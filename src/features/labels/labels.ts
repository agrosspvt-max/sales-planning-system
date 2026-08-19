/**
 * Central Label Dictionary for planning grids (section titles + column headers ONLY — never data).
 * Every planning screen reads labels from here via `useLabel(key)`, so an admin override applied to a
 * key is reflected everywhere that key is used. Shared business concepts intentionally share ONE key
 * (e.g. "Current Outstanding" appears in the Recovery Month AND Week views under `recovery.currentOutstanding`).
 *
 * DEFAULT_LABELS are the built-in defaults; admin overrides (SystemSetting JSON) are merged over these
 * at runtime. Keys are stable identifiers and must never change once shipped.
 */
export const DEFAULT_LABELS = {
  // ---- Shared column concepts (reused across grids) ----
  "col.product": "Product",
  "col.dealer": "Dealer",
  "col.noPlan": "No Plan",
  "col.amount": "Amount",
  "col.nbv": "NBV",
  "col.actualQty": "Actual Qty",
  "col.actualAmt": "Actual Amt",
  "col.actualNbv": "Actual NBV",
  "col.liveQty": "Live Qty",
  "col.liveAmt": "Live Amt",
  "col.liveNbv": "Live NBV",
  "col.seasonMinusMonth": "Season − Month",
  "col.pending": "Pending",

  // ---- Seasonal Dealer Plan ----
  "seasonal.section.planning": "Planning",
  "seasonal.section.planSummary": "Plan Summary",
  "seasonal.section.actualSales": "Actual Sales",
  "seasonal.section.liveMonth": "Live Month",
  "seasonal.totalQty": "Total Qty",

  // ---- Dealer Plan Month View ----
  "monthView.section.monthlyPlan": "Monthly Plan",
  "monthView.monthlyPlannedQty": "Monthly Planned Qty",

  // ---- Monthly Planner ----
  "monthly.seasonUnit": "Season",
  "monthly.plannedAllMonths": "Planned (all months)",
  "monthly.remaining": "Remaining",
  "monthly.thisMonthPlan": "This Month Plan",
  "monthly.thisMonthSold": "This Month Sold",
  "monthly.pendingMo": "Pending (mo)",
  "monthly.plannedAmount": "Planned Amount",
  "monthly.actualAmount": "Actual Amount",

  // ---- Recovery: sections ----
  "recovery.section.dealerClosing": "Dealer & Closing Balance",
  "recovery.section.recoveryPlanning": "Recovery Planning",
  "recovery.section.weeklyPlanning": "Weekly Planning",
  "recovery.section.recoveryProgress": "Recovery Progress",
  "recovery.section.daybook": "Daybook (SR/CR · Live · Actual Running)",
  "recovery.section.results": "Results",
  "recovery.section.reference": "Reference (Read-only)",

  // ---- Recovery: Month View columns ----
  "recovery.currentOutstanding": "Current Outstanding",
  // The trailing dd/mm date is appended dynamically in the view (aging cutoff / month opening),
  // so the base label omits the word "Date".
  "recovery.outstandingTillDate": "Outstanding Till",
  "recovery.overdue": "Overdue",
  "recovery.due": "Due",
  "recovery.recoveryPlan": "Recovery Plan",
  "recovery.runningOsBills": "Running O/S Bills",
  "recovery.runningOsTillDate": "Running O/S Till Date",
  "recovery.runningRecoveryPlan": "Running Recovery Plan",
  "recovery.recoveryPct": "Recovery %",
  "recovery.srCr": "SR / CR",
  "recovery.liveRecovery": "Live Recovery",
  "recovery.actualRunningRecovery": "Actual Running Recovery",
  "recovery.monthTotal": "Month Total",

  // ---- Recovery: Week View columns ----
  "recovery.thisWeeksDue": "This Week's Due",
  "recovery.weekRecovery": "Week Recovery",
  "recovery.runningMonthPlan": "Running Month Plan",
  "recovery.weeklyPlanTillDate": "Weekly Plan Till Date",
  "recovery.runningPlanThisWeek": "Running Plan This Week",
  "recovery.thisWeekTotal": "This Week Total",
  "recovery.diff": "Diff",
  "recovery.runningRecoveryMonth": "Running Recovery (Month)",

  // ---- Dealer Summary / Product Plan (month-filter view) ----
  "summary.planQty": "Plan Qty",
  "summary.planAmount": "Plan Amount",
  "summary.plannedNbv": "Planned NBV",
  "summary.soldQty": "Sold Qty",
  "summary.soldAmount": "Sold Amount",
  "summary.soldNbv": "Sold NBV",

  // ---- Dealer Summary (seasonal total) ----
  "dealerSummary.salesPlan": "Sales Plan",
  "dealerSummary.salesPlanNbv": "Sales Plan NBV",
  "dealerSummary.liveMonthPlan": "Live Month Plan",
  "dealerSummary.liveMonthNbv": "Live Month NBV",
  "dealerSummary.actualSales": "Actual Sales",
  "dealerSummary.actualNbv": "Actual NBV",
  "dealerSummary.salesAchvPct": "Sales Achv %",
  "dealerSummary.nbvAchvPct": "NBV Achv %",

  // ---- Product Plan (seasonal total) ----
  "productPlan.totalAmount": "Total Amount",
  "productPlan.actualAmount": "Actual Amount",
} as const;

export type LabelKey = keyof typeof DEFAULT_LABELS;

/** Merge admin overrides over the defaults (unknown keys ignored). */
export function resolveLabels(overrides: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_LABELS };
  if (overrides) for (const [k, v] of Object.entries(overrides)) if (k in DEFAULT_LABELS && typeof v === "string" && v.trim()) out[k] = v;
  return out;
}
