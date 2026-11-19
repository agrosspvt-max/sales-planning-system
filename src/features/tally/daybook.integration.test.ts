/** Only run against a fresh disposable PostgreSQL instance. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PrismaClient, Role } from "@prisma/client";
import { indiaDay } from "./billwise";
import { hashSales, salesPeriod } from "./sales";

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
async function claim(requestId = randomUUID()) {
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
  async function refresh(vouchers: unknown[], throughDate = last, coverage?: "all_vouchers") {
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
        vouchers,
      },
    };
    return { reply: await call(body), retry: () => call(body) };
  }
  const vouchers: unknown[] = [
    { ...credit(1, "Verified Dealer", "5.25"), voucherNumber: "" },
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
  const first = await refresh(vouchers, last, "all_vouchers");
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
    }[];
    dealerRows: {
      dealerName: string;
      srCr: string;
      liveRecovery: string;
      other: string | null;
      status: string;
      reason?: string;
    }[];
  };
  assert.equal(summary.coverage, "all_vouchers");
  assert.equal(summary.receiptCount, 5);
  assert.equal(summary.srCrCount, 2);
  assert.equal(summary.excluded, 4);
  const verifiedSummary = summary.dealerRows.find((r) => r.dealerName === "Verified Dealer")!;
  assert.equal(verifiedSummary.liveRecovery, "13.25");
  assert.equal(verifiedSummary.srCr, "10.00");
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
      details: evidence.details,
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
  await testDealerAudit();
  approved = false;
  await assert.rejects(svc.requestDaybookRefresh(auth, month), /approved test Preview/);
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
