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
  // Follow-up sub-view switch (Installments default) — Product/Value achievement views (Phase 6)
  "scheme_planning.view.installments": "Installments",
  "scheme_planning.view.product_based": "Product Based",
  "scheme_planning.view.value_based": "Value Based",

  // Review / summary table column headers
  "scheme_planning.col.scheme": "Scheme",
  "scheme_planning.col.dealers": "Dealers",
  "scheme_planning.col.no_of_dealers": "No. of Dealers",
  "scheme_planning.col.no_of_schemes": "No. of Schemes",
  "scheme_planning.col.total_amount": "Total Amount",
  "scheme_planning.col.planned_dealers": "Planned Dealers",
  "scheme_planning.col.converted_dealers": "Converted Dealers",
  "scheme_planning.col.planned_schemes": "Planned Schemes",
  "scheme_planning.col.converted_schemes": "Converted Schemes",
  "scheme_planning.col.booking_amount": "Booking Amount",
  "scheme_planning.col.document_status": "Document Status",
  "scheme_planning.col.billing_status": "Billing Status",
  "scheme_planning.col.sales_officers": "Sales Officer(s)",
  "scheme_planning.col.state": "State",
  "scheme_planning.col.plan_status": "Plan Status",
  "scheme_planning.col.scheme_status": "Scheme Status",
  "scheme_planning.col.actions": "Actions",

  // Follow-up achievement columns (Phase 6) — Product Based / Value Based / Installments
  "scheme_planning.col.scheme_installments": "Scheme Installments",
  "scheme_planning.col.products": "Products",
  "scheme_planning.col.required_qty": "Required Qty",
  "scheme_planning.col.sale_qty": "Sale Qty",
  "scheme_planning.col.products_completed": "Products Completed",
  "scheme_planning.col.remaining_qty": "Remaining Qty",
  "scheme_planning.col.progress": "Progress",
  "scheme_planning.col.required_value": "Required Value",
  "scheme_planning.col.achieved_value": "Achieved Value",
  "scheme_planning.col.remaining_value": "Remaining Value",
  "scheme_planning.col.completion": "Completion",
  "scheme_planning.col.no_of_schemes_fu": "No. of Schemes",

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

  /* =====================================================================================
   * SCHEME MASTER — Scheme Requirement configuration (Phase 5). Structural labels only:
   * section title, field labels, requirement-type / value-mode option text, and the
   * requirement product table column headers. Display text is customizable here; the
   * underlying enum values (NONE / PRODUCT_BASED / VALUE_BASED / INDIVIDUAL / COMBINED)
   * are DB constants and are never renamed.
   * ===================================================================================== */
  "scheme_master.requirement.section": "Scheme Requirement",
  "scheme_master.requirement.type": "Requirement Type",
  "scheme_master.requirement.type.none": "None",
  "scheme_master.requirement.type.product": "Product Based",
  "scheme_master.requirement.type.value": "Value Based",
  "scheme_master.requirement.value_mode": "Value Mode",
  "scheme_master.requirement.value_mode.individual": "Individual",
  "scheme_master.requirement.value_mode.combined": "Combined",
  "scheme_master.requirement.combined_value": "Combined Required Value",
  "scheme_master.requirement.applicable_products": "Applicable Products",
  "scheme_master.requirement.add_product": "Add Product",
  "scheme_master.requirement.col.product": "Product",
  "scheme_master.requirement.col.required_qty": "Required Quantity",
  "scheme_master.requirement.col.required_value": "Required Value",

  /* =====================================================================================
   * SCHEME MASTER — full form / table / action labels (Phase 8). Centrally editable, user-visible
   * text only; never data and never DB enum values.
   * ===================================================================================== */
  // Page + list
  "scheme_master.page.title": "Scheme Master",
  "scheme_master.page.subtitle_manage": "Create and manage commercial schemes by State.",
  "scheme_master.page.subtitle_view": "Available commercial schemes by State.",
  "scheme_master.filter.all_status": "All status",
  "scheme_master.filter.all_states": "All states",
  "scheme_master.action.new_scheme": "New Scheme",
  "scheme_master.view.view_scheme": "View Scheme",
  "scheme_master.view.enrolled_scheme": "Enrolled Scheme",
  // List table columns
  "scheme_master.col.scheme_name": "Scheme Name",
  "scheme_master.col.states": "States",
  "scheme_master.col.scheme_period": "Scheme Period",
  "scheme_master.col.last_booking_date": "Last Booking Date",
  "scheme_master.col.without_gst": "Without GST",
  "scheme_master.col.with_gst": "With GST",
  "scheme_master.col.benefit": "Benefit",
  "scheme_master.col.status": "Status",
  "scheme_master.col.actions": "Actions",
  // Row menu / actions
  "scheme_master.action.info": "Info",
  "scheme_master.action.view_document": "View Document",
  "scheme_master.action.share": "Share",
  "scheme_master.action.edit_scheme": "Edit Scheme",
  "scheme_master.action.delete_scheme": "Delete Scheme",
  // Create/Edit dialog — titles + buttons
  "scheme_master.form.create_title": "Create Scheme",
  "scheme_master.form.edit_title": "Edit Scheme",
  "scheme_master.form.cancel": "Cancel",
  "scheme_master.form.save_scheme": "Save Scheme",
  "scheme_master.form.save_changes": "Save Changes",
  // Create/Edit dialog — field labels
  "scheme_master.form.scheme_name": "Scheme Name",
  "scheme_master.form.applicable_states": "Applicable States",
  "scheme_master.form.perpetual": "Perpetual Scheme",
  "scheme_master.form.scheme_start": "Scheme Start",
  "scheme_master.form.scheme_end": "Scheme End",
  "scheme_master.form.last_booking_date": "Last Booking Date",
  "scheme_master.form.booking_amount": "Booking Amount",
  "scheme_master.form.value_without_gst": "Scheme Value (Without GST)",
  "scheme_master.form.value_with_gst": "Scheme Value (With GST)",
  "scheme_master.form.scheme_benefit": "Scheme Benefit",
  "scheme_master.form.allow_multiple": "Allow Multiple Schemes",
  "scheme_master.form.max_extension_days": "Maximum Extension Days",
  "scheme_master.form.max_extension_attempts": "Maximum Extension Attempts",
  "scheme_master.form.benefit_details": "Enter Benefit Details",
  "scheme_master.form.other_benefit_details": "Other Benefit Details",
  "scheme_master.form.installment_builder": "Installment Rule Builder",
  "scheme_master.form.no_of_installments": "No. of Installments",
  "scheme_master.form.calculation_type": "Calculation Type",
  "scheme_master.form.col_percentage": "Percentage (%)",
  "scheme_master.form.col_amount": "Amount (₹)",
  "scheme_master.form.days_after_billing": "Days after Billing Date",
  "scheme_master.form.scheme_document": "Scheme Document",

  /* =====================================================================================
   * SCHEME UPLOAD (Phase 7) — the dedicated date-range achievement upload tab. Structural
   * labels only (tab, step headings, field labels). Never data. Never renames DB enums.
   * ===================================================================================== */
  "scheme_upload.tab": "Scheme Upload",
  "scheme_upload.title": "Scheme Upload",
  "scheme_upload.select_schemes": "Select Schemes",
  "scheme_upload.start_date": "Start Date",
  "scheme_upload.end_date": "End Date",
  "scheme_upload.file": "Sales Register (.xlsx)",
  "scheme_upload.analyze": "Analyze",
  "scheme_upload.review": "Review",
  "scheme_upload.confirm_import": "Confirm Import",
} as const;

