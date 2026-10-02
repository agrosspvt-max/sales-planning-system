import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import type { ReceiptReview, HistoricalAnalysis } from "./types";

const url = process.env.HISTORICAL_DAYBOOK_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  new URL(url).pathname !== "/historical_daybook_test" ||
  new URL(url).searchParams.get("host") !== "/tmp/dealer-tags-pg"
)
  throw new Error(
    "Only the isolated /tmp/dealer-tags-pg/historical_daybook_test database is permitted.",
  );
const prisma = new PrismaClient({ datasources: { db: { url: `${url}&connection_limit=1` } } });
let failAudit = false;
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": {
    writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx = prisma) => {
      if (failAudit && data.entity === "lastPaymentImport")
        throw new Error("injected audit failure");
      return tx.auditLog.create({ data });
    },
  },
  "@/features/cn-requests/service.server": { latestCnRequestStatusByDealer: async () => new Map() },
});
const svc = load<typeof import("./service.server")>(
  "src/features/historical-daybook/service.server.ts",
);
const read = load<typeof import("@/lib/last-payment.server")>("src/lib/last-payment.server.ts");
const recovery = load<typeof import("@/features/recovery/service.server")>(
  "src/features/recovery/service.server.ts",
);
const admin: AuthContext = {
  userId: "admin",
  username: "admin",
  role: Role.SUPER_ADMIN,
  groupId: null,
};
const denied = (promise: Promise<unknown>, status: number) =>
  assert.rejects(promise, (e) => e instanceof TestApiError && e.status === status);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const header = ["Date", "Particulars", "Vch Type", "Vch No.", "Credit Amount"];
