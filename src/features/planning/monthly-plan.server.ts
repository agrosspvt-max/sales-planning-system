import "server-only";
import { z } from "zod";
import { PlanStatus, ApprovalActionType, Role, NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertOfficerInScope, getCurrentManagerId, getOfficerScope } from "@/lib/scope";
import { createNotification, notifyMany, getSuperAdminIds } from "@/features/notifications/service.server";
import { saveMonthlySchema } from "@/lib/validations/planning";
import { isQuantityMode, type PlanningMode } from "@/lib/calc";
import { tightKey } from "@/lib/match-key";
import { findProbableDealers } from "@/lib/dealer-resolver";
import { writeAudit } from "@/lib/audit";
import { applyDealerAssignment } from "@/features/assignments/service.server";
import { buildMonthlyDealers } from "./monthly.server";
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
      seasonMonth: { select: { name: true, order: true } },
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
  actorId: string,
  action: ApprovalActionType,
  fromStatus: PlanStatus,
  toStatus: PlanStatus,
  remarks?: string,
) {
  await prisma.approvalAction.create({
    data: { seasonPlanId: mp.seasonPlanId, monthlyPlanId: mp.id, actorId, action, fromStatus, toStatus, remarks },
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
  const isOwner = ctx.role === Role.SALES_OFFICER && seasonPlan.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) {
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
      seasonMonth: { select: { name: true, order: true } },
      officer: { select: { name: true } },
    },
    orderBy: [{ updatedAt: "desc" }],
  });
  return rows.map((mp) => ({
    id: mp.id,
    seasonPlanId: mp.seasonPlanId,
    seasonMonthId: mp.seasonMonthId,
    seasonName: `${mp.seasonPlan.season.name} ${mp.seasonPlan.season.year}`,
    monthName: mp.seasonMonth.name,
    monthOrder: mp.seasonMonth.order,
    officerId: mp.officerId,
    officerName: mp.officer.name,
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
    prisma.seasonMonth.findMany({ where: { seasonId: seasonPlan.seasonId }, orderBy: { order: "asc" } }),
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
    months: months.map((m) => {
      const mp = byMonth.get(m.id);
      return {
        id: m.id,
        name: m.name,
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
      // Only ACTIVE dealers (isActive) appear: excludes deactivated/deleted/rejected (all
      // isActive=false). Pending monthly-created dealers stay visible to their creator (isActive=true).
      where: { seasonPlanId: mp.seasonPlanId, dealer: { isActive: true } },
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
    prisma.seasonMonth.findUnique({ where: { id: mp.seasonMonthId }, select: { id: true, name: true, order: true } }),
    prisma.monthlyPlanDealer.findMany({ where: { monthlyPlanId: mp.id, noPlan: true }, select: { dealerId: true, noPlanReason: true } }),
  ]);

  const isOwner = ctx.userId === mp.officerId && ctx.role === Role.SALES_OFFICER;
  const monthlyMode = (season?.monthlyMode ?? "PACK_SIZE") as PlanningMode;
  const isLive = mp.lifecycleState === "ACTIVE" && mp.seasonPlan.lifecycleState === "ACTIVE";
  const canEdit = (isOwner || ctx.role === Role.SUPER_ADMIN) && EDITABLE.includes(mp.status) && isLive;
  // Admin Override: a Super Admin may correct an APPROVED, live monthly plan (read-only flag; the
  // admin-edit service re-checks the parent seasonal version).
  const canAdminEdit = ctx.role === Role.SUPER_ADMIN && mp.status === PlanStatus.APPROVED && isLive;
  // Exactly ONE month — shaped as MonthlyData so the existing provider/planner consume it
  // unchanged (no in-page month selector). Editability comes from the monthly plan lifecycle.
  const months = month
    ? [{ id: month.id, name: month.name, order: month.order, status: "OPEN", editable: canEdit }]
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
  // Attach per-dealer completion (≥1 monthly plan value entered — the SAME "has a value" concept
  // Seasonal Planning uses) and the stored monthly No Plan state.
  const dealers = buildMonthlyDealers(planDealers, months, monthlyMode).map((d) => ({
    ...d,
    noPlan: noPlanByDealer.has(d.dealerId),
    noPlanReason: noPlanByDealer.get(d.dealerId) ?? null,
    completed: d.products.some((p) => (p.monthly[monthId]?.plan ?? 0) > 0),
    contact: contactByDealer.get(d.dealerId) ?? null,
  }));

  return {
    monthlyPlanId: mp.id,
    planId: mp.seasonPlanId,
    officerId: mp.officerId,
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
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = ctx.role === Role.SALES_OFFICER && mp.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "This monthly plan is not editable");
  assertMonthlyLive(mp);

  const noPlanReason = noPlan ? reason?.trim() || null : null;
  await prisma.monthlyPlanDealer.upsert({
    where: { monthlyPlanId_dealerId: { monthlyPlanId, dealerId } },
    create: { monthlyPlanId, dealerId, noPlan, noPlanReason },
    update: { noPlan, noPlanReason },
  });
  return { noPlan, noPlanReason };
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
    prisma.seasonMonth.findMany({ where: { id: { in: approvedIds } }, orderBy: { order: "asc" }, select: { id: true, name: true, order: true } }),
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

  return { monthlyMode, months, dealers: buildMonthlyDealers(planDealers, months, monthlyMode) };
}

/* -------------------------------- Saving ---------------------------------- */

export async function saveMonthlyPlanEntries(ctx: AuthContext, monthlyPlanId: string, raw: unknown) {
  const { entries } = saveMonthlySchema.parse(raw);
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = ctx.role === Role.SALES_OFFICER && mp.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) {
    throw new ApiError(403, "Only the owning Sales Officer or a Super Admin can enter monthly figures");
  }
  if (!EDITABLE.includes(mp.status)) {
    throw new ApiError(409, "This monthly plan is not editable in its current state");
  }
  assertMonthlyLive(mp);

  const validLines = new Set(
    (await prisma.planLine.findMany({ where: { planDealer: { seasonPlanId: mp.seasonPlanId } }, select: { id: true } })).map(
      (l) => l.id,
    ),
  );

  await prisma.$transaction(async (tx) => {
    for (const e of entries) {
      if (!validLines.has(e.planLineId)) throw new ApiError(422, "Plan line is not part of this plan");
      // A monthly plan owns exactly ONE month — reject stray months defensively.
      if (e.seasonMonthId !== mp.seasonMonthId) {
        throw new ApiError(422, "Entry month does not match this monthly plan");
      }
      const where = { planLineId_seasonMonthId: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId } };
      const existing = (await tx.monthlyEntry.findUnique({ where })) as
        | { planQty: number; planValue: unknown }
        | null;
      const mode = (e.mode ?? "PACK_SIZE") as PlanningMode;

      // Monthly planning writes ONLY the plan fields. Actual sales (saleQty / saleValue) are
      // owned exclusively by the Sales Upload and must never be modified here — so an upsert on
      // an existing entry preserves whatever actuals the upload wrote.
      if (isQuantityMode(mode)) {
        const planQty = e.planQty ?? existing?.planQty ?? 0;
        await tx.monthlyEntry.upsert({
          where,
          create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, planQty },
          update: { planQty },
        });
      } else {
        const planValue = e.planValue ?? num(existing?.planValue ?? 0);
        await tx.monthlyEntry.upsert({
          where,
          create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, inputMode: mode, planValue },
          update: { inputMode: mode, planValue },
        });
      }
    }
  });

  const saved = await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { lastSavedAt: new Date() }, select: { lastSavedAt: true } });
  return { saved: true, lastSavedAt: saved.lastSavedAt };
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

  const products = (await prisma.product.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      rate: true,
      nbvPercent: true,
    },
  })) as {
    id: string;
    name: string;
    rate: unknown;
    nbvPercent: unknown;
  }[];

  return products
    .filter((p) => !alreadyInMonth.has(p.id))
    .map((p) => ({
      productId: p.id,
      productName: p.name,
      rate: num(p.rate),
      nbvPercent: num(p.nbvPercent),
    }));
}

