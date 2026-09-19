export type SchemeRemainderDecision = "CANCELLED" | "FUTURE_DRAFT";

export interface QuantitySplitDecision {
  originalQuantity: number;
  proceedingQuantity: number;
  remainingQuantity: number;
  disposition: SchemeRemainderDecision | null;
  split: boolean;
}

/**
 * The quantity represented by the plan segment that is proceeding through the current operation.
 * Persisted segments already store their own effective quantity in `numberOfSchemes`; while the SO is
 * choosing a split, `proceedingQuantity` temporarily overrides that value until the transaction updates the
 * current segment. Keeping this resolver independent of the remainder disposition also lets the conversion
 * UI update its read-only targets before the SO chooses Future Draft or Cancelled.
 */
export function effectiveProceedingSchemeUnits(
  planQuantity: number,
  proceedingQuantity?: number,
): number {
  if (!Number.isInteger(planQuantity) || planQuantity < 1)
    throw new Error("The approved plan has an invalid scheme quantity");
  const proceeding = proceedingQuantity ?? planQuantity;
  if (!Number.isInteger(proceeding) || proceeding < 1)
    throw new Error("Schemes proceeding now must be at least 1");
  if (proceeding > planQuantity)
    throw new Error(`Schemes proceeding now cannot exceed the approved quantity of ${planQuantity}`);
  return proceeding;
}

/** Scale one Scheme Master/selected-option Product Quantity target for the current plan segment. */
export function effectiveProductQuantityTarget(perSchemeTarget: number, proceedingUnits: number): number {
  const target = Number.isFinite(perSchemeTarget) && perSchemeTarget > 0 ? perSchemeTarget : 0;
  const units = Number.isInteger(proceedingUnits) && proceedingUnits > 0 ? proceedingUnits : 1;
  return Math.round(target * units * 1000) / 1000;
}

/** Pure validation shared by both conversion server paths and focused contract tests. */
export function quantitySplitDecision(
  originalQuantity: number,
  proceedingQuantity: number | undefined,
  disposition: SchemeRemainderDecision | null | undefined,
): QuantitySplitDecision {
  const proceeding = effectiveProceedingSchemeUnits(originalQuantity, proceedingQuantity);
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
