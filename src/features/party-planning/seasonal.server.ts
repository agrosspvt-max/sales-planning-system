import "server-only";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getCurrentManagerId, getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { isAdministrativeRole, assertAdminPermission } from "@/features/accounts/permissions";
import { getSeasonInfo, isSeasonOpen, listOpenSeasonInfos, type SeasonInfo } from "./season-info.server";
import {
  canReviewNow, cleanPartyName, derivedType, displayStatus, finalApprovalFields, isEditable, reviewTransition, seasonalSheetStatus, shownMarketPotential, shownMarketSource, submitTarget, validatePartyName,
  type ApprovalStatus, type SheetStatus,
} from "@/lib/seasonal-plan";

/**
 * Party Planning · Seasonal Planning. A "Seasonal Plan" is one owner's plan for ONE selected Season (a SeasonalPlanSheet); inside it sit the
 * owner's market rows (SeasonalPlan: Market + tentative Party Name), each approved SO → RM → Admin exactly as before.
 *
 *  • Season: chosen when the plan is created, from the OPEN seasons of the Seasons module — never derived from "today". Every later read /
 *    write loads the season from the plan itself; rows may only change while that season is OPEN.
 *  • Market: a Phase-1 Market id. Name / Type / Market Potential are resolved from the Market record, never taken from the browser.
 *  • Owner: always the caller (a payload `ownerId` is ignored).
 *  • Approval: DRAFT → PENDING_RM → PENDING_ADMIN → APPROVED | REJECTED (an RM's own row skips the RM step). Approval makes a row "Pending";
 *    it never marks it Appointed and never sets a date.
 *  • The list status of a Seasonal Plan is derived from its rows (seasonalSheetStatus); approval stays row-level.
 */

function assertPlanner(ctx: AuthContext): void {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can create Seasonal Plans");
}
function assertReader(ctx: AuthContext): void {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER && !isAdministrativeRole(ctx.role)) throw new ApiError(403, "You do not have access to Seasonal Planning");
}
const planner = (ctx: AuthContext): boolean => ctx.role === Role.SALES_OFFICER || ctx.role === Role.REGIONAL_MANAGER;
/** Who may create a Seasonal Plan (the container for a season): SO / RM, and Admin in their own right (owner = the Admin user; no SO scope is borrowed). */
function assertSheetCreator(ctx: AuthContext): void {
  if (isAdministrativeRole(ctx.role)) return assertAdminPermission(ctx, "partyPlanning", "manage");
  assertPlanner(ctx);
}
const SEASON_CLOSED = "This Seasonal Plan belongs to a season that is no longer open";

/* ------------------------------------------------ plan sheets (list / create / open) ------------------------------------------------ */

export interface SeasonalSheetDto {
  id: string; seasonId: string; seasonName: string; seasonOpen: boolean; ownerId: string; ownerName: string;
  status: SheetStatus; itemCount: number; pendingCount: number; needsMyReview: number; updatedAt: string; own: boolean;
}

const sheetInclude = {
  season: { select: { name: true, year: true, status: true } },
  owner: { select: { name: true } },
  items: { select: { approvalStatus: true, ownerId: true, updatedAt: true } },
} as const;
type SheetRow = Prisma.SeasonalPlanSheetGetPayload<{ include: typeof sheetInclude }>;

async function viewerOf(ctx: AuthContext) {
  const scope = await getOfficerScope(ctx);
  return { userId: ctx.userId, role: ctx.role === Role.REGIONAL_MANAGER ? ("RM" as const) : isAdministrativeRole(ctx.role) ? ("ADMIN" as const) : ("OTHER" as const), teamIds: scope.ids, scope };
}
type Viewer = Awaited<ReturnType<typeof viewerOf>>;

function toSheetDto(ctx: AuthContext, v: Viewer, r: SheetRow): SeasonalSheetDto {
  const updated = [r.updatedAt, ...r.items.map((i) => i.updatedAt)].sort((a, b) => b.getTime() - a.getTime())[0]!;
  return {
    id: r.id, seasonId: r.seasonId, seasonName: `${r.season.name} ${r.season.year}`, seasonOpen: r.season.status === "OPEN", ownerId: r.ownerId, ownerName: r.owner.name,
    status: seasonalSheetStatus(r.items), itemCount: r.items.length, pendingCount: r.items.filter((i) => i.approvalStatus === "PENDING_RM" || i.approvalStatus === "PENDING_ADMIN").length,
    needsMyReview: r.items.filter((i) => canReviewNow(i, v)).length, updatedAt: updated.toISOString(), own: r.ownerId === ctx.userId,
  };
}

