import "server-only";
import { PlanStatus, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";

/**
 * Plan Lifecycle Management (Seasonal / Monthly / Recovery).
 *
 * A plan has TWO independent axes:
 *   - `status`         — the approval state (DRAFT … APPROVED), driven by the shared approval machine.
 *   - `lifecycleState` — ACTIVE | CLOSED | DEACTIVATED, managed here.
 *
 * CLOSED      = frozen. Read-only everywhere, still in reports & history, visible to the SO.
 * DEACTIVATED = hidden from the Sales Officer (Admin can still view / restore). Excluded from reports
 *               by default. Nothing is deleted.
 *
 * This module is the ONE place lifecycle transitions live; the seasonal/monthly/recovery services
 * import the guards below so the rule "a non-ACTIVE plan cannot be edited or moved through approval"
 * exists in exactly one spot. No approval, calculation or import logic is duplicated.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export type LifecycleState = "ACTIVE" | "CLOSED" | "DEACTIVATED";
export type LifecycleAction = "close" | "reopen" | "deactivate" | "reactivate";

/** Approval states whose rows may be hard-deleted. Approved/pending plans must be deactivated instead. */
export const DELETABLE_STATUSES: PlanStatus[] = [PlanStatus.DRAFT, PlanStatus.RETURNED, PlanStatus.REJECTED];

const AUDIT_ACTION: Record<LifecycleAction, "CLOSE" | "REOPEN" | "DEACTIVATE" | "REACTIVATE"> = {
  close: "CLOSE",
  reopen: "REOPEN",
  deactivate: "DEACTIVATE",
  reactivate: "REACTIVATE",
};

/** The column patch for each transition. ACTIVE is exclusive — it clears both timestamps. */
function lifecyclePatch(action: LifecycleAction): { lifecycleState: LifecycleState; closedAt: Date | null; deactivatedAt: Date | null } {
  switch (action) {
    case "close":
      return { lifecycleState: "CLOSED", closedAt: new Date(), deactivatedAt: null };
    case "deactivate":
      return { lifecycleState: "DEACTIVATED", deactivatedAt: new Date(), closedAt: null };
    case "reopen":
    case "reactivate":
      return { lifecycleState: "ACTIVE", closedAt: null, deactivatedAt: null };
  }
}

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can manage plan lifecycle");
}

/**
 * Cascade a seasonal lifecycle change to its Monthly + Recovery children, preserving states an
 * admin set on a child directly (requirement: reopening a parent must not un-close a month an admin
 * closed on purpose).
 *   - Freeze/hide (parent → non-ACTIVE): only touch children that are currently ACTIVE, and stamp
 *     lifecycleFromParent=true so they can be restored later. Children already CLOSED/DEACTIVATED by
 *     an admin are left exactly as they are.
 *   - Restore (parent → ACTIVE): only restore children with lifecycleFromParent=true (i.e. closed by
 *     THIS cascade). Admin-managed children (lifecycleFromParent=false) keep their state.
 */
async function cascadeToChildren(
  tx: Tx,
  where: { seasonPlanId: string } | { seasonPlanId: { in: string[] } },
  patch: { lifecycleState: LifecycleState; closedAt: Date | null; deactivatedAt: Date | null },
) {
  if (patch.lifecycleState === "ACTIVE") {
    const data = { ...patch, lifecycleFromParent: false };
    await tx.monthlyPlan.updateMany({ where: { ...where, lifecycleFromParent: true }, data });
    await tx.recoveryPlan.updateMany({ where: { ...where, lifecycleFromParent: true }, data });
  } else {
    const data = { ...patch, lifecycleFromParent: true };
    await tx.monthlyPlan.updateMany({ where: { ...where, lifecycleState: "ACTIVE" }, data });
    await tx.recoveryPlan.updateMany({ where: { ...where, lifecycleState: "ACTIVE" }, data });
  }
}

/* --------------------------------- Guards --------------------------------- */

/**
 * The single predicate every editable / approval action calls. A CLOSED or DEACTIVATED plan
 * accepts no edits, autosave, submit or approval — it is frozen.
 */
export function assertLifecycleEditable(lifecycleState: string | null | undefined, label = "This plan") {
  const s = (lifecycleState ?? "ACTIVE") as LifecycleState;
  if (s === "CLOSED") throw new ApiError(409, `${label} is closed (read-only) and cannot be changed.`);
  if (s === "DEACTIVATED") throw new ApiError(409, `${label} is deactivated and cannot be changed. Restore it first.`);
}

/** True when a Sales Officer must NOT see this plan (deactivated). Admin/RM still see it. */
export function isHiddenFromOfficer(ctx: AuthContext, lifecycleState: string | null | undefined): boolean {
  return ctx.role === Role.SALES_OFFICER && (lifecycleState ?? "ACTIVE") === "DEACTIVATED";
}

/**
 * Prisma `where` fragment that hides deactivated plans from a Sales Officer.
 *
 * VISIBILITY RULE (intentional): DEACTIVATED = hidden from the SALES OFFICER only. Regional Managers
 * and the Super Admin still see deactivated plans (RMs may need to reference them; the Admin manages
 * and restores them). CLOSED plans stay visible to everyone (read-only).
 */
