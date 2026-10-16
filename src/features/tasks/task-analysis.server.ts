import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";
import { currentBusinessDate } from "@/lib/daily-work";
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
 * Reminders, meetings, notes and other calendar-only entries are NOT tasks. "In Daily Work", materialized, confirmed or plan-submitted never means Completed, and a reschedule never does.
 * No source here supports cancelled / withdrawn tasks today; the status exists and is kept distinct for when one does.
 *
 * DATE MEANINGS (never mixed): ORIGINAL = the task's original scheduled date (Original Due Date; permanent); the CURRENT scheduled date is separate; RESCHEDULED_ON = the business
 * (Asia/Kolkata) date a date change was MADE. Scope is decided by the caller's authoritative Performance population (SO self / RM team / Admin all, State and employee narrowing only).
 */

export interface TaskScopePerson { id: string; name: string; role: string; groupId: string | null; groupName: string | null }
export interface TaskScope { population: TaskScopePerson[]; officers: { id: string; name: string }[]; states: { id: string; name: string }[] }

export type TaskSource = "BILLING_EXCEPTION" | "CN_PAYMENT" | "CN_LEGACY" | "CALENDAR_ENTRY" | "DAILY_WORK_ROW";
export interface TaskRow {
  key: string; sourceType: TaskSource; taskId: string; ownerId: string; ownerName: string; territory: string | null; state: string | null;
  type: TaskTypeKind; section: string; subtype: TaskSubtype; dealerId: string | null; dealerName: string | null; marketName: string | null; description: string | null; amount: number | null;
  originalDate: string; originalVerified: boolean; currentDate: string; moves: number; daysMoved: number | null; status: TaskStatus; historyState: HistoryState; periodMoves: number | null;
}

interface RawTask {
  sourceType: TaskSource; taskId: string; ownerId: string; dealerId: string | null; dealerName: string | null; marketName: string | null; description: string | null; amount: string | null;
  section: string; entryType: string | null; schemeName: string | null; taskType: TaskTypeKind; originalDate: string; originalVerified: boolean; currentDate: string;
  moves: number; gap: boolean; completed: boolean; cancelled: boolean;
}

// The business-timezone literal is inlined (a bind parameter would make the SELECT and GROUP BY expressions differ).
const ISTDATE = Prisma.sql`((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date`;
/** Per-task move count + the FIRST event's previous date, from the immutable history (one indexed lateral lookup per task). */
const evLateral = (type: string, idCol: Prisma.Sql) => Prisma.sql`LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS "moves", (array_agg(e."previousDate" ORDER BY e."createdAt", e."id"))[1] AS "first"
  FROM "TaskRescheduleEvent" e WHERE e."sourceType" = ${type} AND e."sourceId" = ${idCol}) ev ON true`;

type Pick = { mode: "original"; from: string; to: string } | { mode: "ids"; ids: readonly string[] };
const SELECT_COLS = Prisma.sql`"sourceType","taskId","ownerId","dealerId","dealerName","marketName","description","amount","section","entryType","schemeName","taskType","originalDate","originalVerified","currentDate","moves","gap","completed","cancelled"`;

async function loadSource(inner: Prisma.Sql, ownerIds: readonly string[] | null, pick: Pick): Promise<RawTask[]> {
  const owners = ownerIds ? (ownerIds.length ? Prisma.sql`AND q."ownerId" IN (${Prisma.join(ownerIds)})` : Prisma.sql`AND FALSE`) : Prisma.empty;
  const picked = pick.mode === "original" ? Prisma.sql`AND q."originalDate" BETWEEN ${pick.from} AND ${pick.to}` : pick.ids.length ? Prisma.sql`AND q."taskId" IN (${Prisma.join(pick.ids)})` : Prisma.sql`AND FALSE`;
  return prisma.$queryRaw<RawTask[]>(Prisma.sql`SELECT ${SELECT_COLS} FROM (${inner}) q WHERE TRUE ${owners} ${picked}`);
}

const billingSql = () => Prisma.sql`
  SELECT 'BILLING_EXCEPTION' AS "sourceType", t."id" AS "taskId",
    CASE WHEN t."dailyWorkEntryId" IS NULL THEN COALESCE((SELECT da."officerId" FROM "DealerAssignment" da WHERE da."dealerId" = t."dealerId" AND da."effectiveTo" IS NULL ORDER BY da."effectiveFrom" DESC, da."createdAt" DESC LIMIT 1), t."officerId") ELSE t."officerId" END AS "ownerId",
    t."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", t."amount"::text AS "amount", 'RECOVERY' AS "section", NULL::text AS "entryType", NULL::text AS "schemeName", 'AUTO' AS "taskType",
    t."promisedDate"::text AS "originalDate", true AS "originalVerified", t."taskDate"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", t."rescheduleHistoryGap" AS "gap",
    (be."status" = 'RESOLVED' AND be."resolutionReason" = 'PAYMENT_RECEIVED') AS "completed", false AS "cancelled"
  FROM "BillingExceptionTask" t JOIN "BillingException" be ON be."id" = t."billingExceptionId" JOIN "Dealer" d ON d."id" = t."dealerId"
  ${evLateral("BILLING_EXCEPTION", Prisma.sql`t."id"`)}`;

