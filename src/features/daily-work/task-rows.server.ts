import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DailyWorkDayState } from "./day-lock.server";

/**
 * ONE DAILY WORK ROW PER DISTINCT TASK.
 *
 * A scheduled task (Billing Exception task, CN payment task, legacy CN task, Calendar Sales / Recovery task) owns its Daily Work row: the row key is derived from the task's own
 * identity (`t:<kind>:<id>`), so two tasks of the same dealer can never be merged, overwrite one another or share an amount — whatever their dealer, date, section or Recovery
 * Type. The ONE directly entered manual task of a dealer keeps `rowKey = dealerId`; a scheduled or rescheduled task never uses (or consumes) that slot.
 * The existing unique key (officer, work date, batch, section, rowKey) makes claiming a row idempotent: a repeated page load, a retry or a racing request finds the same row.
 */
export type TaskRowKind = "BE" | "CNP" | "CNL" | "CAL";
export const TASK_ROW_PREFIX = "t:";
export const taskRowKey = (kind: TaskRowKind, sourceId: string): string => `${TASK_ROW_PREFIX}${kind}:${sourceId}`;
export const isTaskRowKey = (rowKey: string | null | undefined): boolean => (rowKey ?? "").startsWith(TASK_ROW_PREFIX);

/** Find-or-create the task's own DRAFT row in the current batch (row-locked). Caller holds the day lock. */
export async function ensureTaskRow(tx: Prisma.TransactionClient, p: {
  officerId: string; dealerId: string; workDate: string; batchId: string; section: "SALES" | "RECOVERY"; kind: TaskRowKind; sourceId: string; entryType?: string; schemeId?: string | null;
}): Promise<string | null> {
  const key = taskRowKey(p.kind, p.sourceId);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","entryType","schemeId","status","createdAt","updatedAt")
    VALUES (${randomUUID()}, ${p.officerId}, ${p.dealerId}, ${key}, ${p.workDate}::date, ${p.batchId}, ${p.section}, 0, ${p.entryType ?? "REGULAR"}, ${p.entryType === "SCHEME" ? p.schemeId ?? null : null}, 'DRAFT', NOW(), NOW())
    ON CONFLICT ("officerId","workDate","batchId","section","rowKey") DO NOTHING`);
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "DailyWorkEntry"
    WHERE "officerId" = ${p.officerId} AND "workDate" = ${p.workDate}::date AND "batchId" = ${p.batchId} AND "section" = ${p.section} AND "rowKey" = ${key} AND "status" = 'DRAFT'
    FOR UPDATE`);
  return rows[0]?.id ?? null;
}

