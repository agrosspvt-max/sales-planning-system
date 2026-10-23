/** Group routing, permission boundaries and cached own-plan lists in the real Approvals components. */
import assert from "node:assert/strict";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

let role: Role = Role.SUPER_ADMIN;
let grants = new Set<string>();
let states: unknown[] = [];
let cursor = 0;
const switches: { children: string; onClick: () => void; "aria-pressed": boolean }[] = [];
const queries: { queryKey: string[]; enabled?: boolean }[] = [];
const overrides: Record<string, string> = {};
let staleLabels = false;
const label = (key: string) => staleLabels && key.startsWith("approvals.") ? "" : overrides[key] ?? (DEFAULT_LABELS as Record<string, string>)[key] ?? key;
const plan = { id: "seasonal", seasonName: "Seasonal queue", officerName: "Officer", version: 1, status: "PENDING_RM", submittedAt: null };
const monthly = { id: "monthly", seasonName: "Monthly queue", monthName: "October", officerName: "Officer", status: "PENDING_ADMIN" };
const recovery = { id: "recovery", seasonName: "Recovery queue", monthName: "October", officerName: "Officer", status: "PENDING_RM" };
const cn = { id: "cn1", dealerId: "d1", partyName: "CN dealer", officerId: "other", employeeName: "Officer", cnType: "Price diff", state: "MP" };
const dataFor = (key: string[]) => {
  if (key[0] === "approvals") return [plan];
  if (key[0] === "monthly-plans") return key[1] === "mine" ? [{ ...monthly, seasonName: "Own monthly" }] : [monthly];
  if (key[0] === "recovery-plans") return key[1] === "mine" ? [{ ...recovery, seasonName: "Own recovery" }] : [recovery];
  if (key[0] === "plans") return [{ ...plan, seasonName: "Own seasonal" }];
  if (key[0] === "cn-requests") return [cn];
  if (key[0] === "month-extensions") return [{ id: "extension", seasonName: "Legacy extension", monthName: "March", requestedByName: "Officer" }];
  return [];
};
const tag = (name: string) => function Tag({ children }: { children?: React.ReactNode }) { return React.createElement(name, null, children); };
const jsx = (type: unknown, props: Record<string, unknown>, key?: string) => {
  if (type === "button" && "aria-pressed" in props) switches.push(props as typeof switches[number]);
  return jsxRuntime.jsx(type as React.ElementType, props, key);
};
const load = testLoader({
  "react/jsx-runtime": { ...jsxRuntime, jsx },
  react: { ...React, useMemo: (fn: () => unknown) => fn(), useState: (initial: unknown) => {
    const i = cursor++;
    if (!(i in states)) states[i] = initial;
    return [states[i], (next: unknown) => { states[i] = next; }];
  } },
  "@/features/labels/label-ui": { useLabel: label, useLabelResolver: () => label },
  "@/features/accounts/permission-ui": { useAdminPermission: (module: string) => role !== Role.CUSTOM_ADMIN || grants.has(module) },
  "@/lib/api-client": { api: { get: async () => [], post: async () => ({}) } },
  "@tanstack/react-query": {
    useQuery: (o: { queryKey: string[]; enabled?: boolean }) => { queries.push(o); return { data: dataFor(o.queryKey), isLoading: false }; },
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    useMutation: () => ({ mutate: () => {}, isPending: false }),
  },
  "@/components/layout/page-header": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> },
  "@/components/ui/table": { Table: tag("table"), TableHeader: tag("thead"), TableBody: tag("tbody"), TableRow: tag("tr"), TableHead: tag("th"), TableCell: tag("td") },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: tag("tbody") },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <span>{name}</span> },
  "@/features/dealer-tags/dealer-tag-requests": { DealerTagRequests: () => <div>Dealer tag approval</div> },
  "@/features/cn-requests/cn-review-ui": { CnReviewInbox: () => <div>Rate confirmation dependency · CN approval dependency</div> },
  "next/link": ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
});
const { ApprovalsInbox } = load<typeof import("./approvals-inbox")>("src/features/planning/approvals-inbox.tsx");
function render() {
  cursor = 0; switches.length = 0; queries.length = 0;
  return renderToStaticMarkup(<ApprovalsInbox role={role} userId="me" />);
}
function choose(text: string) {
  const button = switches.find(b => b.children === text);
  assert.ok(button, `switch ${text} exists`);
  button.onClick();
  return render();
}
const enabled = () => queries.filter(q => q.enabled !== false).map(q => q.queryKey[0]);

