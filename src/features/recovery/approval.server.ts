import "server-only";
import { PlanStatus, ApprovalActionType, Role, NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertOfficerInScope, getCurrentManagerId, isPlanOwner } from "@/lib/scope";
import { createNotification, notifyMany, getSuperAdminIds } from "@/features/notifications/service.server";
import { assertLifecycleEditable } from "@/features/planning/lifecycle.server";

/**
 * Recovery Plan approval — reuses the EXACT same status machine, ApprovalAction log and
 * notification system as Seasonal/Monthly planning (Officer → RM → Admin). No new framework;
 * Recovery has no rate snapshot / versioning, so there is no finalize step.
 */

const EDITABLE: PlanStatus[] = [PlanStatus.DRAFT, PlanStatus.RETURNED, PlanStatus.REJECTED];
const PENDING: PlanStatus[] = [PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN];

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

interface RecoveryRow {
  id: string;
  officerId: string;
  status: PlanStatus;
  lifecycleState: string;
  seasonMonth: { name: string };
  season: { name: string; year: number };
  seasonPlan: { lifecycleState: string } | null;
}

async function loadOr404(id: string): Promise<RecoveryRow> {
  const p = await prisma.recoveryPlan.findUnique({
    where: { id },
    include: {
      seasonMonth: { select: { name: true } },
      season: { select: { name: true, year: true } },
      seasonPlan: { select: { lifecycleState: true } },
    },
  });
  if (!p) throw new ApiError(404, "Recovery plan not found");
  return p as unknown as RecoveryRow;
}

/** No workflow action on a closed/deactivated recovery plan (or under a frozen seasonal plan). */
function assertRecoveryLive(p: RecoveryRow) {
  if (p.seasonPlan) assertLifecycleEditable(p.seasonPlan.lifecycleState, "The parent seasonal plan");
  assertLifecycleEditable(p.lifecycleState, "This recovery plan");
}
async function label(p: RecoveryRow): Promise<string> {
  const officer = await prisma.user.findUnique({ where: { id: p.officerId }, select: { name: true } });
  return `${officer?.name ?? "Officer"} — ${p.season.name} ${p.season.year} · ${p.seasonMonth.name} Recovery`;
}
async function record(p: { id: string }, actorId: string, action: ApprovalActionType, fromStatus: PlanStatus, toStatus: PlanStatus, remarks?: string) {
  await prisma.approvalAction.create({ data: { recoveryPlanId: p.id, actorId, action, fromStatus, toStatus, remarks } });
}

export async function submitRecoveryPlan(ctx: AuthContext, id: string) {
  const p = await loadOr404(id);
  if (!(isPlanOwner(ctx, p.officerId))) throw new ApiError(403, "Only the owning Sales Officer can submit this recovery plan");
  if (!EDITABLE.includes(p.status)) throw new ApiError(409, "This recovery plan cannot be submitted in its current state");
  assertRecoveryLive(p);

  // Dealer completion gate — every dealer must have a recovery plan value or be marked No Plan.
  const dealers = await prisma.recoveryPlanDealer.findMany({
    where: { recoveryPlanId: id },
    select: { noPlan: true, monthRecoveryPlan: true, monthRunningRecovery: true, dealer: { select: { name: true } } },
  });
  const remaining = dealers.filter((d) => !d.noPlan && num(d.monthRecoveryPlan ?? 0) <= 0 && num(d.monthRunningRecovery ?? 0) <= 0);
  if (dealers.length === 0 || remaining.length > 0) {
    throw new ApiError(422, `Every dealer must be planned or marked "No Plan". Not yet accounted for: ${remaining.map((r) => r.dealer.name).slice(0, 20).join(", ")}`);
  }

  const managerId = await getCurrentManagerId(p.officerId);
  const nextStatus = managerId ? PlanStatus.PENDING_RM : PlanStatus.PENDING_ADMIN;
  await prisma.recoveryPlan.update({ where: { id }, data: { status: nextStatus, submittedAt: new Date() } });
  await record(p, ctx.userId, ApprovalActionType.SUBMIT, p.status, nextStatus);

  const l = await label(p);
  if (nextStatus === PlanStatus.PENDING_RM && managerId) {
    await createNotification({ userId: managerId, type: NotificationType.PLAN_SUBMITTED, title: "Recovery plan submitted", message: `${l} is awaiting your approval.`, relatedEntityType: "RecoveryPlan", relatedEntityId: id });
  } else {
    await notifyMany(await getSuperAdminIds(), { type: NotificationType.PLAN_SUBMITTED, title: "Recovery plan submitted", message: `${l} is awaiting Super Admin approval.`, relatedEntityType: "RecoveryPlan", relatedEntityId: id });
  }
  return { status: nextStatus };
}

