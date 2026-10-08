/**
 * Party Planning · Monthly Planning — pure rules (no database). The transition table below is the ONE definition of the option
 * lifecycle; the server applies it and the UI only reads it. Each option (Option 1 / Option 2) is its own state machine.
 *
 *   PENDING ──SO──► DOC_SENT ──Admin──► DOC_RECEIVED ──Admin──► SD_DELAYED_BY_SO ──► SD_BOUNCE ──► APPOINTED
 *      │                │                    │  └─────────────────────────┴────────────┴──────────────┘
 *      └────────────────┴────────────────────┴──► PART_REJECTED (Admin, reason required; terminal)      (APPOINTED is terminal)
 *
 * Statuses after DOC_RECEIVED may be skipped forward (a plan need not hit every SD state), but nothing moves backwards and nothing leaves
 * APPOINTED or PART_REJECTED. Only the owning SO/RM moves PENDING → DOC_SENT; every later step is an Admin step.
 */

export const OPTION_STATUSES = ["PENDING", "DOC_SENT", "DOC_RECEIVED", "SD_DELAYED_BY_SO", "SD_BOUNCE", "APPOINTED", "PART_REJECTED"] as const;
export type OptionStatus = (typeof OPTION_STATUSES)[number];
export const OPTION_NUMBERS = [1, 2] as const;
export type OptionNo = (typeof OPTION_NUMBERS)[number];

export const STATUS_LABEL: Record<OptionStatus, string> = {
  PENDING: "Pending", DOC_SENT: "Doc Sent", DOC_RECEIVED: "Doc Received", SD_DELAYED_BY_SO: "SD Delayed by SO",
  SD_BOUNCE: "SD Bounce", APPOINTED: "Appointed", PART_REJECTED: "Part Rejected",
};
export const isOptionStatus = (v: unknown): v is OptionStatus => typeof v === "string" && (OPTION_STATUSES as readonly string[]).includes(v);

export type Actor = "OWNER" | "ADMIN";
const LATE: OptionStatus[] = ["SD_DELAYED_BY_SO", "SD_BOUNCE", "APPOINTED", "PART_REJECTED"];
export const TRANSITIONS: Record<OptionStatus, { to: OptionStatus; actor: Actor }[]> = {
  PENDING: [{ to: "DOC_SENT", actor: "OWNER" }, { to: "PART_REJECTED", actor: "ADMIN" }],
  DOC_SENT: [{ to: "DOC_RECEIVED", actor: "ADMIN" }, { to: "PART_REJECTED", actor: "ADMIN" }],
  DOC_RECEIVED: LATE.map((to) => ({ to, actor: "ADMIN" as const })),
  SD_DELAYED_BY_SO: (["SD_BOUNCE", "APPOINTED", "PART_REJECTED"] as OptionStatus[]).map((to) => ({ to, actor: "ADMIN" as const })),
  SD_BOUNCE: (["APPOINTED", "PART_REJECTED"] as OptionStatus[]).map((to) => ({ to, actor: "ADMIN" as const })),
  APPOINTED: [],
  PART_REJECTED: [],
};

/** Who may make this exact move, or null when the move does not exist. */
export function transitionActor(from: string, to: string): Actor | null {
  if (!isOptionStatus(from) || !isOptionStatus(to)) return null;
  return TRANSITIONS[from].find((t) => t.to === to)?.actor ?? null;
}
/** The existing Dealer-Appointment permission action an Admin needs for the target status (rejection → reject, every other step → approve). */
export const adminActionFor = (to: OptionStatus): "approve" | "reject" => (to === "PART_REJECTED" ? "reject" : "approve");

/* ------------------------------------------------ transition payloads ------------------------------------------------ */

export interface DocInfo { documents: boolean; checks: boolean; other: boolean; otherDetails: string | null }
const MAX_TEXT = 500;
const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** What was sent (by the SO) / received (by Admin): at least one item; "Other" needs its clarification. Stored exactly as given. */
export function parseDocInfo(raw: unknown): { ok: true; value: DocInfo } | { ok: false; message: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const info: DocInfo = { documents: r.documents === true, checks: r.checks === true, other: r.other === true, otherDetails: null };
  if (!info.documents && !info.checks && !info.other) return { ok: false, message: "Select at least one of Documents, Checks or Other." };
  if (info.other) {
    const details = text(r.otherDetails);
    if (!details) return { ok: false, message: "Describe what 'Other' is." };
    if (details.length > MAX_TEXT) return { ok: false, message: `Other details can be at most ${MAX_TEXT} characters.` };
    info.otherDetails = details;
  }
  return { ok: true, value: info };
}

export type TransitionInput =
  | { to: "DOC_SENT"; sent: DocInfo }
  | { to: "DOC_RECEIVED"; received: DocInfo }
  | { to: "SD_DELAYED_BY_SO" | "SD_BOUNCE" | "PART_REJECTED"; reason: string }
  | { to: "APPOINTED"; actualPartyName: string };

/** Validates the data a transition requires. Nothing the browser sends is trusted beyond these fields (actor, date and status come from the server). */
export function parseTransition(raw: unknown): { ok: true; value: TransitionInput } | { ok: false; message: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const to = r.to;
  if (!isOptionStatus(to) || to === "PENDING") return { ok: false, message: "Choose a valid status." };
  if (to === "DOC_SENT" || to === "DOC_RECEIVED") {
    const info = parseDocInfo(to === "DOC_SENT" ? r.sent : r.received);
    if (!info.ok) return info;
    return { ok: true, value: to === "DOC_SENT" ? { to, sent: info.value } : { to, received: info.value } };
  }
  if (to === "APPOINTED") {
    const name = text(r.actualPartyName);
    if (!name) return { ok: false, message: "Actual Party Name is required." };
    if (name.length > 200) return { ok: false, message: "Actual Party Name can be at most 200 characters." };
    return { ok: true, value: { to, actualPartyName: name } };
  }
  const reason = text(r.reason);
  if (!reason) return { ok: false, message: to === "PART_REJECTED" ? "A rejection reason is required." : "A reason is required." };
  if (reason.length > MAX_TEXT) return { ok: false, message: `The reason can be at most ${MAX_TEXT} characters.` };
  return { ok: true, value: { to, reason } };
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

/** The status a Monthly Plan (the per-season-month header) shows in the list, derived from its rows' options: none → Draft; all options final → Completed; else In Progress. */
export type MonthlySheetStatus = "Draft" | "In Progress" | "Completed";
export function monthlySheetStatus(rows: { options: { status: string }[] }[]): MonthlySheetStatus {
  const options = rows.flatMap((r) => r.options);
  if (rows.length === 0) return "Draft";
  return options.length > 0 && options.every((o) => o.status === "APPOINTED" || o.status === "PART_REJECTED") ? "Completed" : "In Progress";
}
/** Option statuses that are waiting on an Admin (documents sent → received → SD steps → appointment): what Admin filters by to find work. */
export const ADMIN_PENDING_STATUSES: readonly OptionStatus[] = ["DOC_SENT", "DOC_RECEIVED", "SD_DELAYED_BY_SO", "SD_BOUNCE"];
