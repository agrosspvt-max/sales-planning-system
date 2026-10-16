"use client";

import type { ReactNode } from "react";
import { useLabel } from "@/features/labels/label-ui";
import type { TaskStatus } from "@/lib/task-analysis";
import type { TaskRow } from "./task-analysis.server";

/** Every piece of Performance → Tasks wording that depends on a task's data, resolved through Edit Labels (templates, subtypes, statuses, counts). */
export function useTaskText() {
  const L = {
    manual: useLabel("tasks.task.manual"), manualSub: useLabel("tasks.task.manual_sub"), auto: useLabel("tasks.task.auto"), autoSub: useLabel("tasks.task.auto_sub"),
    hManual: useLabel("calendar.heading.manual"), hManualSub: useLabel("calendar.heading.manual_sub"), hAuto: useLabel("calendar.heading.auto"), hAutoSub: useLabel("calendar.heading.auto_sub"),
    SALES: useLabel("daily_work.section.sales"), RECOVERY: useLabel("daily_work.section.recovery"), APPOINTMENT: useLabel("daily_work.section.appointment"), VISITS: useLabel("daily_work.section.visits"), OTHERS: useLabel("daily_work.section.others"),
    REGULAR: useLabel("calendar.subtype.regular"), SCHEME: useLabel("calendar.subtype.scheme"), BILLING_EXCEPTION: useLabel("calendar.subtype.billing_exception"), CN_REQUEST: useLabel("calendar.subtype.cn_request"),
    COMPLETED: useLabel("tasks.status.completed"), ABANDONED: useLabel("tasks.status.abandoned"), PENDING: useLabel("tasks.status.pending"), OVERDUE: useLabel("tasks.status.overdue"), CANCELLED: useLabel("tasks.status.cancelled"),
    timesOne: useLabel("tasks.times_one"), timesMany: useLabel("tasks.times_many"), timesAtLeast: useLabel("tasks.times_at_least"), unknown: useLabel("tasks.moved.unknown"),
    laterOne: useLabel("tasks.moved.later_one"), laterMany: useLabel("tasks.moved.later_many"), earlierOne: useLabel("tasks.moved.earlier_one"), earlierMany: useLabel("tasks.moved.earlier_many"), none: useLabel("tasks.moved.none"),
    nLaterOne: useLabel("tasks.panel.net_later_one"), nLaterMany: useLabel("tasks.panel.net_later_many"), nEarlierOne: useLabel("tasks.panel.net_earlier_one"), nEarlierMany: useLabel("tasks.panel.net_earlier_many"), nSame: useLabel("tasks.panel.net_same"), nUnknown: useLabel("tasks.panel.net_unknown"),
    DEALER_VISITS: useLabel("tasks.detail.dealer_visits"), NEW_PARTY_VISITS: useLabel("tasks.detail.new_party_visits"),
    partialBadge: useLabel("tasks.history.partial_badge"), unavailableBadge: useLabel("tasks.history.unavailable_badge"),
  } as Record<string, string>;
  const section = (s: string) => L[s] ?? s;
  const sub = (t: TaskRow) => (t.subtype ? L[t.subtype] ?? "" : "");
  const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (w, k: string) => vars[k] ?? w);
  return {
    /** "Manual Task - Recovery [Regular]" — the same heading the Calendar uses. */
    heading: (t: TaskRow) => fill(t.type === "MANUAL" ? (sub(t) ? L.hManualSub! : L.hManual!) : (sub(t) ? L.hAutoSub! : L.hAuto!), { section: section(t.section), subtype: sub(t) }),
    /** "Auto · Recovery [Billing Exception]" — the table's compact form. */
    short: (t: TaskRow) => fill(t.type === "MANUAL" ? (sub(t) ? L.manualSub! : L.manual!) : (sub(t) ? L.autoSub! : L.auto!), { section: section(t.section), subtype: sub(t) }),
    detail: (t: TaskRow, dealer: (id: string, name: string) => ReactNode): ReactNode => (t.category ? fill(L[t.category]!, { n: String(t.target ?? 0) }) : t.dealerId && t.dealerName ? dealer(t.dealerId, t.dealerName) : t.dealerName ?? t.description ?? "—"),
    status: (s: TaskStatus) => L[s]!,
    statusVariant: (s: TaskStatus): "success" | "warning" | "destructive" | "muted" | "secondary" => (s === "COMPLETED" ? "success" : s === "ABANDONED" ? "destructive" : s === "OVERDUE" ? "warning" : s === "CANCELLED" ? "muted" : "secondary"),
    /** Reschedule count: exact for a complete history, "n+" for a partial one, unknown (never zero) when unavailable. */
    moves: (t: TaskRow) => (t.historyState === "UNAVAILABLE" ? L.unknown! : t.historyState === "PARTIAL" ? fill(L.timesAtLeast!, { n: String(t.moves) }) : fill(t.moves === 1 ? L.timesOne! : L.timesMany!, { n: String(t.moves) })),
    daysMoved: (d: number | null) => (d === null ? L.unknown! : d === 0 ? L.none! : d > 0 ? fill(d === 1 ? L.laterOne! : L.laterMany!, { n: String(d) }) : fill(d === -1 ? L.earlierOne! : L.earlierMany!, { n: String(-d) })),
    net: (d: number | null) => (d === null ? L.nUnknown! : d === 0 ? L.nSame! : d > 0 ? fill(d === 1 ? L.nLaterOne! : L.nLaterMany!, { n: String(d) }) : fill(d === -1 ? L.nEarlierOne! : L.nEarlierMany!, { n: String(-d) })),
    partialBadge: L.partialBadge!, unavailableBadge: L.unavailableBadge!,
  };
}
