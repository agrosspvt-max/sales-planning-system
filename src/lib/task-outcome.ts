/**
 * Daily Report → Sales / Recovery task OUTCOMES — pure rules (no database). The client and the server both use this ONE definition, so what the form accepts is exactly what the
 * server accepts. An outcome is a deliberate statement about ONE task: Completed (with a positive Actual amount), Not Completed — Reschedule (with a strictly future date) or
 * Abandon (with a specific reason). Nothing here decides whether money was received; it only validates what the officer reported.
 */

export const TASK_OUTCOMES = ["COMPLETED", "RESCHEDULED", "ABANDONED"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
export const isTaskOutcome = (v: unknown): v is TaskOutcome => typeof v === "string" && (TASK_OUTCOMES as readonly string[]).includes(v);

export const MAX_ACTUAL_AMOUNT = 1e12; // the existing Daily Work amount ceiling
export const MIN_REASON_CHARS = 20; // non-whitespace characters
export const MAX_REASON_LENGTH = 500;

/** The fields the officer filled in for one task. Only the fields of the CHOSEN outcome are kept (see sanitizeOutcomeFields). */
export interface OutcomeFields { outcome: TaskOutcome | null; actualAmount: number | null; nextDate: string | null; reason: string | null }
export type OutcomeError = "outcome_required" | "amount_required" | "amount_invalid" | "date_required" | "date_invalid" | "date_not_future" | "reason_required" | "reason_short" | "reason_meaningless" | "reason_long";

const isDateKey = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
/** Amounts are stored with the existing 2-decimal precision. */
export const roundMoney = (n: number): number => Math.round(n * 100) / 100;

/** A positive, finite amount within the existing limit (anything that rounds to 0.00 is not positive). null = not provided. */
export function parseActualAmount(raw: unknown): { ok: true; value: number | null } | { ok: false; error: "amount_invalid" } {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || roundMoney(n) <= 0 || n > MAX_ACTUAL_AMOUNT) return { ok: false, error: "amount_invalid" };
  return { ok: true, value: roundMoney(n) };
}

/** Whitespace collapsed; this is also what is stored. */
export const cleanReason = (raw: unknown): string => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "");

/**
 * Rule-based (never AI): at least 20 non-whitespace characters, at least 12 letters / digits, at least 5 different letters / digits, at least 2 different words, and no
 * single character making up more than half of the text — so "....................", "aaaaaaaaaaaaaaaaaaaa" and "asdf asdf asdf asdf" are refused.
 */
export function checkReason(raw: unknown): "ok" | "reason_required" | "reason_short" | "reason_meaningless" | "reason_long" {
  const text = cleanReason(raw);
  if (text === "") return "reason_required";
  if (text.length > MAX_REASON_LENGTH) return "reason_long";
  const compact = text.replace(/\s+/g, "");
  if (compact.length < MIN_REASON_CHARS) return "reason_short";
  const alnum = [...compact.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const distinct = new Set(alnum);
  const words = new Set(text.toLowerCase().split(" ").map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean));
  const counts = new Map<string, number>();
  for (const c of compact.toLowerCase()) counts.set(c, (counts.get(c) ?? 0) + 1);
  const dominant = Math.max(...counts.values()) / compact.length;
  if (alnum.length < 12 || distinct.size < 5 || words.size < 2 || dominant > 0.5) return "reason_meaningless";
  return "ok";
}

/**
 * Keeps ONLY the fields that belong to the chosen outcome — switching the dropdown can never leave a stale amount, date or reason that later triggers an effect.
 * (Used for drafts too: a draft keeps the chosen outcome's possibly-incomplete fields, nothing else.)
 */
export function sanitizeOutcomeFields(i: { outcome?: unknown; actualAmount?: unknown; nextDate?: unknown; reason?: unknown }): { ok: true; value: OutcomeFields } | { ok: false; error: OutcomeError } {
  if (i.outcome === null || i.outcome === undefined || i.outcome === "") return { ok: true, value: { outcome: null, actualAmount: null, nextDate: null, reason: null } };
  if (!isTaskOutcome(i.outcome)) return { ok: false, error: "outcome_required" };
  if (i.outcome === "COMPLETED") {
    const a = parseActualAmount(i.actualAmount);
    return a.ok ? { ok: true, value: { outcome: "COMPLETED", actualAmount: a.value, nextDate: null, reason: null } } : { ok: false, error: a.error };
  }
  if (i.outcome === "RESCHEDULED") {
    const d = i.nextDate === null || i.nextDate === undefined || i.nextDate === "" ? null : i.nextDate;
    if (d !== null && !isDateKey(d)) return { ok: false, error: "date_invalid" };
    return { ok: true, value: { outcome: "RESCHEDULED", actualAmount: null, nextDate: d as string | null, reason: null } };
  }
  const reason = cleanReason(i.reason);
  if (reason.length > MAX_REASON_LENGTH) return { ok: false, error: "reason_long" };
  return { ok: true, value: { outcome: "ABANDONED", actualAmount: null, nextDate: null, reason: reason === "" ? null : reason } };
}

/**
 * FINAL validation of one task's outcome at report submission: Completed → positive amount; Reschedule → a date STRICTLY later than today (the application's business date);
 * Abandon → a valid reason. `today` is the business date at the moment of submission.
 */
export function validateOutcome(f: OutcomeFields, today: string): OutcomeError | null {
  if (f.outcome === null) return "outcome_required";
  if (f.outcome === "COMPLETED") return f.actualAmount === null ? "amount_required" : f.actualAmount > 0 ? null : "amount_invalid";
  if (f.outcome === "RESCHEDULED") return f.nextDate === null ? "date_required" : !isDateKey(f.nextDate) ? "date_invalid" : f.nextDate > today ? null : "date_not_future";
  const r = checkReason(f.reason);
  return r === "ok" ? null : r;
}
export const isOutcomeComplete = (f: OutcomeFields, today: string): boolean => validateOutcome(f, today) === null;

/** What the row's own `todaysActual` becomes: null until EVERY task has a valid outcome, then the sum of the Completed amounts (0 when nothing was completed). */
export function rowActualFromOutcomes(units: readonly OutcomeFields[], today: string): number | null {
  if (units.length === 0) return 0;
  if (!units.every((u) => isOutcomeComplete(u, today))) return null;
  return roundMoney(units.reduce((s, u) => s + (u.outcome === "COMPLETED" ? u.actualAmount ?? 0 : 0), 0));
}

/** The task kinds a Daily Work row is made of (identity of one task inside a row). */
export type OutcomeUnitType = "BILLING_EXCEPTION" | "CN_PAYMENT" | "CN_LEGACY" | "CALENDAR_ENTRY" | "MANUAL_ROW";
export const OUTCOME_UNIT_TYPES: readonly OutcomeUnitType[] = ["BILLING_EXCEPTION", "CN_PAYMENT", "CN_LEGACY", "CALENDAR_ENTRY", "MANUAL_ROW"];
/** Manual = deliberately created (Daily Work row, Calendar); Auto = generated by a business workflow (Billing Exception, CN). */
export const outcomeUnitIsAuto = (t: OutcomeUnitType): boolean => t === "BILLING_EXCEPTION" || t === "CN_PAYMENT" || t === "CN_LEGACY";
export const outcomeUnitSource = (t: OutcomeUnitType): "BILLING_EXCEPTION" | "CN_REQUEST" | null => (t === "BILLING_EXCEPTION" ? "BILLING_EXCEPTION" : t === "CN_PAYMENT" || t === "CN_LEGACY" ? "CN_REQUEST" : null);
