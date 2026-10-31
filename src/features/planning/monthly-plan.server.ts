import { actorDisplayName } from "@/features/accounts/identity";
import { assertAdminPermission } from "@/features/accounts/permissions";
import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";

import { SEASON_MONTH_ORDER, calendarRows } from "@/lib/season-calendar";
import { z } from "zod";
import { Prisma, PlanStatus, ApprovalActionType, Role, NotificationType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { lockMonthlyPlan, type LockedMonthlyPlan } from "@/lib/plan-row-lock.server";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertOfficerInScope, getCurrentManagerId, getOfficerScope, isDealerOwnerRole, isPlanOwner } from "@/lib/scope";
import { createNotification, notifyMany, getSuperAdminIds } from "@/features/notifications/service.server";
import { saveMonthlySchema } from "@/lib/validations/planning";
import { isQuantityMode, type PlanningMode } from "@/lib/calc";
import { tightKey } from "@/lib/match-key";
import { findProbableDealers } from "@/lib/dealer-resolver";
import { DEALER_STATUSES, isActiveForStatus } from "@/lib/dealer-status";
import { planningProductsForOfficer, catalogueEntryForOfficerProduct, clearanceMapForGroup, clearanceSoldForGroup } from "@/features/users/catalogue.server";
import { writeAudit } from "@/lib/audit";
import { applyDealerAssignment } from "@/features/assignments/service.server";
import { buildMonthlyDealers } from "./monthly.server";
import { loadEffectiveProduct } from "@/features/products/merge.server";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { assertLifecycleEditable, officerVisibilityWhere, isHiddenFromOfficer, isHiddenByArchivedParent } from "./lifecycle.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/**
 * First-class Monthly Plan lifecycle. A MonthlyPlan is one month of an APPROVED seasonal
 * plan, with the SAME approval workflow as the seasonal plan (Officer → RM → Admin). It
 * reuses the existing monthly DATA engine (MonthlyEntry + `buildMonthlyDealers`) — no line
 * calculations are duplicated. This file adds only the lifecycle (status machine, approval
 * log, notifications), mirroring the seasonal approval code path.
 */

const EDITABLE: PlanStatus[] = [PlanStatus.DRAFT, PlanStatus.RETURNED, PlanStatus.REJECTED];
const PENDING: PlanStatus[] = [PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN];

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

interface MonthlyPlanRow {
  id: string;
  seasonPlanId: string;
  seasonMonthId: string;
  officerId: string;
  status: PlanStatus;
  lifecycleState: string;
  lifecycleFromParent: boolean;
  seasonPlan: { seasonId: string; officerId: string; lifecycleState: string };
  seasonMonth: { name: string; order: number };
}

async function loadMonthlyPlanOr404(id: string): Promise<MonthlyPlanRow> {
  const mp = await prisma.monthlyPlan.findUnique({
    where: { id },
    include: {
      seasonPlan: { select: { seasonId: true, officerId: true, lifecycleState: true } },
      seasonMonth: { select: { name: true, order: true, calendarMonth: true, calendarYear: true } },
    },
  });
  if (!mp) throw new ApiError(404, "Monthly plan not found");
  return mp as unknown as MonthlyPlanRow;
}

/**
 * A monthly plan is editable only when BOTH it and its parent seasonal plan are ACTIVE (a closed or
 * deactivated seasonal plan freezes its months too). One guard, called by every mutating action.
 *
 * BUSINESS RULE (Monthly CLOSED = planning read-only only): a CLOSED monthly plan blocks plan EDITING
 * only. Actual-sales (Sales Upload) and reporting operate at the SEASONAL-plan level and are
 * intentionally NOT gated by an individual month's lifecycle — sales still post and the month still
 * appears in reports. Full month-level freezing of actuals/reports is deliberately out of scope.
 */
function assertMonthlyLive(mp: MonthlyPlanRow) {
  assertLifecycleEditable(mp.seasonPlan.lifecycleState, "The parent seasonal plan");
  assertLifecycleEditable(mp.lifecycleState, "This monthly plan");
}

async function monthlyLabel(mp: MonthlyPlanRow): Promise<string> {
  const [officer, season] = await Promise.all([
    prisma.user.findUnique({ where: { id: mp.officerId }, select: { name: true } }),
    prisma.season.findUnique({ where: { id: mp.seasonPlan.seasonId }, select: { name: true, year: true } }),
  ]);
  return `${officer?.name ?? "Officer"} — ${season?.name ?? ""} ${season?.year ?? ""} · ${mp.seasonMonth.name}`.trim();
}

async function recordMonthlyAction(
  mp: { id: string; seasonPlanId: string },
  ctx: AuthContext,
  action: ApprovalActionType,
  fromStatus: PlanStatus,
  toStatus: PlanStatus,
  remarks?: string,
) {
  await prisma.approvalAction.create({
    data: { seasonPlanId: mp.seasonPlanId, monthlyPlanId: mp.id, actorId: ctx.userId, ...(ctx.designation ? { actorDesignation: ctx.designation } : {}), action, fromStatus, toStatus, remarks },
  });
}

/* ------------------------------- Creation --------------------------------- */

export async function createMonthlyPlan(
  ctx: AuthContext,
  seasonPlanId: string,
  seasonMonthId: string,
): Promise<{ id: string; reopened: boolean }> {
  const seasonPlan = await prisma.seasonPlan.findUnique({ where: { id: seasonPlanId } });
  if (!seasonPlan) throw new ApiError(404, "Seasonal plan not found");
  if (!(seasonPlan.status === PlanStatus.APPROVED && seasonPlan.isActiveVersion)) {
    throw new ApiError(409, "Monthly plans can only be created from an approved seasonal plan");
  }
  assertLifecycleEditable((seasonPlan as { lifecycleState?: string }).lifecycleState, "The seasonal plan");
  const isOwner = isPlanOwner(ctx, seasonPlan.officerId);
  if (!(isOwner || isAdministrativeRole(ctx.role))) {
    throw new ApiError(403, "Only the owning Sales Officer or a Super Admin can create a monthly plan");
  }
  // The month must belong to this plan's season.
  const month = await prisma.seasonMonth.findUnique({ where: { id: seasonMonthId }, select: { seasonId: true } });
  if (!month || month.seasonId !== seasonPlan.seasonId) {
    throw new ApiError(422, "That month does not belong to this plan's season");
  }

  const existing = await prisma.monthlyPlan.findUnique({
    where: { seasonPlanId_seasonMonthId: { seasonPlanId, seasonMonthId } },
  });
  if (existing) {
    if (EDITABLE.includes(existing.status as PlanStatus)) return { id: existing.id, reopened: true };
    throw new ApiError(409, "A monthly plan for this month already exists and is submitted or approved");
  }

  const created = await prisma.monthlyPlan.create({
    data: { seasonPlanId, seasonMonthId, officerId: seasonPlan.officerId, status: PlanStatus.DRAFT },
  });
  return { id: created.id, reopened: false };
}

/* --------------------------------- Lists ---------------------------------- */

