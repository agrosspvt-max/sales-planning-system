import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";

import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope, assertOfficerInScope, getCurrentDealerIds } from "@/lib/scope";
import { currentBusinessDate, MANDATORY_SECTIONS, RECOVERY_PAYMENT_MODES } from "@/lib/daily-work";
import {
  monthRange, upcomingRange, dateKey,
  projectConversionEvents, type ConversionEvent, type ConversionEventInput,
  projectPartyAppointmentEvents, type PartyAppointmentEvent, type PartyAppointmentInput,
} from "@/lib/calendar";
import { getCalendarEnabled } from "@/lib/recovery-config";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";

/**
 * Operational Calendar server loader.
 *
 * CONVERSION events are PROJECTED from DealerSchemePlan at read time (never stored): a single scoped, ranged
 * query per month/window → `projectConversionEvents`. Scope reuses `getOfficerScope` (SO = own, RM = team,
 * Admin = all), so a Sales Officer only ever sees their own conversions and an RM/Admin sees the team/all.
 *
 * Stored calendar data: CalendarNote (personal per-day notes — unchanged) and CalendarEntry (Daily Task / Meeting /
 * Reminder / Other, each owned by its creator). Notes are private to their owner; Admin additionally sees everyone's
 * notes. A CalendarEntry TASK is the source of a Daily Work row (see daily-work/calendar-task-materialization.server.ts).
 *
 * WHOSE entries/events are shown is decided ONCE, server-side (`resolveCalendarOwners`): SO → self; RM → "mine" (self) or
 * "team" (the existing getOfficerScope: self + group SOs); Admin → everyone; then the State (group) and Sales Officer
 * filters only NARROW that set (the officer is re-validated against it, so a manipulated parameter can never widen it).
 */

const PLAN_SELECT = {
  id: true, schemeId: true, dealerId: true, expectedBillingDate: true, originalConversionDate: true, conversionExtensionCount: true,
  numberOfSchemes: true, totalSchemeAmount: true, salesOfficerId: true, planStatus: true, schemeStatus: true, enrollmentStatus: true,
  dealer: { select: { name: true } }, scheme: { select: { schemeName: true } }, salesOfficer: { select: { name: true } },
} as const;

type PlanRow = {
  id: string; schemeId: string; dealerId: string; expectedBillingDate: Date | null; originalConversionDate: Date | null; conversionExtensionCount: number;
  numberOfSchemes: number; totalSchemeAmount: unknown; salesOfficerId: string; planStatus: string; schemeStatus: string; enrollmentStatus: string;
  dealer: { name: string }; scheme: { schemeName: string }; salesOfficer: { name: string };
};

const asNum = (v: unknown): number => (v == null ? 0 : Number(v.toString()));

/** Every Calendar read/write is guarded server-side; disabling the feature never deletes its stored notes. */
async function assertCalendarEnabled(): Promise<void> {
  if (!(await getCalendarEnabled())) throw new ApiError(403, "Calendar is disabled");
}

function toInput(r: PlanRow, aliasNames?: Map<string, string>): ConversionEventInput {
  return {
    dealerId: r.dealerId,
    id: r.id, schemeId: r.schemeId, expectedBillingDate: r.expectedBillingDate, originalConversionDate: r.originalConversionDate,
    // DISPLAY-only: alias-preferred dealer name; the event still belongs to the same dealer id.
    dealerName: aliasNames?.get(r.dealerId) ?? r.dealer.name, schemeName: r.scheme.schemeName, numberOfSchemes: r.numberOfSchemes || 1, totalSchemeAmount: asNum(r.totalSchemeAmount),
    salesOfficerId: r.salesOfficerId, salesOfficerName: r.salesOfficer.name, planStatus: r.planStatus, schemeStatus: r.schemeStatus,
    enrollmentStatus: r.enrollmentStatus, conversionExtensionCount: r.conversionExtensionCount,
  };
}

export type CalendarView = "mine" | "team";

/**
 * The owner ids whose calendar the caller may see for this request, or null = unrestricted (Admin, no filter).
 *  • no `view` (legacy callers) behaves as "team": the caller's existing officer scope;
 *  • a Sales Officer is always limited to themselves;
 *  • `officerId` must lie INSIDE the base set (403 otherwise — never widens);
 *  • `groupId` (State) keeps only owners of that group.
 */
