import "server-only";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { isAdministrativeRole, assertAdminPermission } from "@/features/accounts/permissions";
import { getSeasonInfo, listOpenSeasonInfos, type MonthOption, type SeasonInfo } from "./season-info.server";
import { identity, monthLabel } from "@/lib/season-calendar";
import { currentBusinessDate } from "@/lib/daily-work";
import { applyAppointment, derivedType, shownMarketPotential, shownMarketSource } from "@/lib/seasonal-plan";
import {
  ADMIN_PENDING_STATUSES, OPTION_NUMBERS, STATUS_LABEL, TRANSITIONS, adminActionFor, cleanParty, monthKey, monthlySheetStatus, parseTransition, transitionActor, validatePartyName, validatePlanDate,
  type MonthlySheetStatus, type OptionNo, type OptionStatus,
} from "@/lib/monthly-plan";

/**
 * Party Planning · Monthly Planning. A "Monthly Plan" is one owner's plan for ONE selected Season + ONE of that season's months (a
 * PartyMonthlySheet); inside it sit the owner's market rows (PartyMonthlyPlan), each with two independent candidate parties
 * (Option 1 / Option 2) moving through their own lifecycle (src/lib/monthly-plan.ts).
 *
 *  • Season + month: chosen when the plan is created — an OPEN season (the Seasons module's rule) and a SeasonMonth of THAT season, listed in
 *    CALENDAR order (SEASON_MONTH_ORDER; `order` is creation order). Every later read / write loads them from the plan itself — never from
 *    "today" or a "current season".
 *  • Market: never chosen freely — it is the Seasonal Plan's Market (the row must be the caller's, APPROVED, in the plan's season). A Monthly
 *    Plan cannot even be created for a season in which the caller has no approved market.
 *  • Workflow: no second approval layer — the Seasonal Plan was already approved, and the option lifecycle itself carries the Admin steps.
 *  • Owner / season / month / market / potential / status / actor / dates are all derived server-side from authoritative records.
 *  • Every transition updates the option AND appends a PartyMonthlyEvent in ONE transaction (events are never updated or deleted).
 */

const planner = (ctx: AuthContext): boolean => ctx.role === Role.SALES_OFFICER || ctx.role === Role.REGIONAL_MANAGER;
function assertPlanner(ctx: AuthContext): void { if (!planner(ctx)) throw new ApiError(403, "Only a Sales Officer or Regional Manager can plan monthly parties"); }
/** Who may create a Monthly Plan: SO / RM, and Admin in their own right (owner = the Admin user). */
function assertSheetCreator(ctx: AuthContext): void {
  if (isAdministrativeRole(ctx.role)) return assertAdminPermission(ctx, "partyPlanning", "manage");
  assertPlanner(ctx);
}
function assertReader(ctx: AuthContext): void { if (!planner(ctx) && !isAdministrativeRole(ctx.role)) throw new ApiError(403, "You do not have access to Monthly Planning"); }
const SEASON_CLOSED = "This Monthly Plan belongs to a season that is no longer open";

/* ------------------------------------------------ plan sheets (list / create / open) ------------------------------------------------ */

export interface MonthlySheetDto {
  id: string; seasonId: string; seasonName: string; seasonOpen: boolean; seasonMonthId: string; monthLabel: string; monthKey: string;
  ownerId: string; ownerName: string; status: MonthlySheetStatus; itemCount: number; needsMyAction: number; updatedAt: string; own: boolean;
}
const sheetInclude = {
  season: { select: { name: true, year: true, status: true } },
  seasonMonth: { select: { name: true, calendarMonth: true, calendarYear: true } },
  owner: { select: { name: true } },
  items: { select: { updatedAt: true, options: { select: { status: true, partyName: true, updatedAt: true } } } },
} as const;
type SheetRow = Prisma.PartyMonthlySheetGetPayload<{ include: typeof sheetInclude }>;