export async function listMonthlyPlans(
  ctx: AuthContext,
  opts: { seasonPlanId?: string; statuses?: PlanStatus[] } = {},
) {
  const scope = await getOfficerScope(ctx);
  const rows = await prisma.monthlyPlan.findMany({
    where: {
      seasonPlanId: opts.seasonPlanId || undefined,
      officerId: scope.all ? undefined : { in: scope.ids },
      status: opts.statuses ? { in: opts.statuses } : undefined,
      // Deactivated monthly plans are hidden from the SO; so are plans that still FOLLOW a deactivated
      // seasonal parent — but a directly-restored (historical/read-only) child stays visible.
      ...officerVisibilityWhere(ctx),
      ...(ctx.role === Role.SALES_OFFICER
        ? { OR: [{ lifecycleFromParent: false }, { seasonPlan: { lifecycleState: { not: "DEACTIVATED" } } }] }
        : {}),
    },
    include: {
      seasonPlan: { select: { seasonId: true, season: { select: { name: true, year: true } } } },
      seasonMonth: { select: { name: true, order: true, calendarMonth: true, calendarYear: true } },
      officer: { select: { name: true, territory: true, group: { select: { name: true } } } },
    },
    orderBy: [{ updatedAt: "desc" }],
  });
  // TEMP DIAGNOSTIC (approval visibility, prod-only empty): logs the authenticated officer id + the
  // result count, and — when a Sales Officer sees zero — whether monthly plans exist under the SAME
  // username but a DIFFERENT officerId (the tell-tale of a duplicated/re-seeded user row in prod).
  // Read-only; no workflow change. Remove after diagnosis.
  if (ctx.role === Role.SALES_OFFICER) {
    console.log(`[approvals-debug:monthly] sessionUserId=${ctx.userId} username=${ctx.username} scopeIds=${JSON.stringify(scope.ids)} resultCount=${rows.length}`);
    if (rows.length === 0 && ctx.username) {
      const byName = (await prisma.monthlyPlan.findMany({
        where: { officer: { username: ctx.username } },
        select: { officerId: true, status: true, officer: { select: { id: true, name: true } } },
        take: 25,
      })) as { officerId: string; status: string; officer: { id: string; name: string } }[];
      const distinctOfficerIds = [...new Set(byName.map((p) => p.officerId))];
      console.log(
        `[approvals-debug:monthly] plans for username=${ctx.username}: count=${byName.length} distinctOfficerIds=${JSON.stringify(distinctOfficerIds)} sessionOfficerId=${ctx.userId} match=${distinctOfficerIds.includes(ctx.userId)}`,
      );
    }
  }
  return rows.map((mp) => ({
    id: mp.id,
    seasonPlanId: mp.seasonPlanId,
    seasonMonthId: mp.seasonMonthId,
    seasonName: `${mp.seasonPlan.season.name} ${mp.seasonPlan.season.year}`,
    monthName: mp.seasonMonth.name,
    monthOrder: mp.seasonMonth.order,
    calendarMonth: mp.seasonMonth.calendarMonth,
    calendarYear: mp.seasonMonth.calendarYear,
    officerId: mp.officerId,
    officerName: mp.officer.name,
    territory: (mp.officer as { territory?: string | null }).territory ?? null,
    groupName: (mp.officer as { group?: { name: string } | null }).group?.name ?? null,
    status: mp.status as PlanStatus,
    lifecycleState: (mp as { lifecycleState?: string }).lifecycleState ?? "ACTIVE",
    submittedAt: mp.submittedAt,
    approvedAt: mp.approvedAt,
    lastSavedAt: mp.lastSavedAt,
    updatedAt: mp.updatedAt,
  }));
}

/**
 * The months of an approved seasonal plan, annotated with any existing MonthlyPlan status.
 * Powers the "Create New Monthly Plan" month step and the "Select Monthly Plan" dialog.
 */
export async function getSeasonalPlanMonths(ctx: AuthContext, seasonPlanId: string) {
  const seasonPlan = await prisma.seasonPlan.findUnique({
    where: { id: seasonPlanId },
    select: { seasonId: true, officerId: true, status: true, isActiveVersion: true, season: { select: { name: true, year: true } } },
  });
  if (!seasonPlan) throw new ApiError(404, "Seasonal plan not found");
  await assertOfficerInScope(ctx, seasonPlan.officerId);

  const [months, monthlyPlans] = await Promise.all([
    prisma.seasonMonth.findMany({ where: { seasonId: seasonPlan.seasonId }, orderBy: SEASON_MONTH_ORDER }),
    prisma.monthlyPlan.findMany({ where: { seasonPlanId }, select: { id: true, seasonMonthId: true, status: true } }),
  ]);
  const byMonth = new Map<string, { id: string; status: PlanStatus }>(
    (monthlyPlans as { id: string; seasonMonthId: string; status: PlanStatus }[]).map((mp) => [mp.seasonMonthId, mp]),
  );

  return {
    seasonPlanId,
    seasonName: `${seasonPlan.season.name} ${seasonPlan.season.year}`,
    seasonId: seasonPlan.seasonId,
    approved: seasonPlan.status === PlanStatus.APPROVED && seasonPlan.isActiveVersion,
    months: calendarRows(months).map((m) => {
      const mp = byMonth.get(m.id);
      return {
        id: m.id,
        name: m.name,
        calendarMonth: m.calendarMonth,
        calendarYear: m.calendarYear,
        order: m.order,
        status: (m as { status?: string }).status ?? "OPEN",
        monthlyPlan: mp ? { id: mp.id, status: mp.status as PlanStatus } : null,
      };
    }),
  };
}

/* -------------------------------- Planner --------------------------------- */