/** Can the caller see this sheet at all? The owner always; Admin everyone's (drafts and empty plans included); an RM their team's — but only once a row has left Draft. */
function sheetVisible(ctx: AuthContext, v: Viewer, r: SheetRow): boolean {
  if (r.ownerId === ctx.userId || v.role === "ADMIN") return true;
  if (!v.scope.all && !v.scope.ids.includes(r.ownerId)) return false;
  return r.items.some((i) => i.approvalStatus !== "DRAFT");
}

/** The create dialog's choices: every OPEN season (the Seasons module's rule), flagged when the caller already has a plan for it. */
export async function getSeasonalOptions(ctx: AuthContext): Promise<{ seasons: (SeasonInfo & { hasPlan: boolean })[] }> {
  assertReader(ctx);
  const [seasons, mine] = await Promise.all([
    listOpenSeasonInfos(),
    planner(ctx) || isAdministrativeRole(ctx.role) ? prisma.seasonalPlanSheet.findMany({ where: { ownerId: ctx.userId }, select: { seasonId: true } }) : Promise.resolve([]),
  ]);
  const have = new Set(mine.map((m) => m.seasonId));
  return { seasons: seasons.map((s) => ({ ...s, hasPlan: have.has(s.id) })) };
}

/** The Seasonal Plans the caller may see, across ALL seasons. `needsReview` narrows to those with rows the caller can approve / reject now. */
export async function listSeasonalSheets(ctx: AuthContext, filters: { seasonId?: string; needsReview?: boolean } = {}): Promise<SeasonalSheetDto[]> {
  assertReader(ctx);
  const v = await viewerOf(ctx);
  const where: Prisma.SeasonalPlanSheetWhereInput = { ...(filters.seasonId ? { seasonId: filters.seasonId } : {}), ...(v.scope.all ? {} : { ownerId: { in: v.scope.ids } }) };
  const rows = await prisma.seasonalPlanSheet.findMany({ where, include: sheetInclude, take: 1000 });
  return rows.filter((r) => sheetVisible(ctx, v, r)).map((r) => toSheetDto(ctx, v, r))
    .filter((d) => !filters.needsReview || d.needsMyReview > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Create the caller's Seasonal Plan for a CHOSEN open season (one per owner and season). The season is validated, never assumed. */
export async function createSeasonalSheet(ctx: AuthContext, raw: unknown): Promise<SeasonalSheetDto> {
  assertSheetCreator(ctx);
  const parsed = z.object({ seasonId: z.string().min(1, "Select a season") }).safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Select a season");
  const season = await getSeasonInfo(parsed.data.seasonId);
  if (!season) throw new ApiError(422, "Select a valid season");
  if (season.status !== "OPEN") throw new ApiError(409, "Seasonal Plans can only be created for an open season");
  if (await prisma.seasonalPlanSheet.findUnique({ where: { ownerId_seasonId: { ownerId: ctx.userId, seasonId: season.id } }, select: { id: true } })) throw new ApiError(409, `You already have a Seasonal Plan for ${season.name} ${season.year}. Open it from the list.`);
  const created = await prisma.$transaction(async (tx) => {
    const sheet = await tx.seasonalPlanSheet.create({ data: { seasonId: season.id, ownerId: ctx.userId }, include: sheetInclude });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "seasonalPlanSheet", entityId: sheet.id, summary: `Seasonal Plan created · ${season.name} ${season.year}` }, tx);
    return sheet;
  });
  return toSheetDto(ctx, await viewerOf(ctx), created);
}

export interface SeasonalSheetDetail { sheet: SeasonalSheetDto; season: SeasonInfo; plans: SeasonalPlanDto[] }

