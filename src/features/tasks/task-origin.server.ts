import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface TaskOrigin { createdAt: string; actorName: string | null }

/** Called only AFTER the history endpoint has authorized this exact task. Never materializes work. */
export async function loadTaskOrigin(sourceType: string, taskId: string): Promise<TaskOrigin | null> {
  let sql: Prisma.Sql;
  if (sourceType === "CALENDAR_ENTRY") {
    // A manual Daily Work task becomes a Calendar task on its first move. Its beginning is the
    // original Daily Work row, not the Calendar row created later to carry that same task forward.
    sql = Prisma.sql`SELECT COALESCE(w."createdAt", c."createdAt") AS "createdAt",
      CASE WHEN w."id" IS NOT NULL THEN owner."name" ELSE creator."name" END AS "actorName"
      FROM "CalendarEntry" c
      LEFT JOIN LATERAL (SELECT u."entryId" FROM "DailyTaskOutcome" u
        WHERE u."state" = 'COMMITTED' AND u."unitType" = 'MANUAL_ROW'
          AND u."continuedAsType" = 'CALENDAR_ENTRY' AND u."continuedAsId" = c."id"
        ORDER BY u."committedAt", u."id" LIMIT 1) origin ON true
      LEFT JOIN "DailyWorkEntry" w ON w."id" = origin."entryId" AND w."officerId" = c."ownerId"
      LEFT JOIN "User" owner ON owner."id" = w."officerId"
      LEFT JOIN "User" creator ON creator."id" = COALESCE(c."createdById", c."ownerId")
      WHERE c."id" = ${taskId}`;
  } else if (sourceType === "BILLING_EXCEPTION") {
    sql = Prisma.sql`SELECT "createdAt", NULL::text AS "actorName" FROM "BillingExceptionTask" WHERE "id" = ${taskId}`;
  } else if (sourceType === "CN_PAYMENT") {
    sql = Prisma.sql`SELECT e."createdAt", u."name" AS "actorName" FROM "CnPaymentEvent" e
      LEFT JOIN "User" u ON u."id" = e."recordedById" WHERE e."id" = ${taskId}`;
  } else if (sourceType === "DAILY_WORK_ROW") {
    sql = Prisma.sql`SELECT w."createdAt", u."name" AS "actorName" FROM "DailyWorkEntry" w
      LEFT JOIN "User" u ON u."id" = w."officerId" WHERE w."id" = ${taskId}`;
  } else {
    // Legacy CN task creation time was not recorded separately from the CN request's creation.
    // Do not present the request's timestamp as this task's initiation time.
    return null;
  }
  const row = (await prisma.$queryRaw<{ createdAt: Date; actorName: string | null }[]>(sql))[0];
  return row ? { createdAt: row.createdAt.toISOString(), actorName: row.actorName } : null;
}
