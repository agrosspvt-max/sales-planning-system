import "server-only";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { getCurrentOwnerByDealer, getOfficerScope } from "@/lib/scope";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { latestReceiptAsOfByDealer } from "@/lib/last-payment.server";
import { currentBusinessDate } from "@/lib/daily-work";
import { buildPage, type Paginated } from "@/lib/pagination";
import {
  DAYBOOK_UPLOAD_AUDIT_ENTITY, DAYBOOK_UPLOAD_AUDIT_PREFIX, applyPaymentAging, applyReportFilters, cascadedFilterOptions, daysSincePayment, matchesParty, pruneReportFilters, sortByDays,
  type LastPaymentReportParams, type LastPaymentReportRow, type ReportFilterable, type ReportFilterOptions, type ReportFilters,
} from "@/lib/last-payment-report";

/**
 * The business date (India calendar date, like the rest of the app) of the most recent SUCCESSFUL Day Book upload, or null when
 * there has been none. Read-only metadata derived from the existing upload records — see DAYBOOK_UPLOAD_AUDIT_*.
 */
export async function loadLastDayBookUpdate(): Promise<string | null> {
  const [audit, imported] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { entity: DAYBOOK_UPLOAD_AUDIT_ENTITY, summary: { startsWith: DAYBOOK_UPLOAD_AUDIT_PREFIX } },
      orderBy: { createdAt: "desc" }, select: { createdAt: true },
    }),
    prisma.lastPaymentImport.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const newest = [audit?.createdAt, imported?.createdAt].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0];
  return newest ? currentBusinessDate(newest) : null;
}

/**
 * Last Payment Report — a read-only, scoped presentation of the SAME Last Payment value Recovery Planning shows.
 *
 *  • Last Payment (date + that receipt's amount): `latestReceiptAsOfByDealer` — the existing, batched source
 *    (legacy per-plan receipts + active Last Payment history → the existing `latestReceiptAsOf` selector). Recovery
 *    asks it "as of the plan month-end"; the report asks "as of today", so the two agree whenever their as-of dates
 *    select the same receipt.
 *  • Party / State / Territory / Sales Officer: the existing master data — the dealer, and its CURRENT owner (open
 *    DealerAssignment). State is the owner's group and Territory the owner's territory, as in every plan list.
 *  • Scope: the caller's existing officer scope, applied in the query and again on each dealer's current owner
 *    (the same rule as the Dealer Tags list). Nothing here accepts an officer/scope parameter.
 */
export async function getLastPaymentReport(
  ctx: AuthContext,
  params: LastPaymentReportParams,
  today: string = currentBusinessDate(),
): Promise<Paginated<LastPaymentReportRow> & { options: ReportFilterOptions; appliedFilters: ReportFilters; lastUpdate: string | null }> {
  const { sorted, options, appliedFilters } = await buildLastPaymentReport(ctx, params, today);
  const start = (params.page - 1) * params.pageSize;
  return { ...buildPage(sorted.slice(start, start + params.pageSize), sorted.length, { page: params.page, pageSize: params.pageSize, search: params.search }), options, appliedFilters, lastUpdate: await loadLastDayBookUpdate() };
}

/**
 * EXPORT: the COMPLETE filtered + sorted result (every matching row, before pagination) with the same Last Update the page
 * shows. It runs the very same pipeline as the page — same scope, search, cascading filters, Payment Aging, Days sort and Last
 * Payment lookup — and only skips the page slice. `params.page` / `pageSize` are ignored.
 */
export async function getLastPaymentReportExport(
  ctx: AuthContext,
  params: LastPaymentReportParams,
  today: string = currentBusinessDate(),
): Promise<{ rows: LastPaymentReportRow[]; lastUpdate: string | null }> {
  const { sorted } = await buildLastPaymentReport(ctx, params, today);
  return { rows: sorted, lastUpdate: await loadLastDayBookUpdate() };
}

/**
 * Dropdown options (and the cleaned selection) for a set of PENDING filter selections — what the filter UI needs while the user is
 * choosing, BEFORE they click Apply. Same authorized rows and the same cascading rules as the report, but no Last Payment lookup
 * and no table rows: it can never return data the report itself would not.
 */
