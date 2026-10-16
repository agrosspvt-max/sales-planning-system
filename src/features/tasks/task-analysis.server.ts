import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";
import { currentBusinessDate, SCHEME_CONVERSION_ENABLED } from "@/lib/daily-work";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { getResolvedLabels } from "@/features/labels/service.server";
import { taskSubtype, type TaskSubtype } from "@/lib/calendar";
import {
  dateTrail, daysMoved, deriveHistoryState, deriveTaskStatus, distinctTrailDates, isDateKey, rescheduleCalendarCounts, summarizeTasks,
  TASK_STATUSES, type DateBasis, type HistoryState, type TaskStatus, type TaskSummary, type TaskTypeKind,
} from "@/lib/task-analysis";

/**
 * Performance → Tasks. ONE authorized task population feeds the summary, the table, the reschedule calendar and each task's history.
 *
 * WHAT A "TASK" IS (one row per distinct task — never a Daily Work row that merely carries it):
 *  AUTO   • Billing Exception Recovery task (BillingExceptionTask)            — completed when its exception is Resolved by a payment
 *         • CN Recovery task (CnPaymentEvent with a date + amount)             — completed when the task was closed by a reported / verified payment outcome
 *         • legacy CN follow-up task (CnRequest without payment tracking)      — completed once the CN is no longer "Accepted, not posted"
 *  MANUAL • Calendar task (CalendarEntry kind TASK, any section)                — completed when its Daily Work report is FINALIZED and the linked row met its target
 *         • the manual part of a submitted Daily Work Sales / Recovery row     — plan minus every automatic / calendar contribution (> 0), same completion rule
 *        • Dealer Appointment: each valid planned appointment row (a Calendar appointment is that Calendar task, counted once); completed only by "Appointed"
 *        • Dealer Visits / New Party Visits: ONE target task per category per employee-day when planned visits > 0; completed when that category's actual reached its target
 *        • Scheme Conversion (only while the feature is enabled): each planned row; completed by "Yes"
 *        Completion of Manual work = a finalized report whose result met the target (Sales / Recovery: Actual ≥ Planned). Automatic tasks keep their authoritative payment resolution.
 * Reminders, meetings, ordinary Others notes, blank rows, No Plan sections and unsubmitted drafts are NOT tasks. "In Daily Work", materialized, confirmed or plan-submitted never means Completed, and a reschedule never does.
 * No source here supports cancelled / withdrawn tasks today; the status exists and is kept distinct for when one does.
 *
 * DATE MEANINGS (never mixed): ORIGINAL = the task's original scheduled date (Original Due Date; permanent); the CURRENT scheduled date is separate; RESCHEDULED_ON = the business
 * (Asia/Kolkata) date a date change was MADE. Scope is decided by the caller's authoritative Performance population (SO self / RM team / Admin all, State and employee narrowing only).
 */

export interface TaskScopePerson { id: string; name: string; role: string; groupId: string | null; groupName: string | null }
export interface TaskScope { population: TaskScopePerson[]; officers: { id: string; name: string }[]; states: { id: string; name: string }[] }

export type TaskSource = "BILLING_EXCEPTION" | "CN_PAYMENT" | "CN_LEGACY" | "CALENDAR_ENTRY" | "DAILY_WORK_ROW" | "DAILY_WORK_VISIT";
/** Visit tasks are one TARGET per category (never one task per visit). */
export type VisitCategory = "DEALER_VISITS" | "NEW_PARTY_VISITS";
export interface TaskRow {
  key: string; sourceType: TaskSource; taskId: string; ownerId: string; ownerName: string; territory: string | null; state: string | null;
  type: TaskTypeKind; section: string; subtype: TaskSubtype; dealerId: string | null; dealerName: string | null; marketName: string | null; description: string | null; amount: number | null;
  originalDate: string; originalVerified: boolean; currentDate: string; moves: number; daysMoved: number | null; status: TaskStatus; historyState: HistoryState; periodMoves: number | null;
  /** Visit tasks only: which category, and the target (planned visits) of that one task. */
  category: VisitCategory | null; target: number | null;
}

interface RawTask {
  sourceType: TaskSource; taskId: string; ownerId: string; dealerId: string | null; dealerName: string | null; marketName: string | null; description: string | null; amount: string | null;
  section: string; entryType: string | null; schemeName: string | null; taskType: TaskTypeKind; category: VisitCategory | null; target: string | null; originalDate: string; originalVerified: boolean; currentDate: string;
  moves: number; gap: boolean; completed: boolean; cancelled: boolean; abandoned: boolean;
}

// The business-timezone literal is inlined (a bind parameter would make the SELECT and GROUP BY expressions differ).
const ISTDATE = Prisma.sql`((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date`;
/** Per-task move count + the FIRST event's previous date, from the immutable history (one indexed lateral lookup per task). */
const evLateral = (type: string, idCol: Prisma.Sql) => Prisma.sql`LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS "moves", (array_agg(e."previousDate" ORDER BY e."createdAt", e."id"))[1] AS "first"
  FROM "TaskRescheduleEvent" e WHERE e."sourceType" = ${type} AND e."sourceId" = ${idCol}) ev ON true`;

type Pick = { mode: "original"; from: string; to: string } | { mode: "ids"; ids: readonly string[] };
const SELECT_COLS = Prisma.sql`"sourceType","taskId","ownerId","dealerId","dealerName","marketName","description","amount","section","entryType","schemeName","taskType","category","target","originalDate","originalVerified","currentDate","moves","gap","completed","cancelled","abandoned"`;

