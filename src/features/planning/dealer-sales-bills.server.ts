import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { loadProductResolver } from "@/lib/product-resolver";
import { salesPartyNames } from "@/features/tally/sales-party-names";
import { cleanProductName } from "@/features/sales-upload/parser";
import { getGroupProductPlan, type GroupPlanFilter } from "./group-plan.server";
import type { DealerSalesBills } from "./dealer-sales-bills";
import { dealerSalesBreakdown } from "./dealer-sales-breakdown";
import { recordedCreditAmount } from "./dealer-credit-adjustments";

const reviewSummary = z.object({ held: z.array(z.object({ dealerId: z.string() })).optional() });

export async function getDealerSalesBills(
  ctx: AuthContext,
  groupId: string,
  seasonId: string,
  dealerId: string,
  filter: GroupPlanFilter,
): Promise<DealerSalesBills> {
  if (!dealerId || dealerId.length > 128) throw new ApiError(422, "A valid dealer is required");
  // This enforces role/group/current ownership AND the actual report's monthly approval filters.
  const report = await getGroupProductPlan(
    ctx,
    groupId,
    seasonId,
    { ...filter, groupBy: "dealer" },
    dealerId,
  );
  const scope = report.dealerBillScope ?? [];
  const expected = (report.dealerProducts ?? []).filter((row) => row.dealerId === dealerId);
  if (!scope.length)
    return {
      bills: [],
      heldMonths: [],
      productBreakdown: dealerSalesBreakdown([], expected, [], false),
      breakdownAvailable: false,
    };
  const snapshots = await prisma.tallySalesSnapshot.findMany({
    where: { id: { in: scope.map((s) => s.snapshotId) } },
    select: { id: true, monthKey: true, summary: true },
  });
  const [dealers, aliases, resolver] = await Promise.all([
    prisma.dealer.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { tallyName: true, systemDealerId: true } }),
    loadProductResolver(),
  ]);
  const names = salesPartyNames(dealers, aliases, true)
    .filter((entry) => entry.dealerIds.length === 1 && entry.dealerIds[0] === dealerId)
    .map((entry) => entry.name);
  const heldMonths = snapshots
    .filter((snapshot) => {
      const review = reviewSummary.safeParse(snapshot.summary);
      return review.success && review.data.held?.some((row) => row.dealerId === dealerId);
    })
    .map((snapshot) => snapshot.monthKey);
  const vouchers = names.length
    ? await prisma.tallySalesVoucher.findMany({
        where: { snapshotId: { in: scope.map((s) => s.snapshotId) }, partyName: { in: names } },
        orderBy: [{ billDate: "desc" }, { billNumber: "asc" }, { guid: "asc" }],
        select: {
          id: true,
          guid: true,
          billDate: true,
          billNumber: true,
          typeName: true,
          family: true,
          cancelled: true,
          optional: true,
          partyName: true,
          ledgerEntries: true,
          items: {
            orderBy: { lineNo: "asc" },
            select: { lineNo: true, stockItemName: true, quantity: true, amount: true, unit: true },
          },
        },
      })
    : [];
  const bills = vouchers.map((v) => ({
    id: v.id,
    guid: v.guid,
    date: v.billDate,
    number: v.billNumber,
    type: v.typeName,
    family: v.family,
    cancelled: v.cancelled,
    optional: v.optional,
    unallocatedAmount:
      v.family === "Credit Note" && !v.items.length
        ? recordedCreditAmount(v.partyName, v.ledgerEntries)
        : undefined,
    items: v.items.map((item) => {
      const original = resolver.resolveProductUnique(cleanProductName(item.stockItemName));
      return {
        lineNo: item.lineNo,
        productName: item.stockItemName,
        productId: original?.id ?? null,
        quantity: Number(item.quantity),
        amount: Number(item.amount),
        unit: item.unit,
      };
    }),
  }));
  return {
    heldMonths,
    bills,
    breakdownAvailable: !heldMonths.length && !report.dealerBillHistoryIncomplete,
    productBreakdown: dealerSalesBreakdown(
      bills,
      expected,
      heldMonths,
      !report.dealerBillHistoryIncomplete,
    ),
  };
}
