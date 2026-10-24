"use client";

import { ReviewTaskHistoryDrawer } from "@/features/daily-work/review-task-history";
import type { TaskHistoryPayload, TaskRow } from "./task-analysis.server";

/** Both task-history entry points share the same complete, read-only timeline and right-side drawer. */
export function TaskHistoryPanel({ row, trigger, onClose, onShowOnCalendar }: {
  row: TaskRow; trigger?: HTMLButtonElement; onClose: () => void; onShowOnCalendar: (history: TaskHistoryPayload) => void;
}) {
  return <ReviewTaskHistoryDrawer selection={{ key: row.key, trigger }} onClose={onClose} onShowOnCalendar={onShowOnCalendar} />;
}