export async function getMonthlyPlan(ctx: AuthContext, monthlyPlanId: string) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  // Hidden from the SO if the plan itself is deactivated, or it still FOLLOWS a deactivated parent
  // (a directly-restored historical/read-only child stays viewable).
  if (isHiddenFromOfficer(ctx, mp.lifecycleState) || isHiddenByArchivedParent(ctx, mp.lifecycleFromParent, mp.seasonPlan.lifecycleState)) {
    throw new ApiError(404, "Monthly plan not found");
  }
  await assertOfficerInScope(ctx, mp.officerId);

  const seasonId = mp.seasonPlan.seasonId;
  const [season, planDealers, month, noPlanRows] = await Promise.all([
    prisma.season.findUnique({ where: { id: seasonId }, select: { name: true, year: true, monthlyMode: true } }),
    prisma.planDealer.findMany({
      // Only isActive dealers appear (excludes Inactive/deleted). Defaulters are blocked from every
      // planning screen. Pending monthly-created dealers stay visible to their creator (isActive=true).
      where: { seasonPlanId: mp.seasonPlanId, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
      include: {
        dealer: { select: { name: true, mobile: true, village: true, tehsil: true, district: true, address: true } },
        lines: {
          include: {
            product: { select: { name: true, rate: true, nbvPercent: true } },
            packs: { select: { quantity: true } },
            monthlyEntries: { where: { seasonMonthId: mp.seasonMonthId } },
          },
        },
      },
    }),
    prisma.seasonMonth.findUnique({ where: { id: mp.seasonMonthId }, select: { id: true, name: true, order: true, calendarMonth: true, calendarYear: true } }),
    prisma.monthlyPlanDealer.findMany({ where: { monthlyPlanId: mp.id, noPlan: true }, select: { dealerId: true, noPlanReason: true } }),
  ]);

  const isOwner = isPlanOwner(ctx, mp.officerId);
  const monthlyMode = (season?.monthlyMode ?? "PACK_SIZE") as PlanningMode;
  const isLive = mp.lifecycleState === "ACTIVE" && mp.seasonPlan.lifecycleState === "ACTIVE";
  const canEdit = (isOwner || isAdministrativeRole(ctx.role)) && EDITABLE.includes(mp.status) && isLive;
  // Admin Override: a Super Admin may correct an APPROVED, live monthly plan (read-only flag; the
  // admin-edit service re-checks the parent seasonal version).
  const canAdminEdit = isAdministrativeRole(ctx.role) && mp.status === PlanStatus.APPROVED && isLive;
  // Exactly ONE month — shaped as MonthlyData so the existing provider/planner consume it
  // unchanged (no in-page month selector). Editability comes from the monthly plan lifecycle.
  const months = month
    ? [{ id: month.id, name: month.name, calendarMonth: month.calendarMonth, calendarYear: month.calendarYear, order: 1, status: "OPEN", editable: canEdit }]
    : [];

  const noPlanByDealer = new Map<string, string | null>(
    (noPlanRows as { dealerId: string; noPlanReason: string | null }[]).map((r) => [r.dealerId, r.noPlanReason]),
  );
  const monthId = mp.seasonMonthId;
  // Contact info per dealer (for the Edit-dealer dialog on pending, monthly-created dealers).
  const contactByDealer = new Map<string, { mobile: string | null; village: string | null; tehsil: string | null; district: string | null; address: string | null }>(
    (planDealers as { dealerId: string; dealer: { mobile: string | null; village: string | null; tehsil: string | null; district: string | null; address: string | null } }[]).map((pd) => [
      pd.dealerId,
      { mobile: pd.dealer.mobile, village: pd.dealer.village, tehsil: pd.dealer.tehsil, district: pd.dealer.district, address: pd.dealer.address },
    ]),
  );
  // Clearance flags (group-specific, by the plan officer's group + productId) — display-only.
  const clearanceOfficer = (await prisma.user.findUnique({ where: { id: mp.officerId }, select: { groupId: true, name: true } })) as { groupId: string | null; name: string | null } | null;
  const clearance = await clearanceMapForGroup(clearanceOfficer?.groupId ?? null);
  // Product Merge (Phase 12): operational identity per line so merged sources fold into the survivor.
  const effMp = await loadEffectiveProduct();
  // Season Sales = TOTAL actual sales for the WHOLE season per plan line (every month), from the same
  // authoritative MonthlyEntry.saleQty/saleValue used everywhere. Independent of the selected month.
  // findMany + in-app aggregation (groupBy's relational-where typing is unreliable on Prisma 6.3.1).
  const seasonEntries = (await prisma.monthlyEntry.findMany({
    where: { planLine: { planDealer: { seasonPlanId: mp.seasonPlanId } } },
    select: { planLineId: true, saleQty: true, saleValue: true },
  })) as { planLineId: string; saleQty: unknown; saleValue: unknown }[];
  const seasonSaleByLine = new Map<string, { qty: number; value: number }>();
  for (const e of seasonEntries) {
    const cur = seasonSaleByLine.get(e.planLineId) ?? { qty: 0, value: 0 };
    cur.qty += num(e.saleQty ?? 0);
    cur.value += num(e.saleValue ?? 0);
    seasonSaleByLine.set(e.planLineId, cur);
  }

  // Attach per-dealer completion (≥1 monthly plan value entered — the SAME "has a value" concept
  // Seasonal Planning uses) and the stored monthly No Plan state.
  const mpAliasNames = await loadDealerAliasNameMap(planDealers.map((pd) => pd.dealerId));
  const dealers = buildMonthlyDealers(planDealers, months, monthlyMode, effMp, clearance, mpAliasNames).map((d) => ({
    ...d,
    noPlan: noPlanByDealer.has(d.dealerId),
    noPlanReason: noPlanByDealer.get(d.dealerId) ?? null,
    completed: d.products.some((p) => (p.monthly[monthId]?.plan ?? 0) > 0),
    contact: contactByDealer.get(d.dealerId) ?? null,
    // Whole-season actual sales per product (qty + value); the client picks the unit by planning mode.
    products: d.products.map((p) => ({
      ...p,
      seasonSaleQty: seasonSaleByLine.get(p.planLineId)?.qty ?? 0,
      seasonSaleValue: seasonSaleByLine.get(p.planLineId)?.value ?? 0,
    })),
  }));

  return {
    monthlyPlanId: mp.id,
    planId: mp.seasonPlanId,
    officerId: mp.officerId,
    officerName: clearanceOfficer?.name ?? "",
    status: mp.status,
    canEdit,
    canAdminEdit,
    seasonName: season ? `${season.name} ${season.year}` : "",
    monthName: month?.name ?? "",
    monthlyMode,
    months,
    dealers,
  };
}

/**
 * Mark a dealer "No Plan" for THIS month (or clear it) — the monthly analogue of
 * setDealerNoPlan. Owner officer (editable plan) or Super Admin only. Completed/Remaining stay
 * derived from stored monthly plan values; only No Plan is persisted (per month, not seasonal).
 */
export async function setMonthlyDealerNoPlan(
  ctx: AuthContext,
  monthlyPlanId: string,
  dealerId: string,
  noPlan: boolean,
  reason?: string,
): Promise<{ noPlan: boolean; noPlanReason: string | null }> {
  const noPlanReason = noPlan ? reason?.trim() || null : null;
  // No Plan changes completion, so it follows the same locked-row rule as saves and Submit.
  return prisma.$transaction(async (tx) => {
    const mp = await lockMonthlyPlan(tx, monthlyPlanId);
    if (!mp) throw new ApiError(404, "Monthly plan not found");
    const isOwner = isPlanOwner(ctx, mp.officerId);
    if (!(isOwner || isAdministrativeRole(ctx.role))) throw new ApiError(403, "You cannot change this monthly plan");
    if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "This monthly plan is not editable");
    assertLifecycleEditable(mp.parentLifecycleState, "The parent seasonal plan");
    assertLifecycleEditable(mp.lifecycleState, "This monthly plan");
    await tx.monthlyPlanDealer.upsert({
      where: { monthlyPlanId_dealerId: { monthlyPlanId, dealerId } },
      create: { monthlyPlanId, dealerId, noPlan, noPlanReason },
      update: { noPlan, noPlanReason },
    });
    return { noPlan, noPlanReason };
  }, MONTHLY_WRITE_TRANSACTION);
}

/**
 * Approved-monthly view for a seasonal plan — powers the Seasonal Product Plan / Dealer
 * Summary "Specific Month" and "Month Range" filters. Only APPROVED monthly plans contribute;
 * figures reuse the same monthly data engine (`buildMonthlyDealers`). If no approved monthly
 * plan exists the caller shows the "Monthly Planning has not been initiated" message.
 */
export async function getApprovedMonthlyForSeasonPlan(ctx: AuthContext, seasonPlanId: string) {
  const seasonPlan = await prisma.seasonPlan.findUnique({
    where: { id: seasonPlanId },
    select: { seasonId: true, officerId: true, season: { select: { monthlyMode: true } } },
  });
  if (!seasonPlan) throw new ApiError(404, "Seasonal plan not found");
  await assertOfficerInScope(ctx, seasonPlan.officerId);

  const monthlyMode = (seasonPlan.season.monthlyMode ?? "PACK_SIZE") as PlanningMode;
  const approved = await prisma.monthlyPlan.findMany({
    where: { seasonPlanId, status: PlanStatus.APPROVED },
    select: { seasonMonthId: true },
  });
  const approvedIds = approved.map((a) => a.seasonMonthId);
  if (approvedIds.length === 0) return { monthlyMode, months: [], dealers: [] };

  const [months, planDealers] = await Promise.all([
    prisma.seasonMonth.findMany({ where: { id: { in: approvedIds } }, orderBy: SEASON_MONTH_ORDER, select: { id: true, name: true, order: true, calendarMonth: true, calendarYear: true } }),
    prisma.planDealer.findMany({
      where: { seasonPlanId },
      include: {
        dealer: { select: { name: true } },
        lines: {
          include: {
            product: { select: { name: true, rate: true, nbvPercent: true } },
            packs: { select: { quantity: true } },
            monthlyEntries: { where: { seasonMonthId: { in: approvedIds } } },
          },
        },
      },
    }),
  ]);

  const clOfficer = (await prisma.user.findUnique({ where: { id: seasonPlan.officerId }, select: { groupId: true } })) as { groupId: string | null } | null;
  const clearance = await clearanceMapForGroup(clOfficer?.groupId ?? null);
  // Product Merge (Phase 12): operational identity per line so merged sources fold into the survivor.
  const eff = await loadEffectiveProduct();
  const aliasNames = await loadDealerAliasNameMap(planDealers.map((pd) => pd.dealerId));
  return { monthlyMode, months: calendarRows(months), dealers: buildMonthlyDealers(planDealers, months, monthlyMode, eff, clearance, aliasNames) };
}

/* -------------------------------- Saving ---------------------------------- */

/** Bounded limits for the short officer write transactions (a constant number of statements; nothing waits on the browser inside them). */
const MONTHLY_WRITE_TRANSACTION = { maxWait: 10_000, timeout: 15_000 };

