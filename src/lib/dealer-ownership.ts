/**
 * Current dealer ownership (pure). The authoritative CURRENT owner of a dealer is its open-ended
 * DealerAssignment (effectiveTo = null). Historical planning/recovery rows may carry a DIFFERENT officer
 * because they were created when a previous officer owned the dealer — that historical meaning is preserved,
 * never rewritten.
 *
 * These helpers decide, for a CURRENT-ownership view (e.g. Territory Plan / Territory Recovery), whether a
 * dealer row sourced from a historical plan should be shown under a given officer.
 */

/**
 * True when a dealer should appear under `officerId` in a current-ownership view.
 *
 *  - currentOwnerId === officerId        → yes (this officer currently owns it).
 *  - currentOwnerId is a DIFFERENT officer → no (it was reassigned away; it now belongs elsewhere).
 *  - currentOwnerId is null/undefined    → yes (no current assignment on record: keep the existing/legacy
 *    behaviour rather than hiding a dealer that has no ownership row — this never causes a reassigned dealer
 *    to show under the old officer, because a reassigned dealer always HAS a current owner).
 */
export function isCurrentlyOwnedBy(currentOwnerId: string | null | undefined, officerId: string): boolean {
  if (currentOwnerId == null) return true;
  return currentOwnerId === officerId;
}

export interface OpenAssignment {
  officerId: string;
  effectiveFrom: Date | string | number;
  createdAt?: Date | string | number | null;
}

const ms = (v: Date | string | number | null | undefined): number => {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * The authoritative CURRENT owner from a dealer's OPEN assignments (effectiveTo = null). Normally there is
 * exactly one, but data can carry more than one open row if a prior reassignment failed to close an older one
 * (e.g. the three-segment history of the reported dealers). In that case the MOST RECENT open assignment wins
 * — by latest effectiveFrom, then latest createdAt — so the result is deterministic and always reflects the
 * last reassignment, never an older lingering owner. Returns null when there is no open assignment.
 */
export function resolveCurrentOwner(openAssignments: readonly OpenAssignment[]): string | null {
  let best: OpenAssignment | null = null;
  for (const a of openAssignments) {
    if (!a || typeof a.officerId !== "string") continue;
    if (best === null) { best = a; continue; }
    const af = ms(a.effectiveFrom), bf = ms(best.effectiveFrom);
    if (af > bf || (af === bf && ms(a.createdAt) > ms(best.createdAt))) best = a;
  }
  return best ? best.officerId : null;
}
