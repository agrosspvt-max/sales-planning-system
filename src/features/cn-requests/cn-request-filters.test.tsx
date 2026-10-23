/** CN header filters: combinations, state cascading, role-specific columns, tabs, and shared export values. No database. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { cnFilterParams, filterCnRequests, parseCnFilters } from "@/lib/cn-request-filters";

const hooks: unknown[] = [];
let cursor = 0;
type Header = { label: string; selected: string[]; options: { value: string; label: string; secondary?: string }[]; searchable: boolean; onChange: (v: string[]) => void };
let headers: Header[] = [];
let navs: { onChange: (v: string) => void }[] = [];
const clicks: Record<string, () => void> = {};
const urls: string[] = [];
const row = (id: string, dealerId: string, officerId: string, state: string | null, territory: string | null, cnType: string) => ({
  id, dealerId, partyName: dealerId === "d1" ? "Alpha Dealer" : "Beta Dealer", cnType, amount: 1000, postedAmount: null,
  paymentStatus: "Pending", paymentVerified: false, paymentTrackingMode: "PAYMENT_V1", paymentOriginalAmount: 1000, paymentOutstandingAmount: 1000,
  officerId, employeeName: "Same Name", state, territory, status: "SUBMITTED", details: null, remarks: null,
  rejectionReason: null, rejectionReasonDetails: null, acceptanceReason: null, acceptanceReasonDetails: null,
  processingReview: undefined as { kind: string; status: string } | undefined, cnExpiryDays: null, expiryDate: "2026-10-25", cnWorking: null, finalCn: null, createdAt: "2026-10-19T05:00:00Z", days: 1,
});
const data = [row("r1", "d1", "so1", "MP", "North", "CD"), row("r2", "d2", "so2", "UP", "South", "Freight"), row("r3", "d1", "so1", "MP", "North", "Damage")];
let rows = data;
let allowActions = true;
const load = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (v: unknown) => { hooks[i] = typeof v === "function" ? (v as (old: unknown) => unknown)(hooks[i]) : v; }]; } },
  "@/features/labels/label-ui": { useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k, useLabelResolver: () => (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@/features/accounts/permission-ui": { useAdminPermission: () => allowActions },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <span>{name}</span> },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
  "@/components/ui/column-filter-header": { ColumnFilterHeader: (p: Header) => { headers.push(p); return <th>{p.label}</th>; } },
  "@/components/ui/select": { NativeSelect: () => <select /> },
  "@/features/planning/plan-list-ui": { PillNav: (p: (typeof navs)[number]) => { navs.push(p); return <div />; }, UnderlineTabs: (p: (typeof navs)[number]) => { navs.push(p); return <div />; } },
  "@/components/layout/page-header": { PageHeader: () => null },
  "./cn-review-ui": { CnProcessingDialog: (p: { requestId: string; canHandle: boolean }) => <div data-open-review={p.requestId} data-can-handle={String(p.canHandle)} /> },
  "./cn-payment-dialog": { CnPaymentDialog: () => null },
  "./cn-request-detail-dialog": { CnRequestDetailDialog: () => null },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; variant?: string; className?: string }) => { if (typeof p.children === "string" && p.onClick) clicks[p.children] = p.onClick; return <button data-variant={p.variant} className={p.className}>{p.children}</button>; } },
  "@/lib/api-client": { api: { get: async (u: string) => { urls.push(u); return rows; } } },
  "@tanstack/react-query": {
    useQuery: (o: { queryFn: () => unknown }) => { void o.queryFn(); return { data: rows, isLoading: false }; },
    useQueryClient: () => ({ invalidateQueries: () => undefined }), useMutation: () => ({ isPending: false, mutate: () => undefined }),
  },
});
const { CnRequestsPage } = load<{ CnRequestsPage: React.ComponentType<{ role: Role; userId: string }> }>("src/features/cn-requests/cn-requests-page.tsx");
const render = (role: Role = Role.SUPER_ADMIN) => { cursor = 0; headers = []; navs = []; const html = renderToStaticMarkup(<CnRequestsPage role={role} userId="so1" />); hooks.length = cursor; return html; };
const label = (k: string) => (DEFAULT_LABELS as Record<string, string>)[k]!;
const header = (name: string) => headers.find((h) => h.label === name)!;
const shown = (html: string) => [...html.matchAll(/data-dealer-id="([^"]+)"/g)].map((m) => m[1]);
const same = (a: unknown, b: unknown, why: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), why);
let html = render();
same(shown(html), ["d1", "d2", "d1"], "no filters means every request, including multiple requests for the same dealer");
assert.ok(headers.every((h) => h.searchable), "each data column uses the shared searchable header dropdown");
same(header(label("cn_requests.field.state")).options.map((o) => o.label), ["MP", "UP"], "State choices are alphabetical");
header(label("cn_requests.field.state")).onChange(["MP"]); html = render();
same(shown(html), ["d1", "d1"], "State filters the table");
same(header(label("cn_requests.field.employee_name")).options.map((o) => o.value), ["so1"], "employee choices obey State and use ids");
same(header(label("cn_requests.field.territory")).options.map((o) => o.label), ["North"], "territory choices obey State");
header(label("cn_requests.field.cn_type")).onChange(["CD", "Damage/Expiry"]); html = render();
same(shown(html), ["d1", "d1"], "OR within CN Type; legacy Damage matches its canonical displayed type");
header(label("cn_requests.field.cn_type")).onChange(["Freight"]); html = render();
assert.ok(html.includes("No matching CN requests.") && html.includes("Clear filters"), "an incompatible combination has a clear empty state and reset");
header(label("cn_requests.field.state")).onChange(["UP"]); html = render();
same(shown(html), ["d2"], "changing State clears dependent selections");
clicks["Clear filters"]!(); html = render();
header(label("cn_requests.field.employee_name")).onChange(["so2"]); html = render();
same(shown(html), ["d2"], "same employee names never combine separate ids");
navs[1]!.onChange("rejected"); html = render();
assert.ok(urls.at(-1)!.includes("view=rejected"));
assert.ok(headers.every((h) => h.selected.length === 0), "switching tabs clears hidden/stale filters");
navs[0]!.onChange("accepted"); render();
for (const name of [label("cn_requests.task.amount"), label("cn_requests.field.payment_status"), label("cn_requests.col.expires")]) assert.ok(header(name)?.searchable, `accepted column ${name} is searchable`);
hooks.length = 0; rows = data.filter((r) => r.officerId === "so1"); render(Role.SALES_OFFICER);
assert.ok(!headers.some((h) => [label("cn_requests.field.state"), label("cn_requests.field.employee_name"), label("cn_requests.field.territory")].includes(h.label)), "SO keeps its existing own-scope column layout");
same(header(label("cn_requests.task.party")).options.map((o) => o.value), ["d1"], "choices use only the authorized rows delivered to this view");
const filters = { state: ["MP"], cnType: ["CD", "Damage/Expiry"] };
same(filterCnRequests(data, parseCnFilters(cnFilterParams(filters))).map((r) => r.id), ["r1", "r3"], "export round-trip uses the exact same filter rules");
same(filterCnRequests([row("empty", "d3", "so3", null, null, "Demo")], { state: [""] }).map((r) => r.id), ["empty"], "missing State can be selected explicitly");
same(filterCnRequests([{ ...data[0]!, amount: 1000.1 }, { ...data[1]!, amount: 1000.2 }], { amount: ["1000"] }).length, 2, "amount choices group the same displayed whole-rupee value without changing stored amounts");
console.log("cn-request-filters.test.tsx — all assertions passed");

// Under Process has one review action, with its status/filter preserved in CN Update for every viewer.
for (const role of [Role.SUPER_ADMIN, Role.CUSTOM_ADMIN, Role.SALES_OFFICER, Role.REGIONAL_MANAGER]) {
  hooks.length = 0; allowActions = role !== Role.CUSTOM_ADMIN;
  rows = [{ ...data[0]!, status: "UNDER_PROCESS", processingReview: { kind: "RATE_CONFIRMATION", status: "CONFIRMED" } }];
  render(role); navs[0]!.onChange("accepted"); render(role); navs[1]!.onChange("under-process"); html = render(role);
  assert.ok(!headers.some(h => h.label === label("cn_requests.field.status")), `${role}: no separate CN Status column`);
  assert.equal((html.match(/>Price Confirmed<\/button>/g) ?? []).length, 1, `${role}: one review button per row`);
  assert.ok(html.includes("text-success") && !html.includes("Open Review"), "confirmed status is inside a green button");
  const update = headers.find(h => h.options.some(o => o.value === "RATE_CONFIRMATION:CONFIRMED"))!;
  assert.ok(update?.searchable, "CN Update preserves the searchable status filter");
  update.onChange(["RATE_CONFIRMATION:CONFIRMED"]); html = render(role);
  same(shown(html), ["d1"], "status filtering still returns the matching row");
  clicks["Price Confirmed"]!(); html = render(role);
  assert.ok(html.includes('data-open-review="r1"'), "Open Review opens the same request");
  const handler = role === Role.SUPER_ADMIN;
  assert.ok(html.includes(`data-can-handle="${handler}"`), "read-only viewers retain history access without gaining decision permissions");
}
console.log("Under Process combined review column, status filter and role-safe access passed");

// Both review branches color their actual outcome; an unanswered review remains neutral.
for (const kind of ["RATE_CONFIRMATION", "CN_APPROVAL"]) {
  hooks.length = 0; allowActions = true;
  rows = [{ ...data[0]!, status: "UNDER_PROCESS", processingReview: { kind, status: "REJECTED" } }];
  render(); navs[0]!.onChange("accepted"); render(); navs[1]!.onChange("under-process"); html = render();
  const rejectedLabel = kind === "RATE_CONFIRMATION" ? "Rate Confirmation Rejected" : "CN Approval Rejected";
  assert.ok(html.includes(`data-variant="destructive">${rejectedLabel}</button>`), "rejected outcome is the red button label");
  clicks[rejectedLabel]!(); html = render();
  assert.ok(html.includes('data-open-review="r1"'), "red outcome button still opens the review");
}
console.log("CN Update outcome button labels, green confirmation and red rejection passed");
