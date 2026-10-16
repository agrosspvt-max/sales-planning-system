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
    // Calendar Daily Task materialization needs its own DB-backed test (calendar-task-materialization.test.ts); here it is inert.
    "./calendar-task-materialization.server": {
      materializeDueCalendarTasks: async () => ({ materialized: 0 }),
      calendarLinkedEntryIds: async () => [],
    },
    // Billing Exception tasks (own DB-backed suite: billing-task.integration.ts + billing-task.test.ts); inert here.
    "./billing-task.server": {
      billingTasksForEntries: async () => [],
      billingLinkedEntryIds: async () => [],
      countUnconfirmedBillingTasks: async () => 0,
      BILLING_CONTRIBUTION_UNION: Prisma.empty,
    },
    // Daily Work → Dealer Appointment ↔ Monthly Party Planning (real-database suite: appointment.integration.ts); inert here.
    "@/features/party-planning/monthly.server": {
      ownerSendDocumentsInTx: async () => { throw new Error("Monthly Party Planning is not part of this fake"); },
    },
    // The Auto Tasks visibility flag defaults OFF; a stub keeps status reads DB-double-free.
    "@/lib/recovery-config": {
      getAutoTasksEnabled: async () => false,
      getAppointmentPartyPlanningEnabled: async () => false,
    },
    // One row per scheduled task (own suites: task-rows.test + the real-database integration); inert here.
    "./task-rows.server": {
      isTaskRowKey: (key: string) => key.startsWith("t:"),
      splitCombinedDraftRows: async () => 0,
      hasCombinedDraftRows: async () => false,
      submittedManualDealerIds: async () => [],
    },
    // Task outcomes (Daily Report): own suites — daily-work/task-outcome.test.ts + billing-task.integration.ts; inert here (rows are treated as outcome-less).
    "./task-outcome.server": {
      commitTaskOutcomes: async () => ({ completed: 0, rescheduled: 0, abandoned: 0 }),
      readRowUnits: async () => new Map(),
      rescheduledEntryIds: async () => [],
      writeOutcomeDrafts: async () => 0,
    },
    // Performance → Task Activity (own suites: tasks/task-analysis.test.ts + the real-database integration); inert here.
    "@/features/tasks/task-analysis.server": { getTaskActivity: async () => new Map() },
    // Dealer DISPLAY-name layer — stubbed to "no aliases" so tests keep asserting the real dealer names.
    "@/lib/dealer-display-name.server": {
      loadDealerAliasNameMap: async () => new Map(),
      resolveDealerDisplayNames: async () => new Map(),
      decorateDealerNames: async (rows: unknown[]) => rows.map((r) => ({ ...(r as object) })),
      dealerDisplayName: (name: string) => name,
    },
  };
}

/**
 * The result row of the combined "section facts" statement (data presence of every section + visits / others + the persisted No-Plan CSV) computed from a fake's
 * in-memory DailyWorkEntry rows — for fakes that answer the service's raw SQL. `rows` = the entries of ONE (officer, date, batch).
 */
export function sectionFactsRow(rows: ReadonlyArray<{ section: string; rowKey?: string; typedDealerName?: string | null; marketName?: string | null; monthlyPlanId?: string | null; dealerVisits?: number | null; newPartyVisits?: number | null; others?: string | null; noPlanSections?: string | null }>) {
  const count = (pred: (r: (typeof rows)[number]) => boolean) => BigInt(rows.filter(pred).length);
  const summary = rows.filter((r) => r.section === "SUMMARY" && (r.rowKey === undefined || r.rowKey === "SUMMARY" || r.rowKey === "__SUMMARY__"));
  return {
    sales: count((r) => r.section === "SALES"), recovery: count((r) => r.section === "RECOVERY"), conversion: count((r) => r.section === "SCHEME_CONVERSION"),
    appointment: count((r) => r.section === "APPOINTMENT"),
    invalidAppointments: count((r) => r.section === "APPOINTMENT" && !r.monthlyPlanId && (!(r.typedDealerName ?? "").trim() || !(r.marketName ?? "").trim())),
    visits: summary.length ? summary.some((r) => r.dealerVisits != null || r.newPartyVisits != null) : null,
    others: summary.length ? summary.some((r) => (r.others ?? "").trim() !== "") : null,
    noPlanSections: summary.map((r) => r.noPlanSections ?? null).find((v) => v != null) ?? null,
  };
}
