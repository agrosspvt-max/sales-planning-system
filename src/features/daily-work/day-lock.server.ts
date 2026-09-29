import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";

export type DailyWorkDb = typeof prisma | Prisma.TransactionClient;

export interface DailyWorkDayState {
  currentBatchId: string;
  status: "OPEN" | "FINALIZED";
  selfRating: number | null;
  finalizedAt: Date | null;
}

export const draftBatchId = (officerId: string, workDate: string) => `draft:${officerId}:${workDate}`;

export async function loadDailyWorkDay(db: DailyWorkDb, officerId: string, workDate: string): Promise<DailyWorkDayState | null> {
  const rows = await db.$queryRaw<DailyWorkDayState[]>(Prisma.sql`
    SELECT "currentBatchId", "status", "selfRating", "finalizedAt"
    FROM "DailyWorkDay" WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date LIMIT 1`);
  return rows[0] ?? null;
}

/** One concurrency gate for every Daily Work mutation, including Auto Task materialization/rescheduling. */
export async function lockDailyWorkDay(tx: Prisma.TransactionClient, officerId: string, workDate: string): Promise<DailyWorkDayState> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DailyWorkDay" ("id","officerId","workDate","currentBatchId","status","createdAt","updatedAt")
    VALUES (${randomUUID()}, ${officerId}, ${workDate}::date, ${draftBatchId(officerId, workDate)}, 'OPEN', NOW(), NOW())
    ON CONFLICT ("officerId","workDate") DO NOTHING`);
  const rows = await tx.$queryRaw<DailyWorkDayState[]>(Prisma.sql`
    SELECT "currentBatchId", "status", "selfRating", "finalizedAt"
    FROM "DailyWorkDay" WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date FOR UPDATE`);
  const day = rows[0];
  if (!day) throw new ApiError(500, "Daily Work day could not be initialized");
  return day;
}

export function assertDayOpen(day: DailyWorkDayState, message: string): void {
  if (day.status === "FINALIZED") throw new ApiError(409, message);
}

export async function readBatchContext(officerId: string, workDate: string): Promise<{ day: DailyWorkDayState; exists: boolean }> {
  const existing = await loadDailyWorkDay(prisma, officerId, workDate);
  return {
    exists: existing != null,
    day: existing ?? { currentBatchId: draftBatchId(officerId, workDate), status: "OPEN", selfRating: null, finalizedAt: null },
  };
}
