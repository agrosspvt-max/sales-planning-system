/**
 * CN calendar expiry + grace + reopen against a REAL, disposable PostgreSQL database.
 *
 *   createdb billing_task_test && DATABASE_URL=postgresql://localhost:5432/billing_task_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   BILLING_TASK_TEST_URL=postgresql://localhost:5432/billing_task_test npm run test:cn-expiry:db
 *
 * Only a LOCAL database named `billing_task_test` is permitted — the script TRUNCATEs the tables it uses.
 * "Now" is the real clock: fixtures are placed relative to today's IST date, so every boundary is exercised without faking time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import * as realLabels from "@/features/labels/labels";
import { addCnDays, cnDateStartInstant } from "@/lib/cn-expiry";
import { cnRequestBusinessDateKey, isCnSundayDateKey } from "@/lib/cn-request";
import type { AuthContext } from "@/lib/http";

const url = process.env.BILLING_TASK_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/billing_task_test")
  throw new Error("Only a local database named billing_task_test is permitted (set BILLING_TASK_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const LABELS = realLabels.DEFAULT_LABELS as Record<string, string>;
const load = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data }) },
  "@/features/labels/service.server": { getResolvedLabels: async () => LABELS },
  "@/features/notifications/task-alerts.server": { notifyAutoTaskCreated: async () => undefined },
  "@/features/tasks/task-history.server": { recordTaskReschedule: async () => true },
  "@/features/daily-work/day-lock.server": { lockDailyWorkDay: async () => ({ currentBatchId: "b", status: "OPEN", selfRating: null, finalizedAt: null }) },
  "@/features/daily-work/auto-task-materialization.server": { reverseMaterializedDailyWorkContribution: async () => undefined },
  "@/features/daily-work/task-rows.server": { dropEmptyTaskRow: async () => undefined },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
});
const svc = load<typeof import("./service.server")>("src/features/cn-requests/service.server.ts");
const exp = load<typeof import("./cn-expiry.server")>("src/features/cn-requests/cn-expiry.server.ts");
const outcomes = load<typeof import("@/features/daily-work/task-outcome.server")>("src/features/daily-work/task-outcome.server.ts");

const fail = async (p: Promise<unknown>) => p.then(() => ({ status: 0, message: "" }), (e: { status?: number; message?: string }) => ({ status: e.status ?? -1, message: e.message ?? "" }));
const ctx = (userId: string, role: Role, groupId: string | null = "g1", permissions?: Record<string, string[]>): AuthContext => ({ userId, username: userId, role, groupId, permissions }) as AuthContext;
const admin = ctx("admin", Role.SUPER_ADMIN, null), so1 = ctx("so1", Role.SALES_OFFICER), so2 = ctx("so2", Role.SALES_OFFICER);
const acc = { ...ctx("acc", Role.CUSTOM_ADMIN, null, { cnRequests: ["read", "approve", "verifyPayment", "post"] }), designation: "Accounts Officer" } as AuthContext;
const accNoApprove = ctx("acc2", Role.CUSTOM_ADMIN, null, { cnRequests: ["read", "verifyPayment"] });

const TODAY = cnRequestBusinessDateKey(new Date())!;
const day = (n: number) => addCnDays(TODAY, n);
const nonSunday = (from: string) => { let d = from; while (isCnSundayDateKey(d)) d = addCnDays(d, 1); return d; };
const PDF = { name: "w.pdf", type: "application/pdf", buffer: Buffer.from("%PDF-1.7\nCN") };
const FINAL = { name: "final.pdf", type: "application/pdf", buffer: Buffer.from("%PDF-1.7\nFINAL") };
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
let seq = 0;
const key = () => `key-${++seq}-${Math.random().toString(36).slice(2)}`;

/** An Accepted / Not Posted, Payment Pending CN with an open SCHEDULED follow-up task. `expiry` / `grace` are placed relative to today. */
async function seed(id: string, o: { expiry: string; grace?: number; stage?: string | null; officerId?: string; outstanding?: number; status?: string; paymentStatus?: string; verified?: boolean; cycle?: number; taskDate?: string; accepted?: Date; legacyDays?: number | null } = { expiry: day(5) }) {
  const outstanding = o.outstanding ?? 1000;
  await prisma.cnRequest.create({ data: {
    id, officerId: o.officerId ?? "so1", dealerId: "d1", cnType: "CD", amount: 1000, status: o.status ?? "ACCEPTED_NOT_POSTED", acceptanceReason: "PAYMENT_PENDING", paymentTrackingMode: "PAYMENT_V1",
    paymentStatus: o.paymentStatus ?? "Pending", paymentOriginalAmount: 1000, paymentOutstandingAmount: outstanding, paymentVerified: o.verified ?? false, details: "d",
    createdAt: new Date((o.accepted ?? new Date(Date.now() - 20 * 86_400_000)).getTime() - 86_400_000), acceptedAt: o.accepted ?? new Date(Date.now() - 20 * 86_400_000), cnWorkingDocument: "data:application/pdf;base64,JVBERg==", cnWorkingFileName: "w.pdf", cnWorkingMimeType: "application/pdf", cnWorkingFileSize: 4,
    cnExpiryDate: new Date(`${o.expiry}T00:00:00Z`), cnGraceDays: o.grace ?? 0, cnPolicyStage: o.stage === undefined ? "WORKING" : o.stage, cnPolicyCycle: o.cycle ?? 1, cnExpiryDays: o.legacyDays ?? null,
  } });
  if (outstanding > 0) await prisma.cnPaymentEvent.create({ data: {
    id: `ev-${id}`, cnRequestId: id, status: "PENDING", eventDate: new Date(`${TODAY}T00:00:00Z`), outstandingBefore: outstanding, outstandingAfter: outstanding, taskAmount: outstanding,
    taskDate: new Date(`${nonSunday(day(1))}T00:00:00Z`), taskStatus: "SCHEDULED", source: "ACCEPTANCE", requestKey: `acceptance:${id}`, recordedById: "admin",
  } });
}
const row = (id: string) => prisma.cnRequest.findUniqueOrThrow({ where: { id } });
const events = (id: string) => prisma.cnExpiryEvent.findMany({ where: { cnRequestId: id }, orderBy: [{ effectiveAt: "asc" }, { cycleNo: "asc" }] });
const kinds = async (id: string) => (await events(id)).map((e) => `${e.cycleNo}:${e.kind}`);
const tab = async (c: AuthContext, view: Parameters<typeof svc.listCnRequests>[1]) => (await svc.listCnRequests(c, view)).map((r) => r.id).sort();