/** Drop a task's DRAFT row once it carries nothing any more (its task moved away). Never touches submitted rows or the direct manual row. */
export async function dropEmptyTaskRow(tx: Prisma.TransactionClient, entryId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "DailyWorkEntry" e
    WHERE e."id" = ${entryId} AND e."status" = 'DRAFT' AND e."rowKey" LIKE 't:%' AND COALESCE(e."todaysPlan", 0) = 0
      AND NOT EXISTS (SELECT 1 FROM "BillingExceptionTask" x WHERE x."dailyWorkEntryId" = e."id")
      AND NOT EXISTS (SELECT 1 FROM "CnPaymentEvent" x WHERE x."dailyWorkEntryId" = e."id")
      AND NOT EXISTS (SELECT 1 FROM "CnRequest" x WHERE x."legacyDailyWorkEntryId" = e."id")
      AND NOT EXISTS (SELECT 1 FROM "CalendarEntry" x WHERE x."dailyWorkEntryId" = e."id")`);
}

/** Σ of every scheduled-task contribution per Daily Work row — the part of a row's plan that is NOT directly entered. */
export const ROW_CONTRIBUTIONS = Prisma.sql`(
  SELECT "dailyWorkEntryId" AS "entryId", "dailyWorkContribution" AS "c" FROM "BillingExceptionTask" WHERE "dailyWorkEntryId" IS NOT NULL
  UNION ALL SELECT "dailyWorkEntryId", "dailyWorkContribution" FROM "CnPaymentEvent" WHERE "dailyWorkEntryId" IS NOT NULL
  UNION ALL SELECT "legacyDailyWorkEntryId", "legacyDailyWorkContribution" FROM "CnRequest" WHERE "legacyDailyWorkEntryId" IS NOT NULL
  UNION ALL SELECT "dailyWorkEntryId", "dailyWorkContribution" FROM "CalendarEntry" WHERE "dailyWorkEntryId" IS NOT NULL AND "kind" = 'TASK' AND "taskSection" IN ('SALES', 'RECOVERY')
)`;

/**
 * Dealers that already have a DIRECTLY ENTERED manual task for this officer / date / section in a SUBMITTED planning batch (a combined legacy row counts only when it carries a
 * manual remainder on top of its scheduled tasks). A scheduled or rescheduled task never counts. Used by the dropdown and by the server-side limit.
 */
export async function submittedManualDealerIds(db: Prisma.TransactionClient | typeof prisma, officerId: string, section: string, workDate: string, currentBatchId: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ dealerId: string }>>(Prisma.sql`
    SELECT DISTINCT e."dealerId" FROM "DailyWorkEntry" e
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(x."c"), 0) AS "sum" FROM ${ROW_CONTRIBUTIONS} x WHERE x."entryId" = e."id") k ON true
    WHERE e."officerId" = ${officerId} AND e."section" = ${section} AND e."workDate" = ${workDate}::date AND e."dealerId" IS NOT NULL
      AND e."batchId" <> ${currentBatchId} AND e."status" IN ('PLAN_SUBMITTED','FINALIZED','SUBMITTED') AND e."rowKey" NOT LIKE 't:%'
      AND COALESCE(e."todaysPlan", 0) - k."sum" > 0.005`);
  return rows.map((r) => r.dealerId);
}

type Linked = { kind: TaskRowKind; id: string; entryId: string; contribution: string; entryType: string | null; schemeId: string | null };

/**
 * HISTORICAL COMBINED DRAFT ROWS. Before task rows existed, every scheduled task of a dealer was added into ONE dealer row. Each source task still carries its own link and
 * contribution, so the current editable batch can be separated EXACTLY from those links (nothing is guessed): every linked task gets its own row with its own amount, and what is
 * left of the combined plan after the linked amounts is the dealer's directly entered manual task. Submitted and finalized rows are never rewritten (they stay explicit legacy
 * records whose individual tasks are still identifiable through their links). Idempotent; caller holds the day lock.
 */
export async function splitCombinedDraftRows(tx: Prisma.TransactionClient, officerId: string, workDate: string, day: DailyWorkDayState): Promise<number> {
  if (day.status === "FINALIZED") return 0;
  const rows = await tx.$queryRaw<Array<{ id: string; dealerId: string; section: string; todaysPlan: string | null; entryType: string; schemeId: string | null }>>(Prisma.sql`
    SELECT e."id", e."dealerId", e."section", e."todaysPlan"::text AS "todaysPlan", e."entryType", e."schemeId" FROM "DailyWorkEntry" e
    WHERE e."officerId" = ${officerId} AND e."workDate" = ${workDate}::date AND e."batchId" = ${day.currentBatchId} AND e."status" = 'DRAFT'
      AND e."section" IN ('SALES','RECOVERY') AND e."dealerId" IS NOT NULL AND e."rowKey" NOT LIKE 't:%'
      AND EXISTS (SELECT 1 FROM ${ROW_CONTRIBUTIONS} x WHERE x."entryId" = e."id")
    FOR UPDATE`);
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  const linked: Linked[] = [
    ...(await tx.$queryRaw<Linked[]>(Prisma.sql`SELECT 'BE' AS "kind", "id", "dailyWorkEntryId" AS "entryId", "dailyWorkContribution"::text AS "contribution", NULL::text AS "entryType", NULL::text AS "schemeId" FROM "BillingExceptionTask" WHERE "dailyWorkEntryId" IN (${Prisma.join(ids)}) ORDER BY "taskDate", "createdAt", "id" FOR UPDATE`)),
    ...(await tx.$queryRaw<Linked[]>(Prisma.sql`SELECT 'CNP' AS "kind", "id", "dailyWorkEntryId" AS "entryId", "dailyWorkContribution"::text AS "contribution", NULL::text AS "entryType", NULL::text AS "schemeId" FROM "CnPaymentEvent" WHERE "dailyWorkEntryId" IN (${Prisma.join(ids)}) ORDER BY "taskDate", "createdAt", "id" FOR UPDATE`)),
    ...(await tx.$queryRaw<Linked[]>(Prisma.sql`SELECT 'CNL' AS "kind", "id", "legacyDailyWorkEntryId" AS "entryId", "legacyDailyWorkContribution"::text AS "contribution", NULL::text AS "entryType", NULL::text AS "schemeId" FROM "CnRequest" WHERE "legacyDailyWorkEntryId" IN (${Prisma.join(ids)}) ORDER BY "taskDate", "id" FOR UPDATE`)),
    ...(await tx.$queryRaw<Linked[]>(Prisma.sql`SELECT 'CAL' AS "kind", "id", "dailyWorkEntryId" AS "entryId", "dailyWorkContribution"::text AS "contribution", "entryType", "schemeId" FROM "CalendarEntry" WHERE "dailyWorkEntryId" IN (${Prisma.join(ids)}) AND "kind" = 'TASK' AND "taskSection" IN ('SALES','RECOVERY') ORDER BY "createdAt", "id" FOR UPDATE`)),
  ].filter((l) => l.contribution != null);

  let split = 0;
  for (const row of rows) {
    const mine = linked.filter((l) => l.entryId === row.id);
    if (mine.length === 0) continue;
    const total = mine.reduce((s, l) => s.add(new Prisma.Decimal(l.contribution)), new Prisma.Decimal(0));
    const remainder = new Prisma.Decimal(row.todaysPlan ?? 0).minus(total);
    const keepsManual = remainder.greaterThan(0.005);
    for (let i = 0; i < mine.length; i++) {
      const l = mine[i]!;
      const amount = new Prisma.Decimal(l.contribution);
      const key = taskRowKey(l.kind, l.id);
      const type = l.kind === "CAL" ? l.entryType ?? "REGULAR" : row.entryType, scheme = l.kind === "CAL" ? l.schemeId : row.schemeId;
      if (!keepsManual && i === 0) {
        // The original row (and its id) becomes this task's own row.
        await tx.$executeRaw(Prisma.sql`UPDATE "DailyWorkEntry" SET "rowKey" = ${key}, "todaysPlan" = ${amount}, "entryType" = ${type}, "schemeId" = ${type === "SCHEME" ? scheme : null}, "updatedAt" = NOW() WHERE "id" = ${row.id}`);
        continue;
      }
      const entryId = await ensureTaskRow(tx, { officerId, dealerId: row.dealerId, workDate, batchId: day.currentBatchId, section: row.section as "SALES" | "RECOVERY", kind: l.kind, sourceId: l.id, entryType: type, schemeId: scheme });
      if (!entryId) continue;
      await tx.$executeRaw(Prisma.sql`UPDATE "DailyWorkEntry" SET "todaysPlan" = ${amount}, "updatedAt" = NOW() WHERE "id" = ${entryId}`);
      if (l.kind === "BE") await tx.$executeRaw(Prisma.sql`UPDATE "BillingExceptionTask" SET "dailyWorkEntryId" = ${entryId} WHERE "id" = ${l.id}`);
      else if (l.kind === "CNP") await tx.$executeRaw(Prisma.sql`UPDATE "CnPaymentEvent" SET "dailyWorkEntryId" = ${entryId} WHERE "id" = ${l.id}`);
      else if (l.kind === "CNL") await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest" SET "legacyDailyWorkEntryId" = ${entryId} WHERE "id" = ${l.id}`);
      else await tx.$executeRaw(Prisma.sql`UPDATE "CalendarEntry" SET "dailyWorkEntryId" = ${entryId} WHERE "id" = ${l.id}`);
    }
    if (keepsManual) await tx.$executeRaw(Prisma.sql`UPDATE "DailyWorkEntry" SET "todaysPlan" = ${remainder}, "updatedAt" = NOW() WHERE "id" = ${row.id}`);
    split++;
  }
  return split;
}

/** A cheap, non-locking look: does the officer's current editable batch still hold a combined legacy row? */
export async function hasCombinedDraftRows(officerId: string, workDate: string, currentBatchId: string): Promise<boolean> {
  const r = await prisma.$queryRaw<Array<{ n: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM "DailyWorkEntry" e WHERE e."officerId" = ${officerId} AND e."workDate" = ${workDate}::date AND e."batchId" = ${currentBatchId} AND e."status" = 'DRAFT'
      AND e."section" IN ('SALES','RECOVERY') AND e."dealerId" IS NOT NULL AND e."rowKey" NOT LIKE 't:%' AND EXISTS (SELECT 1 FROM ${ROW_CONTRIBUTIONS} x WHERE x."entryId" = e."id")) AS "n"`);
  return r[0]?.n ?? true;
}
