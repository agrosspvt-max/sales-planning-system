/** Performance → Tasks: Employee and Status filters live in their column headings (single choice, backend filtering, page 1 on change). No DB / browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { defaultTaskFilters, summarizeTasks, type TaskFilterState } from "@/lib/task-analysis";
import { testLoader } from "@/features/dealer-tags/test-loader";

interface Header { label: string; ariaLabel: string; options: { value: string; label: string }[]; selected: string[]; onChange: (n: string[]) => void; allLabel?: string; searchable?: boolean; activeText?: string }
let headers: Header[] = [];
let rows: unknown[] = [];
const L = DEFAULT_LABELS as Record<string, string>;
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const row = (over: Record<string, unknown>) => ({ key: "K1", sourceType: "BILLING_EXCEPTION", taskId: "t1", ownerId: "so1", ownerName: "Suresh Verma", territory: null, state: "CG", type: "AUTO", section: "RECOVERY", subtype: "BILLING_EXCEPTION", dealerId: "d", dealerName: "Dealer", marketName: null, description: null, amount: 100, originalDate: "2026-10-14", originalVerified: true, currentDate: "2026-10-14", moves: 0, daysMoved: 0, status: "PENDING", historyState: "COMPLETE", periodMoves: null, ...over });
const payload = () => ({ filters: {}, summary: summarizeTasks(rows as never), rows, page: 3, pageSize: 25, totalRows: rows.length, totalPages: 3, focusCount: null, officers: [{ id: "so1", name: "Suresh Verma" }, { id: "so2", name: "Pankaj Verma" }], states: [{ id: "g1", name: "CG" }] });
const load = testLoader({
  react: { ...React, useState: (i: unknown) => [i, () => {}], useEffect: () => {} },
  "@tanstack/react-query": { useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[1] === "analysis" ? payload() : undefined, isLoading: false, error: null }) },
  "@/lib/api-client": { api: { get: async () => ({}) } },
  "@/features/labels/label-ui": { useLabel: (k: LabelKey) => DEFAULT_LABELS[k], Th: ({ labelKey }: { labelKey: LabelKey }) => <th>{DEFAULT_LABELS[labelKey]}</th> },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/components/ui/date-input-dmy": { DateInputDMY: ({ value, "aria-label": a }: { value: string; "aria-label"?: string }) => <input readOnly aria-label={a} value={value} /> },
  "@/components/ui/column-filter-header": { ColumnFilterHeader: (p: Header) => { headers.push(p); return <th data-col-filter={p.ariaLabel}>{p.label}{p.selected.length > 0 && p.activeText !== undefined && <span data-testid="column-filter-active">{p.activeText}</span>}</th>; } },
});
const { TaskAnalysisView } = load<typeof import("./task-analysis-view")>("src/features/tasks/task-analysis-view.tsx");
const base: TaskFilterState = { ...defaultTaskFilters("2026-10-15"), from: "2026-10-01", to: "2026-10-31", page: 3 };
let last: TaskFilterState | null = null;
const render = (role: Role, f: TaskFilterState = base) => { headers = []; return renderToStaticMarkup(<TaskAnalysisView role={role} filters={f} onFilters={(n: TaskFilterState) => { last = n; }} />); };
const employee = () => headers.find((h) => h.ariaLabel === L["tasks.filter.employee"])!;
const status = () => headers.find((h) => h.ariaLabel === L["tasks.filter.status"])!;

rows = [row({})];
let html = render(Role.SUPER_ADMIN);
// Top controls are gone; the other filters stay.
assert.ok(!/<label[^>]*>\s*Employee\s*<\/label>/i.test(html) && !html.includes(`aria-label="${L["tasks.filter.status"]}"`), "no Employee / Status dropdowns above the table");
for (const k of ["tasks.filter.basis", "tasks.filter.section", "tasks.filter.source"]) assert.ok(html.includes(`aria-label="${L[k]}"`), `${k} stays`);
assert.ok(html.includes('aria-label="State"') && html.includes('aria-label="From'), "State, From and To stay");
// Employee column: searchable, All Employees + the authorized options.
same([employee().label, employee().allLabel, employee().searchable], ["Employee", L["tasks.filter.all_employees"], true]);
same(employee().options.map((o) => o.value), ["so1", "so2"], "the same authorized options the top filter had");
same(status().options.map((o) => o.label), ["Completed", "Pending", "Overdue", "Abandoned", "Cancelled"], "Status options keep their definitions");
assert.equal(status().allLabel, L["tasks.filter.all_statuses"]);
assert.equal(html.indexOf("data-col-filter") > html.indexOf("<thead"), true, "both filters sit in the table header");
// Selecting sets the existing query field, returns to page 1 and keeps the other filters.
const withOthers: TaskFilterState = { ...base, section: "RECOVERY", source: "BILLING_EXCEPTION", groupId: "g1" };
render(Role.SUPER_ADMIN, withOthers); employee().onChange(["so2"]);
same([last!.officerId, last!.page, last!.section, last!.source, last!.groupId, last!.from, last!.to, last!.basis], ["so2", 1, "RECOVERY", "BILLING_EXCEPTION", "g1", "2026-10-01", "2026-10-31", withOthers.basis], "Employee change: page 1, other selections preserved");
render(Role.SUPER_ADMIN, withOthers); status().onChange(["OVERDUE"]);
same([last!.status, last!.page, last!.section], ["OVERDUE", 1, "RECOVERY"]);
// Combined filters; choosing another option replaces (single choice); All / re-selecting clears only that filter.
const both: TaskFilterState = { ...withOthers, officerId: "so1", status: "OVERDUE" };
html = render(Role.SUPER_ADMIN, both);
same([employee().selected, status().selected], [["so1"], ["OVERDUE"]]);
assert.ok(html.includes("Suresh Verma</span>") && html.includes("Overdue</span>"), "compact active indication beneath each heading");
status().onChange(["OVERDUE", "COMPLETED"]); assert.equal(last!.status, "COMPLETED", "another option replaces the choice");
render(Role.SUPER_ADMIN, both); status().onChange([]);
same([last!.status, last!.officerId, last!.section, last!.page], ["", "so1", "RECOVERY", 1], "All Statuses clears only the status");
render(Role.SUPER_ADMIN, both); employee().onChange([]);
same([last!.officerId, last!.status, last!.page], ["", "OVERDUE", 1], "All Employees clears only the employee");
render(Role.SUPER_ADMIN, both); employee().onChange([]);
assert.equal(last!.officerId, "", "toggling the chosen employee returns to All");
// Inactive: no indication.
html = render(Role.SUPER_ADMIN);
assert.ok(!html.includes('data-testid="column-filter-active"'), "no indication while All is chosen");
// Empty results: the filters stay reachable.
rows = []; html = render(Role.SUPER_ADMIN, both);
assert.ok(html.includes(`data-col-filter="${L["tasks.filter.employee"]}"`) && html.includes(`data-col-filter="${L["tasks.filter.status"]}"`) && html.includes(L["tasks.empty"]!), "with no matching rows the filters remain in the header");
// Roles: a Sales Officer has no employee filter (plain heading) but keeps Status; an RM keeps Employee, no State.
rows = [row({})];
render(Role.SALES_OFFICER); assert.ok(!headers.some((h) => h.ariaLabel === L["tasks.filter.employee"]) && headers.some((h) => h.ariaLabel === L["tasks.filter.status"]), "SO: no Employee filter, Status filter present");
html = render(Role.REGIONAL_MANAGER); assert.ok(headers.some((h) => h.ariaLabel === L["tasks.filter.employee"]) && !html.includes('aria-label="State"'), "RM: Employee filter, no State filter");
// All / Auto / Manual views share the table (the same headers whichever type is selected).
for (const type of ["ALL", "AUTO", "MANUAL"] as const) { render(Role.SUPER_ADMIN, { ...base, type }); assert.ok(employee() && status(), `${type} view has both column filters`); }
console.log("task-column-filters.test.tsx — all assertions passed");

// The shared header itself: a single-choice column shows its choice beneath the heading in the active blue (no "(n)" count) and nothing when inactive.
{
  const real = testLoader({})("src/components/ui/column-filter-header.tsx") as { ColumnFilterHeader: React.ComponentType<Record<string, unknown>> };
  const mk = (selected: string[]) => renderToStaticMarkup(<table><thead><tr><real.ColumnFilterHeader label="Status" ariaLabel="Status" options={[{ value: "OVERDUE", label: "Overdue" }]} selected={selected} onChange={() => undefined} activeText="Overdue" /></tr></thead></table>);
  const on = mk(["OVERDUE"]), off = mk([]);
  assert.ok(on.includes('data-testid="column-filter-active"') && on.includes("text-primary") && !on.includes("Status (1)"), "active: blue indication, no count");
  assert.ok(!off.includes("column-filter-active"), "inactive: no indication");
  console.log("column-filter-header single-choice indication passed");
}
