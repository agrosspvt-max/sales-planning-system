/**
 * Party Planning · Monthly Planning — pure rules (no database). A Monthly Plan row (one market) has ONE operational status; Option 1 /
 * Option 2 are only the two candidate party names. The transition table below is the single definition of that workflow:
 * the server applies it and the UI only reads it.
 *
 *   NONE ──SO──► DOC_SENT ──Admin──► DOC_RECEIVED ──Admin──► SD_BOUNCE ──Admin──► APPOINTED   (terminal)
 *     │  └─SO─► DOC_NOT_SENT ─SO─► DOC_SENT        └──────────────────────┴───────────────────► REJECTED   (Admin, terminal)
 *     └──────────────┴─► REJECTED (Admin)
 *
 * DOC_NOT_SENT ("Appointed, Document Not Sent") is an UNFINISHED, owner-actionable state: the owner may later submit the Document / Cheque answers
 * (→ DOC_SENT). It can never skip Admin receipt, and it stays open for the Pending counts and plan-completion rules.
 *
 * NONE means the status workflow has not begun. It can begin only once the PLAN is approved (a separate, plan-level approval); an operational
 * status change never approves a plan. Only the owning SO/RM moves NONE → DOC_SENT; every other step is an Admin step.
 */

export const ROW_STATUSES = ["NONE", "DOC_NOT_SENT", "DOC_SENT", "DOC_RECEIVED", "SD_BOUNCE", "APPOINTED", "REJECTED"] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
/** A market entry carries a VARIABLE number of candidate party options: at least MIN_OPTIONS complete ones, at most MAX_OPTIONS (also the database CHECK). */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export type OptionNo = number;

export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  NONE: "Pending", DOC_NOT_SENT: "Document Not Sent", DOC_SENT: "Doc Send By SO", DOC_RECEIVED: "Doc Received", SD_BOUNCE: "SD Bounce", APPOINTED: "Appointed", REJECTED: "Rejected",
};
export const isRowStatus = (v: unknown): v is RowStatus => typeof v === "string" && (ROW_STATUSES as readonly string[]).includes(v);

/** What the Status column shows: the operational status once it has begun, otherwise the plan's own stage (Draft / Submitted / Approved). */
export function displayRowStatus(rowStatus: string, planApprovalStatus: string): string {
  if (isRowStatus(rowStatus) && rowStatus !== "NONE") return ROW_STATUS_LABEL[rowStatus];
  // An approved entry whose appointment process has not started is operationally PENDING (the approval itself is unchanged).
  if (planApprovalStatus === "APPROVED") return ROW_STATUS_LABEL.NONE;
  if (planApprovalStatus === "PENDING_RM" || planApprovalStatus === "PENDING_ADMIN") return "Submitted";
  return "Draft";
}