/** What the caller can do next on a sheet: Admin → options waiting on an Admin step; an owner → options still Pending that have a candidate party to send. */
function needsMyAction(ctx: AuthContext, r: SheetRow): number {
  const options = r.items.flatMap((i) => i.options);
  if (isAdministrativeRole(ctx.role)) return options.filter((o) => (ADMIN_PENDING_STATUSES as readonly string[]).includes(o.status)).length;
  return r.ownerId === ctx.userId ? options.filter((o) => o.status === "PENDING" && o.partyName).length : 0;
}
function toSheetDto(ctx: AuthContext, r: SheetRow): MonthlySheetDto {
  const updated = [r.updatedAt, ...r.items.flatMap((i) => [i.updatedAt, ...i.options.map((o) => o.updatedAt)])].sort((a, b) => b.getTime() - a.getTime())[0]!;
  return {
    id: r.id, seasonId: r.seasonId, seasonName: `${r.season.name} ${r.season.year}`, seasonOpen: r.season.status === "OPEN", seasonMonthId: r.seasonMonthId,
    monthLabel: monthLabel({ ...r.seasonMonth }), monthKey: monthKey(r.seasonMonth) ?? "", ownerId: r.ownerId, ownerName: r.owner.name,
    status: monthlySheetStatus(r.items), itemCount: r.items.length, needsMyAction: needsMyAction(ctx, r), updatedAt: updated.toISOString(), own: r.ownerId === ctx.userId,
  };
}
/** The owner always; an RM their team's; Admin everyone's. Anyone else cannot tell it exists. */
async function sheetVisible(ctx: AuthContext, ownerId: string): Promise<boolean> {
  if (ownerId === ctx.userId) return true;
  const scope = await getOfficerScope(ctx);
  return scope.all || scope.ids.includes(ownerId);
}

export interface MonthlySeasonOption extends SeasonInfo { eligibleCount: number; takenMonthIds: string[] }

/**
 * The create dialog's choices: every OPEN season with its months in calendar order, how many APPROVED Seasonal Plan markets the caller has in it
 * (a Monthly Plan needs at least one — otherwise the dialog explains why it cannot be created), and the months they already have a plan for.
 */
export async function getMonthlyOptions(ctx: AuthContext): Promise<{ seasons: MonthlySeasonOption[] }> {
  assertReader(ctx);
  const seasons = await listOpenSeasonInfos();
  if (!planner(ctx) && !isAdministrativeRole(ctx.role)) return { seasons: seasons.map((s) => ({ ...s, eligibleCount: 0, takenMonthIds: [] })) };
  const [approved, taken] = await Promise.all([
    // An officer's markets are their own; Admin has no Seasonal Plan of their own, so the dependency is the season's approved markets system-wide.
    prisma.seasonalPlan.findMany({ where: { ...(planner(ctx) ? { ownerId: ctx.userId } : {}), approvalStatus: "APPROVED", seasonId: { in: seasons.map((s) => s.id) } }, select: { seasonId: true } }),
    prisma.partyMonthlySheet.findMany({ where: { ownerId: ctx.userId }, select: { seasonMonthId: true } }),
  ]);
  const takenIds = new Set(taken.map((t) => t.seasonMonthId));
  return { seasons: seasons.map((s) => ({ ...s, eligibleCount: approved.filter((a) => a.seasonId === s.id).length, takenMonthIds: s.months.filter((m) => takenIds.has(m.id)).map((m) => m.id) })) };
}

