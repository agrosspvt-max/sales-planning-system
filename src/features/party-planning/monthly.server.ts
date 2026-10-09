import "server-only";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getCurrentManagerId, getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { hasAdminPermission, isAdministrativeRole, assertAdminPermission } from "@/features/accounts/permissions";
import { getSeasonInfo, listOpenSeasonInfos, type MonthOption, type SeasonInfo } from "./season-info.server";
import { identity, monthLabel } from "@/lib/season-calendar";
import { currentBusinessDate } from "@/lib/daily-work";
import { createDealerForOfficer } from "@/features/planning/monthly-plan.server";
import { applyAppointment, derivedType, isEditable, reviewTransition, shownMarketPotential, shownMarketSource, submitTarget } from "@/lib/seasonal-plan";
import {
  APPROVAL_LABEL, ADMIN_PENDING_STATUSES, OPTION_NUMBERS, STAGE_ROW_STATUSES, sheetInStage, type PlanStage, type StageCounts, conversionDays, summarizeDateHistory, ROW_STATUS_LABEL, TRANSITIONS, adminActionFor, cleanParty, displayRowStatus, isRowStatus, monthKey, monthlySheetStatus, parseTransition, transitionActor, validatePartyName, validatePlanDate,
  type DocInfo, type TransitionInput, type MonthlySheetStatus, type OptionNo, type RowStatus,
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
 *  • Every status change updates the row AND appends a PartyMonthlyStatusEvent (and the automatic Conversion Date change) in ONE transaction (events are never updated or deleted).
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
  /** ONE logical plan per owner + month: how many of its entries sit in each lifecycle section (Create = Draft / Rejected, Submitted = awaiting RM / Admin, Approved). */
  counts: StageCounts & { pendingRm: number; pendingAdmin: number; rejected: number };
  submittedAt: string | null; rejectionStage: string | null; rejectionReason: string | null;
  /** What the caller may do now (the service re-checks each one). canEdit = add entries; canSubmit = there are editable entries; canReview = entries waiting on this caller. */
  canEdit: boolean; canSubmit: boolean; canReview: boolean;
}
const sheetInclude = {
  season: { select: { name: true, year: true, status: true } },
  seasonMonth: { select: { name: true, calendarMonth: true, calendarYear: true } },
  owner: { select: { name: true } },
  items: { select: { updatedAt: true, opStatus: true, approvalStatus: true, submittedAt: true, rejectionStage: true, rejectionReason: true, options: { select: { optionNo: true, partyName: true, updatedAt: true } } } },
} as const;
type SheetRow = Prisma.PartyMonthlySheetGetPayload<{ include: typeof sheetInclude }>;

