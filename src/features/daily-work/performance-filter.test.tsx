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
const rangeHeaders: { from: string; to: string; today: string; onApply: (f: string, t: string) => void }[] = [];
const headers: { label: string; ariaLabel: string; selected: string[]; options: { value: string; label: string }[]; onChange: (next: string[]) => void }[] = [];
const selects: { value?: string; onChange?: (e: { target: { value: string } }) => void; options: { value: string; label: string }[] }[] = [];

// Server payload per query string: what the real API returns for the Admin (options follow State; RMs included).
const PEOPLE = [
  { id: "rm2", name: "RM Two", state: "g2" }, { id: "so1", name: "Rahul", state: "g1" }, { id: "so3", name: "Ravi", state: "g2" },
];
let patch: Record<string, Record<string, unknown>> = {};
const payloadFor = (url: string) => {
  const q = new URLSearchParams(url.split("?")[1]);
  const states = q.getAll("groupId"); const people = q.getAll("officerId");
  const pool = PEOPLE.filter((p) => !states.length || states.includes(p.state));
  const shown = pool.filter((p) => !people.length || people.includes(p.id));
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
  "@/components/ui/date-range-filter-header": { DateRangeFilterHeader: (p: (typeof rangeHeaders)[number]) => { rangeHeaders.push(p); return <th>Date</th>; } },
  "@/components/ui/select": {
    NativeSelect: (props: (typeof selects)[number]) => { selects.push(props); return <select />; },
  },
  "@/components/layout/page-header": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> },
  "./team-performance-page": { DailyWorkReviewDialog: () => null },
};
const load = testLoader(overrides);
const { PerformancePage } = load("src/features/daily-work/performance-page.tsx") as { PerformancePage: React.ComponentType<{ role: Role }> };

