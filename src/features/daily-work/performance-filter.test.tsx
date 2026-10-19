/** Performance page: the Sales Officer COLUMN HEADER is the filter, cascades with State, and includes RMs. No DB / browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

let hooks: unknown[] = [];
let cursor = 0;
const urls: string[] = [];
const headers: { label: string; ariaLabel: string; selected: string[]; options: { value: string; label: string }[]; onChange: (next: string[]) => void }[] = [];
const selects: { value?: string; onChange?: (e: { target: { value: string } }) => void; options: { value: string; label: string }[] }[] = [];

// Server payload per query string: what the real API returns for the Admin (options follow State; RMs included).
const PEOPLE = [
  { id: "rm2", name: "RM Two", state: "g2" }, { id: "so1", name: "Rahul", state: "g1" }, { id: "so3", name: "Ravi", state: "g2" },
];
let patch: Record<string, Record<string, unknown>> = {};
const payloadFor = (url: string) => {
  const q = new URLSearchParams(url.split("?")[1]);
  const state = q.get("groupId"); const person = q.get("officerId");
  const pool = PEOPLE.filter((p) => !state || p.state === state);
  const shown = pool.filter((p) => !person || p.id === person);
  return {
    role: Role.SUPER_ADMIN, from: "2026-09-28", to: "2026-09-28",
    states: [{ id: "g1", name: "MP" }, { id: "g2", name: "UP" }],
    officers: pool.map((p) => ({ id: p.id, name: p.name })),
    rows: shown.map((p) => ({ ...(patch[p.id] ?? {}), officerId: p.id, officerName: p.name, groupId: p.state, stateName: p.state, date: "2026-09-28", planSubmittedAt: "2026-09-28T09:00:00.000Z", reportSubmittedAt: null, reportMissed: p.id === "so1", taskActivity: p.id === "so1" ? { tasks: 9, completed: 4, reschedules: 3, abandoned: 0, sections: { SALES: 3, RECOVERY: 2, APPOINTMENT: 2, VISITS: 2 } } : p.id === "so3" ? { tasks: 0, completed: 0, reschedules: 0, abandoned: 0, sections: {} } : null, selfRating: null, rmRating: null, submitted: true, ...(patch[p.id] ?? {}) })),
    summary: { salesOfficers: shown.length, employeeDays: shown.length, submittedPlans: shown.length, submittedReports: 0, averageSelfRating: null, averageRmRating: null, sections: Object.fromEntries(["sales", "recovery", "schemeConversion", "appointment", "visits"].map((k) => [k, { planned: 0, actual: 0 }])) },
  };
};

const overrides: Record<string, unknown> = {
  react: {
    ...React,
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks[i], (update: unknown) => { hooks[i] = typeof update === "function" ? (update as (v: unknown) => unknown)(hooks[i]) : update; }];
    },
  },
  "@/features/labels/label-ui": { useLabel: (key: LabelKey) => DEFAULT_LABELS[key], Th: ({ labelKey }: { labelKey: LabelKey }) => <th>{DEFAULT_LABELS[labelKey]}</th> },
  "@/features/tasks/task-analysis-view": { TaskAnalysisView: () => null }, // own suite: tasks/task-analysis-ui.test.tsx
  "@/lib/api-client": { api: { get: async (url: string) => { urls.push(url); return payloadFor(url); } } },
  "@tanstack/react-query": {
    useQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => {
      void queryFn();
      return { isLoading: false, isFetching: false, data: payloadFor(urls[urls.length - 1]!) };
    },
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    useMutation: () => ({ isPending: false, mutate: () => {} }),
  },
  "@/components/ui/column-filter-header": {
    ColumnFilterHeader: (props: (typeof headers)[number]) => { headers.push(props); return <th>{props.label}</th>; },
  },
  "@/components/ui/select": {
    NativeSelect: (props: (typeof selects)[number]) => { selects.push(props); return <select />; },
  },
  "@/components/layout/page-header": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> },
  "./team-performance-page": { DailyWorkReviewDialog: () => null },
};
const load = testLoader(overrides);
const { PerformancePage } = load("src/features/daily-work/performance-page.tsx") as { PerformancePage: React.ComponentType<{ role: Role }> };

const render = (role: Role) => { cursor = 0; headers.length = 0; selects.length = 0; return renderToStaticMarkup(<PerformancePage role={role} />); };
const lastUrl = () => urls[urls.length - 1]!;
const lastHeader = () => headers[headers.length - 1]!;
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// 0) Performance | Tasks switches above the filters (Performance selected by default) and the compact Task Activity column.
{
  const h = render(Role.SUPER_ADMIN);
  assert.ok(/data-testid="mode-switch"[^>]*>\s*<button[^>]*aria-pressed="true"[^>]*>Performance<\/button>\s*<button[^>]*aria-pressed="false"[^>]*>Tasks<\/button>/.test(h), "Performance | Tasks, Performance selected");
  assert.ok(h.indexOf('data-testid="mode-switch"') < h.indexOf("Date From"), "the switches sit above the date filters");
  const act = [...h.matchAll(/data-testid="task-activity"[^>]*>([^]*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  assert.deepEqual(act, ["Unavailable", "9 tasks · 4 completed Sales 3 · Recovery 2 · Dealer Appointment 2 · Visits 2 ↻ 3 reschedules", "No tasks ↻ 0 reschedules"], "Task Activity: tasks · completed, ↻ reschedules; zero is stated, an unavailable cell is a dash");
  assert.ok(h.includes("Task Activity"), "its own column heading");
  assert.ok(h.includes('data-testid="activity-unavailable"') && !/>\s*No tasks[^<]*<\/div>\s*<\/td>\s*<td[^>]*>\s*<\/td>/.test(h), "task data that could not be loaded is Unavailable — never presented as 'No tasks'");
  assert.ok(/title="Open the tasks originally scheduled for this date\. By section: Sales 3 · Recovery 2 · Dealer Appointment 2 · Visits 2\./.test(h), "the count's tooltip explains the total by section");
  // Attendance is retired from the page: no summary figure, no column, no editing control or badge, no request.
  assert.ok(!/attendance|Present<|Absent<|Holiday<|Leave<|\d+ \/ \d+/i.test(h), "no Attendance anywhere on the Performance view");
  const headCells = [...h.matchAll(/<th[^>]*>([^]*?)<\/th>/g)].length;
  const bodyCells = [...h.matchAll(/<tr[^>]*>((?:(?!<\/tr>)[^])*?<td[^]*?)<\/tr>/g)][0]![1]!.match(/<td/g)!.length;
  assert.equal(bodyCells, headCells, "the table body has exactly one cell per header after the column was removed");
}

// 0b) Late-report presentation: Missed in BOTH columns for a skipped date; "Pending Approval" / "Reopened" under Missed; the real submission time with a muted Late label.
{
  patch = {
    so1: { planSubmittedAt: null, planMissed: true, reportMissed: true, reportSubmittedAt: null, lateReport: { open: null, late: false } },
    so3: { reportMissed: true, reportSubmittedAt: null, lateReport: { open: "PENDING", late: false } },
    rm2: { reportMissed: false, reportSubmittedAt: "2026-09-30T09:00:00.000Z", lateReport: { open: null, late: true } },
  };
  hooks.length = 0;
  const h = render(Role.SUPER_ADMIN);
  const rowsHtml = [...h.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!).filter((x) => x.includes("<td"));
  const rowOf = (name: string) => rowsHtml.find((x) => x.includes(name))!;
  assert.equal((rowOf("Rahul").match(/data-testid="plan-missed"|Missed/g) ?? []).length >= 2, true, "a skipped date shows Missed under Plan Submission AND Report Submission");
  assert.ok(rowOf("Ravi").includes("Pending Approval") && rowOf("Ravi").includes("Missed"), "an open request is shown under Missed without inventing a submission time");
  assert.ok(rowOf("RM Two").includes("30/09/2026") && rowOf("RM Two").includes("Late") && !rowOf("RM Two").includes("Missed"), "approved late submission: real submission date/time, a muted Late label, no Missed");
  patch = {};
  hooks.length = 0;
}

// 1) Loads without a person filter; the header IS the filter, still labelled "Sales Officer".
let html = render(Role.SUPER_ADMIN);
assert.ok(!lastUrl().includes("officerId"), "no Sales Officer filter by default");
assert.equal(lastHeader().label, "Sales Officer");
assert.deepEqual(plain(lastHeader().selected), []);
assert.deepEqual(lastHeader().options.map((o) => o.label).sort(), ["RM Two", "Rahul", "Ravi"], "options include Regional Managers");

assert.ok(html.includes("Missed"), "a day whose report deadline passed shows Missed in Report Submission");
const missedBadges = html.match(/Missed/g)!.length;
assert.equal(missedBadges, 1, "only the Missed row shows it; the others keep the pending dash");

// 2) Selecting one person filters rows and the summary (server returns the filtered set).
lastHeader().onChange(["so3"]);
html = render(Role.SUPER_ADMIN);
assert.ok(lastUrl().includes("officerId=so3") && lastUrl().includes("from=") && lastUrl().includes("to="), "person + date range sent together");
assert.deepEqual(plain(lastHeader().selected), ["so3"]);
assert.ok(html.includes("Ravi") && !html.includes("Rahul") && !html.includes("RM Two"), "table shows only the selected person");
assert.ok(/Sales Officers<\/div><div[^>]*>1</.test(html), "summary cards follow the selection");

// 3) Single selection: ticking another person replaces; ticking the selected one clears.
lastHeader().onChange(["so3", "rm2"]);
render(Role.SUPER_ADMIN);
assert.deepEqual(plain(lastHeader().selected), ["rm2"], "an RM is selectable and replaces the previous person");
assert.ok(lastUrl().includes("officerId=rm2"));
lastHeader().onChange([]);
render(Role.SUPER_ADMIN);
assert.deepEqual(plain(lastHeader().selected), []);
assert.ok(!lastUrl().includes("officerId"), "clearing restores the full scope");

// 4) State + person: State narrows the options; changing State clears a person who no longer belongs.
lastHeader().onChange(["so1"]);
render(Role.SUPER_ADMIN);
const stateSelect = selects.find((s) => s.options.some((o) => o.label === "UP"))!;
stateSelect.onChange!({ target: { value: "g2" } });
render(Role.SUPER_ADMIN);
assert.ok(lastUrl().includes("groupId=g2") && !lastUrl().includes("officerId"), "changing State cleared the previous person");
assert.deepEqual(lastHeader().options.map((o) => o.label).sort(), ["RM Two", "Ravi"], "only UP people are offered, RM included");
lastHeader().onChange(["rm2"]);
render(Role.SUPER_ADMIN);
assert.ok(lastUrl().includes("groupId=g2") && lastUrl().includes("officerId=rm2"), "State + person together");
selects.find((s) => s.options.some((o) => o.label === "UP"))!.onChange!({ target: { value: "" } });
render(Role.SUPER_ADMIN);
assert.ok(!lastUrl().includes("groupId") && !lastUrl().includes("officerId"), "clearing State restores the authorized scope");
assert.equal(lastHeader().options.length, 3);

// 5) Roles: an RM keeps the header filter; a Sales Officer has none.
hooks = [];
render(Role.REGIONAL_MANAGER);
assert.equal(headers.length, 1, "RM sees the person filter");
hooks = [];
render(Role.SALES_OFFICER);
assert.equal(headers.length, 0, "Sales Officer view has no person filter");

console.log("performance-filter.test.tsx — all assertions passed");
