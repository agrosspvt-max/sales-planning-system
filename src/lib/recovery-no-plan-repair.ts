import { Prisma, Role, type PrismaClient } from "@prisma/client";

/** Only planning inputs qualify; imported outstanding balances and receipts never imply a plan. */
export const conflictingRecoveryNoPlan: Prisma.RecoveryPlanDealerWhereInput = {
  noPlan: true,
  OR: [
    { monthRecoveryPlan: { gt: 0 } },
    { monthRunningRecovery: { gt: 0 } },
    { weekPlans: { some: { OR: [{ weekRecoveryPlan: { gt: 0 } }, { weekRunningRecovery: { gt: 0 } }] } } },
  ],
};

/** Explicit, idempotent data correction; dry-run by default. Never changes amounts or workflow status. */
export async function repairRecoveryNoPlan(db: PrismaClient, apply = false, actorId?: string) {
  return db.$transaction(async (tx) => {
    if (!apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const plans = await tx.recoveryPlan.findMany({
      where: { dealers: { some: conflictingRecoveryNoPlan } },
      orderBy: { id: "asc" },
      select: { id: true, officer: { select: { name: true } }, seasonMonth: { select: { name: true, calendarYear: true } } },
    });
    if (apply && plans.length) {
      // Same parent lock and ordering as the normal save paths; re-read conflicts after acquiring it.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "RecoveryPlan" WHERE "id" IN (${Prisma.join(plans.map((p) => p.id))}) ORDER BY "id" FOR UPDATE`);
    }
    const before = await tx.recoveryPlanDealer.findMany({
      where: { ...conflictingRecoveryNoPlan, recoveryPlanId: { in: plans.map((p) => p.id) } },
      include: { weekPlans: { orderBy: { id: "asc" } } },
      orderBy: { id: "asc" },
    });
    const report = plans.map((p) => ({ planId: p.id, officer: p.officer.name, month: p.seasonMonth.name, year: p.seasonMonth.calendarYear,
      correctedRows: before.filter((d) => d.recoveryPlanId === p.id).length }));
    if (apply && before.length) {
      const actor = await tx.user.findFirst({ where: { ...(actorId ? { id: actorId } : {}), role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }, select: { id: true } });
      if (!actor) throw new Error("An active Super Admin is required for the repair audit.");
      const ids = before.map((d) => d.id);
      const changed = await tx.recoveryPlanDealer.updateMany({ where: { id: { in: ids }, ...conflictingRecoveryNoPlan }, data: { noPlan: false } });
      if (changed.count !== before.length) throw new Error("Recovery rows changed during repair; no changes committed.");
      const after = await tx.recoveryPlanDealer.findMany({ where: { id: { in: ids } }, include: { weekPlans: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } });
      if (JSON.stringify(after) !== JSON.stringify(before.map((d) => ({ ...d, noPlan: false })))) {
        throw new Error("Recovery data preservation check failed; no changes committed.");
      }
      await tx.auditLog.createMany({ data: report.filter((p) => p.correctedRows > 0).map((p) => ({
        userId: actor.id, action: "UPDATE", entity: "recoveryPlan", entityId: p.planId,
        summary: `Recovery No Plan repair: ${p.correctedRows} dealer row(s) with positive monthly/weekly planning amounts marked Completed. Only noPlan flags changed; all amounts, reasons and approval status preserved.`,
      })) });
    }
    return { applied: apply, correctedRows: before.length, plans: report.filter((p) => p.correctedRows > 0) };
  }, { timeout: 30000, maxWait: 10000 });
}
