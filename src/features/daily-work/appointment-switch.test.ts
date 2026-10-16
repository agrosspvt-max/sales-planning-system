/** Exercise the real appointment service and settings with a transactional, DB-free store. */
import assert from "node:assert/strict";
import { Prisma, Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { dailyWorkServiceInfrastructureMocks } from "./service-test-mocks";
import * as daily from "@/lib/daily-work";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import type { AuthContext } from "@/lib/http";

type Row = {
  id: string; rowKey: string; officerId: string; batchId: string; workDate: string; section: string; status: string;
  monthlyPlanId: string | null; typedDealerName: string | null; marketName: string | null; marketId: string | null;
  resultStatus: string | null; resultEventId: string | null; reportedDealerName: string | null;
};
const DATE = "2026-10-15";
const SO: AuthContext = { userId: "so1", role: Role.SALES_OFFICER, username: "so1", groupId: "g1" };
const RM = { ...SO, userId: "rm1", role: Role.REGIONAL_MANAGER };
const ADMIN = { ...SO, userId: "admin", role: Role.SUPER_ADMIN };
daily.dailyWorkClock.now = () => new Date(`${DATE}T06:00:00Z`);
let partyPlanningAvailable = true;
let enabled = false, batchId = "draft:so1:2026-10-15", finalized = false, monthlyWrites = 0, monthlyReads = 0;
let rows: Row[] = [];
const plans = [{ id: "plan1", marketId: "market1", marketNameAtPlanning: "Approved Market", opStatus: "NONE" }];
const settingKey = "dailyWork.appointmentPartyPlanningEnabled";
const settings = new Map<string, string>();
function query(q: Prisma.Sql): unknown {
  const sql = q.sql.replace(/\s+/g, " ").trim(), v = q.values;
  if (sql.startsWith('SELECT "rowKey", "typedDealerName"')) return rows.filter((r) => r.officerId === v[0] && r.workDate === v[1] && r.batchId === v[2] && r.status === "DRAFT");
  if (sql.startsWith('SELECT "id", "batchId", "dealerId"')) {
    const report = sql.includes("status\" IN ('PLAN_SUBMITTED'");
    return rows.filter((r) => r.officerId === v[0] && r.workDate === v[2] && (report ? r.batchId !== v[3] && r.status !== "DRAFT" : r.batchId === v[3] && r.status === "DRAFT"));
  }
  if (sql.startsWith('SELECT "monthlyPlanId", "resultStatus"')) return rows.filter((r) => r.id === v[0] && r.officerId === v[1] && r.workDate === v[2] && r.batchId !== v[3] && r.status === "PLAN_SUBMITTED");
  if (sql.startsWith('DELETE FROM "DailyWorkEntry"')) { const keep = v.slice(3); rows = rows.filter((r) => r.officerId !== v[0] || r.workDate !== v[1] || r.batchId !== v[2] || keep.includes(r.rowKey)); return 1; }
  if (sql.startsWith('INSERT INTO "DailyWorkEntry"')) {
    const linked = sql.includes('"monthlyPlanId"'), rowKey = String(v[2]);
    let row = rows.find((r) => r.officerId === v[1] && r.batchId === v[4] && r.rowKey === rowKey);
    if (!row) { row = { id: String(v[0]), officerId: String(v[1]), rowKey, workDate: String(v[3]), batchId: String(v[4]), section: "APPOINTMENT", status: "DRAFT", monthlyPlanId: null, marketId: null, typedDealerName: null, marketName: null, resultStatus: null, resultEventId: null, reportedDealerName: null }; rows.push(row); }
    if (linked) Object.assign(row, { marketName: v[5], monthlyPlanId: v[6], marketId: v[7] });
    else Object.assign(row, { typedDealerName: v[5], marketName: v[6] });
    return 1;
  }
  if (sql.startsWith('UPDATE "DailyWorkEntry" SET "resultStatus"')) { const row = rows.find((r) => r.id === v[2])!; Object.assign(row, { resultStatus: v[0], reportedDealerName: v[1] }); return 1; }
  throw new Error(`Unhandled SQL: ${sql}`);
}
const prisma = {
  $queryRaw: async (q: Prisma.Sql) => query(q), $executeRaw: async (q: Prisma.Sql) => query(q),
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const before = structuredClone(rows);
    try { return await fn(prisma); } catch (e) { rows = before; throw e; }
  },
  systemSetting: { findUnique: async () => ({ value: enabled ? "true" : "false" }) },
  partyMonthlyPlan: { findMany: async ({ where }: { where: Record<string, unknown> }) => { monthlyReads++; if (where.ownerId) { assert.equal(where.ownerId, SO.userId); assert.equal(JSON.stringify(where.seasonMonth), JSON.stringify({ calendarYear: 2026, calendarMonth: 10 })); assert.equal(where.approvalStatus, "APPROVED"); } return plans; } },
};
const load = testLoader({
  ...dailyWorkServiceInfrastructureMocks(prisma as never),
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/daily-work": daily, "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
  "@/lib/feature-flags": { isPartyPlanningEnabled: () => partyPlanningAvailable },
  "@/lib/audit": { writeAudit: async () => ({}) },
  "@/lib/recovery-config": { getAutoTasksEnabled: async () => false, getAppointmentPartyPlanningEnabled: async () => enabled,
    getRecoveryConfig: async () => ({ dueValidation: true, calendarEnabled: true, autoTasksEnabled: false, appointmentPartyPlanningEnabled: settings.get(settingKey) === "true" }),
    saveRecoveryConfig: async (c: { appointmentPartyPlanningEnabled: boolean }) => { settings.set(settingKey, String(c.appointmentPartyPlanningEnabled)); return c; } },
  "./day-lock.server": {
    lockDailyWorkDay: async () => ({ currentBatchId: batchId, status: finalized ? "FINALIZED" : "OPEN" }),
    readBatchContext: async () => ({ exists: true, day: { currentBatchId: batchId, status: "OPEN" } }),
    assertDayOpen: (_day: unknown, message: string) => { if (finalized) throw new TestApiError(409, message); },
  },
  "@/features/party-planning/monthly.server": { ownerSendDocumentsInTx: async () => { monthlyWrites++; throw new Error("Unexpected monthly write"); } },
  "@/features/planning/monthly.server": {}, "@/features/planning/monthly-plan.server": {},
  "@/features/schemes/scheme-planning.server": {}, "@/features/cn-requests/service.server": {},
});
const svc = load<typeof import("./service.server")>("src/features/daily-work/service.server.ts");
const cfg = load<typeof import("../settings/service.server")>("src/features/settings/service.server.ts");
const fail = async (fn: () => Promise<unknown>, status = 409) => assert.rejects(fn, (e: unknown) => (e as TestApiError).status === status);
const save = (rs: unknown[], mode?: boolean, ctx = SO) => svc.saveDailyAppointment(ctx, { workDate: DATE, rows: rs, ...(mode === undefined ? {} : { partyPlanningEnabled: mode }) });
const manual = (name = "Typed Dealer", market = "Typed Market") => ({ rowId: "manual1", dealerName: name, marketName: market });
async function main() {
  // Admin setting rejects owners and truthy strings; missing field defaults OFF for older settings clients.
  for (const ctx of [SO, RM]) await fail(() => cfg.updateRecoveryConfig(ctx, { dueValidation: true, appointmentPartyPlanningEnabled: true }), 403);
  partyPlanningAvailable = false;
  await fail(() => cfg.updateRecoveryConfig(ADMIN, { dueValidation: true, appointmentPartyPlanningEnabled: true }), 422);
  partyPlanningAvailable = true;
  await cfg.updateRecoveryConfig(ADMIN, { dueValidation: true, appointmentPartyPlanningEnabled: true });
  assert.equal(settings.get(settingKey), "true");
  await cfg.updateRecoveryConfig(ADMIN, { dueValidation: true });
  assert.equal(settings.get(settingKey), "false");
  await assert.rejects(() => cfg.updateRecoveryConfig(ADMIN, { dueValidation: true, appointmentPartyPlanningEnabled: "false" }));

  // OFF creates/edits manual rows for SO and RM, without even reading monthly planning.
  let p = await svc.getDailyAppointment(SO, DATE);
  assert.equal(p.partyPlanningEnabled, false); assert.equal(p.eligibleMarkets.length, 0);
  await save([manual()], false); assert.equal(rows[0].typedDealerName, "Typed Dealer"); assert.equal(rows[0].monthlyPlanId, null);
  await save([manual("Edited Dealer")], false); assert.equal(rows[0].typedDealerName, "Edited Dealer");
  await save([{ rowId: "rm-row", dealerName: "RM Dealer" }], false, RM);
  assert.equal(rows.find((r) => r.officerId === "rm1")?.typedDealerName, "RM Dealer");
  assert.equal(monthlyReads, 0); assert.equal(monthlyWrites, 0);
  await save([{ rowId: "manual1", dealerName: "   " }], false);
  assert.equal(rows.find((r) => r.rowKey === "manual1")?.typedDealerName, "", "unfinished rows can be kept as drafts");
  await save([manual("Edited Dealer")], false);
  await fail(() => save([{ rowId: "plan1", monthlyPlanId: "plan1" }], false));
  await fail(() => svc.recordAppointedResult(SO, { workDate: DATE, entryId: rows[0].id }));

  // A stale OFF page cannot overwrite drafts after enabling; ON validates ownership/month eligibility.
  enabled = true;
  const before = structuredClone(rows);
  await fail(() => save([manual()], false)); assert.deepEqual(rows, before);
  await fail(() => save([{ rowId: "new", dealerName: "Forged Manual" }], true), 422);
  await save([{ rowId: "blank-selector" }], true);
  p = await svc.getDailyAppointment(SO, DATE);
  assert.equal(p.rows[0].legacy, false, "an unfinished linked selection reloads as a selector");
  await save([], true);
  // Restore an existing manual draft to exercise mode compatibility.
  enabled = false; await save([manual("Edited Dealer")], false); enabled = true;
  const currentManual = manual("Edited Dealer");
  await save([currentManual, { rowId: "plan1", monthlyPlanId: "plan1" }], true);
  p = await svc.getDailyAppointment(SO, DATE); assert.equal(p.monthlyDealerPlan, 1); assert.equal(p.eligibleMarkets.length, 1);
  assert.equal(rows.find((r) => r.rowKey === "manual1")?.monthlyPlanId, null, "manual name is never matched to a market");
  await fail(() => save([{ rowId: "foreign", monthlyPlanId: "foreign" }], true), 422);
  assert.equal(rows.some((r) => r.rowKey === "plan1"), true, "invalid linked save rolled back deletes");

  // Turning OFF keeps links/snapshots and blocks stale linked writes and the popup endpoint.
  enabled = false;
  await fail(() => save([{ rowId: "plan1", monthlyPlanId: "plan1" }], true));
  await save([currentManual, { rowId: "plan1", monthlyPlanId: "plan1" }], false);
  assert.equal(rows.find((r) => r.rowKey === "plan1")?.monthlyPlanId, "plan1");
  await fail(() => save([{ rowId: "plan1", dealerName: "Convert link" }], false));

  // Submitted manual results are plain records, independent of the current switch. Existing linked
  // results in OFF mode likewise have no monthly side effects; ON requires the protected popup.
  for (const r of rows) if (r.officerId === SO.userId) r.status = "PLAN_SUBMITTED";
  // A previously submitted empty placeholder must not create an appointment result requirement.
  rows.push({ ...rows.find((r) => r.rowKey === "manual1")!, id: "historic-blank", rowKey: "historic-blank", typedDealerName: "  ", marketName: null });
  batchId = "next-batch";
  p = await svc.getDailyAppointment(SO, DATE, undefined, "REPORT");
  assert.equal(p.rows.some((r) => r.entryId === "historic-blank"), false);
  const manualRow = rows.find((r) => r.rowKey === "manual1")!, linkedRow = rows.find((r) => r.rowKey === "plan1")!;
  await svc.enterAppointmentStatus(SO, { workDate: DATE, entries: [{ entryId: manualRow.id, status: "APPOINTED" }] });
  assert.equal(manualRow.resultStatus, "APPOINTED");
  enabled = true;
  await fail(() => svc.enterAppointmentStatus(SO, { workDate: DATE, entries: [{ entryId: linkedRow.id, status: "APPOINTED" }] }));
  enabled = false;
  await svc.enterAppointmentStatus(SO, { workDate: DATE, entries: [{ entryId: linkedRow.id, status: "APPOINTED" }] });
  assert.equal(rows.find((r) => r.id === linkedRow.id)?.resultStatus, "APPOINTED");
  await svc.enterAppointmentStatus(SO, { workDate: DATE, entries: [{ entryId: manualRow.id, status: "NOT_APPOINTED", dealerName: "Must clear" }] });
  assert.equal(rows.find((r) => r.id === manualRow.id)?.reportedDealerName, null);
  finalized = true;
  await fail(() => svc.enterAppointmentStatus(SO, { workDate: DATE, entries: [{ entryId: manualRow.id, status: "APPOINTED" }] }));
  assert.equal(monthlyWrites, 0);
  console.log("appointment-switch.test.ts — settings permissions, manual/linked saves, results, stale pages and history passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
