/** Destructive fixtures ONLY in an explicitly named disposable local-socket database. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient, Role } from "@prisma/client";
import * as XLSX from "xlsx";
import type { AuthContext } from "@/lib/http";
import { testLoader } from "@/features/dealer-tags/test-loader";

const url = process.env.SEASON_TRANSFER_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  new URL(url).pathname !== "/season_transfer_test" ||
  !new URL(url).searchParams.get("host")?.startsWith("/tmp/season-transfer-pg.")
) {
  throw Error(
    "SEASON_TRANSFER_TEST_URL must name /season_transfer_test on an isolated /tmp/season-transfer-pg.* Unix socket. Application URLs are forbidden.",
  );
}
const prisma = new PrismaClient({ datasources: { db: { url } } });
let failAudit = false;
const svc = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/audit": {
    writeAudit: async (data: object, tx: typeof prisma) => {
      if (failAudit) throw Error("injected audit failure");
      return tx.auditLog.create({ data: data as Parameters<typeof tx.auditLog.create>[0]["data"] });
    },
  },
})<typeof import("./remove-month.server")>("src/features/seasons/remove-month.server.ts");
const admin: AuthContext = {
  userId: "admin",
  username: "admin",
  role: Role.SUPER_ADMIN,
  groupId: null,
};
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const body = { targetMonthId: "r11" };
async function snapshot() {
  const tables = [
    "Season",
    "SeasonMonth",
    "SeasonPlan",
    "PlanDealer",
    "PlanLine",
    "MonthlyEntry",
    "MonthlyPlan",
    "MonthlyPlanDealer",
    "RecoveryPlan",
    "RecoveryPlanDealer",
    "RecoveryWeekPlan",
    "RecoveryWeekLock",
    "AgingSnapshot",
    "AgingSnapshotDealer",
    "AgingSnapshotBill",
    "ApprovalAction",
    "SeasonalPlan",
    "SeasonalPlanSheet",
    "PartyMonthlySheet",
    "PartyMonthlyPlan",
    "PartyMonthlyOption",
    "SalesUploadRun",
    "LastPaymentImport",
    "LastPaymentJob",
    "AuditLog",
    "Notification",
  ];
  return JSON.stringify(
    await Promise.all(
      tables.map((t) => prisma.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY id`)),
    ),
  );
}
async function seed() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "User", "Season", "Dealer", "Product", "Market", "LastPaymentJob" CASCADE',
  );
  failAudit = false;
  await prisma.user.createMany({
    data: [
      {
        id: "admin",
        username: "admin",
        name: "Admin",
        role: Role.SUPER_ADMIN,
        passwordHash: "fixture",
      },
      {
        id: "so",
        username: "so",
        name: "Officer",
        role: Role.SALES_OFFICER,
        passwordHash: "fixture",
      },
    ],
  });
  await prisma.season.createMany({
    data: [
      {
        id: "k",
        name: "Kharif",
        year: 2026,
        startMonth: 10,
        startYear: 2026,
        endMonth: 11,
        endYear: 2026,
      },
      {
        id: "r",
        name: "Rabi",
        year: 2026,
        startMonth: 11,
        startYear: 2026,
        endMonth: 12,
        endYear: 2026,
      },
    ],
  });
  await prisma.seasonMonth.createMany({
    data: [
      {
        id: "k10",
        seasonId: "k",
        name: "October",
        calendarMonth: 10,
        calendarYear: 2026,
        order: 1,
      },
      {
        id: "k11",
        seasonId: "k",
        name: "November",
        calendarMonth: 11,
        calendarYear: 2026,
        order: 2,
      },
      {
        id: "r11",
        seasonId: "r",
        name: "November",
        calendarMonth: 11,
        calendarYear: 2026,
        order: 1,
      },
      {
        id: "r12",
        seasonId: "r",
        name: "December",
        calendarMonth: 12,
        calendarYear: 2026,
        order: 2,
      },
    ],
  });
  await prisma.dealer.createMany({
    data: [
      { id: "d1", name: "Dealer One" },
      { id: "d2", name: "Dealer Two" },
    ],
  });
  await prisma.product.create({
    data: { id: "prod", name: "Product", rate: 100, nbvPercent: 0.4 },
  });
  await prisma.seasonPlan.create({
    data: { id: "kp", seasonId: "k", officerId: "so", status: "APPROVED", isActiveVersion: true },
  });
  await prisma.planDealer.create({ data: { id: "kd", seasonPlanId: "kp", dealerId: "d1" } });
  await prisma.planLine.create({
    data: { id: "kl", planDealerId: "kd", productId: "prod", inputValue: 100, rateSnapshot: 100 },
  });
  await prisma.monthlyEntry.createMany({
    data: [
      {
        id: "oct",
        planLineId: "kl",
        seasonMonthId: "k10",
        planQty: 10,
        saleQty: 8,
        saleValue: 800,
      },
      {
        id: "nov",
        planLineId: "kl",
        seasonMonthId: "k11",
        planQty: 20,
        saleQty: -2,
        saleValue: -200,
        planValue: 2000,
        inputMode: "VALUE",
      },
    ],
  });
  await prisma.monthlyPlan.create({
    data: {
      id: "km",
      seasonPlanId: "kp",
      seasonMonthId: "k11",
      officerId: "so",
      dealerStates: { create: { id: "kmstate", dealerId: "d1" } },
    },
  });
  await prisma.approvalAction.create({
    data: { id: "ma", monthlyPlanId: "km", seasonPlanId: "kp", actorId: "admin", action: "SUBMIT" },
  });
  await prisma.recoveryPlan.create({
    data: {
      id: "kr",
      seasonId: "k",
      seasonMonthId: "k11",
      seasonPlanId: "kp",
      officerId: "so",
      cutoffDate: new Date("2026-11-02"),
      dealers: {
        create: {
          id: "krd",
          dealerId: "d1",
          outstanding: 999,
          monthRecoveryPlan: 40,
          liveRecovery: 5,
          srCr: -1,
          weekPlans: { create: { id: "kw", weekNo: 1, weekRecoveryPlan: 10 } },
        },
      },
      weekLocks: { create: { weekNo: 1, locked: false } },
      snapshots: {
        create: {
          id: "ksnap",
          weekNo: 0,
          cutoffDate: new Date("2026-11-02"),
          workbookName: "aging.xlsx",
          uploadedById: "admin",
          dealers: { create: { id: "ksd", dealerId: "d1", outstanding: 999 } },
        },
      },
    },
  });
  await prisma.agingSnapshotBill.create({
    data: {
      id: "bill",
      snapshotId: "ksnap",
      snapshotDealerId: "ksd",
      dealerId: "d1",
      amount: 999,
      bucket: "DUE",
    },
  });
  await prisma.market.create({ data: { id: "market", name: "Market", nameKey: "market" } });
  await prisma.seasonalPlanSheet.create({ data: { id: "kss", seasonId: "k", ownerId: "so" } });
  await prisma.seasonalPlan.create({
    data: {
      id: "ksp",
      sheetId: "kss",
      seasonId: "k",
      ownerId: "so",
      marketId: "market",
      approvalStatus: "APPROVED",
    },
  });
  await prisma.partyMonthlySheet.create({
    data: { id: "kms", seasonId: "k", seasonMonthId: "k11", ownerId: "so" },
  });
  await prisma.partyMonthlyPlan.create({
    data: {
      id: "kparty",
      sheetId: "kms",
      seasonId: "k",
      seasonMonthId: "k11",
      ownerId: "so",
      marketId: "market",
      marketNameAtPlanning: "Market",
      seasonalPlanId: "ksp",
      options: {
        create: { id: "opt", optionNo: 1, partyName: "Party", turnoverCategory: "LT_50L" },
      },
    },
  });
  await prisma.salesUploadRun.create({
    data: {
      id: "upload",
      uploadedById: "admin",
      workbookName: "nov.xlsx",
      seasonMonthId: "k11",
      targetMonthName: "Kharif 2026 · November",
    },
  });
  await prisma.lastPaymentImport.create({
    data: {
      id: "receipt",
      kind: "REGULAR",
      scopeKey: "k11",
      fileHash: "unique",
      workbookName: "day.xlsx",
      uploadedById: "admin",
      summary: "{}",
    },
  });
  await prisma.lastPaymentJob.create({
    data: {
      id: "job",
      scopeKey: "k11",
      workbookName: "day.xlsx",
      sourceFileHash: "unique",
      uploadedById: "admin",
      status: "DONE",
      payload: {},
    },
  });
  await prisma.notification.createMany({
    data: [
      {
        id: "monthly-notice",
        userId: "so",
        type: "PLAN_SUBMITTED",
        title: "Monthly",
        message: "Review",
        relatedEntityType: "MonthlyPlan",
        relatedEntityId: "km",
      },
      {
        id: "recovery-notice",
        userId: "so",
        type: "PLAN_SUBMITTED",
        title: "Recovery",
        message: "Review",
        relatedEntityType: "RecoveryPlan",
        relatedEntityId: "kr",
      },
    ],
  });
}
async function destination(dealer = "d2") {
  await prisma.seasonPlan.create({
    data: { id: "rp", seasonId: "r", officerId: "so", status: "APPROVED", isActiveVersion: true },
  });
  await prisma.planDealer.create({ data: { id: "rd", seasonPlanId: "rp", dealerId: dealer } });
  await prisma.planLine.create({
    data: { id: "rl", planDealerId: "rd", productId: "prod", inputValue: 300 },
  });
  await prisma.monthlyEntry.create({
    data: { id: "dest-entry", planLineId: "rl", seasonMonthId: "r11", saleQty: 7, saleValue: 700 },
  });
  await prisma.monthlyPlan.create({
    data: {
      id: "rm",
      seasonPlanId: "rp",
      seasonMonthId: "r11",
      officerId: "so",
      dealerStates: { create: { dealerId: dealer } },
    },
  });
  await prisma.recoveryPlan.create({
    data: {
      id: "rr",
      seasonId: "r",
      seasonMonthId: "r11",
      seasonPlanId: "rp",
      officerId: "so",
      cutoffDate: new Date("2026-11-02"),
      dealers: { create: { id: "rrd", dealerId: dealer, outstanding: 12 } },
      snapshots: {
        create: {
          id: "rsnap",
          weekNo: 1,
          cutoffDate: new Date("2026-11-02"),
          workbookName: "dest.xlsx",
          uploadedById: "admin",
          dealers: { create: { dealerId: dealer, outstanding: 12 } },
        },
      },
    },
  });
}
async function unchangedOnFailure(work: () => Promise<unknown>, pattern: RegExp) {
  const before = await snapshot();
  await assert.rejects(work, pattern);
  assert.equal(
    await snapshot(),
    before,
    "failure must roll back every table, including newly-created parents",
  );
}
async function main() {
  const temp = mkdtempSync(join(tmpdir(), "season-transfer-schema-"));
  try {
    const path = join(temp, "schema.prisma");
    writeFileSync(path, readFileSync(resolve("prisma/schema.prisma")));
    const push = spawnSync(
      resolve("node_modules/.bin/prisma"),
      ["db", "push", "--schema", path, "--skip-generate"],
      { cwd: temp, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: "utf8" },
    );
    if (push.status !== 0) throw Error(push.stderr || push.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  await seed();
  const options = await svc.getRemoveMonthOptions(admin, "k", "k11");
  assert.equal(options.targets.length, 1);
  assert.equal(options.targets[0].id, "r11");
  const october = plain(await prisma.monthlyEntry.findUnique({ where: { id: "oct" } }));
  const recoveryDealer = plain(
    await prisma.recoveryPlanDealer.findUnique({ where: { id: "krd" } }),
  );
  const transferred = await svc.removeSeasonMonth(admin, "k", "k11", body);
  assert.equal(transferred.counts.draftSeasonalPlans, 1);
  assert.equal(await prisma.seasonMonth.count({ where: { id: "k11" } }), 0);
  assert.equal((await prisma.season.findUniqueOrThrow({ where: { id: "k" } })).endMonth, 10);
  const entry = await prisma.monthlyEntry.findUniqueOrThrow({
    where: { id: "nov" },
    include: { planLine: { include: { planDealer: { include: { seasonPlan: true } } } } },
  });
  assert.deepEqual(
    [
      entry.seasonMonthId,
      entry.planQty,
      entry.saleQty,
      Number(entry.saleValue),
      Number(entry.planValue),
      entry.inputMode,
    ],
    ["r11", 20, -2, -200, 2000, "VALUE"],
  );
  assert.deepEqual(
    [
      entry.planLine.planDealer.seasonPlan.seasonId,
      entry.planLine.planDealer.seasonPlan.status,
      entry.planLine.inputValue,
    ],
    ["r", "DRAFT", null],
  );
  assert.deepEqual(plain(await prisma.monthlyEntry.findUnique({ where: { id: "oct" } })), october);
  assert.deepEqual(
    plain(await prisma.recoveryPlanDealer.findUnique({ where: { id: "krd" } })),
    recoveryDealer,
  );
  assert.equal(
    (await prisma.recoveryPlan.findUniqueOrThrow({ where: { id: "kr" } })).seasonId,
    "r",
  );
  assert.equal(
    (await prisma.monthlyPlan.findUniqueOrThrow({ where: { id: "km" } })).seasonMonthId,
    "r11",
  );
  assert.equal(
    (
      await prisma.partyMonthlyPlan.findUniqueOrThrow({
        where: { id: "kparty" },
        include: { seasonalPlan: true },
      })
    ).seasonalPlan.seasonId,
    "r",
  );
  assert.equal(
    (await prisma.partyMonthlyOption.findUniqueOrThrow({ where: { id: "opt" } })).monthlyPlanId,
    "kparty",
  );
  assert.equal(
    (await prisma.lastPaymentJob.findUniqueOrThrow({ where: { id: "job" } })).scopeKey,
    "r11",
  );
  assert.equal(
    (await prisma.lastPaymentImport.findUniqueOrThrow({ where: { id: "receipt" } })).scopeKey,
    "r11",
  );
  assert.equal(
    (await prisma.salesUploadRun.findUniqueOrThrow({ where: { id: "upload" } })).seasonMonthId,
    "r11",
  );
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", body),
    /no longer exists/,
  );
  console.log(
    "PASS: complete transfer, draft parents, retained IDs/values/history, untouched October, repeat safety",
  );

  await seed();
  await destination();
  await svc.removeSeasonMonth(admin, "k", "k11", body);
  assert.equal(await prisma.monthlyEntry.count({ where: { seasonMonthId: "r11" } }), 2);
  assert.equal(await prisma.monthlyPlan.count({ where: { seasonMonthId: "r11" } }), 1);
  assert.equal(await prisma.monthlyPlanDealer.count({ where: { monthlyPlanId: "rm" } }), 2);
  assert.equal(
    (await prisma.approvalAction.findUniqueOrThrow({ where: { id: "ma" } })).monthlyPlanId,
    "rm",
  );
  assert.equal(await prisma.recoveryPlan.count({ where: { seasonMonthId: "r11" } }), 1);
  assert.equal(
    (await prisma.recoveryPlanDealer.findUniqueOrThrow({ where: { id: "krd" } })).recoveryPlanId,
    "rr",
  );
  assert.equal(
    (await prisma.recoveryWeekPlan.findUniqueOrThrow({ where: { id: "kw" } })).recoveryPlanDealerId,
    "krd",
  );
  assert.equal(
    (await prisma.agingSnapshotBill.findUniqueOrThrow({ where: { id: "bill" } })).snapshotId,
    "ksnap",
  );
  assert.equal(await prisma.agingSnapshot.count({ where: { recoveryPlanId: "rr" } }), 2);
  assert.equal(
    (await prisma.agingSnapshot.findUniqueOrThrow({ where: { id: "ksnap" } })).workbookName,
    "aging.xlsx",
  );
  assert.equal(
    (await prisma.notification.findUniqueOrThrow({ where: { id: "monthly-notice" } }))
      .relatedEntityId,
    "rm",
  );
  assert.equal(
    (await prisma.notification.findUniqueOrThrow({ where: { id: "recovery-notice" } }))
      .relatedEntityId,
    "rr",
  );
  const audit = JSON.parse((await prisma.auditLog.findFirstOrThrow()).summary!);
  assert.ok(audit.mappings.some((m: { from: string }) => m.from === "kr"));
  console.log(
    "PASS: non-overlapping sales/recovery merge, weekly plans/bills/approval history retained and audited",
  );

  await seed();
  await prisma.market.create({
    data: { id: "other-market", name: "Other market", nameKey: "other" },
  });
  await prisma.seasonalPlanSheet.create({ data: { id: "rss", ownerId: "so", seasonId: "r" } });
  await prisma.seasonalPlan.create({
    data: {
      id: "rsp",
      sheetId: "rss",
      ownerId: "so",
      seasonId: "r",
      marketId: "other-market",
      approvalStatus: "APPROVED",
    },
  });
  await prisma.partyMonthlySheet.create({
    data: { id: "rms", ownerId: "so", seasonId: "r", seasonMonthId: "r11" },
  });
  await prisma.partyMonthlyPlan.create({
    data: {
      id: "rparty",
      sheetId: "rms",
      ownerId: "so",
      seasonId: "r",
      seasonMonthId: "r11",
      seasonalPlanId: "rsp",
      marketId: "other-market",
      marketNameAtPlanning: "Other market",
    },
  });
  await svc.removeSeasonMonth(admin, "k", "k11", body);
  assert.equal(await prisma.partyMonthlySheet.count(), 1);
  assert.equal(await prisma.partyMonthlyPlan.count({ where: { sheetId: "rms" } }), 2);
  assert.equal(
    (await prisma.partyMonthlyOption.findUniqueOrThrow({ where: { id: "opt" } })).monthlyPlanId,
    "kparty",
  );
  console.log("PASS: disjoint Party Planning sheets merge without replacing entries or options");

  await seed();
  await prisma.seasonalPlanSheet.create({ data: { id: "rss", ownerId: "so", seasonId: "r" } });
  await prisma.seasonalPlan.create({
    data: {
      id: "rsp",
      sheetId: "rss",
      ownerId: "so",
      seasonId: "r",
      marketId: "market",
      approvalStatus: "APPROVED",
    },
  });
  await prisma.partyMonthlySheet.create({
    data: { id: "rms", ownerId: "so", seasonId: "r", seasonMonthId: "r11" },
  });
  await prisma.partyMonthlyPlan.create({
    data: {
      id: "rparty",
      sheetId: "rms",
      ownerId: "so",
      seasonId: "r",
      seasonMonthId: "r11",
      seasonalPlanId: "rsp",
      marketId: "market",
      marketNameAtPlanning: "Market",
    },
  });
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", body),
    /Party Planning overlap/,
  );
  console.log(
    "PASS: Party Planning overlap rolls back sales/recovery changes made earlier in the transaction",
  );

  await seed();
  await destination("d1");
  await unchangedOnFailure(() => svc.removeSeasonMonth(admin, "k", "k11", body), /Sales overlap/);
  await prisma.monthlyEntry.delete({ where: { id: "dest-entry" } });
  await prisma.monthlyPlanDealer.deleteMany({ where: { monthlyPlanId: "rm" } });
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", body),
    /Recovery dealer overlap/,
  );
  console.log("PASS: sales and recovery conflicts stop the whole operation");

  await seed();
  await destination();
  await prisma.agingSnapshot.update({ where: { id: "rsnap" }, data: { weekNo: 0 } });
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", body),
    /overlapping upload histories/,
  );
  console.log("PASS: overlapping aging-file history is never combined, renumbered or overwritten");

  await seed();
  failAudit = true;
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", body),
    /injected audit failure/,
  );
  failAudit = false;
  await unchangedOnFailure(
    () => svc.removeSeasonMonth({ ...admin, role: Role.SALES_OFFICER }, "k", "k11", body),
    /administrative/,
  );
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", { targetMonthId: "r12" }),
    /exact same/,
  );
  await prisma.season.update({ where: { id: "r" }, data: { status: "CLOSED" } });
  await unchangedOnFailure(() => svc.removeSeasonMonth(admin, "k", "k11", body), /Both seasons/);
  console.log("PASS: audit failure rollback, authorization, wrong month/year, closed destination");

  await seed();
  await prisma.lastPaymentJob.update({ where: { id: "job" }, data: { status: "PENDING" } });
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", body),
    /pending Last Payment/,
  );
  await prisma.lastPaymentJob.update({ where: { id: "job" }, data: { status: "DONE" } });
  const racing = await Promise.allSettled([
    svc.removeSeasonMonth(admin, "k", "k11", body),
    svc.removeSeasonMonth(admin, "k", "k11", body),
  ]);
  assert.equal(racing.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await prisma.auditLog.count(), 1);
  assert.equal(await prisma.monthlyEntry.count(), 2);
  console.log("PASS: pending background job guard and concurrent removal safety");

  await seed();
  await prisma.seasonMonth.update({ where: { id: "r11" }, data: { calendarYear: 2027 } });
  assert.equal((await svc.getRemoveMonthOptions(admin, "k", "k11")).targets.length, 0);
  await unchangedOnFailure(() => svc.removeSeasonMonth(admin, "k", "k11", body), /exact same/);
  await prisma.seasonMonth.update({ where: { id: "r11" }, data: { calendarYear: 2026 } });
  await prisma.lastPaymentImport.create({
    data: {
      kind: "REGULAR",
      scopeKey: "r11",
      fileHash: "unique",
      workbookName: "duplicate.xlsx",
      uploadedById: "admin",
      summary: "{}",
    },
  });
  await unchangedOnFailure(
    () => svc.removeSeasonMonth(admin, "k", "k11", body),
    /same Day Book import/,
  );
  console.log("PASS: year identity and duplicate Day Book provenance safeguards");

  // Exercise the real Day Book transaction with post-commit receipt processing isolated.
  // A file analyzed before removal must not reset transferred recovery rows or queue an
  // orphan job under the removed month ID.
  await seed();
  let beforeCommit = async () => {};
  const recoveryService = testLoader({
    "@/lib/prisma": { prisma },
    "@/lib/audit": {
      writeAudit: async (data: Parameters<typeof prisma.auditLog.create>[0]["data"], tx = prisma) =>
        tx.auditLog.create({ data }),
    },
    "@/features/historical-daybook/service.server": {
      preserveBeforeDaybookCommit: () => beforeCommit(),
      processPendingLastPaymentJobs: async () => {},
      processLastPaymentJob: async (id: string) => {
        await prisma.lastPaymentJob.update({ where: { id }, data: { status: "DONE" } });
        return { status: "DONE" };
      },
    },
    "@/features/reports/billing-exception.server": {
      reconcileBillingExceptionsSafely: async () => undefined,
    },
  })<typeof import("@/features/recovery/service.server")>(
    "src/features/recovery/service.server.ts",
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Date", "Particulars", "Vch Type", "Vch No.", "Credit Amount"],
      ["2026-11-02", "Dealer One", "Receipt", "R1", 123],
    ]),
    "Day Book",
  );
  const book = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  beforeCommit = async () => {
    await svc.removeSeasonMonth(admin, "k", "k11", body);
  };
  await assert.rejects(
    () => recoveryService.commitDaybook(admin, book, "stale.xlsx", { seasonMonthId: "k11" }),
    /removed or transferred/,
  );
  assert.equal(
    Number(
      (await prisma.recoveryPlanDealer.findUniqueOrThrow({ where: { id: "krd" } })).liveRecovery,
    ),
    5,
  );
  assert.equal(await prisma.lastPaymentJob.count({ where: { scopeKey: "k11" } }), 0);
  beforeCommit = async () => {};
  const result = await recoveryService.commitDaybook(admin, book, "fresh.xlsx", {
    seasonMonthId: "r11",
  });
  assert.equal(result.dealersUpdated, 1);
  assert.equal(
    Number(
      (await prisma.recoveryPlanDealer.findUniqueOrThrow({ where: { id: "krd" } })).liveRecovery,
    ),
    123,
  );
  assert.equal(
    Number(
      (await prisma.recoveryPlanDealer.findUniqueOrThrow({ where: { id: "krd" } })).outstanding,
    ),
    999,
  );
  console.log(
    "PASS: stale Day Book commit rejected; fresh receiving-month upload works and preserves aging",
  );

  await seed();
  await prisma.monthlyEntry.delete({ where: { id: "oct" } });
  await prisma.seasonMonth.delete({ where: { id: "k10" } });
  await unchangedOnFailure(() => svc.removeSeasonMonth(admin, "k", "k11", body), /last month/);
  console.log("PASS: cannot leave an active season without any months");
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
