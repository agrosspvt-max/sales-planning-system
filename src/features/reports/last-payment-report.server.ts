import "server-only";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { getCurrentOwnerByDealer, getOfficerScope } from "@/lib/scope";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { latestReceiptAsOfByDealer } from "@/lib/last-payment.server";
import { currentBusinessDate } from "@/lib/daily-work";
import { buildPage, type Paginated } from "@/lib/pagination";
import {
  applyPaymentAging, applyReportFilters, daysSincePayment, matchesParty, reportFilterOptions, sortByDays,
  type LastPaymentReportParams, type LastPaymentReportRow, type ReportFilterable, type ReportFilterOptions,
} from "@/lib/last-payment-report";

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
): Promise<Paginated<LastPaymentReportRow> & { options: ReportFilterOptions }> {
  const scope = await getOfficerScope(ctx);
  const dealers = await prisma.dealer.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      ...(scope.all ? {} : { assignments: { some: { officerId: { in: scope.ids }, effectiveTo: null } } }),
    },
    select: { id: true, name: true },
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
      state: officer?.group?.name ?? null,
      territory: officer?.territory ?? null,
      salesOfficer: officer?.name ?? null,
      salesOfficerId: officer ? officerId : null,
    };
  });
  const options = reportFilterOptions(base);

  // Search (displayed name) AND the four column filters (OR within a column, AND across), all before the receipt
  // lookup so they narrow the work as well.
  const matched = applyReportFilters(base.filter((row) => matchesParty(row.party, params.search)), params.filters);

  // Last Payment: one batched lookup of the EXISTING source for the remaining dealers — no per-dealer queries.
  const payments = await latestReceiptAsOfByDealer(matched.map((d) => d.dealerId), new Date(`${today}T00:00:00.000Z`));
  const rows: LastPaymentReportRow[] = matched.map((d) => {
    const payment = payments.get(d.dealerId);
    return {
      dealerId: d.dealerId,
      party: d.party,
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
  const start = (params.page - 1) * params.pageSize;
  return { ...buildPage(sorted.slice(start, start + params.pageSize), sorted.length, { page: params.page, pageSize: params.pageSize, search: params.search }), options };
}