/** What the caller can do next on a sheet: Admin → entries waiting on an Admin step; an owner → APPROVED entries whose status workflow has not begun. */
function needsMyAction(ctx: AuthContext, r: SheetRow): number {
  if (isAdministrativeRole(ctx.role)) return r.items.filter((i) => i.approvalStatus === "APPROVED" && (ADMIN_PENDING_STATUSES as readonly string[]).includes(i.opStatus)).length;
  return r.ownerId === ctx.userId ? r.items.filter((i) => i.approvalStatus === "APPROVED" && i.opStatus === "NONE").length : 0;
}
/** Entry-level review rights: Admin on PENDING_ADMIN; an RM on PENDING_RM entries of a TEAM member (never their own). `teamIds` = the RM's scope. */
function canReviewEntry(ctx: AuthContext, r: { ownerId: string; approvalStatus: string }, teamIds: readonly string[]): boolean {
  if (isAdministrativeRole(ctx.role)) return r.approvalStatus === "PENDING_ADMIN" && hasAdminPermission(ctx, "partyPlanning", "approve");
  if (ctx.role === Role.REGIONAL_MANAGER) return r.approvalStatus === "PENDING_RM" && r.ownerId !== ctx.userId && teamIds.includes(r.ownerId);
  return false;
}
function toSheetDto(ctx: AuthContext, r: SheetRow, teamIds: readonly string[] = []): MonthlySheetDto {
  const updated = [r.updatedAt, ...r.items.flatMap((i) => [i.updatedAt, ...i.options.map((o) => o.updatedAt)])].sort((a, b) => b.getTime() - a.getTime())[0]!;
  const n = (...statuses: string[]) => r.items.filter((i) => statuses.includes(i.approvalStatus)).length;
  const open = r.season.status === "OPEN";
  const owner = r.ownerId === ctx.userId;
  const counts = { create: n("DRAFT", "REJECTED"), submitted: n("PENDING_RM", "PENDING_ADMIN"), approved: n("APPROVED"), pendingRm: n("PENDING_RM"), pendingAdmin: n("PENDING_ADMIN"), rejected: n("REJECTED") };
  const rejected = r.items.filter((i) => i.approvalStatus === "REJECTED" && i.rejectionReason);
  const submitted = r.items.map((i) => i.submittedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    id: r.id, seasonId: r.seasonId, seasonName: `${r.season.name} ${r.season.year}`, seasonOpen: open, seasonMonthId: r.seasonMonthId,
    monthLabel: monthLabel({ ...r.seasonMonth }), monthKey: monthKey(r.seasonMonth) ?? "", ownerId: r.ownerId, ownerName: r.owner.name,
    status: monthlySheetStatus(r.items), itemCount: r.items.length, updatedAt: updated.toISOString(), own: owner,
    needsMyAction: needsMyAction(ctx, r) + r.items.filter((i) => canReviewEntry(ctx, { ownerId: r.ownerId, approvalStatus: i.approvalStatus }, teamIds)).length,
    counts, submittedAt: submitted?.toISOString() ?? null, rejectionStage: rejected[0]?.rejectionStage ?? null, rejectionReason: rejected[0]?.rejectionReason ?? null,
    canEdit: owner && (planner(ctx) || isAdministrativeRole(ctx.role)) && open,
    canSubmit: owner && planner(ctx) && open && counts.create > 0,
    canReview: open && r.items.some((i) => canReviewEntry(ctx, { ownerId: r.ownerId, approvalStatus: i.approvalStatus }, teamIds)),
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
export async function listMonthlySheets(ctx: AuthContext, filters: { seasonId?: string; needsAction?: boolean; stage?: PlanStage } = {}): Promise<MonthlySheetDto[]> {
  assertReader(ctx);
  const scope = await getOfficerScope(ctx);
  const rows = await prisma.partyMonthlySheet.findMany({ where: { ...(filters.seasonId ? { seasonId: filters.seasonId } : {}), ...(scope.all ? {} : { ownerId: { in: scope.ids } }) }, include: sheetInclude, take: 1000 });
  return rows.map((r) => toSheetDto(ctx, r, scope.ids)).filter((d) => !filters.stage || sheetInStage(d.counts, d.seasonOpen, filters.stage)).filter((d) => !filters.needsAction || d.needsMyAction > 0)
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
  return toSheetDto(ctx, created, [ctx.userId]);
}

export interface EligibleSeasonalPlan { id: string; marketName: string; marketPotential: string | null; type: "Existing" | "New" | null }
export interface MonthlySheetDetail { sheet: MonthlySheetDto; season: SeasonInfo; month: MonthOption; seasonalPlans: EligibleSeasonalPlan[]; plans: MonthlyPlanDto[] }

/** Open ONE Monthly Plan by its id: season, month and rows all come from the plan itself. `seasonalPlans` = the owner's approved markets still free for this month. */
export async function getMonthlySheet(ctx: AuthContext, id: string, stage?: string): Promise<MonthlySheetDetail> {
  assertReader(ctx);
  const sheet = await prisma.partyMonthlySheet.findUnique({ where: { id }, include: sheetInclude });
  if (!sheet || !(await sheetVisible(ctx, sheet.ownerId))) throw new ApiError(404, "Monthly Plan not found");
  const season = await getSeasonInfo(sheet.seasonId);
  const month = season?.months.find((m) => m.id === sheet.seasonMonthId);
  if (!season || !month) throw new ApiError(404, "Monthly Plan not found");
  // The plan is one logical plan; each lifecycle section shows only ITS entries (Create = editable ones, Submitted = awaiting review, Approved = approved; Older Plans = all, read-only).
  const inStage = STAGE_ROW_STATUSES[stage ?? ""];
  const rows = await prisma.partyMonthlyPlan.findMany({ where: { sheetId: id, ...(inStage ? { approvalStatus: { in: [...inStage] } } : {}) }, include, take: 1000 });
  const plans = (await toDtos(ctx, rows, (await getOfficerScope(ctx)).ids)).sort((a, b) => a.marketName.localeCompare(b.marketName));
  const own = sheet.ownerId === ctx.userId && planner(ctx);
  const usedRows = await prisma.partyMonthlyPlan.findMany({ where: { sheetId: id }, select: { seasonalPlanId: true } }); // a market already planned this month (in ANY section) is not offered again
  const approved = own && (!stage || stage === "create")
    ? await prisma.seasonalPlan.findMany({ where: { ownerId: ctx.userId, seasonId: sheet.seasonId, approvalStatus: "APPROVED" }, include: { market: { select: { name: true, source: true, potential: true } } }, orderBy: { createdAt: "asc" } })
    : [];
  const used = new Set(usedRows.map((r) => r.seasonalPlanId));
  return {
    sheet: toSheetDto(ctx, sheet, (await getOfficerScope(ctx)).ids), season, month, plans,
    seasonalPlans: approved.filter((p) => !used.has(p.id)).map((p) => ({ id: p.id, marketName: p.market.name, marketPotential: shownMarketPotential(p, p.market), type: derivedType(shownMarketSource(p, p.market)) })),
  };
}

/* ------------------------------------------------ DTO ------------------------------------------------ */

/** Option 1 / Option 2 are only candidate party names — no status, no timeline of their own. */
export interface OptionDto { id: string; optionNo: OptionNo; partyName: string | null }
export interface StatusEventDto { id: string; dealerId: string | null; previousStatus: string; newStatus: string; previousLabel: string; newLabel: string; actorName: string; actorRole: string; remarks: string | null; sentInfo: DocInfo | null; receivedInfo: DocInfo | null; createdAt: string }
export interface MonthlyPlanDto {
  id: string; sheetId: string; seasonalPlanId: string; seasonId: string; seasonMonthId: string; monthLabel: string; monthKey: string;
  ownerId: string; ownerName: string; ownerGroupId: string | null; marketId: string; marketName: string; marketPotential: string | null;
  planDate: string | null; createdAt: string; canManage: boolean; options: OptionDto[];
  /** The dealer created when the row was marked Appointed. */
  appointedDealerId: string | null; appointedDealerName: string | null;
  /** The ONE operational status of the row (and what the Status column shows: Draft / Submitted / Approved until the workflow begins). */
  opStatus: RowStatus; statusLabel: string; statusChangedAt: string | null;
  /** Entry-level approval (separate from the operational status): which batch section the entry is in, and why it was rejected. */
  approvalStatus: string; approvalLabel: string; rejectionStage: string | null; rejectionReason: string | null; canEditEntry: boolean; canReview: boolean;
  /** The moves the CALLER may make now (the server re-checks every one). */
  allowedStatuses: { to: RowStatus; label: string }[];
  /** What the SO last said was sent / what Admin last said was actually received — kept apart, never merged. */
  sentInfo: DocInfo | null; receivedInfo: DocInfo | null; statusEvents: StatusEventDto[];
  /** Conversion Date (= planDate): hand-editable by the SO only before the status workflow begins, then set automatically on every status change. */
  canEditDate: boolean; dateChangeCount: number; seasonalAddedOn: string; days: number; daysFinal: boolean;
  dateHistory: DateChangeDto[];
}
export interface DateChangeDto { id: string; previousDate: string | null; newDate: string | null; byAdmin: boolean; automatic: boolean; actorName: string; actorRole: string; createdAt: string }
const dayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

const include = {
  seasonMonth: { select: { name: true, calendarMonth: true, calendarYear: true } },
  season: { select: { status: true } },
  owner: { select: { name: true, groupId: true } },
  appointedDealer: { select: { id: true, name: true } },
  seasonalPlan: { select: { createdAt: true } }, // when the market was ADDED to the Seasonal Plan — the start of "Days"
  dateChanges: { orderBy: { createdAt: "asc" as const } },
  statusEvents: { orderBy: { createdAt: "asc" as const } },
  options: { orderBy: { optionNo: "asc" as const } },
} as const;
type PlanRow = Prisma.PartyMonthlyPlanGetPayload<{ include: typeof include }>;

async function toDtos(ctx: AuthContext, rows: PlanRow[], teamIds: readonly string[] = []): Promise<MonthlyPlanDto[]> {
  const admin = isAdministrativeRole(ctx.role);
  const todayIst = currentBusinessDate();
  return rows.map((r) => {
    const open = r.season.status === "OPEN"; // history stays readable; actions need the plan's season to be open
    const own = r.ownerId === ctx.userId && planner(ctx);
    const history = summarizeDateHistory(r.dateChanges);
    const planDay = dayOf(r.planDate);
    const opStatus = (isRowStatus(r.opStatus) ? r.opStatus : "NONE") as RowStatus;
    const seasonalAddedOn = currentBusinessDate(r.seasonalPlan.createdAt); // Asia/Kolkata calendar date
    const aging = conversionDays(seasonalAddedOn, opStatus === "APPOINTED" ? planDay : null, todayIst); // freezes at the Appointed date
    const allowedStatuses = !open || r.approvalStatus !== "APPROVED" ? [] : TRANSITIONS[opStatus]
      .filter((t) => (t.actor === "OWNER" ? own : admin && hasAdminPermission(ctx, "partyPlanning", adminActionFor(t.to)) && (t.to !== "APPOINTED" || hasAdminPermission(ctx, "dealers", "create")))).map((t) => ({ to: t.to, label: ROW_STATUS_LABEL[t.to] }));
    const events: StatusEventDto[] = r.statusEvents.map((e) => ({
      id: e.id, dealerId: e.dealerId ?? null, previousStatus: e.previousStatus, newStatus: e.newStatus, previousLabel: displayRowStatus(e.previousStatus, "APPROVED"), newLabel: displayRowStatus(e.newStatus, "APPROVED"),
      actorName: e.actorName, actorRole: e.actorRole, remarks: e.remarks, sentInfo: (e.sentInfo ?? null) as DocInfo | null, receivedInfo: (e.receivedInfo ?? null) as DocInfo | null, createdAt: e.createdAt.toISOString(),
    }));
    return {
      id: r.id, sheetId: r.sheetId, seasonalPlanId: r.seasonalPlanId, seasonId: r.seasonId, seasonMonthId: r.seasonMonthId,
      monthLabel: monthLabel({ ...r.seasonMonth }), monthKey: monthKey(r.seasonMonth) ?? "", ownerId: r.ownerId, ownerName: r.owner.name, ownerGroupId: r.owner.groupId ?? null,
      appointedDealerId: r.appointedDealerId ?? null, appointedDealerName: r.appointedDealer?.name ?? null,
      marketId: r.marketId, marketName: r.marketNameAtPlanning, marketPotential: r.marketPotentialAtPlanning,
      planDate: planDay, createdAt: r.createdAt.toISOString(), canManage: own && open,
      options: r.options.map((o) => ({ id: o.id, optionNo: o.optionNo as OptionNo, partyName: o.partyName })),
      opStatus, statusLabel: displayRowStatus(opStatus, r.approvalStatus),
      approvalStatus: r.approvalStatus, approvalLabel: APPROVAL_LABEL[r.approvalStatus] ?? r.approvalStatus, rejectionStage: r.rejectionStage, rejectionReason: r.rejectionReason,
      canEditEntry: own && open && isEditable(r.approvalStatus) && opStatus === "NONE", canReview: open && canReviewEntry(ctx, r, teamIds), statusChangedAt: r.opStatusChangedAt?.toISOString() ?? null, allowedStatuses,
      sentInfo: [...events].reverse().find((e) => e.newStatus === "DOC_SENT")?.sentInfo ?? null,
      receivedInfo: [...events].reverse().find((e) => e.newStatus === "DOC_RECEIVED")?.receivedInfo ?? null, statusEvents: events,
      canEditDate: own && open && opStatus === "NONE", dateChangeCount: history.soChanges, seasonalAddedOn, days: aging.days, daysFinal: aging.final,
      dateHistory: r.dateChanges.map((c) => ({ id: c.id, previousDate: dayOf(c.previousDate), newDate: dayOf(c.newDate), byAdmin: c.byAdmin, automatic: c.automatic, actorName: c.actorName, actorRole: c.actorRole, createdAt: c.createdAt.toISOString() })),
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

  const potential = shownMarketPotential(sp, sp.market);
  const planDate = parsed.data.planDate ? String(parsed.data.planDate) : null;
  const parties: Record<OptionNo, string | null> = { 1: cleanParty(parsed.data.option1Party), 2: cleanParty(parsed.data.option2Party) };
  const created = await prisma.$transaction(async (tx) => {
    const plan = await tx.partyMonthlyPlan.create({ data: { sheetId: sheet.id, seasonalPlanId: sp.id, seasonId: sheet.seasonId, seasonMonthId: month.id, ownerId: ctx.userId, marketId: sp.marketId, marketNameAtPlanning: sp.market.name, marketPotentialAtPlanning: potential, planDate: planDate ? new Date(`${planDate}T00:00:00.000Z`) : null } });
    for (const optionNo of OPTION_NUMBERS) {
      await tx.partyMonthlyOption.create({ data: { monthlyPlanId: plan.id, optionNo, partyName: parties[optionNo], status: "PENDING" } }); // a candidate name only
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
    if (plan.opStatus !== "NONE") throw new ApiError(409, "The Conversion Date is now set automatically by each status change");
    const problem = validatePlanDate(d.planDate, plan.seasonMonth);
    if (problem) throw new ApiError(422, problem);
    planDate = d.planDate ? new Date(`${String(d.planDate)}T00:00:00.000Z`) : null;
  }
  const renames: { option: PlanRow["options"][number]; to: string | null }[] = [];
  for (const [no, value] of [[1, d.option1Party], [2, d.option2Party]] as const) {
    if (value === undefined) continue;
    const option = plan.options.find((o) => o.optionNo === no)!;
    if (plan.opStatus !== "NONE" || !isEditable(plan.approvalStatus)) throw new ApiError(409, "The candidate parties can only change while the entry is a draft (before it is submitted / its status workflow begins)");
    const problem = validatePartyName(value, no === 1); if (problem) throw new ApiError(422, `Option ${no}: ${problem}`);
    const to = cleanParty(value);
    if (to !== option.partyName) renames.push({ option, to });
  }
  const actor = await actorOf(ctx);
  const dateChanged = planDate !== undefined && dayOf(planDate) !== dayOf(plan.planDate);
  const updated = await prisma.$transaction(async (tx) => {
    if (planDate !== undefined) await tx.partyMonthlyPlan.update({ where: { id }, data: { planDate } });
    // Every hand edit of the Conversion Date by the SO is kept (the grey counter = how many).
    if (dateChanged) await tx.partyMonthlyDateChange.create({ data: { monthlyPlanId: id, previousDate: plan.planDate, newDate: planDate ?? null, byAdmin: false, automatic: false, actorId: ctx.userId, actorName: actor.name, actorRole: actor.role } });
    for (const { option, to } of renames) {
      await tx.partyMonthlyOption.update({ where: { id: option.id }, data: { partyName: to } });
    }
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "partyMonthlyPlan", entityId: id, summary: `Monthly Plan edited · ${plan.marketNameAtPlanning}` }, tx);
    return (await tx.partyMonthlyPlan.findUnique({ where: { id }, include }))!;
  });
  return (await toDtos(ctx, [updated]))[0]!;
}

/* ------------------------------------------------ submit / review the whole Monthly Plan ------------------------------------------------ */

async function loadSheet(id: string) {
  const sheet = await prisma.partyMonthlySheet.findUnique({ where: { id }, include: sheetInclude });
  if (!sheet) throw new ApiError(404, "Monthly Plan not found");
  return sheet;
}

/**
 * Submit EVERY editable (Draft / Rejected) entry of the caller's Monthly Plan as one batch: RM review (an SO who has an RM) or Admin review. Entries that are
 * already Submitted / Approved are untouched, so the same plan (owner + month) keeps accumulating entries while Create stays open for new ones. Each entry is
 * claimed on the status it was read at, so a retry or double click submits nothing twice (the second call finds nothing to submit).
 */
export async function submitMonthlySheet(ctx: AuthContext, id: string): Promise<MonthlySheetDto> {
  assertPlanner(ctx);
  const sheet = await loadSheet(id);
  if (sheet.ownerId !== ctx.userId) throw new ApiError(404, "Monthly Plan not found");
  if (sheet.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  const rmId = ctx.role === Role.SALES_OFFICER ? await getCurrentManagerId(ctx.userId) : null;
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.partyMonthlyPlan.findMany({ where: { sheetId: id, ownerId: ctx.userId, approvalStatus: { in: ["DRAFT", "REJECTED"] } }, select: { id: true, approvalStatus: true, options: { select: { optionNo: true, partyName: true } } } });
    if (rows.length === 0) throw new ApiError(409, "There is nothing new to submit");
    if (rows.some((r) => !r.options.some((o) => o.optionNo === 1 && o.partyName))) throw new ApiError(422, "Every market needs an Option 1 party before submitting");
    const now = new Date();
    let n = 0;
    for (const row of rows) {
      const target = submitTarget(row.approvalStatus, ctx.role as "SALES_OFFICER" | "REGIONAL_MANAGER", rmId != null);
      if (!target) continue;
      const claimed = await tx.partyMonthlyPlan.updateMany({
        where: { id: row.id, ownerId: ctx.userId, approvalStatus: row.approvalStatus },
        data: { approvalStatus: target, submittedAt: now, rmDecidedById: null, rmDecidedAt: null, adminDecidedById: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null },
      });
      n += claimed.count;
    }
    if (n === 0) throw new ApiError(409, "There is nothing new to submit");
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "partyMonthlySheet", entityId: id, summary: `Monthly Plan batch submitted for ${rmId ? "RM" : "Admin"} review · ${monthLabel(sheet.seasonMonth)} · ${n} market(s)` }, tx);
    return (await tx.partyMonthlySheet.findUnique({ where: { id }, include: sheetInclude }))!;
  });
  return toSheetDto(ctx, updated, [ctx.userId]);
}

const sheetActInput = z.object({ action: z.enum(["approve", "reject"]), reason: z.string().optional() });

/**
 * RM (their team's entries awaiting RM) or Admin (entries awaiting Admin) approves / rejects the plan's pending entries AT THEIR STEP, as a batch. Approved
 * entries join the plan's Approved section next to earlier ones (never duplicated: each is claimed on the status it was read at); rejected ones return to
 * the owner's Create section. Submitting never approves anything.
 */
export async function actOnMonthlySheet(ctx: AuthContext, id: string, raw: unknown): Promise<MonthlySheetDto> {
  const parsed = sheetActInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, "Choose approve or reject");
  const { action } = parsed.data;
  const reason = parsed.data.reason?.trim() ?? "";
  if (reason.length > 500) throw new ApiError(422, "The reason can be at most 500 characters.");
  const isRm = ctx.role === Role.REGIONAL_MANAGER, isAdmin = isAdministrativeRole(ctx.role);
  if (!isRm && !isAdmin) throw new ApiError(403, "Only a Regional Manager or Admin can review Monthly Plans");
  if (isAdmin) assertAdminPermission(ctx, "partyPlanning", action === "approve" ? "approve" : "reject");
  const scope = await getOfficerScope(ctx);
  const sheet = await loadSheet(id);
  if (isRm && (sheet.ownerId === ctx.userId || !scope.ids.includes(sheet.ownerId))) throw new ApiError(404, "Monthly Plan not found");
  if (sheet.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  const expected = isRm ? "PENDING_RM" : "PENDING_ADMIN";
  const step = reviewTransition(expected, { by: isRm ? "RM" : "ADMIN", action, reason });
  if (!step.ok) throw new ApiError(step.code, step.message);
  const now = new Date();
  const who = isRm ? { rmDecidedById: ctx.userId, rmDecidedAt: now } : { adminDecidedById: ctx.userId, adminDecidedAt: now };
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.partyMonthlyPlan.updateMany({
      where: { sheetId: id, approvalStatus: expected },
      data: { approvalStatus: step.approvalStatus, ...who, ...(action === "reject" ? { rejectionStage: isRm ? "RM" : "ADMIN", rejectionReason: reason } : {}) },
    });
    if (claimed.count === 0) throw new ApiError(409, isRm ? "No entries are waiting for RM review (they may have just been reviewed)" : "No entries are waiting for Admin review (they may have just been reviewed)");
    const verb = action === "approve" ? (step.finalApproval ? "approved (final)" : "approved by RM") : "rejected";
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "partyMonthlySheet", entityId: id, summary: `Monthly Plan batch ${verb} · ${monthLabel(sheet.seasonMonth)} · ${claimed.count} market(s)${action === "reject" ? ` — ${reason}` : ""}` }, tx);
    return (await tx.partyMonthlySheet.findUnique({ where: { id }, include: sheetInclude }))!;
  });
  return toSheetDto(ctx, updated, scope.ids);
}