async function loadSource(inner: Prisma.Sql, ownerIds: readonly string[] | null, pick: Pick): Promise<RawTask[]> {
  const owners = ownerIds ? (ownerIds.length ? Prisma.sql`AND q."ownerId" IN (${Prisma.join(ownerIds)})` : Prisma.sql`AND FALSE`) : Prisma.empty;
  const picked = pick.mode === "original" ? Prisma.sql`AND q."originalDate" BETWEEN ${pick.from} AND ${pick.to}` : pick.ids.length ? Prisma.sql`AND q."taskId" IN (${Prisma.join(pick.ids)})` : Prisma.sql`AND FALSE`;
  return prisma.$queryRaw<RawTask[]>(Prisma.sql`SELECT ${SELECT_COLS} FROM (${inner}) q WHERE TRUE ${owners} ${picked}`);
}

/**
 * The task's SUBMITTED outcomes (Daily Report). `met` = a Completed outcome whose Actual reached the task's planned target (a lower Actual is a recorded result, not a completion).
 * Only MANUAL tasks use it: an Automatic task is completed solely by its source's authoritative payment resolution. A task never given an outcome falls back to its legacy evidence.
 */
const ocLateral = (type: string, idCol: Prisma.Sql) => Prisma.sql`LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS "n", COALESCE(BOOL_OR(u."outcome" = 'COMPLETED'), false) AS "done", COALESCE(BOOL_OR(u."outcome" = 'ABANDONED'), false) AS "ab",
    COALESCE(BOOL_OR(u."outcome" = 'COMPLETED' AND u."actualAmount" >= u."plannedAmount"), false) AS "met"
  FROM "DailyTaskOutcome" u WHERE u."unitType" = ${type} AND u."unitId" = ${idCol} AND u."state" = 'COMMITTED') oc ON true`;
const ownersClause = (col: Prisma.Sql, owners: readonly string[] | null) => (owners ? (owners.length ? Prisma.sql`AND ${col} IN (${Prisma.join(owners)})` : Prisma.sql`AND FALSE`) : Prisma.empty);

const billingSql = () => Prisma.sql`
  SELECT 'BILLING_EXCEPTION' AS "sourceType", t."id" AS "taskId",
    CASE WHEN t."dailyWorkEntryId" IS NULL THEN COALESCE((SELECT da."officerId" FROM "DealerAssignment" da WHERE da."dealerId" = t."dealerId" AND da."effectiveTo" IS NULL ORDER BY da."effectiveFrom" DESC, da."createdAt" DESC LIMIT 1), t."officerId") ELSE t."officerId" END AS "ownerId",
    t."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", t."amount"::text AS "amount", 'RECOVERY' AS "section", NULL::text AS "entryType", NULL::text AS "schemeName", 'AUTO' AS "taskType", NULL::text AS "category", NULL::text AS "target",
    t."promisedDate"::text AS "originalDate", true AS "originalVerified", t."taskDate"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", t."rescheduleHistoryGap" AS "gap",
    (be."status" = 'RESOLVED' AND be."resolutionReason" = 'PAYMENT_RECEIVED') AS "completed", false AS "cancelled", (oc."ab" OR t."abandonedAt" IS NOT NULL) AS "abandoned"
  FROM "BillingExceptionTask" t JOIN "BillingException" be ON be."id" = t."billingExceptionId" JOIN "Dealer" d ON d."id" = t."dealerId"
  ${evLateral("BILLING_EXCEPTION", Prisma.sql`t."id"`)} ${ocLateral("BILLING_EXCEPTION", Prisma.sql`t."id"`)}`;

const cnPaymentSql = (owners: readonly string[] | null) => Prisma.sql`
  SELECT 'CN_PAYMENT' AS "sourceType", e0."id" AS "taskId", c."officerId" AS "ownerId", c."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", e0."taskAmount"::text AS "amount",
    'RECOVERY' AS "section", NULL::text AS "entryType", NULL::text AS "schemeName", 'AUTO' AS "taskType", NULL::text AS "category", NULL::text AS "target",
    COALESCE(ev."first", e0."taskDate")::text AS "originalDate", NOT e0."rescheduleHistoryGap" AS "originalVerified", e0."taskDate"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", e0."rescheduleHistoryGap" AS "gap",
    (e0."taskStatus" = 'COMPLETED') AS "completed", false AS "cancelled", (oc."ab" OR e0."taskStatus" = 'ABANDONED') AS "abandoned"
  FROM "CnPaymentEvent" e0 JOIN "CnRequest" c ON c."id" = e0."cnRequestId" JOIN "Dealer" d ON d."id" = c."dealerId"
  ${evLateral("CN_PAYMENT", Prisma.sql`e0."id"`)} ${ocLateral("CN_PAYMENT", Prisma.sql`e0."id"`)}
  WHERE e0."taskDate" IS NOT NULL AND e0."taskStatus" IS NOT NULL AND e0."taskAmount" > 0 ${ownersClause(Prisma.sql`c."officerId"`, owners)}`;

const cnLegacySql = (owners: readonly string[] | null) => Prisma.sql`
  SELECT 'CN_LEGACY' AS "sourceType", c."id" AS "taskId", c."officerId" AS "ownerId", c."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", c."amount"::text AS "amount",
    'RECOVERY' AS "section", NULL::text AS "entryType", NULL::text AS "schemeName", 'AUTO' AS "taskType", NULL::text AS "category", NULL::text AS "target",
    COALESCE(ev."first", c."taskDate")::text AS "originalDate", false AS "originalVerified", c."taskDate"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", c."rescheduleHistoryGap" AS "gap",
    (c."status" <> 'ACCEPTED_NOT_POSTED') AS "completed", false AS "cancelled", (oc."ab" OR c."legacyTaskAbandonedAt" IS NOT NULL) AS "abandoned"
  FROM "CnRequest" c JOIN "Dealer" d ON d."id" = c."dealerId"
  ${evLateral("CN_LEGACY", Prisma.sql`c."id"`)} ${ocLateral("CN_LEGACY", Prisma.sql`c."id"`)}
  WHERE c."paymentTrackingMode" IS NULL AND c."acceptanceReason" = 'PAYMENT_PENDING' AND c."taskDate" IS NOT NULL AND c."amount" > 0 ${ownersClause(Prisma.sql`c."officerId"`, owners)}`;

