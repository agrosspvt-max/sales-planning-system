/**
 * Party Planning · Monthly Planning — pure rules (no database). A Monthly Plan row (one market) has ONE operational status; Option 1 /
 * Option 2 are only the two candidate party names. The transition table below is the single definition of that workflow:
 * the server applies it and the UI only reads it.
 *
 *   NONE ──SO──► DOC_SENT ──Admin──► DOC_RECEIVED ──Admin──► SD_BOUNCE ──Admin──► APPOINTED   (terminal)
 *     │              │                    └──────────────────────┴───────────────────► REJECTED   (Admin, terminal)
 *     └──────────────┴─► REJECTED (Admin)
 *
 * NONE means the status workflow has not begun. It can begin only once the PLAN is approved (a separate, plan-level approval); an operational
 * status change never approves a plan. Only the owning SO/RM moves NONE → DOC_SENT; every other step is an Admin step.
 */

export const ROW_STATUSES = ["NONE", "DOC_SENT", "DOC_RECEIVED", "SD_BOUNCE", "APPOINTED", "REJECTED"] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
export const OPTION_NUMBERS = [1, 2] as const;
export type OptionNo = (typeof OPTION_NUMBERS)[number];

export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  NONE: "Approved", DOC_SENT: "Doc Send By SO", DOC_RECEIVED: "Doc Received", SD_BOUNCE: "SD Bounce", APPOINTED: "Appointed", REJECTED: "Rejected",
};
export const isRowStatus = (v: unknown): v is RowStatus => typeof v === "string" && (ROW_STATUSES as readonly string[]).includes(v);

/** What the Status column shows: the operational status once it has begun, otherwise the plan's own stage (Draft / Submitted / Approved). */
export function displayRowStatus(rowStatus: string, planApprovalStatus: string): string {
  if (isRowStatus(rowStatus) && rowStatus !== "NONE") return ROW_STATUS_LABEL[rowStatus];
  if (planApprovalStatus === "APPROVED") return "Approved";
  if (planApprovalStatus === "PENDING_RM" || planApprovalStatus === "PENDING_ADMIN") return "Submitted";
  return "Draft";
}

export type Actor = "OWNER" | "ADMIN";
export const TRANSITIONS: Record<RowStatus, { to: RowStatus; actor: Actor }[]> = {
  NONE: [{ to: "DOC_SENT", actor: "OWNER" }, { to: "REJECTED", actor: "ADMIN" }],
  DOC_SENT: [{ to: "DOC_RECEIVED", actor: "ADMIN" }, { to: "REJECTED", actor: "ADMIN" }],
  DOC_RECEIVED: [{ to: "SD_BOUNCE", actor: "ADMIN" }, { to: "APPOINTED", actor: "ADMIN" }, { to: "REJECTED", actor: "ADMIN" }],
  SD_BOUNCE: [{ to: "APPOINTED", actor: "ADMIN" }, { to: "REJECTED", actor: "ADMIN" }],
  APPOINTED: [],
  REJECTED: [],
};

/** Who may make this exact move, or null when the move does not exist. */
export function transitionActor(from: string, to: string): Actor | null {
  if (!isRowStatus(from) || !isRowStatus(to)) return null;
  return TRANSITIONS[from].find((t) => t.to === to)?.actor ?? null;
}
/** The existing Dealer-Appointment permission action an Admin needs for the target status (rejection → reject, every other step → approve). */
export const adminActionFor = (to: RowStatus): "approve" | "reject" => (to === "REJECTED" ? "reject" : "approve");

/* ------------------------------------------------ transition payloads ------------------------------------------------ */

/** What the SO says was sent / what Admin says was actually received. `other` is free text, never a checkbox. */
export interface DocInfo { documents: boolean; checks: boolean; other: string | null }
const MAX_TEXT = 500;
const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** At least one of Document / Check must be ticked; "Other" is optional free text. Stored exactly as given. */
export function parseDocInfo(raw: unknown): { ok: true; value: DocInfo } | { ok: false; message: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const documents = r.documents === true, checks = r.checks === true;
  if (!documents && !checks) return { ok: false, message: "Select at least one of Document or Check." };
  const other = text(r.other);
  if (other.length > MAX_TEXT) return { ok: false, message: `Other can be at most ${MAX_TEXT} characters.` };
  return { ok: true, value: { documents, checks, other: other || null } };
}

export type TransitionInput =
  | { to: "DOC_SENT"; sent: DocInfo }
  | { to: "DOC_RECEIVED"; received: DocInfo }
  | { to: "SD_BOUNCE" | "APPOINTED" | "REJECTED"; remarks: string | null };

/** Validates the data a transition requires. Nothing the browser sends is trusted beyond these fields (actor, date and status come from the server). */
export function parseTransition(raw: unknown): { ok: true; value: TransitionInput } | { ok: false; message: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const to = r.to;
  if (!isRowStatus(to) || to === "NONE") return { ok: false, message: "Choose a valid status." };
  if (to === "DOC_SENT" || to === "DOC_RECEIVED") {
    const info = parseDocInfo(to === "DOC_SENT" ? r.sent : r.received);
    if (!info.ok) return info;
    return { ok: true, value: to === "DOC_SENT" ? { to, sent: info.value } : { to, received: info.value } };
  }
  const remarks = text(r.remarks);
  if (remarks.length > MAX_TEXT) return { ok: false, message: `Remarks can be at most ${MAX_TEXT} characters.` };
  return { ok: true, value: { to, remarks: remarks || null } };
}

