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

export type CalendarEventType = "CONVERSION" | "PARTY_APPOINTMENT"; // future: | "RECOVERY" | "INSTALLMENT"

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
  dealerId?: string;
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
  dealerId?: string;
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
      ...(r.dealerId ? { dealerId: r.dealerId } : {}),
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

/* =====================================================================================
 * PARTY APPOINTMENT events (Phase 2) — a SECOND projected event source over the SAME calendar.
 *
 * A Party Appointment is PROJECTED from an APPROVED PartyPlan at read time (never stored), exactly like a
 * conversion is projected from a DealerSchemePlan. The scoping/range query lives in calendar.server.ts; only
 * APPROVED plans are passed here (a Draft / Pending / Rejected plan is never queried, so it never appears).
 * `appointmentDate` is a pure business date, so `dateKey` preserves it with no timezone shift. Because the
 * event is derived per query, refreshing or reopening the calendar can never create a duplicate.
 * ===================================================================================== */

/** The fields the Party projection needs from an (already APPROVED) PartyPlan row (a superset is fine). */
export interface PartyAppointmentInput {
  id: string;
  partyName: string | null;
  marketName: string | null;
  appointmentDate: Date | string | null;
  salesOfficerId: string;
  salesOfficerName: string;
}

export interface PartyAppointmentEvent {
  type: "PARTY_APPOINTMENT";
  planId: string;
  dateKey: string;
  partyName: string;
  marketName: string | null;
  salesOfficerId: string;
  salesOfficerName: string;
}

/**
 * Project APPROVED PartyPlan rows → Party Appointment calendar events. One event per plan that HAS an
 * appointment date, on that exact date. A plan without a date (should not occur for an approved plan, since
 * Submit requires it) produces no event — mirroring the conversion projection's "no date → no event" rule.
 */
