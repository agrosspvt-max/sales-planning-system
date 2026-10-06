import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { currentBusinessDate } from "@/lib/daily-work";
import { lockDailyWorkDay, type DailyWorkDayState } from "./day-lock.server";
import { autoTasksApplyToRole } from "./auto-task-materialization.server";

/**
 * CALENDAR DAILY TASKS → DAILY WORK.
 *
 * A Calendar "Add Daily Task" is stored as a CalendarEntry (kind TASK) and is the SOURCE of the Daily Work row it becomes.
 * When its date is the Daily Work business date, it is materialized — exactly once — into the owner's CURRENT editable
 * (DRAFT) batch, in the section it was created for:
 *   SALES / RECOVERY → the dealer's row (created if absent; the amount is ADDED to Today's Plan if the row already exists)
 *   APPOINTMENT      → a typed dealer + market row keyed `cal-<entryId>`
 *   VISITS           → the day's SUMMARY visit counts (added to any existing counts)
 *   OTHERS           → the day's SUMMARY note (appended)
 *
 * IDEMPOTENT: the entry is claimed with `UPDATE … WHERE "materializedAt" IS NULL` in the same transaction as the write, so
 * opening Daily Work any number of times (or two requests racing) never duplicates it. The link (`dailyWorkEntryId`) is how
 * Daily Work labels the row Task Type "Calendar". Caller must already hold the DailyWorkDay lock (same order as CN Auto
 * Tasks). A finalized day is never touched. This does not read or change CN Auto Tasks.
 */

type DueEntry = {
  id: string; taskSection: string; dealerId: string | null; amount: string | null; entryType: string | null; schemeId: string | null;
  paymentMode: string | null; typedDealerName: string | null; marketName: string | null; dealerVisits: number | null; newPartyVisits: number | null; text: string | null;
};
export interface CalendarMaterializationResult { materialized: number }

const SUMMARY_ROWKEY = "SUMMARY";

