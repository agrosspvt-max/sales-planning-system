import "server-only";
import { Prisma, type PlanStatus } from "@prisma/client";

/**
 * ONE rule for every Sales Seasonal / Sales Monthly / Recovery write that depends on the plan being editable (line / entry saves, No Plan,
 * Submit): the transaction first takes the plan row's lock (SELECT … FOR UPDATE) and re-reads status + lifecycle from that locked row.
 *
 *  - A save and a Submit of the same plan therefore run one after the other, never interleaved: a save that arrives after Submit sees the
 *    new status and is refused (409); a Submit that arrives while a save runs waits for it and checks completion on the SAVED values.
 *  - Status / lifecycle changes elsewhere (approve, return, recall, close / deactivate — which UPDATE the same row, parents before children)
 *    take the same row lock implicitly, so they serialize with these writes too. Each write locks exactly ONE plan row, always first, so the
 *    lock order is the same everywhere and no deadlock cycle can form.
 *  - The lock is held only for the transaction's own statements (no browser or external work happens inside it).
 */
type Db = Pick<Prisma.TransactionClient, "$queryRaw">;

export interface LockedSeasonPlan { id: string; status: PlanStatus; lifecycleState: string; officerId: string; seasonId: string; seasonStatus: string }
export interface LockedMonthlyPlan { id: string; status: PlanStatus; lifecycleState: string; officerId: string; seasonPlanId: string; seasonMonthId: string; parentLifecycleState: string; monthlyMode: string }
export interface LockedRecoveryPlan { id: string; status: PlanStatus; lifecycleState: string; officerId: string; weeklyEditEnabled: boolean; parentLifecycleState: string | null }

export async function lockSeasonPlan(db: Db, id: string): Promise<LockedSeasonPlan | null> {
  const rows = await db.$queryRaw<LockedSeasonPlan[]>(Prisma.sql`
    SELECT p."id", p."status"::text AS "status", p."lifecycleState", p."officerId", p."seasonId", s."status"::text AS "seasonStatus"
    FROM "SeasonPlan" p JOIN "Season" s ON s."id" = p."seasonId"
    WHERE p."id" = ${id}
    FOR UPDATE OF p`);
  return rows[0] ?? null;
}

export async function lockMonthlyPlan(db: Db, id: string): Promise<LockedMonthlyPlan | null> {
  const rows = await db.$queryRaw<LockedMonthlyPlan[]>(Prisma.sql`
    SELECT m."id", m."status"::text AS "status", m."lifecycleState", m."officerId", m."seasonPlanId", m."seasonMonthId", p."lifecycleState" AS "parentLifecycleState",
           s."monthlyMode"
    FROM "MonthlyPlan" m JOIN "SeasonPlan" p ON p."id" = m."seasonPlanId" JOIN "Season" s ON s."id" = p."seasonId"
    WHERE m."id" = ${id}
    FOR UPDATE OF m`);
  return rows[0] ?? null;
}

export async function lockRecoveryPlan(db: Db, id: string): Promise<LockedRecoveryPlan | null> {
  const rows = await db.$queryRaw<LockedRecoveryPlan[]>(Prisma.sql`
    SELECT r."id", r."status"::text AS "status", r."lifecycleState", r."officerId", r."weeklyEditEnabled", p."lifecycleState" AS "parentLifecycleState"
    FROM "RecoveryPlan" r LEFT JOIN "SeasonPlan" p ON p."id" = r."seasonPlanId"
    WHERE r."id" = ${id}
    FOR UPDATE OF r`);
  return rows[0] ?? null;
}

/** A raw bulk write that hit a foreign key (e.g. a pack size deleted meanwhile): the same answer Prisma's P2003 gets from the route handler. */
export function isForeignKeyViolation(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  return e?.code === "P2003" || (e?.code === "P2010" && (e.meta?.code === "23503" || /23503|foreign key/i.test(e.message ?? "")));
}
