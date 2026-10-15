/**
 * Daily Work → Submit Daily Work (`submitDailyWorkDay`) against a REAL, disposable PostgreSQL database with SIMULATED NETWORK LATENCY (every statement waits a fixed
 * round trip first — the database itself needs ~1–30 ms for the whole transaction, so slow round trips are what exhaust a transaction's time budget).
 *
 *   createdb submit_test && DATABASE_URL=postgresql://localhost:5432/submit_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   SUBMIT_TEST_URL=postgresql://localhost:5432/submit_test npm run test:daily-submit:db
 *
 * Only a LOCAL database named `submit_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import * as realLabels from "@/features/labels/labels";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const url = process.env.SUBMIT_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/submit_test")
  throw new Error("Only a local database named submit_test is permitted (set SUBMIT_TEST_URL).");
let rtt = 0;
const base = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] });
const log: string[] = [];
base.$on("query", (e: { query: string }) => { log.push(e.query.replace(/\s+/g, " ").slice(0, 60)); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prisma = base.$extends({ query: { async $allOperations({ args, query }) { if (rtt) await sleep(rtt); return query(args); } } }) as unknown as PrismaClient;
const TODAY = "2026-10-14", PREVIOUS = "2026-10-13";
realDailyWork.dailyWorkClock.now = () => new Date(`${TODAY}T06:00:00Z`); // 11:30 IST: yesterday's report window is still open
const DL = realLabels.DEFAULT_LABELS as Record<string, string>;
const svc = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async (d: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data: d }) },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : TODAY) },
  "@/lib/scope": { getCurrentDealerIds: async () => Array.from({ length: 12 }, (_, i) => `d${i}`), getCurrentManagerId: async () => null, getOfficerScope: async (c: AuthContext) => ({ all: false, ids: [c.userId] }), assertOfficerInScope: async () => undefined, getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.map((i) => [i, "so1"])) },
  "@/features/labels/service.server": { getResolvedLabels: async () => DL },
  "@/features/schemes/scheme-planning.server": { runningSchemes: async () => [] },
  "@/features/planning/monthly.server": { getMonthly: async () => ({ monthlyMode: "PACK_SIZE", months: [], dealers: [] }) }, "@/features/planning/monthly-plan.server": { resolveAddableSeasonalPlanId: async () => null },
  "@/features/party-planning/monthly.server": { ownerSendDocumentsInTx: async () => ({}) },
  "@/features/cn-requests/service.server": { cnTasksForOfficerDate: async () => [], materializedCnTasksForEntries: async () => [], latestCnRequestStatusByDealer: async () => new Map(),
    countUnconfirmedMaterializedTasks: async (tx: Prisma.TransactionClient, o: string, d: string, b: string) => { const r = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM "CnPaymentEvent" e JOIN "DailyWorkEntry" w ON w."id" = e."dailyWorkEntryId" WHERE w."officerId" = ${o} AND w."workDate" = ${d}::date AND w."batchId" = ${b}`); return r[0]!.n; } },
  "@/lib/recovery-config": { getAutoTasksEnabled: async () => false, getCalendarEnabled: async () => true },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
})<typeof import("./service.server")>("src/features/daily-work/service.server.ts");

const so1 = { userId: "so1", username: "so1", role: Role.SALES_OFFICER, groupId: "g1" } as AuthContext;
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const msg = (p: Promise<unknown>) => p.then(() => "", (e: { message?: string }) => e.message ?? "");
const eq = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const BATCH = `draft:so1:${TODAY}`;

async function main() {
  await base.$executeRawUnsafe(`TRUNCATE "BillingExceptionTask","BillingException","DailyWorkEntry","DailyWorkDay","DealerAssignment","Dealer","AuditLog","User","UserGroup" CASCADE`);
  await base.userGroup.create({ data: { id: "g1", name: "MP" } });
  for (const [id, role] of [["so1", Role.SALES_OFFICER], ["admin", Role.SUPER_ADMIN]] as const) await base.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role, groupId: id === "so1" ? "g1" : null } });
  for (let i = 0; i < 12; i++) {
    await base.dealer.create({ data: { id: `d${i}`, name: `Dealer ${i}` } });
    await base.dealerAssignment.create({ data: { dealerId: `d${i}`, officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
    for (const section of ["SALES", "RECOVERY"]) await base.$executeRaw`INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","entryType","status","createdAt","updatedAt") VALUES (${`e-${section}-${i}`},'so1',${`d${i}`},${`d${i}`},${TODAY}::date,${BATCH},${section},1000,'REGULAR','DRAFT',NOW(),NOW())`;
  }
  // a due Billing Exception task: submitting materializes it into the d0 Recovery row INSIDE the transaction
  await base.billingException.create({ data: { id: "bx", dealerId: "d0", billingDate: new Date("2026-10-10"), billNo: "B1", authPerson: "x", createdById: "admin", requestId: "r1", snapDays: 60, snapParty: "Dealer 0", snapDealerStatus: "ACTIVE", billingAmount: 500, paymentCondition: true, paymentDate: new Date(TODAY), paymentAmount: 500 } });
  await base.billingExceptionTask.create({ data: { billingExceptionId: "bx", dealerId: "d0", officerId: "so1", amount: 500, promisedDate: new Date(TODAY), taskDate: new Date(TODAY) } });
  for (const section of ["APPOINTMENT", "VISITS", "OTHERS"]) await svc.setDailyNoPlan(so1, { workDate: TODAY, section, noPlan: true });

  const snapshot = async () => JSON.stringify({
    entries: (await base.dailyWorkEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, batchId: true, todaysPlan: true, planSubmittedAt: true } })).map((e) => [e.id, e.status, e.batchId, Number(e.todaysPlan ?? 0), e.planSubmittedAt !== null]),
    day: (await base.dailyWorkDay.findMany({ select: { officerId: true, currentBatchId: true } })),
    task: (await base.billingExceptionTask.findMany({ select: { dailyWorkEntryId: true, dailyWorkContribution: true } })),
    audits: await base.auditLog.count({ where: { entity: "dailyWork", entityId: { startsWith: "BATCH:" } } }),
  });

  /* ---- previous-report check (strict daily workflow) ---- */
  await base.$executeRaw`INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","status","planSubmittedAt","createdAt","updatedAt") VALUES ('prev','so1','d1','d1',${PREVIOUS}::date,'b-prev','SALES',10,'PLAN_SUBMITTED',NOW(),NOW(),NOW())`;
  const before = await snapshot();
  assert.equal(await code(svc.submitDailyWorkDay(so1, { workDate: TODAY })), 422, "yesterday's report is outstanding: blocked");
  assert.equal(await snapshot(), before, "a refused submission changes nothing (incl. the task that would have been materialized)");
  await base.$executeRaw`INSERT INTO "DailyWorkDay" ("id","officerId","workDate","currentBatchId","status","finalizedAt","createdAt","updatedAt") VALUES ('prevday','so1',${PREVIOUS}::date,'b-prev','FINALIZED',NOW(),NOW(),NOW())`;

  /* ---- contention: ordinary reads no longer open locking transactions when nothing is due ---- */
  log.length = 0; rtt = 0;
  await svc.getDailyWork(so1, "SALES", TODAY); await svc.getDailyAppointment(so1, TODAY); await svc.getDailyStatus(so1, TODAY);
  assert.equal(log.filter((q) => q === "BEGIN").length, 0, "reads of Sales / Appointment / Status open no transaction (the Recovery read below may — and only because a task is due)");
  await base.$executeRaw`UPDATE "BillingExceptionTask" SET "taskDate" = '2026-10-20'::date`; // nothing due today
  log.length = 0;
  await svc.getDailyWork(so1, "RECOVERY", TODAY, undefined, "PLAN");
  assert.equal(log.filter((q) => q === "BEGIN").length, 0, "a Recovery read with no task due takes no day lock and opens no transaction");
  await base.$executeRaw`UPDATE "BillingExceptionTask" SET "taskDate" = ${TODAY}::date`;
  log.length = 0;
  await svc.getDailyWork(so1, "RECOVERY", TODAY, undefined, "PLAN"); // the due Billing Exception task exists → ONE materialization transaction
  const materialized = JSON.stringify((await base.billingExceptionTask.findMany()).map((t) => t.dailyWorkEntryId));
  assert.ok(materialized !== "[null]", "…and that read did materialize the due task (once)");
  // put the day back exactly as it was before the read (the task stays unlinked for the submission scenarios below)
  await base.$executeRaw`UPDATE "DailyWorkEntry" SET "todaysPlan" = 1000 WHERE "id" = 'e-RECOVERY-0'`;
  await base.$executeRaw`UPDATE "BillingExceptionTask" SET "dailyWorkEntryId" = NULL, "dailyWorkContribution" = NULL, "materializedAt" = NULL`;
  log.length = 0;
  await svc.getDailyWork(so1, "RECOVERY", TODAY, undefined, "REPORT"); await svc.getDailyAppointment(so1, TODAY);
  assert.equal(log.filter((q) => q === "BEGIN").length, 0, "no transaction at all for report / appointment reads");

  /* ---- a transaction that runs out of time rolls EVERYTHING back (materialization, status change, rotation, audit) ---- */
  const clean = await snapshot();
  rtt = 150; (svc.SUBMIT_DAY_TRANSACTION as { timeout: number }).timeout = 700; // ~15 round trips × 150 ms ≫ 700 ms
  let failure: { status?: number; message?: string } = {};
  await svc.submitDailyWorkDay(so1, { workDate: TODAY }).catch((e) => { failure = e; });
  rtt = 0; (svc.SUBMIT_DAY_TRANSACTION as { timeout: number }).timeout = 30_000;
  eq([failure.status, failure.message], [503, DL["daily_work.validation.submit_timeout"]], "a timed-out submission is a clear, retryable 503 (wording from Edit Labels)");
  assert.equal(await snapshot(), clean, "nothing was committed: rows still draft, batch not rotated, the due task not linked, no audit entry");
  assert.ok(Object.keys(svc.SUBMIT_DAY_TRANSACTION).join() === "timeout,maxWait" && svc.SUBMIT_DAY_TRANSACTION.timeout <= 60_000, "the limit is explicit and bounded (not unlimited)");

  /* ---- a realistic, slow, busy moment: double click + status / Sales / Recovery reads in flight ---- */
  rtt = 150;
  log.length = 0;
  const t0 = Date.now();
  const results = await Promise.all([
    svc.submitDailyWorkDay(so1, { workDate: TODAY }).then(() => "ok", (e: { status?: number }) => `err${e.status}`),
    svc.submitDailyWorkDay(so1, { workDate: TODAY }).then(() => "ok", (e: { status?: number }) => `err${e.status}`), // the double click
    svc.getDailyStatus(so1, TODAY), svc.getDailyStatus(so1, TODAY),
    svc.getDailyWork(so1, "SALES", TODAY), svc.getDailyWork(so1, "RECOVERY", TODAY),
  ]);
  const wall = Date.now() - t0; rtt = 0;
  eq(results.slice(0, 2).filter((r) => r === "ok").length, 1, "exactly ONE of the two clicks submitted");
  assert.ok(results.slice(0, 2).some((r) => r !== "ok"), "the other was refused, not a second submission");
  eq(await base.auditLog.count({ where: { entity: "dailyWork", entityId: { startsWith: "BATCH:" } } }), 1, "ONE submission audit");
  const days = await base.dailyWorkDay.findMany({ where: { workDate: new Date(TODAY) } });
  assert.ok(days[0]!.currentBatchId !== BATCH, "the batch was rotated, once");
  eq((await base.dailyWorkEntry.count({ where: { workDate: new Date(TODAY), batchId: BATCH, status: "PLAN_SUBMITTED" } })), 25, "every row of the batch (12 Sales + 12 Recovery + the No Plan summary) was submitted");
  const task = await base.billingExceptionTask.findFirstOrThrow();
  eq([task.dailyWorkEntryId, Number(task.dailyWorkContribution)], ["e-RECOVERY-0", 500], "the due automatic task was materialized exactly ONCE, inside the same transaction");
  eq(Number((await base.dailyWorkEntry.findUniqueOrThrow({ where: { id: "e-RECOVERY-0" } })).todaysPlan), 1500, "1,000 planned + 500 automatic — not counted twice");
  console.log(`[measured] busy moment @150 ms round trip: wall ${wall} ms, ${log.filter((q) => q !== "BEGIN" && q !== "COMMIT").length} statements for all six concurrent requests`);

  /* ---- retrying a submission that already succeeded duplicates / rotates nothing ---- */
  const done = await snapshot();
  assert.notEqual(await code(svc.submitDailyWorkDay(so1, { workDate: TODAY })), 0, "a retry has nothing left to submit");
  assert.equal(await snapshot(), done, "…and changes nothing");

  /* ---- the Daily Report still completes: actuals, payment mode, self rating, final submission ---- */
  const submitted = await base.dailyWorkEntry.findMany({ where: { workDate: new Date(TODAY), batchId: BATCH, section: { in: ["SALES", "RECOVERY"] } } });
  await svc.enterDailyActual(so1, { section: "SALES", workDate: TODAY, entries: submitted.filter((e) => e.section === "SALES").map((e) => ({ entryId: e.id, todaysActual: 900 })) });
  await svc.enterDailyActual(so1, { section: "RECOVERY", workDate: TODAY, entries: submitted.filter((e) => e.section === "RECOVERY").map((e) => ({ entryId: e.id, todaysActual: 800, paymentMode: "CASH" })) });
  await svc.submitDailyReport(so1, { workDate: TODAY, selfRating: 7 });
  eq((await base.dailyWorkDay.findFirstOrThrow({ where: { workDate: new Date(TODAY) } })).status, "FINALIZED", "the Daily Report submits");
  console.log("submit-day.integration.ts — all assertions passed");
}
main().then(() => base.$disconnect(), async (e) => { console.error(e); await base.$disconnect(); process.exit(1); });