/** The editability rule every write of a monthly plan shares, checked on the LOCKED row inside the write's own transaction. */
function assertMonthlyWritable(mp: LockedMonthlyPlan | null, ctx: AuthContext, refused: string, ownerOnly = false): asserts mp is LockedMonthlyPlan {
  if (!mp) throw new ApiError(404, "Monthly plan not found");
  const isOwner = isPlanOwner(ctx, mp.officerId);
  if (!(isOwner || (!ownerOnly && isAdministrativeRole(ctx.role)))) {
    throw new ApiError(403, ownerOnly ? "Only the owning Sales Officer can submit this monthly plan" : "Only the owning Sales Officer or a Super Admin can enter monthly figures");
  }
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, refused);
  assertLifecycleEditable(mp.parentLifecycleState, "The parent seasonal plan");
  assertLifecycleEditable(mp.lifecycleState, "This monthly plan");
}

/** One stored monthly entry as the monthly read shows it (the read's own rule: value modes use planValue, quantity modes planQty). */
export interface SavedMonthlyEntry { planLineId: string; seasonMonthId: string; planQty: number; planValue: number | null }

export async function saveMonthlyPlanEntries(ctx: AuthContext, monthlyPlanId: string, raw: unknown) {
  const { entries: sent } = saveMonthlySchema.parse(raw);
  // The same cell sent twice in one request: the later entry wins (as the former one-by-one writes did).
  const entries = [...new Map(sent.map((e) => [`${e.planLineId}|${e.seasonMonthId}`, e])).values()];

  return prisma.$transaction(async (tx) => {
    // Editability is checked on the LOCKED monthly plan: a Submit waits for this save, and a save that arrives after Submit is refused.
    const mp = await lockMonthlyPlan(tx, monthlyPlanId);
    assertMonthlyWritable(mp, ctx, "This monthly plan is not editable in its current state");

    const ids = [...new Set(entries.map((e) => e.planLineId))];
    const valid = new Set(ids.length === 0 ? [] : (await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT l."id" FROM "PlanLine" l JOIN "PlanDealer" d ON d."id" = l."planDealerId"
      WHERE d."seasonPlanId" = ${mp.seasonPlanId} AND l."id" = ANY(${ids}::text[])`)).map((r) => r.id));
    for (const e of entries) {
      if (!valid.has(e.planLineId)) throw new ApiError(422, "Plan line is not part of this plan");
      // A monthly plan owns exactly ONE month — reject stray months defensively.
      if (e.seasonMonthId !== mp.seasonMonthId) throw new ApiError(422, "Entry month does not match this monthly plan");
    }

    // Monthly planning writes ONLY the plan fields. Actual sales (saleQty / saleValue) are owned exclusively by the Sales Upload and are never
    // modified here. A field the request leaves out keeps its stored value (a new entry starts at 0). One statement per group, whatever the count.
    const month = mp.seasonMonthId;
    const qtyWith = entries.filter((e) => isQuantityMode((e.mode ?? "PACK_SIZE") as PlanningMode) && e.planQty !== undefined);
    const qtyWithout = entries.filter((e) => isQuantityMode((e.mode ?? "PACK_SIZE") as PlanningMode) && e.planQty === undefined);
    const valueWith = entries.filter((e) => !isQuantityMode((e.mode ?? "PACK_SIZE") as PlanningMode) && e.planValue !== undefined);
    const valueWithout = entries.filter((e) => !isQuantityMode((e.mode ?? "PACK_SIZE") as PlanningMode) && e.planValue === undefined);
    const stored: { planLineId: string; planQty: number; planValue: string | null }[] = [];
    const ret = Prisma.sql`RETURNING "planLineId", "planQty", "planValue"::text AS "planValue"`;
    if (qtyWith.length > 0) stored.push(...await tx.$queryRaw<typeof stored>(Prisma.sql`
      INSERT INTO "MonthlyEntry" ("id", "planLineId", "seasonMonthId", "planQty", "updatedAt")
      SELECT v."id", v."planLineId", ${month}, v."planQty", NOW() FROM unnest(${qtyWith.map(() => randomUUID())}::text[], ${qtyWith.map((e) => e.planLineId)}::text[], ${qtyWith.map((e) => e.planQty!)}::int[]) AS v("id", "planLineId", "planQty")
      ON CONFLICT ("planLineId", "seasonMonthId") DO UPDATE SET "planQty" = EXCLUDED."planQty", "updatedAt" = NOW()
      ${ret}`));
    if (qtyWithout.length > 0) stored.push(...await tx.$queryRaw<typeof stored>(Prisma.sql`
      INSERT INTO "MonthlyEntry" ("id", "planLineId", "seasonMonthId", "planQty", "updatedAt")
      SELECT v."id", v."planLineId", ${month}, 0, NOW() FROM unnest(${qtyWithout.map(() => randomUUID())}::text[], ${qtyWithout.map((e) => e.planLineId)}::text[]) AS v("id", "planLineId")
      ON CONFLICT ("planLineId", "seasonMonthId") DO UPDATE SET "updatedAt" = NOW()
      ${ret}`));
    if (valueWith.length > 0) stored.push(...await tx.$queryRaw<typeof stored>(Prisma.sql`
      INSERT INTO "MonthlyEntry" ("id", "planLineId", "seasonMonthId", "inputMode", "planValue", "updatedAt")
      SELECT v."id", v."planLineId", ${month}, v."mode", v."planValue", NOW()
      FROM unnest(${valueWith.map(() => randomUUID())}::text[], ${valueWith.map((e) => e.planLineId)}::text[], ${valueWith.map((e) => e.mode!)}::text[], ${valueWith.map((e) => String(e.planValue))}::numeric[]) AS v("id", "planLineId", "mode", "planValue")
      ON CONFLICT ("planLineId", "seasonMonthId") DO UPDATE SET "inputMode" = EXCLUDED."inputMode", "planValue" = EXCLUDED."planValue", "updatedAt" = NOW()
      ${ret}`));
    if (valueWithout.length > 0) stored.push(...await tx.$queryRaw<typeof stored>(Prisma.sql`
      INSERT INTO "MonthlyEntry" ("id", "planLineId", "seasonMonthId", "inputMode", "planValue", "updatedAt")
      SELECT v."id", v."planLineId", ${month}, v."mode", 0, NOW()
      FROM unnest(${valueWithout.map(() => randomUUID())}::text[], ${valueWithout.map((e) => e.planLineId)}::text[], ${valueWithout.map((e) => e.mode!)}::text[]) AS v("id", "planLineId", "mode")
      ON CONFLICT ("planLineId", "seasonMonthId") DO UPDATE SET "inputMode" = EXCLUDED."inputMode", "updatedAt" = NOW()
      ${ret}`));

    // Completion of every dealer touched by this save, with the monthly read's rule (≥1 planned value this month) on the SAVED state — the editor
    // patches its cached plan (progress, ticks, Submit gate) from this instead of re-reading the whole monthly plan.
    const dealers = ids.length === 0 ? [] : await tx.$queryRaw<{ dealerId: string; completed: boolean }[]>(Prisma.sql`
      SELECT d."dealerId", COALESCE(BOOL_OR(CASE WHEN ${!isQuantityMode(mp.monthlyMode as PlanningMode)} THEN e."planValue" > 0 ELSE e."planQty" > 0 END), false) AS "completed"
      FROM "PlanDealer" d
      JOIN "PlanLine" l ON l."planDealerId" = d."id"
      LEFT JOIN "MonthlyEntry" e ON e."planLineId" = l."id" AND e."seasonMonthId" = ${month}
      WHERE d."seasonPlanId" = ${mp.seasonPlanId}
        AND d."id" IN (SELECT l2."planDealerId" FROM "PlanLine" l2 WHERE l2."id" = ANY(${ids}::text[]))
      GROUP BY d."dealerId"`);
    const saved = await tx.monthlyPlan.update({ where: { id: mp.id }, data: { lastSavedAt: new Date() }, select: { lastSavedAt: true } });
    const savedEntries: SavedMonthlyEntry[] = stored.map((r) => ({ planLineId: r.planLineId, seasonMonthId: month, planQty: r.planQty, planValue: r.planValue == null ? null : Number(r.planValue) }));
    return { saved: true, lastSavedAt: saved.lastSavedAt, entries: savedEntries, dealers };
  }, MONTHLY_WRITE_TRANSACTION);
}

/* --------------------- Additional products & new dealers ------------------ */

/** Active products not already present in this dealer's current monthly plan. */
export async function getAdditionalProductCandidates(
  ctx: AuthContext,
  monthlyPlanId: string,
  dealerId: string,
) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertOfficerInScope(ctx, mp.officerId);

  // A product can already exist in the seasonal plan but still be absent from this
  // particular month. Only a MonthlyEntry for this month makes it ineligible to add.
  const existing = await prisma.planLine.findMany({
    where: {
      planDealer: { seasonPlanId: mp.seasonPlanId, dealerId },
      monthlyEntries: { some: { seasonMonthId: mp.seasonMonthId } },
    },
    select: { productId: true },
  });
  const alreadyInMonth = new Set(existing.map((line) => line.productId));

  // Candidates come from the officer's GROUP catalogue (active), at the group price (Master fallback when
  // the group has no catalogue). Names are joined from the Master. Products already in this month excluded.
  const catalogue = await planningProductsForOfficer(mp.officerId);
  const byId = new Map(catalogue.map((c) => [c.productId, c] as const));
  const names = (await prisma.product.findMany({
    where: { id: { in: catalogue.map((c) => c.productId) } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })) as { id: string; name: string }[];

  // Group-specific clearance (isClearance/clearanceQty already come from the group catalogue). Remaining
  // = clearanceQty − actual sold in THIS group only. Clearance is NEVER read from the Product Master.
  const officer = (await prisma.user.findUnique({ where: { id: mp.officerId }, select: { groupId: true } })) as { groupId: string | null } | null;
  const clearanceIds = catalogue.filter((c) => c.isClearance).map((c) => c.productId);
  const sold = await clearanceSoldForGroup(officer?.groupId ?? null, clearanceIds);

  return names
    .filter((p) => !alreadyInMonth.has(p.id))
    .map((p) => {
      const c = byId.get(p.id)!;
      const clearanceRemaining = c.isClearance && c.clearanceQty != null ? Math.max(0, c.clearanceQty - (sold.get(p.id) ?? 0)) : null;
      return { productId: p.id, productName: p.name, rate: c.rate, nbvPercent: c.nbvPercent, isClearance: c.isClearance ?? false, clearanceQty: c.clearanceQty ?? null, clearanceRemaining };
    });
}

/**
 * Add a product to one dealer's current monthly plan. A seasonal product reuses its existing
 * PlanLine; a product absent from the seasonal plan gets an additional zero-seasonal PlanLine.
 * In both cases, the zero-valued MonthlyEntry is the month-specific membership record.
 */
export async function addAdditionalProduct(ctx: AuthContext, monthlyPlanId: string, dealerId: string, productId: string) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = isPlanOwner(ctx, mp.officerId);
  if (!(isOwner || isAdministrativeRole(ctx.role))) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "This monthly plan is not editable");
  assertMonthlyLive(mp);

  // Availability + price come from the officer's GROUP catalogue (Master fallback). Null => not available.
  const entry = await catalogueEntryForOfficerProduct(mp.officerId, productId);
  if (!entry) throw new ApiError(422, "Product is not available in this group's catalogue");

  let pd = await prisma.planDealer.findUnique({
    where: { seasonPlanId_dealerId: { seasonPlanId: mp.seasonPlanId, dealerId } },
    select: { id: true },
  });
  if (!pd) pd = await prisma.planDealer.create({ data: { seasonPlanId: mp.seasonPlanId, dealerId }, select: { id: true } });

  const existingLine = await prisma.planLine.findUnique({
    where: {
      planDealerId_productId: {
        planDealerId: pd.id,
        productId,
      },
    },
    select: { id: true },
  });
  // Snapshot the group price onto the new line so it stays price-stable like every other line.
  const line = existingLine ?? await prisma.planLine.create({
    data: { planDealerId: pd.id, productId, isAdditional: true, rateSnapshot: entry.rate, nbvPercentSnapshot: entry.nbvPercent },
    select: { id: true },
  });
  await prisma.monthlyEntry.upsert({
    where: { planLineId_seasonMonthId: { planLineId: line.id, seasonMonthId: mp.seasonMonthId } },
    create: { planLineId: line.id, seasonMonthId: mp.seasonMonthId },
    update: {},
  });
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { lastSavedAt: new Date() } });
  return { planLineId: line.id, alreadyExisted: Boolean(existingLine) };
}

const dealerFieldsSchema = z.object({
  name: z.string().min(1, "Dealer name is required").max(200),
  mobile: z.string().max(20).optional(),
  village: z.string().max(120).optional(),
  tehsil: z.string().max(120).optional(),
  district: z.string().max(120).optional(),
  address: z.string().max(400).optional(),
  town: z.string().max(120).optional(), // "Territory" on the Dealer Alias create form
  // When true, skip the "possible existing dealer" duplicate warning and create anyway.
  force: z.boolean().optional(),
});
type DealerFields = z.infer<typeof dealerFieldsSchema>;

function dealerData(d: DealerFields) {
  return {
    name: d.name.trim(),
    mobile: d.mobile?.trim() || null,
    village: d.village?.trim() || null,
    tehsil: d.tehsil?.trim() || null,
    district: d.district?.trim() || null,
    address: d.address?.trim() || null,
    town: d.town?.trim() || null,
  };
}

/**
 * The ONE definition of the officer's "current seasonal plan" a dealer can be auto-added to, shared by
 * the add service below AND the Dealer-Alias membership indicator so both always agree:
 *   1. Preferred — the APPROVED, active-version, ACTIVE-lifecycle seasonal plan (the finalised plan).
 *   2. Fallback  — if none is approved yet, the officer's latest ACTIVE-lifecycle seasonal plan whose
 *      SEASON is still OPEN (e.g. a DRAFT/RETURNED plan being worked on). Newest version preferred.
 * Returns the target plan id, or null when the officer has neither. Read-only (no writes).
 */
export async function resolveAddableSeasonalPlanId(tx: Tx, officerId: string): Promise<string | null> {
  const approved = await tx.seasonPlan.findFirst({
    where: { officerId, planningType: "SEASONAL", status: PlanStatus.APPROVED, isActiveVersion: true, lifecycleState: "ACTIVE" },
    select: { id: true },
  });
  if (approved) return approved.id;
  // Fallback: an in-progress (not-yet-approved) plan for a season that is still OPEN.
  const open = await tx.seasonPlan.findFirst({
    where: { officerId, planningType: "SEASONAL", lifecycleState: "ACTIVE", season: { status: "OPEN" } },
    orderBy: [{ isActiveVersion: "desc" }, { version: "desc" }],
    select: { id: true },
  });
  return open?.id ?? null;
}

/**
 * Add an EXISTING dealer to the officer's current seasonal plan as a real seasonal dealer: one PlanDealer
 * + one zero-quantity PlanLine per active product (no PlanLinePack rows = 0). The target plan is resolved
 * by `resolveAddableSeasonalPlanId` — the APPROVED active plan, or (fallback) an open-season in-progress
 * plan. Idempotent (skips if the PlanDealer already exists). If the officer has NO approved AND no
 * open-season plan, it does nothing and returns a warning. Reused by the create form + Excel + Edit Dealer.
 */
export async function addDealerToActiveSeasonalPlan(tx: Tx, officerId: string, dealerId: string): Promise<{ added: boolean; warning?: string }> {
  const planId = await resolveAddableSeasonalPlanId(tx, officerId);
  if (!planId) return { added: false, warning: "This Sales Officer has no approved active plan and no open-season plan — the dealer was not added to any plan." };
  const existing = await tx.planDealer.findUnique({ where: { seasonPlanId_dealerId: { seasonPlanId: planId, dealerId } }, select: { id: true } });
  if (existing) return { added: true }; // no duplicate PlanDealer
  const pd = await tx.planDealer.create({ data: { seasonPlanId: planId, dealerId, fromMonthlyPlan: false }, select: { id: true } });
  await seedSeasonalPlanLines(tx, pd.id, officerId);
  return { added: true };
}

/**
 * Seed a PlanDealer with one zero-quantity PlanLine per product in the officer's CURRENT seasonal-plan
 * product set (their GROUP catalogue, group price snapshotted; Master fallback) — exactly how a seasonal
 * dealer is seeded. This is what makes a newly added/created dealer show the current Seasonal Plan products
 * (not an empty plan). Idempotent per (planDealer, product) is unnecessary here — the PlanDealer is new.
 */
async function seedSeasonalPlanLines(tx: Tx, planDealerId: string, officerId: string) {
  const products = await planningProductsForOfficer(officerId, tx);
  if (products.length > 0) {
    await tx.planLine.createMany({
      data: products.map((p) => ({ planDealerId, productId: p.productId, rateSnapshot: p.rate, nbvPercentSnapshot: p.nbvPercent })),
    });
  }
}

/** Create the first DealerAlias from the dealer name (idempotent on the unique tallyKey). */
async function ensureDealerAlias(tx: Tx, dealerId: string, name: string) {
  const key = tightKey(name);
  if (!key) return;
  const existing = await tx.dealerAlias.findUnique({ where: { tallyKey: key }, select: { id: true } });
  if (!existing) await tx.dealerAlias.create({ data: { systemDealerId: dealerId, tallyName: name.trim(), tallyKey: key } });
}

export interface DealerCreateOutcome {
  dealerId?: string;
  dealerName?: string;
  duplicates?: Awaited<ReturnType<typeof findProbableDealers>>;
  addedToPlan?: boolean;
  planWarning?: string;
}

/**
 * Create a dealer from Monthly Planning (Sales Officer). Created PENDING and stays PENDING until an
 * admin sets it Active (dealer approval is decoupled from plan approval). It participates in
 * matching/recovery (isActive) but is not planning-eligible while Pending. Appears in this officer's
 * monthly plan (PlanDealer `fromMonthlyPlan`). Reused by the Admin path via `createDealerForOfficer`.
 * Runs the shared duplicate check first (unless `force`).
 */
export async function createMonthlyDealer(ctx: AuthContext, monthlyPlanId: string, raw: unknown): Promise<DealerCreateOutcome> {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = isPlanOwner(ctx, mp.officerId);
  if (!(isOwner || isAdministrativeRole(ctx.role))) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "This monthly plan is not editable");
  assertMonthlyLive(mp);
  const data = dealerFieldsSchema.parse(raw);

  if (!data.force) {
    const duplicates = await findProbableDealers(data.name);
    if (duplicates.length > 0) return { duplicates };
  }

  // Create the dealer, its PlanDealer on THIS season plan, and seed the current Seasonal Plan product set
  // (so the new dealer opens with the seasonal products, not an empty plan) — atomically.
  const dealer = await prisma.$transaction(async (tx: Tx) => {
    const d = await tx.dealer.create({
      data: { ...dealerData(data), status: "PENDING", createdByUserId: ctx.userId, createdFrom: "MONTHLY_PLAN" },
    });
    const pd = await tx.planDealer.create({ data: { seasonPlanId: mp.seasonPlanId, dealerId: d.id, fromMonthlyPlan: true }, select: { id: true } });
    await seedSeasonalPlanLines(tx, pd.id, mp.officerId);
    return d;
  });
  return { dealerId: dealer.id, dealerName: dealer.name };
}

/**
 * List dealers the Sales Officer may ADD to this monthly plan: their CURRENTLY assigned, active,
 * non-defaulter dealers (server-side scope) that are NOT already a PlanDealer on this season plan. Because
 * the population is "all eligible dealers in the SO's scope" (not a frozen snapshot), dealers assigned
 * after the seasonal plan was created are included.
 */
export async function listAddableDealers(ctx: AuthContext, monthlyPlanId: string): Promise<{ id: string; name: string }[]> {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  if (!(isPlanOwner(ctx, mp.officerId) || isAdministrativeRole(ctx.role))) throw new ApiError(403, "You cannot change this monthly plan");
  await assertOfficerInScope(ctx, mp.officerId);
  const [assigns, present] = await Promise.all([
    prisma.dealerAssignment.findMany({
      where: { officerId: mp.officerId, effectiveTo: null, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
      select: { dealer: { select: { id: true, name: true } } },
    }) as Promise<{ dealer: { id: string; name: string } }[]>,
    prisma.planDealer.findMany({ where: { seasonPlanId: mp.seasonPlanId }, select: { dealerId: true } }) as Promise<{ dealerId: string }[]>,
  ]);
  const inPlan = new Set(present.map((p) => p.dealerId));
  return assigns.map((a) => a.dealer).filter((d) => !inPlan.has(d.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Add an EXISTING in-scope dealer to this monthly plan's season plan (as a real seasonal dealer with the
 * current Seasonal Plan products seeded at zero quantity). Owner Sales Officer / Super Admin; editable +
 * live plan; the dealer must be currently assigned to the plan officer (scope enforced server-side).
 * Idempotent — never creates a duplicate PlanDealer.
 */
export async function addExistingDealerToMonthlyPlan(ctx: AuthContext, monthlyPlanId: string, dealerId: string): Promise<{ added: boolean }> {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  if (!(isPlanOwner(ctx, mp.officerId) || isAdministrativeRole(ctx.role))) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "This monthly plan is not editable");
  assertMonthlyLive(mp);
  await assertOfficerInScope(ctx, mp.officerId);
  const assign = await prisma.dealerAssignment.findFirst({
    where: { officerId: mp.officerId, dealerId, effectiveTo: null, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
    select: { id: true },
  });
  if (!assign) throw new ApiError(422, "That dealer is not in your active dealer list");
  const existing = await prisma.planDealer.findUnique({ where: { seasonPlanId_dealerId: { seasonPlanId: mp.seasonPlanId, dealerId } }, select: { id: true } });
  if (existing) return { added: true }; // no duplicate — idempotent against double-submit
  await prisma.$transaction(async (tx: Tx) => {
    const pd = await tx.planDealer.create({ data: { seasonPlanId: mp.seasonPlanId, dealerId, fromMonthlyPlan: false }, select: { id: true } });
    await seedSeasonalPlanLines(tx, pd.id, mp.officerId);
  });
  return { added: true };
}

const adminCreateSchema = dealerFieldsSchema.extend({
  officerId: z.string().min(1, "Select a Sales Officer"),
  // Optional extras used by the Dealer Alias create form (the Dealers module omits them = unchanged):
  groupId: z.string().optional(), // validate the officer belongs to this group
  aliasName: z.string().max(200).optional(), // Tally alias (defaults to the dealer name)
  addToSeasonalPlan: z.boolean().optional(),
  // Approval status to create with. Admin create form omits it → ACTIVE (unchanged). The Excel import
  // passes the parsed "Dealer Status" column (defaults PENDING there). isActive is derived from it.
  status: z.enum(DEALER_STATUSES).optional(),
});

/**
 * Admin creates a dealer for a Sales Officer. No approval: the dealer is ACTIVE, permanently assigned
 * immediately (reusing `applyDealerAssignment`), and gets its DealerAlias — so it appears at once in
 * matching/recovery/sales-upload/future seasonal. Same Dealer model + duplicate check as the Monthly
 * path. Shared by the User Details page (Dealers module) AND the Dealer Alias create form; the latter
 * passes a Tally alias, a group to validate against, and an optional "add to active seasonal plan".
 * `opts.tx`: run the creation (and its audit) inside the CALLER's transaction instead of opening one — used by Party Planning's
 * Appointed step so the dealer and the row's status change commit or roll back together. Without it, behaviour is unchanged.
 */
export async function createDealerForOfficer(ctx: AuthContext, raw: unknown, opts: { tx?: Tx } = {}): Promise<DealerCreateOutcome> {
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only a Super Admin can create a dealer for an officer");
  const data = adminCreateSchema.parse(raw);
  const officer = await prisma.user.findUnique({ where: { id: data.officerId }, select: { role: true, isActive: true, groupId: true } });
  // A dealer may be owned by an active Sales Officer OR the group's Regional Manager (RMs also plan/own
  // their own dealers). Same DealerAssignment relationship for both — no separate RM-ownership path.
  if (!officer || !isDealerOwnerRole(officer.role) || !officer.isActive) throw new ApiError(422, "The selected owner must be an active Sales Officer or Regional Manager");
  if (data.groupId && officer.groupId !== data.groupId) throw new ApiError(422, "The selected owner does not belong to the selected group");

  // Duplicate-dealer guard (unchanged) …
  if (!data.force) {
    const duplicates = await findProbableDealers(data.name);
    if (duplicates.length > 0) return { duplicates };
  }
  // … and a duplicate-ALIAS guard when an explicit Tally alias was supplied.
  const aliasName = data.aliasName?.trim();
  if (aliasName) {
    const aliasKey = tightKey(aliasName);
    if (aliasKey) {
      const clash = await prisma.dealerAlias.findUnique({ where: { tallyKey: aliasKey }, select: { id: true } });
      if (clash) throw new ApiError(409, `An alias "${aliasName}" already exists`);
    }
  }

  const status = data.status ?? "ACTIVE";
  const body = async (tx: Tx) => {
      const dealer = await tx.dealer.create({
        data: { ...dealerData(data), status, isActive: isActiveForStatus(status), createdByUserId: ctx.userId, createdFrom: "ADMIN" },
      });
      await applyDealerAssignment(tx, dealer.id, data.officerId, new Date());
      // Save the alias automatically (the supplied Tally name, else the dealer name).
      await ensureDealerAlias(tx, dealer.id, aliasName || dealer.name);
      let plan: { added: boolean; warning?: string } = { added: false };
      // Only ACTIVE dealers are plan-eligible; never auto-add a Pending/Inactive/Defaulter dealer.
      if (data.addToSeasonalPlan && status === "ACTIVE") plan = await addDealerToActiveSeasonalPlan(tx, data.officerId, dealer.id);
      return { id: dealer.id, name: dealer.name, plan };
  };
  const created = opts.tx ? await body(opts.tx) : await prisma.$transaction(body, { timeout: 60000, maxWait: 10000 });
  await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "dealer", entityId: created.id, summary: `Admin created & assigned dealer "${created.name}" to a Sales Officer${created.plan.added ? " (added to active seasonal plan)" : ""}` }, opts.tx);
  return { dealerId: created.id, dealerName: created.name, addedToPlan: created.plan.added, planWarning: created.plan.warning };
}

/** Admin shortcut: assign an EXISTING dealer to a Sales Officer (from the duplicate dialog). */
export async function assignExistingDealer(ctx: AuthContext, dealerId: string, officerId: string) {
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only a Super Admin can assign a dealer");
  const [dealer, officer] = await Promise.all([
    prisma.dealer.findUnique({ where: { id: dealerId }, select: { name: true, status: true } }),
    prisma.user.findUnique({ where: { id: officerId }, select: { role: true, isActive: true } }),
  ]);
  if (!dealer) throw new ApiError(404, "Dealer not found");
  if (!officer || !isDealerOwnerRole(officer.role) || !officer.isActive) throw new ApiError(422, "The selected owner must be an active Sales Officer or Regional Manager");
  await prisma.$transaction(async (tx: Tx) => {
    await applyDealerAssignment(tx, dealerId, officerId, new Date());
    await ensureDealerAlias(tx, dealerId, dealer.name);
  });
  await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Admin assigned existing dealer "${dealer.name}" to its owner` });
  return { dealerId };
}

/**
 * Edit a PENDING dealer's info while its Monthly Plan is still DRAFT/RETURNED. Reuses the same
 * dialog (Edit mode). Read-only once the plan is submitted/approved. Only dealers created here
 * (fromMonthlyPlan) may be edited — never existing master dealers.
 */
export async function updateMonthlyDealer(ctx: AuthContext, monthlyPlanId: string, dealerId: string, raw: unknown) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = isPlanOwner(ctx, mp.officerId);
  if (!(isOwner || isAdministrativeRole(ctx.role))) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "Dealer info is read-only once the plan is submitted");
  assertMonthlyLive(mp);
  const pd = (await prisma.planDealer.findUnique({
    where: { seasonPlanId_dealerId: { seasonPlanId: mp.seasonPlanId, dealerId } },
    select: { fromMonthlyPlan: true },
  })) as { fromMonthlyPlan: boolean } | null;
  if (!pd?.fromMonthlyPlan) throw new ApiError(403, "Only a dealer created here can be edited");
  const dealer = (await prisma.dealer.findUnique({ where: { id: dealerId }, select: { status: true } })) as { status: string } | null;
  if (dealer?.status !== "PENDING") throw new ApiError(409, "This dealer is no longer editable");
  const data = dealerFieldsSchema.parse(raw);
  await prisma.dealer.update({ where: { id: dealerId }, data: dealerData(data) });
  return { dealerId };
}

