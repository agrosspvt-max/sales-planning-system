/**
 * Dealer approval lifecycle — decoupled from Seasonal/Monthly plan approval.
 *
 *   PENDING   – default for Sales-Officer-created dealers. Never activated automatically by any plan
 *               approval. Participates in uploads / matching / recovery / history (isActive = true),
 *               but is NOT eligible for planning selection until an admin sets it Active.
 *   ACTIVE    – normal, fully eligible everywhere.
 *   INACTIVE  – hidden from active dropdowns / new plans; stays in history/recovery/reports (isActive = false).
 *   DEFAULTER – blocked from EVERY planning screen, but still present in uploads / matching / recovery /
 *               history / audit (isActive = true). Never deleted.
 *
 * `Dealer.status` is the single source of truth; `Dealer.isActive` is kept in sync as
 * `status !== "INACTIVE"` so the many existing `isActive` gates keep working unchanged.
 */
export const DEALER_STATUSES = ["PENDING", "ACTIVE", "INACTIVE", "DEFAULTER"] as const;
export type DealerStatus = (typeof DEALER_STATUSES)[number];

/** isActive is derived from status: only INACTIVE is inactive (Pending/Active/Defaulter stay isActive). */
export function isActiveForStatus(status: DealerStatus): boolean {
  return status !== "INACTIVE";
}

/** Parse a free-text status label (Excel cell, etc.). Returns null if unrecognised. */
export function parseDealerStatus(raw: string | null | undefined): DealerStatus | null {
  const v = (raw ?? "").trim().toUpperCase();
  if (!v) return null;
  return (DEALER_STATUSES as readonly string[]).includes(v) ? (v as DealerStatus) : null;
}

/** Human label for display. */
export function dealerStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}
