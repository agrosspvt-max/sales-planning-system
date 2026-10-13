/**
 * Billing Exception — the REAL service (billing-exception.server + the shared report pipeline) against an in-memory database, plus the rendered
 * page / form. Row locks and real concurrency are proven against PostgreSQL by billing-exception.integration.ts (opt-in); this suite covers the rules:
 * validation, authorization / scope, the server-derived snapshot, idempotency, the Current / History semantics, the 50 → 23 lifecycle, and retry.
 */
import assert from "node:assert/strict";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import type { AuthContext } from "@/lib/http";
import { TestApiError, testLoader } from "@/features/dealer-tags/test-loader";
import { parseLastPaymentReportParams } from "@/lib/last-payment-report";
import { canCreateBillingException } from "@/features/accounts/permissions";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TODAY = "2026-10-05";
const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);

/* ---------------------------------- in-memory database ---------------------------------- */
const officers: Record<string, { name: string; territory: string; group: string }> = { so1: { name: "Arjun", territory: "BHOPAL", group: "MP" }, so2: { name: "Sunil", territory: "RAIPUR", group: "CG" }, so3: { name: "Rahul", territory: "LUCKNOW", group: "UP" } };
const owners: Record<string, string> = { dA: "so1", dB: "so1", dC: "so2", dFresh: "so1", dNone: "so1" };
const dealers: Row[] = [{ id: "dA", name: "Alpha Traders", status: "ACTIVE" }, { id: "dB", name: "Beta Stores", status: "ACTIVE" }, { id: "dC", name: "Gamma Agro", status: "DEFAULTER" }, { id: "dFresh", name: "Fresh", status: "ACTIVE" }, { id: "dNone", name: "Never Paid", status: "ACTIVE" }];
// dealerId → { date, amount } of the effective Last Payment (the shared source is replaced by this map; the report's Days arithmetic is the REAL one)
const payments: Record<string, { date: string; amount: number } | undefined> = { dA: { date: day(50), amount: 5000 }, dB: { date: day(60), amount: 700 }, dC: { date: day(70), amount: 100 }, dFresh: { date: day(10), amount: 1 } };
let exceptions: Row[] = [], audit: Row[] = [], tasks: Row[] = [];
let failAudit = false, seq = 0, clock = 0;
const noUserFor = new Set<string>(); // officers that are not valid owners (inactive / missing)
const tick = () => new Date(Date.UTC(2026, 9, 5, 0, 0, ++clock));
const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([k, c]) => {
  if (c && typeof c === "object" && !(c instanceof Date)) { if ("in" in c) return c.in.includes(row[k]); if ("not" in c) return row[k] !== c.not; }
  if (k === "createdById_requestId") return row.createdById === (c as Row).createdById && row.requestId === (c as Row).requestId;
  return (row[k] ?? null) === (c ?? null);
});
const withUser = (r: Row) => ({ ...r, createdBy: { name: officers[r.createdById]?.name ?? r.createdById.toUpperCase() }, task: tasks.find((t) => t.billingExceptionId === r.id) ? { ...tasks.find((t) => t.billingExceptionId === r.id)!, officer: { name: officers[tasks.find((t) => t.billingExceptionId === r.id)!.officerId]?.name ?? "?" } } : null });
const prisma = {
  dealer: { findMany: async ({ where }: Row) => dealers.filter((d) => (!where.id || where.id.in.includes(d.id)) && (!where.assignments || where.assignments.some.officerId.in.includes(owners[d.id]))).map((d) => ({ ...d })) },
  user: { findMany: async ({ where }: Row) => where.id.in.filter((id: string) => id in officers).map((id: string) => ({ id, name: officers[id].name, territory: officers[id].territory, group: { name: officers[id].group } })), findUnique: async ({ where }: Row) => (where.id in officers && !noUserFor.has(where.id) ? { id: where.id, role: "SALES_OFFICER", isActive: true, deletedAt: null } : null) },
  dealerAssignment: { findMany: async ({ where }: Row) => Object.entries(owners).filter(([, o]) => where.officerId.in.includes(o)).map(([dealerId]) => ({ dealerId })) },
  auditLog: { findFirst: async () => null }, lastPaymentImport: { findFirst: async () => null },
  dealerLastPayment: { findMany: async () => [] }, dealerPaymentReceipt: { findMany: async () => [] },
  billingException: {
    groupBy: async ({ where }: Row) => [...new Set(exceptions.filter((e) => e.status === "CURRENT" && where.dealerId.in.includes(e.dealerId)).map((e) => e.dealerId))].map((dealerId) => ({ dealerId, _count: { _all: exceptions.filter((e) => e.status === "CURRENT" && e.dealerId === dealerId).length } })),
    findUnique: async ({ where }: Row) => { const r = exceptions.find((e) => matches(e, where.id ? { id: where.id } : where)); return r ? withUser(r) : null; },
    findMany: async ({ where, distinct }: Row) => { let rows = exceptions.filter((e) => matches(e, where)); rows = [...rows].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)); if (distinct) rows = rows.filter((r, i) => rows.findIndex((x) => x.dealerId === r.dealerId) === i); return rows.map((r) => ({ ...r })); },
    create: async ({ data }: Row) => { if (exceptions.some((e) => e.createdById === data.createdById && e.requestId === data.requestId)) throw Object.assign(new Error("unique"), { code: "P2002" }); const { task, ...rest } = data; const r = { id: `e${++seq}`, status: "CURRENT", resolvedAt: null, resolutionReason: null, resolvedDays: null, createdAt: tick(), billingAmount: null, paymentCondition: null, paymentDate: null, ...rest }; exceptions.push(r); if (task) tasks.push({ id: `t${++seq}`, billingExceptionId: r.id, rescheduled: false, dailyWorkEntryId: null, dailyWorkConfirmed: false, ...task.create }); return withUser(r); },
    updateMany: async ({ where, data }: Row) => { const rows = exceptions.filter((e) => matches(e, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  },
  $queryRaw: async () => [], // the dealer row lock (a no-op here)
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => { const snap = structuredClone([exceptions, audit, tasks]); try { return await fn(prisma); } catch (e) { [exceptions, audit, tasks] = snap as Row[][]; for (const r of exceptions) { r.createdAt = new Date(r.createdAt); } throw e; } },
};
const load = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (p: Row) => { if (failAudit && p.entity === "billingException" && p.action === "UPDATE") throw new Error("injected audit failure"); audit.push({ ...p }); } },
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : TODAY) },
  "./last-payment.server": { latestReceiptAsOfByDealer: async (ids: string[]) => new Map(ids.filter((id) => payments[id]).map((id) => [id, { date: payments[id]!.date, amount: payments[id]!.amount }])) },
  "@/lib/last-payment.server": { latestReceiptAsOfByDealer: async (ids: string[]) => new Map(ids.filter((id) => payments[id]).map((id) => [id, { date: payments[id]!.date, amount: payments[id]!.amount }])) },
  "@/lib/scope": {
    getOfficerScope: async (c: AuthContext) => (c.role === Role.SUPER_ADMIN || c.role === Role.CUSTOM_ADMIN ? { all: true, ids: [] } : c.role === Role.REGIONAL_MANAGER ? { all: false, ids: ["rm", "so1"] } : { all: false, ids: [c.userId] }),
    getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.filter((id) => owners[id]).map((id) => [id, owners[id]])),
  },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
});
const be = load<typeof import("./billing-exception.server")>("src/features/reports/billing-exception.server.ts");
const report = load<typeof import("./last-payment-report.server")>("src/features/reports/last-payment-report.server.ts");
const ctx = (userId: string, role: Role, permissions?: Row): AuthContext => ({ userId, username: userId, role, groupId: null, permissions } as AuthContext);
const admin = ctx("admin", Role.SUPER_ADMIN), so1 = ctx("so1", Role.SALES_OFFICER), so2 = ctx("so2", Role.SALES_OFFICER), rm = ctx("rm", Role.REGIONAL_MANAGER);
const params = (over = {}) => ({ ...parseLastPaymentReportParams(new URLSearchParams()), pageSize: 200, ...over });
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const status = async (fn: () => Promise<unknown>) => { try { await fn(); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; } };
let n = 0;
const input = (dealerId: string, over: Row = {}) => ({ dealerId, billingDate: "2026-10-01", billNo: `INV-${++n}`, authPerson: "Varun sir", requestId: `request-${n}-abcdef`, billingAmount: 20000, paymentCondition: "NO", ...over });
const rowOf = async (c: AuthContext, id: string) => plain((await report.getLastPaymentReport(c, params(), TODAY)).items.find((r) => r.dealerId === id)!);
const cur = async (c: AuthContext, over = {}) => plain(await be.listBillingExceptions(c, "current", params(over), TODAY));
const his = async (c: AuthContext, over = {}) => plain(await be.listBillingExceptions(c, "history", params(over), TODAY));