async function resolveCalendarOwners(ctx: AuthContext, opts: { officerId?: string; view?: CalendarView; groupId?: string }): Promise<string[] | null> {
  const scope = await getOfficerScope(ctx);
  let base: string[] | null = ctx.role === Role.SALES_OFFICER ? [ctx.userId]
    : opts.view === "mine" && !isAdministrativeRole(ctx.role) ? [ctx.userId]
    : scope.all ? null : scope.ids;
  if (opts.officerId) {
    if (base ? !base.includes(opts.officerId) : false) throw new ApiError(403, "You do not have access to this Sales Officer's data");
    if (!base) await assertOfficerInScope(ctx, opts.officerId);
    base = [opts.officerId];
  }
  if (opts.groupId) {
    const users = (await prisma.user.findMany({ where: { groupId: opts.groupId, ...(base ? { id: { in: base } } : {}) }, select: { id: true } })) as { id: string }[];
    base = users.map((u) => u.id);
  }
  return base;
}

export interface CalendarNoteDto {
  id: string; dateKey: string; text: string; ownerId: string; ownerName: string;
  createdAt: string; updatedAt: string; canEdit: boolean;
}

type NoteRow = { id: string; ownerId: string; date: Date; text: string; createdAt: Date; updatedAt: Date; owner: { name: string } };

/** Notes visible to the caller in [gte, lt): own notes always; Admin also sees everyone's. `officerId`
 *  (Admin only) narrows to that owner. RM/SO always see only their own notes. */