/** LEGACY evidence only (a task never given an outcome): a FINALIZED report whose linked row met its target (Sales / Recovery: actual ≥ plan; Appointment: Appointed; Visits: EACH category of the task met on its own; Others: finalized). */
const manualDone = Prisma.sql`COALESCE((dd."id" IS NOT NULL AND w."id" IS NOT NULL AND CASE ce."taskSection"
    WHEN 'SALES' THEN COALESCE(w."todaysPlan", 0) > 0 AND COALESCE(w."todaysActual", 0) >= COALESCE(w."todaysPlan", 0)
    WHEN 'RECOVERY' THEN COALESCE(w."todaysPlan", 0) > 0 AND COALESCE(w."todaysActual", 0) >= COALESCE(w."todaysPlan", 0)
    WHEN 'APPOINTMENT' THEN w."resultStatus" = 'APPOINTED'
    WHEN 'VISITS' THEN COALESCE(ce."dealerVisits", 0) + COALESCE(ce."newPartyVisits", 0) > 0
      AND (COALESCE(ce."dealerVisits", 0) = 0 OR COALESCE(w."actualDealerVisits", 0) >= COALESCE(w."dealerVisits", 0))
      AND (COALESCE(ce."newPartyVisits", 0) = 0 OR COALESCE(w."actualNewPartyVisits", 0) >= COALESCE(w."newPartyVisits", 0))
    WHEN 'OTHERS' THEN true ELSE false END), false)`;
const calendarSql = (owners: readonly string[] | null) => Prisma.sql`
  SELECT 'CALENDAR_ENTRY' AS "sourceType", ce."id" AS "taskId", ce."ownerId", ce."dealerId", COALESCE(d."name", ce."typedDealerName") AS "dealerName", ce."marketName", ce."text" AS "description", ce."amount"::text AS "amount",
    ce."taskSection" AS "section", ce."entryType", sc."schemeName", 'MANUAL' AS "taskType", NULL::text AS "category", NULL::text AS "target",
    COALESCE(ev."first", ce."date")::text AS "originalDate", true AS "originalVerified", ce."date"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", false AS "gap",
    (oc."met" OR (${manualDone} AND oc."n" = 0)) AS "completed", false AS "cancelled", (oc."ab" OR ce."abandonedAt" IS NOT NULL) AS "abandoned"
  FROM "CalendarEntry" ce LEFT JOIN "Dealer" d ON d."id" = ce."dealerId" LEFT JOIN "Scheme" sc ON sc."id" = ce."schemeId"
  LEFT JOIN "DailyWorkEntry" w ON w."id" = ce."dailyWorkEntryId"
  LEFT JOIN "DailyWorkDay" dd ON dd."officerId" = w."officerId" AND dd."workDate" = w."workDate" AND dd."status" = 'FINALIZED'
  ${evLateral("CALENDAR_ENTRY", Prisma.sql`ce."id"`)} ${ocLateral("CALENDAR_ENTRY", Prisma.sql`ce."id"`)}
  WHERE ce."kind" = 'TASK' ${ownersClause(Prisma.sql`ce."ownerId"`, owners)}`;

/**
 * The MANUAL part of a submitted Sales / Recovery row. Once the row has frozen task outcomes, its manual task is exactly that frozen unit (a later unlink of an automatic
 * contribution can never inflate it) — and a manual task that was rescheduled continues as a Calendar task, so it is NOT counted a second time here.
 */
const dailyRowSql = (owners: readonly string[] | null, window: { from: string; to: string } | null, entryIds: readonly string[] | null) => Prisma.sql`
  SELECT 'DAILY_WORK_ROW' AS "sourceType", w."id" AS "taskId", w."officerId" AS "ownerId", w."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", COALESCE(mu."plannedAmount", w."todaysPlan" - COALESCE(c."sum", 0))::text AS "amount",
    w."section", w."entryType", sc."schemeName", 'MANUAL' AS "taskType", NULL::text AS "category", NULL::text AS "target", w."workDate"::text AS "originalDate", true AS "originalVerified", w."workDate"::text AS "currentDate", 0 AS "moves", false AS "gap",
    COALESCE((mu."state" = 'COMMITTED' AND mu."outcome" = 'COMPLETED' AND mu."actualAmount" >= mu."plannedAmount") OR (mu."id" IS NULL AND NOT snap."has" AND (dd."finalizedAt" IS NOT NULL OR dd."status" = 'FINALIZED') AND COALESCE(w."todaysActual", 0) >= w."todaysPlan"), false) AS "completed", false AS "cancelled",
    COALESCE(mu."state" = 'COMMITTED' AND mu."outcome" = 'ABANDONED', false) AS "abandoned"
  FROM "DailyWorkEntry" w LEFT JOIN "Dealer" d ON d."id" = w."dealerId" LEFT JOIN "Scheme" sc ON sc."id" = w."schemeId"
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(x."contribution"), 0) AS "sum" FROM (
      SELECT "dailyWorkContribution" AS "contribution" FROM "BillingExceptionTask" WHERE "dailyWorkEntryId" = w."id"
      UNION ALL SELECT "dailyWorkContribution" FROM "CnPaymentEvent" WHERE "dailyWorkEntryId" = w."id"
      UNION ALL SELECT "legacyDailyWorkContribution" FROM "CnRequest" WHERE "legacyDailyWorkEntryId" = w."id"
      UNION ALL SELECT "dailyWorkContribution" FROM "CalendarEntry" WHERE "dailyWorkEntryId" = w."id") x) c ON true
  LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM "DailyTaskOutcome" x WHERE x."entryId" = w."id") AS "has") snap ON true
  LEFT JOIN LATERAL (SELECT u."id", u."plannedAmount", u."actualAmount", u."outcome", u."state", u."continuedAsId" FROM "DailyTaskOutcome" u WHERE u."entryId" = w."id" AND u."unitType" = 'MANUAL_ROW' LIMIT 1) mu ON true
  LEFT JOIN "DailyWorkDay" dd ON dd."officerId" = w."officerId" AND dd."workDate" = w."workDate"
  WHERE w."section" IN ('SALES', 'RECOVERY') AND w."status" <> 'DRAFT'
    AND ((mu."id" IS NOT NULL AND mu."continuedAsId" IS NULL) OR (mu."id" IS NULL AND NOT snap."has" AND w."todaysPlan" - COALESCE(c."sum", 0) > 0))
    ${window ? Prisma.sql`AND w."workDate" BETWEEN ${window.from}::date AND ${window.to}::date` : Prisma.empty}
    ${entryIds ? (entryIds.length ? Prisma.sql`AND w."id" IN (${Prisma.join(entryIds)})` : Prisma.sql`AND FALSE`) : Prisma.empty}
    ${ownersClause(Prisma.sql`w."officerId"`, owners)}`;