/** Open ONE Seasonal Plan by its id. Its season and rows come from the plan itself — nothing is resolved from the current date or season. */
export async function getSeasonalSheet(ctx: AuthContext, id: string, search = ""): Promise<SeasonalSheetDetail> {
  assertReader(ctx);
  const v = await viewerOf(ctx);
  const sheet = await prisma.seasonalPlanSheet.findUnique({ where: { id }, include: sheetInclude });
  if (!sheet || !sheetVisible(ctx, v, sheet)) throw new ApiError(404, "Seasonal Plan not found"); // not yours / not in scope looks the same as missing
  const season = await getSeasonInfo(sheet.seasonId);
  if (!season) throw new ApiError(404, "Seasonal Plan not found");
  const needle = search.trim();
  const rows = await prisma.seasonalPlan.findMany({
    where: { AND: [{ sheetId: id }, ...(sheet.ownerId === ctx.userId || v.role === "ADMIN" ? [] : [{ approvalStatus: { not: "DRAFT" } }]), ...(needle ? [{ OR: [{ partyName: { contains: needle, mode: "insensitive" as const } }, { market: { name: { contains: needle, mode: "insensitive" as const } } }] }] : [])] },
    include, orderBy: { createdAt: "desc" }, take: 1000,
  });
  return { sheet: toSheetDto(ctx, v, sheet), season, plans: await toDtos(ctx, rows, v) };
}

/* ------------------------------------------------ DTO ------------------------------------------------ */

export interface SeasonalPlanDto {
  id: string; sheetId: string; seasonId: string; seasonName: string;
  ownerId: string; ownerName: string;
  marketId: string; marketName: string;
  type: "Existing" | "New" | null; marketPotential: string | null;
  status: "—" | "Pending" | "Appointed"; appointmentDate: string | null;
  partyName: string;
  approvalStatus: ApprovalStatus; rejectionStage: string | null; rejectionReason: string | null;
  rmDecidedByName: string | null; rmDecidedAt: string | null; adminDecidedByName: string | null; adminDecidedAt: string | null;
  createdAt: string; updatedAt: string;
  editable: boolean; // the caller may edit / delete / submit it
  canReview: boolean; // the caller may approve / reject it right now
}

const include = {
  market: { select: { name: true, source: true, potential: true } },
  owner: { select: { name: true } },
  season: { select: { name: true, year: true } },
} as const;
type PlanRow = Prisma.SeasonalPlanGetPayload<{ include: typeof include }>;

async function toDtos(ctx: AuthContext, rows: PlanRow[], viewer?: Viewer): Promise<SeasonalPlanDto[]> {
  const v = viewer ?? await viewerOf(ctx);
  const deciderIds = [...new Set(rows.flatMap((r) => [r.rmDecidedById, r.adminDecidedById]).filter((x): x is string => !!x))];
  const users = deciderIds.length ? await prisma.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, name: true } }) : [];
  const name = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id, sheetId: r.sheetId, seasonId: r.seasonId, seasonName: `${r.season.name} ${r.season.year}`, ownerId: r.ownerId, ownerName: r.owner.name,
    marketId: r.marketId, marketName: r.market.name,
    // Type + Potential come from the authoritative Market (frozen at final approval).
    type: derivedType(shownMarketSource(r, r.market)), marketPotential: shownMarketPotential(r, r.market),
    status: displayStatus(r), appointmentDate: r.appointedAt ? r.appointedAt.toISOString().slice(0, 10) : null,
    partyName: r.partyName, approvalStatus: r.approvalStatus as ApprovalStatus, rejectionStage: r.rejectionStage, rejectionReason: r.rejectionReason,
    rmDecidedByName: r.rmDecidedById ? name.get(r.rmDecidedById) ?? null : null, rmDecidedAt: r.rmDecidedAt?.toISOString() ?? null,
    adminDecidedByName: r.adminDecidedById ? name.get(r.adminDecidedById) ?? null : null, adminDecidedAt: r.adminDecidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    editable: r.ownerId === ctx.userId && isEditable(r.approvalStatus), canReview: canReviewNow(r, v),
  }));
}

/* ------------------------------------------------ owner writes ------------------------------------------------ */

// Only these fields are read from the browser: anything else (ownerId, type, potential, status, season …) is stripped and ignored.
const createInput = z.object({ sheetId: z.string().min(1, "Open a Seasonal Plan first"), marketId: z.string().min(1, "Select a Market"), partyName: z.unknown() });
const updateInput = z.object({ marketId: z.string().min(1).optional(), partyName: z.unknown().optional() });

