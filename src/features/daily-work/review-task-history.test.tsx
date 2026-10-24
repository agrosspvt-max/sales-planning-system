import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import type { TaskHistoryPayload } from "@/features/tasks/task-analysis.server";

const task = {
  key: "CALENDAR_ENTRY:task:1", sourceType: "CALENDAR_ENTRY", taskId: "task:1", ownerId: "so1", ownerName: "Pankaj Verma",
  territory: "Main", state: "CG", type: "MANUAL", section: "RECOVERY", subtype: "REGULAR", dealerId: "d1", dealerName: "Alpha Traders",
  marketName: null, description: null, amount: 1000, originalDate: "2026-10-19", originalVerified: true, currentDate: "2026-10-28",
  moves: 7, daysMoved: 9, status: "PENDING", historyState: "COMPLETE", periodMoves: null, category: null, target: null, abandonReasonCode: null, abandonReason: null,
} as TaskHistoryPayload["task"];
const events = Array.from({ length: 7 }, (_, i) => ({
  id: `e${i}`, previousDate: `2026-10-${19 + i}`, newDate: `2026-10-${20 + i}`,
  actorName: i === 2 ? "System Administrator" : "Pankaj Verma", actorRole: "SALES_OFFICER", reason: i === 2 ? "Dealer requested time" : null,
  createdAt: `2026-10-${19 + i}T04:30:00.000Z`,
}));
const history: TaskHistoryPayload = {
  task, events: [...events].reverse(), outcomes: [{ outcome: "RESCHEDULED", workDate: "2026-10-19", nextDate: "2026-10-20", actualAmount: null, reason: null, reasonCode: null, committedAt: events[0]!.createdAt, committedByName: "Pankaj Verma" }],
  origin: { createdAt: "2026-10-18T18:45:00.000Z", actorName: "Pankaj Verma" }, trail: [], chainOk: true, distinctDates: [],
};
let data: TaskHistoryPayload | undefined = history;
let error: Error | null = null;
let isLoading = false;
let query: { queryKey: unknown[]; queryFn: () => Promise<unknown> };
const requests: string[] = [];
const custom: Record<string, string> = {};
const div = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
const load = testLoader({
  "@/features/labels/label-ui": { useLabel: (key: keyof typeof DEFAULT_LABELS) => custom[key] ?? DEFAULT_LABELS[key] },
  "@tanstack/react-query": { useQuery: (q: typeof query) => { query = q; return { data, error, isLoading, refetch: () => {} }; } },
  "@/lib/api-client": { api: { get: async (url: string) => { requests.push(url); return data; } } },
  "@/components/ui/dialog": { Dialog: div, DialogContent: div, DialogDescription: div, DialogHeader: div, DialogTitle: div },
});
const { ReviewTaskTimeline, ReviewTaskHistoryDrawer, reviewTaskHistoryUrl } = load<typeof import("./review-task-history")>("src/features/daily-work/review-task-history.tsx");
const { MoveTag } = load<typeof import("./team-performance-page")>("src/features/daily-work/team-performance-page.tsx");

