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
  "historical_daybook.tab": "Historical Daybook",
  "historical_daybook.file": "Day Book Excel file",
  "historical_daybook.analyze": "Analyze",
  "historical_daybook.review": "Update Preview",
  "historical_daybook.import": "Import Historical Receipts",
  "historical_daybook.date": "Receipt Date",
  "historical_daybook.voucher": "Voucher Reference",
  "historical_daybook.decision": "Review Decision",
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
  "recovery.lastPayment": "Last Payment",
  "recovery.lastPaymentFallback": "Before 01/04/2026",
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
  "recovery.cnRequest": "CN Request",
  "recovery.requestCn": "Request CN",
  "recovery.cnStatus.lastCn": "Last CN",
  "recovery.cnStatus.requestRaised": "CN Submitted",
  "recovery.cnStatus.rejected": "Rejected",
  "recovery.cnStatus.cnWorkingSent": "CN Working Sent",
  "recovery.cnStatus.postedInLedger": "Posted in Ledger",
  "recovery.cnStatus.returnedFromLedger": "Rejected",

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

  // ---- CN Requests workflow ----
  "cn_requests.page.breadcrumb": "Requests",
  "cn_requests.page.title": "CN Requests",
  "cn_requests.page.subtitle_officer": "Raise and track your Credit Note requests.",
  "cn_requests.page.subtitle_manager": "Raise your own, and review your team's Credit Note requests.",
  "cn_requests.page.subtitle_admin": "Accept, reject, and post Credit Note requests.",
  "cn_requests.nav.submitted_rejected": "Submitted / Rejected",
  "cn_requests.nav.accepted": "Accepted",
  "cn_requests.view.submitted": "Submitted",
  "cn_requests.view.rejected": "Rejected",
  "cn_requests.view.accepted_not_posted": "Accepted / Not Posted",
  "cn_requests.view.posted_in_ledger": "Posted in Ledger",
  "cn_requests.status.returned_from_ledger": "Returned from Ledger",
  "cn_requests.action.accept": "Accept",
  "cn_requests.action.reject": "Reject",
  "cn_requests.action.post_in_ledger": "Post in Ledger",
  "cn_requests.action.view_details": "View Details",
  "cn_requests.action.download_cn_workaround": "Download CN Workaround",
  "cn_requests.action.download_cn": "Download CN",
  "cn_requests.action.download_final_cn": "Download Final CN",
  "cn_requests.action.create_new_request": "Create New Request",
  "cn_requests.action.cancel": "Cancel",
  "cn_requests.action.close": "Close",
  "cn_requests.action.submit_request": "Submit Request",
  "cn_requests.field.cn_type": "CN Type",
  "cn_requests.field.approx_amount": "Approx Amount",
  "cn_requests.field.payment_status": "Payment Status",
  "cn_requests.field.employee_name": "Employee Name",
  "cn_requests.field.state": "State",
  "cn_requests.field.territory": "Territory",
  "cn_requests.field.status": "Status",
  "cn_requests.field.approval": "Approval",
  "cn_requests.field.details": "Details",
  "cn_requests.field.remarks": "Remarks",
  "cn_requests.create.title": "Create CN Request",
  "cn_requests.detail.title": "CN Request",
  "cn_requests.create.request_for": "Request For",
  "cn_requests.create.my_dealer": "My Dealer",
  "cn_requests.create.team": "Team",
  "cn_requests.create.select_officer": "Select Sales Officer",
  "cn_requests.create.select_officer_placeholder": "Select a Sales Officer…",
  "cn_requests.create.select_party_placeholder": "Select a party…",
  "cn_requests.create.select_type_placeholder": "Select CN Type…",
  "cn_requests.create.select_officer_help": "Select a Sales Officer to see their parties.",
  "cn_requests.create.no_team_officers": "No Sales Officers on your team yet.",
  "cn_requests.create.no_dealers_team": "No dealers are assigned to that Sales Officer.",
  "cn_requests.create.no_dealers_self": "No dealers are assigned to you yet.",
  "cn_requests.create.details_placeholder": "Enter details",
  "cn_requests.create.submitting": "Submitting…",
  "cn_requests.state.no_requests": "No CN requests yet.",
  "cn_requests.rejection.title": "Reject CN Request",
  "cn_requests.rejection.reason": "Reason",
  "cn_requests.rejection.select_reason": "Select a reason...",
  "cn_requests.rejection.billing_condition_not_met": "Billing Condition not met",
  "cn_requests.rejection.payment_condition_not_met": "Payment condition not met",
  "cn_requests.rejection.other": "Other",
  "cn_requests.rejection.other_reason": "Other Reason",
  "cn_requests.rejection.reject_request": "Reject Request",
  "cn_requests.rejection.rejecting": "Rejecting…",
  "cn_requests.acceptance.title": "Accept CN Request",
  "cn_requests.acceptance.status": "Acceptance Status",
  "cn_requests.acceptance.select_status": "Select acceptance status",
  "cn_requests.acceptance.not_posted": "Accepted, Not Posted",
  "cn_requests.acceptance.posted": "Accepted, Posted in Ledger",
  "cn_requests.acceptance.reason": "Reason",
  "cn_requests.acceptance.select_reason": "Select a reason...",
  "cn_requests.acceptance.payment_pending": "Payment Pending",
  "cn_requests.acceptance.cn_working": "CN Working",
  "cn_requests.acceptance.final_cn": "Final CN",
  "cn_requests.acceptance.choose_file": "Choose File",
  "cn_requests.acceptance.selected": "Selected",
  "cn_requests.acceptance.view": "View",
  "cn_requests.acceptance.download": "Download",
  "cn_requests.acceptance.confirm": "Confirm",
  "cn_requests.acceptance.expiry_days": "CN Expiry Date",
  "cn_requests.acceptance.posted_amount": "Posted Amount",
  "cn_requests.acceptance.file_help": "PDF or XLSX · maximum 3.5 MB",
  "cn_requests.acceptance.confirming": "Confirming…",
  "cn_requests.payment.title": "CN Payment Details",
  "cn_requests.payment.original_amount": "Original Outstanding Amount",
  "cn_requests.payment.outstanding_amount": "Outstanding Amount",
  "cn_requests.payment.history": "Payment History",
  "cn_requests.payment.recovery_tasks": "Recovery Task History",
  "cn_requests.payment.update": "Update Payment Status",
  "cn_requests.payment.verify": "Verify Payment",
  "cn_requests.payment.final_cn_document": "Final CN Document",
  "cn_requests.payment.amount_paid": "Amount Paid",
  "cn_requests.payment.remaining_amount": "Remaining Amount",
  "cn_requests.payment.payment_date": "Payment Date",
  "cn_requests.payment.follow_up_date": "Follow-up Date",
  "cn_requests.payment.pending": "Pending",
  "cn_requests.payment.not_paid": "Not Paid",
  "cn_requests.payment.partial_paid": "Partial Paid",
  "cn_requests.payment.paid": "Paid",
  "cn_requests.payment.select_status": "Select payment status…",
  "cn_requests.payment.select_verified_status": "Select verified status…",
  "cn_requests.payment.save_status": "Save Payment Status",
  "cn_requests.payment.saving": "Saving…",
  "cn_requests.payment.verifying": "Verifying…",
  "cn_requests.payment.not_scheduled": "Not scheduled",
  "cn_requests.payment.admin_verified": "Admin verified",
  "cn_requests.payment.admin": "Admin",
  "cn_requests.payment.so_reported": "SO reported",
  "cn_requests.payment.system": "System",
  "cn_requests.payment.paid_suffix": "paid",
  "cn_requests.payment.remaining_suffix": "remaining",
  "cn_requests.payment.recorded_by": "recorded by",
  "cn_requests.payment.unavailable": "Payment details are unavailable.",
  "cn_requests.payment.verify_help": "Confirm or override the Sales Officer's reported status. Verification is authoritative. If a balance remains, its next Recovery task is scheduled automatically within the CN expiry window.",
  "cn_requests.payment.task_unscheduled": "UNSCHEDULED",
  "cn_requests.payment.task_scheduled": "SCHEDULED",
  "cn_requests.payment.task_completed": "COMPLETED",
  "cn_requests.cn_type.price_difference": "Price diff",
  "cn_requests.cn_type.freight": "Freight",
  "cn_requests.cn_type.scheme": "Scheme",
  "cn_requests.cn_type.demo": "Demo",
  "cn_requests.cn_type.damage_expiry": "Damage/Expiry",
  "cn_requests.cn_type.other": "Other",
  "cn_requests.col.days": "Days",
  "cn_requests.col.expires": "Expires",
  "cn_requests.col.action": "Action",
  "cn_requests.duration.day": "Day",
  "cn_requests.duration.days": "Days",
  // CN follow-up task (Daily Work → Recovery)
  "cn_requests.task.pending_title": "Pending CN Tasks",
  "cn_requests.task.cn_recovery": "CN Recovery",
  "cn_requests.task.cn_task": "CN Task",
  "cn_requests.task.task_date": "Task Date",
  "cn_requests.task.dealer": "Dealer",
  "cn_requests.task.reschedule_type": "Reschedule Type",
  "cn_requests.task.next_working_day": "Next Working Day",
  "cn_requests.task.rescheduled": "Rescheduled",
  "cn_requests.task.no_active": "No active CN Working tasks.",
  "cn_requests.task.schedule": "Schedule Task",
  "cn_requests.task.reschedule": "Reschedule",
  "cn_requests.task.party": "Party",
  "cn_requests.task.amount": "Amount",
  "cn_requests.task.reason": "Reason",
  "cn_requests.task.none_pending": "No pending CN tasks.",
  "cn_requests.task.update_payment": "Update Payment",
  "cn_requests.validation.select_party": "Select a party",
  "cn_requests.validation.valid_type": "Select a valid CN type",
  "cn_requests.validation.details_required": "Details is required.",
  "cn_requests.validation.rejection_reason_required": "Select a rejection reason.",
  "cn_requests.validation.other_reason_required": "Other Reason is required.",
  "cn_requests.validation.acceptance_status_required": "Select an acceptance status.",
  "cn_requests.validation.acceptance_reason_required": "Select an acceptance reason.",
  "cn_requests.validation.expiry_required": "CN Expiry Date is required.",
  "cn_requests.validation.expiry_invalid": "Enter a valid CN Expiry Date.",
  "cn_requests.validation.posted_amount_required": "Posted Amount is required.",
  "cn_requests.validation.posted_amount_invalid": "Posted Amount must be greater than 0.",
  "cn_requests.validation.outstanding_required": "Outstanding Amount is required.",
  "cn_requests.validation.outstanding_invalid": "Outstanding Amount must be greater than 0.",
  "cn_requests.validation.payment_status_required": "Select a payment status.",
  "cn_requests.validation.payment_date_required": "Payment Date is required.",
  "cn_requests.validation.payment_date_invalid": "Enter a valid Payment Date.",
  "cn_requests.validation.payment_amount_required": "Amount Paid is required.",
  "cn_requests.validation.payment_amount_invalid": "Amount Paid must be greater than 0 and less than the current outstanding amount.",
  "cn_requests.validation.follow_up_date_required": "Follow-up Date is required.",
  "cn_requests.validation.task_date_outside_expiry": "Selected task date is outside the CN expiry period.",
  "cn_requests.validation.task_date_sunday": "Sunday is not a valid CN task date.",
  "cn_requests.validation.default_task_date_unavailable": "The CN expiry period does not include the next working day.",
  "cn_requests.validation.valid_task_date": "A valid date is required",
  "cn_requests.validation.working_required": "CN Working document is required.",
  "cn_requests.validation.working_too_large": "CN Working document must be smaller than 3.5 MB.",
  "cn_requests.validation.working_filename_invalid": "CN Working filename is invalid.",
  "cn_requests.validation.working_file_type": "CN Working document must be a PDF or XLSX file.",
  "cn_requests.validation.working_content_type": "CN Working document content does not match its file type.",
  "cn_requests.validation.final_cn_required": "Final CN document is required to verify the payment as Paid.",
  "cn_requests.validation.final_cn_too_large": "Final CN document must be smaller than 3.5 MB.",
  "cn_requests.validation.final_cn_filename_invalid": "Final CN filename is invalid.",
  "cn_requests.validation.final_cn_file_type": "Final CN document must be a PDF or XLSX file.",
  "cn_requests.validation.final_cn_content_type": "Final CN document content does not match its file type.",
  "cn_requests.validation.acceptance_failed": "Acceptance failed",
  "cn_requests.validation.invalid_request": "Invalid CN Request",
  "cn_requests.validation.invalid_action": "Invalid CN Request action",
  "cn_requests.validation.invalid_acceptance": "Invalid CN Request acceptance",
  "cn_requests.validation.invalid_payment_update": "Invalid payment update",
  "cn_requests.validation.invalid_payment_verification": "Invalid payment verification",
  "cn_requests.error.create_role": "Only a Sales Officer or Regional Manager can raise a CN Request",
  "cn_requests.error.manager_team_only": "Only a Regional Manager can raise a request for a team member",
  "cn_requests.error.officer_not_on_team": "That Sales Officer is not on your team",
  "cn_requests.error.party_not_assigned": "That party is not assigned to the selected Sales Officer",
  "cn_requests.error.not_found": "CN Request not found",
  "cn_requests.error.cannot_view": "You cannot view this CN Request",
  "cn_requests.error.cannot_reject_own": "You cannot reject your own CN Request",
  "cn_requests.error.not_from_team": "This CN Request is not from your team",
  "cn_requests.error.submitted_reject_only": "Only a submitted CN Request can be rejected",
  "cn_requests.error.cannot_act": "You cannot act on this CN Request",
  "cn_requests.error.business_date": "Unable to resolve the business date",
  "cn_requests.error.admin_accept_only": "Only the Super Admin can accept a CN Request",
  "cn_requests.error.process_state": "Only a submitted or accepted, not-posted CN Request can be processed",
  "cn_requests.error.request_changed": "The CN Request changed while this action was being completed",
  "cn_requests.error.cannot_access_working": "You cannot access this CN Working document",
  "cn_requests.error.working_unavailable": "CN Working document is not available",
  "cn_requests.error.cannot_access_final": "You cannot access this Final CN document",
  "cn_requests.error.final_unavailable": "Final CN document is not available",
  "cn_requests.error.cannot_access_payment": "You cannot access this CN payment",
  "cn_requests.error.payment_tracking_unavailable": "Payment tracking is not available for this CN Request",
  "cn_requests.error.payment_key_used": "That payment update key is already in use",
  "cn_requests.error.owning_officer_payment": "Only the owner of this CN request (Sales Officer or Regional Manager) can report a CN payment",
  "cn_requests.error.payment_tracking_inactive": "Payment tracking is not active for this CN Request",
  "cn_requests.error.recovery_task_inactive": "This Recovery task is no longer active",
  "cn_requests.error.schedule_task_first": "Schedule and open the active Recovery task before updating its payment status",
  "cn_requests.error.payment_settled": "This CN payment is already settled",
  "cn_requests.error.settled_not_paid": "A settled payment cannot be marked Not Paid",
  "cn_requests.error.pending_update": "Pending is the initial payment state and cannot be selected as an update",
  "cn_requests.error.payment_changed": "The payment changed while this update was being completed",
  "cn_requests.error.admin_verify_only": "Only the Super Admin can verify a CN payment",
  "cn_requests.error.verification_key_used": "That verification key is already in use",
  "cn_requests.error.no_report_to_verify": "There is no reported payment status to verify yet",
  "cn_requests.error.pending_verify": "Pending cannot be verified",
  "cn_requests.error.payment_verify_changed": "The payment changed while it was being verified",
  "cn_requests.error.task_not_found": "CN Recovery task not found",
  "cn_requests.error.cannot_schedule_task": "You cannot schedule this CN task",
  "cn_requests.error.cn_task_inactive": "This CN Recovery task is no longer active",
  "cn_requests.error.task_changed": "This CN Recovery task changed while it was being scheduled",
  "cn_requests.error.not_legacy_task": "This is not a legacy CN follow-up task",
  "cn_requests.error.legacy_task_inactive": "Only an active legacy CN task can be scheduled",
  "cn_requests.error.task_not_materialized": "This Auto Task is not in today's editable Daily Plan and cannot be confirmed",
  "cn_requests.error.task_confirm_finalized": "Today's Daily Work is finalized and Auto Tasks can no longer be confirmed",

  /* =====================================================================================
   * SCHEME PLANNING — structural labels only (flip/tab buttons, view buttons, table column
   * headers and nested/collapsible table column headers). NEVER data. Every occurrence of a
   * key renders the same override for Admin / RM / Sales Officer and across all schemes.
   * ===================================================================================== */

  // Navigation / flip buttons (the top module bar, shared by all roles)
  "scheme_planning.nav.create_plan": "Create Plan",
  "scheme_planning.nav.view_plan": "View Plan",
  "scheme_planning.nav.follow_up": "Follow-up Plans",
  "scheme_planning.nav.follow_up_monitor": "Follow Up",

  // Follow Up hub — VIEW segmented control (Follow-up Type) + shared representation tabs
  "scheme_planning.follow_up.conversion": "Conversion Follow-up",
  "scheme_planning.follow_up.billing": "Billing Follow-up",
  "scheme_planning.follow_up.payment": "Payment Follow-up",
  "scheme_planning.follow_up.scheme_wise": "Scheme-wise Follow-up",
  "scheme_planning.follow_up.dealer_wise": "Dealer-wise Follow-up",
  // Conversion Follow-up — scheme-level columns
  "scheme_planning.follow_up.col.planned_dealers": "Planned Dealers",
  "scheme_planning.follow_up.col.planned_units": "Planned Sch. Units",
  "scheme_planning.follow_up.col.plan_amount_wo_gst": "Plan Amt. w/o GST",
  "scheme_planning.follow_up.col.sold_units": "Sold Sch. Units",
  "scheme_planning.follow_up.col.actual_amount_wo_gst": "Actual Amt. w/o GST",
  "scheme_planning.follow_up.col.booking_amount": "Booking Amt.",
  "scheme_planning.follow_up.col.document_status": "Doc. Status",
  // Conversion Follow-up — dealer-level columns
  "scheme_planning.follow_up.col.dealer": "Dealer",
  "scheme_planning.follow_up.col.planned_amount": "Planned Amt.",
  "scheme_planning.follow_up.col.conversion_date": "Conversion Date",
  "scheme_planning.follow_up.col.plan_status": "Plan Status",
  "scheme_planning.follow_up.col.scheme_status": "Scheme Status",
  "scheme_planning.follow_up.col.action": "Action",
  // Follow Up hub — page title/subtitle + empty/select states
  "scheme_planning.follow_up.title": "Follow Up",
  "scheme_planning.follow_up.subtitle": "Monitor conversion progress across scheme plans. Read-only aggregation over existing plan data.",
  "scheme_planning.follow_up.empty": "No approved scheme plans to follow up yet.",
  "scheme_planning.follow_up.select_officer": "Select a Sales Officer to view their conversion follow-up.",

  // Shared structural section headings (the boxed segmented-control captions)
  "scheme_planning.section.scope": "Scope",
  "scheme_planning.section.view": "View",
  "scheme_planning.section.plan_type": "Plan Type",

  // Shared states / common action buttons across Scheme Planning
  "scheme_planning.state.coming_soon": "Coming Soon",
  "scheme_planning.state.no_team_officers": "No Sales Officers on your team yet.",
  "scheme_planning.action.verify": "Verify",
  "scheme_planning.action.update": "Update",

  // View / secondary flip buttons
  "scheme_planning.view.scheme_wise": "Scheme-wise",
  "scheme_planning.view.dealer_wise": "Dealer-wise",
  "scheme_planning.view.enrolled_scheme": "Enrolled Scheme",
  // View Plan lifecycle tabs (Submitted | Approved | Enrolled Plans | Older Plans)
  "scheme_planning.view.submitted": "Submitted",
  "scheme_planning.view.approved": "Approved",
  "scheme_planning.view.enrolled_plans": "Enrolled Plans",
  "scheme_planning.view.older_plans": "Older Plans",
  // Submitted tab count strip
  "scheme_planning.view.total_schemes": "Total Schemes",
  "scheme_planning.view.rm_pending": "RM Pending",
  "scheme_planning.view.admin_pending": "Admin Pending",
  "scheme_planning.view.view_all_scheme": "View All Scheme",
  "scheme_planning.view.planned_scheme": "Planned Scheme",
  // Sales Officer Create Plan secondary tabs (Open Schemes | Draft)
  "scheme_planning.view.open_schemes": "Open Schemes",
  "scheme_planning.view.draft": "Draft",
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
  "scheme_planning.view.options": "Options", // Phase 10: Multiple Options achievement follow-up

  // Review / summary table column headers
  "scheme_planning.col.scheme": "Scheme",
  "scheme_planning.col.date_of_creation": "Date of Creation",
  "scheme_planning.col.scheme_type": "Scheme Type",
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
  "scheme_planning.col.billing_completion_status": "Billing Completion Status",
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
  "scheme_master.requirement.type.product": "Product Quantity Based",
  "scheme_master.requirement.type.value": "Value Based",
  "scheme_master.requirement.value_mode": "Value Mode",
  "scheme_master.requirement.value_mode.individual": "Individual",
  "scheme_master.requirement.value_mode.combined": "Combined",
  "scheme_master.requirement.combined_value": "Combined Required Value",
  "scheme_master.requirement.applicable_products": "Applicable Products",
  "scheme_master.requirement.add_product": "Add Product",
  "scheme_master.requirement.col.product": "Product",
  "scheme_master.requirement.col.required_qty": "Scheme Qty",
  "scheme_master.requirement.col.required_value": "Required Value",
  "scheme_master.requirement.col.rate_without_gst": "Rate W/O GST",
  "scheme_master.requirement.col.rate_with_gst": "Rate + GST",
  "scheme_master.requirement.col.amount_without_gst": "Amount W/O GST",
  "scheme_master.requirement.col.amount_with_gst": "Amount With GST",

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
  "scheme_master.col.options_quantity_scheme_value": "As Per Scheme",
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
  "scheme_master.form.booking_amount": "Credit Note Amt.",
  "scheme_master.form.value_without_gst": "Scheme Value (Without GST)",
  "scheme_master.form.value_with_gst": "Scheme Value (With GST)",
  // Phase 10 — Fixed vs Multiple Options structure
  // Phase 11 — Create/Edit Scheme section headers + pre-placement
  "scheme_master.form.section.basic": "Basic Scheme Information",
  "scheme_master.form.section.details": "Scheme Details",
  "scheme_master.form.section.payment": "Scheme Payment",
  "scheme_master.form.section.timeline": "Timeline",
  "scheme_master.form.section.benefit": "Scheme Benefit / Other Details",
  "scheme_master.form.section.document": "Scheme Document",
  "scheme_master.form.pre_placement_max_days": "Pre-placement (Max Days)",
  "scheme_master.form.structure": "Scheme Structure",
  "scheme_master.form.structure.fixed": "Fixed Scheme",
  "scheme_master.form.structure.options": "Options Scheme",
  "scheme_master.form.number_of_bills": "No. of Bills",
  "scheme_master.form.achievement_type": "Achievement Type",
  "scheme_master.form.achievement_type.quantity": "Product Quantity Based",
  "scheme_master.form.achievement_type.value": "Value Based",
  "scheme_master.form.eligible_products": "Eligible Products",
  "scheme_master.form.no_of_options": "No. of Options",
  "scheme_master.form.only_multiple": "Only for Multiple Options",
  "scheme_master.form.only_fixed": "Only for Fixed Scheme",
  "scheme_master.form.options_builder": "Options",
  "scheme_master.form.option_col.label": "Label",
  "scheme_master.form.option_col.target": "Target",
  "scheme_master.form.option_col.value_without_gst": "Value (Without GST)",
  "scheme_master.form.option_col.value_with_gst": "Value (With GST)",
  "scheme_master.form.option_col.active": "Active",
  "scheme_master.form.add_option": "Add Option",
  "scheme_master.form.scheme_benefit": "Scheme Benefit",
  "scheme_master.form.allow_multiple": "Allow Multiple Schemes",
  "scheme_master.form.max_extension_days": "Maximum Extension Days",
  "scheme_master.form.max_extension_attempts": "Maximum Extension Attempts",
  "scheme_master.form.benefit_details": "Enter Benefit Details",
  "scheme_master.form.other_benefit_details": "Other Benefit Details",
  "scheme_master.form.installment_builder": "Installment Rule Builder",
  "scheme_master.form.col_amount_derived": "Amount",
  "scheme_master.form.booking_note": "Booking Amount is included in the total Scheme Value and is deducted from the final installment. This adjusted final installment amount is used throughout the system.",
  "scheme_master.form.no_of_installments": "No. of Installments",
  "scheme_master.form.calculation_type": "Calculation Type",
  "scheme_master.form.col_percentage": "Percentage (%)",
  "scheme_master.form.col_amount": "Amount (₹)",
  "scheme_master.form.days_after_billing": "Days after Billing Date",
  "scheme_master.form.scheme_document": "Scheme Document",
  // Scheme Payment section — installment mode dropdown + payment table column/row headers
  "scheme_master.form.installment_mode": "Installment Mode",
  "scheme_master.form.installment_mode.percentage": "Percentage",
  "scheme_master.form.installment_mode.amount": "Amount",
  "scheme_master.form.col_scheme_payment": "Scheme Payment",
  "scheme_master.form.col_payment_details": "Payment Details",
  "scheme_master.form.row_booking_amount": "Booking Amount",
  "scheme_master.form.row_installment": "Installment",
  "scheme_master.form.row_total": "Total",
  // Options builder — the "Option" column header (rows render "Option 1", "Option 2", … dynamically)
  "scheme_master.form.option_col.option": "Option",
  // Generic form choices / actions used across the Create Scheme form
  "scheme_master.form.yes": "Yes",
  "scheme_master.form.no": "No",
  "scheme_master.form.remove": "Remove",
  "scheme_master.form.no_limit": "No Limit",
  "scheme_master.form.disabled": "Disabled",
  // Scheme Benefit dropdown display values (the underlying enum values are DB constants, never renamed)
  "scheme_master.form.benefit.domestic_tour": "Domestic Tour",
  "scheme_master.form.benefit.foreign_tour": "Foreign Tour",
  "scheme_master.form.benefit.credit_note": "Credit Note",
  "scheme_master.form.benefit.special_gift": "Special Gift",
  "scheme_master.form.benefit.gold_silver": "Gold / Silver",
  "scheme_master.form.benefit.other": "Other",

  /* =====================================================================================
   * SCHEME UPLOAD (Phase 7) — the dedicated date-range achievement upload tab. Structural
   * labels only (tab, step headings, field labels). Never data. Never renames DB enums.
   * ===================================================================================== */
  "scheme_bills.count": "Number of Bills",
  "scheme_bills.so_date": "SO Date",
  "scheme_bills.admin_date": "Admin Date",
  "scheme_upload.tab": "Scheme Upload",
  "scheme_upload.title": "Scheme Upload",
  "scheme_upload.select_schemes": "Select Schemes",
  "scheme_upload.start_date": "Start Date",
  "scheme_upload.end_date": "End Date",
  "scheme_upload.file": "Sales Register (.xlsx)",
  "scheme_upload.analyze": "Analyze",
  "scheme_upload.review": "Review",
  "scheme_upload.confirm_import": "Confirm Import",

  /* =====================================================================================
   * CALENDAR (operational calendar over Scheme Planning). Structural, user-visible labels only —
   * conversion events are projected from DealerSchemePlan, never stored, and are never renamed here.
   * ===================================================================================== */
  "calendar.nav": "Calendar",
  "calendar.title": "Calendar",
  "calendar.today": "Today",
  "calendar.prev_month": "Previous Month",
  "calendar.next_month": "Next Month",
  "calendar.all_officers": "All Sales Officers",
  "calendar.conversion": "Conversion",
  // Party Appointment calendar event (Phase 2) — projected from APPROVED Party Plans onto the same calendar.
  "calendar.party_appointment": "Party Appointment",
  "calendar.market": "Market",
  "calendar.note": "Note",
  "calendar.add_note": "Add Note",
  "calendar.edit_note": "Edit Note",
  "calendar.delete_note": "Delete Note",
  "calendar.save_note": "Save Note",
  "calendar.cancel": "Cancel",
  "calendar.note_placeholder": "Write a note for this day…",
  "calendar.date_changed": "Date changed",
  "calendar.previous_date": "Previous Date",
  "calendar.new_date": "New Date",
  "calendar.upcoming": "Upcoming",
  "calendar.upcoming_days": "Upcoming — Next 5 Days",
  "calendar.no_upcoming": "No upcoming events.",
  "calendar.no_events": "No events on this date.",
  "calendar.my_calendar": "My Calendar",
  "calendar.team_calendar": "Team Calendar",
  "calendar.all_states": "All States",
  "calendar.sales_officer": "Sales Officer",
  "calendar.add_task": "Add Daily Task",
  "calendar.add_reminder": "Add Reminder",
  "calendar.kind.task": "Calendar Task",
  "calendar.kind.meeting": "Meeting",
  "calendar.kind.reminder": "Reminder",
  "calendar.kind.other": "Other",
  "calendar.added_by": "Added by",
  "calendar.task_type": "Task Type",
  "calendar.dealer": "Dealer",
  "calendar.select_dealer": "Select a dealer",
  "calendar.amount": "Today's Plan (₹)",
  "calendar.payment_mode": "Payment Mode",
  "calendar.dealer_name": "Dealer name",
  "calendar.market_name": "Market",
  "calendar.dealer_visits": "Number of Dealer Visits",
  "calendar.new_party_visits": "Number of New Party Visits",
  "calendar.details": "Details",
  "calendar.reminder_placeholder": "Reminder…",
  "calendar.task_details_placeholder": "Describe the task…",
  "calendar.save": "Save",
  "calendar.delete": "Delete",
  "calendar.in_daily_work": "In Daily Work",
  "calendar.task_past_date": "Daily Tasks can only be added for today or a future date.",
  "calendar.no_dealers": "No dealers are assigned to you.",
  "calendar.schemes": "Schemes",
  "calendar.scheme": "Scheme",
  // Event status chips (derived from the plan's existing planStatus + schemeStatus — display only)
  "calendar.status.planned": "Planned",
  "calendar.status.submitted": "Submitted",
  "calendar.status.approved": "Approved",
  "calendar.status.converted": "Converted",
  "calendar.status.enrolled": "Enrolled",
  "calendar.status.declined": "Declined",
  "calendar.status.returned": "Returned",
  "calendar.status.rejected": "Rejected",

  /* =====================================================================================
   * PARTY PLANNING (Phase 1) — a minimal Sales Officer planning module with a
   * Draft → Submit → Admin Approval workflow. Structural, user-visible text only (module title,
   * Create Plan | View toggle, the two View tabs, table column headers, and the row actions).
   * Never data; never renames the DB status constants (DRAFT | PENDING_APPROVAL | APPROVED | REJECTED).
   * ===================================================================================== */
  "party_planning.title": "Party Planning",
  // Navigation — the module's Create Plan | View toggle
  "party_planning.nav.create_plan": "Create Plan",
  "party_planning.nav.view": "View",
  // View tabs
  "party_planning.view.submitted": "Submitted",
  "party_planning.view.approved": "Approved",
  // Table columns
  "party_planning.col.party_name": "Party Name",
  "party_planning.col.market_name": "Market Name",
  "party_planning.col.appointment_date": "Date of Appointment",
  "party_planning.col.status": "Status",
  "party_planning.col.action": "Action",
  // Actions
  "party_planning.action.add_row": "Add Row",
  "party_planning.action.save_draft": "Save Draft",
  "party_planning.action.submit": "Submit",
  "party_planning.action.approve": "Approve",
  "party_planning.action.reject": "Reject",

  /* =====================================================================================
   * DAILY WORK — every static, user-facing word used by the Daily Work page and its validation
   * responses. Dynamic dealer/scheme names, dates, amounts and counts remain data. The combined-summary
   * row and Pending are always DERIVED from dealer rows; labels never affect stored business values.
   * ===================================================================================== */
  // Page
  "daily_work.title": "Daily Work",
  "daily_work.page.breadcrumb_planning": "Planning",
  "daily_work.page.subtitle": "Plan and record your day. Monthly plan and pending are read-only; enter today's plan, then the result after submitting.",
  "daily_work.view.plan": "Daily Plan",
  "daily_work.view.report": "Daily Report",
  "daily_work.container.plan_report": "Daily Plan & Daily Report",
  "daily_work.container.cn_tasks": "CN Tasks",
  "daily_work.container.planning": "Daily Work Planning",
  "daily_work.container.daily_task": "Daily Task",
  "daily_work.col.task_type": "Task Type",
  "daily_work.task_type.auto": "Auto Task",
  "daily_work.task_type.manual": "Manual",
  "daily_work.task_type.calendar": "Calendar",
  "daily_work.col.plan_type": "Plan Type",
  "daily_work.col.select_task_date": "Select Task Date",
  "daily_work.report.no_submitted": "No submitted Daily Report for this date.",
  "daily_work.report.no_submitted_section": "No submitted data for this section.",
  "daily_work.report.plan_submitted": "Plan Submitted",
  "daily_work.report.report_submitted": "Report Submitted",
  "daily_work.report.complete": "Complete Daily Report",
  "daily_work.report.locked": "Daily Report Locked",
  // Sections
  "daily_work.section.sales": "Sales",
  "daily_work.section.recovery": "Recovery",
  "daily_work.section.appointment": "Dealer Appointment",
  "daily_work.section.scheme_conversion": "Scheme Conversion",
  "daily_work.section.visits": "Visits",
  "daily_work.section.others": "Others",
  // Shared columns (`col.dealer` and `col.pending` are reused from the global column dictionary)
  "daily_work.col.todays_plan": "Today's Plan",
  "daily_work.col.batch": "Batch",
  // Sales columns
  "daily_work.col.monthly_sales_plan": "Monthly Sales Plan",
  "daily_work.col.sales_type": "Sales Type",
  "daily_work.col.todays_sales": "Today's Sales",
  // Recovery columns
  "daily_work.col.monthly_recovery_plan": "Monthly Recovery Plan",
  "daily_work.col.recovery_type": "Recovery Type",
  "daily_work.col.payment_mode": "Payment Mode",
  "daily_work.payment_mode.cheque": "Cheque",
  "daily_work.payment_mode.upi": "UPI",
  "daily_work.payment_mode.neft_rtgs": "NEFT/RTGS",
  "daily_work.payment_mode.cash": "Cash",
  "daily_work.placeholder.payment_mode": "Select...",
  "daily_work.col.todays_recovery": "Today's Recovery",
  // Type options (shared concept)
  "daily_work.type.regular": "Regular",
  "daily_work.type.scheme": "Scheme",
  "daily_work.type.mixed": "Mixed",
  // Dynamic count nouns
  "daily_work.count.dealers": "Dealers",
  "daily_work.count.markets": "Markets",
  // Actions
  "daily_work.action.add_dealer": "Add Dealer",
  "daily_work.add_dealer.choose": "Choose Dealer",
  "daily_work.action.add_row": "Add Row",
  "daily_work.action.remove_dealer": "Remove dealer",
  "daily_work.action.remove_row": "Remove row",
  "daily_work.action.save_draft": "Save Draft",
  "daily_work.action.submit": "Submit",
  "daily_work.action.save_actuals": "Save Actuals",
  "daily_work.action.no_plan": "No Plan",
  "daily_work.action.undo_no_plan": "Undo No Plan",
  "daily_work.action.submit_day": "Submit Daily Work",
  "daily_work.action.submit_report": "Submit Daily Report",
  "daily_work.action.cancel": "Cancel",
  "daily_work.action.confirm_auto_task": "Confirm",
  "daily_work.action.confirm_reschedule": "Confirm Reschedule",
  "daily_work.state.auto_task_confirmed": "Confirmed",
  "daily_work.state.saving": "Saving…",
  "daily_work.state.saved": "Saved",
  "daily_work.state.save_failed": "Save failed — will retry",
  "daily_work.state.submitting": "Submitting…",
  // Daily self-rating (captured at day-level Submit; stored on the day's record)
  "daily_work.rating.title": "Submit Daily Report",
  "daily_work.rating.prompt": "Rate your performance for today",
  "daily_work.rating.field": "Rating",
  "daily_work.rating.placeholder": "Select / enter rating",
  "daily_work.rating.self_rating": "Self Rating",
  // Section 3 — Dealer Appointment
  "daily_work.col.market": "Market",
  "daily_work.col.monthly_dealer_plan": "Monthly Dealer Plan",
  "daily_work.col.todays_appointment": "Today's Appointment / Work Information",
  "daily_work.col.appointment_status": "Appointment Status / Result",
  "daily_work.status.appointed": "Appointed",
  "daily_work.status.not_appointed": "Not Appointed",
  // Section 4 — Scheme Conversion
  "daily_work.col.scheme": "Scheme",
  "daily_work.col.planned_scheme_units": "Planned Scheme Units",
  "daily_work.col.todays_conversion": "Today's Conversion / Achievability",
  "daily_work.achievability.yes": "Yes",
  "daily_work.achievability.no": "No",
  // Shared neutral combined states
  "daily_work.combined.multiple": "Multiple",
  "daily_work.combined.none": "—",
  // Section 5 — Visits
  "daily_work.visits.dealer_visits": "Dealer Visits",
  "daily_work.visits.new_party_visits": "New Party Visits",
  "daily_work.visits.planned_dealer_visits": "Planned Dealer Visits",
  "daily_work.visits.planned_new_party_visits": "Planned New Party Visits",
  "daily_work.visits.actual_dealer_visits": "Actual Dealer Visits",
  "daily_work.visits.actual_new_party_visits": "Actual New Party Visits",
  // Section 6 — Others
  "daily_work.others.placeholder": "Anything else you want to record about your day…",
  // Section completion / progress bar / No Plan
  "daily_work.status.filled": "Filled",
  "daily_work.status.no_plan": "No Plan",
  "daily_work.status.remaining": "Remaining",
  "daily_work.progress.sections": "Sections",
  // Select/input placeholders and empty states
  "daily_work.placeholder.select_dealer": "Select a dealer…",
  "daily_work.placeholder.no_more_dealers": "No more dealers",
  "daily_work.placeholder.select_scheme": "Select scheme…",
  "daily_work.placeholder.no_applicable_schemes": "No applicable schemes",
  "daily_work.placeholder.dealer_name": "Dealer name",
  "daily_work.placeholder.market": "Market",
  "daily_work.placeholder.select_status": "Select status…",
  "daily_work.placeholder.select_achievability": "Select…",
  "daily_work.placeholder.no_planned_scheme_dealers": "No dealers with planned schemes",
  "daily_work.empty.sales": "Add a dealer to start your daily sales plan.",
  "daily_work.empty.recovery": "Add a dealer to start your daily recovery plan.",
  "daily_work.empty.scheme_conversion": "Add a dealer with a planned scheme to start.",
  // Validation and API error messages. Braced tokens are replaced with authoritative server values.
  "daily_work.validation.valid_date": "A valid date is required",
  "daily_work.validation.valid_amount": "Enter a valid amount",
  "daily_work.validation.whole_number": "Enter a whole number",
  "daily_work.validation.not_negative": "Cannot be negative",
  "daily_work.validation.invalid_option": "Select a valid option",
  "daily_work.validation.too_many_rows": "Too many rows were submitted",
  "daily_work.validation.plan_units": "Today's Plan must be a whole number from 0 to 6",
  "daily_work.validation.dealer_name_length": "Dealer name cannot exceed 200 characters",
  "daily_work.validation.market_length": "Market cannot exceed 200 characters",
  "daily_work.validation.others_length": "Others cannot exceed 5,000 characters",
  "daily_work.validation.owner_only": "Only a Sales Officer can create Daily Work",
  "daily_work.validation.dealer_not_assigned": "That dealer is not assigned to you",
  "daily_work.validation.duplicate_dealer": "The same dealer cannot be added twice",
  "daily_work.validation.select_sales_scheme": "Select a scheme for the Scheme type",
  "daily_work.validation.scheme_not_applicable": "That scheme is not applicable",
  "daily_work.validation.add_dealer_before_submit": "Add at least one dealer before submitting",
  "daily_work.validation.actuals_after_submit": "Today's actuals can be entered only after the daily work is submitted",
  "daily_work.validation.duplicate_appointment": "Duplicate appointment row",
  "daily_work.validation.appointment_after_submit": "Appointment status can be entered only after the daily work is submitted",
  "daily_work.validation.duplicate_dealer_scheme": "The same dealer + scheme cannot be added twice",
  "daily_work.validation.scheme_not_planned": "That scheme is not planned for this dealer",
  "daily_work.validation.plan_exceeds_pending": "Today's Plan cannot exceed Pending ({pending})",
  "daily_work.validation.add_conversion_before_submit": "Add at least one dealer + scheme before submitting",
  "daily_work.validation.achievability_after_submit": "Achievability can be entered only after the daily work is submitted",
  "daily_work.validation.no_plan_has_data": "This section has data — No Plan is not available",
  "daily_work.validation.complete_sections": "Complete or mark No Plan for: {sections}",
  "daily_work.validation.confirm_auto_tasks": "Confirm every Auto Task in Recovery before submitting Daily Work.",
  "daily_work.validation.rating_required": "Please select a rating from 1 to 10.",
  "daily_work.validation.already_submitted": "Daily Work for this date has already been submitted.",
  "daily_work.validation.day_finalized": "Daily Report for this date is finalized and locked.",
  "daily_work.validation.report_already_submitted": "Daily Report for this date has already been submitted.",
  "daily_work.validation.empty_batch": "The current Daily Plan is empty.",
  "daily_work.validation.payment_mode_required": "Select Payment Mode for recovery amount.",
  "daily_work.validation.previous_report_required": "Submit the previous day's Daily Report before submitting today's Daily Plan.",
  "daily_work.report.for_date": "Daily Report for {date}",
  "daily_work.report.missed": "Daily Report missed — submission deadline was 12:00 PM.",
  "daily_work.performance.report_missed": "Missed",
  "daily_work.validation.report_deadline_passed": "The Daily Report can only be submitted until 12:00 PM on the following day. This deadline has passed.",
  "daily_work.validation.plan_required": "Please enter a Today's Plan greater than 0 for:\n{rows}",
  "daily_work.validation.complete_report": "Complete Daily Report results for: {sections}",
  "daily_work.validation.complete_current_plan": "New Auto Tasks were added to the current Daily Plan. Submit that plan before finalizing the Daily Report.",
  "daily_work.validation.auto_task_amount": "Refresh Daily Work before saving. Today's Plan must retain the active Auto Task amount.",
  "daily_work.validation.section_submit_removed": "Use Submit Daily Work to submit the complete planning batch.",
  "daily_work.validation.enter_visit_actuals": "Enter both actual visit counts for at least one batch.",
  // Phase 2 — RM Team Performance + immutable RM review
  "daily_work.team.title": "Team Performance",
  "daily_work.team.breadcrumb": "Performance",
  "daily_work.team.subtitle": "Review your Sales Officers' submitted Daily Work and rate each one.",
  "daily_work.team.date": "Date",
  "daily_work.team.col.sales_officer": "Sales Officer",
  "daily_work.team.col.submission": "Submission",
  "daily_work.team.col.self_rating": "Self Rating",
  "daily_work.team.col.rm_rating": "RM Rating",
  "daily_work.team.col.action": "Action",
  "daily_work.team.action.view": "View",
  "daily_work.team.submitted": "Submitted",
  "daily_work.team.not_submitted": "Not Submitted",
  "daily_work.team.empty": "No Sales Officers in your team.",
  "daily_work.team.summary.sales_officers": "Sales Officers",
  "daily_work.team.summary.submitted": "Submitted",
  "daily_work.team.summary.not_submitted": "Not Submitted",
  "daily_work.team.summary.avg_self_rating": "Average Self Rating",
  "daily_work.team.summary.avg_rm_rating": "Average RM Rating",
  "daily_work.review.title": "Daily Work Review",
  "daily_work.col.review_planned": "Planned",
  "daily_work.col.review_actual": "Actual",
  "daily_work.col.review_metric": "Metric",
  "daily_work.col.review_item": "Item",
  "daily_work.col.review_dealer_client": "Dealer / Client",
  "daily_work.review.no_data": "No {section} data",
  "daily_work.review.self_rating": "SO Self Rating",
  "daily_work.review.rm_review": "RM Review",
  "daily_work.review.not_rated": "Not Rated",
  "daily_work.review.rate_prompt": "Rate this Sales Officer's day",
  "daily_work.review.field": "RM Rating",
  "daily_work.review.placeholder": "Select / enter rating",
  "daily_work.review.submit": "Submit Rating",
  "daily_work.review.reviewer": "Reviewed by",
  "daily_work.review.reviewed_at": "Reviewed at",
  "daily_work.review.locked": "Locked",
  "daily_work.review.reviewer_only": "Only a Regional Manager can review a Sales Officer's Daily Work.",
  "daily_work.review.invalid_officer": "That Sales Officer is not in your team.",
  "daily_work.review.not_submitted": "This Daily Work has not been submitted yet.",
  "daily_work.review.report_not_submitted": "Daily Report has not been submitted yet.",
  "daily_work.review.already_reviewed": "This Daily Work has already been reviewed.",
  "daily_work.review.rating_required": "Please select a rating from 1 to 10.",
  // Phase 3 — Admin company-wide Performance dashboard (read-only)
  "daily_work.performance.title": "Performance",
  "daily_work.performance.breadcrumb": "Insights",
  "daily_work.performance.subtitle": "Company-wide Daily Work performance for the selected business date.",
  "daily_work.performance.admin_only": "Only an administrator can view company-wide performance.",
  "daily_work.performance.col.rm": "RM",
  "daily_work.performance.col.group": "Group",
  "daily_work.performance.summary.total_officers": "Total Sales Officers",
  "daily_work.performance.filter.rm": "RM",
  "daily_work.performance.filter.group": "Group",
  "daily_work.performance.filter.submission": "Submission",
  "daily_work.performance.filter.all": "All",
  "daily_work.performance.filter.all_rms": "All RMs",
  "daily_work.performance.filter.all_sales_officers": "All Sales Officers",
  "daily_work.performance.filter.all_groups": "All Groups",
  "daily_work.performance.empty": "No Sales Officers match these filters.",
  "daily_work.performance.no_rm": "No RM",
  // Phase 4 — role-aware, date-range performance + attendance
  "daily_work.performance.forbidden": "You do not have access to this performance data.",
  "daily_work.performance.invalid_range": "The From date must be on or before the To date.",
  "daily_work.performance.range_too_large": "Please choose a shorter date range.",
  "daily_work.performance.invalid_officer": "That Sales Officer is not valid.",
  "daily_work.performance.attendance_admin_only": "Only an administrator can change attendance.",
  "daily_work.performance.my_title": "My Performance",
  "daily_work.performance.team_title": "Team Performance",
  "daily_work.performance.company_title": "Company Performance",
  "daily_work.performance.date_from": "Date From",
  "daily_work.performance.date_to": "Date To",
  "daily_work.performance.col.date": "Date",
  "daily_work.performance.col.attendance": "Attendance",
  "daily_work.performance.col.plan_submission": "Plan Submission",
  "daily_work.performance.col.report_submission": "Report Submission",
  "daily_work.performance.col.state": "State",
  "daily_work.performance.attendance.present": "Present",
  "daily_work.performance.attendance.absent": "Absent",
  "daily_work.performance.attendance.leave": "Leave",
  "daily_work.performance.attendance.holiday": "Holiday",
  "daily_work.performance.filter.all_states": "All States",
  "daily_work.performance.summary.my_attendance": "My Attendance",
  "daily_work.performance.summary.attendance": "Attendance",
  "daily_work.performance.summary.submitted_plans": "Submitted Plans",
  "daily_work.performance.summary.submitted_reports": "Submitted Reports",
  // Admin-only Daily Work submitted-report viewer
  "daily_work.admin.subtitle": "View a Sales Officer's submitted Daily Report by date and State.",
  "daily_work.admin.select_state": "Select State…",
  "daily_work.admin.select_officer": "Select Sales Officer…",
  "daily_work.admin.choose_state": "Select a State to view its Sales Officers.",
  "daily_work.admin.choose_officer": "Select a Sales Officer to view their submitted Daily Report.",
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
  assign("scheme_planning.section.", "Sections");
  assign("scheme_planning.state.", "View Buttons");
  assign("scheme_planning.action.", "Navigation / Flip Buttons");
  assign("scheme_planning.view.", "View Buttons");
  assign("scheme_planning.follow_up.", "View Buttons"); // sub-tabs (broad) …
  assign("scheme_planning.follow_up.col.", "Table Columns"); // … then columns override
  assign("scheme_planning.col.", "Table Columns");
  assign("scheme_planning.nested.", "Nested/Collapsible Table Columns");
  assign("scheme_planning.enrolled.col.", "Table Columns");
  assign("scheme_planning.enrolled.inst.", "Nested/Collapsible Table Columns");
})();