/** The Monthly Plans the caller may see, across ALL seasons and months. `needsAction` narrows to those with something the caller can act on now. */
export async function listMonthlySheets(ctx: AuthContext, filters: { seasonId?: string; needsAction?: boolean } = {}): Promise<MonthlySheetDto[]> {
  assertReader(ctx);
  const scope = await getOfficerScope(ctx);
  const rows = await prisma.partyMonthlySheet.findMany({ where: { ...(filters.seasonId ? { seasonId: filters.seasonId } : {}), ...(scope.all ? {} : { ownerId: { in: scope.ids } }) }, include: sheetInclude, take: 1000 });
  return rows.map((r) => toSheetDto(ctx, r)).filter((d) => !filters.needsAction || d.needsMyAction > 0)
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Create the caller's Monthly Plan for a CHOSEN open season and one of ITS months. Needs an approved Seasonal Plan market in that season. */
export async function createMonthlySheet(ctx: AuthContext, raw: unknown): Promise<MonthlySheetDto> {
  assertSheetCreator(ctx);
  const parsed = z.object({ seasonId: z.string().min(1, "Select a season"), seasonMonthId: z.string().min(1, "Select a month") }).safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Select a season and month");
  const season = await getSeasonInfo(parsed.data.seasonId);
  if (!season) throw new ApiError(422, "Select a valid season");
  if (season.status !== "OPEN") throw new ApiError(409, "Monthly Plans can only be created for an open season");
  const month = season.months.find((m) => m.id === parsed.data.seasonMonthId);
  if (!month) throw new ApiError(422, "Select a month of the chosen season");
  const eligible = await prisma.seasonalPlan.count({ where: { ...(planner(ctx) ? { ownerId: ctx.userId } : {}), seasonId: season.id, approvalStatus: "APPROVED" } });
  if (eligible === 0) throw new ApiError(422, `${planner(ctx) ? "You have" : "There is"} no approved Seasonal Plan market in ${season.name} ${season.year}, so there is nothing to plan monthly. Get a Seasonal Plan approved first.`);
  if (await prisma.partyMonthlySheet.findUnique({ where: { ownerId_seasonMonthId: { ownerId: ctx.userId, seasonMonthId: month.id } }, select: { id: true } })) throw new ApiError(409, `You already have a Monthly Plan for ${month.label}. Open it from the list.`);
  const created = await prisma.$transaction(async (tx) => {
    const sheet = await tx.partyMonthlySheet.create({ data: { seasonId: season.id, seasonMonthId: month.id, ownerId: ctx.userId }, include: sheetInclude });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "partyMonthlySheet", entityId: sheet.id, summary: `Monthly Plan created · ${season.name} ${season.year} · ${month.label}` }, tx);
    return sheet;
  });
  return toSheetDto(ctx, created);
}

export interface EligibleSeasonalPlan { id: string; marketName: string; marketPotential: string | null; type: "Existing" | "New" | null; partyName: string }
export interface MonthlySheetDetail { sheet: MonthlySheetDto; season: SeasonInfo; month: MonthOption; seasonalPlans: EligibleSeasonalPlan[]; plans: MonthlyPlanDto[] }

/** Open ONE Monthly Plan by its id: season, month and rows all come from the plan itself. `seasonalPlans` = the owner's approved markets still free for this month. */
export async function getMonthlySheet(ctx: AuthContext, id: string): Promise<MonthlySheetDetail> {
  assertReader(ctx);
  const sheet = await prisma.partyMonthlySheet.findUnique({ where: { id }, include: sheetInclude });
  if (!sheet || !(await sheetVisible(ctx, sheet.ownerId))) throw new ApiError(404, "Monthly Plan not found");
  const season = await getSeasonInfo(sheet.seasonId);
  const month = season?.months.find((m) => m.id === sheet.seasonMonthId);
  if (!season || !month) throw new ApiError(404, "Monthly Plan not found");
  const rows = await prisma.partyMonthlyPlan.findMany({ where: { sheetId: id }, include, take: 1000 });
  const plans = (await toDtos(ctx, rows)).sort((a, b) => a.marketName.localeCompare(b.marketName));
  const own = sheet.ownerId === ctx.userId && planner(ctx);
  const approved = own
    ? await prisma.seasonalPlan.findMany({ where: { ownerId: ctx.userId, seasonId: sheet.seasonId, approvalStatus: "APPROVED" }, include: { market: { select: { name: true, source: true, potential: true } } }, orderBy: { createdAt: "asc" } })
    : [];
  const used = new Set(rows.map((r) => r.seasonalPlanId));
  return {
    sheet: toSheetDto(ctx, sheet), season, month, plans,
    seasonalPlans: approved.filter((p) => !used.has(p.id)).map((p) => ({ id: p.id, marketName: p.market.name, marketPotential: shownMarketPotential(p, p.market), type: derivedType(shownMarketSource(p, p.market)), partyName: p.partyName })),
  };
}

/* ------------------------------------------------ DTO ------------------------------------------------ */

