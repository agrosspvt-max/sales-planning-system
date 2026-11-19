import "server-only";
import { ALL_BUCKETS, type GroupPlanFilter, type StatusBucket } from "./group-plan.server";

/** Shared parsing keeps the main territory report and dealer bills on identical filters. */
export function readGroupPlanFilter(q: URLSearchParams): GroupPlanFilter {
  const rawView = q.get("view") ?? "total";
  return {
    buckets: (q.get("buckets") ?? "approved")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is StatusBucket => (ALL_BUCKETS as string[]).includes(s)),
    includeUnplanned: q.get("unplanned") === "true",
    view: rawView === "month" || rawView === "range" ? rawView : "total",
    monthIds: (q.get("months") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    officerId: q.get("officerId")?.trim() || undefined,
    seasonMetrics: q.get("seasonMetrics") === "filters" ? "filters" : "approved",
    fromMonthId: q.get("fromMonth") ?? undefined,
    toMonthId: q.get("toMonth") ?? undefined,
    groupBy: q.get("groupBy") === "dealer" ? "dealer" : undefined,
  };
}
