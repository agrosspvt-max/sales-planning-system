/**
 * Performance → Tasks — pure rules (no database). One definition of: how a task's status is derived, what its history can truthfully say, which scheduled dates a task's
 * moves touch, how the reschedule calendar is counted, how the summary figures are computed and how a long history is previewed.
 */

export type TaskTypeKind = "AUTO" | "MANUAL";
export type TaskStatus = "COMPLETED" | "PENDING" | "OVERDUE" | "CANCELLED" | "ABANDONED";
export const TASK_STATUSES: readonly TaskStatus[] = ["COMPLETED", "PENDING", "OVERDUE", "CANCELLED", "ABANDONED"];

/**
 * Completed (a submitted Completed outcome; for a task never given one, its source's own legacy evidence) / Abandoned / Cancelled come ONLY from explicit evidence (never from "in Daily Work", materialized, confirmed or plan submitted, and never from a reschedule).
 * Everything else is open: Overdue when its CURRENT scheduled date has passed, otherwise Pending (today counts as not yet passed).
 */
export function deriveTaskStatus(t: { completed: boolean; cancelled: boolean; abandoned?: boolean; currentDate: string; today: string }): TaskStatus {
  if (t.cancelled) return "CANCELLED";
  if (t.abandoned) return "ABANDONED"; // an explicit, submitted Abandon outcome: its own state, never Pending / Overdue / Completed
  if (t.completed) return "COMPLETED";
  return t.currentDate < t.today ? "OVERDUE" : "PENDING";
}

/**
 * What the recorded history can honestly say. COMPLETE = every move since the task was created is recorded (a verified count, possibly zero). PARTIAL = the task was moved
 * before history was recorded (a gap) but later moves are recorded. UNAVAILABLE = it has such a gap and nothing is recorded: the count is unknown, NOT zero.
 */
export type HistoryState = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export function deriveHistoryState(t: { gap: boolean; moves: number }): HistoryState {
  if (!t.gap) return "COMPLETE";
  return t.moves > 0 ? "PARTIAL" : "UNAVAILABLE";
}

export const daysBetweenDates = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** Signed days from the original to the current date (positive = later); null when the original date is not verified. */
export const daysMoved = (original: string, current: string, originalVerified: boolean): number | null => (originalVerified ? daysBetweenDates(original, current) : null);

export interface RescheduleEventLite { previousDate: string; newDate: string; createdAt: string }

/**
 * The ordered date trail of a task: where it was originally due, then every date it was moved to (a revisited date appears again — the trail is the real sequence).
 * `chainOk` is false when an event does not continue from the previous one (recorded history that cannot be trusted as a chain).
 */
export function dateTrail(events: readonly RescheduleEventLite[]): { trail: string[]; chainOk: boolean } {
  if (events.length === 0) return { trail: [], chainOk: true };
  const trail = [events[0]!.previousDate];
  let chainOk = true;
  for (const e of events) {
    if (trail[trail.length - 1] !== e.previousDate) chainOk = false;
    trail.push(e.newDate);
  }
  return { trail, chainOk };
}
/** The DISTINCT scheduled dates a task touched (a task that left and later returned to a date still counts that date once). */
export const distinctTrailDates = (trail: readonly string[]): string[] => [...new Set(trail)];

/**
 * Reschedule-calendar counts: for each scheduled date, how many DISTINCT tasks (with at least one genuine reschedule) involve it. A task moved A → B → C counts once on each of
 * A, B and C (one task, two reschedules); a task that returns to a date counts once there. Tasks that were never moved do not contribute.
 */
export function rescheduleCalendarCounts(tasks: readonly { key: string; dates: readonly string[] }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tasks) for (const d of new Set(t.dates)) out.set(d, (out.get(d) ?? 0) + 1);
  return out;
}

