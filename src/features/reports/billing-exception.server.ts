import "server-only";
import { Role, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getCurrentOwnerByDealer, getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { currentBusinessDate } from "@/lib/daily-work";
import { canCreateBillingException } from "@/features/accounts/permissions";
import { buildPage, type Paginated } from "@/lib/pagination";
import {
  applyAuthByFilter, applyPaymentAging, applyReportFilters, cascadedFilterOptions, matchesParty, pruneReportFilters, sortByDays,
  type LastPaymentReportParams, type ReportFilterable, type ReportFilterOptions, type ReportFilters,
} from "@/lib/last-payment-report";
import {
  BILLING_BLOCK_DAYS, RESOLUTION_PAYMENT_RECEIVED, validateBillingExceptionInput,
  type BillingExceptionDetail, type BillingExceptionRow, type BillingTaskSummary, type ExceptionStatus, type ExceptionView, type PaymentCondition,
  summarizeExceptions, type ExceptionSummary, type SummarySource,
} from "@/lib/billing-exception";
import { alertLabels, notifyBillingExceptionCreated } from "@/features/notifications/task-alerts.server";
import { buildLastPaymentReport, loadAuthorizedRows, loadLastDayBookUpdate, paymentSnapshotByDealer } from "./last-payment-report.server";

/**
 * Billing Exception — records of "this dealer may still be billed although its Days are above 45". INFORMATIONAL: nothing here blocks an invoice or
 * schedules a task. Payment conditions and Recovery / Daily Work / Calendar tasks are deliberately not part of it.
 *
 *  • CREATE: the server re-derives the dealer's Days from the shared Last Payment source (never from the client), requires Days > 45, and writes the
 *    exception + its immutable report snapshot + the audit record in ONE transaction.
 *  • CONCURRENCY with payment updates: creation and reconciliation both take the dealer's row lock (FOR NO KEY UPDATE) before they read Days, hold it until
 *    commit, and read Days AFTER obtaining it. A payment commit that lands first is therefore seen by the creator (stale Save rejected); one that lands
 *    later is followed by a reconciliation that waits for the creator to commit and then resolves the new row. No interleaving leaves a CURRENT exception for
 *    a dealer whose committed Days are 45 or less.
 *  • DUPLICATES: each logical Save carries a requestId; (creator, requestId) is unique. A re-delivery returns the original exception; a deliberate second
 *    exception for the same dealer uses a new requestId and is allowed.
 *  • RECONCILIATION: when a dealer's effective Days is 45 or less, ALL its CURRENT exceptions become RESOLVED (lifecycle only — the snapshot and the row stay).
 *    It is idempotent, per dealer, independent of any report page/filter, and safe to re-run; a failure never undoes the Day Book commit that triggered it.
 */

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;
type Tx = Prisma.TransactionClient;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const money = (v: Prisma.Decimal | number | null) => (v === null ? null : Number(v));

/**
 * Creating is restricted to Super Admin and to a Custom Admin (Account Management account) explicitly granted Last Payment Report read + create. SO, RM and every
 * other role are denied by default. Runs FIRST — before validation, any read of the exception table and the duplicate-request path — so a revoked or never-granted
 * account gets 403 even when re-sending an earlier, previously authorized request.
 */
function assertCanCreate(ctx: AuthContext): void {
  if (!canCreateBillingException(ctx)) throw new ApiError(403, "You do not have permission to create a Billing Exception");
}

/** The dealers whose exceptions the caller may see: null = every dealer (administrative scope), otherwise those CURRENTLY owned by an officer in scope. */
async function scopedDealerIds(ctx: AuthContext): Promise<string[] | null> {
  const scope = await getOfficerScope(ctx);
  if (scope.all) return null;
  const assigned = await prisma.dealerAssignment.findMany({ where: { officerId: { in: scope.ids }, effectiveTo: null }, select: { dealerId: true } });
  const ids = [...new Set(assigned.map((a) => a.dealerId))];
  const owners = await getCurrentOwnerByDealer(ids);
  return ids.filter((id) => scope.ids.includes(owners.get(id) ?? ""));
}

const lockDealer = (tx: Tx, dealerId: string) => tx.$queryRaw`SELECT "id" FROM "Dealer" WHERE "id" = ${dealerId} FOR NO KEY UPDATE`;

const DETAIL_INCLUDE = { createdBy: { select: { name: true } }, task: { include: { officer: { select: { name: true } } } } } as const;
type ExceptionRecord = Prisma.BillingExceptionGetPayload<{ include: typeof DETAIL_INCLUDE }>;
const conditionOf = (v: boolean | null): PaymentCondition | null => (v === null ? null : v ? "YES" : "NO");
function taskSummary(t: NonNullable<ExceptionRecord["task"]>, today: string): BillingTaskSummary {
  return {
    id: t.id, officerName: t.officer.name, amount: Number(t.amount), promisedDate: isoDay(t.promisedDate), taskDate: isoDay(t.taskDate), rescheduled: t.rescheduled,
    status: t.dailyWorkEntryId ? "IN_DAILY_WORK" : isoDay(t.taskDate) < today ? "OVERDUE" : "SCHEDULED", confirmed: t.dailyWorkConfirmed,
  };
}
function toDetail(r: ExceptionRecord, today: string = currentBusinessDate()): BillingExceptionDetail {
  return {
    id: r.id, dealerId: r.dealerId, party: r.snapParty, billingDate: isoDay(r.billingDate), billNo: r.billNo, authPerson: r.authPerson,
    createdAt: r.createdAt.toISOString(), createdByName: r.createdBy.name, exceptionStatus: r.status as ExceptionStatus,
    resolvedAt: r.resolvedAt?.toISOString() ?? null, resolutionReason: r.resolutionReason, resolvedDays: r.resolvedDays,
    billingAmount: money(r.billingAmount), paymentCondition: conditionOf(r.paymentCondition), paymentDate: r.paymentDate ? isoDay(r.paymentDate) : null, paymentAmount: money(r.paymentAmount),
    task: r.task ? taskSummary(r.task, today) : null,
    snapshot: { days: r.snapDays, lastPaymentDate: r.snapLastPaymentDate ? isoDay(r.snapLastPaymentDate) : null, amount: money(r.snapAmount), status: r.snapDealerStatus, state: r.snapState, territory: r.snapTerritory, salesOfficer: r.snapSalesOfficer },
  };
}

/* ------------------------------------------------ create ------------------------------------------------ */

export async function createBillingException(ctx: AuthContext, raw: unknown, today: string = currentBusinessDate()): Promise<BillingExceptionDetail & { duplicate: boolean }> {
  assertCanCreate(ctx);
  const parsed = validateBillingExceptionInput(raw, today); // the promised date is checked against the Daily Work business date
  if ("error" in parsed) throw new ApiError(422, parsed.error);
  const input = parsed.value;
  // Scope + the master data to snapshot: the caller's authorized report rows (a dealer outside scope looks missing — ids cannot be probed).
  const [dealer] = await loadAuthorizedRows(ctx, [input.dealerId]);
  if (!dealer) throw new ApiError(404, "Dealer not found");

  const labels = await alertLabels(); // Edit Labels text for the alert, read before the transaction
  const result = await prisma.$transaction(async (tx) => {
    await lockDealer(tx, dealer.dealerId);
    // A re-delivery of the SAME Save returns what was saved, even if the dealer has since become Open.
    const existing = await tx.billingException.findUnique({ where: { createdById_requestId: { createdById: ctx.userId, requestId: input.requestId } }, include: DETAIL_INCLUDE });
    if (existing) {
      if (existing.dealerId !== dealer.dealerId || isoDay(existing.billingDate) !== input.billingDate || existing.billNo !== input.billNo || existing.authPerson !== input.authPerson
        || money(existing.billingAmount) !== input.billingAmount || conditionOf(existing.paymentCondition) !== input.paymentCondition || (existing.paymentDate ? isoDay(existing.paymentDate) : null) !== input.paymentDate
        || money(existing.paymentAmount) !== input.paymentAmount)
        throw new ApiError(409, "This request identity was already used for a different exception. Close the form and try again.");
      return { row: existing, duplicate: true };
    }
    // Days are derived HERE, inside the lock, from the shared source — the client's view of the report is irrelevant.
    const payment = (await paymentSnapshotByDealer([dealer.dealerId], today, tx)).get(dealer.dealerId)!;
    if (payment.days === null) throw new ApiError(409, "This dealer has no payment date, so a Billing Exception does not apply.");
    if (payment.days <= BILLING_BLOCK_DAYS) throw new ApiError(409, `This dealer's Days are now ${payment.days} (${BILLING_BLOCK_DAYS} or less) after a payment update, so it is Open and no Billing Exception is needed. The report has been refreshed.`);
    // Yes → the responsible Sales Officer is the dealer's AUTHORITATIVE current assignment, resolved here from the database (a client-supplied officer is never read).
    // No valid owner ⇒ a clear error and the whole transaction rolls back: no exception without its promised task.
    let officerId: string | null = null;
    if (input.paymentCondition === "YES") {
      const owner = (await getCurrentOwnerByDealer([dealer.dealerId], tx)).get(dealer.dealerId);
      const user = owner ? await tx.user.findUnique({ where: { id: owner }, select: { id: true, role: true, isActive: true, deletedAt: true } }) : null;
      if (!user || !user.isActive || user.deletedAt || (user.role !== Role.SALES_OFFICER && user.role !== Role.REGIONAL_MANAGER))
        throw new ApiError(422, "This dealer has no valid Sales Officer assignment, so its Recovery task cannot be created. Assign a Sales Officer first, or answer No to the payment condition.");
      officerId = user.id;
    }
    const row = await tx.billingException.create({
      data: {
        dealerId: dealer.dealerId, billingDate: new Date(`${input.billingDate}T00:00:00Z`), billNo: input.billNo, authPerson: input.authPerson,
        createdById: ctx.userId, requestId: input.requestId,
        snapDays: payment.days, snapLastPaymentDate: payment.date ? new Date(`${payment.date}T00:00:00Z`) : null, snapAmount: payment.amount,
        snapParty: dealer.party, snapDealerStatus: dealer.status, snapState: dealer.state, snapTerritory: dealer.territory, snapSalesOfficer: dealer.salesOfficer, snapSalesOfficerId: dealer.salesOfficerId,
        billingAmount: input.billingAmount, paymentCondition: input.paymentCondition === "YES", paymentDate: input.paymentDate ? new Date(`${input.paymentDate}T00:00:00Z`) : null, paymentAmount: input.paymentAmount,
        // One Recovery task per exception (unique), scheduled for the promised date — created in the SAME statement-chain / transaction.
        ...(officerId ? { task: { create: { dealerId: dealer.dealerId, officerId, amount: input.paymentAmount!, promisedDate: new Date(`${input.paymentDate}T00:00:00Z`), taskDate: new Date(`${input.paymentDate}T00:00:00Z`) } } } : {}),
      },
      include: DETAIL_INCLUDE,
    });
    await writeAudit({
      userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "billingException", entityId: row.id,
      summary: `Billing Exception · ${dealer.party} · Bill ${input.billNo} · ${input.authPerson} · Days ${payment.days} · Amount ${input.billingAmount} · Payment condition ${input.paymentCondition}${input.paymentDate ? ` (promised ${input.paymentAmount} on ${input.paymentDate}, Recovery task for officer ${officerId})` : ""}`,
    }, tx);
    // The alert is written in the SAME transaction as the exception (and its task), only for a NEW save: a retried / double-clicked Save returned above, so it never alerts twice.
    await notifyBillingExceptionCreated(tx, labels, {
      exceptionId: row.id, dealerId: dealer.dealerId, dealerName: dealer.party, billNo: input.billNo, billingDate: input.billingDate, billingAmount: input.billingAmount,
      authPerson: input.authPerson, paymentCondition: input.paymentCondition === "YES", paymentDate: input.paymentDate, paymentAmount: input.paymentAmount, taskOfficerId: officerId,
    });
    return { row, duplicate: false };
  }, TX_OPTIONS);
  return { ...toDetail(result.row, today), duplicate: result.duplicate };
}

/* ------------------------------------------------ reads ------------------------------------------------ */

export async function getBillingExceptionDetail(ctx: AuthContext, id: string): Promise<BillingExceptionDetail> {
  const row = await prisma.billingException.findUnique({ where: { id }, include: DETAIL_INCLUDE });
  const visible = row ? await scopedDealerIds(ctx) : null;
  // Access follows the dealer's CURRENT owner (never the snapshot's); an exception outside scope looks missing.
  if (!row || (visible !== null && !visible.includes(row.dealerId))) throw new ApiError(404, "Billing Exception not found");
  return toDetail(row);
}

export type ExceptionPage = Paginated<BillingExceptionRow> & { options: ReportFilterOptions; appliedFilters: ReportFilters; lastUpdate: string | null; summary: ExceptionSummary };
interface ExceptionRecordLite { id: string; dealerId: string; billingDate: Date; billNo: string; authPerson: string; status: string; createdAt: Date; billingAmount: Prisma.Decimal | null; paymentCondition: boolean | null; paymentDate: Date | null; paymentAmount: Prisma.Decimal | null; snapDays: number | null }
const rowOf = (e: ExceptionRecordLite, v: { party: string; status: string; state: string | null; territory: string | null; salesOfficer: string | null; lastPaymentDate: string | null; amount: number | null; days: number | null }): BillingExceptionRow => ({
  exceptionId: e.id, dealerId: e.dealerId, ...v, billingDate: isoDay(e.billingDate), billNo: e.billNo, authPerson: e.authPerson, exceptionStatus: e.status as ExceptionStatus, createdAt: e.createdAt.toISOString(),
  billingAmount: money(e.billingAmount), paymentCondition: conditionOf(e.paymentCondition), paymentDate: e.paymentDate ? isoDay(e.paymentDate) : null, paymentAmount: money(e.paymentAmount), frozenDays: e.snapDays,
});
const LITE = { id: true, dealerId: true, billingDate: true, billNo: true, authPerson: true, status: true, createdAt: true, billingAmount: true, paymentCondition: true, paymentDate: true, paymentAmount: true, snapDays: true } as const;
const newestFirst = (a: ExceptionRecordLite, b: ExceptionRecordLite) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

/** Every row of the view (filtered + sorted, NOT paginated). Current = live report values; History = the stored snapshots. */
async function exceptionRows(ctx: AuthContext, view: ExceptionView, rawParams: LastPaymentReportParams, today: string): Promise<{ rows: BillingExceptionRow[]; options: ReportFilterOptions; appliedFilters: ReportFilters; summary: ExceptionSummary }> {
  // The Billing Status header filter belongs to the Last Payment tab only: the exception views never apply (or echo) it.
  const { billing: _billing, ...otherFilters } = rawParams.filters; // eslint-disable-line @typescript-eslint/no-unused-vars
  const params: LastPaymentReportParams = { ...rawParams, filters: otherFilters, dayBucket: null }; // the day summary is a Last Payment tab feature
  const visible = await scopedDealerIds(ctx);
  if (view === "history") {
    const records = await prisma.billingException.findMany({ where: visible === null ? {} : { dealerId: { in: visible } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const base: (ReportFilterable & { record: (typeof records)[number] })[] = records.map((r) => ({
      dealerId: r.dealerId, party: r.snapParty, status: r.snapDealerStatus, state: r.snapState, territory: r.snapTerritory, salesOfficer: r.snapSalesOfficer, salesOfficerId: r.snapSalesOfficerId, record: r,
    }));
    const appliedFilters = pruneReportFilters(base, params.filters);
    const options = cascadedFilterOptions(base, appliedFilters);
    const matched = applyReportFilters(base.filter((b) => matchesParty(b.party, params.search)), appliedFilters);
    const rows = matched.map((b) => rowOf(b.record, { party: b.party, status: b.status, state: b.state, territory: b.territory, salesOfficer: b.salesOfficer, lastPaymentDate: b.record.snapLastPaymentDate ? isoDay(b.record.snapLastPaymentDate) : null, amount: money(b.record.snapAmount), days: b.record.snapDays }));
    const final = sortByDays(applyPaymentAging(applyAuthByFilter(rows, params.filters), params.paymentAging), params.sort);
    // Summary over the COMPLETE filtered set (before paging). The Sales Officer is the one stored with each exception's snapshot — the same one its row and the Sales Officer filter use.
    const officerByException = new Map(matched.map((b) => [b.record.id, { id: b.salesOfficerId ?? null, name: b.salesOfficer }]));
    return { rows: final, options, appliedFilters, summary: summarizeExceptions(final.map((r): SummarySource => ({ exceptionId: r.exceptionId, dealerId: r.dealerId, party: r.party, officerId: officerByException.get(r.exceptionId)?.id ?? null, officerName: r.salesOfficer, billingAmount: r.billingAmount }))) };
  }
  const current = await prisma.billingException.findMany({ where: { status: "CURRENT", ...(visible === null ? {} : { dealerId: { in: visible } }) }, select: LITE, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const dealerIds = [...new Set(current.map((c) => c.dealerId))];
  // The SAME report pipeline (scope, search, cascading filters, Payment Aging, Last Payment source) over just these dealers.
  const { sorted, options, appliedFilters, officerIdByDealer } = await buildLastPaymentReport(ctx, params, today, dealerIds);
  const byDealer = new Map<string, ExceptionRecordLite[]>();
  for (const c of current) byDealer.set(c.dealerId, [...(byDealer.get(c.dealerId) ?? []), c]);
  const rows: BillingExceptionRow[] = [];
  const stale: string[] = [];
  for (const r of sorted) {
    // An exception only counts while Days > 45; a row whose payment update has not been reconciled yet is hidden and queued for resolution.
    if (r.days === null || r.days <= BILLING_BLOCK_DAYS) { if (r.days !== null) stale.push(r.dealerId); continue; }
    for (const e of (byDealer.get(r.dealerId) ?? []).sort(newestFirst)) rows.push(rowOf(e, { party: r.party, status: r.status, state: r.state, territory: r.territory, salesOfficer: r.salesOfficer, lastPaymentDate: r.lastPaymentDate, amount: r.amount, days: r.days }));
  }
  if (stale.length) void reconcileBillingExceptions({ dealerIds: stale, today, actor: { userId: ctx.userId, designation: ctx.designation } }).catch(() => undefined); // best effort: reads stay correct without it
  const final = applyAuthByFilter(rows, params.filters); // before pagination / export
  // Summary over the COMPLETE filtered set: the dealer's CURRENT Sales Officer (id) — the same association as the row's Sales Officer column and filter.
  const summary = summarizeExceptions(final.map((r): SummarySource => ({ exceptionId: r.exceptionId, dealerId: r.dealerId, party: r.party, officerId: officerIdByDealer.get(r.dealerId) ?? null, officerName: r.salesOfficer, billingAmount: r.billingAmount })));
  return { rows: final, options, appliedFilters, summary };
}

export async function listBillingExceptions(ctx: AuthContext, view: ExceptionView, params: LastPaymentReportParams, today: string = currentBusinessDate()): Promise<ExceptionPage> {
  const { rows, options, appliedFilters, summary } = await exceptionRows(ctx, view, params, today);
  const start = (params.page - 1) * params.pageSize;
  return { summary, ...buildPage(rows.slice(start, start + params.pageSize), rows.length, { page: params.page, pageSize: params.pageSize, search: params.search }), options, appliedFilters, lastUpdate: await loadLastDayBookUpdate() };
}
/** EXPORT: the COMPLETE filtered + sorted result of the view (History from the stored snapshots). */
export async function listBillingExceptionsExport(ctx: AuthContext, view: ExceptionView, params: LastPaymentReportParams, today: string = currentBusinessDate()): Promise<{ rows: BillingExceptionRow[]; lastUpdate: string | null }> {
  return { rows: (await exceptionRows(ctx, view, params, today)).rows, lastUpdate: await loadLastDayBookUpdate() };
}
/** Dropdown options (and the cleaned selection) for pending filter selections — same authorized rows as the view. */
export async function listBillingExceptionOptions(ctx: AuthContext, view: ExceptionView, filters: ReportFilters, today: string = currentBusinessDate()): Promise<{ options: ReportFilterOptions; appliedFilters: ReportFilters }> {
  const { options, appliedFilters } = await exceptionRows(ctx, view, { search: "", sort: "days_desc", page: 1, pageSize: 1, filters, paymentAging: null, dayBucket: null }, today);
  return { options, appliedFilters };
}

/* ------------------------------------------------ reconciliation ------------------------------------------------ */

export interface ReconcileResult { checked: number; resolved: number; failed: number }
/**
 * Resolve every CURRENT exception of each dealer whose effective Days is 45 or less. `dealerIds` narrows the sweep; without it every dealer that has a
 * current exception is checked (so it never depends on which dealers the uploader or any report page could see). Per dealer, in its own short transaction:
 * dealer lock → Days from the shared source → compare-and-set status CURRENT → RESOLVED. Re-running changes nothing; a failed dealer is counted and
 * retried by the next run. Days = null (no payment) is not "paid", so it never resolves.
 */
export async function reconcileBillingExceptions(opts: { dealerIds?: string[]; today?: string; actor: { userId: string; designation?: string | null } }): Promise<ReconcileResult> {
  const today = opts.today ?? currentBusinessDate();
  const candidates = await prisma.billingException.findMany({ where: { status: "CURRENT", ...(opts.dealerIds ? { dealerId: { in: opts.dealerIds } } : {}) }, select: { dealerId: true }, distinct: ["dealerId"] });
  const result: ReconcileResult = { checked: candidates.length, resolved: 0, failed: 0 };
  for (const { dealerId } of candidates) {
    try {
      result.resolved += await prisma.$transaction(async (tx) => {
        await lockDealer(tx, dealerId);
        const payment = (await paymentSnapshotByDealer([dealerId], today, tx)).get(dealerId)!;
        if (payment.days === null || payment.days > BILLING_BLOCK_DAYS) return 0;
        const done = await tx.billingException.updateMany({
          where: { dealerId, status: "CURRENT" },
          data: { status: "RESOLVED", resolvedAt: new Date(), resolutionReason: RESOLUTION_PAYMENT_RECEIVED, resolvedDays: payment.days },
        });
        if (done.count > 0) await writeAudit({ userId: opts.actor.userId, actorDesignation: opts.actor.designation, action: "UPDATE", entity: "billingException", entityId: dealerId, summary: `Billing Exception resolved · ${done.count} exception(s) · dealer Days now ${payment.days}` }, tx);
        return done.count;
      }, TX_OPTIONS);
    } catch (error) {
      result.failed += 1;
      console.error("[billing-exception] reconciliation failed for a dealer", error instanceof Error ? error.name : "Unknown error");
    }
  }
  return result;
}

/**
 * Called AFTER a Day Book commit has fully succeeded. Never throws and never touches the financial commit: a problem becomes a warning the uploader can
 * act on (the next upload, the next report read or the next reconciliation resolves what was missed).
 */
export async function reconcileBillingExceptionsSafely(actor: { userId: string; designation?: string | null }): Promise<string | undefined> {
  try {
    const result = await reconcileBillingExceptions({ actor });
    if (result.failed > 0) return "The Day Book was saved, but some Billing Exceptions could not be re-checked against the new payments. They will be re-checked on the next upload or report refresh.";
  } catch (error) {
    console.error("[billing-exception] reconciliation could not run", error instanceof Error ? error.name : "Unknown error");
    return "The Day Book was saved, but Billing Exceptions could not be re-checked against the new payments. They will be re-checked on the next upload or report refresh.";
  }
  return undefined;
}