async function loadNotes(ctx: AuthContext, gte: Date, lt: Date, ownerIds: string[] | null = null): Promise<CalendarNoteDto[]> {
  const isAdmin = isAdministrativeRole(ctx.role);
  const ownerWhere = isAdmin ? (ownerIds ? { ownerId: { in: ownerIds } } : {}) : { ownerId: ctx.userId };
  const rows = (await prisma.calendarNote.findMany({
    where: { date: { gte, lt }, ...ownerWhere },
    select: { id: true, ownerId: true, date: true, text: true, createdAt: true, updatedAt: true, owner: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  })) as unknown as NoteRow[];
  return rows.map((n) => ({
    id: n.id, dateKey: dateKey(n.date)!, text: n.text, ownerId: n.ownerId, ownerName: n.owner.name,
    createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString(), canEdit: n.ownerId === ctx.userId,
  }));
}

/**
 * APPROVED Party Plans within [gte, lt), scoped like conversions (SO own, RM team, Admin all; optional
 * `officerId` narrows to one Sales Officer within the caller's scope). Read via raw SQL because the generated
 * Prisma client does not yet expose PartyPlan in this environment. Only APPROVED rows are selected, and the
 * date is read as a pure "YYYY-MM-DD" (`appointmentDate::text`) so no timezone shift is possible. One ranged,
 * scoped query — never per-day — so there is no N+1.
 */
async function loadPartyAppointments(gte: Date, lt: Date, ownerIds: string[] | null): Promise<PartyAppointmentInput[]> {
  // The owner set is resolved once (resolveCalendarOwners): an explicit id list, or null = everyone.
  const scopeClause: Prisma.Sql = ownerIds === null
    ? Prisma.empty
    : ownerIds.length > 0
      ? Prisma.sql`AND p."salesOfficerId" IN (${Prisma.join(ownerIds)})`
      : Prisma.sql`AND FALSE`;
  // Half-open [gte, lt) on the DATE column, comparing against date literals (no time component).
  const gteKey = dateKey(gte)!;
  const ltKey = dateKey(lt)!;
  const rows = await prisma.$queryRaw<{ id: string; partyName: string | null; marketName: string | null; appointmentDate: string | null; salesOfficerId: string; salesOfficerName: string }[]>(Prisma.sql`
    SELECT p."id", p."partyName", p."marketName", p."appointmentDate"::text AS "appointmentDate",
           p."salesOfficerId", u."name" AS "salesOfficerName"
    FROM "PartyPlan" p JOIN "User" u ON u."id" = p."salesOfficerId"
    WHERE p."status" = 'APPROVED'
      AND p."appointmentDate" IS NOT NULL
      AND p."appointmentDate" >= ${gteKey}::date AND p."appointmentDate" < ${ltKey}::date
      ${scopeClause}`);
  return rows.map((r) => ({
    id: r.id, partyName: r.partyName, marketName: r.marketName, appointmentDate: r.appointmentDate,
    salesOfficerId: r.salesOfficerId, salesOfficerName: r.salesOfficerName,
  }));
}

/* ------------------------------ Calendar entries (Daily Task / Meeting / Reminder / Other) ------------------------------ */

export const CALENDAR_ENTRY_KINDS = ["TASK", "MEETING", "REMINDER", "OTHER"] as const;
export type CalendarEntryKind = (typeof CALENDAR_ENTRY_KINDS)[number];

export interface CalendarEntryTaskDto {
  section: string; dealerId: string | null; dealerName: string | null; amount: number | null; paymentMode: string | null;
  typedDealerName: string | null; marketName: string | null; dealerVisits: number | null; newPartyVisits: number | null;
}
export interface CalendarEntryDto {
  id: string; dateKey: string; kind: CalendarEntryKind; text: string | null;
  ownerId: string; ownerName: string; ownerRole: string; ownerRoleLabel: string; ownerState: string | null;
  task: CalendarEntryTaskDto | null;
  materialized: boolean; // a TASK already became a Daily Work row
  canEdit: boolean; canDelete: boolean; createdAt: string;
}
export interface CalendarOfficerOption { id: string; name: string; role: string; roleLabel: string; groupId: string | null }
export interface CalendarStateOption { id: string; name: string }

const ROLE_LABELS: Record<string, string> = { SALES_OFFICER: "Sales Officer", REGIONAL_MANAGER: "Regional Manager", SUPER_ADMIN: "Admin", CUSTOM_ADMIN: "Admin" };
const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;
/** Who can own a Daily Task (the same owners as Daily Work itself): Sales Officers and Regional Managers. */
const canOwnDailyTask = (role: Role) => role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;

type EntryRow = {
  id: string; ownerId: string; date: Date; kind: string; text: string | null; taskSection: string | null; dealerId: string | null;
  amount: unknown; paymentMode: string | null; typedDealerName: string | null; marketName: string | null;
  dealerVisits: number | null; newPartyVisits: number | null; materializedAt: Date | null; createdAt: Date;
  owner: { name: string; role: string; group: { id: string; name: string } | null };
};
const ENTRY_SELECT = {
  id: true, ownerId: true, date: true, kind: true, text: true, taskSection: true, dealerId: true, amount: true, paymentMode: true,
  typedDealerName: true, marketName: true, dealerVisits: true, newPartyVisits: true, materializedAt: true, createdAt: true,
  owner: { select: { name: true, role: true, group: { select: { id: true, name: true } } } },
} as const;

async function toEntryDtos(ctx: AuthContext, rows: EntryRow[]): Promise<CalendarEntryDto[]> {
  const dealerIds = [...new Set(rows.map((r) => r.dealerId).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (dealerIds.length > 0) {
    const [dealers, aliases] = await Promise.all([
      prisma.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true } }) as Promise<{ id: string; name: string }[]>,
      loadDealerAliasNameMap(dealerIds),
    ]);
    for (const d of dealers) names.set(d.id, aliases.get(d.id) ?? d.name); // DISPLAY-only alias-preferred name
  }
  return rows.map((r) => ({
    id: r.id, dateKey: dateKey(r.date)!, kind: r.kind as CalendarEntryKind, text: r.text,
    ownerId: r.ownerId, ownerName: r.owner.name, ownerRole: r.owner.role, ownerRoleLabel: roleLabel(r.owner.role), ownerState: r.owner.group?.name ?? null,
    task: r.kind === "TASK" ? {
      section: r.taskSection ?? "", dealerId: r.dealerId, dealerName: r.dealerId ? (names.get(r.dealerId) ?? null) : null,
      amount: r.amount == null ? null : asNum(r.amount), paymentMode: r.paymentMode, typedDealerName: r.typedDealerName, marketName: r.marketName,
      dealerVisits: r.dealerVisits, newPartyVisits: r.newPartyVisits,
    } : null,
    materialized: r.materializedAt != null,
    canEdit: r.ownerId === ctx.userId && r.kind !== "TASK",
    canDelete: r.ownerId === ctx.userId && r.materializedAt == null,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function loadEntries(ctx: AuthContext, gte: Date, lt: Date, ownerIds: string[] | null): Promise<CalendarEntryDto[]> {
  const rows = (await prisma.calendarEntry.findMany({
    where: { date: { gte, lt }, ...(ownerIds ? { ownerId: { in: ownerIds } } : {}) },
    select: ENTRY_SELECT, orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  })) as unknown as EntryRow[];
  return toEntryDtos(ctx, rows);
}

export interface CalendarPayload {
  events: ConversionEvent[]; partyEvents: PartyAppointmentEvent[]; notes: CalendarNoteDto[]; entries: CalendarEntryDto[];
  canFilterOfficers: boolean; officers: CalendarOfficerOption[]; states: CalendarStateOption[];
  view: CalendarView; canTeamView: boolean; taskSections: string[]; paymentModes: string[];
  /** The caller's OWN assigned dealers (for the Daily Task form's Sales / Recovery dealer choice). [] when they cannot add tasks. */
  myDealers: { id: string; name: string }[];
}

/**
 * One month of the calendar. `view` ("mine" | "team", Regional Manager) and the `groupId` (State) / `officerId`
 * (Sales Officer or Regional Manager) filters only ever NARROW the caller's own scope — see resolveCalendarOwners.
 */
export async function calendarMonth(ctx: AuthContext, opts: { year: number; month: number; officerId?: string; view?: CalendarView; groupId?: string }): Promise<CalendarPayload> {
  await assertCalendarEnabled();
  const { year, month } = opts;
  const { gte, lt } = monthRange(year, month);
  const isRm = ctx.role === Role.REGIONAL_MANAGER;
  const effectiveView: CalendarView = isRm && opts.view === "mine" ? "mine" : "team"; // no `view` = the legacy team scope
  const ownerIds = await resolveCalendarOwners(ctx, { officerId: opts.officerId, view: effectiveView, groupId: opts.groupId });
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { expectedBillingDate: { gte, lt }, ...(ownerIds ? { salesOfficerId: { in: ownerIds } } : {}) },
    select: PLAN_SELECT,
  })) as unknown as PlanRow[];
  const calAliasNames = await loadDealerAliasNameMap(rows.map((r) => r.dealerId));
  const events = projectConversionEvents(rows.map((r) => toInput(r, calAliasNames)));
  const partyEvents = projectPartyAppointmentEvents(await loadPartyAppointments(gte, lt, ownerIds));
  const notes = await loadNotes(ctx, gte, lt, ownerIds);
  const entries = await loadEntries(ctx, gte, lt, ownerIds);
  // Filter options come from the caller's scope ONLY (never the whole company): Sales Officers AND Regional Managers.
  const canFilterOfficers = ctx.role !== Role.SALES_OFFICER && !(isRm && effectiveView === "mine");
  const options = canFilterOfficers ? await officerOptions(ctx) : [];
  const states = [...new Map(options.filter((o) => o.group).map((o) => [o.group!.id, { id: o.group!.id, name: o.group!.name }])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const myDealers = canOwnDailyTask(ctx.role) ? await loadMyDealers(ctx.userId) : [];
  return {
    myDealers,
    events, partyEvents, notes, entries, canFilterOfficers,
    officers: options.map((o) => ({ id: o.id, name: o.name, role: o.role, roleLabel: roleLabel(o.role), groupId: o.group?.id ?? null })),
    states, view: effectiveView, canTeamView: isRm, taskSections: [...MANDATORY_SECTIONS], paymentModes: [...RECOVERY_PAYMENT_MODES],
  };
}

/** The caller's own current dealers (alias-preferred display names), name-sorted. */
async function loadMyDealers(userId: string): Promise<{ id: string; name: string }[]> {
  const ids = await getCurrentDealerIds(userId);
  if (ids.length === 0) return [];
  const [dealers, aliases] = await Promise.all([
    prisma.dealer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) as Promise<{ id: string; name: string }[]>,
    loadDealerAliasNameMap(ids),
  ]);
  return dealers.map((d) => ({ id: d.id, name: aliases.get(d.id) ?? d.name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Filter options — Sales Officers AND Regional Managers inside the caller's scope (RM: self + their group; Admin: everyone). */
async function officerOptions(ctx: AuthContext): Promise<{ id: string; name: string; role: string; group: { id: string; name: string } | null }[]> {
  const scope = await getOfficerScope(ctx);
  const where = scope.all
    ? { role: { in: [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] }, isActive: true, deletedAt: null }
    : { id: { in: scope.ids }, role: { in: [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] }, isActive: true, deletedAt: null };
  return (await prisma.user.findMany({ where, select: { id: true, name: true, role: true, group: { select: { id: true, name: true } } }, orderBy: { name: "asc" } })) as unknown as { id: string; name: string; role: string; group: { id: string; name: string } | null }[];
}

export interface UpcomingItem {
  kind: "CONVERSION" | "PARTY_APPOINTMENT" | "NOTE";
  dateKey: string;
  event?: ConversionEvent;
  partyEvent?: PartyAppointmentEvent;
  note?: CalendarNoteDto;
}

/** Sort priority within a day: conversions first, then party appointments, then notes. */
const UPCOMING_KIND_ORDER: Record<UpcomingItem["kind"], number> = { CONVERSION: 0, PARTY_APPOINTMENT: 1, NOTE: 2 };

/** Upcoming conversions + party appointments + notes within [today, today+days) for the caller's scope —
 *  future-only, sorted by date then kind. */
export async function calendarUpcoming(ctx: AuthContext, days = 5): Promise<UpcomingItem[]> {
  await assertCalendarEnabled();
  const { gte, lt } = upcomingRange(new Date(), days);
  const ownerIds = await resolveCalendarOwners(ctx, {});
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { expectedBillingDate: { gte, lt }, ...(ownerIds ? { salesOfficerId: { in: ownerIds } } : {}) },
    select: PLAN_SELECT,
  })) as unknown as PlanRow[];
  const upcomingAliasNames = await loadDealerAliasNameMap(rows.map((r) => r.dealerId));
  const events = projectConversionEvents(rows.map((r) => toInput(r, upcomingAliasNames)));
  const partyEvents = projectPartyAppointmentEvents(await loadPartyAppointments(gte, lt, ownerIds));
  const notes = await loadNotes(ctx, gte, lt);
  const items: UpcomingItem[] = [
    ...events.map((e): UpcomingItem => ({ kind: "CONVERSION", dateKey: e.dateKey, event: e })),
    ...partyEvents.map((e): UpcomingItem => ({ kind: "PARTY_APPOINTMENT", dateKey: e.dateKey, partyEvent: e })),
    ...notes.map((n): UpcomingItem => ({ kind: "NOTE", dateKey: n.dateKey, note: n })),
  ];
  return items.sort((a, b) => (a.dateKey === b.dateKey ? UPCOMING_KIND_ORDER[a.kind] - UPCOMING_KIND_ORDER[b.kind] : a.dateKey.localeCompare(b.dateKey)));
}

/* ------------------------------ Notes CRUD (owner-only writes) ------------------------------ */

const noteInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A valid date is required"),
  text: z.string().trim().min(1, "Note text is required").max(2000),
});
const noteUpdateInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  text: z.string().trim().min(1, "Note text is required").max(2000).optional(),
});