/* ------------------------------- Workflow --------------------------------- */

export async function submitMonthlyPlan(ctx: AuthContext, monthlyPlanId: string) {
  // Status, completion and the status change are decided on the LOCKED monthly plan: a save still running finishes first (its values count), a later
  // save is refused, and a second Submit waits and then gets the already-submitted answer — exactly one submission.
  const { mp, nextStatus, managerId } = await prisma.$transaction(async (tx) => {
    const mp = await lockMonthlyPlan(tx, monthlyPlanId);
    assertMonthlyWritable(mp, ctx, "This monthly plan cannot be submitted in its current state", true);

    // Dealer completion gate — mirrors the Seasonal submit gate: every dealer in the monthly view must be Completed (≥1 monthly plan value entered)
    // or explicitly marked "No Plan". Use the SAME eligibility rule as the monthly view/draft (getMonthlyPlan): only dealers that are currently
    // plannable (Active, non-Defaulter) must be accounted for — a deactivated dealer that still has a historical PlanDealer row must not block
    // submission. One aggregate over the stored entries (value modes count planValue, quantity modes planQty — the read's own rule).
    const gate = await tx.$queryRaw<{ dealerName: string; noPlan: boolean; completed: boolean }[]>(Prisma.sql`
      SELECT dl."name" AS "dealerName",
             EXISTS (SELECT 1 FROM "MonthlyPlanDealer" n WHERE n."monthlyPlanId" = ${mp.id} AND n."dealerId" = d."dealerId" AND n."noPlan" = true) AS "noPlan",
             COALESCE(BOOL_OR(CASE WHEN ${!isQuantityMode(mp.monthlyMode as PlanningMode)} THEN e."planValue" > 0 ELSE e."planQty" > 0 END), false) AS "completed"
      FROM "PlanDealer" d
      JOIN "Dealer" dl ON dl."id" = d."dealerId"
      LEFT JOIN "PlanLine" l ON l."planDealerId" = d."id"
      LEFT JOIN "MonthlyEntry" e ON e."planLineId" = l."id" AND e."seasonMonthId" = ${mp.seasonMonthId}
      WHERE d."seasonPlanId" = ${mp.seasonPlanId} AND dl."isActive" = true AND dl."status" <> 'DEFAULTER'
      GROUP BY d."id", d."dealerId", dl."name"
      ORDER BY dl."name"`);
    const remaining = gate.filter((d) => !d.noPlan && !d.completed);
    if (remaining.length > 0) {
      throw new ApiError(
        422,
        `Every dealer must be planned or marked "No Plan". Not yet accounted for: ${remaining.map((r) => r.dealerName).join(", ")}`,
      );
    }

    const managerId = await getCurrentManagerId(mp.officerId, tx);
    const nextStatus = managerId ? PlanStatus.PENDING_RM : PlanStatus.PENDING_ADMIN;
    await tx.monthlyPlan.update({ where: { id: mp.id }, data: { status: nextStatus, submittedAt: new Date() } });
    // The approval history entry commits together with the status change.
    await tx.approvalAction.create({ data: { seasonPlanId: mp.seasonPlanId, monthlyPlanId: mp.id, actorId: ctx.userId, ...(ctx.designation ? { actorDesignation: ctx.designation } : {}), action: ApprovalActionType.SUBMIT, fromStatus: mp.status, toStatus: nextStatus } });
    return { mp, nextStatus, managerId };
  }, MONTHLY_WRITE_TRANSACTION);

  // Notifications are sent after the commit (as before, a notification failure must not undo a recorded submission).
  const label = await monthlyLabel(await loadMonthlyPlanOr404(mp.id));
  if (nextStatus === PlanStatus.PENDING_RM && managerId) {
    await createNotification({
      userId: managerId,
      type: NotificationType.PLAN_SUBMITTED,
      title: "Monthly plan submitted for approval",
      message: `${label} is awaiting your approval.`,
      relatedEntityType: "MonthlyPlan",
      relatedEntityId: mp.id,
    });
  } else {
    await notifyMany(await getSuperAdminIds(), {
      type: NotificationType.PLAN_SUBMITTED,
      title: "Monthly plan submitted for approval",
      message: `${label} is awaiting Super Admin approval.`,
      relatedEntityType: "MonthlyPlan",
      relatedEntityId: mp.id,
    });
  }
  return { status: nextStatus };
}