export function officerVisibilityWhere(ctx: AuthContext): { lifecycleState?: { not: "DEACTIVATED" } } {
  return ctx.role === Role.SALES_OFFICER ? { lifecycleState: { not: "DEACTIVATED" } } : {};
}

/* ---------------------------- Seasonal lifecycle -------------------------- */

/**
 * Close / reopen / deactivate / reactivate a Seasonal plan. Monthly and Recovery plans that belong
 * to it FOLLOW the same lifecycle (requirement 6: their visibility follows the seasonal plan), so
 * this cascades the same patch to the linked children in one transaction. Every action is audited
 * with the old→new lifecycle.
 */
export async function setSeasonalPlanLifecycle(
  ctx: AuthContext,
  planId: string,
  action: LifecycleAction,
): Promise<{ lifecycleState: LifecycleState }> {
  assertAdmin(ctx);
  const plan = await prisma.seasonPlan.findUnique({
    where: { id: planId },
    select: { id: true, lifecycleState: true, planningType: true },
  });
  if (!plan) throw new ApiError(404, "Plan not found");

  const patch = lifecyclePatch(action);
  await prisma.$transaction(async (tx) => {
    await tx.seasonPlan.update({ where: { id: planId }, data: patch });
    // Children follow the parent, but admin-set child states are preserved (see cascadeToChildren).
    await cascadeToChildren(tx, { seasonPlanId: planId }, patch);
  });

  await writeAudit({
    userId: ctx.userId,
    action: AUDIT_ACTION[action],
    entity: "seasonPlan",
    entityId: planId,
    summary: `Seasonal plan ${action}: ${(plan as { lifecycleState?: string }).lifecycleState ?? "ACTIVE"} → ${patch.lifecycleState} (Monthly & Recovery followed)`,
  });
  return { lifecycleState: patch.lifecycleState };
}

/** Delete a Seasonal plan — Draft/Returned/Rejected only (approved must be deactivated). */
export async function deleteSeasonalPlan(ctx: AuthContext, planId: string): Promise<{ deleted: true }> {
  assertAdmin(ctx);
  const plan = await prisma.seasonPlan.findUnique({
    where: { id: planId },
    select: { id: true, status: true, planningType: true },
  });
  if (!plan) throw new ApiError(404, "Plan not found");
  if (!DELETABLE_STATUSES.includes(plan.status as PlanStatus)) {
    throw new ApiError(409, "Only Draft, Returned or Rejected plans can be deleted. Deactivate an approved plan instead.");
  }
  // Recovery must always keep a valid parent (FK is Restrict). Block deletion while any recovery plan
  // references this seasonal plan — the admin must handle (delete/deactivate) those first.
  const linkedRecovery = await prisma.recoveryPlan.count({ where: { seasonPlanId: planId } });
  if (linkedRecovery > 0) {
    throw new ApiError(
      409,
      `This seasonal plan has ${linkedRecovery} linked Recovery plan(s). Delete or handle them first — recovery must always belong to a seasonal plan.`,
    );
  }
  // Cascade removes dealers → lines → packs → monthly entries, child MonthlyPlans and ApprovalActions.
  await prisma.seasonPlan.delete({ where: { id: planId } });
  await writeAudit({
    userId: ctx.userId,
    action: "DELETE",
    entity: "seasonPlan",
    entityId: planId,
    summary: `Deleted ${plan.status} seasonal plan (dependent monthly plans removed)`,
  });
  return { deleted: true };
}

/* ---------------------------- Monthly lifecycle -------------------------- */

export async function setMonthlyPlanLifecycle(
  ctx: AuthContext,
  monthlyPlanId: string,
  action: LifecycleAction,
): Promise<{ lifecycleState: LifecycleState }> {
  assertAdmin(ctx);
  const mp = await prisma.monthlyPlan.findUnique({ where: { id: monthlyPlanId }, select: { id: true, lifecycleState: true } });
  if (!mp) throw new ApiError(404, "Monthly plan not found");
  const patch = lifecyclePatch(action);
  // Direct admin action → this state is admin-managed, not inherited from a parent cascade.
  await prisma.monthlyPlan.update({ where: { id: monthlyPlanId }, data: { ...patch, lifecycleFromParent: false } });
  await writeAudit({
    userId: ctx.userId,
    action: AUDIT_ACTION[action],
    entity: "monthlyPlan",
    entityId: monthlyPlanId,
    summary: `Monthly plan ${action}: ${(mp as { lifecycleState?: string }).lifecycleState ?? "ACTIVE"} → ${patch.lifecycleState}`,
  });
  return { lifecycleState: patch.lifecycleState };
}