async function main() {
  let html = renderToStaticMarkup(<ReviewTaskTimeline history={history} />);
  assert.equal((html.match(/data-testid="review-task-move"/g) ?? []).length, 7, "all moves, including moves after the reviewed day; no preview limit or duplicate reschedule outcome");
  assert.ok(html.includes("Task initiated") && html.includes("19/10/2026, 12:15 am"), "actual initiation timestamp in IST");
  assert.ok(html.includes("Original scheduled date: 19/10/2026") && html.includes("28/10/2026"));
  assert.ok(html.indexOf("19/10/2026 → 20/10/2026") < html.indexOf("25/10/2026 → 26/10/2026"), "chronological even if input is not sorted; dates are not sorted by due date");
  assert.ok(html.includes("Dealer requested time") && html.includes("By: System Administrator") && !html.includes("SALES_OFFICER"), "saved reason and name only");
  assert.ok(html.includes("border-l-2 border-border") && html.includes("rounded-full border-2") && html.includes("All times in IST"), "CN timeline styling");
  const partial = { ...history, origin: null, chainOk: false, task: { ...task, originalVerified: false, historyState: "PARTIAL" as const } };
  html = renderToStaticMarkup(<ReviewTaskTimeline history={partial} />);
  assert.ok(html.includes("Partial history:") && html.includes("Initiation time was not recorded.") && html.includes("unbroken chain"), "missing history is disclosed, not invented");
  const abandoned = { ...history, task: { ...task, status: "ABANDONED" as const }, outcomes: [{ outcome: "ABANDONED" as const, workDate: "2026-10-27", nextDate: null, actualAmount: null, reason: "Customer closed", reasonCode: "OTHER", committedAt: "2026-10-27T12:00:00.000Z", committedByName: "Pankaj Verma" }] };
  html = renderToStaticMarkup(<ReviewTaskTimeline history={abandoned} />);
  assert.ok(html.includes("text-destructive") && html.includes("Customer closed") && html.indexOf("25/10/2026 → 26/10/2026") < html.indexOf("Work date: 27/10/2026"));
  custom["daily_work.review.history.rescheduled"] = "Moved task";
  assert.ok(renderToStaticMarkup(<ReviewTaskTimeline history={history} />).includes("Moved task"), "wording remains editable through Labels");

  // Exercise the real click handler: choose the exact task (not another task for the same dealer).
  const trigger = { isConnected: true, focus: () => { focused = true; } } as HTMLButtonElement;
  let selected = "", focused = false;
  const move = { key: task.key, sourceType: "CALENDAR_ENTRY", from: "2026-10-19", to: "2026-10-28", count: 7, recordedOnly: false, dealerName: "Alpha", marketName: null, description: null, section: "RECOVERY" };
  const tag = MoveTag({ move, onOpenHistory: (key, element) => { selected = key; assert.equal(element, trigger); } });
  const button = React.Children.toArray(tag.props.children).find((child) => React.isValidElement(child) && child.type === "button") as React.ReactElement<{ onClick: (e: { currentTarget: HTMLButtonElement }) => void; "aria-haspopup": string }>;
  assert.equal(button.props["aria-haspopup"], "dialog");
  button.props.onClick({ currentTarget: trigger });
  assert.equal(selected, task.key);
  assert.equal(reviewTaskHistoryUrl(selected), "/api/tasks/history/CALENDAR_ENTRY/task%3A1");
  let closed = 0;
  const drawer = ReviewTaskHistoryDrawer({ selection: { key: selected, trigger }, onClose: () => closed++ });
  assert.deepEqual(Array.from(query!.queryKey), ["review-task-history", task.key]);
  await query!.queryFn();
  assert.equal(requests.at(-1), "/api/tasks/history/CALENDAR_ENTRY/task%3A1", "no date, range, or dealer filter sent");
  const content = drawer.props.children;
  assert.ok(content.props.className.includes("right-0") && content.props.className.includes("top-0") && content.props.className.includes("h-dvh"));
  content.props.onCloseAutoFocus({ preventDefault: () => {} });
  assert.equal(focused, true, "closing restores focus to the tag");
  drawer.props.onOpenChange(false);
  assert.equal(closed, 1, "close callback belongs only to the sidebar");
  let calendarHistory: TaskHistoryPayload | undefined;
  const withCalendar = ReviewTaskHistoryDrawer({ selection: { key: task.key }, onClose: () => {}, onShowOnCalendar: (value) => { calendarHistory = value; } });
  const fragment = React.Children.toArray(withCalendar.props.children.props.children).find((child) => React.isValidElement(child) && child.type === React.Fragment) as React.ReactElement<{ children: React.ReactNode }>;
  const calendarButton = React.Children.toArray(fragment.props.children).find((child) => React.isValidElement(child) && typeof (child.props as { onClick?: unknown }).onClick === "function") as React.ReactElement<{ onClick: () => void }>;
  calendarButton.props.onClick();
  assert.equal(calendarHistory, history, "Tasks keeps Show on calendar and passes the complete history, including its full date trail");
  assert.ok(!renderToStaticMarkup(<ReviewTaskHistoryDrawer selection={{ key: task.key }} onClose={() => {}} />).includes("Show on calendar"), "Performance's review drawer gains no unrelated action");
  error = new Error("Unavailable"); data = undefined;
  html = renderToStaticMarkup(<ReviewTaskHistoryDrawer selection={{ key: task.key }} onClose={() => {}} />);
  assert.ok(html.includes('role="alert"') && html.includes("Try again"), "fetch failures can be retried without losing the review");
  error = null; isLoading = true;
  assert.ok(renderToStaticMarkup(<ReviewTaskHistoryDrawer selection={{ key: task.key }} onClose={() => {}} />).includes('aria-label="Loading tasks…"'));
  console.log("review-task-history.test.tsx — all assertions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