export async function recallMonthlyPlan(ctx: AuthContext, monthlyPlanId: string) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  if (!(isPlanOwner(ctx, mp.officerId))) {
    throw new ApiError(403, "Only the owning Sales Officer can recall this monthly plan");
  }
  if (!PENDING.includes(mp.status)) throw new ApiError(409, "Only a submitted monthly plan can be recalled");
  assertMonthlyLive(mp);
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.DRAFT } });
  await recordMonthlyAction(mp, ctx, ApprovalActionType.RECALL, mp.status, PlanStatus.DRAFT);
  return { status: PlanStatus.DRAFT };
}

async function assertMonthlyApprover(ctx: AuthContext, mp: MonthlyPlanRow) {
  if (mp.status === PlanStatus.PENDING_RM) {
    // Super Admin override: may act on a submitted monthly plan directly, without waiting for the RM.
    if (isAdministrativeRole(ctx.role)) return;
    const managerId = await getCurrentManagerId(mp.officerId);
    if (ctx.userId !== managerId) throw new ApiError(403, "Only the assigned Regional Manager can act on this monthly plan");
  } else if (mp.status === PlanStatus.PENDING_ADMIN) {
    if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only the Super Admin can act on this monthly plan");
  } else {
    throw new ApiError(409, "This monthly plan is not awaiting approval");
  }
}