/** Classify any key into { module, group } — explicit Scheme Planning metadata first, else by prefix. */
export function labelMeta(key: LabelKey): LabelMeta {
  if (key.startsWith("historical_daybook.")) return { module: "Historical Daybook", group: key.endsWith(".date") || key.endsWith(".voucher") || key.endsWith(".decision") ? "Table Columns" : "View Buttons" };
  const explicit = SCHEME_PLANNING_META[key];
  if (explicit) return explicit;
  if (key.startsWith("scheme_master.requirement.col.")) return { module: "Scheme Master", group: "Table Columns" };
  if (key.startsWith("scheme_master.requirement.section")) return { module: "Scheme Master", group: "Sections" };
  if (key.startsWith("scheme_master.form.")) return { module: "Scheme Master", group: "Form Fields" };
  if (key.startsWith("scheme_master.col.")) return { module: "Scheme Master", group: "Table Columns" };
  if (key.startsWith("scheme_master.page.") || key.startsWith("scheme_master.action.") || key.startsWith("scheme_master.filter.") || key.startsWith("scheme_master.view.")) return { module: "Scheme Master", group: "View Buttons" };
  if (key.startsWith("scheme_master.")) return { module: "Scheme Master", group: "View Buttons" };
  if (key.startsWith("scheme_upload.")) return { module: "Scheme Upload", group: "View Buttons" };
  if (key.startsWith("party_planning.col.")) return { module: "Party Planning", group: "Table Columns" };
  if (key.startsWith("party_planning.nav.") || key.startsWith("party_planning.view.")) return { module: "Party Planning", group: "Navigation / Flip Buttons" };
  if (key.startsWith("party_planning.")) return { module: "Party Planning", group: "View Buttons" };
  if (key.startsWith("daily_work.col.")) return { module: "Daily Work", group: "Table Columns" };
  if (key.startsWith("daily_work.section.")) return { module: "Daily Work", group: "Navigation / Flip Buttons" };
  if (key.startsWith("daily_work.placeholder.") || key.startsWith("daily_work.empty.") || key.startsWith("daily_work.validation.") || key.startsWith("daily_work.field.") || key.startsWith("daily_work.others.") || key.startsWith("daily_work.visits.")) return { module: "Daily Work", group: "Form Fields" };
  if (key.startsWith("daily_work.")) return { module: "Daily Work", group: "View Buttons" };
  if (key.startsWith("cn_requests.col.")) return { module: "CN Requests", group: "Table Columns" };
  if (key.startsWith("cn_requests.field.")) return { module: "CN Requests", group: "Table Columns" };
  if (key.startsWith("cn_requests.create.") || key.startsWith("cn_requests.detail.") || key.startsWith("cn_requests.payment.") || key.startsWith("cn_requests.task.") || key.startsWith("cn_requests.validation.") || key.startsWith("cn_requests.error.") || key.startsWith("cn_requests.cn_type.")) return { module: "CN Requests", group: "Form Fields" };
  if (key.startsWith("cn_requests.acceptance.")) return { module: "CN Requests", group: "Form Fields" };
  if (key.startsWith("cn_requests.rejection.")) return { module: "CN Requests", group: "Form Fields" };
  if (key.startsWith("cn_requests.action.") || key.startsWith("cn_requests.state.") || key.startsWith("cn_requests.status.") || key.startsWith("cn_requests.page.")) return { module: "CN Requests", group: "View Buttons" };
  if (key.startsWith("cn_requests.")) return { module: "CN Requests", group: "Navigation / Flip Buttons" };
  if (key.startsWith("calendar.")) return { module: "Calendar", group: "View Buttons" };
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