const cnPaymentSql = (owners: readonly string[] | null) => Prisma.sql`
  SELECT 'CN_PAYMENT' AS "sourceType", e0."id" AS "taskId", c."officerId" AS "ownerId", c."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", e0."taskAmount"::text AS "amount",
    'RECOVERY' AS "section", NULL::text AS "entryType", NULL::text AS "schemeName", 'AUTO' AS "taskType",
    COALESCE(ev."first", e0."taskDate")::text AS "originalDate", NOT e0."rescheduleHistoryGap" AS "originalVerified", e0."taskDate"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", e0."rescheduleHistoryGap" AS "gap",
    (e0."taskStatus" = 'COMPLETED') AS "completed", false AS "cancelled"
  FROM "CnPaymentEvent" e0 JOIN "CnRequest" c ON c."id" = e0."cnRequestId" JOIN "Dealer" d ON d."id" = c."dealerId"
  ${evLateral("CN_PAYMENT", Prisma.sql`e0."id"`)}
  WHERE e0."taskDate" IS NOT NULL AND e0."taskStatus" IS NOT NULL AND e0."taskAmount" > 0 ${owners ? (owners.length ? Prisma.sql`AND c."officerId" IN (${Prisma.join(owners)})` : Prisma.sql`AND FALSE`) : Prisma.empty}`;

const cnLegacySql = (owners: readonly string[] | null) => Prisma.sql`
  SELECT 'CN_LEGACY' AS "sourceType", c."id" AS "taskId", c."officerId" AS "ownerId", c."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", c."amount"::text AS "amount",
    'RECOVERY' AS "section", NULL::text AS "entryType", NULL::text AS "schemeName", 'AUTO' AS "taskType",
    COALESCE(ev."first", c."taskDate")::text AS "originalDate", false AS "originalVerified", c."taskDate"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", c."rescheduleHistoryGap" AS "gap",
    (c."status" <> 'ACCEPTED_NOT_POSTED') AS "completed", false AS "cancelled"
  FROM "CnRequest" c JOIN "Dealer" d ON d."id" = c."dealerId"
  ${evLateral("CN_LEGACY", Prisma.sql`c."id"`)}
  WHERE c."paymentTrackingMode" IS NULL AND c."acceptanceReason" = 'PAYMENT_PENDING' AND c."taskDate" IS NOT NULL AND c."amount" > 0 ${owners ? (owners.length ? Prisma.sql`AND c."officerId" IN (${Prisma.join(owners)})` : Prisma.sql`AND FALSE`) : Prisma.empty}`;

/** The Daily Work row a manual task landed in counts as COMPLETED only through a FINALIZED report whose row met its target (Sales / Recovery: actual ≥ plan; Appointment: Appointed; Visits: actual ≥ planned; Others: finalized). */
const manualDone = Prisma.sql`COALESCE((dd."id" IS NOT NULL AND w."id" IS NOT NULL AND CASE ce."taskSection"
    WHEN 'SALES' THEN COALESCE(w."todaysPlan", 0) > 0 AND COALESCE(w."todaysActual", 0) >= COALESCE(w."todaysPlan", 0)
    WHEN 'RECOVERY' THEN COALESCE(w."todaysPlan", 0) > 0 AND COALESCE(w."todaysActual", 0) >= COALESCE(w."todaysPlan", 0)
    WHEN 'APPOINTMENT' THEN w."resultStatus" = 'APPOINTED'
    WHEN 'VISITS' THEN COALESCE(w."dealerVisits", 0) + COALESCE(w."newPartyVisits", 0) > 0 AND COALESCE(w."actualDealerVisits", 0) + COALESCE(w."actualNewPartyVisits", 0) >= COALESCE(w."dealerVisits", 0) + COALESCE(w."newPartyVisits", 0)
    WHEN 'OTHERS' THEN true ELSE false END), false)`;
