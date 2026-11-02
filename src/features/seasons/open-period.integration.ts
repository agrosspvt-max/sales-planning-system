/** Real database regression: closing hides periods for every role without changing saved work. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient, Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { ADMIN_MODULES } from "@/features/accounts/permissions";
import type { AuthContext } from "@/lib/http";

const url = process.env.OPEN_PERIOD_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  new URL(url).pathname !== "/open_period_test" ||
  !new URL(url).searchParams.get("host")?.startsWith("/tmp/open-period-pg.")
) {
  throw Error(
    "OPEN_PERIOD_TEST_URL must use the disposable /open_period_test database on a /tmp/open-period-pg.* Unix socket. Application databases are forbidden.",
  );
}
const prisma = new PrismaClient({ datasources: { db: { url } } });
const load = testLoader({ "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError } });
const sales = load<typeof import("../planning/service.server")>(
  "src/features/planning/service.server.ts",
);
const monthly = load<typeof import("../planning/monthly-plan.server")>(
  "src/features/planning/monthly-plan.server.ts",
);
const recovery = load<typeof import("../recovery/service.server")>(
  "src/features/recovery/service.server.ts",
);
const partySeasonal = load<typeof import("../party-planning/seasonal.server")>(
  "src/features/party-planning/seasonal.server.ts",
);
const partyMonthly = load<typeof import("../party-planning/monthly.server")>(
  "src/features/party-planning/monthly.server.ts",
);
const uploads = load<typeof import("../sales-upload/service.server")>(
  "src/features/sales-upload/service.server.ts",
);
const seasons = load<typeof import("./service.server")>("src/features/seasons/service.server.ts");
const states = load<typeof import("../planning/planning-state.server")>(
  "src/features/planning/planning-state.server.ts",
);
const locks = load<typeof import("@/lib/plan-row-lock.server")>("src/lib/plan-row-lock.server.ts");
const permissions = Object.fromEntries(ADMIN_MODULES.map((m) => [m.id, [...m.actions]]));
const actors = [Role.SALES_OFFICER, Role.REGIONAL_MANAGER, Role.SUPER_ADMIN, Role.CUSTOM_ADMIN].map(
  (role, i) =>
    ({ userId: `u${i}`, username: `u${i}`, role, groupId: "g", permissions }) as AuthContext,
);
const admin = actors[2]!;
const ids = (rows: { id: string }[]) =>
  rows
    .map((r) => r.id)
    .sort()
    .join(",");
const missing = (call: () => Promise<unknown>) =>
  assert.rejects(call, (e: unknown) => (e as { status?: number }).status === 404);

async function seed() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "User", "UserGroup", "Season", "Dealer", "Product", "Market" CASCADE',
  );
  await prisma.userGroup.create({ data: { id: "g", name: "State" } });
  await prisma.user.createMany({
    data: actors.map((a) => ({
      id: a.userId,
      username: a.username!,
      name: a.role,
      role: a.role,
      groupId: "g",
      passwordHash: "fixture",
    })),
  });
  await prisma.season.create({
    data: {
      id: "s",
      name: "Rabi",
      year: 2026,
      startMonth: 11,
      startYear: 2026,
      endMonth: 1,
      endYear: 2027,
    },
  });
  await prisma.seasonMonth.createMany({
    data: [
      {
        id: "nov",
        seasonId: "s",
        name: "November",
        calendarYear: 2026,
        calendarMonth: 11,
        order: 1,
      },
      {
        id: "dec",
        seasonId: "s",
        name: "December",
        calendarYear: 2026,
        calendarMonth: 12,
        order: 2,
      },
      {
        id: "jan",
        seasonId: "s",
        name: "January",
        calendarYear: 2027,
        calendarMonth: 1,
        order: 3,
        status: "LOCKED",
      },
    ],
  });
  await prisma.dealer.create({ data: { id: "d", name: "Dealer" } });
  await prisma.product.create({ data: { id: "p", name: "Product", rate: 100, nbvPercent: 0.4 } });
  await prisma.market.create({ data: { id: "market", name: "Market", nameKey: "market" } });
  for (const a of actors) {
    const u = a.userId;
    await prisma.seasonPlan.create({
      data: {
        id: `sp-${u}`,
        seasonId: "s",
        officerId: u,
        status: "APPROVED",
        isActiveVersion: true,
      },
    });
    await prisma.planDealer.create({
      data: { id: `pd-${u}`, seasonPlanId: `sp-${u}`, dealerId: "d" },
    });
    await prisma.planLine.create({
      data: { id: `line-${u}`, planDealerId: `pd-${u}`, productId: "p", inputValue: 40 },
    });
    await prisma.monthlyEntry.createMany({
      data: [
        {
          planLineId: `line-${u}`,
          seasonMonthId: "nov",
          planQty: 10,
          saleQty: -2,
          saleValue: -200,
        },
        { planLineId: `line-${u}`, seasonMonthId: "dec", planQty: 30 },
      ],
    });
    await prisma.seasonalPlanSheet.create({
      data: {
        id: `ss-${u}`,
        ownerId: u,
        seasonId: "s",
        items: {
          create: {
            id: `ps-${u}`,
            ownerId: u,
            seasonId: "s",
            marketId: "market",
            approvalStatus: "APPROVED",
          },
        },
      },
    });
    for (const m of ["nov", "dec"]) {
      await prisma.monthlyPlan.create({
        data: {
          id: `mp-${u}-${m}`,
          seasonPlanId: `sp-${u}`,
          officerId: u,
          seasonMonthId: m,
          status: "PENDING_ADMIN",
        },
      });
      await prisma.recoveryPlan.create({
        data: {
          id: `rp-${u}-${m}`,
          seasonPlanId: `sp-${u}`,
          seasonId: "s",
          seasonMonthId: m,
          officerId: u,
          cutoffDate: new Date("2026-11-02"),
          dealers: {
            create: {
              dealerId: "d",
              outstanding: 123,
              monthRecoveryPlan: 50,
              weekPlans: { create: { weekNo: 1, weekRecoveryPlan: 25 } },
            },
          },
        },
      });
      await prisma.partyMonthlySheet.create({
        data: {
          id: `pms-${u}-${m}`,
          seasonId: "s",
          seasonMonthId: m,
          ownerId: u,
          items: {
            create: {
              id: `pm-${u}-${m}`,
              seasonalPlanId: `ps-${u}`,
              seasonId: "s",
              seasonMonthId: m,
              ownerId: u,
              marketId: "market",
              marketNameAtPlanning: "Market",
              approvalStatus: "PENDING_ADMIN",
              options: {
                create: [
                  { optionNo: 1, partyName: "Party 1", turnoverCategory: "LT_50_LAKH" },
                  { optionNo: 2, partyName: "Party 2", turnoverCategory: "LT_50_LAKH" },
                ],
              },
            },
          },
        },
      });
    }
  }
}
async function savedWork() {
  const tables = [
    "SeasonPlan",
    "MonthlyPlan",
    "MonthlyEntry",
    "PlanDealer",
    "PlanLine",
    "RecoveryPlan",
    "RecoveryPlanDealer",
    "RecoveryWeekPlan",
    "SeasonalPlanSheet",
    "SeasonalPlan",
    "PartyMonthlySheet",
    "PartyMonthlyPlan",
    "PartyMonthlyOption",
  ];
  return JSON.stringify(
    await Promise.all(
      tables.map((t) => prisma.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY id`)),
    ),
  );
}
async function view(a: AuthContext) {
  return {
    sales: await sales.listPlans(a),
    monthly: await monthly.listMonthlyPlans(a),
    recovery: await recovery.listRecoveryPlans(a),
    seasonal: await partySeasonal.listSeasonalSheets(a),
    party: await partyMonthly.listMonthlySheets(a),
    months: (await monthly.getSeasonalPlanMonths(a, `sp-${a.userId}`)).months,
  };
}
async function main() {
  const temp = mkdtempSync(join(tmpdir(), "open-period-schema-"));
  try {
    const schema = join(temp, "schema.prisma");
    writeFileSync(schema, readFileSync(resolve("prisma/schema.prisma")));
    const run = spawnSync(
      resolve("node_modules/.bin/prisma"),
      ["db", "push", "--schema", schema, "--skip-generate"],
      { cwd: temp, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: "utf8" },
    );
    if (run.status !== 0) throw Error(run.stderr || run.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  await seed();
  const before = await savedWork();
  const initial = await Promise.all(actors.map(view));
  for (const v of initial)
    assert.equal(ids(v.months), "dec,nov", "locked January is never offered");
  await states.setMonthStatus(admin, "nov", "CLOSED");
  for (const a of actors) {
    const v = await view(a);
    assert.ok(
      v.sales.length > 0 && v.seasonal.length > 0,
      "closing one month keeps its seasonal parents visible",
    );
    for (const rows of [v.monthly, v.recovery, v.party]) {
      assert.ok(
        rows.length > 0 && rows.every((r) => r.id.endsWith("-dec")),
        `${a.role}: only December plans remain`,
      );
    }
    assert.equal(ids(v.months), "dec");
    await missing(() => monthly.getMonthlyPlan(a, `mp-${a.userId}-nov`));
    await missing(() => recovery.getRecoveryPlan(a, `rp-${a.userId}-nov`));
    await missing(() => partyMonthly.getMonthlySheet(a, `pms-${a.userId}-nov`));
    await missing(() => monthly.saveMonthlyPlanEntries(a, `mp-${a.userId}-nov`, { entries: [] }));
    await missing(() => recovery.saveRecoveryMonth(a, `rp-${a.userId}-nov`, { entries: [] }));
    if (a.role === Role.SALES_OFFICER || a.role === Role.REGIONAL_MANAGER) {
      await missing(() => partyMonthly.submitMonthlySheet(a, `pms-${a.userId}-nov`));
    }
  }
  assert.equal((await uploads.listTargetMonths(admin)).map((m) => m.id).join(), "dec");
  assert.equal((await uploads.listTargetMonths(actors[3]!)).map((m) => m.id).join(), "dec");
  assert.equal(
    (await states.getSeasonMonthStates("s")).length,
    3,
    "management can still reopen every month",
  );
  assert.equal((await states.getOpenSeasonMonthStates("s")).length, 1);
  const info = load<typeof import("../party-planning/season-info.server")>(
    "src/features/party-planning/season-info.server.ts",
  );
  const period = await info.getSeasonInfo("s");
  assert.equal(period?.months.length, 1);
  assert.ok(
    period?.period?.includes("Nov") && period?.period?.includes("Jan"),
    "visibility does not shorten the actual season period",
  );
  await prisma.$transaction(async (tx) => {
    assert.equal(
      await locks.lockMonthlyPlan(tx, "mp-u0-nov"),
      null,
      "locked saves reject a closed month",
    );
    assert.equal(await locks.lockRecoveryPlan(tx, "rp-u0-nov"), null);
    assert.ok(await locks.lockRecoveryPlan(tx, "rp-u0-dec"));
  });
  assert.equal(
    await savedWork(),
    before,
    "close and refused saves preserve every stored plan/value/option",
  );
  await states.setMonthStatus(admin, "nov", "OPEN");
  const reopened = await Promise.all(actors.map(view));
  assert.equal(
    JSON.stringify(reopened),
    JSON.stringify(initial),
    "reopening restores identical lists and approval states",
  );

  await seasons.setSeasonStatus("s", "CLOSED");
  for (const a of actors) {
    assert.equal((await sales.listPlans(a)).length, 0);
    assert.equal((await monthly.listMonthlyPlans(a)).length, 0);
    assert.equal((await recovery.listRecoveryPlans(a)).length, 0);
    assert.equal((await partySeasonal.listSeasonalSheets(a)).length, 0);
    assert.equal((await partyMonthly.listMonthlySheets(a)).length, 0);
    await missing(() => sales.getPlanDetail(a, `sp-${a.userId}`));
    await missing(() => monthly.getSeasonalPlanMonths(a, `sp-${a.userId}`));
    await missing(() => recovery.getRecoveryPlan(a, `rp-${a.userId}-dec`));
    await missing(() => partySeasonal.getSeasonalSheet(a, `ss-${a.userId}`));
    await missing(() => partyMonthly.getMonthlySheet(a, `pms-${a.userId}-dec`));
  }
  assert.equal((await uploads.listTargetMonths(admin)).length, 0);
  assert.equal((await seasons.listSeasons("", true)).length, 0);
  assert.equal((await seasons.listSeasons("", false)).length, 1);
  assert.equal((await states.getOpenSeasonMonthStates("s")).length, 0);
  await prisma.$transaction(async (tx) => {
    assert.equal(await locks.lockSeasonPlan(tx, "sp-u0"), null);
    assert.equal(await locks.lockMonthlyPlan(tx, "mp-u0-dec"), null);
    assert.equal(await locks.lockRecoveryPlan(tx, "rp-u0-dec"), null);
  });
  await seasons.setSeasonStatus("s", "OPEN");
  assert.equal(await savedWork(), before);
  assert.equal(JSON.stringify(await Promise.all(actors.map(view))), JSON.stringify(initial));
  console.log(
    "Open-period DB regression passed: all four roles, lists, selectors, stale URLs/saves, master management, locks, close/reopen and saved data preservation.",
  );
}
main()
  .finally(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
