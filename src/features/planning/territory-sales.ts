type PlanCandidate = { id: string; status: string; isActiveVersion: boolean; version: number };

export function compareSalesPlans(a: PlanCandidate, b: PlanCandidate) {
  const activeApproved = (p: PlanCandidate) => Number(p.status === "APPROVED" && p.isActiveVersion);
  return activeApproved(b) - activeApproved(a) || b.version - a.version || a.id.localeCompare(b.id);
}

export function includesTerritorySale(
  monthlyBucket: "approved" | "submitted" | "draft" | null,
  selected: ReadonlySet<string>,
  includeUnplanned: boolean,
) {
  return (
    (monthlyBucket !== null && selected.has(monthlyBucket)) ||
    (includeUnplanned && monthlyBucket !== "approved")
  );
}
