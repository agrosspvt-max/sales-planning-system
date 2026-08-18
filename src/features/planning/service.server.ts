import "server-only";
import { PlanStatus, ApprovalActionType, Role, SeasonStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import {
  assertOfficerInScope,
  getCurrentDealerIds,
  getCurrentManagerId,
  getOfficerScope,
  isPlanOwner,
} from "@/lib/scope";
import { planningProductsForOfficer, clearanceMapForGroup } from "@/features/users/catalogue.server";
import { saveLinesSchema, remarksSchema, revisionRequestSchema } from "@/lib/validations/planning";
import { NotificationType } from "@prisma/client";
import { findOrCreateSeason } from "@/features/seasons/service.server";
import { writeAudit } from "@/lib/audit";
import {
  createNotification,
  notifyMany,
  getSuperAdminIds,
} from "@/features/notifications/service.server";
import { assembleWorkbookLine, type PlanningMode, type WorkbookLine } from "@/lib/calc";
import { assertLifecycleEditable, officerVisibilityWhere, isHiddenFromOfficer } from "./lifecycle.server";

const EDITABLE: PlanStatus[] = [PlanStatus.DRAFT, PlanStatus.RETURNED, PlanStatus.REJECTED];
const PENDING: PlanStatus[] = [PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN];

/** A short human label for a plan, used in notification messages. */
async function planLabel(plan: { officerId: string; seasonId: string }): Promise<string> {
  const [officer, season] = await Promise.all([
    prisma.user.findUnique({ where: { id: plan.officerId }, select: { name: true } }),
    prisma.season.findUnique({ where: { id: plan.seasonId }, select: { name: true, year: true } }),
  ]);
  return `${officer?.name ?? "Officer"} — ${season?.name ?? ""} ${season?.year ?? ""}`.trim();
}

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

async function loadPlanOr404(planId: string) {
  const plan = await prisma.seasonPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new ApiError(404, "Plan not found");
  return plan;
}

async function assertSeasonOpen(seasonId: string) {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) throw new ApiError(404, "Season not found");
  if (season.status !== SeasonStatus.OPEN) {
    throw new ApiError(422, "The season is closed; plans cannot be created or edited"); // V5
  }
}

/**
 * The Dealer Planning columns = the canonical PLANNING pack sizes only (isPlanning), in
 * displayOrder (the workbook order — never sorted alphabetically). Non-planning pack sizes
 * that exist in the master (e.g. price-import sizes like "1 KG") are intentionally excluded
 * so the grid is an exact digital copy of the Excel workbook.
 */