export function projectPartyAppointmentEvents(rows: PartyAppointmentInput[]): PartyAppointmentEvent[] {
  const out: PartyAppointmentEvent[] = [];
  for (const r of rows) {
    const dk = dateKey(r.appointmentDate);
    if (!dk) continue;
    out.push({
      type: "PARTY_APPOINTMENT",
      planId: r.id,
      dateKey: dk,
      partyName: r.partyName ?? "",
      marketName: r.marketName,
      salesOfficerId: r.salesOfficerId,
      salesOfficerName: r.salesOfficerName,
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

/**
 * One selected day, grouped by EMPLOYEE for the Calendar's details panel: every authorized entry of every source (scheme conversions, party appointments, Billing Exception
 * recovery tasks, Calendar tasks / meetings / reminders / other, notes) lands under the employee it belongs to; employees are sorted by name; `count` is the number of entries.
 * It only regroups what the server already authorized — it never adds, widens or reveals anything.
 */
export interface DayGroupInput {
  events: readonly { salesOfficerId: string; salesOfficerName: string }[];
  partyEvents: readonly { salesOfficerId: string; salesOfficerName: string }[];
  billingTasks: readonly { ownerId: string; ownerName: string }[];
  entries: readonly { ownerId: string; ownerName: string }[];
  notes: readonly { ownerId: string; ownerName: string }[];
}
export interface DayEmployeeGroup<I extends DayGroupInput> {
  employeeId: string; employeeName: string; count: number;
  events: I["events"][number][]; partyEvents: I["partyEvents"][number][]; billingTasks: I["billingTasks"][number][]; entries: I["entries"][number][]; notes: I["notes"][number][];
}
export function groupDayByEmployee<I extends DayGroupInput>(day: I): DayEmployeeGroup<I>[] {
  const map = new Map<string, DayEmployeeGroup<I>>();
  const slot = (id: string, name: string) => { let g = map.get(id); if (!g) { g = { employeeId: id, employeeName: name, count: 0, events: [], partyEvents: [], billingTasks: [], entries: [], notes: [] }; map.set(id, g); } return g; };
  // ONE underlying item is counted once: the same record handed over twice (e.g. through its source AND a Daily Work link) is kept a single time, while genuinely separate
  // records — even with the same dealer, section and amount — keep their own ids and stay separate.
  const seen = new Set<string>();
  const once = (kind: string, id: unknown) => { const key = `${kind}:${String(id)}`; if (id == null || !seen.has(key)) { seen.add(key); return true; } return false; };
  for (const e of day.events) { const x = e as { planId?: string }; if (!once("event", x.planId)) continue; const g = slot(e.salesOfficerId, e.salesOfficerName); g.events.push(e); g.count++; }
  for (const e of day.partyEvents) { const x = e as { planId?: string }; if (!once("party", x.planId)) continue; const g = slot(e.salesOfficerId, e.salesOfficerName); g.partyEvents.push(e); g.count++; }
  for (const t of day.billingTasks) { const x = t as { id?: string }; if (!once("billing", x.id)) continue; const g = slot(t.ownerId, t.ownerName); g.billingTasks.push(t); g.count++; }
  for (const e of day.entries) { const x = e as { id?: string }; if (!once("entry", x.id)) continue; const g = slot(e.ownerId, e.ownerName); g.entries.push(e); g.count++; }
  for (const n of day.notes) { const x = n as { id?: string }; if (!once("note", x.id)) continue; const g = slot(n.ownerId, n.ownerName); g.notes.push(n); g.count++; }
  return [...map.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.employeeId.localeCompare(b.employeeId));
}

/* ------------------------------------------------ selected-day list: heading, header, order, totals ------------------------------------------------ */

/**
 * Task heading parts. Only TWO task types exist: MANUAL (deliberately created by an SO, RM or Admin — also through the Calendar, and still Manual after it moves into Daily Work)
 * and AUTO (generated by a business workflow, e.g. a Billing Exception). "Calendar" is where a task was created, never a type. The subtype is the real recovery / sales
 * classification (Regular | Scheme for Sales and Recovery, the generating source for Auto tasks) — a section without a subtype has none.
 */
export type TaskTypeKind = "MANUAL" | "AUTO";
export type TaskSubtype = "REGULAR" | "SCHEME" | "BILLING_EXCEPTION" | "CN_REQUEST" | null;
export function taskSubtype(section: string, entryType: string | null | undefined, autoSource: "BILLING_EXCEPTION" | "CN_REQUEST" | null): TaskSubtype {
  if (autoSource) return autoSource;
  if (section === "SALES" || section === "RECOVERY") return entryType === "SCHEME" ? "SCHEME" : "REGULAR";
  return null;
}

/** "Suresh Verma [Raigarh] CG" — territory in brackets, then state; a missing part (and its brackets) is simply left out. */
export function employeeHeaderParts(name: string, territory: string | null | undefined, state: string | null | undefined): { name: string; territory: string | null; state: string | null } {
  const clean = (v: string | null | undefined) => { const t = (v ?? "").replace(/\s+/g, " ").trim(); return t && t.toLowerCase() !== "undefined" && t.toLowerCase() !== "null" ? t : null; };
  return { name, territory: clean(territory), state: clean(state) };
}
export const employeeHeaderText = (name: string, territory: string | null | undefined, state: string | null | undefined): string => {
  const p = employeeHeaderParts(name, territory, state);
  return [p.name, p.territory ? `[${p.territory}]` : null, p.state].filter(Boolean).join(" ");
};

export type DayItemType = "event" | "party" | "billing" | "task" | "entry" | "note";
export interface DayItem<I extends DayGroupInput> { type: DayItemType; id: string; data: I["events"][number] | I["partyEvents"][number] | I["billingTasks"][number] | I["entries"][number] | I["notes"][number] }
const ITEM_RANK: Record<DayItemType, number> = { event: 0, party: 1, billing: 2, task: 3, entry: 4, note: 5 };
/**
 * One employee's agenda as ONE ordered list (numbered 1, 2, 3… for the selected date). The order is deterministic — kind, then creation time, then id — so a refresh never
 * reshuffles the numbers, and nothing is merged: every record keeps its own entry.
 */
export function orderedDayItems<I extends DayGroupInput>(g: DayEmployeeGroup<I>): DayItem<I>[] {
  const items: (DayItem<I> & { sort: string })[] = [];
  const at = (x: unknown) => String((x as { createdAt?: string }).createdAt ?? "");
  for (const e of g.events) items.push({ type: "event", id: String((e as { planId?: string }).planId), data: e, sort: "" });
  for (const e of g.partyEvents) items.push({ type: "party", id: String((e as { planId?: string }).planId), data: e, sort: "" });
  for (const t of g.billingTasks) items.push({ type: "billing", id: String((t as { id?: string }).id), data: t, sort: "" });
  for (const e of g.entries) items.push({ type: (e as { kind?: string }).kind === "TASK" ? "task" : "entry", id: String((e as { id?: string }).id), data: e, sort: at(e) });
  for (const n of g.notes) items.push({ type: "note", id: String((n as { id?: string }).id), data: n, sort: at(n) });
  return items.sort((a, b) => ITEM_RANK[a.type] - ITEM_RANK[b.type] || a.sort.localeCompare(b.sort) || a.id.localeCompare(b.id)).map(({ sort: _s, ...rest }) => rest as DayItem<I>); // eslint-disable-line @typescript-eslint/no-unused-vars
}

/**
 * The selected day's totals for Admin / RM: how many distinct SALES OFFICERS have at least one visible item (an Admin's or RM's own reminder never counts as an SO), and
 * how many distinct work items the lists hold. Computed from the already-authorized groups (date, State / Sales Officer filters and permissions are already applied), so they
 * do not depend on which accordions are open.
 */
export function dayTotals(groups: readonly { employeeId: string; count: number }[], roleOf: (employeeId: string) => string | null | undefined): { officers: number; tasks: number } {
  return { officers: groups.filter((g) => g.count > 0 && roleOf(g.employeeId) === "SALES_OFFICER").length, tasks: groups.reduce((n, g) => n + g.count, 0) };
}
