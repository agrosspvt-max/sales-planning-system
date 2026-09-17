import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope, assertOfficerInScope } from "@/lib/scope";
import { monthRange, upcomingRange, dateKey, projectConversionEvents, type ConversionEvent, type ConversionEventInput } from "@/lib/calendar";
import { getCalendarEnabled } from "@/lib/recovery-config";

/**
 * Operational Calendar server loader.
 *
 * CONVERSION events are PROJECTED from DealerSchemePlan at read time (never stored): a single scoped, ranged
 * query per month/window → `projectConversionEvents`. Scope reuses `getOfficerScope` (SO = own, RM = team,
 * Admin = all), so a Sales Officer only ever sees their own conversions and an RM/Admin sees the team/all.
 *
 * The ONLY stored calendar data is CalendarNote (personal per-day notes). Notes are private to their owner;
 * Admin additionally sees everyone's notes (grouped by owner in the UI). Notes never affect Scheme Planning.
 */

const PLAN_SELECT = {
  id: true, schemeId: true, expectedBillingDate: true, originalConversionDate: true, conversionExtensionCount: true,
  numberOfSchemes: true, totalSchemeAmount: true, salesOfficerId: true, planStatus: true, schemeStatus: true, enrollmentStatus: true,
  dealer: { select: { name: true } }, scheme: { select: { schemeName: true } }, salesOfficer: { select: { name: true } },
} as const;

type PlanRow = {
  id: string; schemeId: string; expectedBillingDate: Date | null; originalConversionDate: Date | null; conversionExtensionCount: number;
  numberOfSchemes: number; totalSchemeAmount: unknown; salesOfficerId: string; planStatus: string; schemeStatus: string; enrollmentStatus: string;
  dealer: { name: string }; scheme: { schemeName: string }; salesOfficer: { name: string };
};

const asNum = (v: unknown): number => (v == null ? 0 : Number(v.toString()));

/** Every Calendar read/write is guarded server-side; disabling the feature never deletes its stored notes. */
async function assertCalendarEnabled(): Promise<void> {
  if (!(await getCalendarEnabled())) throw new ApiError(403, "Calendar is disabled");
}

function toInput(r: PlanRow): ConversionEventInput {
  return {
    id: r.id, schemeId: r.schemeId, expectedBillingDate: r.expectedBillingDate, originalConversionDate: r.originalConversionDate,
    dealerName: r.dealer.name, schemeName: r.scheme.schemeName, numberOfSchemes: r.numberOfSchemes || 1, totalSchemeAmount: asNum(r.totalSchemeAmount),
    salesOfficerId: r.salesOfficerId, salesOfficerName: r.salesOfficer.name, planStatus: r.planStatus, schemeStatus: r.schemeStatus,
    enrollmentStatus: r.enrollmentStatus, conversionExtensionCount: r.conversionExtensionCount,
  };
}

/** Officer-scope WHERE fragment for plan queries. Optional `officerId` narrows to a single officer, validated
 *  against the caller's scope (an RM can only pick their own team; a Sales Officer only themselves). */
async function officerPlanWhere(ctx: AuthContext, officerId?: string): Promise<Record<string, unknown>> {
  const scope = await getOfficerScope(ctx);
  if (officerId) { await assertOfficerInScope(ctx, officerId); return { salesOfficerId: officerId }; }
  return scope.all ? {} : { salesOfficerId: { in: scope.ids } };
}

export interface CalendarNoteDto {
  id: string; dateKey: string; text: string; ownerId: string; ownerName: string;
  createdAt: string; updatedAt: string; canEdit: boolean;
}

type NoteRow = { id: string; ownerId: string; date: Date; text: string; createdAt: Date; updatedAt: Date; owner: { name: string } };

/** Notes visible to the caller in [gte, lt): own notes always; Admin also sees everyone's. `officerId`
 *  (Admin only) narrows to that owner. RM/SO always see only their own notes. */
async function loadNotes(ctx: AuthContext, gte: Date, lt: Date, officerId?: string): Promise<CalendarNoteDto[]> {
  const isAdmin = ctx.role === Role.SUPER_ADMIN;
  const ownerWhere = isAdmin ? (officerId ? { ownerId: officerId } : {}) : { ownerId: ctx.userId };
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

export interface CalendarPayload { events: ConversionEvent[]; notes: CalendarNoteDto[]; canFilterOfficers: boolean; officers: { id: string; name: string }[] }

/** One month of the calendar for the caller's scope. `officerId` (Admin/RM) narrows to one Sales Officer. */
export async function calendarMonth(ctx: AuthContext, opts: { year: number; month: number; officerId?: string }): Promise<CalendarPayload> {
  await assertCalendarEnabled();
  const { year, month, officerId } = opts;
  const { gte, lt } = monthRange(year, month);
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { expectedBillingDate: { gte, lt }, ...(await officerPlanWhere(ctx, officerId)) },
    select: PLAN_SELECT,
  })) as unknown as PlanRow[];
  const events = projectConversionEvents(rows.map(toInput));
  const notes = await loadNotes(ctx, gte, lt, officerId);
  const scope = await getOfficerScope(ctx);
  const canFilterOfficers = ctx.role !== Role.SALES_OFFICER;
  const officers = canFilterOfficers ? await officerOptions(ctx, scope) : [];
  return { events, notes, canFilterOfficers, officers };
}

/** Officer options for the Admin/RM filter — the officers in the caller's scope. */
async function officerOptions(ctx: AuthContext, scope: { all: boolean; ids: string[] }): Promise<{ id: string; name: string }[]> {
  const where = scope.all ? { role: Role.SALES_OFFICER, isActive: true, deletedAt: null } : { id: { in: scope.ids } };
  const users = (await prisma.user.findMany({ where, select: { id: true, name: true }, orderBy: { name: "asc" } })) as { id: string; name: string }[];
  return users;
}

export interface UpcomingItem {
  kind: "CONVERSION" | "NOTE";
  dateKey: string;
  event?: ConversionEvent;
  note?: CalendarNoteDto;
}

/** Upcoming conversions + notes within [today, today+days) for the caller's scope — future-only, sorted by date. */
export async function calendarUpcoming(ctx: AuthContext, days = 5): Promise<UpcomingItem[]> {
  await assertCalendarEnabled();
  const { gte, lt } = upcomingRange(new Date(), days);
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { expectedBillingDate: { gte, lt }, ...(await officerPlanWhere(ctx)) },
    select: PLAN_SELECT,
  })) as unknown as PlanRow[];
  const events = projectConversionEvents(rows.map(toInput));
  const notes = await loadNotes(ctx, gte, lt);
  const items: UpcomingItem[] = [
    ...events.map((e): UpcomingItem => ({ kind: "CONVERSION", dateKey: e.dateKey, event: e })),
    ...notes.map((n): UpcomingItem => ({ kind: "NOTE", dateKey: n.dateKey, note: n })),
  ];
  return items.sort((a, b) => (a.dateKey === b.dateKey ? (a.kind === "NOTE" ? 1 : -1) : a.dateKey.localeCompare(b.dateKey)));
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