export async function approveMonthlyPlan(ctx: AuthContext, monthlyPlanId: string) {
  assertAdminPermission(ctx, "salesPlanning", "approve");
  assertAdminPermission(ctx, "approvals", "approve");
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertMonthlyApprover(ctx, mp);
  assertMonthlyLive(mp);

  // RM approving a Pending-RM monthly plan advances it to Pending Super Admin (RM workflow UNCHANGED).
  if (mp.status === PlanStatus.PENDING_RM && !isAdministrativeRole(ctx.role)) {
    await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.PENDING_ADMIN } });
    await recordMonthlyAction(mp, ctx, ApprovalActionType.APPROVE, PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN);
    await notifyMany(await getSuperAdminIds(), {
      type: NotificationType.PLAN_SUBMITTED,
      title: "Monthly plan awaiting Super Admin approval",
      message: `${await monthlyLabel(mp)} was approved by the Regional Manager and awaits final approval.`,
      relatedEntityType: "MonthlyPlan",
      relatedEntityId: mp.id,
    });
    return { status: PlanStatus.PENDING_ADMIN };
  }

  // Super Admin FINAL approval — from Pending Super Admin (normal) OR directly from Pending RM (override,
  // RM step skipped). fromStatus reflects the true prior state for a truthful audit trail.
  const overrodeRm = mp.status === PlanStatus.PENDING_RM;
  const fromStatus = mp.status;
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.APPROVED, approvedAt: new Date() } });
  await recordMonthlyAction(mp, ctx, ApprovalActionType.APPROVE, fromStatus, PlanStatus.APPROVED, overrodeRm ? "Super Admin override approval (approved directly from Pending RM; RM approval skipped)" : undefined);

  // NOTE: Dealer approval is fully DECOUPLED from plan approval. Approving a monthly plan must never
  // change a dealer's status — SO-created dealers stay PENDING until an admin activates them from the
  // Dealer Alias → Edit dialog. (Previously this block flipped them to ACTIVE + assigned + aliased; that
  // coupling has been removed intentionally.)

  await createNotification({
    userId: mp.officerId,
    type: NotificationType.PLAN_APPROVED,
    title: "Monthly plan approved",
    message: `${await monthlyLabel(mp)} has been approved.`,
    relatedEntityType: "MonthlyPlan",
    relatedEntityId: mp.id,
  });
  return { status: PlanStatus.APPROVED };
}

