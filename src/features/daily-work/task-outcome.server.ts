import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { cnRequestExpiryDateKey, isCnSundayDateKey } from "@/lib/cn-request";
import { cnTaskWindowEnd, effectiveCnStage } from "@/lib/cn-expiry";
import { currentBusinessDate } from "@/lib/daily-work";
import { recordTaskReschedule, type TaskSourceType } from "@/features/tasks/task-history.server";
import {
  OUTCOME_UNIT_TYPES, outcomeUnitIsAuto, outcomeUnitSource, rowActualFromOutcomes, sanitizeOutcomeFields, validateOutcome, roundMoney,
  type AbandonReasonCode, type OutcomeError, type OutcomeFields, type OutcomeUnitType, type TaskOutcome,
} from "@/lib/task-outcome";
import type { DailyWorkDb } from "./day-lock.server";

/**
 * Daily Report → Sales / Recovery TASK OUTCOMES (storage + effects). A dealer row can carry several source tasks (Billing Exception, CN, Calendar) plus a manual part; each is
 * an identifiable UNIT with its own outcome — nothing is split by guesswork. Units are frozen the first time the (already submitted) row is reported on: after plan submission the
 * source links cannot change, so the snapshot equals what was planned. Drafts only store the officer's choices; the effects (reschedule / abandon) happen ONLY in
 * commitTaskOutcomes, inside the transaction that finalizes the report.
 */

export type Labels = Record<string, string>;
const SOURCE_TYPE: Record<Exclude<OutcomeUnitType, "MANUAL_ROW">, TaskSourceType> = { BILLING_EXCEPTION: "BILLING_EXCEPTION", CN_PAYMENT: "CN_PAYMENT", CN_LEGACY: "CN_LEGACY", CALENDAR_ENTRY: "CALENDAR_ENTRY" };
const RANK: Record<OutcomeUnitType, number> = { BILLING_EXCEPTION: 0, CN_PAYMENT: 1, CN_LEGACY: 2, CALENDAR_ENTRY: 3, MANUAL_ROW: 4 };

export interface EntryFacts { id: string; officerId: string; workDate: string; section: string; dealerId: string | null; todaysPlan: number; todaysActual: number | null; entryType: string; schemeId: string | null }
/** `blocked`: the CN is Expired — its task can be neither rescheduled nor abandoned (that would bypass the expiry) until an Admin reopens the CN. */
export interface DateRule { maxDate: string | null; noSunday: boolean; blocked?: boolean }
export interface TaskUnitDto {
  unitType: OutcomeUnitType; unitId: string; type: "MANUAL" | "AUTO"; source: "BILLING_EXCEPTION" | "CN_REQUEST" | null; plannedAmount: number;
  outcome: TaskOutcome | null; actualAmount: number | null; nextDate: string | null; reason: string | null; reasonCode: AbandonReasonCode | null; state: "DRAFT" | "COMMITTED";
  committedAt: string | null; committedByName: string | null;
  /** Set when this occurrence IS a rescheduled one (the date it was moved from) — shown as the Rescheduled badge. */
  rescheduledFrom: string | null; rescheduleCount: number; dateRule: DateRule | null;
}
export interface RowUnits { legacy: boolean; units: TaskUnitDto[] }

interface LiveUnit { unitType: OutcomeUnitType; unitId: string; plannedAmount: number }
interface OutcomeRow {
  id: string; entryId: string; unitType: OutcomeUnitType; unitId: string; officerId: string; workDate: string; section: string; plannedAmount: string;
  outcome: TaskOutcome | null; actualAmount: string | null; nextDate: string | null; reason: string | null; reasonCode: AbandonReasonCode | null; state: "DRAFT" | "COMMITTED";
  committedAt: Date | null; committedByName: string | null;
}
const OUTCOME_COLS = Prisma.sql`o."id", o."entryId", o."unitType", o."unitId", o."officerId", o."workDate"::text AS "workDate", o."section", o."plannedAmount"::text AS "plannedAmount", o."outcome", o."actualAmount"::text AS "actualAmount", o."nextDate"::text AS "nextDate", o."reason", o."reasonCode", o."state", o."committedAt", o."committedByName"`;
const ids = (list: readonly string[]) => Prisma.join(list);

