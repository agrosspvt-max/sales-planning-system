/**
 * Performance → Tasks — the REAL components rendered with mocked data (table, summary, calendar, history panel, labels). No DB / browser.
 *   npx tsx src/features/tasks/task-analysis-ui.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, labelMeta, type LabelKey } from "@/features/labels/labels";
import { defaultTaskFilters, summarizeTasks } from "@/lib/task-analysis";
import { testLoader } from "@/features/dealer-tags/test-loader";

const UNSET = Symbol("unset");
let queue: unknown[] = [];
let overrides: Record<string, string> = {};
let analysis: unknown, calendar: unknown, history: unknown;
const text = (k: LabelKey) => overrides[k] ?? DEFAULT_LABELS[k];
const row = (over: Record<string, unknown>) => ({ key: "BILLING_EXCEPTION:t1", sourceType: "BILLING_EXCEPTION", taskId: "t1", ownerId: "so1", ownerName: "Suresh Verma", territory: "Raigarh", state: "CG", type: "AUTO", section: "RECOVERY", subtype: "BILLING_EXCEPTION",
  dealerId: "d5", dealerName: "test_dealer5", marketName: null, description: null, amount: 12000, originalDate: "2026-10-14", originalVerified: true, currentDate: "2026-10-20", moves: 3, daysMoved: 6, status: "PENDING", historyState: "COMPLETE", periodMoves: null, ...over });
const summaryOf = (rows: ReturnType<typeof row>[]) => summarizeTasks(rows as never);
const payload = (rows: ReturnType<typeof row>[], over: Record<string, unknown> = {}) => ({ filters: {}, summary: summaryOf(rows), rows, page: 1, pageSize: 25, totalRows: rows.length, totalPages: 1, focusCount: null, officers: [{ id: "so1", name: "Suresh Verma" }], states: [{ id: "g1", name: "CG" }], ...over });
const ev = (i: number, prev: string, next: string, actor: string) => ({ id: `e${i}`, previousDate: prev, newDate: next, actorName: actor, actorRole: "SALES_OFFICER", reason: i === 2 ? "Dealer asked for time" : null, createdAt: `2026-10-0${i + 1}T09:30:00.000Z` });

const useState = (initial: unknown) => { const v = queue.length ? queue.shift() : UNSET; return [v === UNSET || v === undefined ? initial : v, () => {}]; };
const load = testLoader({
  react: { ...React, useState, useEffect: () => {} },
  "@tanstack/react-query": { useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[1] === "analysis" ? analysis : queryKey[1] === "calendar" ? calendar : history, isLoading: false, error: null }) },
  "@/lib/api-client": { api: { get: async () => ({}) } },
  "@/features/labels/label-ui": { useLabel: (k: LabelKey) => text(k), Th: ({ labelKey }: { labelKey: LabelKey }) => <th>{text(labelKey)}</th> },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/components/ui/date-input-dmy": { DateInputDMY: ({ value, "aria-label": a }: { value: string; "aria-label"?: string }) => <input readOnly aria-label={a} value={value} /> },
});
const { TaskAnalysisView } = load<typeof import("./task-analysis-view")>("src/features/tasks/task-analysis-view.tsx");
const { RescheduleCalendar } = load<typeof import("./reschedule-calendar")>("src/features/tasks/reschedule-calendar.tsx");
const { TaskHistoryPanel } = load<typeof import("./task-history-panel")>("src/features/tasks/task-history-panel.tsx");
const filters = { ...defaultTaskFilters("2026-10-15"), from: "2026-10-01", to: "2026-10-31" };
const view = (role: Role = Role.SUPER_ADMIN, f = filters, seeds: unknown[] = []) => { queue = [...seeds]; return renderToStaticMarkup(<TaskAnalysisView role={role} filters={f} onFilters={() => {}} />); };
const norm = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
let n = 0; const ok = (m: string) => { n++; console.log(`  ok - ${m}`); };

async function main() {
  // 1. Table row, summary, switches and the date basis.
  analysis = payload([row({}), row({ key: "CALENDAR_ENTRY:t2", sourceType: "CALENDAR_ENTRY", taskId: "t2", type: "MANUAL", subtype: "SCHEME", section: "RECOVERY", dealerName: "XYZ Stores", amount: 8000, moves: 0, daysMoved: 0, originalDate: "2026-10-18", currentDate: "2026-10-18", status: "COMPLETED" })]);
  let html = view();
  const t = norm(html);
  assert.ok(t.includes("Suresh Verma [Raigarh] CG") && t.includes("Auto · Recovery [Billing Exception]") && t.includes("test_dealer5") && t.includes("₹12,000") && t.includes("14/10/2026") && t.includes("20/10/2026") && t.includes("3 times") && t.includes("6 days later") && t.includes("Pending"), "the example row: employee, Auto · Recovery [Billing Exception], dealer, amount, original, current, count, days moved, status");
  assert.ok(t.includes("Manual · Recovery [Scheme]") && t.includes("0 times") && t.includes("Not moved") && t.includes("Completed"), "a manual, never-moved, completed task");
  assert.ok(/aria-pressed="true"[^>]*>Auto</.test(html) && /aria-pressed="false"[^>]*>All</.test(html) && /aria-pressed="false"[^>]*>Manual</.test(html), "All | Auto | Manual with Auto selected");
  for (const [label, value] of [["Total Tasks", "2"], ["Completed", "1"], ["Pending", "1"], ["Overdue", "0"], ["Tasks Rescheduled", "1"], ["Total Reschedules", "3"], ["Average Reschedules per Task", "1.5"]]) assert.ok(new RegExp(`${label}\\s*[^]*?${value}`).test(t), `${label} = ${value}`);
  assert.ok(html.includes('data-testid="basis-note"') && t.includes("Original Due Date") && t.includes("Original Due Date, 01/10/2026 to 31/10/2026"), "the date meaning is stated: Original Due Date");
  assert.ok(t.includes("Original Due Date") && t.includes("Current Date") && t.includes("Days Moved") && t.includes("Reschedules"), "separate original and current date columns");
  assert.ok(html.includes("Show Reschedule Calendar") && !html.includes('data-testid="reschedule-calendar"'), "the calendar is collapsed until opened");
  assert.ok(html.includes("Rescheduled On") && html.includes("Original Due Date"), "both date meanings are offered, never mixed");
  const so = view(Role.SALES_OFFICER); assert.ok(!so.includes('aria-label="Employee"') && !so.includes('aria-label="State"'), "an SO has no employee / State filter");
  assert.ok(view(Role.SUPER_ADMIN).includes('aria-label="State"') && view(Role.REGIONAL_MANAGER).includes('aria-label="Employee"') && !view(Role.REGIONAL_MANAGER).includes('aria-label="State"'));
  html = view(Role.SUPER_ADMIN, { ...filters, basis: "RESCHEDULED_ON", from: "2026-10-17", to: "2026-10-17" });
  assert.ok(norm(html).includes("Rescheduled On, 17/10/2026") === false && norm(html).includes("date was changed between 17/10/2026 and 17/10/2026"), "the Rescheduled On basis is visible and described as the day the change was made");
  ok("table, summary, type switch, basis labelling and role-based filters");

  // 2. Partial / unavailable history and the empty state.
  analysis = payload([row({ key: "A", taskId: "a", moves: 0, daysMoved: null, historyState: "UNAVAILABLE", originalVerified: false }), row({ key: "B", taskId: "b", moves: 2, historyState: "PARTIAL", originalVerified: false, daysMoved: null })]);
  const legacy = norm(view());
  assert.ok(legacy.includes("History unavailable") && legacy.includes("Partial history") && legacy.includes("Unknown") && legacy.includes("2+ times") && !/ 0 times /.test(legacy), "unknown is never shown as a verified zero; partial is '2+'");
  assert.ok(legacy.includes("Original date not verified") && legacy.includes("2 of these 2 tasks have partial or unavailable history"), "the effect on the totals is explained");
  analysis = payload([]);
  assert.ok(norm(view()).includes("No tasks match these filters.") && norm(view()).includes("Average Reschedules per Task 0"), "empty population");
  analysis = payload([row({})], { focusCount: 4 });
  assert.ok(norm(view(Role.SUPER_ADMIN, { ...filters, focusDate: "2026-10-16" })).includes("Showing rescheduled tasks involving 16/10/2026 — 4 tasks") && view(Role.SUPER_ADMIN, { ...filters, focusDate: "2026-10-16" }).includes("Clear date focus"), "selected date focus: count and a way to remove it");
  ok("legacy history, empty population and date focus");

  // 3. The reschedule calendar: one scale, counts in the cells, legend; selected-task trail with step markers.
  analysis = payload([row({})]);
  calendar = { month: "2026-10", days: { "2026-10-14": 1, "2026-10-16": 2, "2026-10-20": 4 }, max: 4, periodTasks: 7, monthTasks: 5 };
  const cal = (selected: unknown = null, focus: string | null = null) => renderToStaticMarkup(<RescheduleCalendar query="x" initialMonth="2026-10" focusDate={focus} onFocusDate={() => {}} selected={selected as never} onClearSelection={() => {}} />);
  queue = []; html = cal();
  assert.ok(/data-date="2026-10-20" data-level="5" data-count="4"/.test(html) && /data-date="2026-10-14" data-level="2" data-count="1"/.test(html) && /data-date="2026-10-17" data-level="0" data-count="0"/.test(html), "darker = more tasks; the count is on the cell too");
  assert.ok(html.includes('data-testid="cell-count">4<') && !/data-date="2026-10-17"[^>]*>[^]*?data-testid="cell-count"[^]*?<\/button>/.test(html.split('data-date="2026-10-18"')[0]!.split('data-date="2026-10-17"')[1] ?? ""), "numbers inside dates with activity only");
  assert.ok(html.includes('data-testid="calendar-legend"') && html.includes("Darker dates involve more rescheduled tasks") && html.includes("not the days the changes were made"), "legend and the scheduled-date meaning");
  assert.ok(norm(html).includes("Filtered period: 7 rescheduled tasks") && norm(html).includes("touching this month: 5") && !html.includes('data-testid="calendar-selected-count"'), "period totals are distinct from the selected date's count");
  html = cal(null, "2026-10-16"); assert.ok(html.includes('data-testid="calendar-selected-count"') && norm(html).includes("Selected date 16/10/2026: 2 tasks") && /data-date="2026-10-16"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-date="2026-10-16"/.test(html), "the selected date and its matching count");
  html = cal({ key: "k", label: "Billing · Dealer", trail: ["2026-10-14", "2026-10-16", "2026-10-18", "2026-10-16"] });
  assert.ok(html.includes('data-testid="selected-task"') && html.includes("Clear task selection") && html.includes('data-testid="date-trail"'), "selected-task mode with a way back");
  assert.ok(/data-date="2026-10-16"[^>]*>[^]*?data-testid="cell-steps"[^]*?>2<[^]*?>4</.test(html), "a revisited date carries both step numbers (2 and 4)");
  assert.ok(!/data-date="2026-10-20"[^>]*data-level="5"[^>]*data-count="4"[^>]*class="[^"]*bg-primary/.test(html) && /data-date="2026-10-20"[^>]*class="[^"]*opacity-30/.test(html), "unrelated activity is faded and not shaded");
  const trail = norm(html.slice(html.indexOf('data-testid="date-trail"')));
  assert.ok(/1 14\/10\/2026 \( ?Original ?\)/.test(trail) && trail.includes("4 16/10/2026") && /\( ?Current ?\)/.test(trail), "ordered trail with original / current markers");
  ok("calendar: one intensity scale, counts, legend, period vs selected totals, selected-task trail and fading");

  // 4. History panel: identity, dates, totals, net movement, timeline; preview with explicit omission; partial / unavailable.
  const six = [ev(0, "2026-10-14", "2026-10-15", "Suresh Verma"), ev(1, "2026-10-15", "2026-10-16", "Suresh Verma"), ev(2, "2026-10-16", "2026-10-17", "Admin"), ev(3, "2026-10-17", "2026-10-18", "Suresh Verma"), ev(4, "2026-10-18", "2026-10-19", "Suresh Verma"), ev(5, "2026-10-19", "2026-10-20", "Admin")];
  history = { task: row({ moves: 6 }), events: six, trail: ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"], chainOk: true, distinctDates: [] };
  const panel = (r: unknown, seeds: unknown[] = []) => { queue = seeds; return renderToStaticMarkup(<TaskHistoryPanel row={r as never} onClose={() => {}} onShowOnCalendar={() => {}} />); };
  html = panel(row({ moves: 6 }));
  const p = norm(html);
  assert.ok(p.includes("Auto Task - Recovery [Billing Exception]") && p.includes("Suresh Verma [Raigarh] CG") && p.includes("test_dealer5") && p.includes("Read-only history"), "task identity and read-only");
  assert.ok(p.includes("Originally due 14/10/2026") && p.includes("20/10/2026 — Current date") && p.includes("6 times") && p.includes("6 days later than originally planned"), "original, current, total, net movement");
  assert.ok(html.includes('data-testid="history-omitted"') && p.includes("2 moves not shown") && (html.match(/data-testid="history-step"/g) ?? []).length === 4, "a long history shows 4 of 6 steps and says 2 are not shown");
  assert.ok(p.includes("View full history") && p.includes("Moved by Suresh Verma") && p.includes("Moved by Admin"), "who moved it");
  html = panel(row({ moves: 6 }), [true]);
  assert.ok(!html.includes('data-testid="history-omitted"') && (html.match(/data-testid="history-step"/g) ?? []).length === 6 && norm(html).includes("Dealer asked for time") && norm(html).includes("Show fewer steps"), "the full history shows every step, with the reason");
  history = { task: row({ moves: 0, historyState: "UNAVAILABLE", originalVerified: false, daysMoved: null }), events: [], trail: [], chainOk: true, distinctDates: [] };
  html = panel(row({ moves: 0, historyState: "UNAVAILABLE", originalVerified: false, daysMoved: null }));
  assert.ok(html.includes('data-testid="history-unavailable"') && norm(html).includes("Unknown — the original date is not verified") && !html.includes('data-testid="history-timeline"') && !html.includes("Show on calendar"), "unavailable: stated plainly, no invented timeline");
  history = { task: row({ moves: 0, daysMoved: 0, currentDate: "2026-10-14" }), events: [], trail: [], chainOk: true, distinctDates: [] };
  assert.ok(panel(row({ moves: 0, daysMoved: 0, currentDate: "2026-10-14" })).includes('data-testid="history-empty"'), "a verified never-moved task says so");
  ok("history panel: identity, dates, totals, net movement, timeline, preview omission, full view, unavailable");

  // 5. Labels / wiring (source level).
  overrides = { "tasks.summary.total": "All tasks", "tasks.col.original": "Planned for", "tasks.type.auto": "Automatic", "tasks.calendar.show": "Open calendar", "tasks.empty": "Nothing here" };
  analysis = payload([row({})]);
  const custom = view();
  assert.ok(norm(custom).includes("All tasks") && norm(custom).includes("Planned for") && /aria-pressed="true"[^>]*>Automatic</.test(custom) && custom.includes("Open calendar"), "customised labels are what is displayed");
  overrides = {};
  const keys = (Object.keys(DEFAULT_LABELS) as LabelKey[]).filter((k) => k.startsWith("tasks."));
  for (const k of keys) assert.equal(labelMeta(k).module, "Performance Tasks", k);
  const src = ["task-analysis-view.tsx", "reschedule-calendar.tsx", "task-history-panel.tsx", "task-text.tsx"].map((f) => readFileSync(`src/features/tasks/${f}`, "utf8")).join("\n") + readFileSync("src/features/daily-work/performance-page.tsx", "utf8");
  const used = new Set([...src.matchAll(/["'](tasks\.[a-z_.]+)["']/g)].map((m) => m[1]!));
  for (const u of used) assert.ok(u in DEFAULT_LABELS, `${u} is registered`);
  for (const k of keys) assert.ok(used.has(k) || readFileSync("src/features/tasks/task-analysis.server.ts", "utf8").includes(k), `${k} is used`);
  ok(`${keys.length} labels registered under Performance Tasks, all used, customisation changes the display`);
  // 6. Every existing reschedule path appends its history row INSIDE the transaction that moves the date; analysis endpoints are read-only and scope-checked.
  {
    const billing = readFileSync("src/features/daily-work/billing-task.server.ts", "utf8"), cn = readFileSync("src/features/cn-requests/service.server.ts", "utf8");
    assert.ok(billing.indexOf("recordTaskReschedule(tx, ctx") > billing.indexOf("billingExceptionTask.updateMany") && billing.indexOf("recordTaskReschedule(tx, ctx") < billing.indexOf("return { taskId: id, taskDate };", billing.indexOf("recordTaskReschedule(tx, ctx")), "Billing: the history row is written right after the date update, in the same transaction");
    assert.ok(cn.includes('sourceType: "CN_PAYMENT"') && cn.includes('sourceType: "CN_LEGACY"') && cn.includes("if (previousTaskDate) await recordTaskReschedule") && cn.includes("if (existing.taskDate) await recordTaskReschedule"), "CN (event + legacy): only an already-dated task being moved records history (first-time scheduling does not)");
    for (const f of ["analysis/route.ts", "reschedule-calendar/route.ts", "history/[sourceType]/[id]/route.ts"]) { const r = readFileSync(`src/app/api/tasks/${f}`, "utf8"); assert.ok(r.includes("requireAuth()") && r.includes("taskAnalysisScope") && !/\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b/.test(r), `${f}: authenticated, scoped, GET only`); }
    const srv = readFileSync("src/features/tasks/task-analysis.server.ts", "utf8");
    assert.ok(!/\.(create|update|updateMany|delete|upsert)\(|INSERT|UPDATE "|DELETE FROM/.test(srv.replace(/\/\*[^]*?\*\//g, "")), "the analysis module never writes (no task creation, completion, rescheduling or notification)");
  }
  ok("reschedule paths record history in-transaction; the analysis endpoints are read-only and scope-checked");
  console.log(`task-analysis-ui.test.tsx — ${n} groups passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
