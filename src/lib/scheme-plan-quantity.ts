export type SchemeRemainderDecision = "CANCELLED" | "FUTURE_DRAFT";

export interface QuantitySplitDecision {
  originalQuantity: number;
  proceedingQuantity: number;
  remainingQuantity: number;
  disposition: SchemeRemainderDecision | null;
  split: boolean;
}

/** Pure validation shared by both conversion server paths and focused contract tests. */
export function quantitySplitDecision(
  originalQuantity: number,
  proceedingQuantity: number | undefined,
  disposition: SchemeRemainderDecision | null | undefined,
): QuantitySplitDecision {
  if (!Number.isInteger(originalQuantity) || originalQuantity < 1)
    throw new Error("The approved plan has an invalid scheme quantity");
  const proceeding = proceedingQuantity ?? originalQuantity;
  if (!Number.isInteger(proceeding) || proceeding < 1)
    throw new Error("Schemes proceeding now must be at least 1");
  if (proceeding > originalQuantity)
    throw new Error(`Schemes proceeding now cannot exceed the approved quantity of ${originalQuantity}`);
  const remaining = originalQuantity - proceeding;
  if (remaining === 0) {
    return { originalQuantity, proceedingQuantity: proceeding, remainingQuantity: 0, disposition: null, split: false };
  }
  if (disposition !== "CANCELLED" && disposition !== "FUTURE_DRAFT")
    throw new Error(`Choose whether the remaining ${remaining} scheme${remaining === 1 ? "" : "s"} should continue in future`);
  return { originalQuantity, proceedingQuantity: proceeding, remainingQuantity: remaining, disposition, split: true };
}

/** Existing amount rule: proportion the plan's frozen total by the effective quantity. */
export function quantityPortionAmount(total: number, originalQuantity: number, portionQuantity: number): number {
  if (!Number.isFinite(total) || total < 0) throw new Error("The approved plan amount is invalid");
  return Math.round((total / originalQuantity) * portionQuantity * 100) / 100;
}

/** Unit/dealer totals used to prove related segments never add an extra dealer or extra scheme unit. */
export function distinctPlanTotals(rows: { dealerId: string; numberOfSchemes: number }[]) {
  return {
    dealers: new Set(rows.map((row) => row.dealerId)).size,
    schemes: rows.reduce((sum, row) => sum + row.numberOfSchemes, 0),
  };
}
