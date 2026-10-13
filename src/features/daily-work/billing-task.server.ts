import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { currentBusinessDate } from "@/lib/daily-work";
import { getCurrentOwnerByDealer } from "@/lib/scope";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { PAYMENT_DATE_PAST_MESSAGE } from "@/lib/billing-exception";
import { effectiveBillingTaskOwners, canViewBillingTask } from "./billing-task-visibility.server";
import { lockDailyWorkDay, type DailyWorkDayState } from "./day-lock.server";
import { reverseMaterializedDailyWorkContribution } from "./auto-task-materialization.server";

/**
 * BILLING EXCEPTION → DAILY WORK → RECOVERY. A genuine, separate task source (table BillingExceptionTask): never a CN request / payment event, never a Calendar entry,
 * never sent through CN endpoints. One task per exception with a payment condition; the amount it adds to Today's Plan is its own `dailyWorkContribution`, linked to
 * the Recovery row it entered, so it is added exactly once, can be reversed on its own and stays traceable next to CN / Calendar / manual contributions on the same row.
 * It is a PLAN: it never creates a receipt, never fills Today's Actual / Payment Mode and never marks money collected.
 *
 * OWNER = the dealer's authoritative CURRENT assignment, decided when the task enters Daily Work (so a dealer moved to another officer in the meantime routes its
 * pending task to the new owner, audited); once linked, the owner of that (possibly submitted) entry is never rewritten.
 * DATES: `taskDate <= workDate` — so a missed day keeps the task pending and it appears (overdue, with its original promised date) the next time an EDITABLE day is
 * opened; a finalized day is never touched. Only today-or-later can be chosen (a past date would rewrite submitted work).
 * LOCK ORDER (same as CN / Calendar): the DailyWorkDay row first, then the task rows.
 */

export interface BillingTaskDto {
  taskId: string; billingExceptionId: string; dealerId: string; dealerName: string;
  taskType: "BILLING_EXCEPTION"; planType: "RECOVERY";
  amount: number; promisedDate: string; taskDate: string; rescheduled: boolean; confirmed: boolean; overdue: boolean;
  billNo: string | null; authPerson: string | null;
}
export interface BillingTaskDetail extends BillingTaskDto { billingDate: string | null; createdByName: string | null; officerName: string; exceptionStatus: string }