function book(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), "Day Book");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
async function operationalSnapshot() {
  const tables = await prisma.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const out: Record<string, string> = {};
  for (const { tablename } of tables) {
    if (
      ["LastPaymentImport", "LastPaymentReceipt", "AuditLog", "_prisma_migrations"].includes(
        tablename,
      )
    )
      continue;
    // Names are from PostgreSQL's catalog, never the workbook/client.
    const name = Prisma.raw(`"${tablename.replace(/"/g, '""')}"`);
    const [row] = await prisma.$queryRaw<{ value: string }[]>(
      Prisma.sql`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS value FROM ${name} t`,
    );
    out[tablename] = row.value;
  }
  return out;
}
async function isolatedSnapshot() {
  return plain({
    operational: await operationalSnapshot(),
    imports: await prisma.lastPaymentImport.findMany({ orderBy: { id: "asc" } }),
    receipts: await prisma.lastPaymentReceipt.findMany({ orderBy: { id: "asc" } }),
    audit: await prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
  });
}
function assertRecoveryViews(
  detail: Awaited<ReturnType<typeof recovery.getRecoveryPlan>>,
  expectedDate: string | null,
  expectedAmount: number | null,
) {
  for (const tab of ["month", "week"]) {
    const uiLoad = testLoader({
      react: {
        ...React,
        useState: (initial: unknown) => React.useState(initial === "month" ? tab : initial),
      },
      "@/lib/api-client": { api: {} },
      "@tanstack/react-query": {
        useQuery: () => ({ data: plain(detail), isLoading: false }),
        useQueryClient: () => ({ invalidateQueries() {} }),
        useMutation: () => ({ isPending: false }),
      },
      "@/features/dealers/dealer-name-ui": {
        DealerName: ({ name }: { name: string }) => React.createElement("span", null, name),
      },
      "@/features/dealers/dealer-table-ui": {
        DealerTableBody: ({ children }: { children: React.ReactNode }) =>
          React.createElement("tbody", null, children),
      },
      "@/components/layout/page-header": { PageHeader: () => null },
      "@/components/layout/mobile-context-bar": { MobileContextBar: () => null },
      "@/features/planning/use-autosave-map": {
        useAutosaveMap: (seed: unknown) => ({
          values: seed,
          saving: false,
          update() {},
          flush() {},
        }),
      },
      "@/features/cn-requests/cn-requests-page": { CreateRequestDialog: () => null },
      "./recovery-actions": { RecoveryActions: () => null },
      "./recovery-history": { RecoveryHistory: () => null },
    });
    const View = uiLoad<typeof import("@/features/recovery/recovery-workspace")>(
      "src/features/recovery/recovery-workspace.tsx",
    ).RecoveryWorkspace;
    const html = renderToStaticMarkup(
      React.createElement(View, { id: detail.id, role: Role.SUPER_ADMIN, userId: "admin" }),
    );
    const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    const dealerIndex = cells.findIndex((cell) => cell.includes(detail.dealers[0].dealerName));
    const paymentCell = cells[dealerIndex + 3];
    assert.ok(dealerIndex >= 0 && paymentCell);
    assert.ok(
      expectedDate
        ? paymentCell.includes(expectedDate.split("-").reverse().join("/")) &&
          paymentCell.includes(new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(expectedAmount!))
        : paymentCell === "—",
      `${tab} view must render date and amount from the real plan response in the same cell`,
    );
    if (detail.dealers[0].lastPaymentUnavailableReason)
      assert.ok(html.includes(detail.dealers[0].lastPaymentUnavailableReason));
  }
}
async function commit(
  buffer: Buffer,
  filename = "history.xlsx",
  reviews: ReceiptReview[] = [],
  analysis?: HistoricalAnalysis,
) {
  const preview =
    analysis ?? (await svc.analyzeHistoricalDaybook(admin, buffer, filename, { reviews }));
  return svc.commitHistoricalDaybook(admin, buffer, filename, {
    reviews,
    previewToken: preview.previewToken,
    confirmed: true,
  });
}
async function verifyCalendarScenarios() {
  await prisma.dealer.createMany({ data: [
    { id: "period", name: "Period Dealer" }, { id: "first-august", name: "Unpaid Dealer" },
  ] });
  await prisma.dealerAssignment.create({ data: { officerId: "so", dealerId: "period", effectiveFrom: new Date("2024-01-01") } });
  await prisma.season.create({ data: { id: "period-season", name: "Calendar scenarios", year: 2026, startMonth: 4, startYear: 2026 } });
  for (let month = 4; month <= 11; month++) {
    await prisma.seasonMonth.create({ data: {
      id: `period-m${month}`, seasonId: "period-season", name: `Month ${month}`, order: month - 3,
      calendarMonth: month, calendarYear: 2026,
    } });
    await prisma.recoveryPlan.create({ data: {
      id: `period-p${month}`, seasonId: "period-season", seasonMonthId: `period-m${month}`, officerId: "so",
      cutoffDate: new Date(Date.UTC(2026, month - 1, 1)), status: "APPROVED",
      dealers: { create: [{ dealerId: "period", outstanding: 1234, monthRecoveryPlan: 567 }, { dealerId: "first-august" }] },
    } });
  }
  const totalPlans = await prisma.recoveryPlan.count();
  const history = book([
    ["2024-01-10", "Period Dealer", "Receipt", "PERIOD-1", 10000],
    ["2025-02-15", "Period Dealer", "Receipt", "PERIOD-2", 20000],
    ["2026-03-10", "Period Dealer", "Receipt", "PERIOD-3", 30000],
  ]);
  const beforeHistory = await operationalSnapshot();
  const preview = await svc.analyzeHistoricalDaybook(admin, history, "calendar-history.xlsx", {});
  assert.equal(preview.changes.length, 8);
  await commit(history, "calendar-history.xlsx", [], preview);
  assert.deepEqual(await operationalSnapshot(), beforeHistory);
  for (let month = 4; month <= 11; month++) {
    const detail = await recovery.getRecoveryPlan(admin, `period-p${month}`);
    const row = detail.dealers.find((d) => d.dealerId === "period")!;
    assert.deepEqual([row.lastPaymentDate, row.lastPaymentAmount], ["2026-03-10", 30000]);
    const projection = preview.changes.find((c) => c.calendarMonth === month)!;
    assert.deepEqual(plain(projection.after), { date: row.lastPaymentDate, amount: row.lastPaymentAmount });
    assertRecoveryViews({ ...detail, dealers: [row] }, "2026-03-10", 30000);
  }
  assert.equal(await prisma.recoveryPlan.count(), totalPlans, "Old receipt years never create missing recovery plans");

  const july = book([["2026-07-15", "Period Dealer", "Receipt", "PERIOD-4", 40000]]);
  const julyPreview = await svc.analyzeHistoricalDaybook(admin, july, "july-history.xlsx", {});
  assert.deepEqual(plain(julyPreview.changes.map((c) => c.calendarMonth)), [7, 8, 9, 10, 11]);
  await prisma.recoveryPlan.update({ where: { id: "period-p7" }, data: { cutoffDate: new Date("2026-06-01") } });
  assert.equal((await svc.analyzeHistoricalDaybook(admin, july, "july-history.xlsx", {})).previewToken, julyPreview.previewToken, "Unrelated aging cutoff does not determine Last Payment preview");
  const beforeJuly = await operationalSnapshot();
  await commit(july, "july-history.xlsx", [], julyPreview);
  assert.deepEqual(await operationalSnapshot(), beforeJuly);
  for (let month = 4; month <= 11; month++) {
    const detail = await recovery.getRecoveryPlan(admin, `period-p${month}`);
    const row = detail.dealers.find((d) => d.dealerId === "period")!;
    const expected = month < 7 ? ["2026-03-10", 30000] as const : ["2026-07-15", 40000] as const;
    assert.deepEqual([row.lastPaymentDate, row.lastPaymentAmount], expected);
    assertRecoveryViews({ ...detail, dealers: [row] }, expected[0], expected[1]);
  }
  assert.equal((await prisma.recoveryPlan.findUniqueOrThrow({ where: { id: "period-p7" } })).cutoffDate.toISOString().slice(0, 10), "2026-06-01");

  const august = book([["2026-08-10", "Unpaid Dealer", "Receipt", "FIRST", 6000]]);
  const augustPreview = await svc.analyzeHistoricalDaybook(admin, august, "first-august.xlsx", {});
  assert.deepEqual(plain(augustPreview.changes.map((c) => c.calendarMonth)), [8, 9, 10, 11]);
  const beforeAugust = await operationalSnapshot();
  await commit(august, "first-august.xlsx", [], augustPreview);
  assert.deepEqual(await operationalSnapshot(), beforeAugust);
  for (let month = 4; month <= 11; month++) {
    const detail = await recovery.getRecoveryPlan(admin, `period-p${month}`);
    const row = detail.dealers.find((d) => d.dealerId === "first-august")!;
    const expected = month < 8 ? [null, null] as const : ["2026-08-10", 6000] as const;
    assert.deepEqual([row.lastPaymentDate, row.lastPaymentAmount], expected);
    assertRecoveryViews({ ...detail, dealers: [row] }, expected[0], expected[1]);
  }

  const normal = await recovery.commitDaybook(admin, book([["2026-09-10", "Period Dealer", "Receipt", "NORMAL", 50000]]), "calendar-normal.xlsx", { seasonMonthId: "period-m9" });
  assert.equal(normal.receiptTotal, 50000);
  assert.equal(normal.srCrTotal, 0);
  assert.ok(!normal.receiptHistoryWarning);
  for (const [month, date, amount] of [[8, "2026-07-15", 40000], [9, "2026-09-10", 50000], [11, "2026-09-10", 50000]] as const) {
    const detail = await recovery.getRecoveryPlan(admin, `period-p${month}`);
    const row = detail.dealers.find((d) => d.dealerId === "period")!;
    assert.deepEqual([row.lastPaymentDate, row.lastPaymentAmount], [date, amount]);
    assertRecoveryViews({ ...detail, dealers: [row] }, date, amount);
  }
  const septemberRow = await prisma.recoveryPlanDealer.findUniqueOrThrow({ where: { recoveryPlanId_dealerId: { recoveryPlanId: "period-p9", dealerId: "period" } } });
  assert.equal(Number(septemberRow.liveRecovery), 50000);
  assert.equal(Number(septemberRow.outstanding), 1234);
  assert.equal(Number(septemberRow.monthRecoveryPlan), 567);

  await prisma.seasonMonth.create({ data: { id: "unresolved-month", seasonId: "period-season", name: "March", order: 9 } });
  await prisma.recoveryPlan.create({ data: { id: "unresolved-plan", seasonId: "period-season", seasonMonthId: "unresolved-month", officerId: "so", cutoffDate: new Date("2026-12-31"), dealers: { create: { dealerId: "period" } } } });
  const unresolved = await recovery.getRecoveryPlan(admin, "unresolved-plan");
  assert.equal(unresolved.dealers[0].lastPaymentDate, null);
  assert.equal(unresolved.dealers[0].lastPaymentAmount, null);
  assert.match(unresolved.dealers[0].lastPaymentUnavailableReason!, /month\/year needs review/);
  assertRecoveryViews(unresolved, null, null);
  const future = book([["2027-01-10", "Period Dealer", "Receipt", "FUTURE", 6]]);
  const unresolvedPreview = await svc.analyzeHistoricalDaybook(admin, future, "unresolved-preview.xlsx", {});
  assert.deepEqual(plain(unresolvedPreview.unresolvedPeriods), [{ planId: "unresolved-plan", seasonMonthId: "unresolved-month", monthName: "March" }]);
  assert.equal(unresolvedPreview.changes.length, 0);
  assert.equal(unresolvedPreview.canCommit, true, "Unresolved plan period does not prevent retaining valid receipt history");
  await prisma.seasonMonth.update({ where: { id: "period-m11" }, data: { calendarMonth: 12 } });
  const beforeStaleCommit = await isolatedSnapshot();
  await denied(commit(future, "unresolved-preview.xlsx", [], unresolvedPreview), 409);
  assert.deepEqual(await isolatedSnapshot(), beforeStaleCommit, "A period change invalidates even an unchanged payment projection without writing");
  await prisma.seasonMonth.update({ where: { id: "period-m11" }, data: { calendarMonth: 11 } });
}