export async function recallRecoveryPlan(ctx: AuthContext, id: string) {
  const p = await loadOr404(id);
  if (!(isPlanOwner(ctx, p.officerId))) throw new ApiError(403, "Only the owning Sales Officer can recall this recovery plan");
  if (!PENDING.includes(p.status)) throw new ApiError(409, "Only a submitted recovery plan can be recalled");
  assertRecoveryLive(p);
  await prisma.recoveryPlan.update({ where: { id }, data: { status: PlanStatus.DRAFT } });
  await record(p, ctx.userId, ApprovalActionType.RECALL, p.status, PlanStatus.DRAFT);
  return { status: PlanStatus.DRAFT };
}

async function assertApprover(ctx: AuthContext, p: RecoveryRow) {
  if (p.status === PlanStatus.PENDING_RM) {
    const managerId = await getCurrentManagerId(p.officerId);
    if (ctx.userId !== managerId) throw new ApiError(403, "Only the assigned Regional Manager can act on this recovery plan");
  } else if (p.status === PlanStatus.PENDING_ADMIN) {
    if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can act on this recovery plan");
  } else {
    throw new ApiError(409, "This recovery plan is not awaiting approval");
  }
}

export async function approveRecoveryPlan(ctx: AuthContext, id: string) {
  const p = await loadOr404(id);
  await assertApprover(ctx, p);
  assertRecoveryLive(p);
  if (p.status === PlanStatus.PENDING_RM) {
    await prisma.recoveryPlan.update({ where: { id }, data: { status: PlanStatus.PENDING_ADMIN } });
    await record(p, ctx.userId, ApprovalActionType.APPROVE, PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN);
    await notifyMany(await getSuperAdminIds(), { type: NotificationType.PLAN_SUBMITTED, title: "Recovery plan awaiting Super Admin approval", message: `${await label(p)} was approved by the Regional Manager.`, relatedEntityType: "RecoveryPlan", relatedEntityId: id });
    return { status: PlanStatus.PENDING_ADMIN };
  }
  await prisma.recoveryPlan.update({ where: { id }, data: { status: PlanStatus.APPROVED, approvedAt: new Date() } });
  await record(p, ctx.userId, ApprovalActionType.APPROVE, PlanStatus.PENDING_ADMIN, PlanStatus.APPROVED);
  await createNotification({ userId: p.officerId, type: NotificationType.PLAN_APPROVED, title: "Recovery plan approved", message: `${await label(p)} has been approved.`, relatedEntityType: "RecoveryPlan", relatedEntityId: id });
  return { status: PlanStatus.APPROVED };
}

export async function returnRecoveryPlan(ctx: AuthContext, id: string, remarks: string) {
  const p = await loadOr404(id);
  await assertApprover(ctx, p);
  assertRecoveryLive(p);
  await prisma.recoveryPlan.update({ where: { id }, data: { status: PlanStatus.RETURNED } });
  await record(p, ctx.userId, ApprovalActionType.RETURN, p.status, PlanStatus.RETURNED, remarks);
  await createNotification({ userId: p.officerId, type: NotificationType.PLAN_RETURNED, title: "Recovery plan returned", message: `${await label(p)} was returned: "${remarks}"`, relatedEntityType: "RecoveryPlan", relatedEntityId: id });
  return { status: PlanStatus.RETURNED };
}

export async function rejectRecoveryPlan(ctx: AuthContext, id: string, remarks: string) {
  const p = await loadOr404(id);
  await assertApprover(ctx, p);
  assertRecoveryLive(p);
  await prisma.recoveryPlan.update({ where: { id }, data: { status: PlanStatus.REJECTED } });
  await record(p, ctx.userId, ApprovalActionType.REJECT, p.status, PlanStatus.REJECTED, remarks);
  await createNotification({ userId: p.officerId, type: NotificationType.PLAN_RETURNED, title: "Recovery plan rejected", message: `${await label(p)} was rejected: "${remarks}"`, relatedEntityType: "RecoveryPlan", relatedEntityId: id });
  return { status: PlanStatus.REJECTED };
}

export async function getRecoveryHistory(ctx: AuthContext, id: string) {
  const p = await loadOr404(id);
  await assertOfficerInScope(ctx, p.officerId);
  const actions = await prisma.approvalAction.findMany({ where: { recoveryPlanId: id }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
  return {
    timeline: actions.map((a) => ({ id: a.id, actorName: a.actor.name, action: a.action, fromStatus: a.fromStatus, toStatus: a.toStatus, remarks: a.remarks, createdAt: a.createdAt })),
  };
}