let html = render();
assert.deepEqual(switches.map(b => b.children), ["Sales Planning", "Recovery Planning", "CN Request", "Other"]);
assert.ok(html.includes("Seasonal queue") && html.includes("Monthly queue") && !html.includes("Recovery queue"));
assert.equal((html.match(/<h1>/g) ?? []).length, 1, "one header above all categories");
assert.deepEqual(enabled(), ["approvals", "monthly-plans"], "only the active category loads its lists");
html = choose("Recovery Planning");
assert.ok(html.includes("Recovery queue") && !html.includes("Seasonal queue") && !html.includes("Monthly queue"));
assert.deepEqual(enabled(), ["recovery-plans"]);
html = choose("CN Request");
assert.ok(html.includes("CN dealer") && !html.includes("Rate confirmation dependency"));
assert.deepEqual(enabled(), ["cn-requests"]);
html = choose("Dependency");
assert.ok(html.includes("Rate confirmation dependency") && html.includes("CN approval dependency") && !html.includes("CN dealer"));
assert.deepEqual(enabled(), [], "the inactive regular CN queue does not fetch in Dependency");
html = choose("Other");
assert.ok(html.includes("Dealer tag approval") && html.includes("Legacy extension") && !html.includes("Rate confirmation dependency"));
assert.deepEqual(enabled(), ["month-extensions"]);
html = choose("CN Request");
assert.ok(html.includes("Rate confirmation dependency"), "the chosen CN subcategory is remembered");

role = Role.CUSTOM_ADMIN; grants = new Set();
html = render();
assert.deepEqual(switches.map(b => b.children), ["CN Request", "Dependency"], "dependency-only accounts retain their assigned inbox and cannot see unrelated queues");
assert.deepEqual(enabled(), []);
assert.ok(html.includes("CN approval dependency") && !html.includes("CN dealer"));
grants = new Set(["approvals", "recoveryPlanning"]); states = [];
html = render();
assert.deepEqual(switches.map(b => b.children), ["Recovery Planning", "CN Request"]);
assert.deepEqual(enabled(), ["recovery-plans"], "default falls back to the first permitted category");

role = Role.REGIONAL_MANAGER; states = [];
html = render();
assert.ok(html.includes("Seasonal queue") && !html.includes("Monthly queue"), "RM keeps its Pending RM planning scope");
html = choose("CN Request");
assert.ok(html.includes("CN dealer"));
cn.officerId = "me";
html = render();
assert.ok(!html.includes("CN dealer") && html.includes("No CN requests awaiting review."), "RM cannot review its own CN request");
cn.officerId = "other";
html = choose("Other");
assert.ok(html.includes("Dealer tag approval") && !html.includes("Legacy extension"), "admin-only month decisions stay unavailable to RM");

role = Role.SALES_OFFICER; states = [];
html = render();
assert.ok(html.includes("Own seasonal") && html.includes("Own monthly") && !html.includes("Own recovery"));
assert.deepEqual(enabled(), ["plans", "monthly-plans"]);
html = choose("Recovery Planning");
assert.ok(html.includes("Own recovery") && !html.includes("Own seasonal") && !html.includes("Own monthly"), "cached sales lists cannot leak into Recovery");
assert.deepEqual(enabled(), ["recovery-plans"]);
html = choose("CN Request");
assert.ok(html.includes("CN approval dependency") && !html.includes("CN dealer"), "SO gets assigned dependencies, not the admin CN approval queue");
html = choose("Other");
assert.ok(html.includes("Dealer tag approval") && !html.includes("Own recovery"));
assert.deepEqual(enabled(), [], "Other does not load any of the officer's plan lists");

role = Role.SUPER_ADMIN; states = [];
overrides["approvals.category.sales"] = "Renamed sales";
html = render();
assert.ok(html.includes("Renamed sales") && html.includes("Seasonal queue"), "editable Labels do not affect category routing");
staleLabels = true; states = [];
html = render();
assert.ok(html.includes("<h1>Approvals</h1>") && switches.some(b => b.children === "Sales Planning") && switches.some(b => b.children === "Recovery Planning"), "a cached label list cannot make the title or main switches blank");
html = choose("CN Request");
html = choose("Dependency");
assert.ok(html.includes("CN approval dependency") && switches.some(b => b.children === "Dependency"), "the secondary switch remains usable while labels refresh");
console.log("Approvals category switches, CN dependencies, own-plan separation and permission boundaries passed.");