export async function getLastPaymentReportOptions(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<{ options: ReportFilterOptions; appliedFilters: ReportFilters }> {
  const base = await loadAuthorizedRows(ctx);
  const appliedFilters = pruneReportFilters(base, filters);
  return { options: cascadedFilterOptions(base, appliedFilters), appliedFilters };
}

/** The shared pipeline: authorized dealers → filters → Last Payment → Payment Aging → Days sort. NOT paginated. */
async function buildLastPaymentReport(
  ctx: AuthContext,
  params: LastPaymentReportParams,
  today: string,
): Promise<{ sorted: LastPaymentReportRow[]; options: ReportFilterOptions; appliedFilters: ReportFilters }> {
  const base = await loadAuthorizedRows(ctx);
  // CASCADING filters: incompatible selections (State UP → MP leaves Territory LUCKNOW) are dropped, and every dropdown lists only
  // what exists together with the OTHER active filters — all computed from the caller's authorized `base` rows, so no option
  // (or selection) can ever reach outside their scope. `appliedFilters` tells the page what was actually applied.
  const appliedFilters = pruneReportFilters(base, params.filters);
  const options = cascadedFilterOptions(base, appliedFilters);

  // Search (displayed name) AND the four column filters (OR within a column, AND across), all before the receipt
  // lookup so they narrow the work as well.
  const matched = applyReportFilters(base.filter((row) => matchesParty(row.party, params.search)), appliedFilters);
  // Last Payment: one batched lookup of the EXISTING source for the remaining dealers — no per-dealer queries.
  const payments = await latestReceiptAsOfByDealer(matched.map((d) => d.dealerId), new Date(`${today}T00:00:00.000Z`));
  const rows: LastPaymentReportRow[] = matched.map((d) => {
    const payment = payments.get(d.dealerId);
    return {
      dealerId: d.dealerId,
      party: d.party,
      status: d.status,
      state: d.state,
      territory: d.territory,
      salesOfficer: d.salesOfficer,
      lastPaymentDate: payment?.date ?? null,
      amount: payment?.date ? (payment.amount ?? 0) : null,
      days: daysSincePayment(payment?.date, today),
    };
  });

  // Payment Aging filters the derived Days (null Days never matches); sorting is independent of it.
  const sorted = sortByDays(applyPaymentAging(rows, params.paymentAging), params.sort);
  return { sorted, options, appliedFilters };
}

/** The caller's authorized dealers with their master data (alias-preferred name, status, and the CURRENT owner's state / territory / name). */
async function loadAuthorizedRows(ctx: AuthContext): Promise<ReportFilterable[]> {
  const scope = await getOfficerScope(ctx);
  const dealers = await prisma.dealer.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      ...(scope.all ? {} : { assignments: { some: { officerId: { in: scope.ids }, effectiveTo: null } } }),
    },
    select: { id: true, name: true, status: true }, // status = the existing authoritative Dealer.status
  });
  const owners = await getCurrentOwnerByDealer(dealers.map((d) => d.id));
  const visible = dealers.filter((d) => scope.all || scope.ids.includes(owners.get(d.id) ?? ""));

  // Master data for every dealer in SCOPE (alias-preferred name + current owner's name / state / territory): one dealer
  // query, one alias lookup, one officer lookup. Filter options come from this set, so they can never name anything
  // outside the caller's scope, and the filters below only ever narrow it.
  const aliases = await loadDealerAliasNameMap(visible.map((d) => d.id));
  const ownerIds = [...new Set(visible.map((d) => owners.get(d.id)).filter((id): id is string => !!id))];
  const officers = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, territory: true, group: { select: { name: true } } } })
    : [];
  const officerById = new Map(officers.map((o) => [o.id, o]));
  const base: ReportFilterable[] = visible.map((d) => {
    const officerId = owners.get(d.id) ?? null;
    const officer = officerId ? officerById.get(officerId) : undefined;
    return {
      dealerId: d.id,
      party: aliases.get(d.id) ?? d.name,
      status: d.status,
      state: officer?.group?.name ?? null,
      territory: officer?.territory ?? null,
      salesOfficer: officer?.name ?? null,
      salesOfficerId: officer ? officerId : null,
    };
  });
  return base;
}
