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
  "recovery.dueOverdue": "Due + Overdue",
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

  /* =====================================================================================
   * SCHEME PLANNING — structural labels only (flip/tab buttons, view buttons, table column
   * headers and nested/collapsible table column headers). NEVER data. Every occurrence of a
   * key renders the same override for Admin / RM / Sales Officer and across all schemes.
   * ===================================================================================== */

  // Navigation / flip buttons (the top module bar, shared by all roles)
  "scheme_planning.nav.create_plan": "Create Plan",
  "scheme_planning.nav.view_plan": "View Plan",
  "scheme_planning.nav.follow_up": "Follow-up Plans",

  // View / secondary flip buttons
  "scheme_planning.view.scheme_wise": "Scheme-wise",
  "scheme_planning.view.dealer_wise": "Dealer-wise",
  "scheme_planning.view.enrolled_scheme": "Enrolled Scheme",
  "scheme_planning.view.view_all_scheme": "View All Scheme",
  "scheme_planning.view.planned_scheme": "Planned Scheme",
  "scheme_planning.view.my_schemes": "My Schemes",
  "scheme_planning.view.team_schemes": "Team Schemes",
  "scheme_planning.view.all_plan_view": "All Plan View",
  "scheme_planning.view.all_plans": "All Plans",
  "scheme_planning.view.review": "Review",
  "scheme_planning.view.running_schemes": "Running Schemes",

  // Review / summary table column headers
  "scheme_planning.col.scheme": "Scheme",
  "scheme_planning.col.dealers": "Dealers",
  "scheme_planning.col.sales_officers": "Sales Officer(s)",
  "scheme_planning.col.state": "State",
  "scheme_planning.col.plan_status": "Plan Status",
  "scheme_planning.col.scheme_status": "Scheme Status",
  "scheme_planning.col.actions": "Actions",

  // Nested / collapsible dealer-table column headers (Review + Scheme-wise expanded rows)
  "scheme_planning.nested.dealer": "Dealer",
  "scheme_planning.nested.sales_officer": "Sales Officer",
  "scheme_planning.nested.state": "State",
  "scheme_planning.nested.planned_conversion": "Planned Conversion",
  "scheme_planning.nested.schemes": "Schemes",
  "scheme_planning.nested.total_amount": "Total Amount",
  "scheme_planning.nested.planning_date": "Planning Date",
  "scheme_planning.nested.plan_status": "Plan Status",
  "scheme_planning.nested.scheme_status": "Scheme Status",
  "scheme_planning.nested.conversion_date": "Conversion Date",
  "scheme_planning.nested.booking_amount": "Booking Amount",
  "scheme_planning.nested.document_status": "Document Status",
  "scheme_planning.nested.billing_date": "Billing Date",
  "scheme_planning.nested.actions": "Actions",

  // Enrolled Scheme table (collapsible) column headers
  "scheme_planning.enrolled.col.dealer_name": "Dealer Name",
  "scheme_planning.enrolled.col.billing_date": "Billing Date",
  "scheme_planning.enrolled.col.amount_without_gst": "Amount (Without GST)",
  "scheme_planning.enrolled.col.amount_with_gst": "Amount (With GST)",
  "scheme_planning.enrolled.col.installments": "Installments",
  "scheme_planning.enrolled.col.status": "Status",
  "scheme_planning.enrolled.col.actions": "Actions",

  // Enrolled Scheme installment sub-table (nested inside the expanded dealer) column headers
  "scheme_planning.enrolled.inst.installment": "Installment",
  "scheme_planning.enrolled.inst.planned_amount": "Planned Amount",
  "scheme_planning.enrolled.inst.planned_date": "Planned Date",
  "scheme_planning.enrolled.inst.received_amount": "Received Amount",
  "scheme_planning.enrolled.inst.actual_date": "Actual Date",
  "scheme_planning.enrolled.inst.status": "Status",
} as const;

export type LabelKey = keyof typeof DEFAULT_LABELS;

/* -------------------------------------------------------------------------------------------------
 * Catalog metadata — organises keys by MODULE and GROUP for the Admin Labels management page. This is
 * presentation-only grouping; the stable KEY (never the group) is what the app and storage use. New
 * Scheme Planning keys are registered explicitly; every other existing key is auto-classified from its
 * prefix so the management page can show them too, and so Sales/Recovery extend without a new mechanism.
 * ------------------------------------------------------------------------------------------------- */

export type LabelGroup = "Navigation / Flip Buttons" | "View Buttons" | "Table Columns" | "Nested/Collapsible Table Columns" | "Sections";

interface LabelMeta { module: string; group: LabelGroup }

/** Explicit metadata for the Scheme Planning keys (the reference implementation). */
const SCHEME_PLANNING_META: Partial<Record<LabelKey, LabelMeta>> = {} as Partial<Record<LabelKey, LabelMeta>>;
(function registerSchemePlanning() {
  const M = "Scheme Planning";
  const assign = (prefix: string, group: LabelGroup) => {
    for (const k of Object.keys(DEFAULT_LABELS) as LabelKey[]) if (k.startsWith(prefix)) SCHEME_PLANNING_META[k] = { module: M, group };
  };
  assign("scheme_planning.nav.", "Navigation / Flip Buttons");
  assign("scheme_planning.view.", "View Buttons");
  assign("scheme_planning.col.", "Table Columns");
  assign("scheme_planning.nested.", "Nested/Collapsible Table Columns");
  assign("scheme_planning.enrolled.col.", "Table Columns");
  assign("scheme_planning.enrolled.inst.", "Nested/Collapsible Table Columns");
})();

/** Classify any key into { module, group } — explicit Scheme Planning metadata first, else by prefix. */
export function labelMeta(key: LabelKey): LabelMeta {
  const explicit = SCHEME_PLANNING_META[key];
  if (explicit) return explicit;
  if (key.startsWith("recovery.")) return { module: "Recovery Planning", group: key.includes(".section.") ? "Sections" : "Table Columns" };
  if (key.startsWith("col.") || key.startsWith("seasonal.") || key.startsWith("monthView.") || key.startsWith("monthly.") || key.startsWith("summary.") || key.startsWith("dealerSummary.") || key.startsWith("productPlan.")) {
    return { module: "Sales Planning", group: key.includes(".section.") ? "Sections" : "Table Columns" };
  }
  return { module: "Other", group: "Table Columns" };
}

export interface LabelCatalogEntry { key: LabelKey; module: string; group: LabelGroup; default: string; current: string; customized: boolean }

/** The full catalog (default + current value per key, grouped) for the Admin Labels management page. */
export function labelCatalog(overrides: Record<string, string> | null | undefined): LabelCatalogEntry[] {
  const resolved = resolveLabels(overrides);
  return (Object.keys(DEFAULT_LABELS) as LabelKey[]).map((key) => {
    const meta = labelMeta(key);
    const def = DEFAULT_LABELS[key];
    const current = resolved[key] ?? def;
    return { key, module: meta.module, group: meta.group, default: def, current, customized: current !== def };
  });
}

/** Merge admin overrides over the defaults (unknown keys ignored). */
export function resolveLabels(overrides: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_LABELS };
  if (overrides) for (const [k, v] of Object.entries(overrides)) if (k in DEFAULT_LABELS && typeof v === "string" && v.trim()) out[k] = v;
  return out;
}
