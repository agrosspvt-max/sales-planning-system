/**
 * Product-rate billing — pure logic (no React, no Prisma) shared by SO conversion and Admin Verify. Product
 * Quantity Based supplies a committed quantity; Options Value Based supplies a monetary target instead.
 *
 *   SO product qty (committed/reconciled for Quantity Based; freely entered for Value Based)
 *     → distributed across bills (planned, per product)
 *       → Admin verifies the ACTUAL qty per bill/product
 *         → amount = qty × HISTORICAL preset product rate  (never re-typed)
 *           → verified bill amount = Σ product amounts      → installment base
 *
 * Rates are always passed IN (snapshotted at conversion), so later Scheme Master edits cannot change a
 * historical plan's financial meaning. This module only computes; persistence lives in the server layer.
 */

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 1000) / 1000;

/** A product's snapshotted per-unit rates. */
export interface ProductRate {
  productId: string;
  rateWithoutGST: number;
  rateWithGST: number;
}

export interface Amounts {
  withoutGST: number;
  withGST: number;
}

/** amount = qty × rate (both GST variants), 2-dp rounded. Negative qty clamps to 0 amounts (validation
 *  reports the error separately). */
export function productAmounts(qty: number, rate: Pick<ProductRate, "rateWithoutGST" | "rateWithGST">): Amounts {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 0;
  return { withoutGST: round2(q * rate.rateWithoutGST), withGST: round2(q * rate.rateWithGST) };
}

/**
 * The final (reconciliation) bill's quantity for ONE product = committed − Σ(earlier bills). `earlier` holds
 * the first (billCount − 1) bill quantities; the last bill is never entered by hand. Returns the remainder
 * (may be negative → the earlier bills over-allocated; `validateSoAllocation` reports that).
 */
export function finalBillRemainder(committedQty: number, earlier: number[]): number {
  return round3(committedQty - earlier.reduce((s, q) => s + (Number.isFinite(q) ? q : 0), 0));
}

/**
 * Resolve one product's SO bill quantities. `entered` = the manually entered EARLIER bills (length
 * billCount − 1, or empty for a single bill); the final bill is the auto remainder. billCount = 1 ⇒ the sole
 * bill takes the whole committed qty. Returns every bill's quantity in order.
 */
export function resolveSoBillQuantities(committedQty: number, entered: number[], billCount: number): number[] {
  if (billCount <= 1) return [round3(committedQty)];
  const earlier = entered.slice(0, billCount - 1).map((q) => (Number.isFinite(q) ? q : 0));
  while (earlier.length < billCount - 1) earlier.push(0);
  return [...earlier.map(round3), finalBillRemainder(committedQty, earlier)];
}

/**
 * Validate an SO allocation for one product against its committed quantity:
 *   - no negative bill quantity,
 *   - no running total exceeding committed (so the final remainder is never negative),
 *   - the resolved bills sum exactly to committed.
 * `billQuantities` is the FULL per-bill list (including the resolved final bill).
 */
export function validateSoAllocation(committedQty: number, billQuantities: number[]): string | null {
  if (billQuantities.some((q) => !Number.isFinite(q) || q < 0)) return "Bill quantity cannot be negative.";
  let running = 0;
  for (const q of billQuantities) {
    running = round3(running + q);
    if (running > round3(committedQty)) return `Bill quantities exceed the committed quantity of ${round3(committedQty)}.`;
  }
  if (round3(running) !== round3(committedQty)) return `Bill quantities must total the committed quantity of ${round3(committedQty)}.`;
  return null;
}

/**
 * Validate an Admin ACTUAL quantity: non-negative and numeric. Admin actual MAY differ from (even exceed) the
 * SO/committed quantity per the existing override model, so no upper cap is enforced here.
 */
export function validateAdminQuantity(qty: number): string | null {
  if (!Number.isFinite(qty) || qty < 0) return "Actual quantity cannot be negative.";
  return null;
}

/** One product's line within one bill: its quantity and (snapshotted) rate. */
export interface BillProductLine {
  rate: Pick<ProductRate, "rateWithoutGST" | "rateWithGST">;
  quantity: number;
}