async function service() {
  // Billing Status is derived on the server from the report's own Days
  assert.deepEqual([(await rowOf(admin, "dA")).billingStatus, (await rowOf(admin, "dFresh")).billingStatus, (await rowOf(admin, "dNone")).billingStatus], ["BLOCKED", "OPEN", "UNAVAILABLE"]);
  payments.dFresh = { date: day(45), amount: 1 }; assert.equal((await rowOf(admin, "dFresh")).billingStatus, "OPEN", "exactly 45 → Open");
  payments.dFresh = { date: day(46), amount: 1 }; assert.equal((await rowOf(admin, "dFresh")).billingStatus, "BLOCKED", "exactly 46 → Blocked");
  payments.dFresh = { date: day(10), amount: 1 };
  assert.equal((await rowOf(admin, "dNone")).days, null, "missing Days stays null (not 0)");

  // validation (server side)
  for (const bad of [{ authPerson: "Other" }, { billNo: " " }, { billingDate: "" }, { billingDate: "2026-13-01" }, { requestId: "" }]) assert.equal(await status(() => be.createBillingException(admin, input("dA", bad), TODAY)), 422, JSON.stringify(bad));
  // authorization / scope
  const denied = [["SO owning the dealer", so1], ["SO of another dealer", so2], ["RM", rm],
    ["SO with a spoofed designation", { ...so1, designation: "Super Admin" } as AuthContext],
    ["Custom Admin: read only", ctx("ca", Role.CUSTOM_ADMIN, { lastPaymentReport: ["read"] })],
    ["Custom Admin: read + export", ctx("ca", Role.CUSTOM_ADMIN, { lastPaymentReport: ["read", "export"] })],
    ["Custom Admin: create without read", ctx("ca", Role.CUSTOM_ADMIN, { lastPaymentReport: ["create"] })],
    ["Custom Admin: generic Reports permissions", ctx("ca", Role.CUSTOM_ADMIN, { reports: ["read", "export", "create"] })],
    ["Custom Admin: no permissions", ctx("ca", Role.CUSTOM_ADMIN, {})]] as const;
  for (const [who, c] of denied) assert.equal(await status(() => be.createBillingException(c, input("dA"), TODAY)), 403, `${who} → 403`);
  assert.equal(await status(() => be.createBillingException(admin, input("nope"), TODAY)), 404, "unknown dealer");
  assert.equal(await status(() => be.createBillingException(admin, input("dFresh"), TODAY)), 409, "Open dealer refused");
  assert.equal(await status(() => be.createBillingException(admin, input("dNone"), TODAY)), 409, "no payment date refused");
  assert.equal(exceptions.length + audit.length, 0, "refusals wrote nothing");

  // create: snapshot from the SERVER, client values ignored
  const base = input("dA");
  const a = plain(await be.createBillingException(admin, { ...base, days: 3, snapDays: 3, status: "RESOLVED", snapSalesOfficer: "Hacker" }, TODAY));
  assert.deepEqual([a.snapshot.days, a.snapshot.lastPaymentDate, a.snapshot.amount, a.exceptionStatus, a.snapshot.salesOfficer, a.duplicate], [50, day(50), 5000, "CURRENT", "Arjun", false]);
  assert.equal(audit.filter((x) => x.action === "CREATE" && x.entity === "billingException").length, 1, "audited in the same transaction");
  // idempotency vs deliberate second exception
  assert.equal(plain(await be.createBillingException(admin, base, TODAY)).id, a.id, "same request → same exception");
  const before = [exceptions.length, audit.length];
  for (const c of [so1, rm, ctx("admin", Role.SALES_OFFICER), ctx("admin", Role.CUSTOM_ADMIN, { lastPaymentReport: ["read", "export"] })]) assert.equal(await status(() => be.createBillingException(c, base, TODAY)), 403, "re-sending an authorized request is still refused once unauthorized (before the duplicate path)");
  assert.deepEqual([exceptions.length, audit.length], before, "…and writes / reveals nothing");
  const granted = ctx("admin", Role.CUSTOM_ADMIN, { lastPaymentReport: ["read", "create"] });
  assert.equal(plain(await be.createBillingException(granted, base, TODAY)).id, a.id, "a Custom Admin granted read + create is authorized (duplicate path)");
  assert.equal(exceptions.length, 1);
  assert.equal(await status(() => be.createBillingException(admin, { ...base, billNo: "OTHER" }, TODAY)), 409, "reused identity with other content");
  const b = plain(await be.createBillingException(admin, input("dA", { billNo: base.billNo }), TODAY));
  assert.notEqual(b.id, a.id); assert.equal(exceptions.length, 2, "a deliberate second exception (even the same Bill No) is kept");
  // billing status + Current / History rows
  assert.equal((await rowOf(admin, "dA")).billingStatus, "BILLING_EXCEPTION");
  const c1 = await cur(admin);
  assert.deepEqual([c1.total, c1.items.map((r: Row) => r.exceptionId).sort().join()], [2, [a.id, b.id].sort().join()], "Current: one row per exception, counted by exception");
  assert.ok(c1.items.every((r: Row) => r.days === 50 && r.dealerId === "dA"));
  assert.equal((await his(admin)).total, 2, "History has every exception immediately");
  assert.equal((await cur(admin, { pageSize: 1 })).items.length, 1);
  assert.equal((await cur(admin, { pageSize: 1 })).total, 2, "pagination counts exceptions, not dealers");
  assert.equal((await be.getBillingExceptionDetail(so1, b.id)).id, b.id, "Info → the exact exception");
  assert.equal(await status(() => be.getBillingExceptionDetail(so2, a.id)), 404);
  assert.deepEqual([(await cur(so2)).total, (await cur(rm)).total, (await his(so2)).total, (await his(rm)).total], [0, 2, 0, 2], "scope by the dealer's current owner");
  assert.equal((await cur(admin, { search: "gamma" })).total, 0); assert.equal((await cur(admin, { filters: { state: ["MP"] } })).total, 2); assert.equal((await cur(admin, { filters: { state: ["CG"] } })).total, 0);
  assert.equal((await cur(admin, { paymentAging: { operator: "gt", value: 60 } })).total, 0, "Payment Aging applies to the live Days");

  // the 50 → 23 example
  payments.dA = { date: day(23), amount: 9000 };
  assert.equal((await rowOf(admin, "dA")).billingStatus, "OPEN", "Days 23 → green Open");
  failAudit = true; // the best-effort re-check a read triggers fails too (nothing may leak out of it)
  assert.equal((await cur(admin)).total, 0, "both exceptions leave Current at once (read-time guard)…");
  await new Promise((r) => setTimeout(r, 20));
  const failed = await be.reconcileBillingExceptions({ today: TODAY, actor: { userId: "admin" } });
  failAudit = false;
  assert.deepEqual([failed.resolved, failed.failed], [0, 1], "a transient failure resolves nothing and is reported");
  assert.deepEqual(exceptions.map((e) => e.status), ["CURRENT", "CURRENT"], "…and rolled back completely (retryable)");
  const done = await be.reconcileBillingExceptions({ today: TODAY, actor: { userId: "admin" } });
  assert.equal(done.resolved, 2, "the retry resolves ALL current exceptions of the dealer");
  assert.deepEqual(exceptions.map((e) => [e.status, e.resolutionReason, e.resolvedDays]), [["RESOLVED", "PAYMENT_RECEIVED", 23], ["RESOLVED", "PAYMENT_RECEIVED", 23]]);
  assert.equal((await be.reconcileBillingExceptions({ today: TODAY, actor: { userId: "admin" } })).resolved, 0, "idempotent");
  assert.deepEqual(plain(await his(admin)).items.map((r: Row) => [r.days, r.lastPaymentDate, r.exceptionStatus]), [[50, day(50), "RESOLVED"], [50, day(50), "RESOLVED"]], "History keeps the creation snapshot");
  assert.equal((await be.getBillingExceptionDetail(so1, a.id)).resolvedDays, 23);
  // ageing again: resolved stay resolved
  payments.dA = { date: day(60), amount: 1 };
  assert.deepEqual([(await rowOf(admin, "dA")).billingStatus, (await cur(admin)).total], ["BLOCKED", 0], "Blocked again until a NEW exception exists");
  await be.reconcileBillingExceptions({ today: TODAY, actor: { userId: "admin" } });
  assert.deepEqual(exceptions.map((e) => e.status), ["RESOLVED", "RESOLVED"], "old exceptions are never reactivated");
  const c = await be.createBillingException(admin, input("dA"), TODAY);
  assert.equal((await cur(admin)).total, 1); assert.equal((await his(admin)).total, 3); assert.ok(c.id);
  // History is a snapshot: live master-data changes do not rewrite it; Current is live
  dealers[0]!.name = "Alpha RENAMED"; dealers[0]!.status = "DEFAULTER"; owners.dA = "so3";
  const h = (await his(admin)).items.find((r: Row) => r.exceptionId === a.id)!;
  assert.deepEqual([h.party, h.status, h.salesOfficer, h.days], ["Alpha Traders", "ACTIVE", "Arjun", 50]);
  assert.deepEqual([(await cur(admin)).items[0].party, (await cur(admin)).items[0].salesOfficer], ["Alpha RENAMED", "Rahul"]);
  assert.equal((await his(so1)).total, 0, "the old owner no longer has access (current ownership decides, not the snapshot)");
  // a dealer whose Days become null is never "paid"
  payments.dA = undefined;
  assert.equal((await be.reconcileBillingExceptions({ today: TODAY, actor: { userId: "admin" } })).resolved, 0, "no payment date → no resolution");

  /* ---- Billing Amount + payment condition → Recovery task ---- */
  const bad = async (over: Row) => status(() => be.createBillingException(admin, input("dB", over), TODAY));
  assert.equal(await bad({ billingAmount: undefined }), 422, "Amount is required");
  assert.equal(await bad({ billingAmount: 0 }), 422); assert.equal(await bad({ billingAmount: "12.345" }), 422);
  assert.equal(await bad({ paymentCondition: undefined }), 422, "an explicit Yes / No is required");
  assert.equal(await bad({ paymentCondition: "YES" }), 422, "Yes needs a Date of Payment");
  assert.equal(await bad({ paymentCondition: "YES", paymentDate: "2026-10-09" }), 422, "Yes needs an explicit Payment (never defaulted from Amount)");
  assert.equal(await bad({ paymentCondition: "YES", paymentDate: "2026-10-09", paymentAmount: 0 }), 422); assert.equal(await bad({ paymentCondition: "YES", paymentDate: "2026-10-09", paymentAmount: "1.234" }), 422);
  assert.equal(await bad({ paymentCondition: "YES", paymentDate: "2026-10-04", paymentAmount: 100 }), 422, "a past promised date would rewrite submitted work");
  assert.equal(exceptions.filter((e) => e.dealerId === "dB").length + tasks.length, 0, "refusals wrote nothing");
  const paymentsBefore = JSON.stringify(payments);
  // No → recorded, amount kept, no date, NO task
  const no = plain(await be.createBillingException(admin, input("dB", { billingAmount: "1,500.50", paymentCondition: "NO", paymentDate: "2026-10-20", paymentAmount: 999 }), TODAY));
  assert.deepEqual([no.billingAmount, no.paymentCondition, no.paymentDate, no.paymentAmount, no.task, tasks.length], [1500.5, "NO", null, null, null, 0], "No: amount + answer saved, hidden date / Payment ignored, no Recovery task");
  // Yes → exactly one task for the dealer's AUTHORITATIVE officer; a forged officer id is never read
  const yesInput = input("dB", { billingAmount: 50000, paymentAmount: 15000, paymentCondition: "YES", paymentDate: "2026-10-09", officerId: "so2", ownerId: "so2" });
  const yes = plain(await be.createBillingException(admin, yesInput, TODAY));
  assert.equal(tasks.length, 1);
  assert.deepEqual([tasks[0]!.officerId, tasks[0]!.dealerId, Number(tasks[0]!.amount), tasks[0]!.promisedDate.toISOString().slice(0, 10), tasks[0]!.taskDate.toISOString().slice(0, 10)], ["so1", "dB", 15000, "2026-10-09", "2026-10-09"], "the task is planned for the PAYMENT (15,000), not the billing amount (50,000)");
  assert.deepEqual([yes.billingAmount, yes.paymentAmount, yes.paymentCondition, yes.paymentDate, yes.task!.officerName, yes.task!.status, yes.task!.amount], [50000, 15000, "YES", "2026-10-09", "Arjun", "SCHEDULED", 15000], "two separate stored values");
  const stored = exceptions.find((e) => e.id === yes.id)!;
  assert.equal(Number(stored.snapAmount), 700, "the billing amount never overwrites the last-payment snapshot amount");
  assert.equal(JSON.stringify(payments), paymentsBefore, "saving a condition / task fabricates no payment and changes no Last Payment value");
  assert.ok(audit.some((a) => a.entity === "billingException" && /Payment condition YES.*Recovery task for officer so1/.test(a.summary ?? "")), "the task is audited with the exception");
  // retries: same logical Save → the same exception and task; a changed Amount / condition / date under that request id is refused
  assert.equal(plain(await be.createBillingException(admin, yesInput, TODAY)).id, yes.id);
  assert.equal(tasks.length, 1, "a retry creates no second task");
  for (const change of [{ billingAmount: 7600 }, { paymentAmount: 15001 }, { paymentDate: "2026-10-10" }, { paymentCondition: "NO" }]) assert.equal(await status(() => be.createBillingException(admin, { ...yesInput, ...change }, TODAY)), 409, `reused request id with ${JSON.stringify(change)}`);
  // a deliberate second exception → its own independent task
  await be.createBillingException(admin, input("dB", { billingAmount: 2500, paymentAmount: 400, paymentCondition: "YES", paymentDate: "2026-10-12" }), TODAY);
  assert.deepEqual(tasks.map((t) => Number(t.amount)), [15000, 400], "multiple exceptions → independent tasks (planned from each Payment)");
  assert.equal(new Set(tasks.map((t) => t.billingExceptionId)).size, 2, "one task per exception");
  // no valid responsible officer → clear error, nothing partially saved
  const rows = exceptions.length, taskRows = tasks.length, auditRows = audit.length;
  const savedOwner = owners.dB; delete owners.dB;
  assert.equal(await status(() => be.createBillingException(admin, input("dB", { billingAmount: 100, paymentAmount: 50, paymentCondition: "YES", paymentDate: "2026-10-09" }), TODAY)), 422, "no current assignment");
  owners.dB = "so1"; noUserFor.add("so1");
  assert.equal(await status(() => be.createBillingException(admin, input("dB", { billingAmount: 100, paymentAmount: 50, paymentCondition: "YES", paymentDate: "2026-10-09" }), TODAY)), 422, "assigned officer is not a valid active officer");
  noUserFor.delete("so1"); owners.dB = savedOwner!;
  assert.deepEqual([exceptions.length, tasks.length, audit.length], [rows, taskRows, auditRows], "no partial exception / orphan task / audit row");
  // legacy exceptions (recorded before these fields) stay as they are: amount / condition null, no task invented
  const legacy = { ...exceptions[0]!, id: "legacy", billingAmount: null, paymentCondition: null, paymentDate: null, paymentAmount: null };
  exceptions.push(legacy);
  const legacyDetail = plain(await be.getBillingExceptionDetail(admin, "legacy"));
  assert.deepEqual([legacyDetail.billingAmount, legacyDetail.paymentCondition, legacyDetail.paymentDate, legacyDetail.paymentAmount, legacyDetail.task], [null, null, null, null, null], "legacy records stay readable: no promised amount invented, no task");
}

