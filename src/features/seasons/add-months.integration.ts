/** Opt-in integration test: refuses every URL except a disposable /tmp local Unix-socket database. */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import * as assignments from "@/lib/validations/assignments";
import * as db from "@prisma/client";
import { z } from "zod";
import * as calendar from "@/lib/season-calendar";
import * as months from "@/lib/season-months";
import * as workbook from "@/lib/season-workbook-months";

const url = process.env.SEASON_MONTH_TEST_URL;
if (
  !url ||
  !url.startsWith("postgresql://") ||
  new URL(url).hostname !== "localhost" ||
  !new URL(url).searchParams.get("host")?.startsWith("/tmp/season-calendar-pg.")
) {
  throw new Error(
    "Set SEASON_MONTH_TEST_URL to an isolated /tmp/season-calendar-pg.* PostgreSQL Unix socket. Application URLs are forbidden.",
  );
}
const prisma = new db.PrismaClient({ datasources: { db: { url } } });
const localRequire = createRequire(import.meta.url);
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function load<T>(file: string): T {
  const source = readFileSync(resolve(file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  const aliases: Record<string, unknown> = {
    "server-only": {},
    "@prisma/client": db,
    zod: { z },
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError },
    "@/lib/season-calendar": calendar,
    "@/lib/season-months": months,
    "@/lib/audit": {
      writeAudit: async (data: unknown, tx: db.Prisma.TransactionClient) =>
        tx.auditLog.create({ data: data as db.Prisma.AuditLogCreateInput }),
    },
    "@/lib/validations/assignments": assignments,
    "@/lib/scope": { assertOfficerInScope: async () => {} },
  };
  runInNewContext(code, {
    module: testModule,
    exports: testModule.exports,
    require: (name: string) =>
      aliases[name] ?? (name.startsWith("@/") || name.startsWith("./") ? {} : localRequire(name)),
    console,
    Date,
    Math,
    Set,
    Map,
    Buffer,
  });
  return testModule.exports as T;
}
const snapshot = async () =>
  JSON.stringify(
    await Promise.all([
      prisma.monthlyPlan.findMany(),
      prisma.monthlyEntry.findMany(),
      prisma.planLine.findMany(),
      prisma.recoveryPlan.findMany(),
      prisma.recoveryPlanDealer.findMany(),
      prisma.agingSnapshot.findMany(),
      prisma.agingSnapshotDealer.findMany(),
      prisma.agingSnapshotBill.findMany(),
      prisma.recoveryWeekPlan.findMany(),
    ]),
  );
function setup() {
  // The guard above allows destructive fixture setup ONLY in a disposable local socket database.
  const sql = (input: string) => {
    const result = spawnSync("psql", [url!, "-v", "ON_ERROR_STOP=1"], {
      input,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const temp = mkdtempSync(join(tmpdir(), "season-calendar-schema-"));
  try {
    const schemaPath = join(temp, "schema.prisma");
    writeFileSync(
      schemaPath,
      readFileSync(resolve("prisma/schema.prisma"), "utf8")
        .replace(/  calendarMonth  Int\?\n/, "")
        .replace(/  calendarYear   Int\?\n/, "")
        .replace("  @@unique([seasonId, calendarYear, calendarMonth])\n", ""),
    );
    const push = spawnSync(
      resolve("node_modules/.bin/prisma"),
      ["db", "push", "--schema", schemaPath, "--skip-generate"],
      { cwd: temp, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: "utf8" },
    );
    if (push.status !== 0) throw new Error(push.stderr || push.stdout);
    assert.match(push.stdout, /localhost/); // Both migration URLs stay local, never .env DIRECT_URL.
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  sql(`INSERT INTO "Season" (id,name,year,"startMonth","startYear","endMonth","endYear","updatedAt") VALUES
    ('legacy-safe','Test Season',2026,6,2026,11,2026,NOW()),
    ('legacy-ambiguous','Unknown Season',2026,NULL,NULL,NULL,NULL,NOW()),
    ('legacy-conflict','Wrong Month Name',2026,6,2026,7,2026,NOW());
    INSERT INTO "SeasonMonth" (id,"seasonId",name,"order",status) VALUES
    ('old-6','legacy-safe','June',1,'OPEN'), ('old-7','legacy-safe','July',2,'LOCKED'),
    ('old-8','legacy-safe','August',3,'CLOSED'), ('old-9','legacy-safe','September',4,'LOCKED'),
    ('old-10','legacy-safe','October',5,'OPEN'), ('old-11','legacy-safe','November',6,'LOCKED'),
    ('ambiguous','legacy-ambiguous','January',1,'OPEN'),
    ('conflict-june','legacy-conflict','June',1,'OPEN'), ('conflict-april','legacy-conflict','April',2,'LOCKED');`);
  sql(
    readFileSync(
      resolve("prisma/migrations/20261001000000_season_month_calendar_identity/migration.sql"),
      "utf8",
    ),
  );
}
async function main() {
  setup();
  const seasons = load<typeof import("./service.server")>("src/features/seasons/service.server.ts");
  const service = load<typeof import("./add-months.server")>(
    "src/features/seasons/add-months.server.ts",
  );
  const upload = load<typeof import("@/features/sales-upload/service.server")>(
    "src/features/sales-upload/service.server.ts",
  );
  const monthly = load<typeof import("@/features/planning/monthly-plan.server")>(
    "src/features/planning/monthly-plan.server.ts",
  );
  const admin = await prisma.user.create({
    data: {
      name: "Test Admin",
      username: "season-test-admin",
      passwordHash: "test",
      role: "SUPER_ADMIN",
    },
  });
  const ctx = { userId: admin.id, role: admin.role, username: admin.username, groupId: null };
  const existing = await prisma.seasonMonth.findMany({
    where: { seasonId: "legacy-safe" },
    orderBy: { order: "asc" },
  });
  assert.deepEqual(
    existing.map((m) => [m.id, m.calendarMonth, m.calendarYear, m.status]),
    [
      ["old-6", 6, 2026, "OPEN"],
      ["old-7", 7, 2026, "LOCKED"],
      ["old-8", 8, 2026, "CLOSED"],
      ["old-9", 9, 2026, "LOCKED"],
      ["old-10", 10, 2026, "OPEN"],
      ["old-11", 11, 2026, "LOCKED"],
    ],
  );
  assert.equal(
    (await prisma.seasonMonth.findUniqueOrThrow({ where: { id: "ambiguous" } })).calendarYear,
    null,
  );
  assert.equal(
    (await prisma.seasonMonth.findUniqueOrThrow({ where: { id: "conflict-june" } })).calendarYear,
    null,
  );
  await assert.rejects(
    service.addSeasonMonths(ctx, "legacy-ambiguous", { months: [{ month: 2, year: 2026 }] }),
    /ambiguous/,
  );
  const dealer = await prisma.dealer.create({ data: { name: "Test Dealer" } });
  const product = await prisma.product.create({
    data: { name: "Test Product", rate: 75, nbvPercent: 0.2 },
  });
  const plan = await prisma.seasonPlan.create({
    data: {
      seasonId: "legacy-safe",
      officerId: admin.id,
      status: "APPROVED",
      isActiveVersion: true,
      dealers: {
        create: {
          dealerId: dealer.id,
          lines: {
            create: {
              productId: product.id,
              rateSnapshot: 75,
              monthlyEntries: { create: { seasonMonthId: "old-6", planQty: 100, saleQty: 70 } },
            },
          },
        },
      },
    },
  });
  const recovery = await prisma.recoveryPlan.create({
    data: {
      seasonId: "legacy-safe",
      seasonMonthId: "old-6",
      officerId: admin.id,
      seasonPlanId: plan.id,
      cutoffDate: new Date("2026-06-01"),
      status: "APPROVED",
      dealers: {
        create: {
          dealerId: dealer.id,
          outstanding: 800,
          due: 150,
          monthRecoveryPlan: 400,
          weekPlans: { create: { weekNo: 1, weekRecoveryPlan: 100 } },
        },
      },
    },
  });
  const existingMonthly = await prisma.monthlyPlan.create({
    data: {
      seasonPlanId: plan.id,
      seasonMonthId: "old-6",
      officerId: admin.id,
      status: "APPROVED",
    },
  });
  const aging = await prisma.agingSnapshot.create({
    data: {
      recoveryPlanId: recovery.id,
      weekNo: 0,
      cutoffDate: new Date("2026-06-30"),
      workbookName: "historical.xlsx",
      uploadedById: admin.id,
    },
  });
  const agingDealer = await prisma.agingSnapshotDealer.create({
    data: { snapshotId: aging.id, dealerId: dealer.id, outstanding: 800, due: 150 },
  });
  await prisma.agingSnapshotBill.create({
    data: {
      snapshotId: aging.id,
      snapshotDealerId: agingDealer.id,
      dealerId: dealer.id,
      refNo: "original-bill",
      amount: 150,
      dueDate: new Date("2026-06-30"),
      bucket: "DUE",
    },
  });
  const pending = await prisma.monthExtensionRequest.create({
    data: {
      seasonId: "legacy-safe",
      requestedById: admin.id,
      monthName: "December",
      monthOrder: 7,
    },
  });
  const financial = await snapshot();
  await service.addSeasonMonths(ctx, "legacy-safe", {
    months: [
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
    ],
  });
  assert.equal(await snapshot(), financial);
  assert.deepEqual(
    await prisma.seasonMonth.findMany({
      where: { id: { in: existing.map((m) => m.id) } },
      orderBy: { order: "asc" },
    }),
    existing,
  );
  assert.deepEqual(
    await prisma.monthExtensionRequest.findUnique({ where: { id: pending.id } }),
    pending,
  );
  const period = { startMonth: 4, startYear: 2026, endMonth: 1, endYear: 2027 };
  await seasons.updateSeason("legacy-safe", { name: "Renamed Season", ...period });
  assert.deepEqual(
    await prisma.seasonMonth.findMany({
      where: { id: { in: existing.map((m) => m.id) } },
      orderBy: { order: "asc" },
    }),
    existing,
  );
  await assert.rejects(
    seasons.updateSeason("legacy-safe", { name: "Renamed Season", ...period, startMonth: 3 }),
    /no longer be changed/,
  );
  const targetMonths = await upload.listTargetMonths(ctx);
  assert.ok(targetMonths.some((m) => m.label.endsWith("January 2027")));
  const available = await monthly.getSeasonalPlanMonths(ctx, plan.id);
  assert.deepEqual(
    available.months.map((m) => m.calendarMonth),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 1],
  );
  assert.equal(available.months.find((m) => m.id === "old-6")?.monthlyPlan?.id, existingMonthly.id);
  assert.ok(available.months.filter((m) => m.id !== "old-6").every((m) => m.monthlyPlan === null));
  const current = await prisma.seasonMonth.findMany({ where: { seasonId: "legacy-safe" } });
  assert.equal(
    targetMonths.find((m) => m.label.endsWith("January 2027"))?.id,
    current.find((m) => m.calendarMonth === 1 && m.calendarYear === 2027)?.id,
  );
  assert.deepEqual(
    workbook.resolveWorkbookMonths(current, [
      { month: 6, year: null },
      { month: 7, year: 2026 },
    ]),
    ["old-6", "old-7"],
  );
  for (const old of existing)
    assert.deepEqual(
      calendar.recoveryCalendar({ startMonth: 4, startYear: 2026 }, old, new Date()),
      { year: 2026, month0: old.calendarMonth! - 1 },
    );
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { entity: "seasonMonths", entityId: "legacy-safe" },
  });
  assert.equal(JSON.parse(audit.summary!).added.length, 4);
  assert.equal(JSON.parse(audit.summary!).actor, admin.id);
  // Real PostgreSQL trigger failure after month/period writes proves complete rollback.
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION reject_season_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER reject_season_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_season_audit()`,
  );
  const beforeRollback = JSON.stringify(
    await prisma.season.findUnique({
      where: { id: "legacy-safe" },
      include: { months: { orderBy: { order: "asc" } } },
    }),
  );
  await assert.rejects(
    service.addSeasonMonths(ctx, "legacy-safe", { months: [{ month: 2, year: 2027 }] }),
    /injected audit failure/,
  );
  assert.equal(
    JSON.stringify(
      await prisma.season.findUnique({
        where: { id: "legacy-safe" },
        include: { months: { orderBy: { order: "asc" } } },
      }),
    ),
    beforeRollback,
  );
  await prisma.$executeRawUnsafe(`DROP TRIGGER reject_season_audit ON "AuditLog"`);
  const outcomes = await Promise.allSettled(
    [1, 2].map(() =>
      service.addSeasonMonths(ctx, "legacy-safe", { months: [{ month: 2, year: 2027 }] }),
    ),
  );
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(
    await prisma.seasonMonth.count({
      where: { seasonId: "legacy-safe", calendarMonth: 2, calendarYear: 2027 },
    }),
    1,
  );
  // No-plan Seasons extended through the canonical operation are protected from Edit regeneration too.
  const unused = await prisma.season.create({
    data: {
      name: "Unused",
      year: 2026,
      startMonth: 6,
      startYear: 2026,
      endMonth: 6,
      endYear: 2026,
      months: {
        create: { name: "June", order: 1, calendarMonth: 6, calendarYear: 2026, status: "LOCKED" },
      },
    },
  });
  await service.addSeasonMonths(ctx, unused.id, { months: [{ month: 5, year: 2026 }] });
  const unusedBefore = await prisma.seasonMonth.findMany({ where: { seasonId: unused.id } });
  await seasons.updateSeason(unused.id, {
    name: "Unused renamed",
    startMonth: 5,
    startYear: 2026,
    endMonth: 6,
    endYear: 2026,
  });
  assert.deepEqual(
    await prisma.seasonMonth.findMany({ where: { seasonId: unused.id } }),
    unusedBefore,
  );
  await prisma.season.update({ where: { id: "legacy-safe" }, data: { status: "CLOSED" } });
  await assert.rejects(
    service.addSeasonMonths(ctx, "legacy-safe", { months: [{ month: 3, year: 2027 }] }),
    /Reopen/,
  );
  assert.equal(await snapshot(), financial);
  console.log(
    "PostgreSQL integration passed: migration safe/ambiguous backfill, stable IDs/statuses, unchanged existing plan/actual/recovery records, upload/monthly selectors, workbook mapping, Recovery calendars, atomic audit rollback, concurrency, and CLOSED rejection.",
  );
}
void main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
