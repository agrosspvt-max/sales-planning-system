import "server-only";
import { Role, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";

/**
 * Recovery Plan Transfer — move a Recovery Plan from one Seasonal Plan version to another.
 *
 * A Sales Officer can have several Seasonal Plan versions (V1 deactivated, V2 approved, …). A Recovery
 * Plan stays attached to whichever Seasonal Plan it was created under, so when that version is
 * deactivated the Recovery Plan is dragged down with it. This tool re-points ONLY
 * `RecoveryPlan.seasonPlanId` to the chosen Seasonal Plan of the SAME officer & season. Nothing else is
 * created, duplicated, or modified (dealer plans, monthly plans, seasonal data, actual sales, history
 * all untouched). Super Admin only.
 *
 * Shape (keeps the transaction tiny, so it never hits the interactive-transaction timeout):
 *   1. `validateTransfer(...)` — ALL read-only loads + validation happen BEFORE any transaction.
 *   2. `applyTransfer(tx, ...)` — the atomic part only: a single guarded update + the audit write.
 * `validateTransfer` + `applyTransfer` are reused by both the single and (future) bulk flows.
 */

// The project-standard interactive-transaction options, matching every other planning/recovery
// transaction (e.g. recovery/service.server.ts, monthly-plan.server.ts). Not new values.
const TX_OPTIONS = { timeout: 60000, maxWait: 10000 } as const;

function assertSuperAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can transfer Recovery Plans");
}

export interface SeasonPlanOption {
  id: string;
  version: number;
  status: string;
  planningType: string;
  isActiveVersion: boolean;
  createdAt: Date;
}
export interface TransferOptions {
  recoveryPlanId: string;
  officerId: string;
  seasonId: string;
  current: SeasonPlanOption | null; // the Seasonal Plan the Recovery Plan is currently attached to
  targets: SeasonPlanOption[]; // eligible destinations (same officer+season, excluding current)
}
export interface TransferResult {
  recoveryPlanId: string;
  fromSeasonPlanId: string | null;
  toSeasonPlanId: string;
}

type RecoveryRow = { id: string; officerId: string; seasonId: string; seasonPlanId: string | null };

/** All Seasonal Plans for an officer+season, newest version first. Reused by options + validation. */
async function seasonalPlansFor(officerId: string, seasonId: string): Promise<SeasonPlanOption[]> {
  return (await prisma.seasonPlan.findMany({
    where: { officerId, seasonId, planningType: "SEASONAL" },
    select: { id: true, version: true, status: true, planningType: true, isActiveVersion: true, createdAt: true },
    orderBy: [{ version: "desc" }],
  })) as SeasonPlanOption[];
}

/** Current attachment + eligible destinations for the transfer modal. Super Admin only. */
export async function getTransferOptions(ctx: AuthContext, recoveryPlanId: string): Promise<TransferOptions> {
  assertSuperAdmin(ctx);
  const rp = (await prisma.recoveryPlan.findUnique({
    where: { id: recoveryPlanId },
    select: { id: true, officerId: true, seasonId: true, seasonPlanId: true },
  })) as RecoveryRow | null;
  if (!rp) throw new ApiError(404, "Recovery Plan not found");

  const all = await seasonalPlansFor(rp.officerId, rp.seasonId);
  const current = all.find((p) => p.id === rp.seasonPlanId) ?? null;
  const targets = all.filter((p) => p.id !== rp.seasonPlanId);
  return { recoveryPlanId: rp.id, officerId: rp.officerId, seasonId: rp.seasonId, current, targets };
}

/** A fully validated, ready-to-apply transfer. Produced OUTSIDE any transaction. */
interface PreparedTransfer {
  recoveryPlanId: string;
  currentSeasonPlanId: string | null;
  targetSeasonPlanId: string;
  officerId: string;
  seasonId: string;
  fromVersion: number | null; // for the audit message only
  toVersion: number; // for the audit message only
}

/**
 * READ-ONLY validation — runs BEFORE any transaction. Loads the source Recovery Plan and target Seasonal
 * Plan, enforces every rule (different plan, target is a Seasonal Plan, same officer, same season), and
 * fetches the version labels needed only for the audit message. No writes, no atomicity needed.
 */