const calendarSql = (owners: readonly string[] | null) => Prisma.sql`
  SELECT 'CALENDAR_ENTRY' AS "sourceType", ce."id" AS "taskId", ce."ownerId", ce."dealerId", COALESCE(d."name", ce."typedDealerName") AS "dealerName", ce."marketName", ce."text" AS "description", ce."amount"::text AS "amount",
    ce."taskSection" AS "section", ce."entryType", sc."schemeName", 'MANUAL' AS "taskType",
    COALESCE(ev."first", ce."date")::text AS "originalDate", true AS "originalVerified", ce."date"::text AS "currentDate", COALESCE(ev."moves", 0) AS "moves", false AS "gap", ${manualDone} AS "completed", false AS "cancelled"
  FROM "CalendarEntry" ce LEFT JOIN "Dealer" d ON d."id" = ce."dealerId" LEFT JOIN "Scheme" sc ON sc."id" = ce."schemeId"
  LEFT JOIN "DailyWorkEntry" w ON w."id" = ce."dailyWorkEntryId"
  LEFT JOIN "DailyWorkDay" dd ON dd."officerId" = w."officerId" AND dd."workDate" = w."workDate" AND dd."status" = 'FINALIZED'
  ${evLateral("CALENDAR_ENTRY", Prisma.sql`ce."id"`)}
  WHERE ce."kind" = 'TASK' ${owners ? (owners.length ? Prisma.sql`AND ce."ownerId" IN (${Prisma.join(owners)})` : Prisma.sql`AND FALSE`) : Prisma.empty}`;

const dailyRowSql = (owners: readonly string[] | null, window: { from: string; to: string } | null) => Prisma.sql`
  SELECT 'DAILY_WORK_ROW' AS "sourceType", w."id" AS "taskId", w."officerId" AS "ownerId", w."dealerId", d."name" AS "dealerName", NULL::text AS "marketName", NULL::text AS "description", (w."todaysPlan" - COALESCE(c."sum", 0))::text AS "amount",
    w."section", w."entryType", sc."schemeName", 'MANUAL' AS "taskType", w."workDate"::text AS "originalDate", true AS "originalVerified", w."workDate"::text AS "currentDate", 0 AS "moves", false AS "gap",
    COALESCE((dd."id" IS NOT NULL AND COALESCE(w."todaysActual", 0) >= w."todaysPlan"), false) AS "completed", false AS "cancelled"
  FROM "DailyWorkEntry" w LEFT JOIN "Dealer" d ON d."id" = w."dealerId" LEFT JOIN "Scheme" sc ON sc."id" = w."schemeId"
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(x."contribution"), 0) AS "sum" FROM (
      SELECT "dailyWorkContribution" AS "contribution" FROM "BillingExceptionTask" WHERE "dailyWorkEntryId" = w."id"
      UNION ALL SELECT "dailyWorkContribution" FROM "CnPaymentEvent" WHERE "dailyWorkEntryId" = w."id"
      UNION ALL SELECT "legacyDailyWorkContribution" FROM "CnRequest" WHERE "legacyDailyWorkEntryId" = w."id"
      UNION ALL SELECT "dailyWorkContribution" FROM "CalendarEntry" WHERE "dailyWorkEntryId" = w."id") x) c ON true
  LEFT JOIN "DailyWorkDay" dd ON dd."officerId" = w."officerId" AND dd."workDate" = w."workDate" AND dd."status" = 'FINALIZED'
  WHERE w."section" IN ('SALES', 'RECOVERY') AND w."status" <> 'DRAFT' AND w."todaysPlan" - COALESCE(c."sum", 0) > 0
    ${window ? Prisma.sql`AND w."workDate" BETWEEN ${window.from}::date AND ${window.to}::date` : Prisma.empty}
    ${owners ? (owners.length ? Prisma.sql`AND w."officerId" IN (${Prisma.join(owners)})` : Prisma.sql`AND FALSE`) : Prisma.empty}`;