/** The tasks currently linked to the given (submitted) rows, from their own source tables, plus each row's manual remainder. */
async function liveUnits(db: DailyWorkDb, entries: readonly EntryFacts[]): Promise<Map<string, LiveUnit[]>> {
  const out = new Map<string, LiveUnit[]>(entries.map((e) => [e.id, []]));
  if (entries.length === 0) return out;
  const entryIds = entries.map((e) => e.id);
  // A transaction uses one connection: Promise.all still takes four network round trips.
  const linkedRows = await db.$queryRaw<{ id: string; entryId: string; c: string; unitType: OutcomeUnitType }[]>(Prisma.sql`
    SELECT t."id", t."dailyWorkEntryId" AS "entryId", t."dailyWorkContribution"::text AS "c", 'BILLING_EXCEPTION' AS "unitType"
      FROM "BillingExceptionTask" t WHERE t."dailyWorkEntryId" IN (${ids(entryIds)}) AND t."abandonedAt" IS NULL
    UNION ALL SELECT e."id", e."dailyWorkEntryId", e."dailyWorkContribution"::text, 'CN_PAYMENT'
      FROM "CnPaymentEvent" e WHERE e."dailyWorkEntryId" IN (${ids(entryIds)})
    UNION ALL SELECT c."id", c."legacyDailyWorkEntryId", c."legacyDailyWorkContribution"::text, 'CN_LEGACY'
      FROM "CnRequest" c WHERE c."legacyDailyWorkEntryId" IN (${ids(entryIds)})
    UNION ALL SELECT c."id", c."dailyWorkEntryId", c."dailyWorkContribution"::text, 'CALENDAR_ENTRY'
      FROM "CalendarEntry" c WHERE c."dailyWorkEntryId" IN (${ids(entryIds)}) AND c."abandonedAt" IS NULL`);
  for (const r of linkedRows) out.get(r.entryId)?.push({ unitType: r.unitType, unitId: r.id, plannedAmount: Number(r.c ?? 0) });
  for (const e of entries) {
    const list = out.get(e.id)!;
    const linked = list.reduce((s, u) => s + u.plannedAmount, 0);
    const manual = roundMoney(e.todaysPlan - linked);
    if (manual > 0.004) list.push({ unitType: "MANUAL_ROW", unitId: e.id, plannedAmount: manual });
    list.sort((a, b) => RANK[a.unitType] - RANK[b.unitType] || a.unitId.localeCompare(b.unitId));
  }
  return out;
}

/** CN tasks follow the CN rules for their date: never a Sunday, never after the end of the CN's current permitted window (expiry, or grace once the expiry date has passed); Expired CNs are blocked. */
export async function dateRules(db: DailyWorkDb, units: readonly { unitType: OutcomeUnitType; unitId: string }[]): Promise<Map<string, DateRule>> {
  const rules = new Map<string, DateRule>();
  const cnEvents = units.filter((u) => u.unitType === "CN_PAYMENT").map((u) => u.unitId), cnLegacy = units.filter((u) => u.unitType === "CN_LEGACY").map((u) => u.unitId);
  const queries: Prisma.Sql[] = [];
  const cols = Prisma.sql`c."acceptedAt", c."cnExpiryDays" AS "days", c."cnExpiryDate"::text AS "expiry", c."cnGraceDays" AS "grace", c."cnPolicyStage" AS "stage", (c."paymentTrackingMode" = 'PAYMENT_V1' AND COALESCE(c."paymentOutstandingAmount", 0) > 0) AS "awaiting"`;
  if (cnEvents.length) queries.push(Prisma.sql`SELECT e."id", ${cols}, 'CN_PAYMENT' AS "unitType" FROM "CnPaymentEvent" e JOIN "CnRequest" c ON c."id" = e."cnRequestId" WHERE e."id" IN (${ids(cnEvents)})`);
  if (cnLegacy.length) queries.push(Prisma.sql`SELECT c."id", ${cols}, 'CN_LEGACY' AS "unitType" FROM "CnRequest" c WHERE c."id" IN (${ids(cnLegacy)})`);
  if (queries.length) {
    const rows = await db.$queryRaw<{ id: string; acceptedAt: Date | null; days: number | null; expiry: string | null; grace: number | null; stage: string | null; awaiting: boolean; unitType: string }[]>(Prisma.sql`${Prisma.join(queries, " UNION ALL ")}`);
    const now = new Date(), today = currentBusinessDate();
    for (const r of rows) {
      const expiry = r.expiry ?? (r.acceptedAt && r.days != null ? cnRequestExpiryDateKey(r.acceptedAt, r.days) : null);
      const state = { cnExpiryDate: expiry, cnGraceDays: r.grace, cnPolicyStage: r.stage };
      const stage = effectiveCnStage(state, r.awaiting, now);
      const blocked = stage === "EXPIRED";
      rules.set(`${r.unitType}:${r.id}`, { maxDate: blocked ? null : cnTaskWindowEnd({ ...state, cnPolicyStage: stage }, today), noSunday: true, blocked });
    }
  }
  return rules;
}
/** An Expired CN's task can only be left as it is: reschedule and abandon are refused (reopen the CN first). */
export function expiredRuleError(rule: DateRule | null | undefined, outcome: string | null | undefined): "cn_expired" | null {
  return rule?.blocked && (outcome === "RESCHEDULED" || outcome === "ABANDONED") ? "cn_expired" : null;
}
export function dateRuleError(rule: DateRule | null | undefined, date: string): OutcomeError | "date_cn_rule" | null {
  if (!rule) return null;
  if (rule.noSunday && isCnSundayDateKey(date)) return "date_cn_rule";
  if (rule.maxDate && date > rule.maxDate) return "date_cn_rule";
  return null;
}

