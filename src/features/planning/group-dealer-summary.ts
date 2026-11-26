import { matchesCategoryFilter, type Category } from "@/lib/product-category";
import type { DealerFinancialRow } from "./dealer-financial-summary-table";
import {
  dealerCreditAdjustment,
  type DealerCreditRecord,
  type DealerCreditAdjustment,
} from "./dealer-credit-adjustments";

export interface DealerProductFinancialRow extends DealerFinancialRow {
  productId: string;
  productName: string;
  nbvPercent: number;
  actualQty: number;
}

export type TerritoryDealerSummary = DealerFinancialRow & {
  products: DealerProductFinancialRow[];
  salesBeforeCredits?: number;
  nbvBeforeCredits?: number;
  creditAdjustment?: DealerCreditAdjustment;
};

export function summarizeTerritoryDealers(
  products: DealerProductFinancialRow[],
  categoryFilter: string,
  categories: Category[],
  credits?: DealerCreditRecord[],
): TerritoryDealerSummary[] {
  const dealers = new Map<string, TerritoryDealerSummary>();
  for (const product of products) {
    if (!matchesCategoryFilter(product.nbvPercent, categoryFilter, categories)) continue;
    const row = dealers.get(product.dealerId);
    if (!row) {
      dealers.set(product.dealerId, {
        dealerId: product.dealerId,
        name: product.name,
        planAmount: product.planAmount,
        planNbv: product.planNbv,
        actualAmount: product.actualAmount,
        actualNbv: product.actualNbv,
        products: [product],
      });
      continue;
    }
    row.planAmount += product.planAmount;
    row.planNbv += product.planNbv;
    row.actualAmount += product.actualAmount;
    row.actualNbv += product.actualNbv;
    row.products.push(product);
  }
  if (credits) {
    const byDealer = new Map(credits.map((record) => [record.dealerId, record]));
    if (!categoryFilter)
      for (const record of credits)
        if (record.notes.length && !dealers.has(record.dealerId))
          dealers.set(record.dealerId, {
            dealerId: record.dealerId,
            name: record.name,
            planAmount: 0,
            planNbv: 0,
            actualAmount: 0,
            actualNbv: 0,
            products: [],
          });
    for (const row of dealers.values()) {
      row.salesBeforeCredits = row.actualAmount;
      row.nbvBeforeCredits = row.actualNbv;
      const adjustment = dealerCreditAdjustment(
        row.actualAmount,
        row.actualNbv,
        byDealer.get(row.dealerId) ?? { notes: [], unavailable: false },
        !!categoryFilter,
      );
      row.creditAdjustment = adjustment;
      if (adjustment.netSales === null) row.actualSalesAvailable = false;
      else row.actualAmount = adjustment.netSales;
      if (adjustment.netNbv === null) row.actualNbvAvailable = false;
      else row.actualNbv = adjustment.netNbv;
    }
  }
  return [...dealers.values()].sort(
    (a, b) =>
      b.planAmount - a.planAmount ||
      b.actualAmount - a.actualAmount ||
      a.name.localeCompare(b.name),
  );
}
