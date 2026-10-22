/** Retailer Mapping UI: creation validation + retry, review actions, navigation and dealer multi-selection. No application database. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { filterSearchableOptions } from "@/components/ui/searchable-select";

const hooks: unknown[] = [];
let cursor = 0;
const setters: ((v: unknown) => void)[] = [];
const calls: { url: string; body?: unknown }[] = [];
const inputs: Record<string, { value: string; onChange: (e: { target: { value: string } }) => void }> = {};
const buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let selection: { value: string[]; onChange: (v: string[]) => void };
let fail = false, created = false;
const request = { id: "r1", retailerName: "Ram", firmName: "Shop", phone: "0123456789", dealers: [{ id: "d1", name: "Alpha Dealer" }, { id: "d2", name: "Beta Dealer" }], requestedById: "so1", requestedByName: "Officer", requestedByTerritory: "North", createdAt: "2026-10-21T04:00:00Z", status: "PENDING", decidedByName: null, decidedAt: null, rejectionReason: null, retailerId: null };
let requestRows = [request];
const label = (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k;
const text = (node: React.ReactNode): string => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : React.isValidElement<{ children?: React.ReactNode }>(node) ? text(node.props.children) : "";
const state = (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; const set = (v: unknown) => { hooks[i] = typeof v === "function" ? (v as (old: unknown) => unknown)(hooks[i]) : v; }; setters[i] = set; return [hooks[i], set]; };
const overrides = {
  react: { ...React, useState: state },
  "@/features/labels/label-ui": { useLabel: label },
  "@/features/accounts/permission-ui": { useAdminPermission: () => true },
  "@/lib/api-client": { api: { get: async (url: string) => { calls.push({ url }); return []; }, post: async (url: string, body: unknown) => { calls.push({ url, body }); if (fail) throw new Error("Connection interrupted"); return {}; } } },
  "@tanstack/react-query": {
    useQuery: (o: { queryKey: string[]; queryFn: () => unknown; enabled?: boolean }) => { if (o.enabled !== false) void o.queryFn(); return { data: o.queryKey[0] === "retailer-dealer-choices" ? [{ id: "d1", name: "Alpha Dealer" }, { id: "d2", name: "Beta Dealer" }] : o.queryKey[0] === "retailer-requests" ? requestRows : o.queryKey[0] === "retailers" ? [{ id: "retailer1", name: "Approved Retailer", firmName: "Approved Firm", phone: "0123456789", dealers: request.dealers, createdAt: request.createdAt }] : [], isLoading: false, isError: false, refetch: async () => undefined }; },
    useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: () => void; onError?: (e: Error) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then(() => o.onSuccess?.(), (e: Error) => o.onError?.(e)); } }),
  },
  "@/components/ui/input": { Input: (p: { id: string; value: string; onChange: (e: { target: { value: string } }) => void }) => { inputs[p.id] = p; return <input id={p.id} value={p.value} readOnly />; } },
  "@/components/ui/textarea": { Textarea: (p: { id: string; value: string; onChange: (e: { target: { value: string } }) => void }) => { inputs[p.id] = p; return <textarea value={p.value} readOnly />; } },
  "@/components/ui/searchable-multi-select": { SearchableMultiSelect: (p: typeof selection) => { selection = p; return <div data-multiselect />; } },
  "@/components/ui/button": { Button: (p: (typeof buttons)[number]) => { buttons.push(p); return <button disabled={p.disabled}>{p.children}</button>; } },
  "@/components/ui/dialog": { Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
};
const ui = testLoader(overrides)<typeof import("./retailer-mapping")>("src/features/party-planning/retailer-mapping.tsx");
const render = (element: React.ReactElement) => { cursor = 0; buttons.length = 0; return renderToStaticMarkup(element); };
const button = (name: string) => buttons.find((p) => text(p.children) === name)!;
const tick = () => new Promise((r) => setImmediate(r));
async function main() {
  const form = <ui.AddRetailerDialog onClose={() => undefined} onCreated={() => { created = true; }} />;
  let html = render(form);
  assert.ok(html.includes("Add Retailer") && html.includes("Retailer Name") && html.includes("Firm Name") && html.includes("Phone Number") && html.includes("data-multiselect"));
  button("Submit Request").onClick!(); html = render(form);
  assert.ok(html.includes("Enter the Retailer Name."));
  inputs["retailer-name"]!.onChange({ target: { value: "Ram" } }); inputs["retailer-firm"]!.onChange({ target: { value: "Shop" } }); inputs["retailer-phone"]!.onChange({ target: { value: "1234" } }); selection!.onChange(["d1", "d2"]); render(form);
  button("Submit Request").onClick!(); html = render(form);
  assert.ok(html.includes("exactly 10 digits") && !calls.some((c) => c.body), "invalid phone never submits");
  inputs["retailer-phone"]!.onChange({ target: { value: "0123456789" } }); render(form); fail = true;
  button("Submit Request").onClick!(); await tick(); html = render(form);
  assert.ok(html.includes("Connection interrupted") && inputs["retailer-name"]!.value === "Ram" && selection!.value.length === 2, "failed submission keeps all form values");
  const first = calls.find((c) => c.body)!.body as { submissionKey: string; dealerIds: string[]; phone: string };
  fail = false; button("Submit Request").onClick!(); await tick();
  const last = calls.filter((c) => c.body).at(-1)!.body as typeof first;
  assert.equal(last.submissionKey, first.submissionKey, "retry uses the same submission key");
  assert.deepEqual(last.dealerIds, ["d1", "d2"]); assert.equal(last.phone, "0123456789"); assert.equal(created, true);
  hooks.length = 0; calls.length = 0;
  const review = <ui.RetailerRequestsTab />; html = render(review);
  assert.ok(calls.some((c) => c.url.includes("view=pending")) && html.includes("Alpha Dealer") && html.includes("Beta Dealer") && html.includes("North"));
  button("Reject").onClick!(); html = render(review);
  assert.equal(button("Reject").disabled, false); // row action is still available; the confirmation itself is disabled below.
  assert.ok(buttons.filter((b) => text(b.children) === "Reject").some((b) => b.disabled), "rejection confirmation requires a reason");
  inputs["retailer-rejection"]!.onChange({ target: { value: "Incorrect retailer information" } }); render(review);
  buttons.filter((b) => text(b.children) === "Reject").at(-1)!.onClick!(); await tick();
  const decision = calls.find((c) => c.url.endsWith("/r1/decide"))!;
  assert.equal(JSON.stringify(decision.body), JSON.stringify({ action: "reject", reason: "Incorrect retailer information" }));

  // The mapping switch separates pending/rejected requests from approved retailer entities.
  hooks.length = 0; calls.length = 0;
  requestRows = [request, { ...request, id: "r2", retailerName: "Rejected Retailer", status: "REJECTED" }, { ...request, id: "r3", retailerName: "Approved Request", status: "APPROVED" }];
  const mapping = <ui.RetailerMappingTab role={Role.SALES_OFFICER} addOpen={false} onAddClose={() => undefined} />;
  html = render(mapping);
  assert.match(html, /aria-pressed="true"[^>]*>Requested/); assert.match(html, /aria-pressed="false"[^>]*>Approved/);
  assert.ok(html.includes("Rejected Retailer") && html.includes("Ram") && !html.includes("Approved Request") && !html.includes("Approved Firm"));
  assert.ok(calls.some((c) => c.url.includes("scope=mine")) && !calls.some((c) => c.url === "/api/territory-mapping/retailers"), "Requested only fetches requests");
  assert.ok(!button("Refresh") && !button("Add Retailer"), "mapping content has no extra action row");
  setters[1]!("approved"); calls.length = 0; html = render(mapping);
  assert.match(html, /aria-pressed="true"[^>]*>Approved/);
  assert.ok(html.includes("Approved Firm") && !html.includes("Rejected Retailer") && !html.includes("Request Status"));
  assert.ok(calls.some((c) => c.url === "/api/territory-mapping/retailers") && !calls.some((c) => c.url.includes("scope=mine")), "Approved only fetches approved retailers");
  hooks.length = 0; calls.length = 0; html = render(<ui.RetailerMappingTab role={Role.SUPER_ADMIN} addOpen={false} onAddClose={() => undefined} />);
  assert.ok(html.includes("Approved Firm") && !calls.some((c) => c.url.includes("scope=mine")), "admin approved listing does not fetch an owner-only endpoint");
  requestRows = [request];

  // Main navigation: no retailer endpoint is loaded on Existing Markets; Request defaults to the existing Party Request screen.
  const navs: { onChange: (key: string) => void; tabs: { key: string; label: string }[] }[] = [];
  const root = testLoader({ ...overrides,
    "./retailer-mapping": { RetailerMappingTab: ({ addOpen }: { addOpen: boolean }) => <div>Retailer Mapping Content{addOpen && <span>Add Retailer Dialog Open</span>}</div>, RetailerRequestsTab: () => <div>Retailer Request Content</div> },
    "./dealer-status-requests": { StatusRequestCell: () => null, StatusRequestsTab: () => <div>Party Request Content</div> },
    "@/components/ui/underline-tabs": { UnderlineTabs: (p: (typeof navs)[number]) => { navs.push(p); return <div />; } },
    "@/components/layout/page-header": { PageHeader: () => null },
    "@/components/ui/searchable-select": { SearchableSelect: () => null }, "@/components/ui/select": { NativeSelect: () => null },
    "@tanstack/react-query": { ...overrides["@tanstack/react-query"], useQuery: () => ({ data: undefined, isLoading: false }) },
  })<typeof import("./territory-mapping-page")>("src/features/party-planning/territory-mapping-page.tsx");
  hooks.length = 0; const page = <root.TerritoryMappingPage role={Role.SUPER_ADMIN} />; render(page);
  assert.ok(navs[0]!.tabs.some((t) => t.key === "retailer"));
  navs[0]!.onChange("request"); html = render(page);
  assert.ok(html.includes("Party Request Content") && html.includes("Retailer Request"), "Request defaults to Party Request");
  setters[2]!("retailer"); html = render(page);
  assert.ok(html.includes("Retailer Request Content") && !html.includes("Party Request Content"), "separate review content");
  navs.at(-1)!.onChange("retailer"); html = render(page); assert.ok(html.includes("Retailer Mapping Content"));
  assert.ok(!button("Add Retailer"), "admins do not receive the owner-only Add Retailer control");
  hooks.length = 0; navs.length = 0; const rmPage = <root.TerritoryMappingPage role={Role.REGIONAL_MANAGER} />; render(rmPage);
  assert.ok(navs[0]!.tabs.some((t) => t.key === "retailer") && !navs[0]!.tabs.some((t) => t.key === "request"), "RM can map retailers without receiving administrative review controls");
  assert.ok(!button("Add Retailer"), "Add Retailer is hidden outside the Retailer Mapping tab");
  navs[0]!.onChange("retailer"); html = render(rmPage);
  assert.ok(button("Add Retailer") && !button("Refresh"));
  button("Add Retailer").onClick!(); html = render(rmPage);
  assert.ok(html.includes("Add Retailer Dialog Open"), "tab-row action opens the mapping form");
  assert.deepEqual(filterSearchableOptions([{ value: "a", label: "Alpha Dealer" }, { value: "b", label: "Beta Dealer" }], "aLPha").map((o) => o.value), ["a"]);
  console.log("retailer-ui.test.tsx — form, retry, validation, review and navigation passed");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
