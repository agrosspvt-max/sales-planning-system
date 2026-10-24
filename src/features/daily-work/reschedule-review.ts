/**
 * Daily Work Review → rescheduling. PURE assembly (no database, no clock) of what the detail dialog shows about moved tasks for one employee and one business date.
 *
 * Two concepts are kept apart everywhere:
 *  • SCHEDULED-date history — `from` / `to`: the task was moved FROM another date TO this one (incoming) / away from this one TO another (outgoing).
 *  • ACTION history — `actions`: date-change events PERFORMED on this business date (Asia/Kolkata), whatever dates the tasks were scheduled for. Their number is exactly the Performance row's "N reschedules".
 *
 * Tasks are followed by their stable identity (`<sourceType>:<sourceId>` of the immutable TaskRescheduleEvent), never by the task's current Daily Work link or current date. A manual Daily Work
 * row that continued as a Calendar task is followed through the continuation the committed outcome recorded. Nothing here changes a total, an amount or an outcome: these are display records.
 */
export interface RescheduleEventInput {
  id: string; sourceType: string; sourceId: string; ownerId: string;
  previousDate: string; newDate: string; actorName: string; reason: string | null;
  createdAt: string; // ISO instant
  actionDate: string; // YYYY-MM-DD, the Asia/Kolkata business date the change was made
}
export interface TaskDescriptor {
  dealerName: string | null; marketName: string | null; description: string | null; section: string; historyState: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
}
/** One Daily Work row (a dealer row of Sales / Recovery) with the tasks the report/plan reader attributed to it. */
export interface ReviewRowInput { entryId: string; units: { unitType: string; unitId: string }[] }

export interface TaskMoveDto {
  key: string; sourceType: string; sourceId: string;
  /** Incoming: the date the task was moved from to arrive on the reviewed date. */
  from: string | null;
  /** Outgoing: the date the task was moved to from the reviewed date. */
  to: string | null;
  /** Lifetime recorded moves of THIS task (never a sum over the dealer's tasks). */
  count: number;
  /** true when earlier history is incomplete: only the recorded moves are known. */
  recordedOnly: boolean;
  dealerName: string | null; marketName: string | null; description: string | null; section: string | null;
}
export interface RescheduleActionDto {
  id: string; key: string; sourceType: string; section: string | null;
  dealerName: string | null; marketName: string | null; description: string | null;
  previousDate: string; newDate: string; createdAt: string; actorName: string; reason: string | null;
  count: number; recordedOnly: boolean;
}
export interface ReschedulingReview {
  /** Moves attached to the Daily Work rows of the reviewed date, by row. */
  rows: Record<string, TaskMoveDto[]>;
  /** Tasks moved to / from the reviewed date that have no row in the day's tables (history only — never part of totals). */
  tasks: TaskMoveDto[];
  actions: RescheduleActionDto[];
}

const SOURCE_OF_UNIT: Record<string, string> = { BILLING_EXCEPTION: "BILLING_EXCEPTION", CN_PAYMENT: "CN_PAYMENT", CN_LEGACY: "CN_LEGACY", CALENDAR_ENTRY: "CALENDAR_ENTRY" };
export const taskKey = (sourceType: string, sourceId: string) => `${sourceType}:${sourceId}`;
const byTime = (a: RescheduleEventInput, b: RescheduleEventInput) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildReschedulingReview(p: {
  officerId: string; date: string;
  /** Every recorded event of every task that touches the date (lifetime history of those tasks). */
  events: readonly RescheduleEventInput[];
  descriptors: ReadonlyMap<string, TaskDescriptor>;
  rows: readonly ReviewRowInput[];
  /** Manual row entry id → the Calendar task it continued as (from its committed Reschedule outcome). */
  continuations: ReadonlyMap<string, { type: string; id: string }>;
}): ReschedulingReview {
  const history = new Map<string, RescheduleEventInput[]>();
  for (const e of p.events) { const k = taskKey(e.sourceType, e.sourceId); history.set(k, [...(history.get(k) ?? []), e]); }
  for (const list of history.values()) list.sort(byTime);

  const describe = (k: string) => p.descriptors.get(k);
  const move = (k: string): TaskMoveDto => {
    const list = history.get(k) ?? [];
    const [sourceType, ...rest] = k.split(":");
    const d = describe(k);
    return {
      key: k, sourceType: sourceType!, sourceId: rest.join(":"),
      from: list.filter((e) => e.newDate === p.date).at(-1)?.previousDate ?? null,
      to: list.filter((e) => e.previousDate === p.date).at(-1)?.newDate ?? null,
      count: list.length,
      recordedOnly: !d || d.historyState !== "COMPLETE",
      dealerName: d?.dealerName ?? null, marketName: d?.marketName ?? null, description: d?.description ?? null, section: d?.section ?? null,
    };
  };

  // Rows: follow each unit by identity; a manual row continues as the Calendar task its outcome recorded.
  const rows: Record<string, TaskMoveDto[]> = {};
  const matched = new Set<string>();
  for (const r of p.rows) {
    const keys: string[] = [];
    for (const u of r.units) {
      const source = SOURCE_OF_UNIT[u.unitType];
      if (source) keys.push(taskKey(source, u.unitId));
      else if (u.unitType === "MANUAL_ROW") { const c = p.continuations.get(r.entryId); if (c) keys.push(taskKey(c.type, c.id)); }
    }
    const moves = [...new Set(keys)].filter((k) => (history.get(k)?.length ?? 0) > 0).map(move);
    for (const m of moves) matched.add(m.key);
    if (moves.length) rows[r.entryId] = moves;
  }

  // Tasks whose scheduled date history touches the reviewed date but that have no row there (e.g. the row's link changed when it moved).
  const tasks = [...history.keys()]
    .filter((k) => !matched.has(k))
    .map(move)
    .filter((m) => m.from !== null || m.to !== null)
    .sort((a, b) => (a.dealerName ?? "").localeCompare(b.dealerName ?? "") || a.key.localeCompare(b.key));

  const actions = p.events
    .filter((e) => e.ownerId === p.officerId && e.actionDate === p.date)
    .sort(byTime)
    .map((e): RescheduleActionDto => {
      const k = taskKey(e.sourceType, e.sourceId);
      const d = describe(k);
      return {
        id: e.id, key: k, sourceType: e.sourceType, section: d?.section ?? null,
        dealerName: d?.dealerName ?? null, marketName: d?.marketName ?? null, description: d?.description ?? null,
        previousDate: e.previousDate, newDate: e.newDate, createdAt: e.createdAt, actorName: e.actorName, reason: e.reason,
        count: history.get(k)?.length ?? 0, recordedOnly: !d || d.historyState !== "COMPLETE",
      };
    });
  return { rows, tasks, actions };
}