/** A SUBMITTED plan row (the same rule as "Submitted Plans" / the Performance section totals): drafts and unsubmitted rows are never work. */
const SUBMITTED = Prisma.sql`w."planSubmittedAt" IS NOT NULL AND w."status" IN ('PLAN_SUBMITTED','FINALIZED','SUBMITTED')`;
const finalized = Prisma.sql`(dd."finalizedAt" IS NOT NULL OR dd."status" = 'FINALIZED')`;
const rowScope = (owners: readonly string[] | null, window: { from: string; to: string } | null, entryIds: readonly string[] | null) => Prisma.sql`
    ${window ? Prisma.sql`AND w."workDate" BETWEEN ${window.from}::date AND ${window.to}::date` : Prisma.empty}
    ${entryIds ? (entryIds.length ? Prisma.sql`AND w."id" IN (${Prisma.join(entryIds)})` : Prisma.sql`AND FALSE`) : Prisma.empty}
    ${ownersClause(Prisma.sql`w."officerId"`, owners)}`;

/**
 * Dealer Appointment: ONE task per valid planned appointment row (a linked Monthly Party Planning market, or a typed dealer — an unnamed placeholder is nothing). A row that IS a
 * Calendar appointment task (`cal-…`, or linked from a Calendar entry) is counted once, as that Calendar task. Completed only by an "Appointed" result in a finalized report:
 * Not Appointed is a recorded outcome, never a success.
 * Scheme Conversion (only while the feature is enabled): one task per submitted row with a planned quantity; completed by a "Yes" result.
 */
const plannedRowSql = (section: "APPOINTMENT" | "SCHEME_CONVERSION", owners: readonly string[] | null, window: { from: string; to: string } | null, entryIds: readonly string[] | null) => Prisma.sql`
  SELECT 'DAILY_WORK_ROW' AS "sourceType", w."id" AS "taskId", w."officerId" AS "ownerId", w."dealerId",
    COALESCE(d."name", NULLIF(btrim(w."typedDealerName"), ''), NULLIF(btrim(w."reportedDealerName"), '')) AS "dealerName", NULLIF(btrim(w."marketName"), '') AS "marketName", NULL::text AS "description",
    ${section === "SCHEME_CONVERSION" ? Prisma.sql`w."todaysPlan"::text` : Prisma.sql`NULL::text`} AS "amount",
    w."section", NULL::text AS "entryType", sc."schemeName", 'MANUAL' AS "taskType", NULL::text AS "category", NULL::text AS "target",
    w."workDate"::text AS "originalDate", true AS "originalVerified", w."workDate"::text AS "currentDate", 0 AS "moves", false AS "gap",
    COALESCE(${finalized} AND w."resultStatus" = ${section === "APPOINTMENT" ? "APPOINTED" : "YES"}, false) AS "completed", false AS "cancelled", false AS "abandoned"
  FROM "DailyWorkEntry" w LEFT JOIN "Dealer" d ON d."id" = w."dealerId" LEFT JOIN "Scheme" sc ON sc."id" = w."schemeId"
  LEFT JOIN "DailyWorkDay" dd ON dd."officerId" = w."officerId" AND dd."workDate" = w."workDate"
  WHERE w."section" = ${section} AND ${SUBMITTED}
    AND ${section === "APPOINTMENT"
      ? Prisma.sql`(w."monthlyPlanId" IS NOT NULL OR btrim(COALESCE(w."typedDealerName", '')) <> '') AND w."rowKey" NOT LIKE 'cal-%' AND NOT EXISTS (SELECT 1 FROM "CalendarEntry" x WHERE x."dailyWorkEntryId" = w."id")`
      : Prisma.sql`COALESCE(w."todaysPlan", 0) > 0`}
    ${rowScope(owners, window, entryIds)}`;

/**
 * Dealer Visits / New Party Visits: ONE target task per category per employee-day when planned visits > 0 (a target of four is ONE task with target four). Several submitted
 * batches of the day add up. Visits that came from Calendar visit tasks are those Calendar tasks (counted once there), so only the remaining manual target is a task here.
 * Completed when the category's actual reached the category's planned target in a finalized report — a shortfall in one category is never covered by the other.
 */