const asNum = (v: unknown) => Number(v);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Which Billing Exception task rows are due for this officer AND currently owned by them, claimed into the current editable Recovery batch (idempotent). Caller holds the day lock. */
export async function materializeDueBillingTasksInTransaction(
  tx: Prisma.TransactionClient,
  officerId: string,
  workDate: string,
  day: DailyWorkDayState,
): Promise<{ materialized: number; affectedDealers: number }> {
  if (day.status === "FINALIZED") return { materialized: 0, affectedDealers: 0 };
  // Candidates: unlinked, due (own or overdue date), dealer currently assigned to THIS officer. FOR UPDATE serializes with reschedule / confirm / other readers.
  const candidates = await tx.$queryRaw<Array<{ id: string; dealerId: string; amount: string; officerId: string }>>(Prisma.sql`
    SELECT t."id", t."dealerId", t."amount"::text AS "amount", t."officerId"
    FROM "BillingExceptionTask" t
    JOIN "DealerAssignment" da ON da."dealerId" = t."dealerId" AND da."officerId" = ${officerId} AND da."effectiveTo" IS NULL
    WHERE t."taskDate" <= ${workDate}::date AND t."dailyWorkEntryId" IS NULL
    ORDER BY t."taskDate", t."createdAt", t."id"
    FOR UPDATE OF t`);
  if (candidates.length === 0) return { materialized: 0, affectedDealers: 0 };
  // The authoritative owner (most recent open assignment) must be this officer — a stale second assignment must not capture another officer's task.
  const owners = await getCurrentOwnerByDealer([...new Set(candidates.map((c) => c.dealerId))], tx);
  const tasks = candidates.filter((c) => owners.get(c.dealerId) === officerId);
  const byDealer = new Map<string, typeof tasks>();
  for (const task of tasks) byDealer.set(task.dealerId, [...(byDealer.get(task.dealerId) ?? []), task]);

  let materialized = 0, affectedDealers = 0;
  for (const [dealerId, dealerTasks] of byDealer) {
    let entries = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
        AND "section" = 'RECOVERY' AND "rowKey" = ${dealerId} AND "status" = 'DRAFT'
      FOR UPDATE`);
    if (entries.length === 0) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","entryType","status","createdAt","updatedAt")
        VALUES (${randomUUID()}, ${officerId}, ${dealerId}, ${dealerId}, ${workDate}::date, ${day.currentBatchId}, 'RECOVERY', 0, 'REGULAR', 'DRAFT', NOW(), NOW())
        ON CONFLICT ("officerId","workDate","batchId","section","rowKey") DO NOTHING`);
      entries = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "DailyWorkEntry"
        WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
          AND "section" = 'RECOVERY' AND "rowKey" = ${dealerId} AND "status" = 'DRAFT'
        FOR UPDATE`);
    }
    const entry = entries[0];
    if (!entry) throw new ApiError(409, "The current Recovery plan changed while Billing Exception tasks were being added.");
    let added = new Prisma.Decimal(0);
    for (const task of dealerTasks) {
      const contribution = new Prisma.Decimal(task.amount);
      if (!contribution.isPositive()) continue;
      // Claim FIRST (atomic, idempotent): only the winner adds the amount. The owner is (re)written here, i.e. BEFORE the task enters Daily Work.
      const claimed = await tx.$executeRaw(Prisma.sql`
        UPDATE "BillingExceptionTask"
        SET "officerId" = ${officerId}, "dailyWorkEntryId" = ${entry.id}, "dailyWorkContribution" = ${contribution}, "dailyWorkConfirmed" = false, "materializedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${task.id} AND "dailyWorkEntryId" IS NULL`);
      if (Number(claimed) !== 1) continue;
      if (task.officerId !== officerId) {
        await writeAudit({ userId: officerId, action: "UPDATE", entity: "billingExceptionTask", entityId: task.id, summary: `Billing Exception task re-routed to the dealer's current Sales Officer (was ${task.officerId})` }, tx);
      }
      added = added.add(contribution);
      materialized++;
    }
    if (added.isPositive()) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry" SET "todaysPlan" = COALESCE("todaysPlan", 0) + ${added}, "updatedAt" = NOW()
        WHERE "id" = ${entry.id} AND "status" = 'DRAFT' AND "batchId" = ${day.currentBatchId}`);
      affectedDealers++;
    }
  }
  if (materialized > 0) {
    // Real Recovery data is authoritative over a previously selected No Plan (same rule as CN / Calendar tasks).
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkEntry"
      SET "noPlanSections" = NULLIF(array_to_string(array_remove(string_to_array(COALESCE("noPlanSections", ''), ','), 'RECOVERY'), ','), ''), "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId} AND "section" = 'SUMMARY' AND "rowKey" = '__SUMMARY__'`);
    await writeAudit({ userId: officerId, action: "UPDATE", entity: "dailyWork", entityId: `BILLING_TASKS:${workDate}:${day.currentBatchId}`, summary: `Materialized ${materialized} Billing Exception task(s) into ${affectedDealers} Recovery row(s)` }, tx);
  }
  return { materialized, affectedDealers };
}

/* ------------------------------------------------ reads (DTOs, labels, gates) ------------------------------------------------ */

type TaskRow = { id: string; billingExceptionId: string; dealerId: string; amount: Prisma.Decimal; promisedDate: Date; taskDate: Date; rescheduled: boolean; dailyWorkConfirmed: boolean; billNo: string | null; authPerson: string | null };