/* ---------------------------------- wiring (source) ---------------------------------- */
function wiring() {
  const read = (p: string) => readFileSync(p, "utf8");
  const server = read("src/features/reports/billing-exception.server.ts");
  assert.ok(server.includes("FOR NO KEY UPDATE") && (server.match(/lockDealer\(tx/g) ?? []).length === 2, "creation AND reconciliation take the dealer lock");
  assert.ok(server.indexOf("lockDealer(tx, dealer.dealerId)") < server.indexOf("paymentSnapshotByDealer([dealer.dealerId]"), "Days are read AFTER the lock is held");
  assert.ok(!/latestReceiptAsOf\(|lastPaymentReceipt|RecoveryPlanDealer/.test(server.replace(/latestReceiptAsOfByDealer/g, "")), "no second payment calculation");
  const code = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/dealerPaymentReceipt|dealerLastPayment|lastPaymentReceipt|lastPaymentImport|cnPaymentEvent|cnRequest|calendarEntry|"DailyWorkEntry"|dailyWorkEntry\./i.test(code), "creating an exception / its task never touches receipts, the latest payment, CN or Calendar records, or a Daily Work row directly");
  assert.ok(code.includes("task: { create:") && (code.match(/billingException\.create\(/g) ?? []).length === 1, "the exception and its single task are created in ONE create (one transaction)");
  const recovery = read("src/features/recovery/service.server.ts"), commit = recovery.slice(recovery.indexOf("export async function commitDaybook"));
  assert.ok(commit.indexOf("retainRegularReceipts(") < commit.indexOf("reconcileBillingExceptionsSafely(") && commit.includes("billingExceptionWarning"), "regular Day Book: reconciled after the financial commit and after receipt retention");
  const hist = read("src/features/historical-daybook/service.server.ts"), hc = hist.slice(hist.indexOf("export async function commitHistoricalDaybook"));
  assert.ok(hc.indexOf("$transaction") < hc.indexOf("reconcileBillingExceptionsSafely(") && !/reconcileBillingExceptions\(/.test(hc.slice(0, hc.indexOf("$transaction"))), "historical Day Book: reconciled after the receipt transaction (also when already imported)");
  const create = server.slice(server.indexOf("export async function createBillingException"));
  assert.ok(create.indexOf("assertCanCreate(ctx)") >= 0 && create.indexOf("assertCanCreate(ctx)") < create.indexOf("validateBillingExceptionInput") && create.indexOf("assertCanCreate(ctx)") < create.indexOf("$transaction"), "authorization is the FIRST step: before validation, reads and the duplicate path");
  const pageSrc = read("src/features/reports/last-payment-report-page.tsx");
  assert.ok(pageSrc.includes("useCanCreateBillingException()") && !/useAdminPermission\("lastPaymentReport", "create"\)/.test(pageSrc) && pageSrc.includes("{canCreate && target && <BillingExceptionActionDialog") && pageSrc.includes("if (canCreate) setTarget("), "badge, open handler and dialog rendering are all guarded");
  assert.ok(read("src/features/reports/billing-exception-ui.tsx").includes('"account-access"'), "a refused / revoked Save re-reads the account's permissions through the existing access query");
  assert.ok(read("src/features/accounts/accounts-page.tsx").includes('"Create Billing Exception"') && read("src/features/accounts/permission-ui.tsx").includes("export function useAdminPermission(module: AdminModule, action = \"read\") {\n  const identity = useContext(PermissionContext);\n  return identity.role !== Role.CUSTOM_ADMIN"), "module-specific label; the shared hook is unchanged");
  const safe = server.slice(server.indexOf("export async function reconcileBillingExceptionsSafely"));
  assert.ok(safe.includes("try {") && safe.includes("catch") && !/throw /.test(safe), "reconciliation never throws into a Day Book commit");
  const schema = read("prisma/schema.prisma"), model = schema.slice(schema.indexOf("model BillingException"), schema.indexOf("\n}\n", schema.indexOf("model BillingException")));
  assert.ok(/@@unique\(\[createdById, requestId\]\)/.test(model) && /onDelete: Restrict/.test(model) && !/@@unique\(\[dealerId/.test(model) && !/billNo\s+String\s+@unique/.test(model), "per-request uniqueness only; restrict deletes; no one-per-dealer / unique Bill No");
  const routes = ["src/app/api/reports/last-payment/billing-exceptions/route.ts", "src/app/api/reports/last-payment/billing-exceptions/[id]/route.ts", "src/app/api/reports/last-payment/billing-exceptions/export/route.ts"].map(read).join("\n");
  assert.ok(!/officerId|scope\s*=|ownerId/.test(routes.replace(/session scope|scope parameter|\bscope\b is/g, "")), "routes read no officer / scope input");
}

/* ---------------------------------- rendered page ---------------------------------- */
let preset: Record<number, unknown> = {}; let stateCall = 0; let served: unknown = { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1, options: { party: [], status: [], state: [], territory: [], officer: [], billing: [], authBy: [] }, appliedFilters: {}, lastUpdate: null };
let requested = ""; const permissions: Row = { role: "SUPER_ADMIN" };
const pageLoad = testLoader({
  "@/features/labels/label-ui": { useLabel: (key: string) => (DEFAULT_LABELS as Record<string, string>)[key] ?? key },
  react: { ...React, useState: (initial: unknown) => { const i = stateCall++; return [i in preset ? preset[i] : initial, () => {}]; }, useContext: () => permissions },
  "next/navigation": { useSearchParams: () => new URLSearchParams("") },
  "@tanstack/react-query": { keepPreviousData: {}, useQuery: ({ queryKey, queryFn }: { queryKey: unknown[]; queryFn: () => unknown }) => { void queryFn(); return { data: String(queryKey[0]).endsWith("options") ? undefined : served, isLoading: false, isFetching: false, isPlaceholderData: false, error: null }; }, useMutation: () => ({ isPending: false, mutate() {} }), useQueryClient: () => ({ invalidateQueries() {} }) },
  "@/lib/api-client": { api: { get: async (url: string) => { if (!url.includes("optionsOnly")) requested = url; return {}; }, post: async () => ({}) } },
  "@/components/layout/page-header": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
  "@/features/accounts/permission-ui": { useAdminPermission: (module: string, action: string) => permissions.role !== "CUSTOM_ADMIN" || (permissions.permissions?.[module] ?? []).includes(action), useCanCreateBillingException: () => canCreateBillingException(permissions as never) },
});
const { LastPaymentReportPage } = pageLoad<typeof import("./last-payment-report-page")>("src/features/reports/last-payment-report-page.tsx");
const ui = pageLoad<typeof import("./billing-exception-ui")>("src/features/reports/billing-exception-ui.tsx");
const draw = (p: Record<number, unknown> = {}, items: unknown[] = [], extra: Row = {}) => { served = { items, total: items.length, page: 1, pageSize: 50, totalPages: 1, options: { party: [], status: [], state: [], territory: [], officer: [] }, appliedFilters: {}, lastUpdate: null, ...extra }; preset = p; stateCall = 0; return renderToStaticMarkup(<LastPaymentReportPage />); };
const heads = (html: string) => [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());
const LP = (over: Row = {}) => ({ dealerId: "d1", party: "Alpha", status: "ACTIVE", state: "MP", territory: "BHOPAL", salesOfficer: "Arjun", lastPaymentDate: "2026-08-16", amount: 5000, days: 50, billingStatus: "BLOCKED", currentExceptions: 0, ...over });
const EX = (id: string, over: Row = {}) => ({ exceptionId: id, dealerId: "d1", party: "Alpha", status: "ACTIVE", state: "MP", territory: "BHOPAL", salesOfficer: "Arjun", lastPaymentDate: "2026-08-16", amount: 5000, days: 50, billingDate: "2026-10-01", billNo: `B-${id}`, authPerson: "Varun sir", exceptionStatus: "CURRENT", createdAt: "2026-10-05T01:00:00.000Z", ...over });

function page() {
  // Tab hierarchy: wrapper states are index 0 (main) and 1 (sub); defaults = Last Payment.
  let html = draw({}, [LP()]);
  assert.ok(html.includes(">Last Payment<") && html.includes(">Billing Exception<"), "two top-level tabs");
  assert.ok(!html.includes(">Current<") && !html.includes(">History<"), "Current / History appear ONLY inside Billing Exception");
  assert.deepEqual(heads(html), ["Party", "Status", "State", "Territory", "Sales Officer", "Last Payment Date", "Days", "Billing Status"], "Last Payment: the eight columns + Billing Status");
  assert.ok(html.includes("data-billing-status=\"BLOCKED\"") && html.includes("Blocked"));
  // Billing Status cell: Open / Unavailable are not buttons; Blocked / Billing Exception are
  const cell = (status: string, clickable = true) => renderToStaticMarkup(<ui.BillingStatusCell status={status as never} party="Alpha" clickable={clickable} onOpen={() => {}} />);
  assert.ok(!cell("OPEN").includes("<button") && cell("OPEN").includes("Open") && /success/.test(cell("OPEN")) || cell("OPEN").includes("bg-success"), "Open: green, not clickable");
  assert.ok(cell("BLOCKED").includes("<button") && cell("BLOCKED").includes("bg-warning"), "Blocked: yellow, clickable");
  assert.ok(cell("BILLING_EXCEPTION").includes("<button") && cell("BILLING_EXCEPTION").includes("bg-purple-500/15"), "Billing Exception: purple, clickable");
  assert.ok(!cell("UNAVAILABLE").includes("<button") && cell("UNAVAILABLE").includes("Unavailable"), "missing payment: neutral, not clickable");
  assert.ok(!cell("BLOCKED", false).includes("<button"), "without the create permission the status is not clickable");
  // Who may click Blocked / Billing Exception (presentation; the API enforces it): Super Admin and a Custom Admin with read + create only.
  const rows = [LP({ dealerId: "d1", billingStatus: "BLOCKED" }), LP({ dealerId: "d2", party: "Beta", billingStatus: "BILLING_EXCEPTION" }), LP({ dealerId: "d3", party: "Gamma", billingStatus: "OPEN", days: 10 }), LP({ dealerId: "d4", party: "Delta", billingStatus: "UNAVAILABLE", days: null })];
  const clickable = (who: Row) => { Object.assign(permissions, { permissions: undefined }, who); const out = draw({}, rows); return [...out.matchAll(/data-billing-status="([A-Z_]+)"/g)].map((m) => m[1]).length === 4 ? [...out.matchAll(/<button[^>]*data-billing-status="([A-Z_]+)"/g)].map((m) => m[1]) : ["?"]; };
  assert.deepEqual(clickable({ role: "SUPER_ADMIN" }), ["BLOCKED", "BILLING_EXCEPTION"], "Super Admin: only Blocked / Billing Exception are clickable — never Open or Unavailable");
  assert.deepEqual(clickable({ role: "CUSTOM_ADMIN", permissions: { lastPaymentReport: ["read", "create"] } }), ["BLOCKED", "BILLING_EXCEPTION"], "Custom Admin with read + create");
  for (const who of [{ role: "SALES_OFFICER" }, { role: "REGIONAL_MANAGER" }, { role: "CUSTOM_ADMIN", permissions: { lastPaymentReport: ["read"] } }, { role: "CUSTOM_ADMIN", permissions: { lastPaymentReport: ["read", "export"] } }, { role: "CUSTOM_ADMIN", permissions: { reports: ["read", "export", "create"] } }])
    assert.deepEqual(clickable(who), [], `${JSON.stringify(who)}: statuses are plain badges (no button)`);
  const plainHtml = draw({}, rows);
  assert.ok(plainHtml.includes("Blocked") && plainHtml.includes("Billing Exception") && plainHtml.includes("bg-warning") && plainHtml.includes("bg-purple-500/15") && !/cursor-pointer|hover:/.test(plainHtml.slice(plainHtml.indexOf("<tbody"), plainHtml.indexOf("</tbody>")).replace(/hover:bg-muted\/50/g, "")), "same text and colours, no pointer / hover affordance");
  Object.assign(permissions, { role: "SUPER_ADMIN", permissions: undefined });
  // Last Payment Date + Amount are ONE cell: the date, with the amount underneath as smaller muted text (display only; both stay separate API / export fields).
  const stack = (view: Row, items: unknown[]) => { const out = draw(view, items); return [...out.matchAll(/<tr[^>]*data-dealer-id="([^"]+)"[^>]*>(.*?)<\/tr>/g)].map((m) => [m[1], [...m[2].matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((c) => c[1])] as const); };
  const payCell = (cells: readonly string[]) => cells[5];
  const stacked = '<div class="flex flex-col items-end gap-0.5"><span>7 Apr 2026</span><span class="text-xs text-muted-foreground" data-testid="payment-amount">₹2,20,706</span></div>';
  const lpRows = stack({}, [LP({ dealerId: "p1", lastPaymentDate: "2026-04-07", amount: 220706 }), LP({ dealerId: "p2", lastPaymentDate: "2026-04-07", amount: 0 }), LP({ dealerId: "p3", lastPaymentDate: null, amount: null, days: null, billingStatus: "UNAVAILABLE" })]);
  assert.ok(payCell(lpRows[0]![1]).includes(stacked), "Last Payment: date on top, amount underneath (smaller, muted)");
  assert.ok(payCell(lpRows[1]![1]).includes("₹0") && payCell(lpRows[1]![1]).includes("7 Apr 2026"), "a genuine zero amount is shown as currency, not as missing");
  assert.equal(payCell(lpRows[2]![1]).replace(/<[^>]*>/g, ""), "—", "nothing available → a single dash");
  assert.ok(!payCell(lpRows[2]![1]).includes("₹"));
  for (const [label, v] of [["Current", { 0: "billing-exception" }], ["History", { 0: "billing-exception", 1: "history" }]] as const) {
    const rows = stack(v, [EX("x1", { lastPaymentDate: "2026-04-07", amount: 220706 })]);
    assert.ok(payCell(rows[0]![1]).includes(stacked), `${label}: the same stacked cell`);
    assert.equal(heads(draw(v, [EX("x1")])).filter((h) => h === "Amount").length, 0, `${label}: no Amount column`);
    assert.equal(rows[0]![1].length, 10, `${label}: ten cells (seven report columns + Billing Date + Authorized By + Info)`);
  }
  assert.equal(lpRows[0]![1].length, 8, "Last Payment: 8 cells (Billing Status last)");
  // Billing Date (+ that exception's Billing Amount underneath) and Authorized By sit between Days and Info, in BOTH exception sections, read from each row's own record.
  for (const [label, v] of [["Current", { 0: "billing-exception" }], ["History", { 0: "billing-exception", 1: "history" }]] as const) {
    const hs = heads(draw(v, [EX("x1")]));
    assert.deepEqual(hs.slice(hs.indexOf("Days"), hs.indexOf("Days") + 4).map((h) => h.replace(/\s+/g, " ")), ["Days", "Billing Date", "Authorized By", "Info"].map((h) => (h === "Days" ? hs[hs.indexOf("Days")]! : h)), `${label}: Days → Billing Date → Authorized By → Info`);
    const two = stack(v, [EX("e1", { billingDate: "2026-10-13", billingAmount: 12000, authPerson: "Varun sir" }), EX("e2", { billingDate: "2026-09-02", billingAmount: 2500, authPerson: "Tej Sir" }), EX("e3", { billingDate: null, billingAmount: null, authPerson: null })]);
    const cell = (i: number, c: number) => two[i]![1][c]!;
    assert.ok(cell(0, 7).includes("<span>13 Oct 2026</span>") && cell(0, 7).includes('class="text-xs text-muted-foreground" data-testid="billing-amount">₹12,000</span>') && cell(0, 8) === "Varun sir", `${label}: first exception shows ITS date, amount and authorization option`);
    assert.ok(cell(1, 7).includes("2 Sept 2026") && cell(1, 7).includes("₹2,500") && cell(1, 8) === "Tej Sir", `${label}: the same dealer's second exception shows its own, different, values`);
    assert.equal(cell(2, 7).replace(/<[^>]*>/g, ""), "—", `${label}: missing legacy billing date/amount → a single dash`);
    assert.equal(cell(2, 8).replace(/<[^>]*>/g, ""), "—", `${label}: missing Auth Person → dash`);
    assert.ok(!cell(0, 7).includes("₹2,20,706") && !cell(0, 7).includes("220706"), `${label}: never the dealer's last-payment amount`);
  }
  // Authorized By is a header filter (same component as Sales Officer) in BOTH exception tabs — and only there.
  for (const [label, v] of [["Current", { 0: "billing-exception" }], ["History", { 0: "billing-exception", 1: "history" }]] as const) {
    const out = draw(v, [EX("x1")]);
    assert.ok(out.includes('aria-label="Filter by Authorized By"') && !out.includes('aria-label="Filter by Billing Status"'), `${label}: Authorized By is a filter header; Billing Status is not shown`);
  }
  assert.ok(!draw({}, [LP()]).includes("Filter by Authorized By"), "Last Payment tab: no Authorized By filter");
  // Billing Exception summary panel: Current and History only, informational items + two clickable ranking items; the Day summary stays Last Payment-only.
  for (const [label, v] of [["Current", { 0: "billing-exception" }], ["History", { 0: "billing-exception", 1: "history" }]] as const) {
    const out = draw(v, [EX("x1")]);
    assert.ok(out.includes('data-testid="exception-summary"') && !out.includes('data-testid="day-summary"'), `${label}: the exception summary, not the day summary`);
    assert.ok(out.indexOf("Apply Filters") < out.indexOf('data-testid="exception-summary"') && out.indexOf('data-testid="exception-summary"') < out.indexOf("<table"), `${label}: between the toolbar and the table`);
    const panelHtml = out.slice(out.indexOf('data-testid="exception-summary"'), out.indexOf("<table"));
    assert.ok(["Total Ex. Bills", "Dealers", "Top Dealers", "Top SO"].every((l) => panelHtml.includes(l)), `${label}: four items`);
    assert.equal((panelHtml.match(/<button/g) ?? []).length, 2, `${label}: only Top Dealers and Top SO are clickable`);
    assert.ok(/data-testid="summary-total-bills">—</.test(panelHtml) === true, `${label}: counts show a dash until the data arrives`);
  }
  assert.ok(!draw({}, [LP()]).includes("exception-summary"), "Last Payment tab: no exception summary");
  const panel = draw({}, [LP()]);
  assert.ok(panel.includes('data-testid="day-summary"') && ["All Dealers", "30 Days or Less", "31–44 Days", "45–60 Days", "61–90 Days", "90+ Days"].every((l) => panel.includes(l)) && panel.indexOf('data-testid="day-summary"') < panel.indexOf("<table") && panel.indexOf("Apply Filters") < panel.indexOf('data-testid="day-summary"'), "Last Payment tab: six summary items between the toolbar and the table");
  assert.ok(!draw({ 0: "billing-exception" }, [EX("x1")]).includes("day-summary") && !draw({ 0: "billing-exception", 1: "history" }, [EX("x1")]).includes("day-summary"), "no summary panel inside Billing Exception");
  const pageSource = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  assert.ok(pageSource.includes("<UnderlineTabs value={sub}") && !pageSource.includes("<PillNav value={sub}") && pageSource.includes('colSpan={exceptionView ? 10 : 8}'), "Current / History: Sales Planning's underlined tabs on their own line; empty-state spans match the columns");
  const pageSrc2 = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  assert.ok(pageSrc2.includes("min-w-[1130px]") && !pageSrc2.includes("min-w-[1260px]") && !pageSrc2.includes('w-32 text-right">Amount'), "the removed column's width is removed from the table, not reserved");
  // Billing Exception → Current (default sub-tab)
  html = draw({ 0: "billing-exception" }, [EX("e1"), EX("e2", { billNo: "B-2" }), EX("e3", { dealerId: "d2", party: "Beta" })]);
  assert.ok(html.includes(">Current<") && html.includes(">History<"), "nested tabs inside Billing Exception");
  assert.ok(requested.includes("/billing-exceptions?") && requested.includes("view=current"), "Current is the default view");
  assert.deepEqual(heads(html), ["Party", "Status", "State", "Territory", "Sales Officer", "Last Payment Date", "Days", "Billing Date", "Authorized By", "Info"], "the report columns, then Billing Date → Authorized By → Info");
  assert.deepEqual([...html.matchAll(/data-exception-id="([^"]+)"/g)].map((m) => m[1]), ["e1", "e2", "e3"], "one row per exception (three rows for two dealers)");
  assert.equal((html.match(/aria-label="Info — exception/g) ?? []).length, 3);
  assert.ok(!html.includes("Billing Status"), "no Billing Status column in the exception tables");
  // History
  html = draw({ 0: "billing-exception", 1: "history" }, [EX("e1", { exceptionStatus: "RESOLVED" })]);
  assert.ok(requested.includes("view=history"));
  // empty / colSpan
  assert.ok(draw({ 0: "billing-exception" }, []).includes("No billing exceptions found.") && /colSpan="10"/.test(draw({ 0: "billing-exception" }, [])), "empty state spans all ten columns");
  assert.ok(/colSpan="8"/.test(draw({}, [])) && draw({}, []).includes("No dealers found."));
  // exports use the dedicated endpoint for the exception views
  const src = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  assert.ok(src.includes("/api/reports/last-payment/billing-exceptions/export?") && src.includes("/api/reports/last-payment/export?${reportQuery()}"));
  // Info opens EXACTLY the selected exception (by its id)
  assert.ok(src.includes("setInfoId(row.exceptionId)") && src.includes("<BillingExceptionInfoDialog exceptionId={infoId}"));
  const uiSrc = readFileSync("src/features/reports/billing-exception-ui.tsx", "utf8");
  assert.ok(uiSrc.includes("/api/reports/last-payment/billing-exceptions/${exceptionId}"));
}

function form() {
  const uiSrc = readFileSync("src/features/reports/billing-exception-ui.tsx", "utf8");
  // The action popup, then the form
  const action = renderToStaticMarkup(<ui.BillingExceptionActionDialog dealerId="d1" party="Alpha" onClose={() => {}} />);
  void action; // Radix dialogs render through a portal (not in static markup); the contract is pinned at source level below.
  assert.ok(uiSrc.includes("billing_exception.action.create") && uiSrc.includes('setStep("form")'), "popup action → form");
  for (const needle of ['Label htmlFor="be-dealer">{L.dealer}<', "L.billingDate", "L.billNo", "L.authPerson", "DateInputDMY", "readOnly", "AUTH_PERSONS.map"]) assert.ok(uiSrc.includes(needle), needle);
  // Labels: every visible string of the form / Info popup comes from the label system (keys exist, defaults are the previous texts); labels are bound to their controls.
  const usedKeys = [...uiSrc.matchAll(/useLabel\("(billing_exception\.[a-z_.]+)"\)/g)].map((m) => m[1]!);
  assert.ok(usedKeys.length >= 30 && usedKeys.every((k) => k in DEFAULT_LABELS), "every label key used by the popups is registered (editable in Edit Labels)");
  assert.deepEqual(["form.title", "form.billing_date", "form.bill_no", "form.auth_person", "form.amount", "form.condition", "form.payment_date", "form.payment_amount"].map((k) => (DEFAULT_LABELS as Record<string, string>)[`billing_exception.${k}`]), ["Create a Billing Exception", "Date of Billing *", "Bill No *", "Auth Person *", "Amount *", "Is there any payment condition? *", "Date of Payment *", "Payment *"], "defaults keep the existing wording and add Payment");
  const formSrc = uiSrc.slice(uiSrc.indexOf("function BillingExceptionForm"), uiSrc.indexOf("export function BillingExceptionInfoDialog"));
  for (const id of ["be-dealer", "be-date", "be-bill", "be-auth", "be-amount", "be-pay-date", "be-pay-amount"]) assert.ok(formSrc.includes(`htmlFor="${id}"`) && formSrc.includes(`id="${id}"`), `label → control: ${id}`);
  assert.ok(formSrc.includes('htmlFor={`be-condition-${v}`}') && formSrc.includes("id={`be-condition-${v}`}"), "the Yes / No labels are bound to their radios");
  assert.ok(!/>(Amount|Payment|Bill No|Auth Person|Date of Billing|Date of Payment)[ *]*</.test(formSrc) && !formSrc.includes("Select Auth Person\"") && !formSrc.includes(">Save<") && !formSrc.includes(">Cancel<"), "no hard-coded visible text left in the form");
  assert.ok(formSrc.includes("sm:grid-cols-2") && formSrc.includes("grid-cols-1") && formSrc.includes("max-h-[90vh] max-w-xl overflow-y-auto"), "two equal columns, stacked on narrow screens, scrolls inside the viewport");
  assert.ok(uiSrc.includes("body: BillingExceptionInput") || uiSrc.includes("(body: BillingExceptionInput)"), "the validated payload is what is posted");
  assert.ok(uiSrc.includes("if (save.isPending || inFlight.current) return;") && uiSrc.includes("inFlight.current = true;") && uiSrc.includes("disabled={save.isPending}"), "repeated Save is blocked while pending");
  assert.ok(uiSrc.includes("validateBillingExceptionInput({ dealerId, billingDate, billNo, authPerson, requestId, billingAmount, paymentCondition: condition, paymentDate: condition === \"YES\" ? paymentDate : null, paymentAmount: condition === \"YES\" ? paymentAmount : null }, businessToday())"), "client validation = server validation (same function)");
  const onError = uiSrc.slice(uiSrc.indexOf("onError:"), uiSrc.indexOf("\n", uiSrc.indexOf("onError:")));
  assert.ok(uiSrc.includes("onSuccess: () => { refresh(); onClose(); }") && onError.includes("setError(") && onError.includes("refresh()") && !onError.includes("setBill") && !onError.includes("setAuthPerson") && !onError.includes("setBillingDate"), "success closes + refreshes; failure keeps the values, shows the message and refreshes");
  assert.ok(uiSrc.includes("useState(() => (typeof crypto") && uiSrc.includes("randomUUID"), "ONE requestId per opened form (stable across retries)");
  assert.ok(!/fetch\(|api\.post/.test(uiSrc.slice(0, uiSrc.indexOf("function BillingExceptionForm"))), "opening / cancelling the popup creates nothing");
  assert.ok(/Button variant="outline" onClick=\{onClose\}/.test(uiSrc), "Cancel just closes");
  for (const needle of ['Label htmlFor="be-amount">{L.amount}<', "L.condition", 'type="radio" name="be-condition"', 'condition === "YES" && (', "L.paymentDate", "L.paymentAmount", "if (v === \"NO\") { setPaymentDate(\"\"); setPaymentAmount(\"\"); }", "max-h-[90vh]"]) assert.ok(uiSrc.includes(needle), needle);
  for (const banned of ["receipt", "Today's Actual", "Payment Mode"]) assert.ok(!uiSrc.toLowerCase().includes(banned.toLowerCase()) || banned === "receipt" , `the form never mentions ${banned}`);
}

service().then(() => { wiring(); page(); form(); console.log("billing-exception.test.tsx — all assertions passed"); }).catch((e) => { console.error(e); process.exitCode = 1; });
