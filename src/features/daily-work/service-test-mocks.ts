import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

type TestDb = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<unknown>;
};

const draftBatchId = (officerId: string, workDate: string) => `draft:${officerId}:${workDate}`;

/** Shared infrastructure doubles for VM-loaded Daily Work service tests. */
export function dailyWorkServiceInfrastructureMocks(prisma: TestDb) {
  const load = async (db: TestDb, officerId: string, workDate: string) => {
    const rows = await db.$queryRaw<Array<{ currentBatchId: string; status: "OPEN" | "FINALIZED"; selfRating: number | null; finalizedAt: Date | null }>>(Prisma.sql`
      SELECT "currentBatchId", "status", "selfRating", "finalizedAt"
      FROM "DailyWorkDay" WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date LIMIT 1`);
    return rows[0] ?? null;
  };
  return {
    "./day-lock.server": {
      draftBatchId,
      loadDailyWorkDay: load,
      lockDailyWorkDay: async (tx: TestDb, officerId: string, workDate: string) => {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "DailyWorkDay" ("id","officerId","workDate","currentBatchId","status","createdAt","updatedAt")
          VALUES (${randomUUID()}, ${officerId}, ${workDate}::date, ${draftBatchId(officerId, workDate)}, 'OPEN', NOW(), NOW())
          ON CONFLICT ("officerId","workDate") DO NOTHING`);
        const day = await load(tx, officerId, workDate);
        if (!day) throw new Error("Daily Work day could not be initialized");
        return day;
      },
      assertDayOpen: (day: { status: string }, message: string) => {
        if (day.status === "FINALIZED") throw Object.assign(new Error(message), { status: 409 });
      },
      readBatchContext: async (officerId: string, workDate: string) => {
        const day = await load(prisma, officerId, workDate);
        return { exists: day != null, day: day ?? { currentBatchId: draftBatchId(officerId, workDate), status: "OPEN", selfRating: null, finalizedAt: null } };
      },
    },
    "./auto-task-materialization.server": {
      materializeDueDailyWorkTasks: async () => ({ materializedTasks: 0, affectedDealers: 0, finalized: false }),
      materializeDueDailyWorkTasksInTransaction: async () => ({ materializedTasks: 0, affectedDealers: 0, finalized: false }),
      autoTasksApplyToRole: (role: string) => role === "SALES_OFFICER" || role === "REGIONAL_MANAGER", // mirrors the real rule (asserted in auto-task-materialization.test.ts)
    },
    // The Auto Tasks visibility flag defaults OFF; a stub keeps status reads DB-double-free.
    "@/lib/recovery-config": {
      getAutoTasksEnabled: async () => false,
    },
    // Dealer DISPLAY-name layer — stubbed to "no aliases" so tests keep asserting the real dealer names.
    "@/lib/dealer-display-name.server": {
      loadDealerAliasNameMap: async () => new Map(),
      resolveDealerDisplayNames: async () => new Map(),
      decorateDealerNames: async (rows: unknown[]) => rows.map((r) => ({ ...(r as object) })),
      dealerDisplayName: (name: string) => name,
    },
  };
}
