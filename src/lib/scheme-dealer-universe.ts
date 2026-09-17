/**
 * "Planned Dealers" denominator for View Plan → Scheme-wise. PURE (no DB) so it is unit-testable and shared by
 * the server summary aggregation.
 *
 * The denominator is the COMBINED dealer universe of the Sales Officers who planned a scheme in the current
 * tab — i.e. the union of each such officer's currently-assigned active dealers (the same DealerAssignment
 * source Sales Planning uses). A dealer assigned to more than one of those officers is counted ONCE (the union
 * dedups). It is NOT the global dealer table count.
 */
export function combinedDealerUniverse(
  officerIds: Iterable<string>,
  assignments: readonly { officerId: string; dealerId: string }[],
): number {
  const officers = officerIds instanceof Set ? officerIds : new Set(officerIds);
  const dealers = new Set<string>();
  for (const a of assignments) if (officers.has(a.officerId)) dealers.add(a.dealerId);
  return dealers.size;
}
