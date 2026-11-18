/** Only run against a fresh disposable PostgreSQL instance. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  async function refresh(vouchers: unknown[], throughDate = last) {
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
        vouchers,
      },
    };
    return { reply: await call(body), retry: () => call(body) };
  }
  const vouchers = [
    credit(1, "Verified Dealer", "5.25"),
    credit(2, "Verified Dealer", "8.00"),
    credit(3, "Verified Dealer", "10.00", "srCr"),
    credit(4, "Payment Only Dealer", "50.00"),
    credit(5, "Bank Charges", "900.00"),
    credit(6, "No Candidate", "70.00"),
  ];
  const first = await refresh(vouchers);
  assert.ok(first.reply.ok);
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
  assert.equal(payments.has("daybook-bank"), false);
  await assert.rejects(
    prisma.$transaction((tx) => svc.assertManualDaybookMonthAvailable(tx, "daybook-month")),
    /Tally Daybook manages/,
  );
  const partial = await refresh([], month + "-15");
  assert.ok(partial.reply.rejected);
  assert.ok((await partial.retry()).rejected);
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