const visitsSql = (owners: readonly string[] | null, window: { from: string; to: string } | null, days: readonly { officerId: string; date: string }[] | null) => Prisma.sql`
  SELECT 'DAILY_WORK_VISIT' AS "sourceType", v."officerId" || ':' || v."workDate"::text || ':' || cat."code" AS "taskId", v."officerId" AS "ownerId", NULL::text AS "dealerId", NULL::text AS "dealerName",
    NULL::text AS "marketName", NULL::text AS "description", NULL::text AS "amount", 'VISITS' AS "section", NULL::text AS "entryType", NULL::text AS "schemeName", 'MANUAL' AS "taskType",
    cat."code" AS "category", cat."remaining"::text AS "target", v."workDate"::text AS "originalDate", true AS "originalVerified", v."workDate"::text AS "currentDate", 0 AS "moves", false AS "gap",
    (v."finalized" AND cat."actual" IS NOT NULL AND cat."actual" >= cat."planned") AS "completed", false AS "cancelled", false AS "abandoned"
  FROM (
    SELECT w."officerId", w."workDate", SUM(w."dealerVisits") AS "pd", SUM(w."newPartyVisits") AS "pn", SUM(w."actualDealerVisits") AS "ad", SUM(w."actualNewPartyVisits") AS "an",
      BOOL_OR(${finalized}) AS "finalized",
      COALESCE((SELECT SUM(ce."dealerVisits") FROM "CalendarEntry" ce JOIN "DailyWorkEntry" x ON x."id" = ce."dailyWorkEntryId"
        WHERE x."officerId" = w."officerId" AND x."workDate" = w."workDate" AND x."section" = 'SUMMARY' AND ce."kind" = 'TASK' AND ce."taskSection" = 'VISITS'), 0) AS "cd",
      COALESCE((SELECT SUM(ce."newPartyVisits") FROM "CalendarEntry" ce JOIN "DailyWorkEntry" x ON x."id" = ce."dailyWorkEntryId"
        WHERE x."officerId" = w."officerId" AND x."workDate" = w."workDate" AND x."section" = 'SUMMARY' AND ce."kind" = 'TASK' AND ce."taskSection" = 'VISITS'), 0) AS "cn"
    FROM "DailyWorkEntry" w LEFT JOIN "DailyWorkDay" dd ON dd."officerId" = w."officerId" AND dd."workDate" = w."workDate"
    WHERE w."section" = 'SUMMARY' AND w."rowKey" = 'SUMMARY' AND ${SUBMITTED}
      ${window ? Prisma.sql`AND w."workDate" BETWEEN ${window.from}::date AND ${window.to}::date` : Prisma.empty}
      ${days ? (days.length ? Prisma.sql`AND (${Prisma.join(days.map((d) => Prisma.sql`(w."officerId" = ${d.officerId} AND w."workDate" = ${d.date}::date)`), " OR ")})` : Prisma.sql`AND FALSE`) : Prisma.empty}
      ${ownersClause(Prisma.sql`w."officerId"`, owners)}
    GROUP BY w."officerId", w."workDate") v
  CROSS JOIN LATERAL (VALUES ('DEALER_VISITS', v."pd", v."ad", v."pd" - v."cd"), ('NEW_PARTY_VISITS', v."pn", v."an", v."pn" - v."cn")) AS cat("code", "planned", "actual", "remaining")
  WHERE cat."remaining" > 0`;

/** Visit task ids are `<officerId>:<date>:<category>`; the day pairs let an id lookup read only those employee-days. */
const visitDays = (ids: readonly string[]) => ids.flatMap((id) => { const [officerId, date, category] = id.split(":"); return officerId && date && category ? [{ officerId, date }] : []; });

async function loadRaw(ownerIds: readonly string[] | null, pick: Pick): Promise<RawTask[]> {
  const window = pick.mode === "original" ? { from: pick.from, to: pick.to } : null;
  const entryIds = pick.mode === "ids" ? pick.ids : null;
  const days = pick.mode === "ids" ? visitDays(pick.ids) : null;
  const parts = await Promise.all([
    loadSource(billingSql(), ownerIds, pick), loadSource(cnPaymentSql(ownerIds), null, pick), loadSource(cnLegacySql(ownerIds), null, pick),
    loadSource(calendarSql(ownerIds), null, pick), loadSource(dailyRowSql(ownerIds, window, entryIds), null, pick),
    loadSource(plannedRowSql("APPOINTMENT", ownerIds, window, entryIds), null, pick),
    SCHEME_CONVERSION_ENABLED ? loadSource(plannedRowSql("SCHEME_CONVERSION", ownerIds, window, entryIds), null, pick) : Promise.resolve([] as RawTask[]),
    loadSource(visitsSql(ownerIds, window, days), null, pick),
  ]);
  return parts.flat();
}

/* ------------------------------------------------ hydration ------------------------------------------------ */