/* ------------------------------------------------ row status workflow ------------------------------------------------ */

/**
 * Move ONE market row to a new operational status. Valid moves come from TRANSITIONS (NONE → Doc Send By SO by the owner; every later step by
 * Admin); the plan must already be APPROVED. The row update (claimed on the status it was read at), the automatic Conversion Date change and the
 * append-only status event are written in ONE transaction. Option 1 / Option 2 are untouched.
 */
export async function changeRowStatus(ctx: AuthContext, planId: string, raw: unknown): Promise<MonthlyPlanDto> {
  assertReader(ctx);
  const input = parseTransition(raw);
  if (!input.ok) throw new ApiError(422, input.message);
  const move = input.value;
  if (move.to === "APPOINTED") throw new ApiError(422, "Use the Appointed action: it creates the dealer and marks the row Appointed together");

  const plan = await prisma.partyMonthlyPlan.findUnique({ where: { id: planId }, include });
  if (!plan) throw new ApiError(404, "Monthly Plan not found");
  const admin = isAdministrativeRole(ctx.role);
  const own = planner(ctx) && plan.ownerId === ctx.userId;
  if (!admin && !own) {
    // Someone else's plan: a Regional Manager may SEE their team's, but only the owner or Admin acts. Anyone else cannot even tell it exists.
    const scope = await getOfficerScope(ctx);
    const teamMember = ctx.role === Role.REGIONAL_MANAGER && scope.ids.includes(plan.ownerId);
    throw new ApiError(teamMember ? 403 : 404, teamMember ? "Only the plan's owner or Admin can change the status" : "Monthly Plan not found");
  }
  if (plan.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  if (plan.approvalStatus !== "APPROVED") throw new ApiError(409, "The status workflow starts once the entry is approved");

  const from = (isRowStatus(plan.opStatus) ? plan.opStatus : "NONE") as RowStatus;
  const actorNeeded = transitionActor(from, move.to);
  if (!actorNeeded) throw new ApiError(409, `A ${displayRowStatus(from, "APPROVED")} row cannot move to ${ROW_STATUS_LABEL[move.to]}`);
  if (actorNeeded === "OWNER" && !own) throw new ApiError(403, "Only the plan's owner can do this step");
  if (actorNeeded === "ADMIN") {
    if (!admin) throw new ApiError(403, "Only an Admin can do this step");
    assertAdminPermission(ctx, "partyPlanning", adminActionFor(move.to));
  }

  const actor = await actorOf(ctx);
  const updated = await prisma.$transaction((tx) => applyRowStatus(tx, ctx, actor, plan, from, move));
  return (await toDtos(ctx, [updated]))[0]!;
}

/**
 * The transactional core of a row status change (shared by every status, including Appointed): claim the row on the status it was read at, set the
 * Conversion Date to today (history kept), run the Seasonal-appointment side effect, and append the status event. `dealerId` = the Dealer created
 * by the Appointed step in the SAME transaction.
 */
async function applyRowStatus(tx: Prisma.TransactionClient, ctx: AuthContext, actor: { name: string; role: string }, plan: PlanRow, from: RowStatus, move: TransitionInput, dealerId?: string): Promise<PlanRow> {
  const now = new Date();
  const today = currentBusinessDate(now); // Asia/Kolkata
  const admin = isAdministrativeRole(ctx.role);
  const claimed = await tx.partyMonthlyPlan.updateMany({ where: { id: plan.id, opStatus: from }, data: { opStatus: move.to, opStatusChangedAt: now, planDate: new Date(`${today}T00:00:00.000Z`) } });
  if (claimed.count === 0) throw new ApiError(409, "This row was just changed by someone else — reload and try again");
  if (dealerId) await tx.partyMonthlyPlan.update({ where: { id: plan.id }, data: { appointedDealerId: dealerId } });
  // Conversion Date follows the status: set to the transition's date, keeping the previous value in the (append-only) date history.
  if (dayOf(plan.planDate) !== today) await tx.partyMonthlyDateChange.create({ data: { monthlyPlanId: plan.id, previousDate: plan.planDate, newDate: new Date(`${today}T00:00:00.000Z`), byAdmin: admin, automatic: true, actorId: ctx.userId, actorName: actor.name, actorRole: actor.role } });
  if (move.to === "APPOINTED") {
    // The actual appointment is the event Seasonal Planning reserved "Appointed" + its Date for; applyAppointment refuses (null) when it was already recorded.
    const sp = await tx.seasonalPlan.findUnique({ where: { id: plan.seasonalPlanId }, select: { approvalStatus: true, appointmentStatus: true } });
    const appointment = sp ? applyAppointment(sp, today) : null;
    if (appointment) await tx.seasonalPlan.updateMany({ where: { id: plan.seasonalPlanId, approvalStatus: "APPROVED", appointmentStatus: "PENDING" }, data: { appointmentStatus: appointment.appointmentStatus, appointedAt: new Date(`${appointment.appointedAt}T00:00:00.000Z`) } });
  }
  await tx.partyMonthlyStatusEvent.create({ data: {
    monthlyPlanId: plan.id, previousStatus: from, newStatus: move.to, actorId: ctx.userId, actorName: actor.name, actorRole: actor.role, dealerId: dealerId ?? null,
    remarks: "remarks" in move ? move.remarks : null, sentInfo: move.to === "DOC_SENT" ? (move.sent as unknown as Prisma.InputJsonValue) : undefined, receivedInfo: move.to === "DOC_RECEIVED" ? (move.received as unknown as Prisma.InputJsonValue) : undefined,
  } });
  await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "partyMonthlyPlan", entityId: plan.id, summary: `Monthly Plan status · ${plan.marketNameAtPlanning} · ${displayRowStatus(from, "APPROVED")} → ${ROW_STATUS_LABEL[move.to]}${dealerId ? " (dealer created)" : ""}` }, tx);
  return (await tx.partyMonthlyPlan.findUnique({ where: { id: plan.id }, include }))!;
}