/* ------------------------------------------------ read ------------------------------------------------ */

/**
 * The tasks of each given submitted row, for the Daily Report. A row that already holds a (legacy) reported actual and no outcome rows predates this workflow: no tasks,
 * read-only. Reads never write.
 */
export async function readRowUnits(db: DailyWorkDb, entries: readonly EntryFacts[]): Promise<Map<string, RowUnits>> {
  const result = new Map<string, RowUnits>();
  if (entries.length === 0) return result;
  const rows = await db.$queryRaw<OutcomeRow[]>(Prisma.sql`SELECT ${OUTCOME_COLS} FROM "DailyTaskOutcome" o WHERE o."entryId" IN (${ids(entries.map((e) => e.id))})`);
  const byEntry = new Map<string, OutcomeRow[]>();
  for (const r of rows) byEntry.set(r.entryId, [...(byEntry.get(r.entryId) ?? []), r]);
  const needLive = entries.filter((e) => !byEntry.has(e.id) && e.todaysActual === null);
  const live = await liveUnits(db, needLive);
  const flat: { entry: EntryFacts; unit: Omit<TaskUnitDto, "rescheduledFrom" | "rescheduleCount" | "dateRule"> }[] = [];
  for (const e of entries) {
    const stored = byEntry.get(e.id);
    if (stored) {
      for (const r of stored) flat.push({ entry: e, unit: { unitType: r.unitType, unitId: r.unitId, type: outcomeUnitIsAuto(r.unitType) ? "AUTO" : "MANUAL", source: outcomeUnitSource(r.unitType), plannedAmount: Number(r.plannedAmount), outcome: r.outcome, actualAmount: r.actualAmount == null ? null : Number(r.actualAmount), nextDate: r.nextDate, reason: r.reason, reasonCode: r.reasonCode, state: r.state, committedAt: r.committedAt?.toISOString() ?? null, committedByName: r.committedByName } });
    } else if (e.todaysActual === null) {
      for (const u of live.get(e.id) ?? []) flat.push({ entry: e, unit: { unitType: u.unitType, unitId: u.unitId, type: outcomeUnitIsAuto(u.unitType) ? "AUTO" : "MANUAL", source: outcomeUnitSource(u.unitType), plannedAmount: u.plannedAmount, outcome: null, actualAmount: null, nextDate: null, reason: null, reasonCode: null, state: "DRAFT", committedAt: null, committedByName: null } });
    }
  }
  const sourceIds = flat.filter((f) => f.unit.unitType !== "MANUAL_ROW").map((f) => f.unit.unitId);
  const [events, rules] = await Promise.all([
    sourceIds.length ? db.$queryRaw<{ sourceType: string; sourceId: string; previousDate: string; newDate: string }[]>(Prisma.sql`SELECT e."sourceType", e."sourceId", e."previousDate"::text AS "previousDate", e."newDate"::text AS "newDate" FROM "TaskRescheduleEvent" e WHERE e."sourceId" IN (${ids(sourceIds)}) ORDER BY e."createdAt", e."id"`) : [],
    dateRules(db, flat.map((f) => f.unit)),
  ]);
  for (const e of entries) result.set(e.id, { legacy: !byEntry.has(e.id) && e.todaysActual !== null, units: [] });
  for (const f of flat) {
    const mine = f.unit.unitType === "MANUAL_ROW" ? [] : events.filter((ev) => ev.sourceId === f.unit.unitId && ev.sourceType === SOURCE_TYPE[f.unit.unitType as Exclude<OutcomeUnitType, "MANUAL_ROW">]);
    const arrived = mine.filter((m) => m.newDate <= f.entry.workDate).at(-1); // the latest move that brought it to (or before) this day
    result.get(f.entry.id)!.units.push({ ...f.unit, rescheduledFrom: arrived?.previousDate ?? null, rescheduleCount: mine.length, dateRule: rules.get(`${f.unit.unitType}:${f.unit.unitId}`) ?? null });
  }
  for (const r of result.values()) r.units.sort((a, b) => RANK[a.unitType] - RANK[b.unitType] || a.unitId.localeCompare(b.unitId));
  return result;
}