export type Actor = "OWNER" | "ADMIN";
export const TRANSITIONS: Record<RowStatus, { to: RowStatus; actor: Actor }[]> = {
  NONE: [{ to: "DOC_SENT", actor: "OWNER" }, { to: "DOC_NOT_SENT", actor: "OWNER" }, { to: "REJECTED", actor: "ADMIN" }],
  DOC_NOT_SENT: [{ to: "DOC_SENT", actor: "OWNER" }, { to: "REJECTED", actor: "ADMIN" }],
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

/** At least one of Document / Check must be ticked; "Other" is optional free text. Stored exactly as given. (Admin's "what was actually received" — unchanged.) */
export function parseDocInfo(raw: unknown): { ok: true; value: DocInfo } | { ok: false; message: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const documents = r.documents === true, checks = r.checks === true;
  if (!documents && !checks) return { ok: false, message: "Select at least one of Document or Check." };
  const other = text(r.other);
  if (other.length > MAX_TEXT) return { ok: false, message: `Other can be at most ${MAX_TEXT} characters.` };
  return { ok: true, value: { documents, checks, other: other || null } };
}

/**
 * What the owning SO / RM answers on the "Doc Send By SO" form. Document and Cheque each have THREE distinguishable states — Complete, Incomplete and unanswered —
 * so completeness is stored as explicit values, never as a boolean. "Appointed, Document Not Sent" is its own answer: both items stay unanswered.
 * Rows recorded before this form existed carry only the old `documents` / `checks` booleans; those were "was it sent", NOT "is it complete", and are never converted.
 */
export const COMPLETENESS = ["COMPLETE", "INCOMPLETE"] as const;
export type Completeness = (typeof COMPLETENESS)[number];
export const isCompleteness = (v: unknown): v is Completeness => typeof v === "string" && (COMPLETENESS as readonly string[]).includes(v);
export interface SentInfo { documentStatus: Completeness | null; chequeStatus: Completeness | null; documentNotSent: boolean; other: string | null }
/** A stored "sent" answer: the current shape, or the legacy booleans (completeness not recorded). */
export type StoredSentInfo = Partial<SentInfo> & Partial<DocInfo>;
/** True for a row saved by the old checkbox form (no completeness recorded). */
export const isLegacySentInfo = (i: StoredSentInfo | null | undefined): boolean => !!i && i.documentStatus === undefined && i.chequeStatus === undefined && i.documentNotSent === undefined;

/** The owner's form state. Document and Cheque each start unanswered (null) — nothing is preselected. */
export interface SentForm { notSent: boolean; documentStatus: Completeness | null; chequeStatus: Completeness | null; other: string }
export const EMPTY_SENT_FORM: SentForm = { notSent: false, documentStatus: null, chequeStatus: null, other: "" };
/** Ticking Complete / Incomplete selects that value (which clears the other of the pair); unticking it leaves the item unanswered. */
export function chooseSentAnswer(f: SentForm, item: "documentStatus" | "chequeStatus", value: Completeness, checked: boolean): SentForm {
  return f.notSent ? f : { ...f, [item]: checked ? value : null };
}
/** "Appointed, Document Not Sent": ticking it clears every Document / Cheque answer; unticking leaves them unanswered (previous answers are never restored). */
export const setSentNotSent = (f: SentForm, checked: boolean): SentForm => ({ ...f, notSent: checked, documentStatus: null, chequeStatus: null });
export const sentFormAnswered = (f: SentForm): boolean => f.notSent || (f.documentStatus !== null && f.chequeStatus !== null);
/** The request body: the special option never carries answers. */
export const sentFormBody = (f: SentForm) => ({ documentNotSent: f.notSent, documentStatus: f.notSent ? null : f.documentStatus, chequeStatus: f.notSent ? null : f.chequeStatus, other: f.other });

export function parseSentInfo(raw: unknown): { ok: true; value: SentInfo } | { ok: false; message: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const other = text(r.other);
  if (other.length > MAX_TEXT) return { ok: false, message: `Other can be at most ${MAX_TEXT} characters.` };
  const hasDoc = r.documentStatus != null && r.documentStatus !== "", hasCheque = r.chequeStatus != null && r.chequeStatus !== "";
  if (r.documentNotSent === true) {
    if (hasDoc || hasCheque) return { ok: false, message: "Appointed, Document Not Sent cannot be combined with Document / Cheque answers." };
    return { ok: true, value: { documentStatus: null, chequeStatus: null, documentNotSent: true, other: other || null } };
  }
  if (!isCompleteness(r.documentStatus) || !isCompleteness(r.chequeStatus)) return { ok: false, message: "Select Complete or Incomplete for both Document and Cheque." };
  return { ok: true, value: { documentStatus: r.documentStatus, chequeStatus: r.chequeStatus, documentNotSent: false, other: other || null } };
}

export type TransitionInput =
  | { to: "DOC_SENT" | "DOC_NOT_SENT"; sent: SentInfo }
  | { to: "DOC_RECEIVED"; received: DocInfo }
  | { to: "SD_BOUNCE" | "APPOINTED" | "REJECTED"; remarks: string | null };

/**
 * Validates the data a transition requires. Nothing the browser sends is trusted beyond these fields (actor, date and status come from the server).
 * The owner's form always posts `to: DOC_SENT` with its answers: the "Appointed, Document Not Sent" answer resolves HERE to the Document Not Sent status, so the
 * same form, validation and transition serve the Monthly Planning dialog and the Daily Report alike.
 */
export function parseTransition(raw: unknown): { ok: true; value: TransitionInput } | { ok: false; message: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const to = r.to;
  if (!isRowStatus(to) || to === "NONE") return { ok: false, message: "Choose a valid status." };
  if (to === "DOC_SENT" || to === "DOC_NOT_SENT") {
    const info = parseSentInfo(to === "DOC_NOT_SENT" ? { documentNotSent: true, other: (r.sent as { other?: unknown } | null | undefined)?.other } : r.sent);
    if (!info.ok) return info;
    return { ok: true, value: { to: info.value.documentNotSent ? "DOC_NOT_SENT" : "DOC_SENT", sent: info.value } };
  }
  if (to === "DOC_RECEIVED") {
    const info = parseDocInfo(r.received);
    if (!info.ok) return info;
    return { ok: true, value: { to, received: info.value } };
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

/* ------------------------------------------------ Create dialog defaults ------------------------------------------------ */

export interface DefaultableSeason { id: string; eligibleCount: number; months: readonly { id: string; key: string }[] }
/** The month of a season whose stored calendar identity (YYYY-MM) is the running month — by identity only, never by position, name or the season's year. "" when the season does not contain it. */
export const monthIdForKey = (months: readonly { id: string; key: string }[], currentMonthKey: string): string => months.find((m) => m.key === currentMonthKey)?.id ?? "";
/**
 * Suggested Season + Month for Create Monthly Plan: the season that has approved Seasonal Party Planning markets for the caller AND contains the running calendar month. Only when exactly
 * ONE season qualifies is it chosen — with several (overlapping seasons) there is no authoritative "current season", so nothing is picked for the user. An existing sheet for the month
 * does not disqualify it (Create then reopens it).
 */
export function defaultMonthlySelection(seasons: readonly DefaultableSeason[], currentMonthKey: string): { seasonId: string; monthId: string } {
  const matches = seasons.filter((s) => s.eligibleCount > 0 && monthIdForKey(s.months, currentMonthKey));
  return matches.length === 1 ? { seasonId: matches[0]!.id, monthId: monthIdForKey(matches[0]!.months, currentMonthKey) } : { seasonId: "", monthId: "" };
}

/* ------------------------------------------------ tentative turnover (per candidate party option) ------------------------------------------------ */

/** Stable stored codes, in display order. The wording shown for each is an editable label; these are TURNOVER CATEGORIES, not amounts, and carry no period. */
export const TURNOVER_CATEGORIES = ["LT_50L", "50L_TO_1CR", "1CR_TO_2CR", "2CR_TO_4CR", "GT_4CR"] as const;
export type TurnoverCategory = (typeof TURNOVER_CATEGORIES)[number];
export const isTurnoverCategory = (value: unknown): value is TurnoverCategory => typeof value === "string" && (TURNOVER_CATEGORIES as readonly string[]).includes(value);
export const cleanTurnover = (value: unknown): string | null => text(value) || null;
/**
 * The rule for ONE option's RESULTING (stored) values: a populated party needs a valid turnover; an unused option must have none. Returns a problem code or null.
 * (Callers apply it to the values the row will hold after the change, so partial updates are checked correctly.)
 */
export function turnoverProblem(party: string | null, turnover: string | null): "required" | "invalid" | "without_party" | null {
  if (!party) return turnover ? "without_party" : null;
  if (!turnover) return "required";
  return isTurnoverCategory(turnover) ? null : "invalid";
}

/** One option as the client sends it / as it will be stored. `id` = an already persisted option; `optionNo` is assigned by the server for new ones. */
export interface OptionInput { id?: string; optionNo?: number; partyName: unknown; turnoverCategory: unknown }
export interface CleanOption { id: string | null; optionNo: number | null; party: string | null; turnover: string | null }
export type OptionsProblem =
  | { code: "not_array" | "too_few" | "too_many" }
  | { code: "party_required" | "party_long" | "turnover_required" | "turnover_invalid" | "number_invalid" | "number_duplicate" | "id_duplicate"; index: number };
/**
 * Validate a COMPLETE options collection (never a fragment): 2..10 options, each with a trimmed party name (≤ 200) and an allowed turnover category, whole unique option numbers
 * when given. Returns the cleaned list, or the first problem with the (1-based) row it concerns.
 */
export function validateOptions(input: unknown): { ok: true; value: CleanOption[] } | { ok: false; problem: OptionsProblem } {
  if (!Array.isArray(input)) return { ok: false, problem: { code: "not_array" } };
  if (input.length > MAX_OPTIONS) return { ok: false, problem: { code: "too_many" } };
  if (input.length < MIN_OPTIONS) return { ok: false, problem: { code: "too_few" } };
  const out: CleanOption[] = [];
  const nos = new Set<number>(), ids = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const index = i + 1;
    const party = cleanParty(row.partyName);
    if (!party) return { ok: false, problem: { code: "party_required", index } };
    if (party.length > 200) return { ok: false, problem: { code: "party_long", index } };
    const turnover = cleanTurnover(row.turnoverCategory);
    if (!turnover) return { ok: false, problem: { code: "turnover_required", index } };
    if (!isTurnoverCategory(turnover)) return { ok: false, problem: { code: "turnover_invalid", index } };
    let optionNo: number | null = null;
    if (row.optionNo !== undefined && row.optionNo !== null && row.optionNo !== "") {
      if (typeof row.optionNo !== "number" || !Number.isInteger(row.optionNo) || row.optionNo < 1 || row.optionNo > MAX_OPTIONS) return { ok: false, problem: { code: "number_invalid", index } };
      if (nos.has(row.optionNo)) return { ok: false, problem: { code: "number_duplicate", index } };
      nos.add(row.optionNo); optionNo = row.optionNo;
    }
    const id = typeof row.id === "string" && row.id ? row.id : null;
    if (id) { if (ids.has(id)) return { ok: false, problem: { code: "id_duplicate", index } }; ids.add(id); }
    out.push({ id, optionNo, party, turnover });
  }
  return { ok: true, value: out };
}
/** Is a STORED entry's option set complete (used when it is submitted)? Blank legacy placeholders and a single populated option are incomplete. */
export function optionsComplete(options: readonly { partyName: string | null; turnoverCategory: string | null }[]): boolean {
  return options.length >= MIN_OPTIONS && options.every((o) => !!o.partyName?.trim() && turnoverProblem(o.partyName, o.turnoverCategory ?? null) === null);
}

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
/**
 * DAILY WORK → DEALER APPOINTMENT totals, over the owner's APPROVED Monthly Party Planning entries of one calendar month (the caller passes only those entries):
 *  • Monthly Dealer Plan = the number of UNIQUE markets (by market id — never candidate party options, never Daily Work rows);
 *  • Pending = how many of those markets are still unfinished in the monthly appointment workflow: every operational status except the terminal Appointed / Rejected
 *    (None/Approved, Doc Send By SO, Doc Received and SD Bounce are all still open). Sending documents is NOT a final appointment, so it never reduces Pending.
 * A market that appears in more than one entry is counted once, and is pending when any of its entries is still open.
 */
export const TERMINAL_ROW_STATUSES: readonly RowStatus[] = ["APPOINTED", "REJECTED"];
export const isMonthlyWorkflowOpen = (opStatus: string): boolean => !(TERMINAL_ROW_STATUSES as readonly string[]).includes(opStatus);
export function appointmentMonthlyTotals(entries: readonly { marketId: string; opStatus: string }[]): { monthlyDealerPlan: number; pending: number } {
  const markets = new Map<string, boolean>();
  for (const e of entries) markets.set(e.marketId, (markets.get(e.marketId) ?? false) || isMonthlyWorkflowOpen(e.opStatus));
  return { monthlyDealerPlan: markets.size, pending: [...markets.values()].filter(Boolean).length };
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