export async function createCalendarNote(ctx: AuthContext, raw: unknown): Promise<CalendarNoteDto> {
  await assertCalendarEnabled();
  const data = noteInput.parse(raw);
  const note = (await prisma.calendarNote.create({
    data: { ownerId: ctx.userId, date: new Date(`${data.date}T00:00:00.000Z`), text: data.text },
    select: { id: true, ownerId: true, date: true, text: true, createdAt: true, updatedAt: true, owner: { select: { name: true } } },
  })) as unknown as NoteRow;
  return { id: note.id, dateKey: dateKey(note.date)!, text: note.text, ownerId: note.ownerId, ownerName: note.owner.name, createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString(), canEdit: true };
}

async function assertOwnNote(ctx: AuthContext, id: string): Promise<void> {
  const existing = (await prisma.calendarNote.findUnique({ where: { id }, select: { ownerId: true } })) as { ownerId: string } | null;
  if (!existing) throw new ApiError(404, "Note not found");
  if (existing.ownerId !== ctx.userId) throw new ApiError(403, "You can only edit your own notes");
}

export async function updateCalendarNote(ctx: AuthContext, id: string, raw: unknown): Promise<CalendarNoteDto> {
  await assertCalendarEnabled();
  await assertOwnNote(ctx, id);
  const data = noteUpdateInput.parse(raw);
  const note = (await prisma.calendarNote.update({
    where: { id },
    data: { ...(data.text !== undefined ? { text: data.text } : {}), ...(data.date !== undefined ? { date: new Date(`${data.date}T00:00:00.000Z`) } : {}) },
    select: { id: true, ownerId: true, date: true, text: true, createdAt: true, updatedAt: true, owner: { select: { name: true } } },
  })) as unknown as NoteRow;
  return { id: note.id, dateKey: dateKey(note.date)!, text: note.text, ownerId: note.ownerId, ownerName: note.owner.name, createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString(), canEdit: true };
}