export async function materializeDueCalendarTasksInTransaction(
  tx: Prisma.TransactionClient,
  officerId: string,
  workDate: string,
  day: DailyWorkDayState,
): Promise<CalendarMaterializationResult> {
  if (day.status === "FINALIZED") return { materialized: 0 };
  const due = await tx.$queryRaw<DueEntry[]>(Prisma.sql`
    SELECT "id", "taskSection", "dealerId", "amount"::text AS "amount", "entryType", "schemeId", "paymentMode",
           "typedDealerName", "marketName", "dealerVisits", "newPartyVisits", "text"
    FROM "CalendarEntry"
    WHERE "ownerId" = ${officerId} AND "kind" = 'TASK' AND "date" = ${workDate}::date AND "materializedAt" IS NULL
    ORDER BY "createdAt", "id"
    FOR UPDATE`);
  let materialized = 0;
  const clearNoPlan = new Set<string>();

  for (const task of due) {
    let rowId: string | null = null;
    let contribution: Prisma.Decimal | null = null;

    if (task.taskSection === "SALES" || task.taskSection === "RECOVERY") {
      if (!task.dealerId || task.amount == null) continue;
      const section = task.taskSection;
      let rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "DailyWorkEntry"
        WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
          AND "section" = ${section} AND "rowKey" = ${task.dealerId} AND "status" = 'DRAFT'
        FOR UPDATE`);
      if (rows.length === 0) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","entryType","schemeId","status","createdAt","updatedAt")
          VALUES (${randomUUID()}, ${officerId}, ${task.dealerId}, ${task.dealerId}, ${workDate}::date, ${day.currentBatchId}, ${section}, 0, ${task.entryType ?? "REGULAR"}, ${task.entryType === "SCHEME" ? task.schemeId : null}, 'DRAFT', NOW(), NOW())
          ON CONFLICT ("officerId","workDate","batchId","section","rowKey") DO NOTHING`);
        rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "DailyWorkEntry"
          WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
            AND "section" = ${section} AND "rowKey" = ${task.dealerId} AND "status" = 'DRAFT'
          FOR UPDATE`);
      }
      rowId = rows[0]?.id ?? null;
      contribution = new Prisma.Decimal(task.amount);
    } else if (task.taskSection === "APPOINTMENT") {
      if (!task.typedDealerName?.trim()) continue;
      const key = `cal-${task.id}`;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","typedDealerName","marketName","status","createdAt","updatedAt")
        VALUES (${randomUUID()}, ${officerId}, NULL, ${key}, ${workDate}::date, ${day.currentBatchId}, 'APPOINTMENT', ${task.typedDealerName.trim()}, ${task.marketName?.trim() || null}, 'DRAFT', NOW(), NOW())
        ON CONFLICT ("officerId","workDate","batchId","section","rowKey") DO NOTHING`);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "DailyWorkEntry"
        WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
          AND "section" = 'APPOINTMENT' AND "rowKey" = ${key} AND "status" = 'DRAFT'`);
      rowId = rows[0]?.id ?? null;
    } else if (task.taskSection === "VISITS" || task.taskSection === "OTHERS") {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","status","createdAt","updatedAt")
        VALUES (${randomUUID()}, ${officerId}, NULL, ${SUMMARY_ROWKEY}, ${workDate}::date, ${day.currentBatchId}, 'SUMMARY', 'DRAFT', NOW(), NOW())
        ON CONFLICT ("officerId","workDate","batchId","section","rowKey") DO NOTHING`);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "DailyWorkEntry"
        WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
          AND "section" = 'SUMMARY' AND "rowKey" = ${SUMMARY_ROWKEY} AND "status" = 'DRAFT'
        FOR UPDATE`);
      rowId = rows[0]?.id ?? null;
    } else continue;
    if (!rowId) continue;

    // Claim FIRST (atomic, idempotent). Only the winner writes the Daily Work data.
    const claimed = await tx.$executeRaw(Prisma.sql`
      UPDATE "CalendarEntry"
      SET "dailyWorkEntryId" = ${rowId}, "dailyWorkContribution" = ${contribution}, "materializedAt" = NOW(), "updatedAt" = NOW()
      WHERE "id" = ${task.id} AND "materializedAt" IS NULL`);
    if (Number(claimed) !== 1) continue;

    if (contribution) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry" SET "todaysPlan" = COALESCE("todaysPlan", 0) + ${contribution}, "updatedAt" = NOW()
        WHERE "id" = ${rowId} AND "status" = 'DRAFT' AND "batchId" = ${day.currentBatchId}`);
      clearNoPlan.add(task.taskSection);
    } else if (task.taskSection === "VISITS") {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry"
        SET "dealerVisits" = COALESCE("dealerVisits", 0) + ${task.dealerVisits ?? 0}, "newPartyVisits" = COALESCE("newPartyVisits", 0) + ${task.newPartyVisits ?? 0}, "updatedAt" = NOW()
        WHERE "id" = ${rowId} AND "status" = 'DRAFT' AND "batchId" = ${day.currentBatchId}`);
      clearNoPlan.add("VISITS");
    } else if (task.taskSection === "OTHERS") {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry"
        SET "others" = CASE WHEN COALESCE(TRIM("others"), '') = '' THEN ${task.text ?? ""} ELSE "others" || E'\n' || ${task.text ?? ""} END, "updatedAt" = NOW()
        WHERE "id" = ${rowId} AND "status" = 'DRAFT' AND "batchId" = ${day.currentBatchId}`);
      clearNoPlan.add("OTHERS");
    } else {
      clearNoPlan.add("APPOINTMENT");
    }
    materialized++;
  }

  if (materialized > 0) {
    // Real data is authoritative over a previously selected No Plan for the sections it fills (same rule as Auto Tasks).
    for (const section of clearNoPlan) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry"
        SET "noPlanSections" = NULLIF(array_to_string(array_remove(string_to_array(COALESCE("noPlanSections", ''), ','), ${section}), ','), ''), "updatedAt" = NOW()
        WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
          AND "section" = 'SUMMARY' AND "rowKey" = ${SUMMARY_ROWKEY}`);
    }
    await writeAudit({
      userId: officerId, action: "UPDATE", entity: "dailyWork", entityId: `CALENDAR_TASKS:${workDate}:${day.currentBatchId}`,
      summary: `Added ${materialized} Calendar task(s) to Daily Work`,
    }, tx);
  }
  return { materialized };
}

/** Read-path entry point (owner, today only). Roles that cannot own Daily Work are no-ops. */
export async function materializeDueCalendarTasks(ctx: AuthContext): Promise<CalendarMaterializationResult> {
  if (!autoTasksApplyToRole(ctx.role)) return { materialized: 0 }; // same owner roles as CN Auto Tasks: SO and RM
  const workDate = currentBusinessDate();
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, ctx.userId, workDate);
    return materializeDueCalendarTasksInTransaction(tx, ctx.userId, workDate, day);
  }, { timeout: 15_000 });
}

/** Which of these Daily Work rows came from a Calendar task (drives Task Type "Calendar"). One batched read. */
export async function calendarLinkedEntryIds(entryIds: string[]): Promise<string[]> {
  if (entryIds.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT "dailyWorkEntryId" AS "id" FROM "CalendarEntry"
    WHERE "kind" = 'TASK' AND "dailyWorkEntryId" IN (${Prisma.join(entryIds)})`);
  return rows.map((r) => r.id);
}
