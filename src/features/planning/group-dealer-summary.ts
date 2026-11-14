import { matchesCategoryFilter, type Category } from "@/lib/product-category";
import type { DealerFinancialRow } from "./dealer-financial-summary-table";

export interface DealerProductFinancialRow extends DealerFinancialRow {
  productId: string;
  productName: string;
  nbvPercent: number;
  actualQty: number;
}

export type TerritoryDealerSummary = DealerFinancialRow & {
  products: DealerProductFinancialRow[];
};

export function summarizeTerritoryDealers(
  products: DealerProductFinancialRow[],
  categoryFilter: string,
  categories: Category[],
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
  return [...dealers.values()].sort((a, b) =>
    b.planAmount - a.planAmount || b.actualAmount - a.actualAmount || a.name.localeCompare(b.name),
  );
}