/**
 * Recorded date changes per Daily Work row, for the Rescheduled badge and its count in Daily Plan / Report. One batched query for all rows. A count is the number of
 * TaskRescheduleEvent rows of the row's task, found by the task's stable identity (source type + source id — never dealer, date or the occurrence id), so it carries across dates.
 * A row linking several tasks reports the most-moved one (counts of different tasks are never added). Rows whose tasks were never moved are absent.
 */
export async function rescheduleCountsByEntry(db: DailyWorkDb, entries: readonly { id: string; workDate: string }[]): Promise<Record<string, number>> {
  if (entries.length === 0) return {};
  const rows = await db.$queryRaw<{ entryId: string; moves: number }[]>(Prisma.sql`
    SELECT x."entryId", MAX(c."n")::int AS "moves" FROM (
      SELECT t."dailyWorkEntryId" AS "entryId", 'BILLING_EXCEPTION' AS "type", t."id" AS "id" FROM "BillingExceptionTask" t WHERE t."dailyWorkEntryId" IN (${ids(entries.map((e) => e.id))})
      UNION ALL SELECT e."dailyWorkEntryId", 'CN_PAYMENT', e."id" FROM "CnPaymentEvent" e WHERE e."dailyWorkEntryId" IN (${ids(entries.map((e) => e.id))})
      UNION ALL SELECT c."legacyDailyWorkEntryId", 'CN_LEGACY', c."id" FROM "CnRequest" c WHERE c."legacyDailyWorkEntryId" IN (${ids(entries.map((e) => e.id))})
      UNION ALL SELECT c."dailyWorkEntryId", 'CALENDAR_ENTRY', c."id" FROM "CalendarEntry" c WHERE c."dailyWorkEntryId" IN (${ids(entries.map((e) => e.id))})
    ) x
    JOIN LATERAL (SELECT COUNT(*) AS "n" FROM "TaskRescheduleEvent" ev WHERE ev."sourceType" = x."type" AND ev."sourceId" = x."id") c ON c."n" > 0
    WHERE x."entryId" IS NOT NULL GROUP BY x."entryId"`);
  return Object.fromEntries(rows.map((r) => [r.entryId, Number(r.moves)]));
}

/** Rows (of the given entries) whose tasks carry a Rescheduled history. */
export async function rescheduledEntryIds(db: DailyWorkDb, entries: readonly { id: string; workDate: string }[]): Promise<string[]> {
  return Object.keys(await rescheduleCountsByEntry(db, entries));
}

/* ------------------------------------------------ draft write ------------------------------------------------ */

export function outcomeMessage(L: Labels, code: OutcomeError | "date_cn_rule" | "cn_expired" | "unit_unknown" | "row_legacy" | "unit_committed"): string {
  return L[`daily_work.outcome.error.${code}`] ?? code;
}

export interface UnitInput { unitType: string; unitId: string; outcome?: unknown; actualAmount?: unknown; nextDate?: unknown; reason?: unknown; reasonCode?: unknown }

/** Single-row compatibility entry point; the report endpoint uses the batched writer below. */
export async function writeOutcomeDrafts(tx: Prisma.TransactionClient, entry: EntryFacts, inputs: readonly UnitInput[], today: string, L: Labels): Promise<number> {
  return writeOutcomeDraftBatch(tx, [{ entry, inputs }], today, L);
}

export interface OutcomeDraftInput { entry: EntryFacts; inputs: readonly UnitInput[]; paymentMode?: string | null }

/**
 * Save all requested report rows under the caller's day/entry locks. Snapshot missing units in memory,
 * validate EVERY choice before writing, then persist snapshots, choices, derived totals and payment
 * modes in one statement. Round trips are bounded, independent of the number of rows/tasks. Drafts
 * still have no scheduling, abandonment or financial effects. Partial choices are allowed.
 */