async function requireMarket(marketId: string): Promise<{ id: string; name: string }> {
  const market = await prisma.market.findUnique({ where: { id: marketId }, select: { id: true, name: true } });
  if (!market) throw new ApiError(422, "Select a valid Market");
  return market;
}
async function ownPlan(ctx: AuthContext, id: string): Promise<PlanRow> {
  const plan = await prisma.seasonalPlan.findUnique({ where: { id }, include });
  // Another officer's plan is indistinguishable from a missing one: ids cannot be probed.
  if (!plan || plan.ownerId !== ctx.userId) throw new ApiError(404, "Seasonal Plan not found");
  return plan;
}

export async function createSeasonalPlan(ctx: AuthContext, raw: unknown): Promise<SeasonalPlanDto> {
  assertPlanner(ctx);
  const parsed = createInput.safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid Seasonal Plan");
  const problem = validatePartyName(parsed.data.partyName);
  if (problem) throw new ApiError(422, problem);
  // The season comes from the Seasonal Plan being edited — and must still be open. Another officer's plan looks missing.
  const sheet = await prisma.seasonalPlanSheet.findUnique({ where: { id: parsed.data.sheetId }, select: { id: true, ownerId: true, seasonId: true, season: { select: { name: true, year: true, status: true } } } });
  if (!sheet || sheet.ownerId !== ctx.userId) throw new ApiError(404, "Seasonal Plan not found");
  if (sheet.season.status !== "OPEN") throw new ApiError(409, SEASON_CLOSED);
  const market = await requireMarket(parsed.data.marketId);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.seasonalPlan.create({ data: { sheetId: sheet.id, seasonId: sheet.seasonId, ownerId: ctx.userId, marketId: market.id, partyName: cleanPartyName(String(parsed.data.partyName)) }, include });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "seasonalPlan", entityId: row.id, summary: `Seasonal Plan drafted · ${sheet.season.name} ${sheet.season.year} · ${market.name} · ${row.partyName}` }, tx);
    return row;
  });
  return (await toDtos(ctx, [created]))[0]!;
}

export async function updateSeasonalPlan(ctx: AuthContext, id: string, raw: unknown): Promise<SeasonalPlanDto> {
  assertPlanner(ctx);
  const plan = await ownPlan(ctx, id);
  if (!isEditable(plan.approvalStatus)) throw new ApiError(409, "Only a draft or rejected Seasonal Plan can be edited");
  const parsed = updateInput.safeParse(raw ?? {});
  if (!parsed.success || (parsed.data.marketId === undefined && parsed.data.partyName === undefined)) throw new ApiError(422, "Nothing to update");
  const data: { marketId?: string; partyName?: string } = {};
  if (parsed.data.partyName !== undefined) {
    const problem = validatePartyName(parsed.data.partyName);
    if (problem) throw new ApiError(422, problem);
    data.partyName = cleanPartyName(String(parsed.data.partyName));
  }
  if (parsed.data.marketId !== undefined) data.marketId = (await requireMarket(parsed.data.marketId)).id;
  if (!(await isSeasonOpen(plan.seasonId))) throw new ApiError(409, SEASON_CLOSED);
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.seasonalPlan.update({ where: { id }, data, include });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "seasonalPlan", entityId: id, summary: `Seasonal Plan edited · ${row.market.name} · ${row.partyName}` }, tx);
    return row;
  });
  return (await toDtos(ctx, [updated]))[0]!;
}

export async function deleteSeasonalPlan(ctx: AuthContext, id: string): Promise<{ ok: true }> {
  assertPlanner(ctx);
  const plan = await ownPlan(ctx, id);
  if (!isEditable(plan.approvalStatus)) throw new ApiError(409, "Only a draft or rejected Seasonal Plan can be deleted");
  await prisma.$transaction(async (tx) => {
    await tx.seasonalPlan.delete({ where: { id } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "DELETE", entity: "seasonalPlan", entityId: id, summary: `Seasonal Plan deleted · ${plan.market.name} · ${plan.partyName}` }, tx);
  });
  return { ok: true };
}