function getPlanningPackSizes() {
  return prisma.packSize.findMany({
    where: { isActive: true, isPlanning: true },
    orderBy: { displayOrder: "asc" },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/**
 * The ONE approval finalisation used everywhere a plan becomes APPROVED/active: supersede the
 * prior active version of the SAME planning type and activate this one. Planning figures always
 * read the current Product Master rate/NBV%, so stored line snapshots are not refreshed or read.
 */
async function finalizeApproval(
  tx: Tx,
  plan: { id: string; seasonId: string; officerId: string; planningType: string },
) {
  await tx.seasonPlan.updateMany({
    where: {
      seasonId: plan.seasonId,
      officerId: plan.officerId,
      planningType: plan.planningType,
      isActiveVersion: true,
      id: { not: plan.id },
    },
    data: { isActiveVersion: false },
  });
  await tx.seasonPlan.update({
    where: { id: plan.id },
    data: {
      status: PlanStatus.APPROVED,
      isActiveVersion: true,
      approvedAt: new Date(),
      revisionRequested: false,
      revisionReason: null,
    },
  });
}

/** Exported for reuse by the import service (Import as Approved). */
export async function finalizeApprovalTx(
  tx: Tx,
  plan: { id: string; seasonId: string; officerId: string; planningType: string },
) {
  return finalizeApproval(tx, plan);
}

async function recordAction(
  seasonPlanId: string,
  actorId: string,
  action: ApprovalActionType,
  fromStatus: PlanStatus | null,
  toStatus: PlanStatus | null,
  remarks?: string,
) {
  await prisma.approvalAction.create({
    data: { seasonPlanId, actorId, action, fromStatus, toStatus, remarks },
  });
}

/* -------------------------- Create / resume draft ------------------------- */

export interface CreateSalesPlanInput {
  seasonId: string;
  planningType?: string; // SEASONAL | MONTHLY | YEARLY (default SEASONAL)
  officerId?: string; // Super Admin only; officers plan for themselves
  versionName?: string;
  description?: string;
}

/**
 * Create (or resume) a Sales Plan for a season, planning type and officer. A Sales
 * Officer always plans for themselves; a Super Admin may create on behalf of an
 * officer. All planning types share the same structure and calculation engine — the
 * type only categorises the plan (Section 39). Yearly = a single total target, no
 * month breakdown.
 */
export async function createSalesPlan(ctx: AuthContext, input: CreateSalesPlanInput): Promise<string> {
  const planningType = input.planningType ?? "SEASONAL";

  let officerId: string;
  if (ctx.role === Role.SALES_OFFICER) {
    officerId = ctx.userId;
  } else if (ctx.role === Role.REGIONAL_MANAGER) {
    // An RM creates plans only for THEMSELVES (My Plans) — same self-owned flow as a Sales Officer.
    officerId = ctx.userId;
  } else if (ctx.role === Role.SUPER_ADMIN) {
    if (!input.officerId) throw new ApiError(422, "Select a Sales Officer for this plan");
    officerId = input.officerId;
  } else {
    throw new ApiError(403, "You are not allowed to create a plan");
  }

  const officer = await prisma.user.findUnique({ where: { id: officerId } });
  // The owner must be an active Sales Officer, OR the Regional Manager creating their own plan.
  const ownerOk = officer && officer.isActive &&
    (officer.role === Role.SALES_OFFICER || (officer.role === Role.REGIONAL_MANAGER && officer.id === ctx.userId));
  if (!ownerOk) {
    throw new ApiError(422, "The selected plan owner is missing or inactive");
  }

  const existing = await prisma.seasonPlan.findMany({
    where: { seasonId: input.seasonId, officerId, planningType },
    orderBy: { version: "desc" },
  });
  // Only ACTIVE plans block creation / are reopened. Archived (deactivated) or frozen (closed)
  // versions are ignored here, so after a Replace/Deactivate the admin can create a fresh plan.
  const isActiveLifecycle = (p: { lifecycleState?: string | null }) => (p.lifecycleState ?? "ACTIVE") === "ACTIVE";
  const editable = existing.find((p) => EDITABLE.includes(p.status) && isActiveLifecycle(p));
  if (editable) return editable.id;
  const pending = existing.find((p) => PENDING.includes(p.status) && isActiveLifecycle(p));
  if (pending) return pending.id;
  const approved = existing.find((p) => p.status === PlanStatus.APPROVED && p.isActiveVersion && isActiveLifecycle(p));
  if (approved) return approved.id; // read-only; revision required to change
  // A fresh plan takes the next version number so it never collides with an archived version.
  const nextVersion = (existing[0]?.version ?? 0) + 1;

  await assertSeasonOpen(input.seasonId);
  const dealerIds = await getCurrentDealerIds(officerId); // V4 — assigned dealers
  const [activeDealers, products, packSizes] = await Promise.all([
    // Defaulters are blocked from planning — never seed them into a new seasonal plan.
    prisma.dealer.findMany({ where: { id: { in: dealerIds }, isActive: true, status: { not: "DEFAULTER" } }, orderBy: { name: "asc" } }),
    // Products come from the officer's GROUP catalogue (active, at the group price); Master fallback when
    // the group has no catalogue. The group price is SNAPSHOTTED onto each line so the plan is price-stable.
    planningProductsForOfficer(officerId),
    getPlanningPackSizes(),
  ]);

  const plan = await prisma.seasonPlan.create({
    data: {
      seasonId: input.seasonId,
      officerId,
      planningType,
      version: nextVersion,
      versionName: input.versionName?.trim() || null,
      description: input.description?.trim() || null,
      status: PlanStatus.DRAFT,
      dealers: {
        create: activeDealers.map((d) => ({
          dealerId: d.id,
          lines: {
            create: products.map((p) => ({
              productId: p.productId,
              rateSnapshot: p.rate,
              nbvPercentSnapshot: p.nbvPercent,
              packs: { create: packSizes.map((ps) => ({ packSizeId: ps.id })) },
            })),
          },
        })),
      },
    },
  });
  return plan.id;
}

/** Backward-compatible helper: an officer opens/resumes their seasonal plan. */
export async function getOrCreateOfficerPlan(ctx: AuthContext, seasonId: string): Promise<string> {
  return createSalesPlan(ctx, { seasonId, planningType: "SEASONAL" });
}

/**
 * Dealer completion — mark a dealer intentionally skipped ("No Plan") with an optional
 * reason, or clear it. Owner officer (editable plan) or Super Admin only. No new calculation:
 * "Completed"/"Remaining" stay derived from the stored quantities.
 */
export async function setDealerNoPlan(
  ctx: AuthContext,
  planId: string,
  dealerId: string,
  noPlan: boolean,
  reason?: string,
): Promise<{ noPlan: boolean; noPlanReason: string | null }> {
  const plan = await loadPlanOr404(planId);
  const isOwner = isPlanOwner(ctx, plan.officerId);
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) throw new ApiError(403, "You cannot change this plan");
  if (!EDITABLE.includes(plan.status)) throw new ApiError(409, "This plan is not editable");
  assertLifecycleEditable(plan.lifecycleState);

  const pd = await prisma.planDealer.findUnique({
    where: { seasonPlanId_dealerId: { seasonPlanId: planId, dealerId } },
    select: { id: true },
  });
  if (!pd) throw new ApiError(404, "Dealer is not part of this plan");

  const noPlanReason = noPlan ? reason?.trim() || null : null;
  await prisma.planDealer.update({ where: { id: pd.id }, data: { noPlan, noPlanReason } });
  return { noPlan, noPlanReason };
}

export interface CreateSeasonalPlansInput {
  season: { name: string; year: number; startMonth: number; endMonth: number };
  officerScope?: "single" | "multiple" | "all";
  officerIds?: string[];
}

/**
 * Simplified Seasonal create (Phase 3). Resolves the Season from name+year+period via the
 * single authoritative findOrCreateSeason, then creates (or reopens) ONE Seasonal draft per
 * targeted officer through the existing createSalesPlan — which already dedupes/reopens, so
 * the "one plan per season+year" rule needs no new logic. Admin may target one, several, or
 * all active Sales Officers; an officer plans only for themselves.
 */
export async function createSeasonalPlans(
  ctx: AuthContext,
  input: CreateSeasonalPlansInput,
): Promise<{ ids: string[] }> {
  const { id: seasonId } = await findOrCreateSeason({
    name: input.season.name,
    startMonth: input.season.startMonth,
    startYear: input.season.year,
    endMonth: input.season.endMonth,
    endYear: input.season.year,
  });

  let officerIds: string[];
  if (ctx.role === Role.SALES_OFFICER || ctx.role === Role.REGIONAL_MANAGER) {
    // Sales Officer and Regional Manager both create only their OWN plan (My Plans).
    officerIds = [ctx.userId];
  } else if (ctx.role === Role.SUPER_ADMIN) {
    if (input.officerScope === "all") {
      const officers = await prisma.user.findMany({
        where: { role: Role.SALES_OFFICER, isActive: true },
        select: { id: true },
      });
      officerIds = officers.map((o) => o.id);
    } else {
      officerIds = input.officerIds ?? [];
    }
    if (officerIds.length === 0) throw new ApiError(422, "Select at least one Sales Officer");
  } else {
    throw new ApiError(403, "Only a Sales Officer or Super Admin can create a plan");
  }

  const ids: string[] = [];
  for (const officerId of officerIds) {
    // Admin creates on behalf of the officer; an officer's own id is taken from ctx.
    ids.push(
      await createSalesPlan(ctx, {
        seasonId,
        planningType: "SEASONAL",
        officerId: ctx.role === Role.SUPER_ADMIN ? officerId : undefined,
      }),
    );
  }
  return { ids };
}

/* -------------------------------- Detail ---------------------------------- */

export async function getPlanDetail(ctx: AuthContext, planId: string) {
  const [plan, planningPacks] = await Promise.all([
    prisma.seasonPlan.findUnique({
      where: { id: planId },
      include: {
        season: { select: { name: true, year: true, status: true, seasonalMode: true } },
        officer: { select: { name: true, groupId: true } },
        // Exclude monthly-only additions (fromMonthlyPlan), deactivated/deleted dealers
        // (isActive=false) and Defaulters (blocked from planning) so the seasonal view shows
        // only plan-eligible seasonal dealers. Existing PlanDealer rows are preserved on disk.
        dealers: {
          where: { fromMonthlyPlan: false, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
          include: {
            dealer: { select: { name: true, isActive: true } },
            lines: {
              where: { isAdditional: false },
              include: {
                product: {
                  select: {
                    name: true,
                    technicalName: true,
                    rate: true,
                    nbvPercent: true,
                    isActive: true,
                  },
                },
                packs: true,
                monthlyEntries: { select: { planQty: true, saleQty: true, saleValue: true } },
              },
            },
          },
        },
      },
    }),
    getPlanningPackSizes(),
  ]);
  if (!plan) throw new ApiError(404, "Plan not found");
  // A deactivated plan is invisible to the Sales Officer (Admin/RM can still open it).
  if (isHiddenFromOfficer(ctx, (plan as { lifecycleState?: string }).lifecycleState)) throw new ApiError(404, "Plan not found");
  await assertOfficerInScope(ctx, plan.officerId);
  // Clearance flags (group-specific, by the plan officer's group + productId) — display-only tag.
  const clearance = await clearanceMapForGroup((plan.officer as { groupId: string | null }).groupId);

  // Grid columns = canonical PLANNING packs UNION every pack that already holds a stored
  // quantity in THIS plan. `isPlanning` governs which columns NEW plans get, but it must
  // never hide (or, on save, erase) historical data — so any pack with qty > 0 here is
  // shown even if it is no longer a planning pack. Empty non-planning packs stay hidden.
  const usedPackIds = new Set<string>();
  for (const pd of plan.dealers)
    for (const l of pd.lines)
      for (const pk of l.packs) if (pk.quantity > 0) usedPackIds.add(pk.packSizeId);
  const planningIds = new Set(planningPacks.map((p) => p.id));
  const extraIds = [...usedPackIds].filter((id) => !planningIds.has(id));
  const extraPacks = extraIds.length
    ? ((await prisma.packSize.findMany({
        where: { id: { in: extraIds } },
        select: { id: true, name: true, displayOrder: true },
      })) as { id: string; name: string; displayOrder: number }[])
    : [];
  const columnPacks = [...planningPacks, ...extraPacks].sort((a, b) => a.displayOrder - b.displayOrder);

  const isOwner = isPlanOwner(ctx, plan.officerId);
  const canEdit = isOwner && EDITABLE.includes(plan.status) && plan.season.status === SeasonStatus.OPEN;
  // Admin Override: a Super Admin may correct the APPROVED, active version (read-only flag only).
  const canAdminEdit =
    ctx.role === Role.SUPER_ADMIN &&
    plan.status === PlanStatus.APPROVED &&
    plan.isActiveVersion &&
    ((plan as { lifecycleState?: string }).lifecycleState ?? "ACTIVE") === "ACTIVE";

  return {
    id: plan.id,
    seasonId: plan.seasonId,
    seasonName: `${plan.season.name} ${plan.season.year}`,
    seasonOpen: plan.season.status === SeasonStatus.OPEN,
    officerId: plan.officerId,
    officerName: plan.officer.name,
    planningType: plan.planningType,
    versionName: plan.versionName,
    description: plan.description,
    source: plan.source,
    version: plan.version,
    status: plan.status,
    isActiveVersion: plan.isActiveVersion,
    revisionRequested: plan.revisionRequested,
    revisionReason: plan.revisionReason,
    lastSavedAt: plan.lastSavedAt,
    canEdit,
    canAdminEdit,
    // Planning mode saved on THIS season (never the current global default) — Section 38.
    seasonalMode: plan.season.seasonalMode as PlanningMode,
    // Columns: canonical planning packs + any pack with stored data in this plan (workbook order).
    packSizes: columnPacks.map((ps) => ({ id: ps.id, name: ps.name })),
    dealers: plan.dealers
      .sort((a, b) => a.dealer.name.localeCompare(b.dealer.name))
      .map((pd) => ({
        planDealerId: pd.id,
        dealerId: pd.dealerId,
        dealerName: pd.dealer.name,
        dealerActive: pd.dealer.isActive,
        noPlan: pd.noPlan,
        noPlanReason: pd.noPlanReason,
        lines: pd.lines
          .sort((a, b) => a.product.name.localeCompare(b.product.name))
          .map((l) => ({
            planLineId: l.id,
            productId: l.productId,
            productName: l.product.name,
            technicalName: l.product.technicalName,
            productActive: l.product.isActive,
            isClearance: clearance.has(l.productId),
            clearanceQty: clearance.get(l.productId)?.clearanceQty ?? null,
            // Auto-added by Sales Upload (unplanned sold product) — drives the "Auto Added" badge.
            isAutoAdded: (l as { isAutoAdded?: boolean }).isAutoAdded ?? false,
            // Planning pricing is the price FROZEN on the line (rateSnapshot), set from the Group
            // Catalogue at creation; falls back to the live Master price for legacy/unset lines.
            rate: num((l as { rateSnapshot?: unknown }).rateSnapshot ?? l.product.rate),
            nbvPercent: num((l as { nbvPercentSnapshot?: unknown }).nbvPercentSnapshot ?? l.product.nbvPercent),
            // Planning Configuration: how this line was stored (null => PACK_SIZE).
            inputMode: (l.inputMode as PlanningMode | null) ?? null,
            inputValue: l.inputValue !== null ? num(l.inputValue) : null,
            // All stored pack quantities (totals sum every row, incl. deactivated packs).
            packs: Object.fromEntries(l.packs.map((pk) => [pk.packSizeId, pk.quantity])),
            // Read-only roll-ups for the workbook columns (Actual / Live Monthly).
            liveMonthlyQty: l.monthlyEntries.reduce(
              (s: number, e: { planQty: number }) => s + e.planQty,
              0,
            ),
            actualQty: l.monthlyEntries.reduce(
              (s: number, e: { saleQty: number }) => s + e.saleQty,
              0,
            ),
            // Actual SALES VALUE is only the uploaded Sales-file value. Never price actuals
            // from the Master Price List.
            actualAmount: l.monthlyEntries.reduce((s: number, e: { saleQty: number; saleValue: unknown }) => {
              void e.saleQty;
              return s + num(e.saleValue ?? 0);
            }, 0),
          })),
      })),
  };
}

/* ------------------------------ Workbook View ----------------------------- */

/**
 * Read-only "digital Excel workbook" for one plan, one dealer at a time. Pure
 * presentation: it only assembles Seasonal + Monthly + Actuals through the shared
 * calc engine (assembleWorkbookLine) — no business logic of its own.
 */
export async function getWorkbook(ctx: AuthContext, planId: string, dealerId?: string) {
  const plan = await prisma.seasonPlan.findUnique({
    where: { id: planId },
    include: {
      season: { select: { name: true, year: true, seasonalMode: true } },
      officer: { select: { name: true } },
      dealers: {
        include: {
          dealer: { select: { name: true } },
          lines: {
            include: {
              product: { select: { name: true, rate: true, nbvPercent: true } },
              packs: { select: { quantity: true } },
              monthlyEntries: { select: { seasonMonthId: true, planQty: true, saleQty: true, saleValue: true } },
            },
          },
        },
      },
    },
  });
  if (!plan) throw new ApiError(404, "Plan not found");
  await assertOfficerInScope(ctx, plan.officerId);

  const months = await prisma.seasonMonth.findMany({
    where: { seasonId: plan.seasonId },
    orderBy: { order: "asc" },
    select: { id: true, name: true, order: true },
  });

  const dealerList = plan.dealers
    .map((pd) => ({ dealerId: pd.dealerId, dealerName: pd.dealer.name }))
    .sort((a, b) => a.dealerName.localeCompare(b.dealerName));
  const selectedDealerId = dealerId && dealerList.some((d) => d.dealerId === dealerId)
    ? dealerId
    : dealerList[0]?.dealerId ?? "";

  const pd = plan.dealers.find((d) => d.dealerId === selectedDealerId);
  const rows = (pd?.lines ?? [])
    .map((l) => {
      // Snapshot-first (frozen at creation) with live-Master fallback.
      const rate = num((l as { rateSnapshot?: unknown }).rateSnapshot ?? l.product.rate);
      const nbvPct = num((l as { nbvPercentSnapshot?: unknown }).nbvPercentSnapshot ?? l.product.nbvPercent);
      const lineMode = (l.inputMode as PlanningMode | null) ?? "PACK_SIZE";
      const seasonalInput =
        lineMode === "PACK_SIZE"
          ? l.packs.reduce((s, pk) => s + pk.quantity, 0)
          : l.inputValue !== null
            ? num(l.inputValue)
            : 0;
      const byMonth = new Map<string, { planQty: number; saleQty: number; saleValue: unknown }>(
        l.monthlyEntries.map((e: { seasonMonthId: string; planQty: number; saleQty: number; saleValue: unknown }) => [
          e.seasonMonthId,
          e,
        ]),
      );
      const planQ = months.map((m: { id: string }) => byMonth.get(m.id)?.planQty ?? 0);
      const saleQ = months.map((m: { id: string }) => byMonth.get(m.id)?.saleQty ?? 0);
      const saleAmounts = months.map((m: { id: string }) => num(byMonth.get(m.id)?.saleValue ?? 0));
      const line: WorkbookLine = assembleWorkbookLine(lineMode, seasonalInput, planQ, saleQ, saleAmounts, rate, nbvPct);
      return { productId: l.productId, productName: l.product.name, line };
    })
    .filter((r) => (r.line.targetQty ?? 0) > 0 || r.line.actualQty > 0 || r.line.liveMonthlyQty > 0)
    .sort((a, b) => a.productName.localeCompare(b.productName));

  // Progress summary = simple sums of the per-line workbook figures (no new math).
  const progress = rows.reduce(
    (acc, r) => {
      acc.targetQty += r.line.targetQty ?? 0;
      acc.monthlyPlannedQty += r.line.liveMonthlyQty;
      acc.actualQty += r.line.actualQty;
      acc.planAmount += r.line.planAmount ?? 0;
      acc.actualAmount += r.line.actualAmount;
      return acc;
    },
    { targetQty: 0, monthlyPlannedQty: 0, actualQty: 0, planAmount: 0, actualAmount: 0 },
  );

  return {
    planId: plan.id,
    seasonName: `${plan.season.name} ${plan.season.year}`,
    officerName: plan.officer.name,
    planningType: plan.planningType,
    seasonalMode: plan.season.seasonalMode as PlanningMode,
    months,
    dealers: dealerList,
    selectedDealerId,
    rows,
    progress: {
      ...progress,
      pendingQty: progress.targetQty - progress.actualQty,
      remainingAllocation: progress.targetQty - progress.monthlyPlannedQty,
      achievement: progress.targetQty > 0 ? progress.actualQty / progress.targetQty : 0,
    },
  };
}

/* ----------------------------- Save (autosave) ---------------------------- */

export async function saveLines(ctx: AuthContext, planId: string, raw: unknown) {
  const { lines } = saveLinesSchema.parse(raw);
  const plan = await loadPlanOr404(planId);

  if (!(isPlanOwner(ctx, plan.officerId))) {
    throw new ApiError(403, "Only the owning Sales Officer can edit this plan"); // V11
  }
  if (!EDITABLE.includes(plan.status)) {
    throw new ApiError(409, "This plan is submitted or approved and cannot be edited"); // V12/V13
  }
  assertLifecycleEditable(plan.lifecycleState);
  await assertSeasonOpen(plan.seasonId); // V5

  // Map (dealerId, productId) → planLineId for this plan.
  const planLines = await prisma.planLine.findMany({
    where: { planDealer: { seasonPlanId: planId } },
    select: { id: true, productId: true, planDealer: { select: { dealerId: true } } },
  });
  const lineKey = (dealerId: string, productId: string) => `${dealerId}|${productId}`;
  const lineMap = new Map(planLines.map((l) => [lineKey(l.planDealer.dealerId, l.productId), l.id]));

  await prisma.$transaction(async (tx) => {
    for (const line of lines) {
      const planLineId = lineMap.get(lineKey(line.dealerId, line.productId));
      if (!planLineId) continue; // not part of this plan — ignore

      const mode = line.mode ?? "PACK_SIZE";
      if (mode === "PACK_SIZE") {
        // Legacy/default: per-pack quantities are the source of truth for this line.
        for (const pack of line.packs) {
          await tx.planLinePack.upsert({
            where: { planLineId_packSizeId: { planLineId, packSizeId: pack.packSizeId } },
            create: { planLineId, packSizeId: pack.packSizeId, quantity: pack.quantity },
            update: { quantity: pack.quantity },
          });
        }
        await tx.planLine.update({
          where: { id: planLineId },
          data: { inputMode: null, inputValue: null },
        });
      } else {
        // Non-pack mode: store the single entered value; quantities in TOTAL_QUANTITY
        // are whole numbers, amount/NBV keep decimals. Packs are left untouched but
        // ignored while inputMode is set.
        const raw = line.value ?? 0;
        const value = mode === "TOTAL_QUANTITY" ? Math.max(0, Math.floor(raw)) : raw;
        await tx.planLine.update({
          where: { id: planLineId },
          data: { inputMode: mode, inputValue: value },
        });
      }
    }
    await tx.seasonPlan.update({ where: { id: planId }, data: { lastSavedAt: new Date() } });
  });

  const saved = await prisma.seasonPlan.findUnique({
    where: { id: planId },
    select: { lastSavedAt: true },
  });
  return { lastSavedAt: saved!.lastSavedAt };
}

/* ------------------------------ Submit / recall --------------------------- */

export async function submitPlan(ctx: AuthContext, planId: string) {
  const plan = await loadPlanOr404(planId);
  if (!(isPlanOwner(ctx, plan.officerId))) {
    throw new ApiError(403, "Only the owning Sales Officer can submit this plan");
  }
  if (!EDITABLE.includes(plan.status)) {
    throw new ApiError(409, "This plan cannot be submitted in its current state");
  }
  assertLifecycleEditable(plan.lifecycleState);
  await assertSeasonOpen(plan.seasonId); // V5

  // V31 — every dealer in the plan must currently be assigned to the officer.
  const currentDealers = new Set(await getCurrentDealerIds(plan.officerId));
  const planDealers = await prisma.planDealer.findMany({
    where: { seasonPlanId: planId },
    include: { dealer: { select: { name: true } }, lines: { include: { packs: { select: { quantity: true } } } } },
  });
  const stray = planDealers.filter((pd) => !currentDealers.has(pd.dealerId));
  if (stray.length > 0) {
    throw new ApiError(
      422,
      `These dealers are no longer assigned to you: ${stray.map((s) => s.dealer.name).join(", ")}`,
    );
  }

  // Dealer completion: every dealer must be Completed (≥1 stored quantity) or explicitly
  // marked "No Plan". No "Remaining" dealers may be submitted.
  const remaining = planDealers.filter((pd) => {
    if (pd.noPlan) return false;
    const hasQty = pd.lines.some(
      (l: { inputValue: unknown; packs: { quantity: number }[] }) =>
        (l.inputValue != null && num(l.inputValue) > 0) || l.packs.some((p) => p.quantity > 0),
    );
    return !hasQty;
  });
  if (remaining.length > 0) {
    throw new ApiError(
      422,
      `Every dealer must be planned or marked "No Plan". Not yet accounted for: ${remaining.map((r) => r.dealer.name).join(", ")}`,
    );
  }

  const managerId = await getCurrentManagerId(plan.officerId);
  const nextStatus = managerId ? PlanStatus.PENDING_RM : PlanStatus.PENDING_ADMIN;

  await prisma.seasonPlan.update({
    where: { id: planId },
    data: { status: nextStatus, submittedAt: new Date() },
  });
  await recordAction(planId, ctx.userId, ApprovalActionType.SUBMIT, plan.status, nextStatus);

  const label = await planLabel(plan);
  if (nextStatus === PlanStatus.PENDING_RM && managerId) {
    await createNotification({
      userId: managerId,
      type: NotificationType.PLAN_SUBMITTED,
      title: "Plan submitted for approval",
      message: `${label} is awaiting your approval.`,
      relatedEntityType: "SeasonPlan",
      relatedEntityId: planId,
    });
  } else {
    await notifyMany(await getSuperAdminIds(), {
      type: NotificationType.PLAN_SUBMITTED,
      title: "Plan submitted for approval",
      message: `${label} is awaiting Super Admin approval.`,
      relatedEntityType: "SeasonPlan",
      relatedEntityId: planId,
    });
  }
  return { status: nextStatus };
}

export async function recallPlan(ctx: AuthContext, planId: string) {
  const plan = await loadPlanOr404(planId);
  if (!(isPlanOwner(ctx, plan.officerId))) {
    throw new ApiError(403, "Only the owning Sales Officer can recall this plan");
  }
  if (!PENDING.includes(plan.status)) {
    throw new ApiError(409, "Only a submitted plan can be recalled");
  }
  assertLifecycleEditable(plan.lifecycleState);
  await prisma.seasonPlan.update({ where: { id: planId }, data: { status: PlanStatus.DRAFT } });
  await recordAction(planId, ctx.userId, ApprovalActionType.RECALL, plan.status, PlanStatus.DRAFT);
  return { status: PlanStatus.DRAFT };
}

/* ------------------------------- Approvals -------------------------------- */

async function assertCurrentApprover(ctx: AuthContext, plan: { officerId: string; status: PlanStatus }) {
  if (plan.status === PlanStatus.PENDING_RM) {
    const managerId = await getCurrentManagerId(plan.officerId);
    if (ctx.userId !== managerId) {
      throw new ApiError(403, "Only the assigned Regional Manager can act on this plan"); // V15
    }
  } else if (plan.status === PlanStatus.PENDING_ADMIN) {
    if (ctx.role !== Role.SUPER_ADMIN) {
      throw new ApiError(403, "Only the Super Admin can act on this plan"); // V15
    }
  } else {
    throw new ApiError(409, "This plan is not awaiting approval");
  }
}

export async function approvePlan(ctx: AuthContext, planId: string) {
  const plan = await loadPlanOr404(planId);
  await assertCurrentApprover(ctx, plan);
  assertLifecycleEditable(plan.lifecycleState);

  if (plan.status === PlanStatus.PENDING_RM) {
    await prisma.seasonPlan.update({
      where: { id: planId },
      data: { status: PlanStatus.PENDING_ADMIN },
    });
    await recordAction(
      planId,
      ctx.userId,
      ApprovalActionType.APPROVE,
      PlanStatus.PENDING_RM,
      PlanStatus.PENDING_ADMIN,
    );
    await notifyMany(await getSuperAdminIds(), {
      type: NotificationType.PLAN_SUBMITTED,
      title: "Plan awaiting Super Admin approval",
      message: `${await planLabel(plan)} was approved by the Regional Manager and awaits final approval.`,
      relatedEntityType: "SeasonPlan",
      relatedEntityId: planId,
    });
    return { status: PlanStatus.PENDING_ADMIN };
  }

  // Super Admin final approval → snapshot prices, activate version, supersede prior.
  await prisma.$transaction(async (tx) => {
    await finalizeApproval(tx, plan);
  });
  await recordAction(
    planId,
    ctx.userId,
    ApprovalActionType.APPROVE,
    PlanStatus.PENDING_ADMIN,
    PlanStatus.APPROVED,
  );
  await createNotification({
    userId: plan.officerId,
    type: NotificationType.PLAN_APPROVED,
    title: "Plan approved",
    message: `${await planLabel(plan)} has been approved. Monthly planning is now available.`,
    relatedEntityType: "SeasonPlan",
    relatedEntityId: planId,
  });
  return { status: PlanStatus.APPROVED };
}

export async function returnPlan(ctx: AuthContext, planId: string, raw: unknown) {
  const { remarks } = remarksSchema.parse(raw); // V14
  const plan = await loadPlanOr404(planId);
  await assertCurrentApprover(ctx, plan);
  assertLifecycleEditable(plan.lifecycleState);
  await prisma.seasonPlan.update({ where: { id: planId }, data: { status: PlanStatus.RETURNED } });
  await recordAction(planId, ctx.userId, ApprovalActionType.RETURN, plan.status, PlanStatus.RETURNED, remarks);
  await createNotification({
    userId: plan.officerId,
    type: NotificationType.PLAN_RETURNED,
    title: "Plan returned",
    message: `${await planLabel(plan)} was returned: "${remarks}"`,
    relatedEntityType: "SeasonPlan",
    relatedEntityId: planId,
  });
  return { status: PlanStatus.RETURNED };
}

export async function rejectPlan(ctx: AuthContext, planId: string, raw: unknown) {
  const { remarks } = remarksSchema.parse(raw); // V14
  const plan = await loadPlanOr404(planId);
  await assertCurrentApprover(ctx, plan);
  assertLifecycleEditable(plan.lifecycleState);
  await prisma.seasonPlan.update({ where: { id: planId }, data: { status: PlanStatus.REJECTED } });
  await recordAction(planId, ctx.userId, ApprovalActionType.REJECT, plan.status, PlanStatus.REJECTED, remarks);
  await createNotification({
    userId: plan.officerId,
    type: NotificationType.PLAN_RETURNED,
    title: "Plan rejected",
    message: `${await planLabel(plan)} was rejected: "${remarks}"`,
    relatedEntityType: "SeasonPlan",
    relatedEntityId: planId,
  });
  return { status: PlanStatus.REJECTED };
}

/* ------------------------------- Revisions -------------------------------- */

export async function requestRevision(ctx: AuthContext, planId: string, raw: unknown) {
  const { reason } = revisionRequestSchema.parse(raw);
  const plan = await loadPlanOr404(planId);
  if (!(isPlanOwner(ctx, plan.officerId))) {
    throw new ApiError(403, "Only the owning Sales Officer can request a revision");
  }
  if (!(plan.status === PlanStatus.APPROVED && plan.isActiveVersion)) {
    throw new ApiError(409, "Only the active approved plan can be revised");
  }
  assertLifecycleEditable(plan.lifecycleState);
  await prisma.seasonPlan.update({
    where: { id: planId },
    data: { revisionRequested: true, revisionReason: reason },
  });
  await recordAction(planId, ctx.userId, ApprovalActionType.REQUEST_REVISION, plan.status, plan.status, reason);
  await notifyMany(await getSuperAdminIds(), {
    type: NotificationType.SYSTEM,
    title: "Revision requested",
    message: `${await planLabel(plan)}: revision requested — "${reason}"`,
    relatedEntityType: "SeasonPlan",
    relatedEntityId: planId,
  });
  return { revisionRequested: true };
}

/** Super Admin authorizes: copy the approved version into a new DRAFT version. */
export async function authorizeRevision(ctx: AuthContext, planId: string): Promise<string> {
  if (ctx.role !== Role.SUPER_ADMIN) {
    throw new ApiError(403, "Only the Super Admin can authorize a revision");
  }
  const plan = await prisma.seasonPlan.findUnique({
    where: { id: planId },
    include: { dealers: { include: { lines: { include: { packs: true } } } } },
  });
  if (!plan) throw new ApiError(404, "Plan not found");
  if (!(plan.status === PlanStatus.APPROVED && plan.isActiveVersion)) {
    throw new ApiError(409, "Only the active approved plan can be revised");
  }
  assertLifecycleEditable(plan.lifecycleState);

  const maxVersion = await prisma.seasonPlan.aggregate({
    where: { seasonId: plan.seasonId, officerId: plan.officerId },
    _max: { version: true },
  });
  const nextVersion = (maxVersion._max.version ?? plan.version) + 1;

  const newPlan = await prisma.seasonPlan.create({
    data: {
      seasonId: plan.seasonId,
      officerId: plan.officerId,
      version: nextVersion,
      status: PlanStatus.DRAFT,
      supersedesId: plan.id,
      dealers: {
        create: plan.dealers.map((pd) => ({
          dealerId: pd.dealerId,
          lines: {
            create: pd.lines.map((l) => ({
              productId: l.productId,
              // Snapshots are NOT copied — a new version uses live prices until its own approval.
              // Planning-mode inputs ARE copied so the revision starts from the same figures.
              inputMode: l.inputMode,
              inputValue: l.inputValue,
              packs: {
                create: l.packs.map((pk) => ({ packSizeId: pk.packSizeId, quantity: pk.quantity })),
              },
            })),
          },
        })),
      },
    },
  });

  await prisma.seasonPlan.update({ where: { id: plan.id }, data: { revisionRequested: false } });
  await recordAction(
    plan.id,
    ctx.userId,
    ApprovalActionType.AUTHORIZE_REVISION,
    plan.status,
    plan.status,
    `Revision authorized → version ${nextVersion}`,
  );
  await createNotification({
    userId: plan.officerId,
    type: NotificationType.REVISION_AUTHORIZED,
    title: "Revision authorized",
    message: `${await planLabel(plan)}: version ${nextVersion} is open for editing.`,
    relatedEntityType: "SeasonPlan",
    relatedEntityId: newPlan.id,
  });
  return newPlan.id;
}

/* ------------------------------- History / lists -------------------------- */

export async function getPlanHistory(ctx: AuthContext, planId: string) {
  const plan = await loadPlanOr404(planId);
  await assertOfficerInScope(ctx, plan.officerId);

  const [actions, versions] = await Promise.all([
    prisma.approvalAction.findMany({
      where: { seasonPlanId: planId },
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.seasonPlan.findMany({
      where: { seasonId: plan.seasonId, officerId: plan.officerId },
      orderBy: { version: "asc" },
      select: { id: true, version: true, status: true, isActiveVersion: true, approvedAt: true },
    }),
  ]);

  return {
    versions,
    timeline: actions.map((a) => ({
      id: a.id,
      actorName: a.actor.name,
      action: a.action,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      remarks: a.remarks,
      createdAt: a.createdAt,
    })),
  };
}

export async function listPlans(ctx: AuthContext, seasonId?: string, mine = false) {
  const scope = await getOfficerScope(ctx);
  // "My Plans" narrows to the caller's own plans (used by RMs, who otherwise see the whole group).
  const officerWhere = mine ? ctx.userId : scope.all ? undefined : { in: scope.ids };
  const plans = await prisma.seasonPlan.findMany({
    where: {
      seasonId: seasonId || undefined,
      officerId: officerWhere,
      // Deactivated plans are hidden from the Sales Officer; Admin/RM still see them.
      ...officerVisibilityWhere(ctx),
    },
    include: {
      season: { select: { name: true, year: true, seasonalMode: true } },
      officer: { select: { name: true } },
    },
    orderBy: [{ updatedAt: "desc" }],
  });
  return plans.map((p) => ({
    id: p.id,
    seasonId: p.seasonId,
    seasonName: `${p.season.name} ${p.season.year}`,
    officerId: p.officerId,
    officerName: p.officer.name,
    planningType: p.planningType,
    planningMode: p.season.seasonalMode,
    versionName: p.versionName,
    source: p.source,
    version: p.version,
    status: p.status,
    lifecycleState: (p as { lifecycleState?: string }).lifecycleState ?? "ACTIVE",
    isActiveVersion: p.isActiveVersion,
    lastSavedAt: p.lastSavedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

/* --------------------------- Duplicate / delete --------------------------- */

function canManagePlan(ctx: AuthContext, plan: { officerId: string }): boolean {
  return (
    ctx.role === Role.SUPER_ADMIN ||
    (isPlanOwner(ctx, plan.officerId))
  );
}

/** Delete a DRAFT plan (cascades dealers/lines/packs/monthly/actions). Draft-only, by owner or admin. */
export async function deleteSalesPlan(ctx: AuthContext, planId: string) {
  const plan = await loadPlanOr404(planId);
  if (!canManagePlan(ctx, plan)) {
    throw new ApiError(403, "You cannot delete this plan");
  }
  if (plan.status !== PlanStatus.DRAFT) {
    throw new ApiError(409, "Only draft plans can be deleted");
  }
  await prisma.seasonPlan.delete({ where: { id: planId } });
  await writeAudit({
    userId: ctx.userId,
    action: "DEACTIVATE",
    entity: "seasonPlan",
    entityId: planId,
    summary: `Deleted draft plan (${plan.planningType})`,
  });
  return { deleted: true };
}

/** Duplicate a plan's structure into a new DRAFT version (no snapshots, no monthly entries). */
export async function duplicateSalesPlan(ctx: AuthContext, planId: string): Promise<string> {
  const plan = await prisma.seasonPlan.findUnique({
    where: { id: planId },
    include: { dealers: { include: { lines: { include: { packs: true } } } } },
  });
  if (!plan) throw new ApiError(404, "Plan not found");
  if (!canManagePlan(ctx, plan)) throw new ApiError(403, "You cannot duplicate this plan");

  const maxVersion = await prisma.seasonPlan.aggregate({
    where: { seasonId: plan.seasonId, officerId: plan.officerId, planningType: plan.planningType },
    _max: { version: true },
  });
  const nextVersion = (maxVersion._max.version ?? plan.version) + 1;

  const copy = await prisma.seasonPlan.create({
    data: {
      seasonId: plan.seasonId,
      officerId: plan.officerId,
      planningType: plan.planningType,
      version: nextVersion,
      versionName: plan.versionName ? `Copy of ${plan.versionName}` : "Copy",
      description: plan.description,
      source: plan.source,
      status: PlanStatus.DRAFT,
      dealers: {
        create: plan.dealers.map((pd) => ({
          dealerId: pd.dealerId,
          lines: {
            create: pd.lines.map((l) => ({
              productId: l.productId,
              inputMode: l.inputMode,
              inputValue: l.inputValue,
              packs: { create: l.packs.map((pk) => ({ packSizeId: pk.packSizeId, quantity: pk.quantity })) },
            })),
          },
        })),
      },
    },
  });
  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "seasonPlan",
    entityId: copy.id,
    summary: `Duplicated plan → v${nextVersion} (${plan.planningType})`,
  });
  return copy.id;
}

/** Plans awaiting the current user's action (approvals inbox). */
export async function getApprovalsInbox(ctx: AuthContext) {
  if (ctx.role === Role.SALES_OFFICER) return [];
  const scope = await getOfficerScope(ctx);

  const pending = await prisma.seasonPlan.findMany({
    where:
      ctx.role === Role.SUPER_ADMIN
        ? {
            // Closed/deactivated plans are frozen and never appear in the approval queue.
            lifecycleState: "ACTIVE",
            OR: [
              { status: PlanStatus.PENDING_ADMIN },
              { status: PlanStatus.APPROVED, isActiveVersion: true, revisionRequested: true },
            ],
          }
        : { status: PlanStatus.PENDING_RM, officerId: { in: scope.ids }, lifecycleState: "ACTIVE" },
    include: {
      season: { select: { name: true, year: true } },
      officer: { select: { name: true } },
    },
    orderBy: { submittedAt: "asc" },
  });

  return pending.map((p) => ({
    id: p.id,
    seasonName: `${p.season.name} ${p.season.year}`,
    officerName: p.officer.name,
    version: p.version,
    status: p.status,
    revisionRequested: p.revisionRequested,
    revisionReason: p.revisionReason,
    submittedAt: p.submittedAt,
  }));
}