export interface SummaryTask { status: TaskStatus; moves: number; historyState: HistoryState }
export interface TaskSummary {
  total: number; completed: number; pending: number; overdue: number; cancelled: number; abandoned: number;
  /** Distinct tasks with at least one RECORDED reschedule. */
  rescheduledTasks: number;
  /** Recorded reschedules across those tasks. */
  totalReschedules: number;
  /** totalReschedules ÷ total (0 for an empty population — never a division error), rounded to 2 decimals. */
  averageReschedules: number;
  /** Tasks whose history is partial / unavailable: their earlier moves are NOT in the three reschedule figures above. */
  incompleteHistory: number;
}
export function summarizeTasks(tasks: readonly SummaryTask[]): TaskSummary {
  const total = tasks.length;
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const totalReschedules = tasks.reduce((n, t) => n + t.moves, 0);
  return {
    total, completed: count("COMPLETED"), pending: count("PENDING"), overdue: count("OVERDUE"), cancelled: count("CANCELLED"), abandoned: count("ABANDONED"),
    rescheduledTasks: tasks.filter((t) => t.moves > 0).length, totalReschedules,
    averageReschedules: total === 0 ? 0 : Math.round((totalReschedules / total) * 100) / 100,
    incompleteHistory: tasks.filter((t) => t.historyState !== "COMPLETE").length,
  };
}

/**
 * A long history shows its first and last steps with an explicit "N moves not shown" marker between them, so the preview never implies that non-adjacent moves were consecutive.
 * (`full` shows everything.)
 */
export type HistorySegment<T> = { kind: "event"; index: number; event: T } | { kind: "omitted"; count: number };
export function previewHistory<T>(events: readonly T[], full: boolean, head = 2, tail = 2): HistorySegment<T>[] {
  const all = events.map((event, index): HistorySegment<T> => ({ kind: "event", index, event }));
  if (full || events.length <= head + tail + 1) return all;
  return [...all.slice(0, head), { kind: "omitted", count: events.length - head - tail }, ...all.slice(events.length - tail)];
}

export type DateBasis = "ORIGINAL" | "RESCHEDULED_ON" | "ABANDONED_ON";
export const isDateKey = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/* ------------------------------------------------ client filter state (shared by the page, the calendar and the Performance links) ------------------------------------------------ */

export interface TaskFilterState {
  from: string; to: string; basis: DateBasis; officerId: string; groupId: string;
  type: "ALL" | TaskTypeKind; section: string; source: string; status: string;
  /** A scheduled date picked on the reschedule calendar: narrows ONLY the table (never the summary or the calendar's own population). */
  focusDate: string | null; page: number;
}
/** First and last day of the month containing `today`. */
export function monthBounds(today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return { from: `${y}-${String(m).padStart(2, "0")}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
/** Tasks opens on Auto, for the current month by Original Due Date. */
export const defaultTaskFilters = (today: string, type: TaskFilterState["type"] = "AUTO"): TaskFilterState => ({ ...monthBounds(today), basis: "ORIGINAL", officerId: "", groupId: "", type, section: "", source: "", status: "", focusDate: null, page: 1 });
/** The query for the table (`table`) or for the population-only endpoints (summary / calendar: no date focus, no page). */
export function taskQueryString(f: TaskFilterState, scope: "table" | "population", extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ from: f.from, to: f.to, basis: f.basis, type: f.type });
  for (const [k, v] of [["officerId", f.officerId], ["groupId", f.groupId], ["section", f.section], ["source", f.source], ["status", f.status]] as const) if (v) q.set(k, v);
  if (scope === "table") { if (f.focusDate) q.set("focusDate", f.focusDate); q.set("page", String(f.page)); }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}
export const shiftMonth = (month: string, delta: number): string => { const [y, m] = month.split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + delta, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
/** Intensity level 0..5 on ONE scale: 0 = nothing; the busiest date of the month is level 5. */
export function intensityLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((count / max) * 5)));
}


/**
 * List order for Performance rows and Tasks: date newest first (ISO YYYY-MM-DD strings, never display text; a missing date sorts last), then employee name A–Z ignoring case,
 * then stable identifiers (owner id, then the record key) so equal names or several records of one employee on one date never reorder between requests.
 */
export function compareListRows(a: { date: string | null; name: string; ownerId: string; key: string }, b: { date: string | null; name: string; ownerId: string; key: string }): number {
  if (a.date !== b.date) { if (a.date === null) return 1; if (b.date === null) return -1; return a.date < b.date ? 1 : -1; }
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name) || a.ownerId.localeCompare(b.ownerId) || a.key.localeCompare(b.key);
}