export interface TimelineEventDto { id: string; eventType: string; fromStatus: OptionStatus | null; toStatus: OptionStatus; actorName: string; actorRole: string; details: Record<string, unknown> | null; createdAt: string }
export interface OptionDto {
  id: string; optionNo: OptionNo; partyName: string | null; status: OptionStatus; statusLabel: string; statusChangedAt: string;
  sentInfo: unknown; sentByName: string | null; sentAt: string | null;
  receivedInfo: unknown; receivedByName: string | null; receivedAt: string | null;
  actualPartyName: string | null; actualAppointedOn: string | null; rejectionReason: string | null;
  /** The moves the CALLER may make from here (the server re-checks every one). */
  allowed: OptionStatus[];
  events: TimelineEventDto[];
}
export interface MonthlyPlanDto {
  id: string; sheetId: string; seasonalPlanId: string; seasonId: string; seasonMonthId: string; monthLabel: string; monthKey: string;
  ownerId: string; ownerName: string; marketId: string; marketName: string; marketPotential: string | null;
  planDate: string | null; createdAt: string; canManage: boolean; options: OptionDto[];
}

const include = {
  seasonMonth: { select: { name: true, calendarMonth: true, calendarYear: true } },
  season: { select: { status: true } },
  owner: { select: { name: true } },
  options: { orderBy: { optionNo: "asc" as const }, include: { events: { orderBy: { createdAt: "asc" as const } } } },
} as const;
type PlanRow = Prisma.PartyMonthlyPlanGetPayload<{ include: typeof include }>;

