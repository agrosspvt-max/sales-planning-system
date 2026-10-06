import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { currentBusinessDate } from "@/lib/daily-work";
import { lockDailyWorkDay, type DailyWorkDayState } from "./day-lock.server";

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
  if (day.status === "FINALIZED") return { materializedTasks: 0, affectedDealers: 0, finalized: true };

  const paymentTasks = await tx.$queryRaw<Array<Omit<DueTask, "sourceKind">>>(Prisma.sql`
    SELECT e."id" AS "sourceId", c."dealerId", e."taskAmount"::text AS "amount"
    FROM "CnPaymentEvent" e
    JOIN "CnRequest" c ON c."id" = e."cnRequestId"
    JOIN "DealerAssignment" da ON da."dealerId" = c."dealerId" AND da."officerId" = c."officerId" AND da."effectiveTo" IS NULL
    WHERE c."officerId" = ${officerId}
      AND c."paymentTrackingMode" = 'PAYMENT_V1'
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
      AND c."legacyDailyWorkEntryId" IS NULL
    ORDER BY c."taskDate", c."acceptedAt" NULLS LAST, c."id"
    FOR UPDATE OF c`);

  const tasks: DueTask[] = [
    ...paymentTasks.map((task) => ({ ...task, sourceKind: "PAYMENT_EVENT" as const })),
    ...legacyTasks.map((task) => ({ ...task, sourceKind: "LEGACY_REQUEST" as const })),
  ];
  if (tasks.length === 0) return { materializedTasks: 0, affectedDealers: 0, finalized: false };

  const byDealer = new Map<string, DueTask[]>();
  for (const task of tasks) {
    const list = byDealer.get(task.dealerId) ?? [];
    list.push(task);
    byDealer.set(task.dealerId, list);
  }

  let materializedTasks = 0;
  let affectedDealers = 0;
  for (const [dealerId, dealerTasks] of byDealer) {
    let entries = await tx.$queryRaw<RecoveryEntry[]>(Prisma.sql`
      SELECT "id" FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date
        AND "batchId" = ${day.currentBatchId} AND "section" = 'RECOVERY' AND "rowKey" = ${dealerId}
        AND "status" = 'DRAFT'
      FOR UPDATE`);
    if (entries.length === 0) {
      const entryId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","entryType","status","createdAt","updatedAt")
        VALUES (${entryId}, ${officerId}, ${dealerId}, ${dealerId}, ${workDate}::date, ${day.currentBatchId}, 'RECOVERY', 0, 'REGULAR', 'DRAFT', NOW(), NOW())
        ON CONFLICT ("officerId","workDate","batchId","section","rowKey") DO NOTHING`);
      entries = await tx.$queryRaw<RecoveryEntry[]>(Prisma.sql`
        SELECT "id" FROM "DailyWorkEntry"
        WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date
          AND "batchId" = ${day.currentBatchId} AND "section" = 'RECOVERY' AND "rowKey" = ${dealerId}
          AND "status" = 'DRAFT'
        FOR UPDATE`);
    }
    const entry = entries[0];
    if (!entry) throw new ApiError(409, "The current Recovery plan changed while Auto Tasks were being added.");

    let added = new Prisma.Decimal(0);
    for (const task of dealerTasks) {
      const contribution = new Prisma.Decimal(task.amount);
      if (!contribution.isPositive()) continue;
      const linked = task.sourceKind === "PAYMENT_EVENT"
        ? await tx.$executeRaw(Prisma.sql`
            UPDATE "CnPaymentEvent"
            SET "dailyWorkEntryId" = ${entry.id}, "dailyWorkContribution" = ${contribution}
            WHERE "id" = ${task.sourceId} AND "dailyWorkEntryId" IS NULL AND "taskStatus" = 'SCHEDULED'`)
        : await tx.$executeRaw(Prisma.sql`
            UPDATE "CnRequest"
            SET "legacyDailyWorkEntryId" = ${entry.id}, "legacyDailyWorkContribution" = ${contribution}, "updatedAt" = NOW()
            WHERE "id" = ${task.sourceId} AND "legacyDailyWorkEntryId" IS NULL
              AND "paymentTrackingMode" IS NULL AND "status" = 'ACCEPTED_NOT_POSTED'`);
      if (Number(linked) === 1) {
        added = added.add(contribution);
        materializedTasks++;
      }
    }
    if (added.isPositive()) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry"
        SET "todaysPlan" = COALESCE("todaysPlan", 0) + ${added}, "updatedAt" = NOW()
        WHERE "id" = ${entry.id} AND "status" = 'DRAFT' AND "batchId" = ${day.currentBatchId}`);
      affectedDealers++;
    }
  }

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
      summary: `Materialized ${materializedTasks} CN Auto Task(s) into ${affectedDealers} Recovery row(s)`,
    }, tx);
  }
  return { materializedTasks, affectedDealers, finalized: false };
}

/** Server-authoritative entry point used by Daily Work reads and the Auto Tasks endpoint. */
export async function materializeDueDailyWorkTasks(ctx: AuthContext): Promise<MaterializationResult> {
  if (!autoTasksApplyToRole(ctx.role)) {
    return { materializedTasks: 0, affectedDealers: 0, finalized: false };
  }
  const workDate = currentBusinessDate();
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
    throw new ApiError(409, "This Auto Task belongs to submitted or finalized Daily Work and cannot be rescheduled.");
  }
  const current = new Prisma.Decimal(row.todaysPlan ?? 0);
  const contribution = new Prisma.Decimal(input.contribution);
  if (!contribution.isPositive() || current.lessThan(contribution)) {
    throw new ApiError(409, "The Auto Task contribution cannot be safely removed from the current Recovery plan.");
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "DailyWorkEntry"
    SET "todaysPlan" = ${current.minus(contribution)}, "updatedAt" = NOW()
    WHERE "id" = ${input.entryId} AND "status" = 'DRAFT' AND "batchId" = ${input.day.currentBatchId}`);
}