async function hydrate(raw: RawTask[], scope: TaskScope, today: string, periodMoves?: Map<string, number>): Promise<TaskRow[]> {
  const people = new Map(scope.population.map((p) => [p.id, p]));
  const territory = new Map<string, string | null>();
  const ownerIds = [...new Set(raw.map((r) => r.ownerId))];
  if (ownerIds.length) for (const u of (await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, territory: true } })) as { id: string; territory: string | null }[]) territory.set(u.id, u.territory?.trim() || null);
  const dealerIds = [...new Set(raw.map((r) => r.dealerId).filter((x): x is string => !!x))];
  const alias = dealerIds.length ? await loadDealerAliasNameMap(dealerIds) : new Map<string, string>(); // DISPLAY-only alias-preferred names
  return raw.map((r): TaskRow => {
    const key = `${r.sourceType}:${r.taskId}`;
    const person = people.get(r.ownerId);
    const status = deriveTaskStatus({ completed: r.completed, cancelled: r.cancelled, abandoned: r.abandoned, currentDate: r.currentDate, today });
    const subtype = taskSubtype(r.section, r.entryType, r.sourceType === "BILLING_EXCEPTION" ? "BILLING_EXCEPTION" : r.sourceType === "CN_PAYMENT" || r.sourceType === "CN_LEGACY" ? "CN_REQUEST" : null);
    return {
      key, sourceType: r.sourceType, taskId: r.taskId, ownerId: r.ownerId, ownerName: person?.name ?? "—", territory: territory.get(r.ownerId) ?? null, state: person?.groupName ?? null,
      type: r.taskType, section: r.section, subtype, dealerId: r.dealerId, dealerName: r.dealerId ? (alias.get(r.dealerId) ?? r.dealerName) : r.dealerName, marketName: r.marketName, description: r.description,
      amount: r.amount == null ? null : Number(r.amount), originalDate: r.originalDate, originalVerified: r.originalVerified, currentDate: r.currentDate, moves: r.moves,
      daysMoved: daysMoved(r.originalDate, r.currentDate, r.originalVerified), status, historyState: deriveHistoryState({ gap: r.gap, moves: r.moves }), periodMoves: periodMoves ? (periodMoves.get(key) ?? 0) : null,
      category: r.category, target: r.target == null ? null : Number(r.target),
    };
  });
}

/* ------------------------------------------------ filters ------------------------------------------------ */

export interface TaskFilters {
  from: string; to: string; basis: DateBasis; type: "ALL" | TaskTypeKind; section: string; source: string; status: string; focusDate: string | null; page: number; pageSize: number;
}
/** Server messages come from the same Edit Labels store as the screen text; a lookup problem falls back to the defaults. */
export async function taskLabels(): Promise<Record<LabelKey, string>> {
  try { return await getResolvedLabels(); } catch { return { ...DEFAULT_LABELS } as Record<LabelKey, string>; }
}
export function parseTaskFilters(raw: Record<string, unknown>, today: string, L: Record<LabelKey, string> = DEFAULT_LABELS as Record<LabelKey, string>): TaskFilters {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const to = isDateKey(raw.to) ? raw.to : today;
  const from = isDateKey(raw.from) ? raw.from : to;
  if (from > to) throw new ApiError(422, L["tasks.error.range"]);
  const basis: DateBasis = raw.basis === "RESCHEDULED_ON" ? "RESCHEDULED_ON" : raw.basis === "ABANDONED_ON" ? "ABANDONED_ON" : "ORIGINAL";
  const type = raw.type === "AUTO" || raw.type === "MANUAL" ? raw.type : "ALL";
  const page = Math.max(1, Math.floor(Number(raw.page)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(raw.pageSize)) || 25));
  return { from, to, basis, type, section: str(raw.section), source: str(raw.source), status: TASK_STATUSES.includes(str(raw.status) as TaskStatus) ? str(raw.status) : "", focusDate: isDateKey(raw.focusDate) ? raw.focusDate : null, page, pageSize };
}

const keyPairs = (rows: readonly { sourceType: string; taskId: string }[]) => {
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.sourceType, [...(by.get(r.sourceType) ?? []), r.taskId]);
  return by;
};
const eventsWhere = (rows: readonly { sourceType: string; taskId: string }[]) => {
  const parts = [...keyPairs(rows)].map(([type, ids]) => Prisma.sql`(e."sourceType" = ${type} AND e."sourceId" IN (${Prisma.join(ids)}))`);
  return parts.length ? Prisma.sql`(${Prisma.join(parts, " OR ")})` : Prisma.sql`FALSE`;
};

/** The authorized, filtered task population (before the table's calendar-date focus): same rows for the summary, calendar and table. */
async function population(scope: TaskScope, f: TaskFilters, today: string): Promise<TaskRow[]> {
  const ownerIds = scope.population.map((p) => p.id);
  let rows: TaskRow[];
  if (f.basis === "ABANDONED_ON") {
    // Tasks abandoned (a submitted Abandon outcome) on a business date in the period, for the in-scope employees.
    const gone = ownerIds.length === 0 ? [] : await prisma.$queryRaw<{ unitType: string; unitId: string }[]>(Prisma.sql`
      SELECT u."unitType", u."unitId" FROM "DailyTaskOutcome" u
      WHERE u."officerId" IN (${Prisma.join(ownerIds)}) AND u."outcome" = 'ABANDONED' AND u."state" = 'COMMITTED'
        AND ((u."committedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date`);
    const keys = new Set(gone.map((g) => `${g.unitType === "MANUAL_ROW" ? "DAILY_WORK_ROW" : g.unitType}:${g.unitId}`));
    const raw = gone.length ? await loadRaw(null, { mode: "ids", ids: gone.map((g) => g.unitId) }) : [];
    rows = await hydrate(raw.filter((r) => keys.has(`${r.sourceType}:${r.taskId}`)), scope, today, new Map([...keys].map((k) => [k, 1])));
  } else if (f.basis === "RESCHEDULED_ON") {
    // The task population is "tasks with a date change MADE in the period" (by the business date of the change), for the in-scope employees.
    const moved = ownerIds.length === 0 ? [] : await prisma.$queryRaw<{ sourceType: string; sourceId: string; n: number }[]>(Prisma.sql`
      SELECT e."sourceType", e."sourceId", COUNT(*)::int AS "n" FROM "TaskRescheduleEvent" e
      WHERE e."ownerId" IN (${Prisma.join(ownerIds)}) AND ${ISTDATE} BETWEEN ${f.from}::date AND ${f.to}::date GROUP BY e."sourceType", e."sourceId"`);
    const periodMoves = new Map(moved.map((m) => [`${m.sourceType}:${m.sourceId}`, m.n]));
    const raw = moved.length ? await loadRaw(null, { mode: "ids", ids: moved.map((m) => m.sourceId) }) : [];
    rows = (await hydrate(raw.filter((r) => periodMoves.has(`${r.sourceType}:${r.taskId}`)), scope, today, periodMoves));
  } else {
    rows = await hydrate(await loadRaw(ownerIds, { mode: "original", from: f.from, to: f.to }), scope, today);
  }
  return rows.filter((r) => (f.type === "ALL" || r.type === f.type) && (!f.section || r.section === f.section) && (!f.source || r.subtype === f.source) && (!f.status || r.status === f.status));
}

