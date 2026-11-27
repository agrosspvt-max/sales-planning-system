/** BAG is bill evidence only, not a sale/planning product. Match the whole name. */
export function isExcludedSalesProduct(name: string) {
  return name.normalize("NFKC").trim().toUpperCase() === "BAG";
}

/** Hide obsolete BAG review notices without rewriting captured source history. */
export function salesReportingSummary<T>(raw: T): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const summary = raw as Record<string, unknown>;
  const copy = { ...summary };
  if (Array.isArray(summary.pendingProducts))
    copy.pendingProducts = summary.pendingProducts.filter(row =>
      !row || typeof row.name !== "string" || !isExcludedSalesProduct(row.name));
  if (Array.isArray(summary.unmatchedProducts)) {
    copy.unmatchedProducts = summary.unmatchedProducts.map(row =>
      row && Array.isArray(row.stockItems)
        ? { ...row, stockItems: row.stockItems.filter((name: unknown) => typeof name !== "string" || !isExcludedSalesProduct(name)) }
        : row,
    ).filter(row => !row || !Array.isArray(row.stockItems) || row.stockItems.length);
    if (!(copy.unmatchedProducts as unknown[]).length) copy.unmatchedProductLines = 0;
  }
  if (Array.isArray(summary.changes))
    copy.changes = summary.changes.filter(row =>
      !row || typeof row.product !== "string" || !isExcludedSalesProduct(row.product));
  return copy as T;
}
