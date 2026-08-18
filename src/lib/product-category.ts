/**
 * Client-safe helpers for the Product Category system. A category owns an NBV% (fraction); a product
 * belongs to whichever category's nbvPercent matches its own. Category is therefore a pure function of a
 * product's NBV% — no manual mapping — so badges and filters are derived on the client from nbvPercent.
 */
export interface Category {
  id: string;
  name: string;
  nbvPercent: number | null; // fraction, e.g. 0.35 = 35%
  notation: string | null;
  color: string | null;
}

/** Sentinel filter value for products whose NBV% matches no category. */
export const UNCATEGORIZED = "__uncategorized__";

// Compare NBV% on the Decimal(6,4) integer grid so 0.35 and 0.3500 always match.
const nbvKey = (n: number) => Math.round(n * 10000);

/** The category matching this product NBV% (fraction), or null when none matches. */
export function categoryForNbv(nbvPercent: number | null | undefined, categories: Category[]): Category | null {
  if (nbvPercent == null) return null;
  const key = nbvKey(nbvPercent);
  return categories.find((c) => c.nbvPercent != null && nbvKey(c.nbvPercent) === key) ?? null;
}

/**
 * Whether a product with this NBV% passes the category filter.
 *  - "" (empty)        → All Categories (always true)
 *  - UNCATEGORIZED     → only products matching no category
 *  - a category id     → only products in that category
 */
export function matchesCategoryFilter(nbvPercent: number | null | undefined, filter: string, categories: Category[]): boolean {
  if (!filter) return true;
  const cat = categoryForNbv(nbvPercent, categories);
  if (filter === UNCATEGORIZED) return cat == null;
  return cat?.id === filter;
}