const order = (a: TaskRow, b: TaskRow) => a.originalDate.localeCompare(b.originalDate) || a.ownerName.localeCompare(b.ownerName) || a.key.localeCompare(b.key);

export interface TaskAnalysisPayload {
  filters: Omit<TaskFilters, "page" | "pageSize">; summary: TaskSummary; rows: TaskRow[]; page: number; pageSize: number; totalRows: number; totalPages: number;
  /** Tasks matching the calendar-date focus (null when no date is focused). */
  focusCount: number | null; officers: TaskScope["officers"]; states: TaskScope["states"];
}

export async function getTaskAnalysis(scope: TaskScope, f: TaskFilters): Promise<TaskAnalysisPayload> {
  const today = currentBusinessDate();
  const all = await population(scope, f, today);
  const summary = summarizeTasks(all);
  let listed = all;
  let focusCount: number | null = null;
  if (f.focusDate) {
    // Only genuinely rescheduled tasks whose date trail touches the focused scheduled date.
    const moved = all.filter((r) => r.moves > 0);
    const hit = moved.length === 0 ? [] : await prisma.$queryRaw<{ sourceType: string; sourceId: string }[]>(Prisma.sql`
      SELECT DISTINCT e."sourceType", e."sourceId" FROM "TaskRescheduleEvent" e WHERE ${eventsWhere(moved)} AND (e."previousDate" = ${f.focusDate}::date OR e."newDate" = ${f.focusDate}::date)`);
    const keys = new Set(hit.map((h) => `${h.sourceType}:${h.sourceId}`));
    listed = moved.filter((r) => keys.has(r.key));
    focusCount = listed.length;
  }
  listed = [...listed].sort(order);
  const totalPages = Math.max(1, Math.ceil(listed.length / f.pageSize));
  const page = Math.min(f.page, totalPages);
  const { page: _p, pageSize: _s, ...filters } = f; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { filters, summary, rows: listed.slice((page - 1) * f.pageSize, page * f.pageSize), page, pageSize: f.pageSize, totalRows: listed.length, totalPages, focusCount, officers: scope.officers, states: scope.states };
}

/* ------------------------------------------------ reschedule calendar ------------------------------------------------ */

export interface RescheduleCalendarPayload {
  month: string; days: Record<string, number>; max: number;
  /** Distinct rescheduled tasks in the whole filtered population (the period total) and how many of them touch THIS month. */
  periodTasks: number; monthTasks: number;
}
export async function getRescheduleCalendar(scope: TaskScope, f: TaskFilters, month: string, L: Record<LabelKey, string> = DEFAULT_LABELS as Record<LabelKey, string>): Promise<RescheduleCalendarPayload> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError(422, L["tasks.error.month"]);
  const today = currentBusinessDate();
  const moved = (await population(scope, f, today)).filter((r) => r.moves > 0);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = `${month}-01`, end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const events = moved.length === 0 ? [] : await prisma.$queryRaw<{ sourceType: string; sourceId: string; previousDate: string; newDate: string }[]>(Prisma.sql`
    SELECT e."sourceType", e."sourceId", e."previousDate"::text AS "previousDate", e."newDate"::text AS "newDate" FROM "TaskRescheduleEvent" e
    WHERE ${eventsWhere(moved)} AND ((e."previousDate" BETWEEN ${start}::date AND ${end}::date) OR (e."newDate" BETWEEN ${start}::date AND ${end}::date))`);
  const datesByTask = new Map<string, Set<string>>();
  for (const e of events) {
    const k = `${e.sourceType}:${e.sourceId}`;
    const set = datesByTask.get(k) ?? new Set<string>();
    for (const d of [e.previousDate, e.newDate]) if (d >= start && d <= end) set.add(d);
    datesByTask.set(k, set);
  }
  const counts = rescheduleCalendarCounts([...datesByTask].map(([key, dates]) => ({ key, dates: [...dates] })));
  const days = Object.fromEntries(counts);
  return { month, days, max: Math.max(0, ...counts.values()), periodTasks: moved.length, monthTasks: datesByTask.size };
}

/* ------------------------------------------------ one task's history ------------------------------------------------ */

export interface TaskHistoryEvent { id: string; previousDate: string; newDate: string; actorName: string; actorRole: string; reason: string | null; createdAt: string }
/** A SUBMITTED Daily Report outcome of this task: how it ended (or was moved), with who / when and, for an abandonment, the reason. */
export interface TaskOutcomeEvent { outcome: "COMPLETED" | "RESCHEDULED" | "ABANDONED"; workDate: string; actualAmount: number | null; nextDate: string | null; reason: string | null; committedAt: string; committedByName: string | null }
export interface TaskHistoryPayload { task: TaskRow; events: TaskHistoryEvent[]; outcomes: TaskOutcomeEvent[]; trail: string[]; chainOk: boolean; distinctDates: string[] }

