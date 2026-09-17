/**
 * Operational Calendar — PURE date + projection helpers (no DB, no React), so the same rules run on the
 * server loader and in unit tests.
 *
 * A CONVERSION calendar event is a PROJECTION of an existing DealerSchemePlan (its current `expectedBillingDate`
 * is the authoritative date; it MOVES when the plan is extended). The calendar never stores conversion data.
 * The event carries the plan's CURRENT status so the calendar reads as an activity timeline (Planned →
 * Submitted → Approved → Converted / Enrolled / Declined), not a pending-only reminder list.
 *
 * Kept generic (CalendarEventType) so a future INSTALLMENT event type can be added without changing consumers.
 */

export type CalendarEventType = "CONVERSION"; // future: | "INSTALLMENT"

/** Current lifecycle status of a conversion event, DERIVED from the plan's existing planStatus + schemeStatus
 *  (+ enrollment). Presentation only — no new business state is introduced or stored. */
export type ConversionStatus =
  | "PLANNED"    // Draft — date entered, not yet submitted
  | "SUBMITTED"  // Pending for RM / Pending Approval
  | "APPROVED"   // Admin-approved, conversion not yet recorded
  | "CONVERTED"  // SO recorded conversion (schemeStatus CONVERTED)
  | "ENROLLED"   // Admin-verified + enrolled
  | "DECLINED"   // schemeStatus DECLINED
  | "RETURNED"
  | "REJECTED";

/** yyyy-mm-dd for a Date or ISO string (date-only, matching the app's ISO-slice convention — no TZ shift). */
export function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** Half-open [gte, lt) range covering an entire month (month is 1–12) — one ranged DB query per month. */
export function monthRange(year: number, month: number): { gte: Date; lt: Date } {
  return { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) };
}

/** Half-open [today, today+days) range for the "Upcoming N days" window (today included). */
export function upcomingRange(today: Date, days: number): { gte: Date; lt: Date } {
  const gte = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const lt = new Date(gte);
  lt.setUTCDate(lt.getUTCDate() + days);
  return { gte, lt };
}

/** Whole-day difference bKey − aKey (both yyyy-mm-dd), in calendar days. */
export function daysBetweenKeys(aKey: string, bKey: string): number {
  return Math.round((Date.parse(`${bKey}T00:00:00Z`) - Date.parse(`${aKey}T00:00:00Z`)) / 86_400_000);
}

/** True when `dk` is within [todayKey, +days): today counts, past excluded, beyond the window excluded. */
export function isUpcoming(dk: string, todayKey: string, days: number): boolean {
  const diff = daysBetweenKeys(todayKey, dk);
  return diff >= 0 && diff < days;
}

/** Derive the event's current status from the plan's EXISTING fields (never a new stored state). */
export function conversionEventStatus(p: { planStatus: string; schemeStatus: string; enrollmentStatus?: string | null }): ConversionStatus {
  if (p.enrollmentStatus === "ENROLLED") return "ENROLLED";
  if (p.schemeStatus === "CONVERTED") return "CONVERTED";
  if (p.schemeStatus === "DECLINED") return "DECLINED";
  switch (p.planStatus) {
    case "APPROVED": return "APPROVED";
    case "PENDING_RM":
    case "PENDING_APPROVAL": return "SUBMITTED";
    case "RETURNED": return "RETURNED";
    case "REJECTED": return "REJECTED";
    default: return "PLANNED"; // DRAFT
  }
}

/** The fields the projection needs from a DealerSchemePlan (a superset row is fine). */
export interface ConversionEventInput {
  id: string;
  schemeId: string;
  expectedBillingDate: Date | string | null;
  originalConversionDate?: Date | string | null;
  dealerName: string;
  schemeName: string;
  numberOfSchemes: number;
  totalSchemeAmount: number;
  salesOfficerId: string;
  salesOfficerName: string;
  planStatus: string;
  schemeStatus: string;
  enrollmentStatus?: string | null;
  conversionExtensionCount?: number;
}

export interface ConversionEvent {
  type: "CONVERSION";
  planId: string;
  schemeId: string;
  dateKey: string;
  dealerName: string;
  schemeName: string;
  numberOfSchemes: number;
  totalSchemeAmount: number;
  salesOfficerId: string;
  salesOfficerName: string;
  status: ConversionStatus;
  /** True when the planned date has moved from its baseline (a Conversion Date extension exists). */
  dateChanged: boolean;
  /** The baseline planned date (yyyy-mm-dd) — shown as "Previous Date" when the date changed. */
  originalDateKey: string | null;
}

/**
 * Project DealerSchemePlan rows → conversion calendar events. One event per plan that HAS a conversion date
 * (`expectedBillingDate`), on that current date. Plans without a date produce no event. No filtering by status
 * (activity timeline) — the status is carried on each event instead.
 */
export function projectConversionEvents(rows: ConversionEventInput[]): ConversionEvent[] {
  const out: ConversionEvent[] = [];
  for (const r of rows) {
    const dk = dateKey(r.expectedBillingDate);
    if (!dk) continue;
    out.push({
      type: "CONVERSION",
      planId: r.id,
      schemeId: r.schemeId,
      dateKey: dk,
      dealerName: r.dealerName,
      schemeName: r.schemeName,
      numberOfSchemes: r.numberOfSchemes,
      totalSchemeAmount: r.totalSchemeAmount,
      salesOfficerId: r.salesOfficerId,
      salesOfficerName: r.salesOfficerName,
      status: conversionEventStatus(r),
      dateChanged: (r.conversionExtensionCount ?? 0) > 0,
      originalDateKey: dateKey(r.originalConversionDate),
    });
  }
  return out;
}

/** Group conversion events by Sales Officer (for the Admin / RM global calendar), officers sorted by name. */
export function groupEventsByOfficer<T extends { salesOfficerId: string; salesOfficerName: string }>(
  events: T[],
): { salesOfficerId: string; salesOfficerName: string; events: T[] }[] {
  const map = new Map<string, { salesOfficerId: string; salesOfficerName: string; events: T[] }>();
  for (const e of events) {
    const g = map.get(e.salesOfficerId) ?? { salesOfficerId: e.salesOfficerId, salesOfficerName: e.salesOfficerName, events: [] };
    g.events.push(e);
    map.set(e.salesOfficerId, g);
  }
  return [...map.values()].sort((a, b) => a.salesOfficerName.localeCompare(b.salesOfficerName));
}