/** Total one bill across its product lines: Σ(qty × rate) for both GST variants. */
export function billTotals(lines: BillProductLine[]): Amounts {
  return lines.reduce<Amounts>(
    (acc, l) => {
      const a = productAmounts(l.quantity, l.rate);
      return { withoutGST: round2(acc.withoutGST + a.withoutGST), withGST: round2(acc.withGST + a.withGST) };
    },
    { withoutGST: 0, withGST: 0 },
  );
}

export interface CommittedRate {
  productId: string;
  /** Null for Value Based billing: quantity is entered freely and completion is validated against money. */
  committedQty: number | null;
  rateWithoutGST: number;
  rateWithGST: number;
}
export interface BillWithProducts {
  partNumber: number;
  products?: { productId: string; qty: number }[];
}
export interface ProductQuantityBillResult {
  /** Per-bill computed amounts, keyed by partNumber. */
  billAmounts: Map<number, Amounts>;
  /** Combined total across all bills. */
  total: Amounts;
  /** Validation errors (empty ⇒ valid). */
  errors: string[];
}

/**
 * Compute each bill's amounts from its per-product quantities × the committed snapshot rates, and validate.
 * `side` = "so" enforces the committed-quantity reconciliation (Σ qty per product === committed, no negative,
 * no over-allocation); "admin" allows any non-negative actual quantity (may differ from / exceed committed).
 * Unknown products (not in `committed`) are an error. This is the single source of the billing math for both
 * the SO conversion and the Admin verification server paths.
 */
export function computeProductQuantityBills(
  bills: BillWithProducts[],
  committed: CommittedRate[],
  side: "so" | "admin",
): ProductQuantityBillResult {
  const rateBy = new Map(committed.map((c) => [c.productId, c]));
  const errors: string[] = [];
  const billAmounts = new Map<number, Amounts>();
  const perProductTotal = new Map<string, number>();

  for (const bill of bills) {
    let woGST = 0;
    let wGST = 0;
    for (const line of bill.products ?? []) {
      const rate = rateBy.get(line.productId);
      if (!rate) { errors.push(`Unknown product in bill ${bill.partNumber}.`); continue; }
      if (!Number.isFinite(line.qty) || line.qty < 0) { errors.push(`Quantity cannot be negative (bill ${bill.partNumber}).`); continue; }
      const a = productAmounts(line.qty, rate);
      woGST = round2(woGST + a.withoutGST);
      wGST = round2(wGST + a.withGST);
      perProductTotal.set(line.productId, round3((perProductTotal.get(line.productId) ?? 0) + line.qty));
    }
    billAmounts.set(bill.partNumber, { withoutGST: woGST, withGST: wGST });
  }

  if (side === "so") {
    for (const c of committed) {
      // Value Based products have no predefined quantity. Their combined monetary target is validated by the
      // existing Scheme/Option preset-value guard after these quantities have been converted to amounts.
      if (c.committedQty == null) continue;
      const got = perProductTotal.get(c.productId) ?? 0;
      if (round3(got) > round3(c.committedQty)) errors.push(`Bill quantities for a product exceed its committed quantity of ${round3(c.committedQty)}.`);
      else if (round3(got) !== round3(c.committedQty)) errors.push(`Bill quantities for a product must total its committed quantity of ${round3(c.committedQty)}.`);
    }
  }

  const total = [...billAmounts.values()].reduce<Amounts>(
    (acc, a) => ({ withoutGST: round2(acc.withoutGST + a.withoutGST), withGST: round2(acc.withGST + a.withGST) }),
    { withoutGST: 0, withGST: 0 },
  );
  return { billAmounts, total, errors };
}

/** Combined total across every bill (each already a list of product lines). */
export function combinedTotals(bills: BillProductLine[][]): Amounts {
  return bills.reduce<Amounts>(
    (acc, lines) => {
      const t = billTotals(lines);
      return { withoutGST: round2(acc.withoutGST + t.withoutGST), withGST: round2(acc.withGST + t.withGST) };
    },
    { withoutGST: 0, withGST: 0 },
  );
}