async function validateTransfer(recoveryPlanId: string, targetSeasonPlanId: string): Promise<PreparedTransfer> {
  const rp = (await prisma.recoveryPlan.findUnique({
    where: { id: recoveryPlanId },
    select: { id: true, officerId: true, seasonId: true, seasonPlanId: true },
  })) as RecoveryRow | null;
  if (!rp) throw new ApiError(404, "Recovery Plan not found");

  if (targetSeasonPlanId === rp.seasonPlanId) throw new ApiError(422, "The Recovery Plan is already attached to this Seasonal Plan");

  const target = (await prisma.seasonPlan.findUnique({
    where: { id: targetSeasonPlanId },
    select: { id: true, officerId: true, seasonId: true, planningType: true, version: true },
  })) as { id: string; officerId: string; seasonId: string; planningType: string; version: number } | null;
  if (!target) throw new ApiError(404, "Target Seasonal Plan not found");
  if (target.planningType !== "SEASONAL") throw new ApiError(422, "The target must be a Seasonal Plan");
  if (target.officerId !== rp.officerId) throw new ApiError(422, "Cannot transfer a Recovery Plan across Sales Officers");
  if (target.seasonId !== rp.seasonId) throw new ApiError(422, "Cannot transfer a Recovery Plan across Seasons");

  // Current version for a readable audit summary (may be null for legacy/unattached rows).
  const from = rp.seasonPlanId
    ? ((await prisma.seasonPlan.findUnique({ where: { id: rp.seasonPlanId }, select: { version: true } })) as { version: number } | null)
    : null;

  return {
    recoveryPlanId: rp.id,
    currentSeasonPlanId: rp.seasonPlanId,
    targetSeasonPlanId: target.id,
    officerId: rp.officerId,
    seasonId: rp.seasonId,
    fromVersion: from?.version ?? null,
    toVersion: target.version,
  };
}

/**
 * ATOMIC part only — runs inside the transaction. Two statements: a single guarded relation update and
 * the audit write. The update is a compare-and-set (id + officer + season) so it re-verifies, in one
 * statement and without an extra read, that the row still matches what we validated — guarding against a
 * concurrent change/deletion (count ≠ 1 → rollback). seasonPlanId is set to a non-null, validated plan,
 * so the Recovery Plan is never left without a Seasonal Plan; the target FK guarantees it still exists.
 * If the audit write fails, the whole transaction (including the update) rolls back.
 */
async function applyTransfer(tx: Prisma.TransactionClient, ctx: AuthContext, p: PreparedTransfer): Promise<TransferResult> {
  const res = await tx.recoveryPlan.updateMany({
    where: { id: p.recoveryPlanId, officerId: p.officerId, seasonId: p.seasonId },
    data: { seasonPlanId: p.targetSeasonPlanId },
  });
  if (res.count !== 1) throw new ApiError(409, "The Recovery Plan changed during transfer; nothing was modified. Please retry.");

  await writeAudit(
    {
      userId: ctx.userId,
      action: "TRANSFER",
      entity: "RecoveryPlan",
      entityId: p.recoveryPlanId,
      summary: `Recovery Plan transferred from Seasonal Plan ${p.fromVersion != null ? `V${p.fromVersion}` : "(none)"} to V${p.toVersion}`,
    },
    tx,
  );

  return { recoveryPlanId: p.recoveryPlanId, fromSeasonPlanId: p.currentSeasonPlanId, toSeasonPlanId: p.targetSeasonPlanId };
}

/** Transfer a single Recovery Plan. Super Admin only. Validate first, then a minimal atomic write. */
export async function transferRecoveryPlan(ctx: AuthContext, recoveryPlanId: string, targetSeasonPlanId: string): Promise<TransferResult> {
  assertSuperAdmin(ctx);
  const prepared = await validateTransfer(recoveryPlanId, targetSeasonPlanId);
  return prisma.$transaction((tx) => applyTransfer(tx, ctx, prepared), TX_OPTIONS);
}

/**
 * Future-facing bulk transfer: validate every item first (outside), then apply them all in ONE short
 * transaction, reusing the same atomic core. Not yet wired to a route.
 */
export async function transferRecoveryPlansBulk(
  ctx: AuthContext,
  items: { recoveryPlanId: string; targetSeasonPlanId: string }[],
): Promise<TransferResult[]> {
  assertSuperAdmin(ctx);
  const prepared = await Promise.all(items.map((it) => validateTransfer(it.recoveryPlanId, it.targetSeasonPlanId)));
  return prisma.$transaction(async (tx) => {
    const out: TransferResult[] = [];
    for (const p of prepared) out.push(await applyTransfer(tx, ctx, p));
    return out;
  }, TX_OPTIONS);
}
