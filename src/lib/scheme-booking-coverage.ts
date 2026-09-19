/**
 * Booking-amount SCHEME-COUNT coverage — pure logic (no React, no Prisma) shared by the Admin Verify server
 * validation, the Verify modal UI, and the Conversion Follow-up aggregation.
 *
 * MODEL (see the "Booking coverage" decision): the SO conversion split remains the structural boundary that
 * moves schemes forward; this layer records, per verification, HOW MANY of the plan's (already-proceeding)
 * scheme instances the Admin's Paid booking actually covers, and validates the received amount against the
 * required amount for that count. It does NOT itself split or move schemes — it is coverage + validation +
 * reporting only.
 *
 *   Required Amount = selected scheme count × booking amount per scheme
 *   Received Amount must be ≥ Required Amount (excess = Received − Required)
 */

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export interface BookingCoverageInput {
  /** The plan's proceeding scheme count (DealerSchemePlan.numberOfSchemes) — the maximum selectable. */
  plannedSchemes: number;
  /** Admin-selected "No. of Schemes" the booking covers. */
  selectedCount: number;
  /** Per-scheme booking amount (scheme.bookingAmount for FIXED, option booking for MULTIPLE_OPTIONS). */
  bookingPerScheme: number;
  /** Admin-entered received booking amount. */
  receivedAmount: number;
}

export interface BookingCoverageResult {
  requiredAmount: number;
  excessAmount: number;
  valid: boolean;
  error: string | null;
}

/**
 * Validate a Paid-booking coverage selection and compute required/excess. Applies to the RECEIVED (Paid)
 * case; PARTIAL / NOT_RECEIVED do not use coverage and should not call this.
 */
export function bookingCoverage(input: BookingCoverageInput): BookingCoverageResult {
  const planned = Math.max(0, Math.trunc(input.plannedSchemes || 0));
  const perScheme = input.bookingPerScheme > 0 ? input.bookingPerScheme : 0;
  const received = Number.isFinite(input.receivedAmount) ? input.receivedAmount : 0;
  const count = input.selectedCount;

  if (!Number.isInteger(count) || count < 1) {
    return { requiredAmount: 0, excessAmount: 0, valid: false, error: "Select the number of schemes the booking amount covers." };
  }
  if (count > planned) {
    return { requiredAmount: 0, excessAmount: 0, valid: false, error: `You can cover at most ${planned} scheme${planned === 1 ? "" : "s"} — the number planned for this dealer.` };
  }
  const requiredAmount = round2(count * perScheme);
  if (received < requiredAmount) {
    return {
      requiredAmount,
      excessAmount: 0,
      valid: false,
      error: `Received booking amount is short of the required ${requiredAmount} for ${count} scheme${count === 1 ? "" : "s"}.`,
    };
  }
  return { requiredAmount, excessAmount: round2(received - requiredAmount), valid: true, error: null };
}

/**
 * How many scheme instances a plan's booking is VERIFIED to cover — the Conversion Follow-up "Booking Amt."
 * value (scheme-wise = Σ over dealers; dealer-wise = this value). Historical-safe: plans verified before this
 * feature have no stored count, so a Paid plan is treated as covering all its (proceeding) schemes, and any
 * non-Paid plan covers 0. Never throws.
 */
export function bookingCoverageUnits(p: {
  adminBookingSchemeCount: number | null | undefined;
  adminBookingStatus: string | null | undefined;
  numberOfSchemes: number;
}): number {
  if (p.adminBookingSchemeCount != null) return Math.max(0, Math.trunc(p.adminBookingSchemeCount));
  return p.adminBookingStatus === "RECEIVED" ? Math.max(1, Math.trunc(p.numberOfSchemes || 1)) : 0;
}