async function reset() {
  await prisma.$executeRawUnsafe(`TRUNCATE "CnExpiryEvent","CnPaymentEvent","CnRequest","DealerAssignment","Dealer","AuditLog","Notification","TaskRescheduleEvent","User","UserGroup" CASCADE`);
  await prisma.userGroup.create({ data: { id: "g1", name: "G1" } });
  for (const [id, role] of [["admin", Role.SUPER_ADMIN], ["acc", Role.CUSTOM_ADMIN], ["acc2", Role.CUSTOM_ADMIN], ["so1", Role.SALES_OFFICER], ["so2", Role.SALES_OFFICER]] as const)
    await prisma.user.create({ data: { id, name: id.toUpperCase(), username: id, passwordHash: "x", role, groupId: role === Role.SALES_OFFICER ? "g1" : null, designation: id === "acc" ? "Accounts Officer" : null } });
  await prisma.dealer.create({ data: { id: "d1", name: "Dealer 1" } });
  await prisma.dealerAssignment.create({ data: { dealerId: "d1", officerId: "so1", effectiveFrom: new Date("2024-01-01") } });
}

async function main() {
  await reset();
  // Real migration data conversion: preserve the old final allowed date, history and already-expired state.
  for (const [id, stage] of [["old-working", "WORKING"], ["old-grace", "GRACE"], ["old-expired", "EXPIRED"]]) await seed(id!, { expiry: day(3), grace: 5, stage });
  await seed("exempt", { expiry: day(3), stage: null });
  const migration = readFileSync("prisma/migrations/20261028000000_cn_manual_grace/migration.sql", "utf8");
  for (const statement of migration.slice(migration.indexOf('INSERT INTO "CnExpiryEvent"')).split(/;\s*\n/).filter(x => x.trim())) await prisma.$executeRawUnsafe(statement);
  for (const id of ["old-working", "old-grace", "old-expired"]) {
    const r = await row(id);
    assert.equal(iso(r.cnExpiryDate), day(8), "old expiry + configured grace is preserved exactly");
    assert.equal(r.cnPolicyStage, id === "old-expired" ? "EXPIRED" : "GRACE");
    const e = (await events(id))[0]!;
    assert.equal(e.actorId, null); assert.equal(e.kind, "GRACE_MIGRATED");
    assert.equal(iso(e.previousExpiryDate), day(3)); assert.equal(e.expiryIncludesGrace, true);
  }
  assert.equal(iso((await row("exempt")).cnExpiryDate), day(3));
  await reset();

  // New acceptance starts WITHOUT grace even if an older browser sends its obsolete grace field.
  await prisma.cnRequest.create({ data: { id: "A", officerId: "so1", dealerId: "d1", cnType: "CD", status: "SUBMITTED", details: "x" } });
  assert.equal((await fail(svc.acceptCnRequest(admin, "A", { status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDate: TODAY, outstandingAmount: 1000 }, PDF))).status, 422);
  await svc.acceptCnRequest(admin, "A", { status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDate: day(10), graceDays: 5, outstandingAmount: 1000 }, PDF);
  assert.deepEqual([iso((await row("A")).cnExpiryDate), (await row("A")).cnGraceDays, (await row("A")).cnPolicyStage], [day(10), 0, "WORKING"]);
  assert.equal((await events("A"))[0]!.graceDays, 0);
  assert.equal((await events("A"))[0]!.expiryIncludesGrace, true);

  const grant = { days: 5, fromExpiry: day(10), fromCycle: 1, requestKey: key() };
  assert.equal((await fail(exp.grantCnGrace(so1, "A", grant))).status, 403);
  assert.equal((await fail(exp.grantCnGrace(accNoApprove, "A", grant))).status, 403);
  for (const days of [0, -1, 1.5, "abc", 366]) assert.equal((await fail(exp.grantCnGrace(admin, "A", { ...grant, days }))).status, 422);
  const beforeAmount = (await row("A")).paymentOutstandingAmount?.toString();
  const result = await Promise.all(Array.from({ length: 4 }, () => exp.grantCnGrace(acc, "A", grant)));
  assert.ok(result.every(r => r.expiryDate === day(15)), "concurrent duplicate clicks add days once");
  assert.deepEqual([iso((await row("A")).cnExpiryDate), (await row("A")).cnGraceDays, (await row("A")).cnPolicyStage], [day(15), 5, "GRACE"]);
  assert.equal((await events("A")).filter(e => e.kind === "GRACE_GRANTED").length, 1);
  assert.equal((await row("A")).paymentOutstandingAmount?.toString(), beforeAmount);
  assert.equal((await fail(exp.grantCnGrace(admin, "A", { ...grant, requestKey: key() }))).status, 409, "a stale date cannot extend again");
  await exp.grantCnGrace(admin, "A", { ...grant, fromExpiry: day(15), days: 2, requestKey: key() });
  assert.deepEqual([iso((await row("A")).cnExpiryDate), (await row("A")).cnGraceDays], [day(17), 7], "explicit second grant accumulates");
  const g = (await svc.getCnRequest(admin, "A")).timeline.filter(e => e.kind === "GRACE_GRANTED");
  assert.equal(g.length, 2); assert.ok(g.every(e => e.actor && e.graceEndDate === null));
  assert.equal(g[0]!.expiryDate, day(15)); assert.equal(g[0]!.previousExpiryDate, day(10));
  const pay = await svc.getCnPaymentDetail(so1, "A");
  assert.equal(pay.followUpWindowEnd, day(17), "payment follow-ups use the effective expiry, never + grace twice");
  const task = await prisma.cnPaymentEvent.findFirstOrThrow({ where: { cnRequestId: "A", taskStatus: "SCHEDULED" } });
  const taskRules = (await outcomes.dateRules(prisma as never, [{ unitType: "CN_PAYMENT", unitId: task.id }])).get(`CN_PAYMENT:${task.id}`)!;
  assert.equal(taskRules.maxDate, day(17));

  // Inclusive four-day window and exclusive tabs, plus all grace-granted CNs regardless of distance.
  await seed("near4", { expiry: day(4) }); await seed("near0", { expiry: TODAY });
  await seed("far5", { expiry: day(5) }); await seed("overdue", { expiry: day(-1) });
  await seed("other-so", { expiry: day(2), officerId: "so2" });
  const near = await tab(so1, "cn-near-expire"), working = await tab(so1, "accepted-not-posted");
  assert.deepEqual(near, ["A", "near0", "near4"]);
  assert.deepEqual(working, ["far5"]);
  assert.deepEqual(await tab(so1, "expired-cn"), ["overdue"]);
  assert.deepEqual(await tab(so2, "cn-near-expire"), ["other-so"]);
  assert.deepEqual(await tab(so1, "cn-in-grace"), near, "old URL remains a compatible alias");
  await prisma.cnRequest.create({ data: { id: "under", officerId: "so1", dealerId: "d1", cnType: "CD", status: "UNDER_PROCESS" } });
  assert.equal((await fail(exp.grantCnGrace(admin, "under", { ...grant, requestKey: key() }))).status, 409);

  // An extension never bypasses the existing payment/verification/posting workflow.
  await svc.updateCnPayment(so1, "A", { status: "PARTIAL_PAID", amountPaid: 100, paymentDate: TODAY, followUpDate: nonSunday(day(8)), requestKey: key(), taskId: task.id });
  assert.equal((await row("A")).cnGraceDays, 7); assert.equal(iso((await row("A")).cnExpiryDate), day(17));
  await svc.verifyCnPayment(acc, "A", { status: "PARTIAL_PAID", amountPaid: 100, requestKey: key() });
  assert.equal((await fail(svc.verifyCnPayment(acc, "A", { status: "PAID", requestKey: key() }))).status, 422, "final document remains compulsory");
  await svc.verifyCnPayment(acc, "A", { status: "PAID", requestKey: key() }, FINAL);
  assert.equal((await row("A")).status, "POSTED_IN_LEDGER");
  assert.ok(!(await tab(so1, "cn-near-expire")).includes("A"));
  assert.ok((await tab(so1, "posted-in-ledger")).includes("A"));
  assert.equal((await fail(exp.grantCnGrace(admin, "A", { ...grant, fromExpiry: day(17), requestKey: key() }))).status, 409);

  // No automatic grace: after the effective date every existing mutation is gated, history remains available.
  assert.equal((await row("overdue")).cnPolicyStage, "EXPIRED");
  assert.deepEqual(await kinds("overdue"), ["1:EXPIRED"]);
  assert.equal((await events("overdue"))[0]!.effectiveAt.toISOString(), cnDateStartInstant(TODAY).toISOString());
  for (const attempt of [
    () => svc.updateCnPayment(so1, "overdue", { status: "PAID", paymentDate: TODAY, requestKey: key(), taskId: "ev-overdue" }),
    () => svc.verifyCnPayment(admin, "overdue", { status: "PAID", requestKey: key() }, FINAL),
    () => svc.scheduleCnTask(so1, "overdue", { taskId: "ev-overdue", taskDate: nonSunday(day(1)) }),
    () => exp.grantCnGrace(admin, "overdue", { ...grant, fromExpiry: day(-1), requestKey: key() }),
  ]) assert.equal((await fail(attempt())).status, 409);
  const reopen = { expiryDate: day(10), reason: "Dealer promised payment", authorizedBy: "Regional Head", fromCycle: 1 };
  assert.equal((await fail(exp.reopenCnRequest(admin, "overdue", { ...reopen, reason: "" }))).status, 422);
  await Promise.all([exp.reopenCnRequest(acc, "overdue", reopen), exp.reopenCnRequest(acc, "overdue", reopen)]);
  assert.deepEqual([(await row("overdue")).cnPolicyCycle, (await row("overdue")).cnGraceDays, iso((await row("overdue")).cnExpiryDate)], [2, 0, day(10)]);
  assert.deepEqual(await kinds("overdue"), ["1:EXPIRED", "2:REOPENED"]);
  const future = new Date(cnDateStartInstant(day(11)));
  assert.equal(await exp.reconcileCnExpiry("overdue", future), "EXPIRED");
  assert.deepEqual(await kinds("overdue"), ["1:EXPIRED", "2:REOPENED", "2:EXPIRED"]);
  // Extended expiry boundary: no implicit second grace window.
  await seed("boundary", { expiry: day(3), grace: 5, stage: "GRACE" });
  assert.equal(await exp.reconcileCnExpiry("boundary", cnDateStartInstant(day(4))), "EXPIRED");
  // Timely Paid awaiting admin verification is not expired by this change.
  await seed("paid-awaiting", { expiry: day(-10), outstanding: 0, paymentStatus: "Paid" });
  assert.equal(await exp.reconcileCnExpiry("paid-awaiting"), "WORKING");
  console.log("CN manual grace, migration, permissions, timeline, tasks and posting integration tests passed");
}
main().then(() => prisma.$disconnect(), async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
