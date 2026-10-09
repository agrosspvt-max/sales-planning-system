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
const payloadFor = (url: string) => {
  const q = new URLSearchParams(url.split("?")[1]);
  const state = q.get("groupId"); const person = q.get("officerId");
  const pool = PEOPLE.filter((p) => !state || p.state === state);
  const shown = pool.filter((p) => !person || p.id === person);
  return {
    role: Role.SUPER_ADMIN, from: "2026-09-28", to: "2026-09-28", canEditAttendance: false,
    states: [{ id: "g1", name: "MP" }, { id: "g2", name: "UP" }],
    officers: pool.map((p) => ({ id: p.id, name: p.name })),
    rows: shown.map((p) => ({ officerId: p.id, officerName: p.name, groupId: p.state, stateName: p.state, date: "2026-09-28", attendance: "PRESENT", planSubmittedAt: "2026-09-28T09:00:00.000Z", reportSubmittedAt: null, reportMissed: p.id === "so1", selfRating: null, rmRating: null, submitted: true })),
    summary: { salesOfficers: shown.length, presentDays: shown.length, totalDays: shown.length, submittedPlans: shown.length, submittedReports: 0, averageSelfRating: null, averageRmRating: null, sections: Object.fromEntries(["sales", "recovery", "schemeConversion", "appointment", "visits"].map((k) => [k, { planned: 0, actual: 0 }])) },
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
  "@/features/labels/label-ui": { useLabel: (key: LabelKey) => DEFAULT_LABELS[key] },
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