const render = (role: Role) => { cursor = 0; headers.length = 0; rangeHeaders.length = 0; selects.length = 0; return renderToStaticMarkup(<PerformancePage role={role} />); };
const lastUrl = () => urls[urls.length - 1]!;
const lastHeader = () => headers.find((h) => h.label === "Sales Officer")!;
const stateHeader = () => headers.find((h) => h.label === "State")!;
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// 0) Performance | Tasks switches above the filters (Performance selected by default) and the compact Task Activity column.
{
  const h = render(Role.SUPER_ADMIN);
  assert.ok(/data-testid="mode-switch"[^>]*>\s*<button[^>]*aria-pressed="true"[^>]*>Performance<\/button>\s*<button[^>]*aria-pressed="false"[^>]*>Tasks<\/button>/.test(h), "Performance | Tasks, Performance selected");
  assert.ok(h.indexOf('data-testid="mode-switch"') < h.indexOf('data-testid="section-totals"'), "the switches sit above the summary cards");
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

// 3) Multiple names stay selected; unchecking one preserves the others; All clears.
lastHeader().onChange(["so3", "rm2"]);
html = render(Role.SUPER_ADMIN);
assert.deepEqual(plain(lastHeader().selected), ["so3", "rm2"], "ticking an RM preserves the earlier SO selection");
assert.deepEqual(new URLSearchParams(lastUrl().split("?")[1]).getAll("officerId"), ["so3", "rm2"]);
assert.ok(html.includes("Ravi") && html.includes("RM Two") && !html.includes("Rahul"), "rows include either selected person");
assert.ok(/Sales Officers<\/div><div[^>]*>2</.test(html), "summary follows the full selection");
lastHeader().onChange(["so3", "rm2", "so1"]);
render(Role.SUPER_ADMIN);
assert.deepEqual(plain(lastHeader().selected), ["so3", "rm2", "so1"], "a third tick preserves both earlier names");
lastHeader().onChange(["so3", "so1"]);
html = render(Role.SUPER_ADMIN);
assert.deepEqual(plain(lastHeader().selected), ["so3", "so1"], "unticking one removes only that person");
assert.ok(html.includes("Ravi") && html.includes("Rahul") && !html.includes("RM Two"));
lastHeader().onChange([]);
render(Role.SUPER_ADMIN);
assert.deepEqual(plain(lastHeader().selected), []);
assert.ok(!lastUrl().includes("officerId"), "clearing restores the full scope");

// 4) State + person: State narrows the options; changing State clears a person who no longer belongs.
lastHeader().onChange(["so1", "so3"]);
render(Role.SUPER_ADMIN);
assert.ok(stateHeader(), "State column header is also a multiselect");
assert.equal(selects.length, 0, "no duplicate State dropdown above the table");
stateHeader().onChange(["g2"]);
render(Role.SUPER_ADMIN);
assert.ok(lastUrl().includes("groupId=g2") && !lastUrl().includes("officerId"), "changing State cleared the previous person");
assert.deepEqual(lastHeader().options.map((o) => o.label).sort(), ["RM Two", "Ravi"], "only UP people are offered, RM included");
lastHeader().onChange(["rm2"]);
render(Role.SUPER_ADMIN);
assert.ok(lastUrl().includes("groupId=g2") && lastUrl().includes("officerId=rm2"), "State + person together");
stateHeader().onChange(["g2", "g1"]);
html = render(Role.SUPER_ADMIN);
assert.deepEqual(plain(stateHeader().selected), ["g2", "g1"], "adding another State preserves the first");
assert.deepEqual(new URLSearchParams(lastUrl().split("?")[1]).getAll("groupId"), ["g2", "g1"]);
assert.equal(lastHeader().options.length, 3, "officer choices include all selected States");
assert.ok(html.includes("Rahul") && html.includes("Ravi") && html.includes("RM Two"));
stateHeader().onChange(["g1"]);
html = render(Role.SUPER_ADMIN);
assert.deepEqual(plain(stateHeader().selected), ["g1"], "unchecking a State preserves the others");
assert.deepEqual(lastHeader().options.map((o) => o.label), ["Rahul"]);
assert.ok(html.includes("Rahul") && !html.includes("Ravi") && !html.includes("RM Two"));
stateHeader().onChange([]);
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

// Exercise real checkbox events through the shared header and the page, not just the callback props.
{
  type Item = { "data-filter-value"?: string; "data-testid"?: string; onSelect: (e: { preventDefault: () => void }) => void; children?: React.ReactNode };
  const items: Item[] = [];
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const realOverrides = { ...overrides };
  delete realOverrides["@/components/ui/column-filter-header"];
  realOverrides["@/components/ui/dropdown-menu"] = {
    DropdownMenu: passthrough, DropdownMenuTrigger: passthrough, DropdownMenuContent: passthrough,
    DropdownMenuItem: (p: Item) => { items.push(p); return <div>{p.children}</div>; },
  };
  const { PerformancePage: RealPage } = testLoader(realOverrides)("src/features/daily-work/performance-page.tsx") as { PerformancePage: typeof PerformancePage };
  hooks = [];
  const draw = () => { cursor = 0; items.length = 0; return renderToStaticMarkup(<RealPage role={Role.SUPER_ADMIN} />); };
  const click = (id: string) => { items.find((p) => p["data-filter-value"] === id)!.onSelect({ preventDefault() {} }); return draw(); };
  const checked = (h: string, name: string) => [...h.matchAll(/<input\b[^>]*>/g)].some(([tag]) => tag.includes(`aria-label="${name}"`) && tag.includes('checked=""'));
  draw(); click("so3"); let h = click("rm2");
  assert.ok(checked(h, "Ravi") && checked(h, "RM Two"), "real checkbox clicks preserve both choices");
  assert.ok(h.includes("Sales Officer (2)"), "header shows the full selection count");
  h = click("so3");
  assert.ok(!checked(h, "Ravi") && checked(h, "RM Two"), "unchecking removes only that choice");
  items.find((p) => p["data-testid"] === "filter-all")!.onSelect({ preventDefault() {} });
  h = draw();
  assert.ok(!lastUrl().includes("officerId") && !checked(h, "RM Two"), "All clears the filter");
  click("g1"); h = click("g2");
  assert.ok(checked(h, "MP") && checked(h, "UP") && h.includes("State (2)"), "real State checkbox clicks keep both choices");
  h = click("g1");
  assert.ok(!checked(h, "MP") && checked(h, "UP"), "a State can be unticked independently");
  items.filter((p) => p["data-testid"] === "filter-all")[1]!.onSelect({ preventDefault() {} });
  draw();
  assert.ok(!lastUrl().includes("groupId"), "State All clears every State selection");
}

// The real metric popup carries every selected person (and State) to its detail endpoint.
{
  const detailUrls: string[] = [];
  const { PerformanceMetricDetail: Metric } = testLoader({
    ...overrides,
    "@tanstack/react-query": { useQuery: ({ queryFn }: { queryFn: () => unknown }) => { void queryFn(); return { data: undefined, isLoading: true }; } },
    "@/lib/api-client": { api: { get: async (url: string) => { detailUrls.push(url); } } },
  })("src/features/daily-work/performance-metric-detail.tsx") as { PerformanceMetricDetail: React.ComponentType<{ request: Record<string, unknown>; onClose: () => void }> };
  hooks = []; cursor = 0;
  renderToStaticMarkup(<Metric request={{ metric: "sales_planned", title: "Sales", from: "2026-10-20", to: "2026-10-21", officerIds: ["so1", "so3"], groupIds: ["g1", "g2"], isSO: false, isAdmin: true }} onClose={() => {}} />);
  const q = new URLSearchParams(detailUrls[0]!.split("?")[1]);
  assert.deepEqual(q.getAll("officerId"), ["so1", "so3"]);
  assert.deepEqual(q.getAll("groupId"), ["g1", "g2"]);
}

// Sunday presentation: "Sunday" under the date (even when worked), "—" instead of Missed only for an unfilled Sunday; real Sunday activity is untouched.
{
  const SUN = { date: "2026-09-27", sunday: true };
  hooks = [];
  const cells = (html: string, name: string) => { const tr = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!).find((t) => t.includes(name))!; return [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!); };
  patch = {
    so1: { ...SUN, planSubmittedAt: null, planMissed: true, reportMissed: true, unfilledSunday: true },                       // nothing entered
    so3: { ...SUN, reportMissed: true, unfilledSunday: false },                                                              // worked: plan submitted, report missed
    rm2: { ...SUN, planSubmittedAt: null, planMissed: true, reportMissed: true, unfilledSunday: false },                      // a genuine draft: keeps its (derived) state
  };
  const html = render(Role.SUPER_ADMIN);
  const unfilled = cells(html, "Rahul"), worked = cells(html, "Ravi"), draft = cells(html, "RM Two");
  assert.ok(unfilled[1]!.includes("27/09/2026") && unfilled[1]!.includes('data-testid="sunday-label">Sunday<'), "Sunday is shown beneath the date");
  assert.ok(worked[1]!.includes('data-testid="sunday-label">Sunday<'), "a worked Sunday carries the annotation too");
  assert.ok(!unfilled.join("").includes("Missed"), "an unfilled Sunday shows no Missed badge in either submission cell");
  assert.ok(unfilled.filter((c) => c === "—").length >= 2, "plain dashes in Plan and Report Submission");
  assert.ok(worked.join("").includes("Missed"), "a worked Sunday with a missed report keeps the Missed badge");
  assert.ok(draft.join("").includes("Missed"), "a real draft is never replaced by a dash");
  hooks = []; patch = { so1: { date: "2026-09-28" } };
  assert.ok(!render(Role.SUPER_ADMIN).includes("sunday-label"), "weekday rows have no annotation");
  patch = {};
}

