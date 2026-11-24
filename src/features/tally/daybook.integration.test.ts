/** Only run against a fresh disposable PostgreSQL instance. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { indiaDay } from "./billwise";
import { hashSales, salesPeriod } from "./sales";
import { DAYBOOK_CHUNK_BYTES, DAYBOOK_CAPTURE_BYTES } from "./daybook-upload";

const url = process.env.TALLY_DISPOSABLE_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  !new URL(url).searchParams.get("host")?.startsWith("/tmp/tally-test-pg.")
)
  throw Error("Disposable local PostgreSQL required");
process.env.DATABASE_URL = url;
process.env.TALLY_SYNC_ENABLED = "true";
process.env.TALLY_EXPECTED_DB_HOST = "localhost";
const prisma = new PrismaClient();
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let approved = true;
const require = createRequire(import.meta.url);
const modules = new Map<string, { exports: unknown }>();
function load<T>(file: string): T {
  const path = resolve(file);
  const loaded = modules.get(path);
  if (loaded) return loaded.exports as T;
  const mod: { exports: unknown } = { exports: {} };
  modules.set(path, mod);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    Buffer,
    Date,
    Map,
    Set,
    URL,
    process,
    require(name: string) {
      if (name === "server-only" || name === "@/lib/audit") return {};
      if (name === "@/lib/prisma") return { prisma };
      if (name === "@/lib/http") return { ApiError };
      if (name.endsWith("sales-rollout")) return { approvedTestPreview: () => approved };
      const local = name.startsWith("@/")
        ? resolve("src", name.slice(2))
        : name.startsWith(".")
          ? resolve(dirname(path), name)
          : null;
      if (local && existsSync(local + ".ts")) return load(local + ".ts");
      return require(name);
    },
  });
  return mod.exports as T;
}
const svc = load<typeof import("./daybook.server")>("src/features/tally/daybook.server.ts");
const report = load<typeof import("@/lib/dealer-last-payment.server")>(
  "src/lib/dealer-last-payment.server.ts",
);
const recovery = load<typeof import("@/lib/last-payment.server")>("src/lib/last-payment.server.ts");
const today = indiaDay();
const current = today.slice(0, 7);
const last = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, 0))
  .toISOString()
  .slice(0, 10);
const month = last.slice(0, 7);
const prefix = "8bc293b5-f31b-464e-b2e1-42d4edb59b7d";
const anchor = prefix + "-00002385";
const auth = {
  userId: "daybook-admin",
  username: "daybook-admin",
  role: Role.SUPER_ADMIN,
  groupId: null,
};
const id = randomUUID();
const secret = "A".repeat(43);
function call(body: unknown) {
  return svc.daybookAgent(
    new Request("https://test.example/api/tally/daybook-agent", {
      headers: { "x-agent-id": id, authorization: "Bearer " + secret },
    }),
    body,
  );
}
async function claim(requestId: string = randomUUID()) {
  const response = await call({ action: "claim", requestId });
  assert.ok("job" in response);
  return { job: response.job };
}
function credit(n: number, ledgerName: string, creditAmount: string, category = "receipt") {
  return {
    guid: prefix + "-" + String(n).padStart(8, "0"),
    date: last,
    voucherNumber: String(n),
    voucherType: category === "receipt" ? "Receipt" : "SALES RETURN-MP",
    category,
    ledgerName,
    creditAmount,
    creditSelection: "named_party",
  };
}

async function testDealerAudit() {
  const audit = load<typeof import("./dealer-audit.server")>(
    "src/features/tally/dealer-audit.server.ts",
  );
  const send = (body: unknown, at: string) =>
    audit.dealerAuditAgent(
      new Request("https://test.example/api/tally/dealer-audit-agent", {
        headers: { "x-agent-id": id, authorization: "Bearer " + secret },
      }),
      body,
      new Date(at),
    );
  function ledger(n: number, name: string, group = "Sundry Debtors") {
    return { guid: prefix + "-" + String(n).padStart(8, "0"), name, group };
  }

  await prisma.dealerAlias.create({
    data: {
      tallyName: "Original Tally Alias",
      tallyKey: "originaltallyalias",
      systemDealerId: "daybook-dealer",
    },
  });
  await prisma.tallyLedgerBinding.create({
    data: { aliasKey: "originaltallyalias", connectionId: id, guid: ledger(2, "").guid },
  });

  const claimBody = { action: "claim", requestId: randomUUID() };
  const firstDay = "2026-11-17T08:30:00Z"; // 2:00 pm IST
  assert.equal((await send(claimBody, "2026-11-17T08:29:59Z")).job, null);
  const firstJob = (await send(claimBody, firstDay)).job;
  assert.ok(firstJob);
  assert.equal((await send({ ...claimBody, requestId: randomUUID() }, firstDay)).job, null);
  const recoveredJob = (await send(claimBody, firstDay)).job;
  assert.ok(recoveredJob);
  assert.equal(recoveredJob.id, firstJob.id);

  const firstRows = [
    { name: "Anchor", guid: anchor, group: "Sundry Debtors" },
    ledger(1, "Payment Only Dealer"),
    ledger(2, "Renamed Ledger"),
    ledger(3, "Repeat Dealer", "UP"),
    ledger(4, "repeat  dealer", "MP"),
    ledger(5, "Employee", "SUNDRY DEBTORS-EMP"),
  ];
  const publish = (job: typeof firstJob, ledgers: typeof firstRows, at: string) =>
    send({ action: "complete", jobId: job.id, leaseToken: job.leaseToken, ledgers }, at);
  await assert.rejects(publish(firstJob, firstRows, firstDay), /no longer active/);
  assert.ok((await publish(recoveredJob, firstRows, firstDay)).ok);
  assert.ok((await publish(recoveredJob, firstRows, firstDay)).duplicate);
  assert.equal((await send({ ...claimBody, requestId: randomUUID() }, firstDay)).job, null);
  const initial = await audit.dealerAuditStatus(auth);
  assert.equal(initial.summary?.scanned, 4);
  assert.equal(initial.summary?.matched, 2);
  assert.equal(
    JSON.stringify(initial.summary?.unmatched.find((r) => r.name === "Repeat Dealer")?.groups),
    '["MP","UP"]',
  );

  const nextDay = "2026-11-18T08:30:00Z";
  const failedJob = (await send({ ...claimBody, requestId: randomUUID() }, nextDay)).job;
  assert.ok(failedJob);
  assert.ok((await publish(failedJob, firstRows.slice(1), nextDay)).rejected);
  const failed = await audit.dealerAuditStatus(auth);
  assert.equal(failed.failed, true);
  assert.equal(JSON.stringify(failed.summary), JSON.stringify(initial.summary));
  assert.equal((await send({ ...claimBody, requestId: randomUUID() }, nextDay)).job, null);

  const retryAt = "2026-11-18T08:35:00Z";
  const nextJob = (await send({ ...claimBody, requestId: randomUUID() }, retryAt)).job;
  assert.ok(nextJob);
  const nextRows = [
    firstRows[0],
    firstRows[1],
    ledger(3, "Repeat Dealer", "WB"),
    ledger(6, "New Dealer", "CG"),
  ];
  assert.ok((await publish(nextJob, nextRows, retryAt)).ok);
  const latest = await audit.dealerAuditStatus(auth);
  assert.equal(latest.failed, false);
  assert.equal(latest.completedAt, new Date(retryAt).toISOString());
  assert.equal(latest.summary?.unmatched.filter((r) => r.name === "Repeat Dealer").length, 1);
  assert.equal(
    latest.summary?.unmatched.find((r) => r.name === "Repeat Dealer")?.groups.join(),
    "WB",
  );
  assert.ok(latest.summary?.unmatched.some((r) => r.name === "New Dealer"));
  const manualAt = "2026-11-18T08:40:00Z";
  await audit.requestDealerAudit(auth, new Date(manualAt));
  await audit.requestDealerAudit(auth, new Date(manualAt));
  const manualJob = (await send({ ...claimBody, requestId: randomUUID() }, manualAt)).job;
  assert.ok(manualJob, "manual refresh can run after today's successful scan");
  await audit.requestDealerAudit(auth, new Date(manualAt));
  assert.equal((await send({ ...claimBody, requestId: randomUUID() }, manualAt)).job, null);
  assert.ok((await publish(manualJob, firstRows, manualAt)).ok);
  assert.equal((await audit.dealerAuditStatus(auth)).refreshState, null);
  assert.equal((await send({ ...claimBody, requestId: randomUUID() }, manualAt)).job, null);
  const morning = "2026-11-19T03:30:00Z";
  assert.equal((await send({ ...claimBody, requestId: randomUUID() }, morning)).job, null);
  await assert.rejects(
    audit.requestDealerAudit({ ...auth, role: Role.SALES_OFFICER }, new Date(morning)),
    /Super Admin/,
  );
  await audit.requestDealerAudit(auth, new Date(morning));
  const morningJob = (await send({ ...claimBody, requestId: randomUUID() }, morning)).job;
  assert.ok(morningJob, "manual refresh can run before 2 pm IST");
  assert.ok((await publish(morningJob, nextRows, morning)).ok);
  assert.equal((await audit.dealerAuditStatus(auth)).summary?.scanned, latest.summary?.scanned);
  console.log(
    "Dealer reconciliation scheduling, manual refresh, authorization, deduplication, retries and replacement passed.",
  );
}

async function testIgnoredComparison() {
  const comparison = load<typeof import("./daybook-sales-comparison.server")>(
    "src/features/tally/daybook-sales-comparison.server.ts",
  );
  const connection = await prisma.tallyConnection.create({
    data: {
      companyName: "Agromaxx Industry (2026-27)",
      anchorName: "Anchor",
      anchorGuid: "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00000001",
      credentialHash: hashSales(secret),
      authorizedById: auth.userId,
    },
  });
  try {
    const emptyBill = {
      guid: "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00010135",
      masterId: "65845",
      alterId: "152380",
      billDate: "2026-07-23",
      billNumber: "CG/RB/26-27/0217",
      typeName: "CREDIT SALE-CG",
      family: "Sales",
      partyName: "",
      cancelled: true,
      optional: true,
      items: [],
      ledgerEntries: [],
    };
    const otherBill = {
      ...emptyBill,
      guid: "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00011479",
      masterId: "70777",
      alterId: "163473",
      billDate: "2026-07-24",
      billNumber: "CG/RB/26-27/0215",
      partyName: "Synthetic Branch",
      cancelled: false,
      optional: false,
      items: [
        {
          lineNo: 0,
          stockItemName: "Synthetic product",
          quantity: "1.000000",
          unit: "Kg",
          amount: "10.00",
          actualQty: "1 Kg",
          billedQty: "1 Kg",
          rate: "10/Kg",
        },
      ],
    };
    const snapshot = await prisma.tallySalesSnapshot.create({
      data: {
        connectionId: connection.id,
        monthKey: "2026-07",
        fromDate: "2026-07-01",
        throughDate: "2026-07-31",
        observedAt: new Date(),
        sourceHash: hashSales("ignored-case-test"),
        jobId: "ignored-case-test",
        summary: {},
      },
    });
    const source = await prisma.tallySalesVoucher.create({
      data: {
        ...emptyBill,
        billNumber: "CG/RB/26-27/0215",
        snapshotId: snapshot.id,
        items: undefined,
      },
    });
    const { items, ...otherFields } = otherBill;
    const other = await prisma.tallySalesVoucher.create({
      data: { ...otherFields, snapshotId: snapshot.id, items: { create: items } },
    });
    const job = await prisma.tallyDaybookJob.create({
      data: {
        connectionId: connection.id,
        monthKey: "2026-07",
        fromDate: "2026-07-01",
        throughDate: "2026-07-31",
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    const save = (includeCase = true) =>
      prisma.tallyDaybookJob.update({
        where: { id: job.id },
        data: {
          summary: {
            _daybookProducts: {
              observedAt: new Date().toISOString(),
              capture: {
                version: "daybook.products.v1",
                status: "complete",
                voucherTypes: [
                  { typeName: "CREDIT SALE-CG", family: "Sales" },
                  { typeName: "Credit Note", family: "Credit Note" },
                ],
                vouchers: (includeCase ? [emptyBill, otherBill] : [otherBill]).map((bill) => ({
                  ...bill,
                  references: [],
                })),
              },
            },
          } as Prisma.InputJsonValue,
        },
      });
    await save();
    const result = await comparison.compareDaybookSales(auth, job.id);
    assert.equal(result.status, "matched_with_ignored");
    assert.equal(result.counts!.matchedBills, 1);
    assert.equal(result.counts!.ignoredBills, 1);
    assert.equal(result.counts!.differentBills, 0);
    assert.equal(result.differenceCount, 0);
    assert.equal(result.ignoredCases![0].sales!.number, "CG/RB/26-27/0215");
    assert.equal(result.ignoredCases![0].daybook!.number, "CG/RB/26-27/0217");
    await prisma.tallySalesItem.update({
      where: { voucherId_lineNo: { voucherId: other.id, lineNo: 0 } },
      data: { quantity: "2.000000" },
    });
    const changed = await comparison.compareDaybookSales(auth, job.id);
    assert.equal(changed.status, "different");
    assert.equal(changed.counts!.ignoredBills, 1);
    assert.equal(
      changed.counts!.differentBills,
      1,
      "An unrelated real quantity mismatch is never suppressed",
    );
    await prisma.tallySalesVoucher.update({ where: { id: source.id }, data: { cancelled: false } });
    const active = await comparison.compareDaybookSales(auth, job.id);
    assert.equal(active.counts!.ignoredBills, 0);
    assert.equal(
      active.counts!.differentBills,
      2,
      "The exception stops applying if this record's status changes",
    );
    await save(false);
    const missing = await comparison.compareDaybookSales(auth, job.id);
    assert.equal(missing.counts!.onlySales, 1);
    assert.equal(missing.counts!.ignoredBills, 0, "A missing side is not ignored");
    console.log(
      "Specific user-requested comparison exception: separate ignored count/evidence, other active same-number bills still checked, changed status and missing side not suppressed: PASS",
    );
  } finally {
    await prisma.tallyConnection.delete({ where: { id: connection.id } });
  }
}

async function main() {
  await prisma.$executeRawUnsafe('TRUNCATE "TallyConnection", "User", "Dealer", "Season" CASCADE');
  await prisma.user.create({
    data: {
      id: auth.userId,
      username: auth.username,
      name: "Synthetic Admin",
      role: auth.role,
      passwordHash: "disabled",
    },
  });
  await prisma.tallyConnection.create({
    data: {
      id,
      companyName: "Synthetic Company",
      anchorName: "Anchor",
      anchorGuid: anchor,
      credentialHash: hashSales(secret),
      authorizedById: auth.userId,
    },
  });
  await prisma.season.create({
    data: { id: "daybook-season", name: "Synthetic", year: +month.slice(0, 4), status: "OPEN" },
  });
  await prisma.seasonMonth.create({
    data: {
      id: "daybook-month",
      seasonId: "daybook-season",
      name: "Previous month",
      order: 1,
      status: "OPEN",
      calendarMonth: +month.slice(5, 7),
      calendarYear: +month.slice(0, 4),
    },
  });
  await prisma.dealer.createMany({
    data: [
      { id: "daybook-dealer", name: "Verified Dealer", isActive: true },
      { id: "daybook-no-plan", name: "Payment Only Dealer", isActive: false },
      { id: "daybook-bank", name: "Bank Charges", isActive: true },
    ],
  });
  await prisma.recoveryPlan.create({
    data: {
      id: "daybook-plan",
      seasonId: "daybook-season",
      seasonMonthId: "daybook-month",
      officerId: auth.userId,
      cutoffDate: new Date(last),
      status: "APPROVED",
    },
  });
  const dealerId = "daybook-dealer";
  await prisma.recoveryPlanDealer.create({
    data: {
      id: "daybook-row",
      recoveryPlanId: "daybook-plan",
      dealerId,
      outstanding: 750,
      monthRecoveryPlan: 500,
      liveRecovery: 999,
      lastReceiptDate: new Date(last),
      lastReceiptAmount: 999,
    },
  });
  await prisma.dealerPaymentReceipt.createMany({
    data: [
      { dealerId, receiptDate: new Date(last), amount: 999, occurrence: 1, sourceKind: "REGULAR" },
      { dealerId, receiptDate: new Date(today), amount: 333, occurrence: 1, sourceKind: "REGULAR" },
    ],
  });
  const requestId = randomUUID();
  const initial = await claim(requestId);
  assert.equal(initial.job?.monthKey, current);
  assert.equal((await claim(requestId)).job?.id, initial.job?.id);
  const active = await prisma.tallyDaybookJob.findUniqueOrThrow({ where: { id: initial.job!.id } });
  assert.equal(active.status, "RUNNING");
  assert.equal((await claim()).job, null, "one running lease");
  await prisma.tallyDaybookJob.update({ where: { id: active.id }, data: { status: "FAILED" } });
  await svc.requestDaybookRefresh(auth, month);
  await svc.requestDaybookRefresh(auth, month);
  assert.equal(await prisma.tallyDaybookJob.count({ where: { monthKey: month } }), 1);
  async function refresh(
    vouchers: unknown[],
    throughDate = last,
    coverage?: "all_vouchers",
    productCapture?: unknown,
  ) {
    await svc.requestDaybookRefresh(auth, month);
    const { job } = await claim();
    assert.ok(job);
    assert.equal(job.monthKey, month);
    const period = salesPeriod(month, today);
    const body = {
      action: "complete",
      jobId: job.id,
      leaseToken: job.leaseToken,
      capture: {
        version: "daybook.capture.v1",
        companyName: "Synthetic Company",
        month,
        fromDate: period.fromDate,
        throughDate,
        observedAt: new Date().toISOString(),
        uploaded: false,
        ...(coverage ? { coverage } : {}),
        ...(productCapture ? { productCapture } : {}),
        vouchers,
      },
    };
    return { reply: await call(body), retry: () => call(body) };
  }
  const vouchers: unknown[] = [
    {
      ...credit(1, "Verified Dealer", "5.25"),
      voucherNumber: "",
      billAllocations: {
        scope: "selected_credit",
        entryCount: 2,
        entries: [
          {
            ledgerLineNumber: 1,
            allocationNumber: 1,
            ledgerName: "Verified Dealer",
            billReference: "INV-101",
            referenceType: "Agst Ref",
            amount: "3.00",
          },
          {
            ledgerLineNumber: 1,
            allocationNumber: 2,
            ledgerName: "Verified Dealer",
            billReference: "INV-102",
            referenceType: "Agst Ref",
            amount: "2.25",
          },
        ],
      },
    },
    credit(2, "Verified Dealer", "8.00"),
    credit(3, "Verified Dealer", "10.00", "srCr"),
    credit(4, "Payment Only Dealer", "50.00"),
    credit(5, "Bank Charges", "900.00"),
    credit(6, "No Candidate", "70.00"),
    credit(7, "Payment Only Dealer", "12.50", "srCr"),
    {
      guid: prefix + "-00000008",
      date: month + "-02",
      voucherNumber: "",
      voucherType: "Cheque Return",
      category: "receipt",
      review: "VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE",
    },
  ];
  vouchers.push(
    {
      guid: prefix + "-00000010",
      date: month + "-02",
      voucherNumber: "",
      voucherType: "Cheque Return",
      category: "other",
      excluded: "unsupported_type",
      ledgerName: "Verified Dealer",
      amount: "25.00",
      direction: "debit",
    },
    {
      guid: prefix + "-00000011",
      date: month + "-02",
      voucherNumber: "J1",
      voucherType: "Journal",
      category: "other",
      excluded: "unsupported_type",
      billAllocations: {
        scope: "voucher_ledgers",
        entryCount: 1,
        entries: [
          {
            ledgerLineNumber: 1,
            allocationNumber: 1,
            ledgerName: "Payment Only Dealer",
            billReference: "INV-J1",
            referenceType: "Agst Ref",
            amount: "45.00",
          },
        ],
      },
      details: {
        stage: "vouchers",
        month,
        fromDate: month + "-01",
        throughDate: last,
        voucher: {
          guid: prefix + "-00000011",
          date: month + "-02",
          voucherNumber: "J1",
          voucherType: "Journal",
          narration: "Adjustment details",
          ledgerEntryCount: 2,
          ledgerEntries: [
            {
              lineNumber: 1,
              ledgerName: "Payment Only Dealer",
              amount: "45.00",
              isDeemedPositive: "No",
            },
            {
              lineNumber: 2,
              ledgerName: "Adjustment account",
              amount: "-45.00",
              isDeemedPositive: "Yes",
            },
          ],
          inventoryEntries: [],
          inventoryEntryCount: 0,
        },
      },
      ledgerName: "Payment Only Dealer",
      amount: "45.00",
      direction: "credit",
    },
    {
      guid: prefix + "-00000012",
      date: month + "-02",
      voucherNumber: "R12",
      voucherType: "Receipt",
      category: "receipt",
      excluded: "cancelled",
      ledgerName: "Verified Dealer",
      amount: "999.00",
      direction: "credit",
    },
  );
  const firstProducts = {
    version: "daybook.products.v1",
    status: "complete",
    voucherTypes: [
      { typeName: "Sales", family: "Sales" },
      { typeName: "SALES RETURN-MP", family: "Credit Note" },
    ],
    vouchers: [3, 7].map((number) => ({
      guid: prefix + "-" + String(number).padStart(8, "0"),
      masterId: String(number),
      alterId: "1",
      billDate: last,
      billNumber: String(number),
      typeName: "SALES RETURN-MP",
      family: "Credit Note",
      partyName: number === 3 ? "Verified Dealer" : "Payment Only Dealer",
      cancelled: false,
      optional: false,
      references: [],
      ledgerEntries: [],
      items: [
        {
          lineNo: 0,
          stockItemName: "Original return product",
          quantity: "-1.000000",
          amount: number === 3 ? "-10.00" : "-12.50",
          unit: "Kg",
          actualQty: "1 Kg",
          billedQty: "1 Kg",
          rate: "",
        },
      ],
    })),
  };
  const first = await refresh(vouchers, last, "all_vouchers", firstProducts);
  assert.ok(first.reply.ok);
  const published = await svc.daybookStatus(auth, month);
  const summary = published.published!.summary as {
    receiptCount: number;
    srCrCount: number;
    coverage: string;
    excluded: number;
    excludedVouchers: {
      voucherType: string;
      reason: string;
      dealerName?: string;
      amount?: string;
      details?: import("./daybook-diagnostics").DaybookDiagnostics;
      billAllocations?: import("./daybook-bill-allocations").DaybookBillAllocations;
    }[];
    dealerRows: {
      dealerName: string;
      srCr: string;
      liveRecovery: string;
      other: string | null;
      status: string;
      reason?: string;
      creditVouchers?: import("./daybook-preview").DaybookCredit[];
    }[];
  };
  const storedProductJob = await prisma.tallyDaybookJob.findUniqueOrThrow({
    where: { id: published.published!.id },
  });
  assert.equal(
    (storedProductJob.summary as { _daybookProducts: { capture: { status: string } } })
      ._daybookProducts.capture.status,
    "complete",
    "product evidence publishes with its Daybook job",
  );
  assert.ok(!("_daybookProducts" in summary), "product data is not exposed in status polling");
  const publicHeaders = (published.published!.summary as { billHeaders?: Record<string, unknown> })
    .billHeaders;
  assert.deepEqual(
    JSON.parse(JSON.stringify(publicHeaders?.[prefix + "-00000003"])),
    {
      subtotal: "-10.00",
      family: "Credit Note",
      active: true,
      hasProducts: true,
      hasQuantity: true,
      isSalesReturn: true,
    },
    "status exposes only the small pre-tax bill header, not full comparison evidence",
  );
  assert.equal(summary.coverage, "all_vouchers");
  assert.equal(summary.receiptCount, 5);
  assert.equal(summary.srCrCount, 2);
  assert.equal(summary.excluded, 4);
  const verifiedSummary = summary.dealerRows.find((r) => r.dealerName === "Verified Dealer")!;
  assert.equal(verifiedSummary.liveRecovery, "13.25");
  assert.equal(verifiedSummary.srCr, "10.00");
  const receiptEvidence = verifiedSummary.creditVouchers!.find(
    (v) => v.guid === prefix + "-00000001",
  )!;
  assert.equal(receiptEvidence.billAllocations!.entries[0].billReference, "INV-101");
  assert.equal(receiptEvidence.billAllocations!.entries[1].billReference, "INV-102");
  assert.equal(receiptEvidence.billAllocations!.entries[1].amount, "2.25");
  assert.equal(receiptEvidence.creditAmount, "5.25");
  assert.equal(verifiedSummary.creditVouchers!.length, 3);

  assert.equal(verifiedSummary.other, "25.00", "cancelled receipts never contribute to Other");
  assert.equal(
    summary.dealerRows.find((r) => r.dealerName === "Payment Only Dealer")!.other,
    "45.00",
  );
  assert.equal(
    summary.dealerRows.find((r) => r.dealerName === "No Candidate")!.status,
    "Needs dealer link",
  );
  assert.match(
    summary.dealerRows.find((r) => r.dealerName === "No Candidate")!.reason!,
    /No exact/,
  );
  assert.equal(summary.excludedVouchers[1].dealerName, "Verified Dealer");
  assert.equal(summary.excludedVouchers[1].amount, "25.00");
  const journalEvidence = summary.excludedVouchers.find((v) => v.voucherType === "Journal")!
    .details!.voucher!;
  assert.equal(journalEvidence.narration, "Adjustment details");
  assert.equal(journalEvidence.ledgerEntries[1].ledgerName, "Adjustment account");
  assert.equal(journalEvidence.ledgerEntries[1].amount, "-45.00");
  assert.equal(
    summary.excludedVouchers.find((v) => v.voucherType === "Journal")!.billAllocations!.entries[0]
      .billReference,
    "INV-J1",
  );

  assert.equal(summary.excludedVouchers[0].voucherType, "Cheque Return");
  assert.equal(summary.excludedVouchers[0].reason, "VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE");
  const replay = await first.retry();
  assert.ok("duplicate" in replay && replay.duplicate);
  const values = () =>
    prisma.recoveryPlanDealer.findUniqueOrThrow({ where: { id: "daybook-row" } });
  let row = await values();
  assert.equal(row.liveRecovery.toFixed(2), "13.25");
  assert.equal(row.srCr.toFixed(2), "10.00");
  assert.equal(row.outstanding.toFixed(2), "750.00");
  assert.equal(row.monthRecoveryPlan?.toFixed(2), "500.00");
  assert.equal(
    (await recovery.latestReceiptAsOfByDealer([dealerId], new Date(last))).get(dealerId)?.amount,
    13.25,
  );
  const payments = await report.loadEffectiveLastPayments(
    [dealerId, "daybook-no-plan", "daybook-bank"],
    today,
  );
  assert.equal(
    payments.get(dealerId)?.amount,
    333,
    "newer November payment survives October refresh",
  );
  assert.equal(payments.get("daybook-no-plan")?.amount, 50);
  const noPlanCoverage = await prisma.tallyDaybookDealerMonth.findUniqueOrThrow({
    where: { monthKey_dealerId: { monthKey: month, dealerId: "daybook-no-plan" } },
  });
  assert.equal(noPlanCoverage.liveRecovery.toFixed(2), "50.00");
  assert.equal(noPlanCoverage.srCr.toFixed(2), "12.50");
  assert.equal(noPlanCoverage.recoveryPlanId, null);
  assert.equal(payments.has("daybook-bank"), false);
  await assert.rejects(
    prisma.$transaction((tx) => svc.assertManualDaybookMonthAvailable(tx, "daybook-month")),
    /Tally Daybook manages/,
  );
  // Exercise actual Python parser evidence -> authenticated agent failure -> saved UI status.
  const signEvidence = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json, sys
import daybook_capture as d
p = json.load(sys.stdin)
raw = f'<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><VOUCHER><GUID>{p["prefix"]}-00000099</GUID><DATE>{p["month"].replace("-", "")}02</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>RCPT-99</VOUCHERNUMBER><PARTYLEDGERNAME>Verified Dealer</PARTYLEDGERNAME><MASTERID>99</MASTERID><ALTERID>100</ALTERID><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ALLLEDGERENTRIES.LIST><LEDGERNAME>Verified Dealer</LEDGERNAME><AMOUNT>-125.50</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER></ALLLEDGERENTRIES.LIST></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>'
try:
    d.parse_vouchers(raw.encode(), None, p["prefix"], p["month"] + "-01", p["last"])
except d.DaybookRejected as error:
    print(json.dumps({"code": str(error), "details": {"companyName": "Synthetic Company", **error.details}}))
`,
    ],
    {
      cwd: resolve("../tally-connector-v1.3/Tally-Office-Connector"),
      input: JSON.stringify({ prefix, month, last }),
      encoding: "utf8",
    },
  );
  assert.equal(signEvidence.status, 0, signEvidence.stderr);
  const evidence = JSON.parse(signEvidence.stdout);
  assert.equal(evidence.details.voucher.amount, "-125.50");
  await svc.requestDaybookRefresh(auth, month);
  const failureJob = (await claim()).job!;
  const failureBody = {
    action: "fail",
    jobId: failureJob.id,
    leaseToken: failureJob.leaseToken,
    ...evidence,
  };
  await assert.rejects(
    call({ ...failureBody, details: { ...evidence.details, companyName: "Another Company" } }),
    /do not match/,
  );
  await assert.rejects(
    call({ ...failureBody, details: { ...evidence.details, month: "2025-01" } }),
    /do not match/,
  );
  await assert.rejects(
    call({
      ...failureBody,
      details: {
        ...evidence.details,
        voucher: { ...evidence.details.voucher, narration: "x".repeat(2049) },
      },
    }),
  );
  assert.ok((await call(failureBody)).ok);
  assert.ok((await call(failureBody)).rejected, "lost failure acknowledgment can replay safely");
  const failureStatus = await svc.daybookStatus(auth, month);
  assert.equal(failureStatus.job?.error, "DAYBOOK_LEDGER_SIGN_MISMATCH");
  const savedDetails = failureStatus.job?.summary as {
    diagnostics: {
      voucher: {
        voucherNumber: string;
        dealerName: string;
        ledgerName: string;
        amount: string;
        isDeemedPositive: string;
        masterId: string;
        ledgerEntries: unknown[];
      };
    };
  };
  assert.equal(savedDetails.diagnostics.voucher.voucherNumber, "RCPT-99");
  assert.equal(savedDetails.diagnostics.voucher.dealerName, "Verified Dealer");
  assert.equal(savedDetails.diagnostics.voucher.ledgerName, "Verified Dealer");
  assert.equal(savedDetails.diagnostics.voucher.isDeemedPositive, "No");
  assert.equal(savedDetails.diagnostics.voucher.masterId, "99");
  assert.equal(savedDetails.diagnostics.voucher.ledgerEntries.length, 1);
  assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
  assert.equal((await values()).srCr.toFixed(2), "10.00");
  assert.equal(
    (await report.loadEffectiveLastPayments([dealerId], today)).get(dealerId)?.amount,
    333,
  );
  await assert.rejects(
    call({ ...failureBody, details: { ...evidence.details, stage: "changed" } }),
    /lease expired/,
  );
  console.log(
    "Daybook Python error evidence, scoped validation, durable failure replay and preservation: PASS",
  );
  const reviewWithDetails = await refresh([
    {
      guid: prefix + "-00000098",
      date: month + "-02",
      voucherNumber: "R98",
      voucherType: "Receipt",
      category: "receipt",
      review: "CREDIT_AMBIGUOUS",
      details: {
        ...evidence.details,
        voucher: {
          ...evidence.details.voucher,
          guid: prefix + "-00000098",
          date: month + "-02",
          voucherNumber: "R98",
        },
      },
    },
  ]);
  assert.ok(reviewWithDetails.reply.rejected);
  const reviewStatus = await svc.daybookStatus(auth, month);
  assert.equal(
    (reviewStatus.job?.summary as { review: { details: { voucher: { dealerName: string } } }[] })
      .review[0].details.voucher.dealerName,
    "Verified Dealer",
  );
  const encodingEvidence = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `
import json, sys
import sales_sync as s
p = json.load(sys.stdin)
raw = (f'<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><VOUCHER><GUID>{p["prefix"]}-00000088</GUID><DATE>{p["month"].replace("-", "")}02</DATE><VOUCHERNUMBER>ENC-88</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><PARTYLEDGERNAME>Verified Dealer</PARTYLEDGERNAME><NARRATION>bad '.encode() + bytes([150]) + b' text</NARRATION></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>')
try:
    s.safe_sales_xml(raw)
except s.EncodingRejected as error:
    print(json.dumps({"code": str(error), "details": {"stage": "vouchers", "companyName": "Synthetic Company", "month": p["month"], "fromDate": p["month"] + "-01", "throughDate": p["last"], **error.details}}))
`,
    ],
    {
      cwd: resolve("../tally-connector-v1.3/Tally-Office-Connector"),
      input: JSON.stringify({ prefix, month, last }),
      encoding: "utf8",
    },
  );
  assert.equal(encodingEvidence.status, 0, encodingEvidence.stderr);
  const encodingFailure = JSON.parse(encodingEvidence.stdout);
  await svc.requestDaybookRefresh(auth, month);
  const encodingJob = (await claim()).job!;
  const encodingBody = {
    action: "fail",
    jobId: encodingJob.id,
    leaseToken: encodingJob.leaseToken,
    ...encodingFailure,
  };
  await assert.rejects(
    call({
      ...encodingBody,
      details: {
        ...encodingFailure.details,
        encoding: { ...encodingFailure.details.encoding, byteOffset: -1 },
      },
    }),
  );
  assert.ok((await call(encodingBody)).ok);
  assert.ok((await call(encodingBody)).rejected);
  const encodingStatus = await svc.daybookStatus(auth, month);
  const storedEncoding = encodingStatus.job?.summary as {
    diagnostics: {
      encoding: {
        byteOffset: number;
        invalidBytesHex: string;
        fieldName: string;
        responseSha256: string;
      };
      voucher: { voucherNumber: string; dealerName: string };
    };
  };
  assert.equal(encodingStatus.job?.error, "SALES_ENCODING_REJECTED");
  assert.equal(
    storedEncoding.diagnostics.encoding.byteOffset,
    encodingFailure.details.encoding.byteOffset,
  );
  assert.equal(storedEncoding.diagnostics.encoding.invalidBytesHex, "96");
  assert.equal(storedEncoding.diagnostics.encoding.fieldName, "NARRATION");
  assert.equal(storedEncoding.diagnostics.encoding.responseSha256.length, 64);
  assert.equal(storedEncoding.diagnostics.voucher.voucherNumber, "ENC-88");
  assert.equal(storedEncoding.diagnostics.voucher.dealerName, "Verified Dealer");
  assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
  assert.equal((await values()).srCr.toFixed(2), "10.00");
  console.log(
    "Encoding byte evidence and recovered voucher metadata reach the status API without changing financial data: PASS",
  );
  const layoutEvidence = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `
import copy,json,sys,tempfile,xml.etree.ElementTree as ET
from pathlib import Path
import daybook_capture as d
p=json.load(sys.stdin)
raw=f'<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><VOUCHER><GUID>{p["prefix"]}-00000001</GUID><DATE>{p["last"].replace("-", "")}</DATE><VOUCHERNUMBER/><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><PARTYLEDGERNAME>Verified Dealer</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ALLLEDGERENTRIES.LIST><LEDGERNAME>Verified Dealer</LEDGERNAME><AMOUNT>5.25</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><BILLALLOCATIONS.LIST><NAME>INV-101</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>3.00</AMOUNT></BILLALLOCATIONS.LIST><BILLALLOCATIONS.LIST><NAME>INV-102</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>2.25</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>'
root=ET.fromstring(raw); voucher=root.find('.//VOUCHER'); alternate=copy.deepcopy(voucher.find('ALLLEDGERENTRIES.LIST')); alternate.tag='LEDGERENTRIES.LIST';voucher.append(alternate)
for bill in alternate.findall('BILLALLOCATIONS.LIST'):
 for tag in ('NAME','BILLTYPE'):
  for field in bill.findall(tag): bill.remove(field)
ET.SubElement(voucher.find('ALLLEDGERENTRIES.LIST'),'ISPARTYLEDGER').text='Yes'
records=d.parse_vouchers(ET.tostring(root),None,p['prefix'],p['month']+'-01',p['last'])
ET.SubElement(alternate.find('BILLALLOCATIONS.LIST'),'NAME').text='INV-CONFLICT'
conflict=ET.tostring(root)
try:
 d.parse_vouchers(conflict,None,p['prefix'],p['month']+'-01',p['last'])
except d.DaybookRejected as e:
 with tempfile.TemporaryDirectory() as folder:
  error=d.save_layout_response({'stateDir':str(Path(folder)/'state')},conflict,e,p['month']+'-01')
  print(json.dumps({'records':records,'failure':{'code':str(error),'details':{'companyName':'Synthetic Company',**error.details}}}))
`,
    ],
    {
      cwd: resolve("../tally-connector-v1.3/Tally-Office-Connector"),
      input: JSON.stringify({ prefix, month, last }),
      encoding: "utf8",
    },
  );
  assert.equal(layoutEvidence.status, 0, layoutEvidence.stderr);
  const layoutPayload = JSON.parse(layoutEvidence.stdout.trim().split("\n").at(-1)!);
  const compatible = await refresh(
    [...layoutPayload.records, ...vouchers.slice(1)],
    last,
    "all_vouchers",
  );
  assert.ok(compatible.reply.ok);
  assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
  assert.equal((await values()).srCr.toFixed(2), "10.00");
  const compatibleReplay = await compatible.retry();
  assert.ok("duplicate" in compatibleReplay && compatibleReplay.duplicate);
  await svc.requestDaybookRefresh(auth, month);
  const layoutJob = (await claim()).job!;
  const layoutBody = {
    action: "fail",
    jobId: layoutJob.id,
    leaseToken: layoutJob.leaseToken,
    ...layoutPayload.failure,
  };
  assert.ok((await call(layoutBody)).ok);
  assert.ok((await call(layoutBody)).rejected);
  const layoutStatus = await svc.daybookStatus(auth, month);
  const layoutDetails = (
    layoutStatus.job!.summary as { diagnostics: import("./daybook-diagnostics").DaybookDiagnostics }
  ).diagnostics;
  assert.equal(layoutStatus.job!.error, "DAYBOOK_LEDGER_LAYOUT_AMBIGUOUS");
  assert.equal(layoutDetails.voucher!.ledgerLayouts!.length, 2);
  assert.equal(
    layoutDetails.voucher!.ledgerLayouts![0].entries[0].billReferences![0].name,
    "INV-101",
  );
  assert.equal(
    layoutDetails.voucher!.ledgerLayouts![1].entries[0].billReferences![0].name,
    "INV-CONFLICT",
  );
  assert.equal(layoutDetails.layoutResponse!.captureStatus, "saved");
  assert.equal(layoutDetails.layoutResponse!.responseSha256.length, 64);
  assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
  assert.equal((await values()).srCr.toFixed(2), "10.00");
  console.log(
    "Compatible ledger layouts publish once; conflicting bill references retain both sections/source file evidence without changing financial data: PASS",
  );
  const billLookup = load<typeof import("./daybook-bill-products.server")>(
    "src/features/tally/daybook-bill-products.server.ts",
  );
  const comparison = load<typeof import("./daybook-sales-comparison.server")>(
    "src/features/tally/daybook-sales-comparison.server.ts",
  );
  const sourceJobId = published.published!.id;
  const sourceJob = await prisma.tallyDaybookJob.findUniqueOrThrow({ where: { id: sourceJobId } });
  const sourceSummary = sourceJob.summary as Prisma.JsonObject;
  const lookupInput = {
    jobId: sourceJobId,
    voucherGuid: prefix + "-00000001",
    ledgerLineNumber: 1,
    allocationNumber: 1,
    reference: "INV-101",
  };
  await assert.rejects(
    billLookup.getDaybookBillProducts({ ...auth, role: Role.SALES_OFFICER }, lookupInput),
    /Super Admin/,
  );
  await assert.rejects(
    comparison.compareDaybookSales({ ...auth, role: Role.SALES_OFFICER }, sourceJobId),
    /Super Admin/,
  );
  await assert.rejects(
    billLookup.getDaybookBillProducts(auth, { ...lookupInput, reference: "FORGED-BILL" }),
    /does not match/,
  );
  await assert.rejects(
    billLookup.getDaybookBillProducts(auth, { ...lookupInput, voucherGuid: prefix + "-ffffffff" }),
    /not uniquely identified/,
  );
  const beforeLookup = await values();
  const lookupAlias = await prisma.dealerAlias.create({
    data: {
      tallyName: "Original Tally Alias",
      tallyKey: "originaltallyalias",
      systemDealerId: "daybook-dealer",
    },
  });
  const invoiceMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 2, 1))
    .toISOString()
    .slice(0, 7);
  const snapshot = await prisma.tallySalesSnapshot.create({
    data: {
      connectionId: id,
      monthKey: invoiceMonth,
      fromDate: invoiceMonth + "-01",
      throughDate: invoiceMonth + "-28",
      observedAt: new Date(),
      sourceHash: hashSales("bill-products-fixture"),
      jobId: "bill-products-test",
      summary: {},
    },
  });
  const originalBill = await prisma.tallySalesVoucher.create({
    data: {
      snapshotId: snapshot.id,
      guid: prefix + "-0000abcd",
      masterId: "11",
      alterId: "12",
      billDate: invoiceMonth + "-03",
      billNumber: "INV-101",
      typeName: "Sales",
      family: "Sales",
      partyName: "Original Tally Alias",
      cancelled: false,
      optional: false,
      ledgerEntries: [],
      items: {
        create: [
          {
            lineNo: 0,
            stockItemName: "NEON original pack",
            quantity: "1.500000",
            unit: "Kg",
            amount: "100.25",
            actualQty: "1.5 Kg",
            billedQty: "1.5 Kg",
            rate: "",
          },
          {
            lineNo: 1,
            stockItemName: "Unmapped original product",
            quantity: "2.000000",
            unit: "Nos",
            amount: "45.00",
            actualQty: "2 Nos",
            billedQty: "2 Nos",
            rate: "",
          },
        ],
      },
    },
  });
  const otherBill = await prisma.tallySalesVoucher.create({
    data: {
      snapshotId: snapshot.id,
      guid: prefix + "-0000abce",
      masterId: "13",
      alterId: "14",
      billDate: invoiceMonth + "-03",
      billNumber: "INV-101",
      typeName: "Sales",
      family: "Sales",
      partyName: "Different party",
      cancelled: false,
      optional: false,
      ledgerEntries: [],
    },
  });
  assert.equal(
    (await billLookup.getDaybookBillProducts(auth, lookupInput)).status,
    "missing",
    "old Daybook captures never fall back to existing Sales products",
  );
  assert.equal((await comparison.compareDaybookSales(auth, sourceJobId)).status, "unavailable");
  const types = [
    { typeName: "Sales", family: "Sales" },
    { typeName: "Credit Note", family: "Credit Note" },
  ];
  const makeEvidence = (vouchers: unknown[]) => ({
    observedAt: new Date().toISOString(),
    capture: { version: "daybook.products.v1", status: "complete", voucherTypes: types, vouchers },
  });
  await prisma.tallyDaybookJob.update({
    where: { id: sourceJobId },
    data: {
      summary: { ...sourceSummary, _daybookProducts: makeEvidence([]) } as Prisma.InputJsonValue,
    },
  });
  const asEvidence = async (billId: string) => {
    const bill = await prisma.tallySalesVoucher.findUniqueOrThrow({
      where: { id: billId },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    return {
      guid: bill.guid,
      masterId: bill.masterId,
      alterId: bill.alterId,
      billDate: bill.billDate,
      billNumber: bill.billNumber,
      typeName: bill.typeName,
      family: bill.family as "Sales" | "Credit Note",
      partyName: bill.partyName,
      cancelled: bill.cancelled,
      optional: bill.optional,
      ledgerEntries: bill.ledgerEntries as { name: string; amount: string }[],
      references: [bill.billNumber],
      items: bill.items.map((item) => ({
        lineNo: item.lineNo,
        stockItemName: item.stockItemName,
        quantity: item.quantity.toFixed(6),
        amount: item.amount.toFixed(2),
        unit: item.unit,
        actualQty: item.actualQty,
        billedQty: item.billedQty,
        rate: item.rate,
      })),
    };
  };
  const firstBill = await asEvidence(originalBill.id),
    secondBill = await asEvidence(otherBill.id);
  let capturedBills = [firstBill, secondBill];
  const historicalJob = await prisma.tallyDaybookJob.create({
    data: {
      connectionId: id,
      monthKey: invoiceMonth,
      fromDate: snapshot.fromDate,
      throughDate: snapshot.throughDate,
      status: "SUCCEEDED",
      completedAt: new Date(),
      summary: {},
    },
  });
  const saveEvidence = async () =>
    prisma.tallyDaybookJob.update({
      where: { id: historicalJob.id },
      data: {
        summary: {
          excludedVouchers: capturedBills.map((bill) => ({
            guid: bill.guid,
            voucherType: bill.typeName,
          })),
          _daybookProducts: makeEvidence(capturedBills),
        } as Prisma.InputJsonValue,
      },
    });
  await saveEvidence();
  const found = await billLookup.getDaybookBillProducts(auth, lookupInput);
  assert.equal(found.status, "matched");
  assert.equal(found.source, "daybook");
  assert.equal(found.bill!.date, invoiceMonth + "-03", "references search earlier Daybook months");
  assert.equal(found.bill!.partyName, "Original Tally Alias");
  assert.equal(found.bill!.items[0].quantity, "1.500000");
  assert.equal(found.bill!.items[0].amount, "100.25", "no proration to payment amount");
  assert.equal((await comparison.compareDaybookSales(auth, historicalJob.id)).status, "matched");
  assert.equal(
    (await comparison.compareDaybookSales(auth, historicalJob.id)).counts!.matchedBills,
    2,
  );
  const own = await billLookup.getDaybookBillProducts(auth, {
    jobId: historicalJob.id,
    voucherGuid: firstBill.guid,
    view: "voucher",
  });
  assert.equal(own.ownVoucher, true);
  assert.equal(own.bill!.items.length, 2);
  assert.equal(own.bill!.amounts!.subtotal, "145.25");
  assert.equal(
    own.bill!.amounts!.total,
    null,
    "a missing party ledger cannot be replaced with an inferred gross total",
  );
  capturedBills = [
    {
      ...firstBill,
      ledgerEntries: [
        { name: firstBill.partyName, amount: "-152.51" },
        { name: "CGST", amount: "3.63" },
        { name: "SGST", amount: "3.63" },
      ],
    },
    secondBill,
  ];
  await saveEvidence();
  const taxBill = await billLookup.getDaybookBillProducts(auth, {
    jobId: historicalJob.id,
    voucherGuid: firstBill.guid,
    view: "voucher",
  });
  assert.equal(taxBill.bill!.amounts!.total, "152.51");
  assert.equal(taxBill.bill!.amounts!.adjustments, "0.00");
  assert.equal(taxBill.bill!.amounts!.taxes[0].kind, "CGST");
  assert.equal(taxBill.bill!.amounts!.taxes[1].kind, "SGST");
  assert.equal(taxBill.bill!.ledgerEntries![0].amount, "-152.51");
  capturedBills = [firstBill, secondBill];
  await saveEvidence();
  // Mutating the independent Sales fixture must affect only the comparison, never displayed Daybook products.
  await prisma.tallySalesItem.update({
    where: { voucherId_lineNo: { voucherId: originalBill.id, lineNo: 0 } },
    data: { quantity: "9.000000" },
  });
  assert.equal(
    (await billLookup.getDaybookBillProducts(auth, lookupInput)).bill!.items[0].quantity,
    "1.500000",
  );
  const different = await comparison.compareDaybookSales(auth, historicalJob.id);
  assert.equal(different.status, "different");
  assert.equal(different.counts!.differentBills, 1);
  assert.equal(different.differences![0].sales!.items[0].quantity, "9.000000");
  assert.deepEqual(Array.from(different.differences![0].products![0].fields), ["Quantity"]);
  assert.equal(different.differences![0].daybook!.masterId, "11");
  assert.equal(different.differences![0].daybook!.productTotal, "145.25");
  assert.equal(different.companyName, "Synthetic Company");
  assert.equal(different.daybookJobId, historicalJob.id);
  assert.equal(different.salesSnapshotId, snapshot.id);
  await prisma.tallySalesItem.update({
    where: { voucherId_lineNo: { voucherId: originalBill.id, lineNo: 0 } },
    data: { quantity: "1.500000" },
  });
  await prisma.tallySalesVoucher.update({
    where: { id: originalBill.id },
    data: { ledgerEntries: [{ name: "Financial adjustment", amount: "-7.00" }] },
  });
  assert.equal(
    (await comparison.compareDaybookSales(auth, historicalJob.id)).status,
    "different",
    "financial-only differences must also be visible",
  );
  await prisma.tallySalesVoucher.update({
    where: { id: originalBill.id },
    data: { ledgerEntries: [] },
  });
  // Product order is presentational; repeated lines must still retain their multiplicity.
  firstBill.items.reverse();
  await saveEvidence();
  assert.equal((await comparison.compareDaybookSales(auth, historicalJob.id)).status, "matched");
  firstBill.items.push({ ...firstBill.items[0], lineNo: 99 });
  await saveEvidence();
  assert.equal((await comparison.compareDaybookSales(auth, historicalJob.id)).status, "different");
  firstBill.items.pop();
  firstBill.items.reverse();
  firstBill.billNumber = "PRINTED-NUMBER";
  await saveEvidence();
  assert.equal(
    (await billLookup.getDaybookBillProducts(auth, lookupInput)).bill!.number,
    "PRINTED-NUMBER",
    "Tally New Ref may differ from printed number",
  );
  firstBill.billNumber = "INV-101";
  const missingInput = { ...lookupInput, allocationNumber: 2, reference: "INV-102" };
  await saveEvidence();
  assert.equal((await billLookup.getDaybookBillProducts(auth, missingInput)).status, "missing");
  capturedBills = [firstBill];
  await saveEvidence();
  assert.equal((await comparison.compareDaybookSales(auth, historicalJob.id)).counts!.onlySales, 1);
  capturedBills = [
    firstBill,
    secondBill,
    { ...secondBill, guid: prefix + "-0000abcf", partyName: firstBill.partyName },
  ];
  await saveEvidence();
  assert.equal((await billLookup.getDaybookBillProducts(auth, lookupInput)).status, "ambiguous");
  assert.equal(
    (await comparison.compareDaybookSales(auth, historicalJob.id)).counts!.onlyDaybook,
    1,
  );
  capturedBills = [firstBill, secondBill];
  firstBill.cancelled = true;
  await saveEvidence();
  assert.equal((await billLookup.getDaybookBillProducts(auth, lookupInput)).bill!.cancelled, true);
  assert.equal((await comparison.compareDaybookSales(auth, historicalJob.id)).status, "different");
  firstBill.cancelled = false;
  // A cancelled, renumbered source record must not mislabel a separate active
  // branch-transfer voucher sharing its old printed number.
  {
    const cancelledSource = await prisma.tallySalesVoucher.create({
      data: {
        snapshotId: snapshot.id,
        guid: prefix + "-0000abc1",
        masterId: "42",
        alterId: "100",
        billDate: invoiceMonth + "-23",
        billNumber: "CG/RB/26-27/0215",
        typeName: "Sales",
        family: "Sales",
        partyName: "",
        cancelled: true,
        optional: true,
        ledgerEntries: [],
      },
    });
    const branchSource = await prisma.tallySalesVoucher.create({
      data: {
        snapshotId: snapshot.id,
        guid: prefix + "-0000abc2",
        masterId: "43",
        alterId: "101",
        billDate: invoiceMonth + "-23",
        billNumber: "CG/RB/26-27/0215",
        typeName: "Sales",
        family: "Sales",
        partyName: "Example Branch",
        cancelled: false,
        optional: false,
        ledgerEntries: [
          { name: "Example Branch", amount: "-12500.00" },
          { name: "Branch Transfer", amount: "12500.00" },
        ],
        items: {
          create: [
            {
              lineNo: 0,
              stockItemName: "Transfer product",
              quantity: "5.000000",
              unit: "Kg",
              amount: "12500.00",
              actualQty: "5 Kg",
              billedQty: "5 Kg",
              rate: "2500/Kg",
            },
          ],
        },
      },
    });
    const cancelledEvidence = {
      ...(await asEvidence(cancelledSource.id)),
      billNumber: "CG/RB/26-27/0217",
      alterId: "200",
    };
    const branchEvidence = await asEvidence(branchSource.id);
    const details = {
      stage: "vouchers",
      month: invoiceMonth,
      companyName: "Synthetic Company",
      fromDate: snapshot.fromDate,
      throughDate: snapshot.throughDate,
      voucher: {
        guid: cancelledEvidence.guid,
        date: cancelledEvidence.billDate,
        voucherNumber: cancelledEvidence.billNumber,
        masterId: cancelledEvidence.masterId,
        alterId: cancelledEvidence.alterId,
        narration: "Original saved narration <not HTML>",
        cancelled: "Yes",
        optional: "Yes",
        ledgerEntries: [],
        ledgerEntryCount: 0,
      },
    };
    await prisma.tallyDaybookJob.update({
      where: { id: historicalJob.id },
      data: {
        summary: {
          excludedVouchers: [
            { guid: cancelledEvidence.guid, details },
            { guid: branchEvidence.guid, amount: "12500.00", direction: "debit" },
          ],
          _daybookProducts: makeEvidence([
            firstBill,
            secondBill,
            cancelledEvidence,
            branchEvidence,
          ]),
        } as Prisma.InputJsonValue,
      },
    });
    const detailed = await comparison.compareDaybookSales(auth, historicalJob.id);
    assert.equal(detailed.counts!.matchedBills, 3);
    assert.equal(detailed.counts!.differentBills, 1);
    assert.equal(detailed.counts!.onlySales, 0);
    assert.equal(detailed.counts!.onlyDaybook, 0);
    const mismatch = detailed.differences![0];
    assert.equal(mismatch.guid, cancelledEvidence.guid);
    assert.equal(mismatch.reason, "Changed: Bill number");
    assert.equal(mismatch.fields![0].daybook, "CG/RB/26-27/0217");
    assert.equal(mismatch.fields![0].sales, "CG/RB/26-27/0215");
    assert.equal(mismatch.daybook!.rawCancelled, "Yes");
    assert.equal(mismatch.daybook!.narration, details.voucher.narration);
    assert.equal(mismatch.daybook!.alterId, "200");
    assert.equal(mismatch.sales!.alterId, "100");
    assert.equal(
      mismatch.daybook!.productTotal,
      null,
      "Missing amounts remain unavailable, never invented zero",
    );
    assert.equal(mismatch.sales!.partyLedgerAmount, null);
    assert.ok(
      !("cancelledAt" in mismatch.daybook!),
      "Capture time or Alter ID cannot invent a cancellation timestamp",
    );
    assert.equal(
      mismatch.numberMatches!.count,
      2,
      "Same printed number is searched in both complete period captures",
    );
    for (const match of mismatch.numberMatches!.vouchers) {
      assert.equal(match.bill.guid, branchSource.guid);
      assert.equal(match.bill.party, "Example Branch");
      assert.equal(match.bill.cancelled, false);
      assert.equal(match.bill.optional, false);
      assert.equal(match.bill.partyLedgerAmount, "-12500.00");
      assert.equal(match.bill.productTotal, "12500.00");
    }
    assert.equal(
      mismatch.numberMatches!.vouchers.find((match) => match.source === "Daybook")!.bill
        .capturedAmount!.amount,
      "12500.00",
    );
    assert.equal((await values()).liveRecovery.toFixed(2), beforeLookup.liveRecovery.toFixed(2));
    await prisma.tallySalesVoucher.deleteMany({
      where: { id: { in: [cancelledSource.id, branchSource.id] } },
    });
    await saveEvidence();
    console.log(
      "Comparison diagnostics: exact bill-number difference, real saved flags, separate same-number branch voucher, party/product amounts, source IDs/raw narration and no invented cancellation time: PASS",
    );
  }
  const emptyBill = {
    ...secondBill,
    guid: prefix + "-0000abd0",
    partyName: firstBill.partyName,
    billNumber: "INV-102",
    references: ["INV-102"],
  };
  capturedBills.push(emptyBill);
  await saveEvidence();
  assert.equal((await billLookup.getDaybookBillProducts(auth, missingInput)).bill!.items.length, 0);
  await prisma.tallySalesSnapshot.update({
    where: { id: snapshot.id },
    data: { throughDate: invoiceMonth + "-27" },
  });
  assert.equal(
    (await comparison.compareDaybookSales(auth, historicalJob.id)).status,
    "period_mismatch",
  );
  await prisma.tallySalesSnapshot.update({
    where: { id: snapshot.id },
    data: { throughDate: snapshot.throughDate },
  });
  const publicStatus = await svc.daybookStatus(auth, month);
  assert.ok(
    !("_daybookProducts" in (publicStatus.published!.summary as Record<string, unknown>)),
    "full product dataset is not in status polling responses",
  );
  const advanceJob = await prisma.tallyDaybookJob.create({
    data: {
      connectionId: id,
      monthKey: month,
      fromDate: month + "-01",
      throughDate: last,
      status: "SUCCEEDED",
      createdAt: new Date("2026-04-01T00:00:00Z"),
      completedAt: new Date("2026-04-01T00:00:00Z"),
      summary: {
        dealerRows: [
          {
            creditVouchers: [
              {
                guid: prefix + "-00000097",
                voucherType: "Receipt",
                billAllocations: {
                  scope: "selected_credit",
                  entryCount: 1,
                  entries: [
                    {
                      ledgerLineNumber: 1,
                      allocationNumber: 1,
                      ledgerName: "Verified Dealer",
                      billReference: "INV-101",
                      referenceType: "Advance",
                      amount: "3.00",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  });
  assert.equal(
    (
      await billLookup.getDaybookBillProducts(auth, {
        ...lookupInput,
        jobId: advanceJob.id,
        voucherGuid: prefix + "-00000097",
      })
    ).status,
    "unlinked",
  );
  await prisma.tallyDaybookJob.update({ where: { id: advanceJob.id }, data: { status: "FAILED" } });
  await assert.rejects(comparison.compareDaybookSales(auth, advanceJob.id), /unavailable/);
  const otherConnection = await prisma.tallyConnection.create({
    data: {
      companyName: "Other Company",
      anchorName: "Other",
      anchorGuid: prefix + "-0000ffff",
      credentialHash: hashSales("other-test"),
      authorizedById: auth.userId,
      enabled: false,
    },
  });
  await prisma.tallyDaybookJob.create({
    data: {
      connectionId: otherConnection.id,
      monthKey: invoiceMonth,
      fromDate: snapshot.fromDate,
      throughDate: snapshot.throughDate,
      status: "SUCCEEDED",
      completedAt: new Date(),
      summary: {
        _daybookProducts: makeEvidence([{ ...firstBill, guid: prefix + "-0000ffff" }]),
      } as Prisma.InputJsonValue,
    },
  });
  assert.equal(
    (await billLookup.getDaybookBillProducts(auth, lookupInput)).status,
    "matched",
    "other company product evidence cannot contaminate matches",
  );
  await prisma.tallyConnection.update({ where: { id }, data: { enabled: false } });
  await assert.rejects(billLookup.getDaybookBillProducts(auth, lookupInput), /unavailable/);
  await prisma.tallyConnection.update({ where: { id }, data: { enabled: true } });
  const afterLookup = await values();
  assert.equal(afterLookup.liveRecovery.toFixed(2), beforeLookup.liveRecovery.toFixed(2));
  assert.equal(afterLookup.srCr.toFixed(2), beforeLookup.srCr.toFixed(2));
  assert.equal(afterLookup.outstanding.toFixed(2), beforeLookup.outstanding.toFixed(2));
  assert.equal(
    (
      await prisma.tallySalesItem.findUniqueOrThrow({
        where: { voucherId_lineNo: { voucherId: originalBill.id, lineNo: 0 } },
      })
    ).amount.toFixed(2),
    "100.25",
  );
  await prisma.tallySalesSnapshot.delete({ where: { id: snapshot.id } });
  await prisma.tallyConnection.delete({ where: { id: otherConnection.id } });
  await prisma.tallyDaybookJob.deleteMany({
    where: { id: { in: [historicalJob.id, advanceJob.id] } },
  });
  await prisma.tallyDaybookJob.update({
    where: { id: sourceJobId },
    data: { summary: sourceSummary as Prisma.InputJsonValue },
  });
  await prisma.dealerAlias.delete({ where: { id: lookupAlias.id } });
  console.log(
    "Daybook-only products and read-only Sales comparison: independent source, New Ref matching, historical captures, full/duplicate/empty lines, complete period checks, differences, role/company boundaries and financial preservation: PASS",
  );
  const partial = await refresh([], month + "-15");
  assert.ok(partial.reply.rejected);
  assert.ok((await partial.retry()).rejected);
  assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
  for (const reason of ["CREDIT_AMBIGUOUS", "CREDIT_MISSING", "VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE"]) {
    const held = await refresh([
      {
        guid: prefix + "-00000009",
        date: month + "-02",
        voucherNumber: "R9",
        voucherType: "Receipt",
        category: "receipt",
        review: reason,
      },
    ]);
    assert.ok(
      held.reply.rejected,
      "a supported voucher with unresolved credits still blocks publication",
    );
    assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
    assert.equal((await values()).srCr.toFixed(2), "10.00");
  }
  const badExclusion = await refresh([
    {
      guid: prefix + "-00000013",
      date: month + "-02",
      voucherNumber: "R13",
      voucherType: "Receipt",
      category: "other",
      excluded: "unsupported_type",
    },
  ]);
  assert.ok(badExclusion.reply.rejected, "a receipt cannot be disguised as Other");
  assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
  // Exercise the actual Python batch transport through the real agent/database.
  {
    const bigProducts = {
      ...firstProducts,
      vouchers: firstProducts.vouchers.map((bill) => ({
        ...bill,
        items: Array.from({ length: 6000 }, (_, lineNo) => ({
          ...bill.items[0],
          lineNo,
          stockItemName: "Original हिन्दी product " + "x".repeat(200),
        })),
      })),
    };
    const priorPublished = (await svc.daybookStatus(auth, month)).published!.id;
    const newBatchJob = async () => {
      await svc.requestDaybookRefresh(auth, month);
      const { job } = await claim();
      assert.ok(job);
      return { jobId: job.id, leaseToken: job.leaseToken };
    };
    const ids = await newBatchJob();
    const capture = {
      version: "daybook.capture.v1",
      companyName: "Synthetic Company",
      month,
      ...salesPeriod(month, today),
      observedAt: new Date().toISOString(),
      uploaded: false,
      coverage: "all_vouchers",
      vouchers,
      productCapture: bigProducts,
    };
    // salesPeriod also returns monthKey; remove it from the transport capture.
    delete (capture as { monthKey?: string }).monthKey;
    const python = spawnSync(
      "python3",
      [
        "-c",
        `
import json,sys
from daybook_worker import DaybookWorker
payload=json.dumps(json.load(sys.stdin),ensure_ascii=True,separators=(',',':'))
messages=[]
class Cloud:
 def call(self,action,**fields):
  messages.append({'action':action,**fields})
  return {'ok':True}
worker=object.__new__(DaybookWorker)
worker.cloud=Cloud()
worker.collection_contact=lambda *args:None
worker.save=lambda *args:None
worker.send({'jobId':'unused','leaseToken':'unused','payload':payload})
print(json.dumps(messages,separators=(',',':')))
`,
      ],
      {
        cwd: resolve("../tally-connector-v1.3/Tally-Office-Connector"),
        input: JSON.stringify(capture),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    assert.equal(python.status, 0, python.stderr);
    const messages = JSON.parse(python.stdout) as {
      action: string;
      manifest?: { chunks: number; bytes: number; sha256: string };
      sequence?: number;
      data?: string;
      hash?: string;
      uploadHash?: string;
    }[];
    const manifest = messages[0].manifest!;
    const batches = messages.filter((message) => message.action === "chunk");
    assert.ok(manifest.bytes > 4 * 1024 * 1024 && manifest.bytes < DAYBOOK_CAPTURE_BYTES);
    assert.equal(batches.length, manifest.chunks);
    for (const batch of batches) {
      assert.ok(batch.data!.length <= DAYBOOK_CHUNK_BYTES);
      assert.ok(Buffer.byteLength(JSON.stringify({ ...batch, ...ids })) < 1024 * 1024);
    }
    const begin = { action: "begin", ...ids, manifest };
    const complete = { action: "complete", ...ids, uploadHash: manifest.sha256 };
    await assert.rejects(call({ ...batches[0], ...ids }), /Begin/);
    await call(begin);
    await call(begin); // lost begin reply
    await assert.rejects(
      call({ ...begin, manifest: { ...manifest, sha256: "0".repeat(64) } }),
      /manifest changed/,
    );
    await assert.rejects(
      call({
        action: "begin",
        ...ids,
        manifest: { ...manifest, bytes: DAYBOOK_CAPTURE_BYTES + 1 },
      }),
    );
    await assert.rejects(
      call({ action: "complete", ...ids, capture, uploadHash: manifest.sha256 }),
      /exactly one/,
    );
    await assert.rejects(call({ action: "complete", ...ids, capture }), /manifest hash/);
    await assert.rejects(call({ ...complete, uploadHash: "0".repeat(64) }), /manifest/);
    await assert.rejects(call(complete), /incomplete/);
    const firstBatch = { ...batches[0], ...ids };
    await call(firstBatch);
    assert.ok(((await call(firstBatch)) as { duplicate?: boolean }).duplicate);
    assert.equal(await prisma.tallyDaybookChunk.count({ where: { jobId: ids.jobId } }), 1);
    await assert.rejects(call({ ...firstBatch, hash: "0".repeat(64) }), /checksum/);
    const changedData = "!" + batches[0].data!.slice(1);
    await assert.rejects(
      call({ ...firstBatch, data: changedData, hash: hashSales(changedData) }),
      /content changed/,
    );
    await assert.rejects(call({ ...firstBatch, sequence: manifest.chunks }), /length or checksum/);
    await assert.rejects(call({ ...firstBatch, leaseToken: "Z".repeat(43) }), /no longer active/);
    assert.equal((await svc.daybookStatus(auth, month)).published!.id, priorPublished);
    assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
    const partialStatus = await svc.daybookStatus(auth, month);
    assert.ok(!JSON.stringify(partialStatus.job).includes("Original हिन्दी product"));
    // A recovering durable claim rotates the lease but preserves acknowledged batches.
    const staged = await prisma.tallyDaybookJob.findUniqueOrThrow({ where: { id: ids.jobId } });
    const recovered = await claim(staged.claimRequestId!);
    assert.equal(recovered.job!.id, ids.jobId);
    await assert.rejects(call(firstBatch), /no longer active/);
    ids.leaseToken = recovered.job!.leaseToken;
    begin.leaseToken = ids.leaseToken;
    complete.leaseToken = ids.leaseToken;
    await call(begin);
    // Out-of-order arrival is reassembled by sequence, never arrival order.
    for (const batch of batches.slice(1).reverse()) await call({ ...batch, ...ids });
    await prisma.tallyDaybookJob.update({
      where: { id: ids.jobId },
      data: { leaseExpiresAt: new Date(Date.now() + 1000) },
    });
    await call({ ...batches[0], ...ids });
    assert.ok(
      +(await prisma.tallyDaybookJob.findUniqueOrThrow({ where: { id: ids.jobId } }))
        .leaseExpiresAt! >
        Date.now() + 5 * 60 * 1000,
    );
    assert.ok((await call(complete)).ok);
    assert.ok(((await call(complete)) as { duplicate?: boolean }).duplicate); // lost completion reply
    assert.ok(((await call(begin)) as { duplicate?: boolean }).duplicate); // restarted outbox after completion
    assert.equal(await prisma.tallyDaybookChunk.count({ where: { jobId: ids.jobId } }), 0);
    const saved = await prisma.tallyDaybookJob.findUniqueOrThrow({ where: { id: ids.jobId } });
    const productSummary = saved.summary as { _daybookProducts: { capture: typeof bigProducts } };
    assert.equal(productSummary._daybookProducts.capture.status, "complete");
    assert.equal(productSummary._daybookProducts.capture.vouchers[0].items.length, 6000);
    assert.equal(
      productSummary._daybookProducts.capture.vouchers[1].items[5999].quantity,
      "-1.000000",
    );
    assert.equal(
      productSummary._daybookProducts.capture.vouchers[0].items[0].stockItemName,
      bigProducts.vouchers[0].items[0].stockItemName,
    );
    assert.equal((await values()).liveRecovery.toFixed(2), "13.25");
    assert.equal((await values()).srCr.toFixed(2), "10.00");
    assert.ok(
      !(
        "_daybookProducts" in
        ((await svc.daybookStatus(auth, month)).published!.summary as Record<string, unknown>)
      ),
    );
    // Corrupt complete content cannot replace published figures and is cleaned up.
    const corruptIds = await newBatchJob();
    const corruptManifest = { ...manifest, sha256: "1".repeat(64) };
    await call({ action: "begin", ...corruptIds, manifest: corruptManifest });
    for (const batch of batches) await call({ ...batch, ...corruptIds });
    assert.ok(
      (await call({ action: "complete", ...corruptIds, uploadHash: corruptManifest.sha256 }))
        .rejected,
    );
    assert.equal(
      (await prisma.tallyDaybookJob.findUniqueOrThrow({ where: { id: corruptIds.jobId } })).error,
      "DAYBOOK_UPLOAD_CHECKSUM_MISMATCH",
    );
    assert.equal(await prisma.tallyDaybookChunk.count({ where: { jobId: corruptIds.jobId } }), 0);
    assert.equal((await svc.daybookStatus(auth, month)).published!.id, ids.jobId);
    // Explicit cancellation/failure and expired abandoned uploads remove staged data.
    for (const expired of [false, true]) {
      const abandoned = await newBatchJob();
      await call({ action: "begin", ...abandoned, manifest });
      await call({ ...batches[0], ...abandoned });
      if (expired) {
        await prisma.tallyDaybookJob.update({
          where: { id: abandoned.jobId },
          data: { leaseExpiresAt: new Date(0) },
        });
        await assert.rejects(call({ ...batches[1], ...abandoned }), /expired/);
        await svc.requestDaybookRefresh(auth, month);
      } else await call({ action: "fail", ...abandoned, code: "TEST_UPLOAD_FAILED" });
      assert.equal(await prisma.tallyDaybookChunk.count({ where: { jobId: abandoned.jobId } }), 0);
    }
    console.log(
      "Daybook Python >4MiB batch transport: complete products, resume/lease rotation, missing/corrupt/duplicate/out-of-order batches, atomic financial preservation, replay and cleanup: PASS",
    );
  }
  const cancellation = await refresh(vouchers.slice(2));
  assert.ok(cancellation.reply.ok);
  row = await values();
  assert.equal(row.liveRecovery.toFixed(2), "0.00");
  assert.equal(row.srCr.toFixed(2), "10.00");
  assert.equal(
    (await recovery.latestReceiptAsOfByDealer([dealerId], new Date(last))).has(dealerId),
    false,
  );
  assert.equal((await report.loadEffectiveLastPayments([dealerId], last)).has(dealerId), false);
  const empty = await refresh([]);
  assert.ok(empty.reply.ok);
  assert.equal((await values()).srCr.toFixed(2), "0.00");
  await testIgnoredComparison();
  await testDealerAudit();
  // Range is a read-only union of independently authorized monthly publications.
  {
    const months = ["2026-04", "2026-05", "2026-06"];
    await prisma.tallyDaybookJob.deleteMany({
      where: { connectionId: id, monthKey: { in: months } },
    });
    const finance = async () =>
      JSON.stringify({
        recovery: await values(),
        monthly: await prisma.monthlyEntry.findMany({ orderBy: { id: "asc" } }),
        lastPayment: [...(await report.loadEffectiveLastPayments([dealerId], today)).entries()],
      });
    const financialBefore = await finance();
    await assert.rejects(
      svc.daybookRangeStatus({ ...auth, role: Role.SALES_OFFICER }, months[0], months[1]),
      /Super Admin/,
    );
    await assert.rejects(
      svc.requestDaybookRangeRefresh({ ...auth, role: Role.SALES_OFFICER }, months[0], months[1]),
      /Super Admin/,
    );
    const job = async (key: string, status: "SUCCEEDED" | "FAILED", order: number) =>
      prisma.tallyDaybookJob.create({
        data: {
          connectionId: id,
          ...salesPeriod(key, today),
          status,
          createdAt: new Date(Date.UTC(2026, 10, 1, 0, order)),
          completedAt: new Date(Date.UTC(2026, 10, 1, 0, order)),
          error: status === "FAILED" ? "TEST_RANGE_FAILED" : null,
          summary: {
            coverage: "all_vouchers",
            marker: order,
            dealerRows: [],
            _daybookProducts: { privateEvidence: "not included in polling" },
          },
        },
      });
    await job(months[0], "SUCCEEDED", 1);
    const latestApril = await job(months[0], "SUCCEEDED", 2);
    await job(months[0], "FAILED", 3);
    const latestMay = await job(months[1], "SUCCEEDED", 1);
    const disabledConnection = await prisma.tallyConnection.create({
      data: {
        companyName: "Range other company",
        anchorName: "Other",
        anchorGuid: prefix + "-0000fffe",
        credentialHash: hashSales("disabled-range"),
        authorizedById: auth.userId,
        enabled: false,
      },
    });
    await prisma.tallyDaybookJob.create({
      data: {
        connectionId: disabledConnection.id,
        ...salesPeriod(months[2], today),
        status: "SUCCEEDED",
        completedAt: new Date(),
        summary: { marker: "wrong company" },
      },
    });
    const range = await svc.daybookRangeStatus(auth, months[0], months[2]);
    assert.deepEqual(
      Array.from(range.months, (entry) => entry.month),
      months,
    );
    assert.equal(range.months[0].published!.id, latestApril.id);
    assert.equal(range.months[0].job!.error, "TEST_RANGE_FAILED");
    assert.equal(range.months[1].published!.id, latestMay.id);
    assert.equal(range.months[2].published, null, "other company cannot fill a missing month");
    assert.ok(!("_daybookProducts" in (range.months[0].published!.summary as object)));
    assert.ok(!("_daybookProducts" in (range.months[0].job!.summary as object)));
    assert.equal((await svc.daybookStatus(auth, months[0])).published!.id, latestApril.id);
    for (const [from, to] of [
      ["2026-05", "2026-04"],
      ["2026-03", "2026-04"],
      ["bad", "2026-05"],
      ["2026-04", "2027-04"],
    ]) {
      await assert.rejects(svc.daybookRangeStatus(auth, from, to), /From\/To month/);
      await assert.rejects(svc.requestDaybookRangeRefresh(auth, from, to), /From\/To month/);
    }
    await prisma.tallyConnection.update({ where: { id }, data: { enabled: false } });
    const disconnected = await svc.daybookRangeStatus(auth, months[0], months[2]);
    assert.equal(disconnected.configured, false);
    assert.ok(disconnected.months.every((entry) => entry.published === null));
    await assert.rejects(svc.requestDaybookRangeRefresh(auth, months[0], months[2]), /Configure/);
    await prisma.tallyConnection.update({ where: { id }, data: { enabled: true } });
    // Overlapping range and legacy single-month requests share the same queue lock.
    await Promise.all([
      svc.requestDaybookRangeRefresh(auth, months[0], months[2]),
      svc.requestDaybookRangeRefresh(auth, months[1], months[2]),
      svc.requestDaybookRefresh(auth, months[1]),
    ]);
    const queued = await prisma.tallyDaybookJob.findMany({
      where: { connectionId: id, monthKey: { in: months }, status: "QUEUED" },
      orderBy: { monthKey: "asc" },
    });
    assert.deepEqual(
      queued.map((entry) => entry.monthKey),
      months,
    );
    assert.equal(queued[0].fromDate, "2026-04-01");
    assert.equal(queued[0].throughDate, "2026-04-30");
    assert.equal(queued[2].throughDate, "2026-06-30");
    assert.equal(
      (await svc.daybookRangeStatus(auth, months[0], months[2])).months[0].published!.id,
      latestApril.id,
    );
    assert.equal(
      await finance(),
      financialBefore,
      "range reads/queue requests cannot change financial figures",
    );
    console.log(
      "Daybook month range: latest success, missing/company isolation, validation, overlapping queue idempotence and financial preservation passed.",
    );
  }
  approved = false;
  await assert.rejects(svc.requestDaybookRefresh(auth, month), /approved test Preview/);
  await assert.rejects(svc.daybookRangeStatus(auth, "2026-04", "2026-05"), /approved test Preview/);
  await assert.rejects(svc.requestDaybookRangeRefresh(auth, "2026-04", "2026-05"), /approved test Preview/);
  assert.equal(
    (await recovery.latestReceiptAsOfByDealer([dealerId], new Date(last))).get(dealerId)?.amount,
    999,
  );
  console.log(
    "Daybook queue, replay, month replacement, holds, coverage, and Last Payment passed.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