/**
 * Add a product to one dealer's current monthly plan. A seasonal product reuses its existing
 * PlanLine; a product absent from the seasonal plan gets an additional zero-seasonal PlanLine.
 * In both cases, the zero-valued MonthlyEntry is the month-specific membership record.
 */
export async function addAdditionalProduct(ctx: AuthContext, monthlyPlanId: string, dealerId: string, productId: string) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = ctx.role === Role.SALES_OFFICER && mp.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "This monthly plan is not editable");
  assertMonthlyLive(mp);

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { isActive: true },
  });
  if (!product || !product.isActive) throw new ApiError(422, "Product not found or inactive");

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
  const line = existingLine ?? await prisma.planLine.create({
    data: { planDealerId: pd.id, productId, isAdditional: true },
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
  };
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
}

/**
 * Create a dealer from Monthly Planning (Sales Officer). PENDING_APPROVAL until the Monthly Plan
 * is approved; appears ONLY in this officer's monthly plan (PlanDealer `fromMonthlyPlan`), never
 * in matching/recovery/seasonal until then. Reused by the Admin path via `createDealerForOfficer`.
 * Runs the shared duplicate check first (unless `force`).
 */
export async function createMonthlyDealer(ctx: AuthContext, monthlyPlanId: string, raw: unknown): Promise<DealerCreateOutcome> {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = ctx.role === Role.SALES_OFFICER && mp.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "This monthly plan is not editable");
  assertMonthlyLive(mp);
  const data = dealerFieldsSchema.parse(raw);

  if (!data.force) {
    const duplicates = await findProbableDealers(data.name);
    if (duplicates.length > 0) return { duplicates };
  }

  const dealer = await prisma.dealer.create({
    data: { ...dealerData(data), status: "PENDING_APPROVAL", createdByUserId: ctx.userId, createdFrom: "MONTHLY_PLAN" },
  });
  await prisma.planDealer.create({ data: { seasonPlanId: mp.seasonPlanId, dealerId: dealer.id, fromMonthlyPlan: true } });
  return { dealerId: dealer.id, dealerName: dealer.name };
}