export async function deleteMonthlyPlan(ctx: AuthContext, monthlyPlanId: string): Promise<{ deleted: true }> {
  assertAdmin(ctx);
  const mp = await prisma.monthlyPlan.findUnique({ where: { id: monthlyPlanId }, select: { id: true, status: true } });
  if (!mp) throw new ApiError(404, "Monthly plan not found");
  if (!DELETABLE_STATUSES.includes(mp.status as PlanStatus)) {
    throw new ApiError(409, "Only Draft, Returned or Rejected monthly plans can be deleted. Deactivate an approved plan instead.");
  }
  await prisma.monthlyPlan.delete({ where: { id: monthlyPlanId } });
  await writeAudit({
    userId: ctx.userId,
    action: "DELETE",
    entity: "monthlyPlan",
    entityId: monthlyPlanId,
    summary: `Deleted ${mp.status} monthly plan`,
  });
  return { deleted: true };
}

/* ---------------------------- Recovery lifecycle ------------------------- */

export async function setRecoveryPlanLifecycle(
  ctx: AuthContext,
  recoveryPlanId: string,
  action: LifecycleAction,
): Promise<{ lifecycleState: LifecycleState }> {
  assertAdmin(ctx);
  const rp = await prisma.recoveryPlan.findUnique({ where: { id: recoveryPlanId }, select: { id: true, lifecycleState: true } });
  if (!rp) throw new ApiError(404, "Recovery plan not found");
  const patch = lifecyclePatch(action);
  // Direct admin action → admin-managed, not inherited from a parent cascade.
  await prisma.recoveryPlan.update({ where: { id: recoveryPlanId }, data: { ...patch, lifecycleFromParent: false } });
  await writeAudit({
    userId: ctx.userId,
    action: AUDIT_ACTION[action],
    entity: "recoveryPlan",
    entityId: recoveryPlanId,
    summary: `Recovery plan ${action}: ${(rp as { lifecycleState?: string }).lifecycleState ?? "ACTIVE"} → ${patch.lifecycleState}`,
  });
  return { lifecycleState: patch.lifecycleState };
}

export async function deleteRecoveryPlan(ctx: AuthContext, recoveryPlanId: string): Promise<{ deleted: true }> {
  assertAdmin(ctx);
  const rp = await prisma.recoveryPlan.findUnique({ where: { id: recoveryPlanId }, select: { id: true, status: true } });
  if (!rp) throw new ApiError(404, "Recovery plan not found");
  if (!DELETABLE_STATUSES.includes(rp.status as PlanStatus)) {
    throw new ApiError(409, "Only Draft, Returned or Rejected recovery plans can be deleted. Deactivate an approved plan instead.");
  }
  await prisma.recoveryPlan.delete({ where: { id: recoveryPlanId } });
  await writeAudit({
    userId: ctx.userId,
    action: "DELETE",
    entity: "recoveryPlan",
    entityId: recoveryPlanId,
    summary: `Deleted ${rp.status} recovery plan`,
  });
  return { deleted: true };
}

/**
 * "Replace Plan" — deactivate (archive) the officer's current ACTIVE seasonal plan(s) for a season so
 * a fresh workbook import (reusing the Company Onboarding importer) becomes the single active plan.
 * Returns how many versions were archived. The actual import is the existing onboarding flow — no
 * duplicate importer.
 */
/** Replace by plan id: archive the officer's active seasonal plan(s) for THIS plan's season, then the
 *  UI opens the shared Company Onboarding importer to bring in the replacement workbook. */
export async function replaceSeasonalPlan(
  ctx: AuthContext,
  planId: string,
): Promise<{ archived: number; officerId: string; seasonId: string }> {
  assertAdmin(ctx);
  const plan = await prisma.seasonPlan.findUnique({ where: { id: planId }, select: { officerId: true, seasonId: true } });
  if (!plan) throw new ApiError(404, "Plan not found");
  const { archived } = await archiveActiveSeasonalForReplace(ctx, plan.officerId, plan.seasonId);
  return { archived, officerId: plan.officerId, seasonId: plan.seasonId };
}

export async function archiveActiveSeasonalForReplace(
  ctx: AuthContext,
  officerId: string,
  seasonId: string,
): Promise<{ archived: number }> {
  assertAdmin(ctx);
  const active = await prisma.seasonPlan.findMany({
    where: { officerId, seasonId, planningType: "SEASONAL", lifecycleState: "ACTIVE" },
    select: { id: true },
  });
  if (active.length === 0) return { archived: 0 };
  const patch = lifecyclePatch("deactivate");
  const ids = active.map((p) => p.id);
  await prisma.$transaction(async (tx) => {
    await tx.seasonPlan.updateMany({ where: { id: { in: ids } }, data: patch });
    // Archive the officer's Monthly + Recovery plans under these versions (preserving admin-set
    // child states via the shared cascade). The replacement plan is imported FRESH — actual sales
    // stay attached to these archived plans for history and are NOT carried forward (item 9).
    await cascadeToChildren(tx, { seasonPlanId: { in: ids } }, patch);
  });
  await writeAudit({
    userId: ctx.userId,
    action: "REPLACE",
    entity: "seasonPlan",
    entityId: ids[0],
    summary: `Replace: archived ${ids.length} active seasonal plan version(s) before a fresh re-import`,
  });
  return { archived: ids.length };
}