async function loadRaw(ownerIds: readonly string[] | null, pick: Pick): Promise<RawTask[]> {
  const window = pick.mode === "original" ? { from: pick.from, to: pick.to } : null;
  const ids = pick.mode === "ids" ? pick.ids : null;
  // `ids` mode only ever asks for tasks that have history events (Daily Work rows have none), so the Daily Work row source is skipped there.
  const parts = await Promise.all([
    loadSource(billingSql(), ownerIds, pick), loadSource(cnPaymentSql(ownerIds), null, pick), loadSource(cnLegacySql(ownerIds), null, pick),
    loadSource(calendarSql(ownerIds), null, pick), ids ? Promise.resolve([] as RawTask[]) : loadSource(dailyRowSql(ownerIds, window), null, pick),
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
    const status = deriveTaskStatus({ completed: r.completed, cancelled: r.cancelled, currentDate: r.currentDate, today });
    const subtype = taskSubtype(r.section, r.entryType, r.sourceType === "BILLING_EXCEPTION" ? "BILLING_EXCEPTION" : r.sourceType === "CN_PAYMENT" || r.sourceType === "CN_LEGACY" ? "CN_REQUEST" : null);
    return {
      key, sourceType: r.sourceType, taskId: r.taskId, ownerId: r.ownerId, ownerName: person?.name ?? "—", territory: territory.get(r.ownerId) ?? null, state: person?.groupName ?? null,
      type: r.taskType, section: r.section, subtype, dealerId: r.dealerId, dealerName: r.dealerId ? (alias.get(r.dealerId) ?? r.dealerName) : r.dealerName, marketName: r.marketName, description: r.description,
      amount: r.amount == null ? null : Number(r.amount), originalDate: r.originalDate, originalVerified: r.originalVerified, currentDate: r.currentDate, moves: r.moves,
      daysMoved: daysMoved(r.originalDate, r.currentDate, r.originalVerified), status, historyState: deriveHistoryState({ gap: r.gap, moves: r.moves }), periodMoves: periodMoves ? (periodMoves.get(key) ?? 0) : null,
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
  const basis: DateBasis = raw.basis === "RESCHEDULED_ON" ? "RESCHEDULED_ON" : "ORIGINAL";
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
  if (f.basis === "RESCHEDULED_ON") {
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
export interface TaskHistoryPayload { task: TaskRow; events: TaskHistoryEvent[]; trail: string[]; chainOk: boolean; distinctDates: string[] }

/** Read-only. The task must belong to an employee inside the caller's authorized population (anything else looks missing). */
export async function getTaskHistory(scope: TaskScope, sourceType: string, taskId: string): Promise<TaskHistoryPayload> {
  const today = currentBusinessDate();
  const ownerIds = scope.population.map((p) => p.id);
  const found = sourceType === "DAILY_WORK_ROW"
    ? await loadSource(dailyRowSql(ownerIds, null), null, { mode: "ids", ids: [taskId] })
    : (await loadRaw(ownerIds, { mode: "ids", ids: [taskId] })).filter((r) => r.sourceType === sourceType && r.taskId === taskId);
  const rows = found.filter((r) => ownerIds.includes(r.ownerId)); // the task must belong to an employee in the caller's scope
  const task = (await hydrate(rows, scope, today))[0];
  if (!task) throw new ApiError(404, (await taskLabels())["tasks.error.not_found"]);
  const events = (await prisma.$queryRaw<{ id: string; previousDate: string; newDate: string; actorName: string; actorRole: string; reason: string | null; createdAt: Date }[]>(Prisma.sql`
    SELECT e."id", e."previousDate"::text AS "previousDate", e."newDate"::text AS "newDate", e."actorName", e."actorRole", e."reason", e."createdAt"
    FROM "TaskRescheduleEvent" e WHERE e."sourceType" = ${sourceType} AND e."sourceId" = ${taskId} ORDER BY e."createdAt", e."id"`)).map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }));
  const { trail, chainOk } = dateTrail(events);
  return { task, events, trail, chainOk, distinctDates: distinctTrailDates(trail) };
}

/* ------------------------------------------------ compact Task Activity for the Performance table ------------------------------------------------ */

export interface TaskActivityCell { tasks: number; completed: number; reschedules: number }
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
  const cell = (owner: string, date: string) => { const k = `${owner}|${date}`; let c = out.get(k); if (!c) { c = { tasks: 0, completed: 0, reschedules: 0 }; out.set(k, c); } return c; };
  const [raw, moved] = await Promise.all([
    loadRaw(ownerIds, { mode: "original", from, to }),
    prisma.$queryRaw<{ ownerId: string; d: string; n: number }[]>(Prisma.sql`
      SELECT e."ownerId", ${ISTDATE}::text AS "d", COUNT(*)::int AS "n" FROM "TaskRescheduleEvent" e
      WHERE e."ownerId" IN (${Prisma.join(ownerIds)}) AND ${ISTDATE} BETWEEN ${from}::date AND ${to}::date GROUP BY e."ownerId", ${ISTDATE}`),
  ]);
  for (const r of raw) {
    const c = cell(r.ownerId, r.originalDate);
    c.tasks++;
    if (deriveTaskStatus({ completed: r.completed, cancelled: r.cancelled, currentDate: r.currentDate, today }) === "COMPLETED") c.completed++;
  }
  for (const m of moved) cell(m.ownerId, m.d).reschedules += m.n;
  return out;
}
