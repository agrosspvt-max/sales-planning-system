import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { type AuthContext } from "@/lib/http";
import { labeledError } from "@/features/labels/labeled-error";
import { writeAudit } from "@/lib/audit";
import { currentBusinessDate } from "@/lib/daily-work";
import { lockDailyWorkDay, type DailyWorkDayState } from "./day-lock.server";
import { materializeDueBillingTasksInTransaction } from "./billing-task.server";
import { reconcileDueCnRequestsTx } from "@/features/cn-requests/cn-expiry.server";
import { dropEmptyTaskRow, ensureTaskRow, splitCombinedDraftRows } from "./task-rows.server";

type DueTask = {
  sourceKind: "PAYMENT_EVENT" | "LEGACY_REQUEST";
  sourceId: string;
  dealerId: string;
  amount: string;
};

type RecoveryEntry = { id: string };

/**
 * Which roles can OWN a CN and therefore receive its follow-up Auto Task in Daily Work → Recovery: Sales Officers and
 * Regional Managers (an RM who raises a CN for themselves is its responsible field officer — RM-owned CN ≈ SO-owned CN).
 * This is only the role gate; every query below is additionally scoped to `c."officerId" = <the submitting user>`, so a
 * task ever belongs to its CN's owner alone (an RM never gets, sees or confirms an SO's task). The SAME predicate drives the
 * Recovery read path and both submit gates, so a gate can never fire for a task the user is not shown — and the CN service
 * authorizes confirm/reschedule with the same owner rule (`isCnTaskOwner`).
 */
export function autoTasksApplyToRole(role: Role): boolean {
  return role === Role.SALES_OFFICER || role === Role.REGIONAL_MANAGER;
}

export interface MaterializationResult {
  materializedTasks: number;
  affectedDealers: number;
  finalized: boolean;
}

/**
 * Materialize every due CN task into the owner's current editable Recovery batch.
 * Caller must already hold the DailyWorkDay row lock. Source rows are then locked in the same order, making
 * page loads, Recovery reads, submissions and reschedules serialize without changing CN taskStatus semantics.
 */
export async function materializeDueDailyWorkTasksInTransaction(
  tx: Prisma.TransactionClient,
  officerId: string,
  workDate: string,
  day: DailyWorkDayState,
): Promise<MaterializationResult> {
  const cn = await materializeDueCnTasksInTransaction(tx, officerId, workDate, day);
  if (cn.finalized) return cn;
  // Billing Exception tasks are a separate source with their own link / contribution; they ride the same lock, read paths and submit gates, and their count joins the total
  // (a newly materialized task blocks finalization exactly like a CN task).
  const billing = await materializeDueBillingTasksInTransaction(tx, officerId, workDate, day);
  return { materializedTasks: cn.materializedTasks + billing.materialized, affectedDealers: cn.affectedDealers + billing.affectedDealers, finalized: false };
}