export async function deleteCalendarNote(ctx: AuthContext, id: string): Promise<{ ok: true }> {
  await assertCalendarEnabled();
  await assertOwnNote(ctx, id);
  await prisma.calendarNote.delete({ where: { id } });
  return { ok: true };
}

/* ------------------------------ Entries CRUD (owner-only writes) ------------------------------ */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A valid date is required");
const detailText = z.string().trim().min(1, "Details are required").max(2000);
const entryInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MEETING"), date: dateStr, text: detailText }),
  z.object({ kind: z.literal("REMINDER"), date: dateStr, text: detailText }),
  z.object({ kind: z.literal("OTHER"), date: dateStr, text: detailText }),
  z.object({
    kind: z.literal("TASK"), date: dateStr,
    // The task sections are exactly the ACTIVE Daily Work sections (MANDATORY_SECTIONS) — a disabled one is rejected below.
    section: z.string(),
    dealerId: z.string().min(1).optional(),
    amount: z.coerce.number().positive("Enter an amount greater than 0").max(1_000_000_000).optional(),
    paymentMode: z.enum(RECOVERY_PAYMENT_MODES as unknown as [string, ...string[]]).nullish(),
    dealerName: z.string().trim().max(200).optional(),
    marketName: z.string().trim().max(200).optional(),
    dealerVisits: z.coerce.number().int().min(0).max(1000).optional(),
    newPartyVisits: z.coerce.number().int().min(0).max(1000).optional(),
    text: z.string().trim().max(2000).optional(),
  }),
]);
const entryUpdateInput = z.object({ text: detailText.optional(), date: dateStr.optional() });