export function validatePartyName(value: unknown, required: boolean): string | null {
  const name = text(value);
  if (!name) return required ? "Party Name is required." : null;
  return name.length > 200 ? "Party Name can be at most 200 characters." : null;
}
export const cleanParty = (value: unknown): string | null => text(value) || null;

/* ------------------------------------------------ month / date ------------------------------------------------ */

export const monthKey = (m: { calendarMonth: number | null; calendarYear: number | null }): string | null =>
  m.calendarMonth && m.calendarYear ? `${m.calendarYear}-${String(m.calendarMonth).padStart(2, "0")}` : null;

/** A plan date is a plain calendar date that must fall inside the chosen season month. */
export function validatePlanDate(value: unknown, month: { calendarMonth: number | null; calendarYear: number | null }): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Enter a valid plan date.";
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return "Enter a valid plan date.";
  const key = monthKey(month);
  if (!key) return "This season month has no calendar identity; the plan date cannot be validated.";
  return value.startsWith(key) ? null : "The plan date must be inside the selected month.";
}

/** The status a Monthly Plan (the per-season-month header) shows in the list, derived from its rows: none → Draft; every row Appointed / Rejected → Completed; else In Progress. */
export type MonthlySheetStatus = "Draft" | "In Progress" | "Completed";
export function monthlySheetStatus(rows: { opStatus: string }[]): MonthlySheetStatus {
  if (rows.length === 0) return "Draft";
  return rows.every((r) => r.opStatus === "APPOINTED" || r.opStatus === "REJECTED") ? "Completed" : "In Progress";
}
/** Row statuses that are waiting on an Admin: what Admin filters by to find work. */
export const ADMIN_PENDING_STATUSES: readonly RowStatus[] = ["DOC_SENT", "DOC_RECEIVED", "SD_BOUNCE"];

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD business dates); never negative. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * The "Days" aging metric of a Monthly Plan row: Seasonal Plan ADDED date → the date the row became Appointed (frozen), or → today while it
 * has not (live). The Monthly Plan's own creation date is never involved.
 */
export function conversionDays(seasonalAddedOn: string, appointedOn: string | null, today: string): { days: number; final: boolean } {
  return appointedOn ? { days: daysBetween(seasonalAddedOn, appointedOn), final: true } : { days: daysBetween(seasonalAddedOn, today), final: false };
}

/** Summary of a row's Conversion Date history: only HAND edits by the SO are counted; automatic status-change dates and (older) Admin confirmations are not. */
export function summarizeDateHistory(changes: readonly { byAdmin: boolean; automatic?: boolean }[]): { soChanges: number } {
  return { soChanges: changes.filter((c) => !c.byAdmin && !c.automatic).length };
}

/* ------------------------------------------------ plan lifecycle (Create | Submitted | Approved | Older Plans) ------------------------------------------------ */

export const PLAN_STAGES = ["create", "submitted", "approved", "older"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];
export const STAGE_LABEL: Record<PlanStage, string> = { create: "Create", submitted: "Submitted", approved: "Approved", older: "Older Plans" };
export const parseStage = (value: unknown): PlanStage => (PLAN_STAGES as readonly string[]).includes(value as string) ? (value as PlanStage) : "create";

/**
 * Which lifecycle section a plan belongs to — the Sales Planning classification: a plan whose parent (the Season) is closed is OLDER whatever
 * its status; otherwise it follows the plan-level approval status. Option 1 / Option 2 statuses play no part.
 */
export function planStage(plan: { seasonOpen: boolean; approvalStatus: string }): PlanStage {
  if (!plan.seasonOpen) return "older";
  if (plan.approvalStatus === "APPROVED") return "approved";
  if (plan.approvalStatus === "PENDING_RM" || plan.approvalStatus === "PENDING_ADMIN") return "submitted";
  return "create"; // DRAFT | REJECTED — still editable by its owner
}

export const APPROVAL_LABEL: Record<string, string> = { DRAFT: "Draft", PENDING_RM: "Awaiting RM review", PENDING_ADMIN: "Awaiting Admin review", APPROVED: "Approved", REJECTED: "Rejected" };

/** Entry approval statuses shown in each lifecycle section of a plan (Older Plans = a closed season: every entry, read-only). */
export const STAGE_ROW_STATUSES: Record<string, readonly string[] | undefined> = { create: ["DRAFT", "REJECTED"], submitted: ["PENDING_RM", "PENDING_ADMIN"], approved: ["APPROVED"] };
export interface StageCounts { create: number; submitted: number; approved: number }
/**
 * Whether a logical plan (owner + period) appears in a lifecycle list. Create is a persistent workspace: an open-season plan stays there for ever so entries can
 * be added at any time. Submitted / Approved list the plan while it holds entries in that state (one row per plan, however many batches). A closed season → Older Plans.
 */
export function sheetInStage(counts: StageCounts, seasonOpen: boolean, stage: PlanStage): boolean {
  if (!seasonOpen) return stage === "older";
  if (stage === "create") return true;
  if (stage === "submitted") return counts.submitted > 0;
  if (stage === "approved") return counts.approved > 0;
  return false;
}
