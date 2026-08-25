/**
 * Shared visual language for every Scheme Planning parent→child table (Admin, RM, SO — Review,
 * Running, Enrolled). Purely presentational class strings so the hierarchy and semantic status
 * colours stay consistent across roles without duplicating styling in each view.
 *
 * Two independent levels are expressed here:
 *   LEVEL 1 — a PARENT row (scheme / dealer) that expands to reveal…
 *   LEVEL 2 — a nested CHILD table that visually belongs inside the parent.
 *
 * Nothing here touches data, business logic, or the verification-column collapse behaviour.
 */
export const schemeTable = {
  /** Outer bordered container that wraps a top-level table. */
  outer: "overflow-auto rounded-lg border bg-background",

  /** PARENT summary row — primary level: stronger background + a subtle left accent. */
  parentRow: "border-l-2 border-l-primary/40 bg-muted/50 transition-colors hover:bg-muted/60",
  /** Applied additionally while the parent is expanded so the open state reads clearly. */
  parentRowOpen: "bg-muted/70",

  /** The colSpan cell that holds the nested child table (slightly recessed backdrop). */
  nestedCell: "bg-muted/10 p-0",
  /** Inset wrapper — gives the child table breathing room and ties it back to the parent. */
  nestedInset: "border-l-2 border-l-primary/20 px-4 py-3",
  /**
   * Bordered "container" shell around the nested child table itself, plus subtle vertical
   * column separators + horizontal row separators applied to every descendant cell. Put this
   * on the wrapper div; the `[&_th]/[&_td]` selectors cascade into the inner <table>.
   */
  nestedShell:
    "overflow-auto rounded-lg border border-border/70 bg-background shadow-sm " +
    "[&_th]:border-r [&_th]:border-border/30 [&_td]:border-r [&_td]:border-border/30 " +
    "[&_th:last-child]:border-r-0 [&_td:last-child]:border-r-0",
} as const;

/**
 * Semantic tint per verification column — muted, dark-mode-friendly. Header uses a slightly
 * stronger tint than the body cell; both carry a thin coloured left accent. Only columns that
 * actually exist in a given role's view should use these.
 *   conversion → success (verified milestone)   green
 *   booking    → attention / financial          amber
 *   document   → compliance / issue             rose
 *   billing    → confirmed scheduling           teal
 */
export const verifyTint = {
  conversion: { head: "border-l-2 border-emerald-500/30 bg-emerald-500/10", cell: "border-l-2 border-emerald-500/30 bg-emerald-500/5" },
  booking: { head: "border-l-2 border-amber-500/30 bg-amber-500/10", cell: "border-l-2 border-amber-500/30 bg-amber-500/5" },
  document: { head: "border-l-2 border-rose-500/30 bg-rose-500/10", cell: "border-l-2 border-rose-500/30 bg-rose-500/5" },
  billing: { head: "border-l-2 border-teal-500/30 bg-teal-500/10", cell: "border-l-2 border-teal-500/30 bg-teal-500/5" },
} as const;