async function toDtos(ctx: AuthContext, rows: PlanRow[]): Promise<MonthlyPlanDto[]> {
  const userIds = [...new Set(rows.flatMap((r) => r.options.flatMap((o) => [o.sentById, o.receivedById])).filter((v): v is string => !!v))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const name = new Map(users.map((u) => [u.id, u.name]));
  const admin = isAdministrativeRole(ctx.role);
  return rows.map((r) => {
    const open = r.season.status === "OPEN"; // history stays readable; actions need the plan's season to be open
    const own = r.ownerId === ctx.userId && planner(ctx);
    return {
      id: r.id, sheetId: r.sheetId, seasonalPlanId: r.seasonalPlanId, seasonId: r.seasonId, seasonMonthId: r.seasonMonthId,
      monthLabel: monthLabel({ ...r.seasonMonth }), monthKey: monthKey(r.seasonMonth) ?? "", ownerId: r.ownerId, ownerName: r.owner.name,
      marketId: r.marketId, marketName: r.marketNameAtPlanning, marketPotential: r.marketPotentialAtPlanning,
      planDate: r.planDate ? r.planDate.toISOString().slice(0, 10) : null, createdAt: r.createdAt.toISOString(), canManage: own && open,
      options: r.options.map((o) => ({
        id: o.id, optionNo: o.optionNo as OptionNo, partyName: o.partyName, status: o.status as OptionStatus, statusLabel: STATUS_LABEL[o.status as OptionStatus], statusChangedAt: o.statusChangedAt.toISOString(),
        sentInfo: o.sentInfo, sentByName: o.sentById ? name.get(o.sentById) ?? null : null, sentAt: o.sentAt?.toISOString() ?? null,
        receivedInfo: o.receivedInfo, receivedByName: o.receivedById ? name.get(o.receivedById) ?? null : null, receivedAt: o.receivedAt?.toISOString() ?? null,
        actualPartyName: o.actualPartyName, actualAppointedOn: o.actualAppointedOn ? o.actualAppointedOn.toISOString().slice(0, 10) : null, rejectionReason: o.rejectionReason,
        allowed: !open ? [] : TRANSITIONS[o.status as OptionStatus].filter((t) => (t.actor === "OWNER" ? own : admin)).map((t) => t.to),
        events: o.events.map((e) => ({ id: e.id, eventType: e.eventType, fromStatus: e.fromStatus as OptionStatus | null, toStatus: e.toStatus as OptionStatus, actorName: e.actorName, actorRole: e.actorRole, details: (e.details ?? null) as Record<string, unknown> | null, createdAt: e.createdAt.toISOString() })),
      })),
    };
  });
}

/* ------------------------------------------------ create / edit (owner) ------------------------------------------------ */

// Only these fields are read from the browser; everything else (owner, season, market, potential, status…) is ignored.
const createInput = z.object({ sheetId: z.string().min(1, "Open a Monthly Plan first"), seasonalPlanId: z.string().min(1, "Select a market"), planDate: z.unknown().optional(), option1Party: z.unknown(), option2Party: z.unknown().optional() });
const updateInput = z.object({ planDate: z.unknown().optional(), option1Party: z.unknown().optional(), option2Party: z.unknown().optional() });

async function actorOf(ctx: AuthContext): Promise<{ name: string; role: string }> {
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
  return { name: user?.name ?? ctx.username ?? ctx.userId, role: ctx.role };
}

export async function createMonthlyPlan(ctx: AuthContext, raw: unknown): Promise<MonthlyPlanDto> {
  assertPlanner(ctx);
  const parsed = createInput.safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid Monthly Plan");

  // The season AND month come from the Monthly Plan being edited (never from "today"); it must be the caller's and its season still open.
  const sheet = await prisma.partyMonthlySheet.findUnique({ where: { id: parsed.data.sheetId }, include: { season: { select: { status: true } }, seasonMonth: { select: { id: true, name: true, calendarMonth: true, calendarYear: true } } } });
  if (!sheet || sheet.ownerId !== ctx.userId) throw new ApiError(404, "Monthly Plan not found");
  if (sheet.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  const month = sheet.seasonMonth;
  if (!identity(month)) throw new ApiError(422, "This month has no calendar identity");

  // The Seasonal Plan row is the market source: the caller's own, APPROVED, in THIS plan's season. Another officer's id looks missing.
  const sp = await prisma.seasonalPlan.findUnique({ where: { id: parsed.data.seasonalPlanId }, include: { market: { select: { id: true, name: true, source: true, potential: true } } } });
  if (!sp || sp.ownerId !== ctx.userId) throw new ApiError(404, "Seasonal Plan not found");
  if (sp.approvalStatus !== "APPROVED") throw new ApiError(409, "Only an approved Seasonal Plan can be planned monthly");
  if (sp.seasonId !== sheet.seasonId) throw new ApiError(409, "This market belongs to a different season's Seasonal Plan");

  const dateProblem = validatePlanDate(parsed.data.planDate, month);
  if (dateProblem) throw new ApiError(422, dateProblem);
  const p1 = validatePartyName(parsed.data.option1Party, true) ?? null; if (p1) throw new ApiError(422, `Option 1: ${p1}`);
  const p2 = validatePartyName(parsed.data.option2Party, false); if (p2) throw new ApiError(422, `Option 2: ${p2}`);
  if (await prisma.partyMonthlyPlan.findFirst({ where: { seasonalPlanId: sp.id, seasonMonthId: month.id }, select: { id: true } })) throw new ApiError(409, "This market is already planned for that month");

  const actor = await actorOf(ctx);
  const potential = shownMarketPotential(sp, sp.market);
  const planDate = parsed.data.planDate ? String(parsed.data.planDate) : null;
  const parties: Record<OptionNo, string | null> = { 1: cleanParty(parsed.data.option1Party), 2: cleanParty(parsed.data.option2Party) };
  const created = await prisma.$transaction(async (tx) => {
    const plan = await tx.partyMonthlyPlan.create({ data: { sheetId: sheet.id, seasonalPlanId: sp.id, seasonId: sheet.seasonId, seasonMonthId: month.id, ownerId: ctx.userId, marketId: sp.marketId, marketNameAtPlanning: sp.market.name, marketPotentialAtPlanning: potential, planDate: planDate ? new Date(`${planDate}T00:00:00.000Z`) : null } });
    for (const optionNo of OPTION_NUMBERS) {
      const option = await tx.partyMonthlyOption.create({ data: { monthlyPlanId: plan.id, optionNo, partyName: parties[optionNo], status: "PENDING" } });
      await tx.partyMonthlyEvent.create({ data: {
        monthlyPlanId: plan.id, optionId: option.id, eventType: "PLAN_CREATED", fromStatus: null, toStatus: "PENDING", actorId: ctx.userId, actorName: actor.name, actorRole: actor.role,
        details: { optionNo, marketName: sp.market.name, marketPotential: potential, month: monthLabel(month), planDate, partyName: parties[optionNo] },
      } });
    }
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "partyMonthlyPlan", entityId: plan.id, summary: `Monthly Plan market added · ${monthLabel(month)} · ${sp.market.name}` }, tx);
    return (await tx.partyMonthlyPlan.findUnique({ where: { id: plan.id }, include }))!;
  });
  return (await toDtos(ctx, [created]))[0]!;
}