export async function writeOutcomeDraftBatch(tx: Prisma.TransactionClient, drafts: readonly OutcomeDraftInput[], today: string, L: Labels): Promise<number> {
  if (drafts.length === 0) return 0;
  const entries = [...new Map(drafts.map((d) => [d.entry.id, d.entry])).values()];
  const stored = await tx.$queryRaw<OutcomeRow[]>(Prisma.sql`SELECT ${OUTCOME_COLS} FROM "DailyTaskOutcome" o WHERE o."entryId" IN (${ids(entries.map((e) => e.id))}) ORDER BY o."entryId", o."unitType", o."unitId" FOR UPDATE`);
  const byEntry = new Map<string, OutcomeRow[]>(entries.map((e) => [e.id, []]));
  for (const row of stored) byEntry.get(row.entryId)!.push(row);
  const missing = entries.filter((e) => byEntry.get(e.id)!.length === 0);
  if (missing.some((e) => e.todaysActual !== null)) throw new ApiError(409, outcomeMessage(L, "row_legacy"));
  const live = await liveUnits(tx, missing);
  const writes = new Map<string, OutcomeRow>();
  for (const entry of missing) for (const unit of live.get(entry.id) ?? []) {
    const row: OutcomeRow = { ...unit, id: randomUUID(), entryId: entry.id, officerId: entry.officerId, workDate: entry.workDate, section: entry.section,
      plannedAmount: String(unit.plannedAmount), outcome: null, actualAmount: null, nextDate: null, reason: null, reasonCode: null, state: "DRAFT", committedAt: null, committedByName: null };
    byEntry.get(entry.id)!.push(row);
    writes.set(row.id, row);
  }
  // Only date-bearing reschedules need CN rules, fetched once for the whole request.
  const rules = await dateRules(tx, drafts.flatMap((d) => d.inputs.filter((i) => (i.outcome === "RESCHEDULED" && i.nextDate) || i.outcome === "ABANDONED").map((i) => ({ unitType: i.unitType as OutcomeUnitType, unitId: i.unitId }))));
  let changed = 0;
  const paymentModes = new Map<string, string | null>();
  for (const { entry, inputs, paymentMode } of drafts) {
    if (paymentMode !== undefined) paymentModes.set(entry.id, paymentMode);
    const rows = byEntry.get(entry.id)!;
    for (const input of inputs) {
      const row = rows.find((r) => r.unitType === input.unitType && r.unitId === input.unitId);
      if (!row || !(OUTCOME_UNIT_TYPES as readonly string[]).includes(input.unitType)) throw new ApiError(409, outcomeMessage(L, "unit_unknown"));
      if (row.state === "COMMITTED") throw new ApiError(409, outcomeMessage(L, "unit_committed"));
      const clean = sanitizeOutcomeFields(input, entry.section); // the category must be one permitted for THIS task's section
      if (!clean.ok) throw new ApiError(422, outcomeMessage(L, clean.error));
      const f = clean.value;
      const expiredRule = expiredRuleError(rules.get(`${row.unitType}:${row.unitId}`), f.outcome);
      if (expiredRule) throw new ApiError(422, outcomeMessage(L, expiredRule));
      if (f.outcome === "RESCHEDULED" && f.nextDate !== null) {
        if (f.nextDate <= today) throw new ApiError(422, outcomeMessage(L, "date_not_future"));
        const rule = dateRuleError(rules.get(`${row.unitType}:${row.unitId}`), f.nextDate);
        if (rule) throw new ApiError(422, outcomeMessage(L, rule));
      }
      Object.assign(row, { outcome: f.outcome, actualAmount: f.actualAmount === null ? null : String(f.actualAmount), nextDate: f.nextDate, reason: f.reason, reasonCode: f.reasonCode ?? null });
      writes.set(row.id, row);
      changed++;
    }
  }
  const totals = entries.map((entry) => {
    const actual = rowActualFromOutcomes(byEntry.get(entry.id)!.map((r): OutcomeFields => ({ outcome: r.outcome, actualAmount: r.actualAmount == null ? null : Number(r.actualAmount), nextDate: r.nextDate, reason: r.reason, reasonCode: r.reasonCode })), today);
    const clearMode = entry.section === "RECOVERY" && (actual === null || actual <= 0);
    return { id: entry.id, actual, setPaymentMode: entry.section === "RECOVERY" && (clearMode || paymentModes.has(entry.id)), paymentMode: clearMode ? null : paymentModes.get(entry.id) ?? null };
  });
  // JSON recordsets use two bound parameters even at the request's maximum row/unit count.
  // The saved-row guard prevents publishing derived totals if an outcome became immutable.
  const saved = writes.size ? Prisma.sql`
    INSERT INTO "DailyTaskOutcome" ("id","entryId","unitType","unitId","officerId","workDate","section","plannedAmount","outcome","actualAmount","nextDate","reason","reasonCode","state","createdAt","updatedAt")
    SELECT v."id",v."entryId",v."unitType",v."unitId",v."officerId",v."workDate",v."section",v."plannedAmount",v."outcome",v."actualAmount",v."nextDate",v."reason",v."reasonCode",'DRAFT',NOW(),NOW()
    FROM jsonb_to_recordset(${JSON.stringify([...writes.values()])}::jsonb) AS v("id" text,"entryId" text,"unitType" text,"unitId" text,"officerId" text,"workDate" date,"section" text,"plannedAmount" numeric,"outcome" text,"actualAmount" numeric,"nextDate" date,"reason" text,"reasonCode" text) WHERE TRUE
    ON CONFLICT ("entryId","unitType","unitId") DO UPDATE SET "outcome" = EXCLUDED."outcome", "actualAmount" = EXCLUDED."actualAmount", "nextDate" = EXCLUDED."nextDate", "reason" = EXCLUDED."reason", "reasonCode" = EXCLUDED."reasonCode", "updatedAt" = NOW()
    WHERE "DailyTaskOutcome"."state" = 'DRAFT' RETURNING "id"` : Prisma.sql`SELECT NULL::text AS "id" WHERE FALSE`;
  const updated = await tx.$executeRaw(Prisma.sql`
    WITH saved AS (${saved})
    UPDATE "DailyWorkEntry" w SET "todaysActual" = v.actual,
      "paymentMode" = CASE WHEN v."setPaymentMode" THEN v."paymentMode" ELSE w."paymentMode" END, "updatedAt" = NOW()
    FROM jsonb_to_recordset(${JSON.stringify(totals)}::jsonb) AS v("id" text,actual numeric,"setPaymentMode" boolean,"paymentMode" text)
    WHERE w."id" = v."id" AND (SELECT COUNT(*) FROM saved) = ${writes.size}`);
  if (Number(updated) !== entries.length) throw new ApiError(409, outcomeMessage(L, "unit_committed"));
  return changed;
}