export async function returnMonthlyPlan(ctx: AuthContext, monthlyPlanId: string, remarks: string) {
  assertAdminPermission(ctx, "salesPlanning", "return");
  assertAdminPermission(ctx, "approvals", "return");
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertMonthlyApprover(ctx, mp);
  assertMonthlyLive(mp);
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.RETURNED } });
  await recordMonthlyAction(mp, ctx, ApprovalActionType.RETURN, mp.status, PlanStatus.RETURNED, remarks);
  await createNotification({
    userId: mp.officerId,
    type: NotificationType.PLAN_RETURNED,
    title: "Monthly plan returned",
    message: `${await monthlyLabel(mp)} was returned: "${remarks}"`,
    relatedEntityType: "MonthlyPlan",
    relatedEntityId: mp.id,
  });
  return { status: PlanStatus.RETURNED };
}

export async function rejectMonthlyPlan(ctx: AuthContext, monthlyPlanId: string, remarks: string) {
  assertAdminPermission(ctx, "salesPlanning", "reject");
  assertAdminPermission(ctx, "approvals", "reject");
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertMonthlyApprover(ctx, mp);
  assertMonthlyLive(mp);
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.REJECTED } });
  await recordMonthlyAction(mp, ctx, ApprovalActionType.REJECT, mp.status, PlanStatus.REJECTED, remarks);

  // Dealer status is DECOUPLED from plan workflow: rejecting a monthly plan no longer changes the
  // status of dealers created in it. They remain PENDING for an admin to triage (activate, mark
  // Inactive, or Defaulter) from the Dealer Alias → Edit dialog — an independent admin action.
  await createNotification({
    userId: mp.officerId,
    type: NotificationType.PLAN_RETURNED,
    title: "Monthly plan rejected",
    message: `${await monthlyLabel(mp)} was rejected: "${remarks}"`,
    relatedEntityType: "MonthlyPlan",
    relatedEntityId: mp.id,
  });
  return { status: PlanStatus.REJECTED };
}

export async function getMonthlyPlanHistory(ctx: AuthContext, monthlyPlanId: string) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertOfficerInScope(ctx, mp.officerId);
  const actions = await prisma.approvalAction.findMany({
    where: { monthlyPlanId },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return {
    timeline: actions.map((a) => ({
      id: a.id,
      actorName: actorDisplayName(a.actor.name, a.actorDesignation),
      action: a.action,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      remarks: a.remarks,
      createdAt: a.createdAt,
    })),
  };
}
