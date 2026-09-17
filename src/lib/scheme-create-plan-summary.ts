/** Oldest persisted dealer-plan creation date in the already-filtered Create Plan population. */
export function oldestDraftPlanCreatedAt(rows: { createdAt: string | null }[]): string | null {
  let oldest: string | null = null;
  let oldestTime = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (!row.createdAt) continue;
    const time = new Date(row.createdAt).getTime();
    if (Number.isFinite(time) && time < oldestTime) {
      oldest = row.createdAt;
      oldestTime = time;
    }
  }
  return oldest;
}

/** User-facing Scheme Master structure label used by both Create Plan tables. */
export function schemeTypeLabel(structure: "FIXED" | "MULTIPLE_OPTIONS" | undefined): "Fixed Scheme" | "Option Scheme" {
  return structure === "MULTIPLE_OPTIONS" ? "Option Scheme" : "Fixed Scheme";
}