const adminCreateSchema = dealerFieldsSchema.extend({ officerId: z.string().min(1, "Select a Sales Officer") });

/**
 * Admin creates a dealer for a Sales Officer from the User Details page. No approval: the dealer
 * is ACTIVE, permanently assigned immediately (reusing `applyDealerAssignment`), and gets its
 * first DealerAlias — so it appears at once in matching/recovery/sales-upload/future seasonal.
 * Same Dealer model + duplicate check as the Monthly path.
 */
export async function createDealerForOfficer(ctx: AuthContext, raw: unknown): Promise<DealerCreateOutcome> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can create a dealer for an officer");
  const data = adminCreateSchema.parse(raw);
  const officer = await prisma.user.findUnique({ where: { id: data.officerId }, select: { role: true, isActive: true } });
  if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive) throw new ApiError(422, "The selected Sales Officer is missing or inactive");

  if (!data.force) {
    const duplicates = await findProbableDealers(data.name);
    if (duplicates.length > 0) return { duplicates };
  }

  const created = await prisma.$transaction(
    async (tx: Tx) => {
      const dealer = await tx.dealer.create({
        data: { ...dealerData(data), status: "ACTIVE", createdByUserId: ctx.userId, createdFrom: "ADMIN" },
      });
      await applyDealerAssignment(tx, dealer.id, data.officerId, new Date());
      await ensureDealerAlias(tx, dealer.id, dealer.name);
      return { id: dealer.id, name: dealer.name };
    },
    { timeout: 60000, maxWait: 10000 },
  );
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "dealer", entityId: created.id, summary: `Admin created & assigned dealer "${created.name}" to a Sales Officer` });
  return { dealerId: created.id, dealerName: created.name };
}