async function dailyWorkDayFinalized(ownerId: string, workDate: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ status: string }[]>(Prisma.sql`
    SELECT "status" FROM "DailyWorkDay" WHERE "officerId" = ${ownerId} AND "workDate" = ${workDate}::date LIMIT 1`);
  return rows[0]?.status === "FINALIZED";
}

/**
 * Create a Calendar entry owned by the CALLER (creator = owner; nobody creates on someone else's behalf). A TASK is validated
 * with the Daily Work rules it will be materialized under: an active section, the officer's own assigned dealer, a positive
 * amount, a today-or-future date, and — for today — a Daily Work that is not already finalized (a finalized day is never
 * mutated). Meetings / Reminders / Other are calendar-only and never become Daily Work.
 */
export async function createCalendarEntry(ctx: AuthContext, raw: unknown): Promise<CalendarEntryDto> {
  await assertCalendarEnabled();
  const parsed = entryInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid calendar entry");
  const data = parsed.data;
  const date = new Date(`${data.date}T00:00:00.000Z`);
  let create: Record<string, unknown>;

  if (data.kind === "TASK") {
    if (!canOwnDailyTask(ctx.role)) throw new ApiError(403, "Only a Sales Officer or Regional Manager can add a Daily Task");
    const section = data.section;
    if (!(MANDATORY_SECTIONS as readonly string[]).includes(section)) throw new ApiError(422, "This task type is not available in Daily Work");
    const today = currentBusinessDate();
    if (data.date < today) throw new ApiError(422, "A Daily Task can only be added for today or a future date");
    if (data.date === today && (await dailyWorkDayFinalized(ctx.userId, today))) throw new ApiError(409, "Today's Daily Work has already been finalized");
    create = { kind: "TASK", taskSection: section };
    if (section === "SALES" || section === "RECOVERY") {
      if (!data.dealerId) throw new ApiError(422, "Select a dealer");
      if (data.amount == null) throw new ApiError(422, "Enter an amount greater than 0");
      if (!(await getCurrentDealerIds(ctx.userId)).includes(data.dealerId)) throw new ApiError(403, "This dealer is not assigned to you");
      Object.assign(create, { dealerId: data.dealerId, amount: data.amount, entryType: "REGULAR", ...(section === "RECOVERY" ? { paymentMode: data.paymentMode ?? null } : {}) });
    } else if (section === "APPOINTMENT") {
      if (!data.dealerName?.trim()) throw new ApiError(422, "Enter the dealer name");
      Object.assign(create, { typedDealerName: data.dealerName.trim(), marketName: data.marketName?.trim() || null });
    } else if (section === "VISITS") {
      const dv = data.dealerVisits ?? 0, npv = data.newPartyVisits ?? 0;
      if (dv + npv <= 0) throw new ApiError(422, "Enter the number of visits");
      Object.assign(create, { dealerVisits: dv, newPartyVisits: npv });
    } else if (section === "OTHERS") {
      if (!data.text?.trim()) throw new ApiError(422, "Enter the task details");
      create.text = data.text.trim();
    }
  } else {
    create = { kind: data.kind, text: data.text };
  }

  const row = (await prisma.calendarEntry.create({
    data: { ownerId: ctx.userId, date, ...create } as never,
    select: ENTRY_SELECT,
  })) as unknown as EntryRow;
  return (await toEntryDtos(ctx, [row]))[0]!;
}