/* ------------------------------------------------ commit (report submission) ------------------------------------------------ */

export interface CommitResult { completed: number; rescheduled: number; abandoned: number }

/**
 * Called INSIDE the transaction that submits the Daily Report. Re-validates every draft outcome against TODAY's business date, then commits them: Completed is recorded as is
 * (no payment, ledger entry or exception resolution is created); Not Completed — Reschedule moves the SAME task to its next date (history row + the source's own scheduling
 * state, so it re-enters the same section with the same planned amount on that day); Abandon ends the task (it is never scheduled again). Any failure rolls the whole report back.
 */
export async function commitTaskOutcomes(tx: Prisma.TransactionClient, ctx: AuthContext, officerId: string, workDate: string, today: string, L: Labels): Promise<CommitResult> {
  const rows = await tx.$queryRaw<OutcomeRow[]>(Prisma.sql`
    SELECT ${OUTCOME_COLS} FROM "DailyTaskOutcome" o WHERE o."officerId" = ${officerId} AND o."workDate" = ${workDate}::date AND o."state" = 'DRAFT'
    ORDER BY o."unitType", o."unitId" FOR UPDATE`);
  const result: CommitResult = { completed: 0, rescheduled: 0, abandoned: 0 };
  if (rows.length === 0) return result;
  const actor = (await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? ctx.username ?? ctx.userId;
  const rules = await dateRules(tx, rows);
  const entryIds = [...new Set(rows.map((r) => r.entryId))];
  const facts = await tx.$queryRaw<{ id: string; dealerId: string | null; entryType: string; schemeId: string | null }[]>(Prisma.sql`SELECT "id", "dealerId", "entryType", "schemeId" FROM "DailyWorkEntry" WHERE "id" IN (${ids(entryIds)})`);
  for (const row of rows) {
    const f: OutcomeFields = { outcome: row.outcome, actualAmount: row.actualAmount == null ? null : Number(row.actualAmount), nextDate: row.nextDate, reason: row.reason, reasonCode: row.reasonCode };
    const err = validateOutcome(f, today) ?? expiredRuleError(rules.get(`${row.unitType}:${row.unitId}`), f.outcome) ?? (f.outcome === "RESCHEDULED" && f.nextDate ? dateRuleError(rules.get(`${row.unitType}:${row.unitId}`), f.nextDate) : null);
    if (err) throw new ApiError(422, outcomeMessage(L, err));
    let continuedAs: { type: string; id: string } | null = null;
    if (f.outcome === "RESCHEDULED") continuedAs = await reschedule(tx, ctx, row, f.nextDate!, facts.find((x) => x.id === row.entryId)!, L);
    else if (f.outcome === "ABANDONED") await abandon(tx, row, L);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyTaskOutcome" SET "state" = 'COMMITTED', "committedAt" = NOW(), "committedById" = ${ctx.userId}, "committedByName" = ${actor},
        "continuedAsType" = ${continuedAs?.type ?? null}, "continuedAsId" = ${continuedAs?.id ?? null}, "updatedAt" = NOW()
      WHERE "id" = ${row.id} AND "state" = 'DRAFT'`);
    if (f.outcome === "COMPLETED") result.completed++; else if (f.outcome === "RESCHEDULED") result.rescheduled++; else result.abandoned++;
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyTaskOutcome", entityId: row.id, summary: `Task outcome ${f.outcome} · ${row.unitType} ${row.unitId}${f.outcome === "RESCHEDULED" ? ` → ${f.nextDate}` : ""}${f.outcome === "COMPLETED" ? ` · actual ${f.actualAmount}` : ""}` }, tx);
  }
  return result;
}

const changed = (L: Labels) => new ApiError(409, L["daily_work.outcome.error.task_changed"] ?? "task_changed");

/** Move the SAME task to its next date. Source tasks keep their id, amount, owner, source links and original date; a manual task continues as a Calendar task from now on. */
async function reschedule(tx: Prisma.TransactionClient, ctx: AuthContext, row: OutcomeRow, next: string, entry: { dealerId: string | null; entryType: string; schemeId: string | null }, L: Labels): Promise<{ type: string; id: string } | null> {
  const move = (type: TaskSourceType, previous: string) => recordTaskReschedule(tx, ctx, { sourceType: type, sourceId: row.unitId, ownerId: row.officerId, previousDate: previous, newDate: next });
  if (row.unitType === "BILLING_EXCEPTION") {
    const t = (await tx.$queryRaw<{ taskDate: string; entryId: string | null; abandoned: boolean }[]>(Prisma.sql`SELECT "taskDate"::text AS "taskDate", "dailyWorkEntryId" AS "entryId", ("abandonedAt" IS NOT NULL) AS "abandoned" FROM "BillingExceptionTask" WHERE "id" = ${row.unitId} FOR UPDATE`))[0];
    if (!t || t.entryId !== row.entryId || t.abandoned) throw changed(L);
    await tx.$executeRaw(Prisma.sql`UPDATE "BillingExceptionTask" SET "taskDate" = ${next}::date, "rescheduled" = true, "dailyWorkEntryId" = NULL, "dailyWorkContribution" = NULL, "dailyWorkConfirmed" = false, "materializedAt" = NULL, "updatedAt" = NOW() WHERE "id" = ${row.unitId}`);
    await move("BILLING_EXCEPTION", t.taskDate);
    return null;
  }
  if (row.unitType === "CN_PAYMENT") {
    const t = (await tx.$queryRaw<{ taskDate: string | null; entryId: string | null; status: string | null }[]>(Prisma.sql`SELECT "taskDate"::text AS "taskDate", "dailyWorkEntryId" AS "entryId", "taskStatus" AS "status" FROM "CnPaymentEvent" WHERE "id" = ${row.unitId} FOR UPDATE`))[0];
    if (!t || t.entryId !== row.entryId || t.status !== "SCHEDULED" || !t.taskDate) throw changed(L);
    await tx.$executeRaw(Prisma.sql`UPDATE "CnPaymentEvent" SET "taskDate" = ${next}::date, "taskStatus" = 'SCHEDULED', "taskRescheduled" = true, "dailyWorkEntryId" = NULL, "dailyWorkContribution" = NULL, "dailyWorkConfirmed" = false WHERE "id" = ${row.unitId}`);
    await move("CN_PAYMENT", t.taskDate);
    return null;
  }
  if (row.unitType === "CN_LEGACY") {
    const t = (await tx.$queryRaw<{ taskDate: string | null; entryId: string | null; abandoned: boolean }[]>(Prisma.sql`SELECT "taskDate"::text AS "taskDate", "legacyDailyWorkEntryId" AS "entryId", ("legacyTaskAbandonedAt" IS NOT NULL) AS "abandoned" FROM "CnRequest" WHERE "id" = ${row.unitId} FOR UPDATE`))[0];
    if (!t || t.entryId !== row.entryId || t.abandoned || !t.taskDate) throw changed(L);
    await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest" SET "taskDate" = ${next}::date, "legacyDailyWorkEntryId" = NULL, "legacyDailyWorkContribution" = NULL, "legacyDailyWorkConfirmed" = false, "updatedAt" = NOW() WHERE "id" = ${row.unitId}`);
    await move("CN_LEGACY", t.taskDate);
    return null;
  }
  if (row.unitType === "CALENDAR_ENTRY") {
    const t = (await tx.$queryRaw<{ date: string; entryId: string | null; abandoned: boolean }[]>(Prisma.sql`SELECT "date"::text AS "date", "dailyWorkEntryId" AS "entryId", ("abandonedAt" IS NOT NULL) AS "abandoned" FROM "CalendarEntry" WHERE "id" = ${row.unitId} FOR UPDATE`))[0];
    if (!t || t.entryId !== row.entryId || t.abandoned) throw changed(L);
    await tx.$executeRaw(Prisma.sql`UPDATE "CalendarEntry" SET "date" = ${next}::date, "dailyWorkEntryId" = NULL, "dailyWorkContribution" = NULL, "materializedAt" = NULL, "updatedAt" = NOW() WHERE "id" = ${row.unitId}`);
    await move("CALENDAR_ENTRY", t.date);
    return null;
  }
  // MANUAL_ROW: a task typed straight into Daily Work has no source row of its own; it continues as ONE Calendar task (a Manual task, created by the officer) on the next date.
  const created = await tx.calendarEntry.create({
    data: { ownerId: row.officerId, createdById: ctx.userId, date: new Date(`${next}T00:00:00.000Z`), kind: "TASK", taskSection: row.section, dealerId: entry.dealerId, amount: Number(row.plannedAmount), entryType: entry.entryType, schemeId: entry.entryType === "SCHEME" ? entry.schemeId : null } as never,
    select: { id: true },
  });
  await recordTaskReschedule(tx, ctx, { sourceType: "CALENDAR_ENTRY", sourceId: created.id, ownerId: row.officerId, previousDate: row.workDate, newDate: next });
  return { type: "CALENDAR_ENTRY", id: created.id };
}