/** Admin shortcut: assign an EXISTING dealer to a Sales Officer (from the duplicate dialog). */
export async function assignExistingDealer(ctx: AuthContext, dealerId: string, officerId: string) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can assign a dealer");
  const [dealer, officer] = await Promise.all([
    prisma.dealer.findUnique({ where: { id: dealerId }, select: { name: true, status: true } }),
    prisma.user.findUnique({ where: { id: officerId }, select: { role: true, isActive: true } }),
  ]);
  if (!dealer) throw new ApiError(404, "Dealer not found");
  if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive) throw new ApiError(422, "Sales Officer missing or inactive");
  await prisma.$transaction(async (tx: Tx) => {
    await applyDealerAssignment(tx, dealerId, officerId, new Date());
    await ensureDealerAlias(tx, dealerId, dealer.name);
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Admin assigned existing dealer "${dealer.name}" to a Sales Officer` });
  return { dealerId };
}

/**
 * Edit a PENDING dealer's info while its Monthly Plan is still DRAFT/RETURNED. Reuses the same
 * dialog (Edit mode). Read-only once the plan is submitted/approved. Only dealers created here
 * (fromMonthlyPlan) may be edited — never existing master dealers.
 */
export async function updateMonthlyDealer(ctx: AuthContext, monthlyPlanId: string, dealerId: string, raw: unknown) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  const isOwner = ctx.role === Role.SALES_OFFICER && mp.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) throw new ApiError(403, "You cannot change this monthly plan");
  if (!EDITABLE.includes(mp.status)) throw new ApiError(409, "Dealer info is read-only once the plan is submitted");
  assertMonthlyLive(mp);
  const pd = (await prisma.planDealer.findUnique({
    where: { seasonPlanId_dealerId: { seasonPlanId: mp.seasonPlanId, dealerId } },
    select: { fromMonthlyPlan: true },
  })) as { fromMonthlyPlan: boolean } | null;
  if (!pd?.fromMonthlyPlan) throw new ApiError(403, "Only a dealer created here can be edited");
  const dealer = (await prisma.dealer.findUnique({ where: { id: dealerId }, select: { status: true } })) as { status: string } | null;
  if (dealer?.status !== "PENDING_APPROVAL") throw new ApiError(409, "This dealer is no longer editable");
  const data = dealerFieldsSchema.parse(raw);
  await prisma.dealer.update({ where: { id: dealerId }, data: dealerData(data) });
  return { dealerId };
}

/* ------------------------------- Workflow --------------------------------- */

export async function submitMonthlyPlan(ctx: AuthContext, monthlyPlanId: string) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  if (!(ctx.role === Role.SALES_OFFICER && mp.officerId === ctx.userId)) {
    throw new ApiError(403, "Only the owning Sales Officer can submit this monthly plan");
  }
  if (!EDITABLE.includes(mp.status)) {
    throw new ApiError(409, "This monthly plan cannot be submitted in its current state");
  }
  assertMonthlyLive(mp);

  // Dealer completion gate — mirrors the Seasonal submit gate: every dealer in the monthly view
  // must be Completed (≥1 monthly plan value entered) or explicitly marked "No Plan".
  const [gatePlanDealers, gateNoPlan, gateSeason] = await Promise.all([
    prisma.planDealer.findMany({
      where: { seasonPlanId: mp.seasonPlanId },
      include: {
        dealer: { select: { name: true } },
        lines: {
          include: {
            product: { select: { name: true, rate: true, nbvPercent: true } },
            packs: { select: { quantity: true } },
            monthlyEntries: { where: { seasonMonthId: mp.seasonMonthId } },
          },
        },
      },
    }),
    prisma.monthlyPlanDealer.findMany({ where: { monthlyPlanId: mp.id, noPlan: true }, select: { dealerId: true } }),
    prisma.season.findUnique({ where: { id: mp.seasonPlan.seasonId }, select: { monthlyMode: true } }),
  ]);
  const gateNoPlanSet = new Set((gateNoPlan as { dealerId: string }[]).map((r) => r.dealerId));
  const gateBuilt = buildMonthlyDealers(gatePlanDealers, [{ id: mp.seasonMonthId }], (gateSeason?.monthlyMode ?? "PACK_SIZE") as PlanningMode);
  const remaining = gateBuilt.filter(
    (d) => !gateNoPlanSet.has(d.dealerId) && !d.products.some((p) => (p.monthly[mp.seasonMonthId]?.plan ?? 0) > 0),
  );
  if (remaining.length > 0) {
    throw new ApiError(
      422,
      `Every dealer must be planned or marked "No Plan". Not yet accounted for: ${remaining.map((r) => r.dealerName).join(", ")}`,
    );
  }

  const managerId = await getCurrentManagerId(mp.officerId);
  const nextStatus = managerId ? PlanStatus.PENDING_RM : PlanStatus.PENDING_ADMIN;
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: nextStatus, submittedAt: new Date() } });
  await recordMonthlyAction(mp, ctx.userId, ApprovalActionType.SUBMIT, mp.status, nextStatus);

  const label = await monthlyLabel(mp);
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
  if (!(ctx.role === Role.SALES_OFFICER && mp.officerId === ctx.userId)) {
    throw new ApiError(403, "Only the owning Sales Officer can recall this monthly plan");
  }
  if (!PENDING.includes(mp.status)) throw new ApiError(409, "Only a submitted monthly plan can be recalled");
  assertMonthlyLive(mp);
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.DRAFT } });
  await recordMonthlyAction(mp, ctx.userId, ApprovalActionType.RECALL, mp.status, PlanStatus.DRAFT);
  return { status: PlanStatus.DRAFT };
}

async function assertMonthlyApprover(ctx: AuthContext, mp: MonthlyPlanRow) {
  if (mp.status === PlanStatus.PENDING_RM) {
    const managerId = await getCurrentManagerId(mp.officerId);
    if (ctx.userId !== managerId) throw new ApiError(403, "Only the assigned Regional Manager can act on this monthly plan");
  } else if (mp.status === PlanStatus.PENDING_ADMIN) {
    if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can act on this monthly plan");
  } else {
    throw new ApiError(409, "This monthly plan is not awaiting approval");
  }
}

export async function approveMonthlyPlan(ctx: AuthContext, monthlyPlanId: string) {
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertMonthlyApprover(ctx, mp);
  assertMonthlyLive(mp);

  if (mp.status === PlanStatus.PENDING_RM) {
    await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.PENDING_ADMIN } });
    await recordMonthlyAction(mp, ctx.userId, ApprovalActionType.APPROVE, PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN);
    await notifyMany(await getSuperAdminIds(), {
      type: NotificationType.PLAN_SUBMITTED,
      title: "Monthly plan awaiting Super Admin approval",
      message: `${await monthlyLabel(mp)} was approved by the Regional Manager and awaits final approval.`,
      relatedEntityType: "MonthlyPlan",
      relatedEntityId: mp.id,
    });
    return { status: PlanStatus.PENDING_ADMIN };
  }

  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.APPROVED, approvedAt: new Date() } });
  await recordMonthlyAction(mp, ctx.userId, ApprovalActionType.APPROVE, PlanStatus.PENDING_ADMIN, PlanStatus.APPROVED);

  // On FINAL approval, dealers created from this monthly plan become permanent: activate them
  // and assign them to the officer (reusing the existing assignment service). Idempotent — the
  // PENDING_APPROVAL guard means already-active dealers are skipped.
  const newDealers = (await prisma.planDealer.findMany({
    where: { seasonPlanId: mp.seasonPlanId, fromMonthlyPlan: true, dealer: { status: "PENDING_APPROVAL", createdByUserId: mp.officerId } },
    select: { dealerId: true, dealer: { select: { name: true } } },
  })) as { dealerId: string; dealer: { name: string } }[];
  if (newDealers.length > 0) {
    await prisma.$transaction(
      async (tx: Tx) => {
        const now = new Date();
        for (const nd of newDealers) {
          await tx.dealer.updateMany({ where: { id: nd.dealerId, status: "PENDING_APPROVAL" }, data: { status: "ACTIVE" } });
          await applyDealerAssignment(tx, nd.dealerId, mp.officerId, now);
          await ensureDealerAlias(tx, nd.dealerId, nd.dealer.name);
        }
      },
      { timeout: 60000, maxWait: 10000 },
    );
  }

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
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertMonthlyApprover(ctx, mp);
  assertMonthlyLive(mp);
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.RETURNED } });
  await recordMonthlyAction(mp, ctx.userId, ApprovalActionType.RETURN, mp.status, PlanStatus.RETURNED, remarks);
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
  const mp = await loadMonthlyPlanOr404(monthlyPlanId);
  await assertMonthlyApprover(ctx, mp);
  assertMonthlyLive(mp);
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.REJECTED } });
  await recordMonthlyAction(mp, ctx.userId, ApprovalActionType.REJECT, mp.status, PlanStatus.REJECTED, remarks);

  // Rejection is terminal for dealers created in this plan: mark them REJECTED + inactive so they
  // never participate in matching, recovery, seasonal planning or reports (proper rejected
  // lifecycle — no permanently-pending strays).
  await prisma.dealer.updateMany({
    where: {
      status: "PENDING_APPROVAL",
      createdByUserId: mp.officerId,
      planDealers: { some: { seasonPlanId: mp.seasonPlanId, fromMonthlyPlan: true } },
    },
    data: { status: "REJECTED", isActive: false },
  });
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
      actorName: a.actor.name,
      action: a.action,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      remarks: a.remarks,
      createdAt: a.createdAt,
    })),
  };
}
