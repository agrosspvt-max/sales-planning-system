import { proportionalCreditTotals, type DealerCreditRecord } from "./dealer-credit-adjustments";
import {
  summarizeTerritoryDealers,
  type DealerProductFinancialRow,
  type TerritoryDealerSummary,
} from "./group-dealer-summary";
import { sameSalesMeasure, sumSalesMeasures } from "./dealer-sales-breakdown";
import type { Category } from "@/lib/product-category";
export interface ProductCreditSummary {
  dealers: TerritoryDealerSummary[];
  creditAmount: number | null;
  nbvAdjustment: number | null;
  netSales: number | null;
  netNbv: number | null;
  applied: boolean;
  nbvPending?: boolean;
  reason?: string;
}
const sum = (values: (number | null)[]) =>
  values.some((value) => value === null)
    ? null
    : sumSalesMeasures(values.map((value) => ({ quantity: 0, amount: value! }))).amount;
export function productCreditSummary(
  beforeSales: number,
  beforeNbv: number,
  products: DealerProductFinancialRow[],
  credits: DealerCreditRecord[],
  categoryFilter: string,
  categories: Category[],
): ProductCreditSummary {
  const dealers = summarizeTerritoryDealers(products, categoryFilter, categories, credits);
  const baseSales = dealers.reduce(
    (total, dealer) => total + (dealer.salesBeforeCredits ?? dealer.actualAmount),
    0,
  );
  const baseNbv = dealers.reduce(
    (total, dealer) => total + (dealer.nbvBeforeCredits ?? dealer.actualNbv),
    0,
  );
  const reconciled =
    sameSalesMeasure({ quantity: 0, amount: beforeSales }, { quantity: 0, amount: baseSales }) &&
    sameSalesMeasure({ quantity: 0, amount: beforeNbv }, { quantity: 0, amount: baseNbv });
  if (categoryFilter)
    return {
      dealers,
      creditAmount: 0,
      nbvAdjustment: 0,
      netSales: beforeSales,
      netNbv: beforeNbv,
      applied: false,
      reason: "Credits without products apply only with All Categories selected.",
    };
  if (!reconciled)
    return {
      dealers,
      creditAmount: null,
      nbvAdjustment: null,
      netSales: null,
      netNbv: null,
      applied: true,
      reason:
        "Dealer credit details do not reconcile with these product totals. Refresh this view.",
    };
  const creditAmount = sum(dealers.map((dealer) => dealer.creditAdjustment?.creditAmount ?? null));
  const totals = proportionalCreditTotals(beforeSales, beforeNbv, creditAmount);
  const nbvPending = dealers.some(dealer => dealer.actualNbvAvailable === false && dealer.products.some(product => product.nbvPending));
  if (nbvPending) { totals.netNbv = null; totals.nbvAdjustment = null; }
  return {
    dealers,
    creditAmount,
    nbvPending,
    ...totals,
    applied: true,
    ...(nbvPending ? { reason: "Some product matches need review. Sales are included; NBV is pending until the products are confirmed and Sales is refreshed." } : creditAmount === null || totals.netNbv === null
      ? {
          reason:
            creditAmount === null
              ? "Complete credit-note amounts are unavailable. Open Credit Notes to review dealer amounts or missing Sales history."
              : "Total NBV cannot be adjusted because total sales before these credits are zero.",
        }
      : {}),
  };
}