/** Abandon ends the FOLLOW-UP task only: nothing is written off, received or resolved. A manual row has no future occurrence to stop. */
async function abandon(tx: Prisma.TransactionClient, row: OutcomeRow, L: Labels): Promise<void> {
  if (row.unitType === "BILLING_EXCEPTION") {
    const n = await tx.$executeRaw(Prisma.sql`UPDATE "BillingExceptionTask" SET "abandonedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${row.unitId} AND "abandonedAt" IS NULL AND "dailyWorkEntryId" = ${row.entryId}`);
    if (Number(n) !== 1) throw changed(L);
  } else if (row.unitType === "CN_PAYMENT") {
    const n = await tx.$executeRaw(Prisma.sql`UPDATE "CnPaymentEvent" SET "taskStatus" = 'ABANDONED' WHERE "id" = ${row.unitId} AND "taskStatus" = 'SCHEDULED' AND "dailyWorkEntryId" = ${row.entryId}`);
    if (Number(n) !== 1) throw changed(L);
  } else if (row.unitType === "CN_LEGACY") {
    const n = await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest" SET "legacyTaskAbandonedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${row.unitId} AND "legacyTaskAbandonedAt" IS NULL AND "legacyDailyWorkEntryId" = ${row.entryId}`);
    if (Number(n) !== 1) throw changed(L);
  } else if (row.unitType === "CALENDAR_ENTRY") {
    const n = await tx.$executeRaw(Prisma.sql`UPDATE "CalendarEntry" SET "abandonedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${row.unitId} AND "abandonedAt" IS NULL AND "dailyWorkEntryId" = ${row.entryId}`);
    if (Number(n) !== 1) throw changed(L);
  }
}