async function materializeDueCnTasksInTransaction(
  tx: Prisma.TransactionClient,
  officerId: string,
  workDate: string,
  day: DailyWorkDayState,
): Promise<MaterializationResult> {
  if (day.status === "FINALIZED") return { materializedTasks: 0, affectedDealers: 0, finalized: true };
  await splitCombinedDraftRows(tx, officerId, workDate, day); // historical combined draft rows → one row per task, from their own links

  // A stage change that is already due is applied first, so an Expired CN can never materialize a task (no bypass of the expiry).
  await reconcileDueCnRequestsTx(tx, [officerId]);
  const paymentTasks = await tx.$queryRaw<Array<Omit<DueTask, "sourceKind">>>(Prisma.sql`
    SELECT e."id" AS "sourceId", c."dealerId", e."taskAmount"::text AS "amount"
    FROM "CnPaymentEvent" e
    JOIN "CnRequest" c ON c."id" = e."cnRequestId"
    JOIN "DealerAssignment" da ON da."dealerId" = c."dealerId" AND da."officerId" = c."officerId" AND da."effectiveTo" IS NULL
    WHERE c."officerId" = ${officerId}
      AND c."paymentTrackingMode" = 'PAYMENT_V1'
      AND c."cnPolicyStage" IS DISTINCT FROM 'EXPIRED'
      AND e."taskStatus" = 'SCHEDULED'
      AND e."taskDate" IS NOT NULL AND e."taskDate" <= ${workDate}::date
      AND e."taskAmount" IS NOT NULL AND e."taskAmount" > 0
      AND e."dailyWorkEntryId" IS NULL
    ORDER BY e."taskDate", e."createdAt", e."id"
    FOR UPDATE OF e`);

  const legacyTasks = await tx.$queryRaw<Array<Omit<DueTask, "sourceKind">>>(Prisma.sql`
    SELECT c."id" AS "sourceId", c."dealerId", c."amount"::text AS "amount"
    FROM "CnRequest" c
    JOIN "DealerAssignment" da ON da."dealerId" = c."dealerId" AND da."officerId" = c."officerId" AND da."effectiveTo" IS NULL
    WHERE c."officerId" = ${officerId}
      AND c."paymentTrackingMode" IS NULL
      AND c."status" = 'ACCEPTED_NOT_POSTED'
      AND c."acceptanceReason" = 'PAYMENT_PENDING'
      AND c."taskDate" IS NOT NULL AND c."taskDate" <= ${workDate}::date
      AND c."amount" IS NOT NULL AND c."amount" > 0
      AND c."legacyDailyWorkEntryId" IS NULL AND c."legacyTaskAbandonedAt" IS NULL
    ORDER BY c."taskDate", c."acceptedAt" NULLS LAST, c."id"
    FOR UPDATE OF c`);

  const tasks: DueTask[] = [
    ...paymentTasks.map((task) => ({ ...task, sourceKind: "PAYMENT_EVENT" as const })),
    ...legacyTasks.map((task) => ({ ...task, sourceKind: "LEGACY_REQUEST" as const })),
  ];
  if (tasks.length === 0) return { materializedTasks: 0, affectedDealers: 0, finalized: false };

  // ONE Recovery row per CN task (never one combined row per dealer): each task keeps its own amount, link and outcome.
  let materializedTasks = 0;
  const touchedDealers = new Set<string>();
  for (const task of tasks) {
    const contribution = new Prisma.Decimal(task.amount);
    if (!contribution.isPositive()) continue;
    const entryId = await ensureTaskRow(tx, { officerId, dealerId: task.dealerId, workDate, batchId: day.currentBatchId, section: "RECOVERY", kind: task.sourceKind === "PAYMENT_EVENT" ? "CNP" : "CNL", sourceId: task.sourceId });
    if (!entryId) throw labeledError(409, "daily_work.error.recovery_plan_changed_auto");
    const linked = task.sourceKind === "PAYMENT_EVENT"
      ? await tx.$executeRaw(Prisma.sql`
          UPDATE "CnPaymentEvent"
          SET "dailyWorkEntryId" = ${entryId}, "dailyWorkContribution" = ${contribution}
          WHERE "id" = ${task.sourceId} AND "dailyWorkEntryId" IS NULL AND "taskStatus" = 'SCHEDULED'`)
      : await tx.$executeRaw(Prisma.sql`
          UPDATE "CnRequest"
          SET "legacyDailyWorkEntryId" = ${entryId}, "legacyDailyWorkContribution" = ${contribution}, "updatedAt" = NOW()
          WHERE "id" = ${task.sourceId} AND "legacyDailyWorkEntryId" IS NULL
            AND "paymentTrackingMode" IS NULL AND "status" = 'ACCEPTED_NOT_POSTED'`);
    if (Number(linked) !== 1) { await dropEmptyTaskRow(tx, entryId); continue; }
    await tx.$executeRaw(Prisma.sql`UPDATE "DailyWorkEntry" SET "todaysPlan" = ${contribution}, "updatedAt" = NOW() WHERE "id" = ${entryId} AND "status" = 'DRAFT' AND "batchId" = ${day.currentBatchId}`);
    touchedDealers.add(task.dealerId);
    materializedTasks++;
  }
  const affectedDealers = touchedDealers.size;

  if (materializedTasks > 0) {
    // Real Recovery data is authoritative over a previously selected No Plan flag.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkEntry"
      SET "noPlanSections" = NULLIF(array_to_string(array_remove(string_to_array(COALESCE("noPlanSections", ''), ','), 'RECOVERY'), ','), ''),
          "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
        AND "section" = 'SUMMARY' AND "rowKey" = '__SUMMARY__'`);
    await writeAudit({
      userId: officerId,
      action: "UPDATE",
      entity: "dailyWork",
      entityId: `AUTO_TASKS:${workDate}:${day.currentBatchId}`,
      summary: `Materialized ${materializedTasks} CN Auto Task(s) as ${materializedTasks} Recovery row(s) for ${affectedDealers} dealer(s)`,
    }, tx);
  }
  return { materializedTasks, affectedDealers, finalized: false };
}

/**
 * A cheap, NON-locking look: is any Auto Task (CN payment event, legacy CN request or Billing Exception task) due for this officer that has not entered Daily Work yet?
 * It only has to be a superset of what materialization would claim — "no" means there is certainly nothing to do, "yes" just means "go and take the lock and check".
 */
export async function hasDueAutoTasks(officerId: string, workDate: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ due: boolean }>>(Prisma.sql`
    SELECT (
      EXISTS (SELECT 1 FROM "CnPaymentEvent" e JOIN "CnRequest" c ON c."id" = e."cnRequestId"
              WHERE c."officerId" = ${officerId} AND c."paymentTrackingMode" = 'PAYMENT_V1' AND e."taskStatus" = 'SCHEDULED' AND e."taskDate" IS NOT NULL AND e."taskDate" <= ${workDate}::date AND e."dailyWorkEntryId" IS NULL)
      OR EXISTS (SELECT 1 FROM "CnRequest" c WHERE c."officerId" = ${officerId} AND c."paymentTrackingMode" IS NULL AND c."status" = 'ACCEPTED_NOT_POSTED' AND c."taskDate" IS NOT NULL AND c."taskDate" <= ${workDate}::date AND c."legacyDailyWorkEntryId" IS NULL AND c."legacyTaskAbandonedAt" IS NULL)
      OR EXISTS (SELECT 1 FROM "BillingExceptionTask" t JOIN "DealerAssignment" da ON da."dealerId" = t."dealerId" AND da."officerId" = ${officerId} AND da."effectiveTo" IS NULL
                 WHERE t."taskDate" <= ${workDate}::date AND t."dailyWorkEntryId" IS NULL AND t."abandonedAt" IS NULL)
    ) AS "due"`);
  return rows[0]?.due ?? true; // when in doubt, take the lock and let the authoritative path decide
}

/**
 * Server-authoritative entry point used by Daily Work reads and the Auto Tasks endpoint. A read only opens the (row-locking) materialization transaction when there is
 * something to materialize: otherwise every Sales / Recovery / status read would queue on the same DailyWorkDay lock — and so would a submission.
 */
export async function materializeDueDailyWorkTasks(ctx: AuthContext): Promise<MaterializationResult> {
  if (!autoTasksApplyToRole(ctx.role)) {
    return { materializedTasks: 0, affectedDealers: 0, finalized: false };
  }
  const workDate = currentBusinessDate();
  if (!(await hasDueAutoTasks(ctx.userId, workDate))) return { materializedTasks: 0, affectedDealers: 0, finalized: false };
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, ctx.userId, workDate);
    return materializeDueDailyWorkTasksInTransaction(tx, ctx.userId, workDate, day);
  }, { timeout: 15_000 });
}

/** Reverse one linked task contribution. The task link itself is cleared by the CN scheduling service. */
export async function reverseMaterializedDailyWorkContribution(
  tx: Prisma.TransactionClient,
  input: { entryId: string; contribution: number; officerId: string; workDate: string; day: DailyWorkDayState },
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string; todaysPlan: string | null }>>(Prisma.sql`
    SELECT "id", "todaysPlan"::text AS "todaysPlan" FROM "DailyWorkEntry"
    WHERE "id" = ${input.entryId} AND "officerId" = ${input.officerId}
      AND "workDate" = ${input.workDate}::date AND "batchId" = ${input.day.currentBatchId}
      AND "section" = 'RECOVERY' AND "status" = 'DRAFT'
    FOR UPDATE`);
  const row = rows[0];
  if (!row || input.day.status === "FINALIZED") {
    throw labeledError(409, "daily_work.error.auto_task_submitted");
  }
  const current = new Prisma.Decimal(row.todaysPlan ?? 0);
  const contribution = new Prisma.Decimal(input.contribution);
  if (!contribution.isPositive() || current.lessThan(contribution)) {
    throw labeledError(409, "daily_work.error.auto_task_contribution");
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "DailyWorkEntry"
    SET "todaysPlan" = ${current.minus(contribution)}, "updatedAt" = NOW()
    WHERE "id" = ${input.entryId} AND "status" = 'DRAFT' AND "batchId" = ${input.day.currentBatchId}`);
}
