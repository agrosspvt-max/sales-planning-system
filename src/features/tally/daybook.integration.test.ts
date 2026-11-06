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