export type LabelKey = keyof typeof DEFAULT_LABELS;

/* -------------------------------------------------------------------------------------------------
 * Catalog metadata — organises keys by MODULE and GROUP for the Admin Labels management page. This is
 * presentation-only grouping; the stable KEY (never the group) is what the app and storage use. New
 * Scheme Planning keys are registered explicitly; every other existing key is auto-classified from its
 * prefix so the management page can show them too, and so Sales/Recovery extend without a new mechanism.
 * ------------------------------------------------------------------------------------------------- */

export type LabelGroup = "Navigation / Flip Buttons" | "View Buttons" | "Table Columns" | "Nested/Collapsible Table Columns" | "Sections" | "Form Fields";

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
  if (key.startsWith("scheme_master.requirement.col.")) return { module: "Scheme Master", group: "Table Columns" };
  if (key.startsWith("scheme_master.requirement.section")) return { module: "Scheme Master", group: "Sections" };
  if (key.startsWith("scheme_master.form.")) return { module: "Scheme Master", group: "Form Fields" };
  if (key.startsWith("scheme_master.col.")) return { module: "Scheme Master", group: "Table Columns" };
  if (key.startsWith("scheme_master.page.") || key.startsWith("scheme_master.action.") || key.startsWith("scheme_master.filter.") || key.startsWith("scheme_master.view.")) return { module: "Scheme Master", group: "View Buttons" };
  if (key.startsWith("scheme_master.")) return { module: "Scheme Master", group: "View Buttons" };
  if (key.startsWith("scheme_upload.")) return { module: "Scheme Upload", group: "View Buttons" };
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