async function ownPlan(ctx: AuthContext, id: string): Promise<PlanRow> {
  const plan = await prisma.partyMonthlyPlan.findUnique({ where: { id }, include });
  if (!plan || plan.ownerId !== ctx.userId) throw new ApiError(404, "Monthly Plan not found");
  return plan;
}

/** Owner edits: the tentative plan date (inside the month) and a candidate party name while that option is still Pending. */
export async function updateMonthlyPlan(ctx: AuthContext, id: string, raw: unknown): Promise<MonthlyPlanDto> {
  assertPlanner(ctx);
  const plan = await ownPlan(ctx, id);
  if (plan.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  const parsed = updateInput.safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(422, "Invalid update");
  const d = parsed.data;
  if (d.planDate === undefined && d.option1Party === undefined && d.option2Party === undefined) throw new ApiError(422, "Nothing to update");
  let planDate: Date | null | undefined;
  if (d.planDate !== undefined) {
    if (plan.options.some((o) => o.status === "APPOINTED")) throw new ApiError(409, "The plan date cannot change once an option is Appointed");
    const problem = validatePlanDate(d.planDate, plan.seasonMonth);
    if (problem) throw new ApiError(422, problem);
    planDate = d.planDate ? new Date(`${String(d.planDate)}T00:00:00.000Z`) : null;
  }
  const renames: { option: PlanRow["options"][number]; to: string | null }[] = [];
  for (const [no, value] of [[1, d.option1Party], [2, d.option2Party]] as const) {
    if (value === undefined) continue;
    const option = plan.options.find((o) => o.optionNo === no)!;
    if (option.status !== "PENDING") throw new ApiError(409, `Option ${no}: the candidate party can only change while it is Pending`);
    const problem = validatePartyName(value, no === 1); if (problem) throw new ApiError(422, `Option ${no}: ${problem}`);
    const to = cleanParty(value);
    if (to !== option.partyName) renames.push({ option, to });
  }
  const actor = await actorOf(ctx);
  const updated = await prisma.$transaction(async (tx) => {
    if (planDate !== undefined) await tx.partyMonthlyPlan.update({ where: { id }, data: { planDate } });
    for (const { option, to } of renames) {
      await tx.partyMonthlyOption.update({ where: { id: option.id }, data: { partyName: to } });
      await tx.partyMonthlyEvent.create({ data: { monthlyPlanId: id, optionId: option.id, eventType: "PARTY_UPDATED", fromStatus: option.status, toStatus: option.status, actorId: ctx.userId, actorName: actor.name, actorRole: actor.role, details: { optionNo: option.optionNo, from: option.partyName, to } } });
    }
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "partyMonthlyPlan", entityId: id, summary: `Monthly Plan edited · ${plan.marketNameAtPlanning}` }, tx);
    return (await tx.partyMonthlyPlan.findUnique({ where: { id }, include }))!;
  });
  return (await toDtos(ctx, [updated]))[0]!;
}

/* ------------------------------------------------ option transitions ------------------------------------------------ */

/**
 * Move ONE option to a new status. Checked in order: authenticate → role → scope/ownership → plan's season open → the option exists on
 * this plan → the move exists in the transition table → the caller is the right actor for it → payload valid → atomic claim of the
 * current status → option update + timeline event in one transaction. The other option is never touched.
 */
