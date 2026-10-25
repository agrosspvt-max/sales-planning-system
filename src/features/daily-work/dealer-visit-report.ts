export type DealerVisitResult = "VISITED" | "NOT_VISITED";
export type DealerVisitSource = "RELATIONSHIP" | "SALES" | "RECOVERY";

export interface VisitReportRecord {
  id: string;
  batchId: string;
  section: string;
  dealerId?: string | null;
  followUpType?: string | null;
  purpose?: string | null;
  noPlanSections?: string | null;
  dealerVisitResults?: unknown;
}

export interface DealerVisitReportRow {
  entryId: string;
  batchId: string;
  dealerId: string;
  sources: DealerVisitSource[];
  purpose: string | null;
  result: DealerVisitResult | null;
}

export function visitResultMap(value: unknown): Record<string, DealerVisitResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const results = (value as { results?: unknown }).results;
  if (!results || typeof results !== "object" || Array.isArray(results)) return {};
  return Object.fromEntries(Object.entries(results).filter(([, result]) => result === "VISITED" || result === "NOT_VISITED")) as Record<string, DealerVisitResult>;
}

export function additionalVisitActual(value: unknown): number | null {
  const count = (value as { additionalDealerVisits?: unknown } | null)?.additionalDealerVisits;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

/** Frozen batches must be supplied oldest first. One dealer/day belongs to its first batch; later sources merge into that row. */
export function dealerVisitReportRows(records: VisitReportRecord[], summaries = records.filter((r) => r.section === "SUMMARY")): DealerVisitReportRow[] {
  const sources = new Map<string, VisitReportRecord[]>();
  for (const row of records) {
    if (!row.dealerId || !(row.section === "RELATIONSHIP" || ((row.section === "SALES" || row.section === "RECOVERY") && row.followUpType === "VISIT"))) continue;
    const batch = sources.get(row.batchId) ?? [];
    batch.push(row); sources.set(row.batchId, batch);
  }
  const dealers = new Map<string, DealerVisitReportRow>();
  for (const summary of summaries) {
    if ((summary.noPlanSections ?? "").split(",").includes("VISITS")) continue;
    const results = visitResultMap(summary.dealerVisitResults);
    for (const row of sources.get(summary.batchId) ?? []) {
      const id = row.dealerId!;
      const visit = dealers.get(id) ?? { entryId: summary.id, batchId: summary.batchId, dealerId: id, sources: [], purpose: null, result: results[id] ?? null };
      const source = row.section as DealerVisitSource;
      if (!visit.sources.includes(source)) visit.sources.push(source);
      if (source === "RELATIONSHIP") visit.purpose = row.purpose ?? visit.purpose;
      dealers.set(id, visit);
    }
  }
  const order: DealerVisitSource[] = ["RELATIONSHIP", "SALES", "RECOVERY"];
  return [...dealers.values()].map((row) => ({ ...row, sources: order.filter((source) => row.sources.includes(source)) }));
}
