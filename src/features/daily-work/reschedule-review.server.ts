import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { describeTasks } from "@/features/tasks/task-analysis.server";
import { buildReschedulingReview, taskKey, type ReschedulingReview, type ReviewRowInput, type RescheduleEventInput, type TaskDescriptor } from "./reschedule-review";

// Same business-date expression as Performance's Task Activity, so the action list reproduces its "N reschedules" exactly.
const ISTDATE = Prisma.sql`((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date`;
const EMPTY: ReschedulingReview = { rows: {}, tasks: [], actions: [] };

interface EventRow { id: string; sourceType: string; sourceId: string; ownerId: string; previousDate: string; newDate: string; actorName: string; reason: string | null; createdAt: Date; actionDate: string }
const toInput = (e: EventRow): RescheduleEventInput => ({ ...e, createdAt: e.createdAt.toISOString() });

/**
 * READ-ONLY rescheduling facts for one employee's Daily Work review of `date`: four batched reads regardless of how many tasks moved (touching events, the lifetime history of those tasks,
 * the manual-to-Calendar continuations of the shown rows, and the task descriptors). Authorization is the caller's (the review detail already checked the officer is in scope).
 * Any failure degrades to "no rescheduling information"; it never takes the rest of the detail down.
 */
export async function loadReschedulingReview(officerId: string, date: string, rows: readonly ReviewRowInput[]): Promise<ReschedulingReview> {
  try {
    const manualEntryIds = rows.filter((r) => r.units.some((u) => u.unitType === "MANUAL_ROW")).map((r) => r.entryId);
    const [touching, continued] = await Promise.all([
      prisma.$queryRaw<{ sourceType: string; sourceId: string }[]>(Prisma.sql`
        SELECT DISTINCT e."sourceType", e."sourceId" FROM "TaskRescheduleEvent" e
        WHERE e."ownerId" = ${officerId} AND (e."previousDate" = ${date}::date OR e."newDate" = ${date}::date OR ${ISTDATE} = ${date}::date)`),
      manualEntryIds.length === 0 ? Promise.resolve([] as { unitId: string; continuedAsType: string; continuedAsId: string }[]) : prisma.$queryRaw<{ unitId: string; continuedAsType: string; continuedAsId: string }[]>(Prisma.sql`
        SELECT u."unitId", u."continuedAsType", u."continuedAsId" FROM "DailyTaskOutcome" u
        WHERE u."state" = 'COMMITTED' AND u."unitType" = 'MANUAL_ROW' AND u."unitId" IN (${Prisma.join(manualEntryIds)}) AND u."continuedAsType" IS NOT NULL AND u."continuedAsId" IS NOT NULL`),
    ]);
    const continuations = new Map(continued.map((c) => [c.unitId, { type: c.continuedAsType, id: c.continuedAsId }]));
    // The shown rows' own tasks (plus manual continuations) are needed even when their move happened on another date: their lifetime count and arrival/departure.
    const identities = new Map<string, { sourceType: string; sourceId: string }>();
    for (const t of touching) identities.set(taskKey(t.sourceType, t.sourceId), t);
    for (const c of continuations.values()) identities.set(taskKey(c.type, c.id), { sourceType: c.type, sourceId: c.id });
    for (const r of rows) for (const u of r.units) if (u.unitType !== "MANUAL_ROW") identities.set(taskKey(u.unitType, u.unitId), { sourceType: u.unitType, sourceId: u.unitId });
    if (identities.size === 0) return EMPTY;
    const list = [...identities.values()];
    const [events, described] = await Promise.all([
      prisma.$queryRaw<EventRow[]>(Prisma.sql`
        SELECT e."id", e."sourceType", e."sourceId", e."ownerId", e."previousDate"::text AS "previousDate", e."newDate"::text AS "newDate", e."actorName", e."reason", e."createdAt", ${ISTDATE}::text AS "actionDate"
        FROM "TaskRescheduleEvent" e WHERE e."sourceId" IN (${Prisma.join(list.map((t) => t.sourceId))}) ORDER BY e."createdAt", e."id"`),
      describeTasks(list),
    ]);
    const known = new Set(list.map((t) => taskKey(t.sourceType, t.sourceId)));
    const descriptors = new Map<string, TaskDescriptor>();
    for (const [k, t] of described) descriptors.set(k, { dealerName: t.dealerName, marketName: t.marketName, description: t.description, section: t.section, historyState: t.historyState });
    return buildReschedulingReview({ officerId, date, events: events.filter((e) => known.has(taskKey(e.sourceType, e.sourceId))).map(toInput), descriptors, rows, continuations });
  } catch (error) {
    console.error("[daily-work review] rescheduling information unavailable", error instanceof Error ? error.name : "Unknown error");
    return EMPTY;
  }
}