export async function transitionOption(ctx: AuthContext, planId: string, optionNoRaw: unknown, raw: unknown): Promise<MonthlyPlanDto> {
  assertReader(ctx);
  const optionNo = Number(optionNoRaw);
  if (!(OPTION_NUMBERS as readonly number[]).includes(optionNo)) throw new ApiError(422, "Option must be 1 or 2");
  const input = parseTransition(raw);
  if (!input.ok) throw new ApiError(422, input.message);
  const move = input.value;

  const plan = await prisma.partyMonthlyPlan.findUnique({ where: { id: planId }, include });
  if (!plan) throw new ApiError(404, "Monthly Plan not found");
  const admin = isAdministrativeRole(ctx.role);
  const own = planner(ctx) && plan.ownerId === ctx.userId;
  if (!admin && !own) {
    // Someone else's plan: a Regional Manager may SEE their team's, but only the owner or Admin acts. Anyone else cannot even tell it exists.
    const scope = await getOfficerScope(ctx);
    throw new ApiError(ctx.role === Role.REGIONAL_MANAGER && scope.ids.includes(plan.ownerId) ? 403 : 404, ctx.role === Role.REGIONAL_MANAGER && scope.ids.includes(plan.ownerId) ? "Only the plan's owner or Admin can change an option" : "Monthly Plan not found");
  }
  if (plan.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  const option = plan.options.find((o) => o.optionNo === optionNo);
  if (!option) throw new ApiError(404, "Option not found");

  const actorNeeded = transitionActor(option.status, move.to);
  if (!actorNeeded) throw new ApiError(409, `A ${STATUS_LABEL[option.status as OptionStatus]} option cannot move to ${STATUS_LABEL[move.to]}`);
  if (actorNeeded === "OWNER" && !own) throw new ApiError(403, "Only the plan's owner can do this step");
  if (actorNeeded === "ADMIN") {
    if (!admin) throw new ApiError(403, "Only an Admin can do this step");
    assertAdminPermission(ctx, "partyPlanning", adminActionFor(move.to));
  }
  if (move.to === "DOC_SENT" && !option.partyName) throw new ApiError(422, "Add the candidate party name before sending documents");

  const now = new Date();
  const today = currentBusinessDate(now);
  const data: Prisma.PartyMonthlyOptionUncheckedUpdateManyInput = { status: move.to, statusChangedAt: now };
  let details: Record<string, unknown>;
  switch (move.to) {
    case "DOC_SENT": Object.assign(data, { sentInfo: move.sent, sentById: ctx.userId, sentAt: now }); details = { sent: move.sent }; break;
    case "DOC_RECEIVED": Object.assign(data, { receivedInfo: move.received, receivedById: ctx.userId, receivedAt: now }); details = { received: move.received, sentBySo: option.sentInfo }; break;
    case "APPOINTED": Object.assign(data, { actualPartyName: move.actualPartyName, actualAppointedOn: new Date(`${today}T00:00:00.000Z`) }); details = { actualPartyName: move.actualPartyName, appointedOn: today, tentativePartyName: option.partyName }; break;
    case "PART_REJECTED": Object.assign(data, { rejectionReason: move.reason }); details = { reason: move.reason }; break;
    default: details = { reason: move.reason };
  }
  const actor = await actorOf(ctx);
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.partyMonthlyOption.updateMany({ where: { id: option.id, status: option.status }, data });
    if (claimed.count === 0) throw new ApiError(409, "This option was just changed by someone else — reload and try again");
    if (move.to === "APPOINTED") {
      // The actual appointment is the event Seasonal Planning reserved "Appointed" + its Date for. The first Appointed option of a Seasonal Plan
      // records it; applyAppointment refuses (null) when it was already recorded, which is simply not repeated.
      const sp = await tx.seasonalPlan.findUnique({ where: { id: plan.seasonalPlanId }, select: { approvalStatus: true, appointmentStatus: true } });
      const appointment = sp ? applyAppointment(sp, today) : null;
      if (appointment) await tx.seasonalPlan.updateMany({ where: { id: plan.seasonalPlanId, approvalStatus: "APPROVED", appointmentStatus: "PENDING" }, data: { appointmentStatus: appointment.appointmentStatus, appointedAt: new Date(`${appointment.appointedAt}T00:00:00.000Z`) } });
      details = { ...details, seasonalPlanMarkedAppointed: appointment != null };
    }
    await tx.partyMonthlyEvent.create({ data: { monthlyPlanId: planId, optionId: option.id, eventType: "STATUS_CHANGED", fromStatus: option.status, toStatus: move.to, actorId: ctx.userId, actorName: actor.name, actorRole: actor.role, details: details as Prisma.InputJsonValue } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "partyMonthlyOption", entityId: option.id, summary: `Monthly Plan option ${optionNo} · ${plan.marketNameAtPlanning} · ${STATUS_LABEL[option.status as OptionStatus]} → ${STATUS_LABEL[move.to]}` }, tx);
    return (await tx.partyMonthlyPlan.findUnique({ where: { id: planId }, include }))!;
  });
  return (await toDtos(ctx, [updated]))[0]!;
}