/** Read-only. The task must belong to an employee inside the caller's authorized population (anything else looks missing). */
export async function getTaskHistory(scope: TaskScope, sourceType: string, taskId: string): Promise<TaskHistoryPayload> {
  const today = currentBusinessDate();
  const ownerIds = scope.population.map((p) => p.id);
  const found = (await loadRaw(ownerIds, { mode: "ids", ids: [taskId] })).filter((r) => r.sourceType === sourceType && r.taskId === taskId);
  const rows = found.filter((r) => ownerIds.includes(r.ownerId)); // the task must belong to an employee in the caller's scope
  const task = (await hydrate(rows, scope, today))[0];
  if (!task) throw new ApiError(404, (await taskLabels())["tasks.error.not_found"]);
  const events = (await prisma.$queryRaw<{ id: string; previousDate: string; newDate: string; actorName: string; actorRole: string; reason: string | null; createdAt: Date }[]>(Prisma.sql`
    SELECT e."id", e."previousDate"::text AS "previousDate", e."newDate"::text AS "newDate", e."actorName", e."actorRole", e."reason", e."createdAt"
    FROM "TaskRescheduleEvent" e WHERE e."sourceType" = ${sourceType} AND e."sourceId" = ${taskId} ORDER BY e."createdAt", e."id"`)).map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }));
  const { trail, chainOk } = dateTrail(events);
  const unitType = sourceType === "DAILY_WORK_ROW" ? "MANUAL_ROW" : sourceType;
  const outcomes = (await prisma.$queryRaw<{ outcome: TaskOutcomeEvent["outcome"]; workDate: string; actualAmount: string | null; nextDate: string | null; reason: string | null; committedAt: Date; committedByName: string | null }[]>(Prisma.sql`
    SELECT u."outcome", u."workDate"::text AS "workDate", u."actualAmount"::text AS "actualAmount", u."nextDate"::text AS "nextDate", u."reason", u."committedAt", u."committedByName"
    FROM "DailyTaskOutcome" u WHERE u."state" = 'COMMITTED' AND ((u."unitType" = ${unitType} AND u."unitId" = ${taskId}) OR (u."continuedAsType" = ${sourceType} AND u."continuedAsId" = ${taskId}))
    ORDER BY u."committedAt", u."id"`)).map((o) => ({ ...o, actualAmount: o.actualAmount == null ? null : Number(o.actualAmount), committedAt: o.committedAt.toISOString() }));
  return { task, events, outcomes, trail, chainOk, distinctDates: distinctTrailDates(trail) };
}

/* ------------------------------------------------ compact Task Activity for the Performance table ------------------------------------------------ */

export interface TaskActivityCell {
  tasks: number; completed: number; reschedules: number; abandoned: number;
  /** Distinct tasks of the cell by Daily Work section (SALES, RECOVERY, APPOINTMENT, VISITS, …) — sums to `tasks`. */
  sections: Record<string, number>;
}
/**
 * For each (employee, date) of the Performance table, in two batch queries (never one per row):
 *  • tasks / completed — distinct tasks ORIGINALLY scheduled for that employee on that date, and how many of those are completed;
 *  • reschedules — date-change events MADE on that business date for that employee's tasks (whatever dates the tasks were originally scheduled for).
 */
export async function getTaskActivity(scope: TaskScope, from: string, to: string): Promise<Map<string, TaskActivityCell>> {
  const today = currentBusinessDate();
  const ownerIds = scope.population.map((p) => p.id);
  const out = new Map<string, TaskActivityCell>();
  if (ownerIds.length === 0) return out;
  const cell = (owner: string, date: string) => { const k = `${owner}|${date}`; let c = out.get(k); if (!c) { c = { tasks: 0, completed: 0, reschedules: 0, abandoned: 0, sections: {} }; out.set(k, c); } return c; };
  const [raw, moved, gone] = await Promise.all([
    loadRaw(ownerIds, { mode: "original", from, to }),
    prisma.$queryRaw<{ ownerId: string; d: string; n: number }[]>(Prisma.sql`
      SELECT e."ownerId", ${ISTDATE}::text AS "d", COUNT(*)::int AS "n" FROM "TaskRescheduleEvent" e
      WHERE e."ownerId" IN (${Prisma.join(ownerIds)}) AND ${ISTDATE} BETWEEN ${from}::date AND ${to}::date GROUP BY e."ownerId", ${ISTDATE}`),
    // Tasks abandoned on that business date (a submitted Abandon outcome), per employee — whatever date they were originally scheduled for.
    prisma.$queryRaw<{ ownerId: string; d: string; n: number }[]>(Prisma.sql`
      SELECT u."officerId" AS "ownerId", ((u."committedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date::text AS "d", COUNT(*)::int AS "n" FROM "DailyTaskOutcome" u
      WHERE u."officerId" IN (${Prisma.join(ownerIds)}) AND u."outcome" = 'ABANDONED' AND u."state" = 'COMMITTED'
        AND ((u."committedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1, 2`),
  ]);
  for (const r of raw) {
    const c = cell(r.ownerId, r.originalDate);
    c.tasks++;
    c.sections[r.section] = (c.sections[r.section] ?? 0) + 1;
    if (deriveTaskStatus({ completed: r.completed, cancelled: r.cancelled, abandoned: r.abandoned, currentDate: r.currentDate, today }) === "COMPLETED") c.completed++;
  }
  for (const m of moved) cell(m.ownerId, m.d).reschedules += m.n;
  for (const g of gone) cell(g.ownerId, g.d).abandoned += g.n;
  return out;
}