/** The officer's Billing Exception tasks that are inside the given Daily Work rows (confirm / reschedule / details act on these). */
export async function billingTasksForEntries(officerId: string, entryIds: string[], workDate: string): Promise<BillingTaskDto[]> {
  if (entryIds.length === 0) return [];
  const rows = await prisma.$queryRaw<TaskRow[]>(Prisma.sql`
    SELECT t."id", t."billingExceptionId", t."dealerId", t."amount", t."promisedDate", t."taskDate", t."rescheduled", t."dailyWorkConfirmed", e."billNo", e."authPerson"
    FROM "BillingExceptionTask" t JOIN "BillingException" e ON e."id" = t."billingExceptionId"
    WHERE t."dailyWorkEntryId" IN (${Prisma.join(entryIds)}) AND t."officerId" = ${officerId}
    ORDER BY t."taskDate", t."createdAt"`);
  const names = await loadDealerAliasNameMap(rows.map((r) => r.dealerId));
  const dealers = rows.length ? await prisma.dealer.findMany({ where: { id: { in: rows.map((r) => r.dealerId) } }, select: { id: true, name: true } }) : [];
  const plain = new Map(dealers.map((d) => [d.id, d.name]));
  return rows.map((r) => ({
    taskId: r.id, billingExceptionId: r.billingExceptionId, dealerId: r.dealerId, dealerName: names.get(r.dealerId) ?? plain.get(r.dealerId) ?? "—",
    taskType: "BILLING_EXCEPTION", planType: "RECOVERY", amount: asNum(r.amount), promisedDate: iso(r.promisedDate), taskDate: iso(r.taskDate),
    rescheduled: r.rescheduled, confirmed: r.dailyWorkConfirmed, overdue: iso(r.taskDate) < workDate, billNo: r.billNo, authPerson: r.authPerson,
  }));
}

/** Which of these Daily Work rows carry a Billing Exception contribution (drives the Task Type label in Daily Plan, Daily Report and review views). */
export async function billingLinkedEntryIds(entryIds: string[]): Promise<string[]> {
  if (entryIds.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT "dailyWorkEntryId" AS "id" FROM "BillingExceptionTask" WHERE "dailyWorkEntryId" IN (${Prisma.join(entryIds)})`);
  return rows.map((r) => r.id);
}

/** Materialized Billing Exception tasks of the editable batch the owner has not explicitly confirmed (the submit gate; submitting never confirms). */
export async function countUnconfirmedBillingTasks(tx: Prisma.TransactionClient, officerId: string, workDate: string, batchId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM "BillingExceptionTask" t JOIN "DailyWorkEntry" d ON d."id" = t."dailyWorkEntryId"
    WHERE d."officerId" = ${officerId} AND d."workDate" = ${workDate}::date AND d."batchId" = ${batchId}
      AND d."section" = 'RECOVERY' AND d."status" = 'DRAFT' AND t."dailyWorkConfirmed" = false`);
  return rows[0]?.n ?? 0;
}

/** Per dealer: the sum of Billing Exception contributions inside the editable Recovery rows (Today's Plan may never be saved below the sum of all active contributions). */
export const BILLING_CONTRIBUTION_UNION = Prisma.sql`
  UNION ALL
  SELECT "dailyWorkEntryId" AS "entryId", "dailyWorkContribution" AS "contribution"
  FROM "BillingExceptionTask" WHERE "dailyWorkEntryId" IS NOT NULL`;

/* ------------------------------------------------ owner actions ------------------------------------------------ */

function assertOwnerRole(ctx: AuthContext): void {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only the responsible officer can act on this task.");
}

async function loadLocked(tx: Prisma.TransactionClient, id: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "BillingExceptionTask" WHERE "id" = ${id} FOR UPDATE`);
  if (locked.length === 0) throw new ApiError(404, "Task not found");
  return tx.billingExceptionTask.findUniqueOrThrow({ where: { id } });
}

/** Explicitly confirm a task that is inside today's editable Recovery row. Idempotent; never completes anything, never moves the contribution. */
export async function confirmBillingTask(ctx: AuthContext, id: string): Promise<{ taskId: string; confirmed: true }> {
  assertOwnerRole(ctx);
  const workDate = currentBusinessDate();
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, ctx.userId, workDate);
    if (day.status === "FINALIZED") throw new ApiError(409, "Today's Daily Work is finalized; its tasks can no longer be confirmed.");
    const task = await loadLocked(tx, id);
    if (task.officerId !== ctx.userId) throw new ApiError(403, "Only the responsible officer can act on this task.");
    const inEditable = task.dailyWorkEntryId ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "DailyWorkEntry" WHERE "id" = ${task.dailyWorkEntryId} AND "officerId" = ${ctx.userId} AND "workDate" = ${workDate}::date
        AND "batchId" = ${day.currentBatchId} AND "section" = 'RECOVERY' AND "status" = 'DRAFT'`) : [];
    if (inEditable.length === 0) throw new ApiError(409, "This task is not in today's editable Recovery plan.");
    await tx.$executeRaw(Prisma.sql`UPDATE "BillingExceptionTask" SET "dailyWorkConfirmed" = true, "updatedAt" = NOW() WHERE "id" = ${id} AND "dailyWorkEntryId" IS NOT NULL`);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "billingExceptionTask", entityId: id, summary: "Billing Exception task confirmed for today's Daily Work" }, tx);
    return { taskId: id, confirmed: true as const };
  }, { timeout: 15_000 });
}