async function run() {
  assert.equal(await prisma.user.count(), 0, "Use a fresh isolated database, not an installation.");
  await prisma.user.createMany({
    data: [
      {
        id: "admin",
        name: "Import Admin",
        username: "admin",
        role: Role.SUPER_ADMIN,
        passwordHash: "test-only",
      },
      {
        id: "so",
        name: "Officer",
        username: "so",
        role: Role.SALES_OFFICER,
        passwordHash: "test-only",
      },
    ],
  });
  await prisma.dealer.createMany({
    data: [
      { id: "a", name: "Dealer Alpha" },
      { id: "b", name: "Dealer Beta" },
      { id: "amb-a", name: "Ambiguous Dealer" },
      { id: "amb-b", name: "Ambiguous Dealer" },
      { id: "inactive", name: "Inactive Dealer", isActive: false },
      { id: "c", name: "Dealer Gamma" },
      { id: "d", name: "Dealer Delta" },
      { id: "e", name: "Dealer Epsilon" },
    ],
  });
  await prisma.dealerAlias.create({
    data: { systemDealerId: "a", tallyName: "Old Alpha Alias", tallyKey: "oldalphaalias" },
  });
  await prisma.dealerAssignment.create({
    data: { officerId: "so", dealerId: "a", effectiveFrom: new Date("2024-01-01") },
  });
  await prisma.season.create({
    data: {
      id: "season",
      name: "Fixture",
      year: 2025,
      status: "CLOSED",
      startMonth: 1,
      startYear: 2025,
    },
  });
  await prisma.seasonPlan.create({
    data: {
      id: "sp",
      seasonId: "season",
      officerId: "so",
      status: "APPROVED",
      isActiveVersion: true,
    },
  });
  await prisma.dealerAssignment.createMany({
    data: ["c", "d", "e"].map((dealerId) => ({
      officerId: "so",
      dealerId,
      effectiveFrom: new Date("2024-01-01"),
    })),
  });
  for (const month of [4, 5, 6, 7, 8, 9, 11, 12]) {
    const id = `m${month}`;
    await prisma.seasonMonth.create({
      data: {
        id,
        seasonId: "season",
        name: id,
        order: month,
        calendarMonth: month,
        calendarYear: 2025,
      },
    });
    await prisma.recoveryPlan.create({
      data: {
        id: `p${month}`,
        seasonMonthId: id,
        seasonId: "season",
        officerId: "so",
        seasonPlanId: "sp",
        cutoffDate: month === 9 ? new Date("2025-07-14") : new Date(Date.UTC(2025, month, 0)),
        status: "APPROVED",
      },
    });
    await prisma.recoveryPlanDealer.create({
      data: {
        recoveryPlanId: `p${month}`,
        dealerId: "a",
        outstanding: 90000,
        overdue: 20000,
        due: 10000,
        running: 60000,
        outstandingTillDate: 100000,
        runningTillDate: 70000,
        monthRecoveryPlan: 30000,
        monthRunningRecovery: 4000,
        srCr: 1500,
        liveRecovery: 2500,
        weekPlans: { create: { weekNo: 1, weekRecoveryPlan: 12000, weekRunningRecovery: 2000 } },
      },
    });
  }
  for (const year of [2024, 2026]) {
    const month = year === 2024 ? 12 : 1,
      seasonId = `season${year}`,
      planId = `p${year}`;
    await prisma.season.create({
      data: {
        id: seasonId,
        name: `Fixture ${year}`,
        year,
        status: year === 2026 ? "OPEN" : "CLOSED",
        startMonth: 1,
        startYear: year,
      },
    });
    const seasonal = await prisma.seasonPlan.create({
      data: { seasonId, officerId: "so", status: "APPROVED", isActiveVersion: true },
    });
    const sm = await prisma.seasonMonth.create({
      data: {
        seasonId,
        name: `Year boundary ${year}`,
        order: 1,
        calendarMonth: month,
        calendarYear: year,
      },
    });
    await prisma.recoveryPlan.create({
      data: {
        id: planId,
        seasonId,
        seasonMonthId: sm.id,
        officerId: "so",
        seasonPlanId: seasonal.id,
        cutoffDate: new Date(Date.UTC(year, month, 0)),
        status: "APPROVED",
        dealers: { create: { dealerId: "a" } },
      },
    });
  }
  const snapshot = await prisma.agingSnapshot.create({
    data: {
      recoveryPlanId: "p5",
      weekNo: 0,
      cutoffDate: new Date("2025-05-31"),
      workbookName: "aging.xlsx",
      uploadedById: "admin",
    },
  });
  const agingDealer = await prisma.agingSnapshotDealer.create({
    data: {
      snapshotId: snapshot.id,
      dealerId: "a",
      outstanding: 90000,
      due: 10000,
      overdue: 20000,
      running: 60000,
    },
  });
  await prisma.agingSnapshotBill.create({
    data: {
      snapshotId: snapshot.id,
      snapshotDealerId: agingDealer.id,
      dealerId: "a",
      amount: 10000,
      billDate: new Date("2025-04-01"),
      dueDate: new Date("2025-05-25"),
      bucket: "DUE",
    },
  });
  await prisma.cnRequest.create({
    data: {
      officerId: "so",
      dealerId: "a",
      cnType: "Freight",
      details: "Fixture",
      amount: 1234,
      status: "REJECTED",
    },
  });
  await prisma.scheme.create({
    data: {
      id: "scheme",
      schemeName: "Unchanged",
      schemeBenefit: "CREDIT_NOTE",
      createdById: "admin",
      schemeValueWithGST: 118000,
      schemeValueWithoutGST: 100000,
    },
  });
  await prisma.dealerSchemePlan.create({
    data: { schemeId: "scheme", dealerId: "a", salesOfficerId: "so", totalSchemeAmount: 118000 },
  });
  await prisma.dailyWorkEntry.create({
    data: {
      officerId: "so",
      dealerId: "a",
      rowKey: "a",
      workDate: new Date("2025-05-01"),
      section: "RECOVERY",
      todaysPlan: 8000,
    },
  });
  await prisma.product.create({
    data: { id: "product", name: "Sales fixture", rate: 100, nbvPercent: 1 },
  });
  const planDealer = await prisma.planDealer.create({
    data: { seasonPlanId: "sp", dealerId: "a" },
  });
  const line = await prisma.planLine.create({
    data: { planDealerId: planDealer.id, productId: "product", rateSnapshot: 100 },
  });
  await prisma.monthlyEntry.create({
    data: {
      planLineId: line.id,
      seasonMonthId: "m5",
      planQty: 100,
      saleQty: 40,
      planValue: 10000,
      saleValue: 4000,
    },
  });
  const original = await operationalSnapshot();
  assert.ok(Object.keys(original).length > 50);
  const history = book([
    ["2024-01-10", "Old Alpha Alias", "Receipt", "H0", 100],
    ["10/04/2025", "Old Alpha Alias", "Receipt", "H1", 10000],
    ["15/07/2025", "Old Alpha Alias", "Receipt", "H2", 20000],
    ["10/12/2025", "Old Alpha Alias", "Receipt", "H3", 15000],
    ["2025-12-25", "Old Alpha Alias", "Credit Note", "C1", 999999],
  ]);
  await denied(
    svc.analyzeHistoricalDaybook(
      { ...admin, role: Role.SALES_OFFICER },
      history,
      "history.xlsx",
      {},
    ),
    403,
  );
  await denied(svc.commitHistoricalDaybook(admin, history, "history.xlsx", {}), 422);
  const beforeAnalyze = await isolatedSnapshot();
  const preview = await svc.analyzeHistoricalDaybook(admin, history, "history.xlsx", {});
  assert.deepEqual(
    await isolatedSnapshot(),
    beforeAnalyze,
    "Analyze performs NO writes, including receipt/audit writes",
  );
  assert.equal(preview.canCommit, true);
  assert.equal(preview.changes.length, 10);
  assert.equal(preview.summary.importing, 4);
  const beforeTamper = await isolatedSnapshot();
  for (const role of [Role.SALES_OFFICER, Role.REGIONAL_MANAGER])
    await denied(
      svc.commitHistoricalDaybook({ ...admin, role }, history, "history.xlsx", {
        confirmed: true,
        previewToken: preview.previewToken,
      }),
      403,
    );
  await denied(
    svc.commitHistoricalDaybook(admin, history, "history.xlsx", {
      confirmed: false,
      previewToken: preview.previewToken,
    }),
    422,
  );
  await denied(
    svc.commitHistoricalDaybook(admin, history, "history.xlsx", {
      confirmed: true,
      previewToken: "tampered",
    }),
    409,
  );
  await denied(
    svc.commitHistoricalDaybook(
      admin,
      book([["2025-04-11", "Old Alpha Alias", "Receipt", "CHANGED", 42]]),
      "history.xlsx",
      { confirmed: true, previewToken: preview.previewToken },
    ),
    409,
  );
  await denied(
    svc.analyzeHistoricalDaybook(admin, history, "history.xlsx", {
      reviews: [{ rowKey: "unknown", action: "KEEP", dealerId: "a" }],
    }),
    422,
  );
  assert.deepEqual(
    await isolatedSnapshot(),
    beforeTamper,
    "Unauthorized, unconfirmed and modified previews cannot write anything",
  );
  const first = await commit(history, "history.xlsx", [], preview);
  assert.equal(first.imported, 4);
  assert.deepEqual(
    await operationalSnapshot(),
    original,
    "EVERY operational table, including timestamps, unchanged after historical import",
  );
  for (const [month, expected] of [
    [4, ["2025-04-10", 10000]],
    [5, ["2025-04-10", 10000]],
    [6, ["2025-04-10", 10000]],
    [7, ["2025-07-15", 20000]],
    [8, ["2025-07-15", 20000]],
    [9, ["2025-07-15", 20000]],
    [11, ["2025-07-15", 20000]],
    [12, ["2025-12-10", 15000]],
  ] as const) {
    const detail = await recovery.getRecoveryPlan(admin, `p${month}`);
    assert.equal(detail.dealers[0].lastPaymentDate, expected[0]);
    assert.equal(detail.dealers[0].lastPaymentAmount, expected[1]);
    const projected = preview.changes.find((c) => c.dealerId === "a" && c.calendarYear === 2025 && c.calendarMonth === month);
    assert.deepEqual(plain(projected?.after), { date: expected[0], amount: expected[1] }, "Preview agrees with actual calendar-month display");
    assertRecoveryViews(detail, expected[0], expected[1]);
    assert.equal(
      detail.dealers[0].actualRunningRecovery,
      -26000,
      "existing recovery formula unchanged",
    );
  }
  assert.equal((await prisma.recoveryPlan.findUniqueOrThrow({ where: { id: "p9" } })).cutoffDate.toISOString().slice(0, 10), "2025-07-14", "Last Payment never rewrites the aging cutoff");
  for (const [planId, date, amount] of [
    ["p2024", "2024-01-10", 100],
    ["p2026", "2025-12-10", 15000],
  ] as const) {
    const detail = await recovery.getRecoveryPlan(admin, planId);
    assert.equal(detail.dealers[0].lastPaymentDate, date);
    assert.equal(detail.dealers[0].lastPaymentAmount, amount);
  }
  assert.equal(
    await prisma.recoveryPlan.count(),
    10,
    "Historical import does not create missing plans",
  );
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["a"], new Date("2024-01-31"))).get("a")),
    { date: "2024-01-10", amount: 100 },
  );
  const auditCount = await prisma.auditLog.count();
  const beforeRetry = await isolatedSnapshot();
  const retry = await commit(history);
  assert.equal(retry.alreadyImported, true);
  assert.equal(retry.importId, first.importId);
  assert.equal(await prisma.lastPaymentReceipt.count(), 4);
  assert.equal(await prisma.auditLog.count(), auditCount);
  assert.deepEqual(await isolatedSnapshot(), beforeRetry, "Exact duplicate import changes NOTHING");

  const uncertain = book([
    ["2024-02-01", "Ambiguous Dealer", "Receipt", "U1", 100],
    ["2024-02-01", "Missing XYZ", "Receipt", "U2", 100],
    ["bad", "Old Alpha Alias", "Receipt", "U3", "bad"],
    ["2024-02-01", "Dealer Beta", "Receipt", "U4", 100],
  ]);
  const uncertainPreview = await svc.analyzeHistoricalDaybook(
    admin,
    uncertain,
    "uncertain.xlsx",
    {},
  );
  assert.equal(uncertainPreview.canCommit, false);
  assert.equal(uncertainPreview.summary.invalid, 1);
  assert.equal(uncertainPreview.summary.unmatched, 2);
  const beforeRejected = await isolatedSnapshot();
  await denied(commit(uncertain, "uncertain.xlsx", [], uncertainPreview), 422);
  assert.deepEqual(
    await isolatedSnapshot(),
    beforeRejected,
    "Rejected import leaves all stores/audit/operational data unchanged",
  );
  const resolutions = uncertainPreview.rows
    .slice(0, 3)
    .map((r): ReceiptReview => ({ rowKey: r.rowKey, action: "EXCLUDE" }));
  await commit(uncertain, "uncertain.xlsx", resolutions);
  const alreadyReviewed = await svc.analyzeHistoricalDaybook(
    admin,
    uncertain,
    "uncertain.xlsx",
    {},
  );
  assert.equal(alreadyReviewed.summary.excluded, 3);
  assert.equal(
    alreadyReviewed.summary.duplicates,
    1,
    "previously excluded rows are not falsely reported as imported duplicates",
  );
  assert.deepEqual(await operationalSnapshot(), original);

  const sameDay = book([
    ["2025-08-01", "Dealer Beta", "Receipt", "S1", 123],
    ["2025-08-01", "Dealer Beta", "Receipt", "S2", 123],
  ]);
  const samePreview = await svc.analyzeHistoricalDaybook(admin, sameDay, "same.xlsx", {});
  assert.equal(samePreview.canCommit, false);
  await commit(
    sameDay,
    "same.xlsx",
    samePreview.rows.map((r) => ({ rowKey: r.rowKey, action: "KEEP" })),
  );
  assert.equal(
    await prisma.lastPaymentReceipt.count({
      where: { dealerId: "b", receiptDate: new Date("2025-08-01") },
    }),
    2,
    "legitimate identical-valued receipts retained",
  );
  const overlap = book([
    ["2025-08-01", "Dealer Beta", "Receipt", "S1", 999],
    ["2025-08-02", "Dealer Beta", "Receipt", "NEW", 50],
  ]);
  const conflict = await svc.analyzeHistoricalDaybook(admin, overlap, "revised.xlsx", {});
  assert.ok(conflict.rows[0].reviewReasons.length);
  assert.equal(conflict.canCommit, false);
  await commit(overlap, "revised.xlsx", [{ rowKey: conflict.rows[0].rowKey, action: "EXCLUDE" }]);
  assert.equal(
    await prisma.lastPaymentReceipt.count({
      where: { dealerId: "b", receiptDate: new Date("2025-08-01") },
    }),
    2,
    "revised file never deletes omitted receipts",
  );

  const rollback = book([["2024-03-01", "Dealer Beta", "Receipt", "FAIL", 321]]);
  const rollbackPreview = await svc.analyzeHistoricalDaybook(admin, rollback, "rollback.xlsx", {});
  const batchesBefore = await prisma.lastPaymentImport.count(),
    rowsBefore = await prisma.lastPaymentReceipt.count();
  const beforeFailure = await isolatedSnapshot();
  failAudit = true;
  await assert.rejects(
    commit(rollback, "rollback.xlsx", [], rollbackPreview),
    /injected audit failure/,
  );
  failAudit = false;
  assert.equal(await prisma.lastPaymentImport.count(), batchesBefore);
  assert.equal(await prisma.lastPaymentReceipt.count(), rowsBefore);
  assert.deepEqual(
    await isolatedSnapshot(),
    beforeFailure,
    "Failed import rolls back the ENTIRE write set",
  );
  await commit(rollback, "rollback.xlsx", [], rollbackPreview);
  assert.deepEqual(
    await operationalSnapshot(),
    original,
    "rollback and retry leave all operational data unchanged",
  );

  const stale = book([["2024-04-01", "Dealer Beta", "Receipt", "STALE", 999]]);
  const stalePreview = await svc.analyzeHistoricalDaybook(admin, stale, "stale.xlsx", {});
  await prisma.dealerAlias.create({
    data: { systemDealerId: "a", tallyName: "Dealer Beta", tallyKey: "dealerbeta" },
  });
  await denied(commit(stale, "stale.xlsx", [], stalePreview), 409);
  await prisma.dealerAlias.delete({ where: { tallyKey: "dealerbeta" } });

  const race = book([["2024-06-01", "Dealer Beta", "Receipt", "RACE", 111]]);
  const racePreview = await svc.analyzeHistoricalDaybook(admin, race, "race.xlsx", {});
  const raced = await Promise.all([
    commit(race, "race.xlsx", [], racePreview),
    commit(race, "race.xlsx", [], racePreview),
  ]);
  assert.equal(raced.filter((r) => r.alreadyImported).length, 1);
  const overlapA = book([
    ["2024-06-03", "Dealer Beta", "Receipt", "COMMON", 501],
    ["2024-06-04", "Dealer Beta", "Receipt", "ONLY-A", 502],
  ]);
  const overlapB = book([["2024-06-03", "Dealer Beta", "Receipt", "COMMON", 501]]);
  const previewA = await svc.analyzeHistoricalDaybook(admin, overlapA, "overlap-a.xlsx", {});
  const previewB = await svc.analyzeHistoricalDaybook(admin, overlapB, "overlap-b.xlsx", {});
  const beforeOverlapping = await operationalSnapshot();
  const overlapping = await Promise.allSettled([
    commit(overlapA, "overlap-a.xlsx", [], previewA),
    commit(overlapB, "overlap-b.xlsx", [], previewB),
  ]);
  assert.equal(overlapping.filter((r) => r.status === "fulfilled").length, 1);
  const rejectedOverlap = overlapping.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(
    rejectedOverlap.reason.status,
    409,
    "Overlapping stale preview must be reviewed again under the receipt lock",
  );
  assert.deepEqual(await operationalSnapshot(), beforeOverlapping);
  const many = book(
    Array.from({ length: 1000 }, (_, i) => [
      "2023-01-01",
      "Dealer Beta",
      "Receipt",
      `B${i}`,
      i + 1,
    ]),
  );
  assert.equal((await commit(many, "large.xlsx")).imported, 1000);
  // Same-day amounts differ; no invented dealer/date-only duplicate key.
  assert.equal(
    await prisma.lastPaymentReceipt.count({
      where: { dealerId: "b", receiptDate: new Date("2023-01-01") },
    }),
    1000,
  );

  // Real monthly endpoint/service: unchanged financial totals plus isolated individual receipt retention.
  await commit(
    book([["2025-12-19", "Dealer Epsilon", "Receipt", "E-H", 700]]),
    "epsilon-history.xlsx",
  );
  const normal = book([
    ["2025-12-12", "Old Alpha Alias", "Receipt", "N1", 5000],
    ["2025-12-20", "Old Alpha Alias", "Receipt", "N2", 7000],
    ["2025-12-21", "Old Alpha Alias", "Credit Note", "NC", 300],
    ["2025-12-10", "Old Alpha Alias", "Receipt", "H3", 15000],
    ["2025-12-14", "Dealer Gamma", "Receipt", "C1", 9000],
    ["2025-12-14", "Dealer Gamma", "Receipt", "C2", 9000],
    ["2025-12-17", "Dealer Delta", "Receipt", "D1", 8000],
    ["2025-12-02", "Dealer Epsilon", "Receipt", "E1", 50],
    ["2025-12-18", "Dealer Gamma", "Sales Return", "CSR", 25],
    ["2025-12-23", "Dealer Delta", "Journal", "J", 99999],
    ["2025-12-24", "Dealer Gamma", "Sales", "INV", 99999],
  ]);
  const beforeNormal = await operationalSnapshot();
  const normalPreviewBefore = await isolatedSnapshot();
  const normalPreview = await recovery.analyzeDaybook(admin, normal, "normal.xlsx", {
    seasonMonthId: "m12",
  });
  assert.equal(normalPreview.summary.receiptTotal, 53050);
  assert.equal(normalPreview.summary.srCrTotal, 325);
  assert.deepEqual(
    await isolatedSnapshot(),
    normalPreviewBefore,
    "Monthly analyze also remains read-only",
  );
  assert.equal(
    (await read.latestReceiptAsOfByDealer(["c", "d"], new Date("2025-12-31"))).size,
    0,
    "Fresh dealers have no receipt history",
  );
  const normalResult = await recovery.commitDaybook(admin, normal, "normal.xlsx", {
    seasonMonthId: "m12",
  });
  assert.equal(normalResult.receiptTotal, 53050);
  assert.equal(normalResult.srCrTotal, 325);
  assert.ok(!normalResult.receiptHistoryWarning);
  const monthlyRow = await prisma.recoveryPlanDealer.findUniqueOrThrow({
    where: { recoveryPlanId_dealerId: { recoveryPlanId: "p12", dealerId: "a" } },
  });
  assert.equal(Number(monthlyRow.liveRecovery), 27000);
  assert.equal(Number(monthlyRow.srCr), 300);
  assert.equal(Number(monthlyRow.outstanding), 90000);
  assert.equal(Number(monthlyRow.monthRecoveryPlan), 30000);
  const afterMonthly = await operationalSnapshot();
  for (const table of Object.keys(beforeNormal))
    if (table !== "RecoveryPlanDealer")
      assert.equal(
        afterMonthly[table],
        beforeNormal[table],
        `Normal upload changed unrelated table ${table}`,
      );
  const oldRows = JSON.parse(beforeNormal.RecoveryPlanDealer) as Record<string, unknown>[];
  const newRows = JSON.parse(afterMonthly.RecoveryPlanDealer) as Record<string, unknown>[];
  for (const row of oldRows) {
    const next = newRows.find((r) => r.id === row.id)!;
    for (const field of Object.keys(row))
      if (
        !["updatedAt", "srCr", "liveRecovery", "lastReceiptDate", "lastReceiptAmount"].includes(
          field,
        )
      )
        assert.deepEqual(
          next[field],
          row[field],
          `Normal upload changed protected RecoveryPlanDealer.${field}`,
        );
  }
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["c"], new Date("2025-12-31"))).get("c")),
    { date: "2025-12-14", amount: 9000 },
    "Distinct same-day receipts select one payment, never a sum",
  );
  assert.equal(
    await prisma.lastPaymentReceipt.count({
      where: { dealerId: "c", receiptDate: new Date("2025-12-14") },
    }),
    2,
  );
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["e"], new Date("2025-12-31"))).get("e")),
    { date: "2025-12-19", amount: 700 },
    "Older normal receipt does not replace a newer eligible historical receipt",
  );
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["a"], new Date("2025-12-10"))).get("a")),
    { date: "2025-12-10", amount: 15000 },
    "Cross-source overlap is not counted twice",
  );
  assert.equal(
    await prisma.lastPaymentReceipt.count({
      where: { dealerId: "a", receiptDate: new Date("2025-12-10"), creditAmount: 15000 },
    }),
    2,
    "Ambiguous cross-source identity is retained as provenance, never summed",
  );
  const historicalAfterNormal = book([["2025-12-05", "Dealer Delta", "Receipt", "D-H", 4000]]);
  const beforeOlderHistory = await operationalSnapshot();
  await commit(historicalAfterNormal, "normal-first-then-history.xlsx");
  assert.deepEqual(await operationalSnapshot(), beforeOlderHistory);
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["d"], new Date("2025-12-10"))).get("d")),
    { date: "2025-12-05", amount: 4000 },
  );
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["d"], new Date("2025-12-31"))).get("d")),
    { date: "2025-12-17", amount: 8000 },
    "Normal-first then older historical import keeps the newer normal payment",
  );
  const overlapPreview = await svc.analyzeHistoricalDaybook(
    admin,
    book([["2025-12-17", "Dealer Delta", "Receipt", "D1", 8000]]),
    "same-payment-revised.xlsx",
    {},
  );
  assert.equal(
    overlapPreview.canCommit,
    false,
    "Cross-source ambiguity is reported instead of inventing identity",
  );
  assert.ok(overlapPreview.rows[0].reviewReasons.length);
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["a"], new Date("2025-12-15"))).get("a")),
    { date: "2025-12-12", amount: 5000 },
    "earlier monthly receipt survives later receipt beyond cutoff",
  );
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["a"], new Date("2025-12-31"))).get("a")),
    { date: "2025-12-20", amount: 7000 },
  );
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["a"], new Date("2025-11-30"))).get("a")),
    { date: "2025-07-15", amount: 20000 },
  );
  const count = await prisma.lastPaymentReceipt.count();
  await recovery.commitDaybook(admin, normal, "normal.xlsx", { seasonMonthId: "m12" });
  assert.equal(
    await prisma.lastPaymentReceipt.count(),
    count,
    "normal retry does not duplicate history",
  );
  await prisma.dealerAlias.update({
    where: { tallyKey: "oldalphaalias" },
    data: { systemDealerId: "d" },
  });
  await recovery.commitDaybook(admin, normal, "normal.xlsx", { seasonMonthId: "m12" });
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["a"], new Date("2025-12-31"))).get("a")),
    { date: "2025-12-10", amount: 15000 },
    "Re-upload after an alias mapping change must not expose stale regular receipts against the old dealer",
  );
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["d"], new Date("2025-12-15"))).get("d")),
    { date: "2025-12-12", amount: 5000 },
    "Individual receipts must follow the same current dealer mapping as the normal financial upload",
  );
  await prisma.dealerAlias.update({
    where: { tallyKey: "oldalphaalias" },
    data: { systemDealerId: "a" },
  });
  await recovery.commitDaybook(admin, normal, "normal.xlsx", { seasonMonthId: "m12" });
  assert.deepEqual(
    plain((await read.latestReceiptAsOfByDealer(["a"], new Date("2025-12-15"))).get("a")),
    { date: "2025-12-12", amount: 5000 },
  );
  const activeBefore = await prisma.lastPaymentImport.findMany({
    where: { kind: "REGULAR", isActive: true },
    orderBy: { id: "asc" },
  });
  await assert.rejects(
    svc.retainRegularReceipts(
      admin,
      book([["2025-12-01", "Dealer Alpha", "Receipt", "STALE", 1]]),
      "stale-normal.xlsx",
      "m12",
      [{ dealerId: "a", date: new Date("2025-12-01"), amount: 1, sourceOrder: 2 }],
      [
        {
          planId: "p12",
          dealerId: "a",
          receipt: 1,
          srCr: 0,
          lastReceiptDate: new Date("2025-12-01"),
          lastReceiptAmount: 1,
        },
      ],
    ),
    /newer monthly upload/,
  );
  assert.deepEqual(
    await prisma.lastPaymentImport.findMany({
      where: { kind: "REGULAR", isActive: true },
      orderBy: { id: "asc" },
    }),
    activeBefore,
    "stale retention cannot supersede current receipt history",
  );
  const afterNormal = await operationalSnapshot();
  const later = book([["2026-01-01", "Old Alpha Alias", "Receipt", "LATER", 9876]]);
  await commit(later, "later.xlsx");
  assert.deepEqual(
    await operationalSnapshot(),
    afterNormal,
    "historical upload after monthly import does not modify ANY operational table",
  );
  failAudit = true;
  const fallbackResult = await recovery.commitDaybook(admin, normal, "normal.xlsx", {
    seasonMonthId: "m7",
  });
  failAudit = false;
  assert.ok(
    fallbackResult.receiptHistoryWarning,
    "isolated retention failure is visible, not a financial rollback",
  );
  assert.equal(fallbackResult.receiptTotal, 53050);
  await verifyCalendarScenarios();
  console.log(
    `Historical Daybook PostgreSQL integration passed: ${Object.keys(original).length} operational tables unchanged, calendar-month preview/views, multi-year scenarios, cutoff independence, unresolved identity, aliases/ambiguity, distinct same-day receipts, duplicate/conflict review, retry/race, audit rollback, 1,000 rows and real monthly retention/regression.`,
  );
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