async function assertOwnEntry(ctx: AuthContext, id: string): Promise<{ kind: string; materializedAt: Date | null }> {
  const existing = (await prisma.calendarEntry.findUnique({ where: { id }, select: { ownerId: true, kind: true, materializedAt: true } })) as { ownerId: string; kind: string; materializedAt: Date | null } | null;
  if (!existing) throw new ApiError(404, "Calendar entry not found");
  if (existing.ownerId !== ctx.userId) throw new ApiError(403, "You can only change your own calendar entries");
  return existing;
}

/** Edit a Meeting / Reminder / Other (text and date). A Daily Task is not edited here — it is a Daily Work source. */
export async function updateCalendarEntry(ctx: AuthContext, id: string, raw: unknown): Promise<CalendarEntryDto> {
  await assertCalendarEnabled();
  const existing = await assertOwnEntry(ctx, id);
  if (existing.kind === "TASK") throw new ApiError(409, "A Daily Task cannot be edited; delete it and add it again");
  const parsed = entryUpdateInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid calendar entry");
  const row = (await prisma.calendarEntry.update({
    where: { id },
    data: { ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}), ...(parsed.data.date !== undefined ? { date: new Date(`${parsed.data.date}T00:00:00.000Z`) } : {}) },
    select: ENTRY_SELECT,
  })) as unknown as EntryRow;
  return (await toEntryDtos(ctx, [row]))[0]!;
}

/** Delete your own entry. A Daily Task that already became a Daily Work row cannot be deleted here (409) — Daily Work owns it now. */
export async function deleteCalendarEntry(ctx: AuthContext, id: string): Promise<{ ok: true }> {
  await assertCalendarEnabled();
  const existing = await assertOwnEntry(ctx, id);
  if (existing.materializedAt) throw new ApiError(409, "This task is already in Daily Work");
  await prisma.calendarEntry.delete({ where: { id } });
  return { ok: true };
}