/**
 * Move a task to another day (today or later). If it is already inside today's editable Recovery row, ONLY its own contribution is removed from Today's Plan
 * (manual / CN / Calendar contributions stay) and it re-enters on its new day. Submitted / finalized work is never touched (409). The original promised date is kept.
 */
export async function rescheduleBillingTask(ctx: AuthContext, id: string, rawDate: unknown): Promise<{ taskId: string; taskDate: string }> {
  assertOwnerRole(ctx);
  const taskDate = typeof rawDate === "string" ? rawDate.trim() : "";
  const workDate = currentBusinessDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taskDate) || Number.isNaN(Date.parse(`${taskDate}T00:00:00Z`))) throw new ApiError(422, "Enter a valid date.");
  if (taskDate < workDate) throw new ApiError(422, PAYMENT_DATE_PAST_MESSAGE);
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, ctx.userId, workDate);
    const task = await loadLocked(tx, id);
    if (task.officerId !== ctx.userId) throw new ApiError(403, "Only the responsible officer can act on this task.");
    if (task.dailyWorkEntryId) {
      // Throws 409 unless the entry is today's current editable Recovery row (submitted / finalized / older days are immutable).
      await reverseMaterializedDailyWorkContribution(tx, { entryId: task.dailyWorkEntryId, contribution: Number(task.dailyWorkContribution), officerId: ctx.userId, workDate, day });
    }
    const updated = await tx.billingExceptionTask.updateMany({
      where: { id, dailyWorkEntryId: task.dailyWorkEntryId },
      data: { taskDate: new Date(`${taskDate}T00:00:00Z`), rescheduled: iso(task.taskDate) !== taskDate ? true : task.rescheduled, dailyWorkEntryId: null, dailyWorkContribution: null, dailyWorkConfirmed: false, materializedAt: null },
    });
    if (updated.count === 0) throw new ApiError(409, "The task changed; refresh Daily Work and try again.");
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "billingExceptionTask", entityId: id, summary: `Billing Exception task rescheduled to ${taskDate} (promised ${iso(task.promisedDate)})` }, tx);
    return { taskId: id, taskDate };
  }, { timeout: 15_000 });
}

/** Details of the originating exception: the responsible officer, or an administrative viewer with Last Payment Report access. */
export async function getBillingTaskDetail(ctx: AuthContext, id: string): Promise<BillingTaskDetail> {
  const task = await prisma.billingExceptionTask.findUnique({
    where: { id },
    include: { billingException: { include: { createdBy: { select: { name: true } } } }, officer: { select: { name: true } } },
  });
  // Viewers: the effective owner, a Regional Manager over that owner's team, an administrative account with Last Payment Report read — anyone else sees "missing".
  const ownerId = task ? (await effectiveBillingTaskOwners([task]))[0]! : null;
  if (!task || !ownerId || !(await canViewBillingTask(ctx, ownerId))) throw new ApiError(404, "Task not found");
  const ownerName = ownerId === task.officerId ? task.officer.name : ((await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name ?? task.officer.name);
  const today = currentBusinessDate();
  const name = (await loadDealerAliasNameMap([task.dealerId])).get(task.dealerId) ?? (await prisma.dealer.findUnique({ where: { id: task.dealerId }, select: { name: true } }))?.name ?? "—";
  return {
    taskId: task.id, billingExceptionId: task.billingExceptionId, dealerId: task.dealerId, dealerName: name, taskType: "BILLING_EXCEPTION", planType: "RECOVERY",
    amount: Number(task.amount), promisedDate: iso(task.promisedDate), taskDate: iso(task.taskDate), rescheduled: task.rescheduled, confirmed: task.dailyWorkConfirmed,
    overdue: !task.dailyWorkEntryId && iso(task.taskDate) < today, billNo: task.billingException.billNo, authPerson: task.billingException.authPerson,
    billingDate: iso(task.billingException.billingDate), createdByName: task.billingException.createdBy.name, officerName: ownerName, exceptionStatus: task.billingException.status,
  };
}
