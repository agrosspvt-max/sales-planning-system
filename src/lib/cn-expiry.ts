import { cnRequestBusinessDateKey, isCnBusinessDateKey, isCnSundayDateKey } from "./cn-request";

/** CN expiry is the effective deadline, valid through its end in IST. Grace is granted explicitly
 * and extends that date; cnGraceDays records cumulative days granted in the current cycle, never an extra window.
 * Outstanding CNs expire after the effective deadline. Reopening/return starts a fresh cycle without grace.
 * Near-expiry includes the final four calendar days plus all CNs granted grace. Sunday only affects task dates. */
export const CN_DEFAULT_GRACE_DAYS = 5;
export const CN_MAX_GRACE_DAYS = 365;
export const CN_POLICY_STAGES = ["WORKING", "GRACE", "EXPIRED"] as const;
export type CnPolicyStage = (typeof CN_POLICY_STAGES)[number];
export const isCnPolicyStage = (v: unknown): v is CnPolicyStage => typeof v === "string" && (CN_POLICY_STAGES as readonly string[]).includes(v);

export function addCnDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Last day of the grace period (inclusive). */
export const cnGraceEndDateKey = (expiryDate: string, graceDays: number): string => addCnDays(expiryDate, graceDays);
/** The instant a calendar date begins in IST (00:00 Asia/Kolkata = 18:30Z the previous day; India has no DST). */
export const cnDateStartInstant = (dateKey: string): Date => new Date(`${dateKey}T00:00:00.000+05:30`);

/** "Grace Period (Days)": a positive whole number. Returns null when it is not one. */
export function parseCnGraceDays(value: unknown): number | null {
  if (value === "" || value == null || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : /^\s*\d+\s*$/.test(String(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= CN_MAX_GRACE_DAYS ? n : null;
}
/** Expiry date: a real YYYY-MM-DD that is not before today (IST). Today is allowed — it stays valid through its end. */
export function cnExpiryDateProblem(value: unknown, todayKey: string): "invalid" | "past" | null {
  if (typeof value !== "string" || !isCnBusinessDateKey(value)) return "invalid";
  return value < todayKey ? "past" : null;
}

export interface CnPolicyState { cnExpiryDate: string | null; cnGraceDays: number | null; cnPolicyStage: string | null }
export interface CnStageTransition { kind: "ENTERED_GRACE" | "EXPIRED"; effectiveAt: Date }

/** Expire at midnight IST after the effective date, recording the real boundary even on a late first read. */
export function dueCnTransitions(state: CnPolicyState, awaitingResponse: boolean, now: Date): CnStageTransition[] {
  if (!isCnPolicyStage(state.cnPolicyStage) || state.cnPolicyStage === "EXPIRED" || !state.cnExpiryDate || !awaitingResponse) return [];
  const expireAt = cnDateStartInstant(addCnDays(state.cnExpiryDate, 1));
  return now >= expireAt ? [{ kind: "EXPIRED", effectiveAt: expireAt }] : [];
}

export function isCnNearExpiry(state: CnPolicyState, todayKey: string): boolean {
  return !!state.cnExpiryDate && state.cnPolicyStage !== "EXPIRED" &&
    ((state.cnGraceDays ?? 0) > 0 || (todayKey >= addCnDays(state.cnExpiryDate, -4) && todayKey <= state.cnExpiryDate));
}
/** The stage a read should show right now: the persisted stage with every due transition applied. NULL = not governed. */
export function effectiveCnStage(state: CnPolicyState, awaitingResponse: boolean, now: Date): CnPolicyStage | null {
  if (!isCnPolicyStage(state.cnPolicyStage)) return null;
  const last = dueCnTransitions(state, awaitingResponse, now).at(-1);
  return last ? (last.kind === "EXPIRED" ? "EXPIRED" : "GRACE") : state.cnPolicyStage;
}

/** Scheduling uses the effective expiry only; grace has already been added to it. */
export function cnTaskWindowEnd(state: CnPolicyState, _todayKey: string): string | null {
  return state.cnPolicyStage === "EXPIRED" ? null : state.cnExpiryDate;
}
/** One check for every scheduling / reschedule / automatic-task entry point: a real, non-Sunday date inside [acceptance date, window end] while the window is still open today. */
export function isCnTaskDateAllowed(taskDate: string, acceptedAt: Date | string | null, state: CnPolicyState, todayKey: string): boolean {
  if (!isCnBusinessDateKey(taskDate) || isCnSundayDateKey(taskDate) || !acceptedAt) return false;
  const start = cnRequestBusinessDateKey(acceptedAt), end = cnTaskWindowEnd(state, todayKey);
  return !!start && !!end && todayKey <= end && taskDate >= start && taskDate <= end;
}