/**
 * ADMIN ONLY: mark a row Appointed AND create the Dealer, atomically. The Dealer is created by the very same service as Dealer Alias → Create Dealer
 * (createDealerForOfficer: dealer + officer assignment + alias + optional Active Seasonal Plan membership), inside the same transaction as the status
 * change: if either fails, neither persists — so a failed / cancelled / duplicate-warned attempt leaves the row exactly as it was, and a retry or a
 * double click cannot create a second dealer (the row is claimed on its previous status first; the loser of a race rolls back its dealer).
 * Returns { duplicates } (nothing saved) when the dealer name resembles an existing dealer and `dealer.force` was not set.
 */
export async function appointRow(ctx: AuthContext, planId: string, raw: unknown): Promise<MonthlyPlanDto | { duplicates: NonNullable<Awaited<ReturnType<typeof createDealerForOfficer>>["duplicates"]> }> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const remarks = typeof r.remarks === "string" ? r.remarks.replace(/\s+/g, " ").trim() : "";
  if (remarks.length > 500) throw new ApiError(422, "Remarks can be at most 500 characters.");
  if (!r.dealer || typeof r.dealer !== "object") throw new ApiError(422, "Dealer details are required to mark a row Appointed");
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only an Admin can appoint a party");
  assertAdminPermission(ctx, "partyPlanning", "approve");
  assertAdminPermission(ctx, "dealers", "create"); // same permission as POST /api/dealers (Dealer Alias → Create Dealer)

  const plan = await prisma.partyMonthlyPlan.findUnique({ where: { id: planId }, include });
  if (!plan) throw new ApiError(404, "Monthly Plan not found");
  if (plan.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  if (plan.approvalStatus !== "APPROVED") throw new ApiError(409, "The status workflow starts once the entry is approved");
  const from = (isRowStatus(plan.opStatus) ? plan.opStatus : "NONE") as RowStatus;
  if (transitionActor(from, "APPOINTED") !== "ADMIN") throw new ApiError(409, `A ${displayRowStatus(from, "APPROVED")} row cannot move to Appointed`);
  if (plan.appointedDealerId) throw new ApiError(409, "A dealer was already created for this row");

  const actor = await actorOf(ctx);
  class Duplicates extends Error { constructor(readonly found: NonNullable<Awaited<ReturnType<typeof createDealerForOfficer>>["duplicates"]>) { super("duplicates"); } }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Claim FIRST (a second submission fails here, before any dealer exists), then create the dealer in this same transaction, then link it.
      const claimed = await tx.partyMonthlyPlan.updateMany({ where: { id: planId, opStatus: from, appointedDealerId: null }, data: { updatedAt: new Date() } });
      if (claimed.count === 0) throw new ApiError(409, "This row was just changed by someone else — reload and try again");
      const outcome = await createDealerForOfficer(ctx, r.dealer, { tx });
      if (outcome.duplicates) throw new Duplicates(outcome.duplicates);
      if (!outcome.dealerId) throw new ApiError(500, "The dealer could not be created");
      return applyRowStatus(tx, ctx, actor, plan, from, { to: "APPOINTED", remarks: remarks || null }, outcome.dealerId);
    }, { timeout: 60_000, maxWait: 10_000 });
    return (await toDtos(ctx, [updated]))[0]!;
  } catch (e) {
    if (e instanceof Duplicates) return { duplicates: e.found };
    throw e;
  }
}
