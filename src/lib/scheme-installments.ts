/**
 * Canonical Scheme installment amount calculation — PURE (no DB, no `server-only`), so the SAME rule is
 * imported by BOTH the Scheme Master builder UI and every server path (schedule generation, Enrolled
 * Scheme, Follow-up, Achievement). There is exactly ONE definition of an installment's payable amount.
 *
 * Business rule — Booking Amount is part of the total scheme value, so it is DEDUCTED FROM THE FINAL
 * installment (the highest installmentNumber). The per-rule "normal" amount is unchanged:
 *   - PERCENTAGE → applicable value (With GST) × percentage / 100
 *   - FIXED_AMOUNT → the entered amount
 * Only the final installment's payable is reduced by the Booking Amount. Therefore, for valid rules:
 *
 *   Booking Amount + Σ plannedAmount === applicable total scheme value (With GST)
 *
 * The final installment is never negative (clamped to 0; `bookingExceedsFinalInstallment` lets callers
 * reject a Booking Amount larger than the final installment BEFORE saving). For MULTIPLE_OPTIONS the
 * "applicable value" is the selected option's snapshotted With-GST value; for FIXED it is the scheme value.
 */

export interface InstallmentRuleInput {
  installmentNumber: number;
  calculationType: string; // "PERCENTAGE" | "FIXED_AMOUNT"
  value: number;
}

export interface ComputedInstallment {
  installmentNumber: number;
  /** Amount before the Booking Amount deduction (percentage × value, or the fixed amount). */
  normalAmount: number;
  /** Payable amount: equals normalAmount for every installment EXCEPT the final, where Booking is deducted. */
  plannedAmount: number;
  isFinal: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The "normal" (pre-booking) payable for ONE rule against the applicable With-GST value. */
export function normalInstallmentAmount(rule: InstallmentRuleInput, valueWithGST: number): number {
  return rule.calculationType === "PERCENTAGE"
    ? round2((valueWithGST * (Number(rule.value) || 0)) / 100)
    : round2(Number(rule.value) || 0);
}

/**
 * Booking-adjusted payable amounts for a set of installment rules. Booking is deducted from the FINAL
 * installment only; the final is clamped at 0 so it is never negative. Deterministic and side-effect free.
 */
export function computeInstallmentAmounts(
  rules: InstallmentRuleInput[],
  valueWithGST: number,
  bookingAmount = 0,
): ComputedInstallment[] {
  const sorted = rules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber);
  const lastIdx = sorted.length - 1;
  const booking = bookingAmount > 0 ? bookingAmount : 0;
  return sorted.map((r, i) => {
    const normalAmount = normalInstallmentAmount(r, valueWithGST);
    const isFinal = i === lastIdx;
    const plannedAmount = isFinal ? Math.max(0, round2(normalAmount - booking)) : normalAmount;
    return { installmentNumber: r.installmentNumber, normalAmount, plannedAmount, isFinal };
  });
}

/**
 * True when the Booking Amount would push the FINAL installment negative (i.e. Booking > final normal
 * amount) — an invalid configuration callers should reject. `valueWithGST` must be the applicable total.
 * Returns false when there are no rules or the booking is 0 (nothing to validate).
 */
export function bookingExceedsFinalInstallment(rules: InstallmentRuleInput[], valueWithGST: number, bookingAmount: number): boolean {
  if (!(bookingAmount > 0) || rules.length === 0) return false;
  const sorted = rules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber);
  const finalNormal = normalInstallmentAmount(sorted[sorted.length - 1], valueWithGST);
  return round2(bookingAmount) > round2(finalNormal);
}