/** Submit for review: to the owner's RM first (SO with an RM), otherwise straight to Admin. A new round clears the previous decisions. */
export async function submitSeasonalPlan(ctx: AuthContext, id: string): Promise<SeasonalPlanDto> {
  assertPlanner(ctx);
  const plan = await ownPlan(ctx, id);
  if (!(await isSeasonOpen(plan.seasonId))) throw new ApiError(409, SEASON_CLOSED);
  const rmId = ctx.role === Role.SALES_OFFICER ? await getCurrentManagerId(ctx.userId) : null;
  const target = submitTarget(plan.approvalStatus, ctx.role as "SALES_OFFICER" | "REGIONAL_MANAGER", rmId != null);
  if (!target) throw new ApiError(409, "This Seasonal Plan has already been submitted");
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.seasonalPlan.updateMany({
      where: { id, ownerId: ctx.userId, approvalStatus: plan.approvalStatus },
      data: { approvalStatus: target, rmDecidedById: null, rmDecidedAt: null, adminDecidedById: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null },
    });
    if (claimed.count === 0) throw new ApiError(409, "This Seasonal Plan has already been submitted");
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "seasonalPlan", entityId: id, summary: `Seasonal Plan submitted for ${target === "PENDING_RM" ? "RM" : "Admin"} review · ${plan.market.name} · ${plan.partyName}` }, tx);
    return (await tx.seasonalPlan.findUnique({ where: { id }, include }))!;
  });
  return (await toDtos(ctx, [updated]))[0]!;
}

/* ------------------------------------------------ review ------------------------------------------------ */

const actInput = z.object({ action: z.enum(["approve", "reject"]), reason: z.string().optional() });

/** RM review (PENDING_RM) then Admin final approval (PENDING_ADMIN). Rejection needs a reason; final approval makes the plan Pending. */
export async function actOnSeasonalPlan(ctx: AuthContext, id: string, raw: unknown): Promise<SeasonalPlanDto> {
  const parsed = actInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, "Choose approve or reject");
  const { action } = parsed.data;
  const reason = parsed.data.reason?.trim() ?? "";
  if (reason.length > 500) throw new ApiError(422, "The reason can be at most 500 characters.");
  const isRm = ctx.role === Role.REGIONAL_MANAGER, isAdmin = isAdministrativeRole(ctx.role);
  if (!isRm && !isAdmin) throw new ApiError(403, "Only a Regional Manager or Admin can review Seasonal Plans");
  if (isAdmin) assertAdminPermission(ctx, "partyPlanning", action === "approve" ? "approve" : "reject");

  const updated = await prisma.$transaction(async (tx) => {
    const plan = await tx.seasonalPlan.findUnique({ where: { id }, include });
    if (!plan) throw new ApiError(404, "Seasonal Plan not found");
    if (isRm) {
      const scope = await getOfficerScope(ctx, tx);
      if (plan.ownerId === ctx.userId || !scope.ids.includes(plan.ownerId)) throw new ApiError(403, "This plan is outside your team");
    }
    const step = reviewTransition(plan.approvalStatus, { by: isRm ? "RM" : "ADMIN", action, reason });
    if (!step.ok) throw new ApiError(step.code, step.message);
    const now = new Date();
    const who = isRm ? { rmDecidedById: ctx.userId, rmDecidedAt: now } : { adminDecidedById: ctx.userId, adminDecidedAt: now };
    const data: Prisma.SeasonalPlanUncheckedUpdateManyInput = { approvalStatus: step.approvalStatus, ...who };
    if (action === "reject") Object.assign(data, { rejectionStage: isRm ? "RM" : "ADMIN", rejectionReason: reason });
    if (step.finalApproval) Object.assign(data, finalApprovalFields(plan.market)); // → Pending, no appointment date
    const claimed = await tx.seasonalPlan.updateMany({ where: { id, approvalStatus: plan.approvalStatus }, data });
    if (claimed.count === 0) throw new ApiError(409, "This plan was just reviewed by someone else");
    const verb = action === "approve" ? (step.finalApproval ? "approved (final)" : "approved by RM") : "rejected";
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "seasonalPlan", entityId: id, summary: `Seasonal Plan ${verb} · ${plan.market.name} · ${plan.partyName}${action === "reject" ? ` — ${reason}` : ""}` }, tx);
    return (await tx.seasonalPlan.findUnique({ where: { id }, include }))!;
  });
  return (await toDtos(ctx, [updated]))[0]!;
}