// Date column filter: the header drives the same from/to query state; State and Sales Officer selections survive a date change; the standalone date inputs are gone.
{
  hooks = [];
  let html2 = render(Role.SUPER_ADMIN);
  assert.ok(!html2.includes("Date From") && !html2.includes("Date To"), "no standalone Date From / Date To inputs");
  assert.equal(rangeHeaders.length, 1, "the Date column header is the range filter");
  stateHeader().onChange(["g1"]); html2 = render(Role.SUPER_ADMIN);
  lastHeader().onChange(["so1"]); html2 = render(Role.SUPER_ADMIN);
  rangeHeaders[0]!.onApply("2026-10-18", "2026-10-24"); html2 = render(Role.SUPER_ADMIN);
  const q2 = new URLSearchParams(lastUrl().split("?")[1]);
  assert.deepEqual([q2.get("from"), q2.get("to"), q2.getAll("groupId"), q2.getAll("officerId")], ["2026-10-18", "2026-10-24", ["g1"], ["so1"]], "the new range is queried with the State and officer kept");
  assert.deepEqual([rangeHeaders[0]!.from, rangeHeaders[0]!.to], ["2026-10-18", "2026-10-24"], "the header shows the applied range");
  // Empty results: the Date header (and so its applied-range indicator) is still rendered.
  lastHeader().onChange(["nobody"]); html2 = render(Role.SUPER_ADMIN);
  assert.ok(html2.includes((DEFAULT_LABELS as Record<string, string>)["daily_work.performance.empty"]!), "the empty state is shown");
  assert.equal(rangeHeaders.length, 1, "the Date header with its indicator stays visible when results are empty");
  hooks = [];
}

console.log("performance-filter.test.tsx — all assertions passed");
