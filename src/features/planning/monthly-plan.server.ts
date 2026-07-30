import "server-only";
import { PlanStatus, ApprovalActionType, Role, NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertOfficerInScope, getCurrentManagerId, getOfficerScope } from "@/lib/scope";
import { createNotification, notifyMany, getSuperAdminIds } from "@/features/notifications/service.server";
import { saveMonthlySchema } from "@/lib/validations/planning";
import { isQuantityMode, type PlanningMode } from "@/lib/calc";
import { buildMonthlyDealers } from "./monthly.server";

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
  seasonPlan: { seasonId: string; officerId: string };
  seasonMonth: { name: string; order: number };
}

async function loadMonthlyPlanOr404(id: string): Promise<MonthlyPlanRow> {
  const mp = await prisma.monthlyPlan.findUnique({
    where: { id },
    include: {
      seasonPlan: { select: { seasonId: true, officerId: true } },
      seasonMonth: { select: { name: true, order: true } },
    },
  });
  if (!mp) throw new ApiError(404, "Monthly plan not found");
  return mp as unknown as MonthlyPlanRow;
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
  await assertOfficerInScope(ctx, mp.officerId);

  const seasonId = mp.seasonPlan.seasonId;
  const [season, planDealers, month] = await Promise.all([
    prisma.season.findUnique({ where: { id: seasonId }, select: { name: true, year: true, monthlyMode: true } }),
    prisma.planDealer.findMany({
      where: { seasonPlanId: mp.seasonPlanId },
      include: {
        dealer: { select: { name: true } },
        lines: {
          include: {
            product: { select: { name: true } },
            packs: { select: { quantity: true } },
            monthlyEntries: { where: { seasonMonthId: mp.seasonMonthId } },
          },
        },
      },
    }),
    prisma.seasonMonth.findUnique({ where: { id: mp.seasonMonthId }, select: { id: true, name: true, order: true } }),
  ]);

  const isOwner = ctx.userId === mp.officerId && ctx.role === Role.SALES_OFFICER;
  const monthlyMode = (season?.monthlyMode ?? "PACK_SIZE") as PlanningMode;
  const canEdit = (isOwner || ctx.role === Role.SUPER_ADMIN) && EDITABLE.includes(mp.status);
  // Exactly ONE month — shaped as MonthlyData so the existing provider/planner consume it
  // unchanged (no in-page month selector). Editability comes from the monthly plan lifecycle.
  const months = month
    ? [{ id: month.id, name: month.name, order: month.order, status: "OPEN", editable: canEdit }]
    : [];

  return {
    monthlyPlanId: mp.id,
    planId: mp.seasonPlanId,
    status: mp.status,
    canEdit,
    seasonName: season ? `${season.name} ${season.year}` : "",
    monthName: month?.name ?? "",
    monthlyMode,
    months,
    dealers: buildMonthlyDealers(planDealers, months, monthlyMode),
  };
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
            product: { select: { name: true } },
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
        | { planQty: number; saleQty: number; planValue: unknown; saleValue: unknown }
        | null;
      const mode = (e.mode ?? "PACK_SIZE") as PlanningMode;

      if (isQuantityMode(mode)) {
        const planQty = e.planQty ?? existing?.planQty ?? 0;
        const saleQty = e.saleQty ?? existing?.saleQty ?? 0;
        await tx.monthlyEntry.upsert({
          where,
          create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, planQty, saleQty },
          update: { planQty, saleQty, inputMode: null, planValue: null, saleValue: null },
        });
      } else {
        const planValue = e.planValue ?? num(existing?.planValue ?? 0);
        const saleValue = e.saleValue ?? num(existing?.saleValue ?? 0);
        await tx.monthlyEntry.upsert({
          where,
          create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, planQty: 0, saleQty: 0, inputMode: mode, planValue, saleValue },
          update: { planQty: 0, saleQty: 0, inputMode: mode, planValue, saleValue },
        });
      }
    }
  });

  const saved = await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { lastSavedAt: new Date() }, select: { lastSavedAt: true } });
  return { saved: true, lastSavedAt: saved.lastSavedAt };
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
  await prisma.monthlyPlan.update({ where: { id: mp.id }, data: { status: PlanStatus.REJECTED } });
  await recordMonthlyAction(mp, ctx.userId, ApprovalActionType.REJECT, mp.status, PlanStatus.REJECTED, remarks);
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
