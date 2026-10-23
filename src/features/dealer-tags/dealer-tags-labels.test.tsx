/**
 * Dealer Tags ↔ Edit Labels: every user-facing word on /dealer-tags (Admin / RM / SO) and its server messages come from the label store.
 *   npx tsx src/features/dealer-tags/dealer-tags-labels.test.tsx
 * Customised labels must change the DISPLAYED text; internal values (ADD / REVOKE, ids, statuses) and tag data must not move.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, labelCatalog, labelMeta, type LabelKey } from "@/features/labels/labels";
import type { AuthContext } from "@/lib/http";
import { NAV_ITEMS } from "@/features/navigation/nav";
import { TestApiError, testLoader } from "./test-loader";

let overrides: Record<string, string> = {};
const text = (k: LabelKey) => overrides[k] ?? DEFAULT_LABELS[k];
const TAG_KEYS = (Object.keys(DEFAULT_LABELS) as LabelKey[]).filter((k) => k.startsWith("dealer_tags."));
const read = (f: string) => readFileSync(f, "utf8");
const SRC = { page: read("src/features/dealer-tags/dealer-tags-page.tsx"), requests: read("src/features/dealer-tags/dealer-tag-requests.tsx"), filter: read("src/features/dealer-tags/sales-officer-filter.tsx"), service: read("src/features/dealer-tags/service.server.ts"), shell: read("src/components/layout/app-shell.tsx") };
let n = 0; const ok = (m: string) => { n++; console.log(`  ok - ${m}`); };

/* ---------------------------------- rendering with a live label map ---------------------------------- */
const labelUi = {
  useLabel: (k: LabelKey) => text(k),
  Th: ({ labelKey }: { labelKey: LabelKey }) => <th>{text(labelKey)}</th>,
};
const tagDealer = { id: "d1", name: "Alpha Traders", isActive: false, tags: [], assignedTags: [{ id: "t1", name: "Legal", marker: "LG", markerType: "TEXT", isActive: false }], salesOfficers: [{ id: "so1", name: "Rahul" }] };
const request = (status: string, canAct: boolean) => ({ id: "r1", dealerId: "d1", dealerName: "Alpha Traders", tagId: "t1", tagName: "Legal", marker: "LG", operation: "REVOKE", status, requestedById: "so1", requestedByName: "Rahul", createdAt: "2026-10-01T00:00:00Z", canAct, history: [] });
let requests: unknown[] = [];
const common = {
  "@/features/labels/label-ui": labelUi,
  "@tanstack/react-query": {
    useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey.join("/") === "dealer-tags/requests" ? requests : queryKey.join("/") === "dealer-tags/master" ? [{ id: "t1", name: "Legal", marker: "LG", markerType: "TEXT", isActive: true }, { id: "t2", name: "Old", marker: "OL", markerType: "TEXT", isActive: false }] : queryKey.join("/") === "dealer-tags/sales-officers" ? [{ id: "so1", name: "Rahul" }] : [tagDealer], error: null }),
    useMutation: () => ({ mutate: () => {}, isPending: false, isSuccess: true, error: null }),
    useQueryClient: () => ({ invalidateQueries: async () => {} }),
  },
  "@/lib/api-client": { api: { get: async () => [], post: async () => ({}) } },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
  "@/components/layout/page-header": { PageHeader: ({ title, subtitle, crumbs }: { title: string; subtitle: string; crumbs: { label: string }[] }) => <header><h1>{title}</h1><p>{subtitle}</p><nav>{crumbs.map((c) => c.label).join("/")}</nav></header> },
  "@/features/planning/status-badge": { StatusBadge: ({ status }: { status: string }) => <>{status}</> },
  "@/components/ui/dialog": { Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
};
const load = testLoader({ ...common, react: { ...React, useState: (i: unknown) => [i, () => {}] } });
const { DealerTagsPage } = load<typeof import("./dealer-tags-page")>("src/features/dealer-tags/dealer-tags-page.tsx");
// the requests table with its reject dialog open (state seeded: rejectId set)
const loadOpen = testLoader({ ...common, react: { ...React, useState: (i: unknown) => [typeof i === "string" || i === null ? (i === null ? "r1" : i) : i, () => {}] } });
const { DealerTagRequests } = loadOpen<typeof import("./dealer-tag-requests")>("src/features/dealer-tags/dealer-tag-requests.tsx");
const page = (role: Role) => renderToStaticMarkup(<DealerTagsPage role={role} />);

async function main() {
  // 1. Registry: every Dealer Tags key is grouped under the "Dealer Tags" module, is used, and every used key exists.
  assert.ok(TAG_KEYS.length >= 60);
  for (const k of TAG_KEYS) assert.equal(labelMeta(k).module, "Dealer Tags", k);
  assert.equal(new Set(labelCatalog(undefined).filter((e) => e.module === "Dealer Tags").map((e) => e.key)).size, TAG_KEYS.length, "all keys appear on the Labels management page");
  const used = new Set<string>();
  for (const src of [SRC.page, SRC.requests, SRC.filter, SRC.service, read("src/features/navigation/nav.ts"), read("src/features/dealer-tags/tag-master-page.tsx")]) for (const m of src.matchAll(/["'](dealer_tags\.[a-z_.]+)["']/g)) used.add(m[1]!);
  for (const m of SRC.service.matchAll(/L\["(dealer_tags\.[a-z_.]+)"\]/g)) used.add(m[1]!);
  for (const k of used) assert.ok(k in DEFAULT_LABELS, `${k} is registered`);
  for (const k of TAG_KEYS) assert.ok(used.has(k), `${k} is used`);
  ok(`${TAG_KEYS.length} keys: registered under the Dealer Tags module, none unused, none missing`);

  // 2. Defaults keep today's wording on every role.
  overrides = {};
  for (const role of [Role.SUPER_ADMIN, Role.REGIONAL_MANAGER, Role.SALES_OFFICER]) {
    const h = page(role);
    for (const w of ["Dealer Tags", "Dealer *", "Action *", "Tag *", "Add Tag", "Revoke Tag", "Select a tag…", "Search dealers…", "Sales Officers", "Status", "Assignments", "Dealer Tag requests", "No tag requests.", "Inactive", "Legal (Inactive tag)"]) assert.ok(h.includes(w.replace("Legal (Inactive tag)", "Legal (Inactive tag)")), `${role}: ${w}`);
  }
  assert.ok(page(Role.SUPER_ADMIN).includes("Direct Admin assignment/revocation takes effect immediately.") && page(Role.SUPER_ADMIN).includes("Assign Tag") && page(Role.SUPER_ADMIN).includes("Dealer tag updated."));
  const so = page(Role.SALES_OFFICER);
  assert.ok(so.includes("Request an addition or revocation. Existing markers change only after final approval.") && so.includes("Request Tag") && so.includes("Request submitted for approval."));
  ok("default wording is unchanged for Admin, RM and SO");

  // 3. Customising labels changes the displayed text (title, breadcrumb, fields, options, placeholders, buttons, headings, status, messages, search).
  overrides = {
    "dealer_tags.page.title": "Dealer Markers", "dealer_tags.crumb.dealer_tags": "Markers", "dealer_tags.page.subtitle_admin": "Admins act at once.", "dealer_tags.page.subtitle_user": "Ask for a change.",
    "dealer_tags.field.dealer": "Party pick", "dealer_tags.field.action": "Operation", "dealer_tags.field.tag": "Marker pick",
    "dealer_tags.action.add_tag": "Attach", "dealer_tags.action.revoke_tag": "Remove", "dealer_tags.tag.placeholder": "Pick a marker…", "dealer_tags.tag.inactive_suffix": " [off]", "dealer_tags.tag.inactive_assigned": " [off tag]",
    "dealer_tags.button.assign": "Attach now", "dealer_tags.button.revoke": "Remove now", "dealer_tags.button.request": "Ask to attach", "dealer_tags.button.request_revoke": "Ask to remove",
    "dealer_tags.msg.updated": "Saved!", "dealer_tags.msg.submitted": "Sent!", "dealer_tags.search.placeholder": "Find party…", "dealer_tags.status.active": "Live", "dealer_tags.status.inactive": "Dormant",
    "dealer_tags.col.dealer": "Party", "dealer_tags.col.sales_officers": "Owners", "dealer_tags.col.status": "State", "dealer_tags.col.assignments": "Markers on it",
    "dealer_tags.requests.title": "Marker requests", "dealer_tags.requests.empty": "Nothing here.",
  };
  const a = page(Role.SUPER_ADMIN);
  for (const w of ["<h1>Dealer Markers</h1>", "<nav>Markers</nav>", "Admins act at once.", ">Party pick<", ">Operation<", ">Marker pick<", ">Attach</option>", ">Remove</option>", "Pick a marker…", "Attach now", "Saved!", 'placeholder="Find party…"', "<th>Party</th>", "<th>State</th>", "<th>Markers on it</th>", ">Dormant<", "Legal [off tag]", "Marker requests", "Nothing here."]) assert.ok(a.includes(w), `customised: ${w}`);
  for (const w of ["Dealer Tags", "Dealer *", "Assign Tag", "Select a tag…", "Search dealers…", "Dealer Tag requests", "No tag requests.", "Assignments"]) assert.ok(!a.includes(w), `old text gone: ${w}`);
  assert.ok(/aria-label="Filter by Sales Officers"[^>]*>Owners/.test(a), "the Sales Officers filter header follows its label");
  const s2 = page(Role.SALES_OFFICER);
  assert.ok(s2.includes("Ask for a change.") && s2.includes("Ask to attach") && s2.includes("Sent!"));
  // Data and internal values are untouched by labels: option VALUES stay ADD / REVOKE; tag / dealer / officer names are data.
  assert.ok(a.includes('value="ADD"') && a.includes('value="REVOKE"') && a.includes("Alpha Traders") && a.includes("Rahul") && a.includes("Legal"), "values and database content unchanged");
  assert.ok(a.includes("Old (OL) [off]") === false, "inactive tag stays excluded from ADD choices");
  ok("customised titles, breadcrumb, fields, options, placeholders, buttons, headings, statuses and messages are what is displayed");

  // 4. Requests table + reject dialog.
  requests = [request("PENDING_RM", true), request("PENDING_ADMIN", true)];
  overrides = { "dealer_tags.requests.title": "Marker requests", "dealer_tags.requests.col.requested_by": "Asked by", "dealer_tags.requests.approve_rm": "RM OK", "dealer_tags.requests.approve_final": "Admin OK", "dealer_tags.requests.reject": "Decline", "dealer_tags.requests.view_history": "Trail", "dealer_tags.action.revoke_tag": "Remove",
    "dealer_tags.dialog.reject_title": "Decline request", "dealer_tags.dialog.reject_description": "Say why.", "dealer_tags.dialog.reason_aria": "Why", "dealer_tags.dialog.cancel": "Back" };
  let r = renderToStaticMarkup(<DealerTagRequests />);
  for (const w of ["Marker requests", "Asked by", "RM OK", "Admin OK", "Decline", "Trail", "Remove", "Decline request", "Say why.", 'aria-label="Why"', "Back"]) assert.ok(r.includes(w), `requests: ${w}`);
  assert.ok(!r.includes("RM Approve") && !r.includes("Final Approve") && !r.includes("View history") && !r.includes("Reject Tag Request"));
  requests = []; overrides = { "dealer_tags.requests.empty": "None yet.", "dealer_tags.requests.empty_actionable": "Nothing to act on." };
  assert.ok(renderToStaticMarkup(<DealerTagRequests />).includes("None yet.") && renderToStaticMarkup(<DealerTagRequests pendingOnly />).includes("Nothing to act on."));
  overrides = {}; requests = [request("PENDING_RM", true)];
  r = renderToStaticMarkup(<DealerTagRequests />); assert.ok(r.includes("RM Approve") && r.includes("Reject") && r.includes("Reject Tag Request") && r.includes("Revoke Tag"), "defaults");
  ok("requests table, actions, empty states and the reject dialog follow the labels");

  // 5. Server messages: validation / permission errors are resolved through the label store (and default to today's text).
  const svcLoad = testLoader({
    "@/lib/prisma": { prisma: {} }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => {} },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }), getCurrentOwnerByDealer: async () => new Map(), getCurrentManagerId: async () => null },
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() }, "@/lib/dealer-tags.server": { loadDealerMarkerMap: async () => ({}) },
    "@/features/notifications/service.server": { notifyMany: async () => {}, getSuperAdminIds: async () => [] },
    "@/features/labels/service.server": { getResolvedLabels: async () => ({ ...DEFAULT_LABELS, ...overrides }) },
  });
  const svc = svcLoad<typeof import("./service.server")>("src/features/dealer-tags/service.server.ts");
  const ctx = (role: Role): AuthContext => ({ userId: "u", username: "u", role, groupId: "g" }) as AuthContext;
  const msg = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return `${(e as TestApiError).status}:${(e as Error).message}`; } };
  overrides = {};
  assert.equal(await msg(svc.directTag(ctx(Role.SALES_OFFICER), {})), "403:Only Super Admin can manage tags or directly assign/revoke them.");
  assert.equal(await msg(svc.requestTag(ctx(Role.SUPER_ADMIN), {})), "403:Use the separate Admin direct action.");
  assert.equal(await msg(svc.decideTagRequest(ctx(Role.SUPER_ADMIN), "x", { action: "reject" })), "422:A reason is required to reject a tag request.");
  assert.equal(await msg(svc.decideTagRequest(ctx(Role.SALES_OFFICER), "x", { action: "approve" })), "403:Only the applicable RM or Super Admin can decide requests.");
  overrides = { "dealer_tags.error.admin_only": "Admins only.", "dealer_tags.error.use_direct": "Admins act directly.", "dealer_tags.error.reason_required": "Give a reason.", "dealer_tags.error.decide_forbidden": "Not yours to decide." };
  assert.equal(await msg(svc.directTag(ctx(Role.SALES_OFFICER), {})), "403:Admins only.", "saved label changes apply on the next request without a deployment");
  assert.equal(await msg(svc.requestTag(ctx(Role.SUPER_ADMIN), {})), "403:Admins act directly.");
  assert.equal(await msg(svc.decideTagRequest(ctx(Role.SUPER_ADMIN), "x", { action: "reject" })), "422:Give a reason.");
  assert.equal(await msg(svc.decideTagRequest(ctx(Role.SALES_OFFICER), "x", { action: "approve" })), "403:Not yours to decide.");
  ok("server permission / validation messages resolve through the label store, with identical status codes");
  overrides = {};

  // 6. Wiring: sidebar, breadcrumb, Th headings (inline Edit Labels), no leftover literals.
  const item = NAV_ITEMS.find((i) => i.href === "/dealer-tags")!;
  assert.equal(item.labelKey, "dealer_tags.nav.sidebar"); assert.equal(item.label, "Dealer Tags"); assert.equal(DEFAULT_LABELS["dealer_tags.nav.sidebar"], "Dealer Tags");
  assert.ok(SRC.shell.includes("<NavText item={item} />") && SRC.shell.includes("useLabel(item.labelKey"), "the sidebar renders the editable label");
  assert.ok((SRC.page.match(/<Th labelKey=/g) ?? []).length === 3 && (SRC.requests.match(/<Th labelKey=/g) ?? []).length === 7, "table headings are inline-editable <Th> label headers");
  assert.ok(SRC.page.includes("crumbs={[{ label: L.crumb }]}"));
  for (const lit of ['"Select a tag…"', '"Assign Tag"', '"Request Revoke"', '"Dealer updated', ">Reject<", ">Cancel<", "No Sales Officers", '"Filter by Sales Officers"']) assert.ok(![SRC.page, SRC.requests].some((s) => s.includes(lit)) && !(lit.includes("Sales Officers") && SRC.filter.includes(lit)), `no literal ${lit}`);
  for (const lit of ['ApiError(403, "', 'ApiError(404, "', 'ApiError(409, "', 'ApiError(422, "']) assert.ok(!SRC.service.split("\n").some((l) => l.includes(lit) && !l.includes("Tag Master")), `server messages use labels (${lit})`);
  // Behaviour pins: ids / operations / endpoints.
  assert.ok(SRC.page.includes("{ dealerId, tagId, operation }") && SRC.page.includes('"/api/dealer-tags/direct" : "/api/dealer-tags/requests"') && SRC.page.includes("<SearchableSelect") && SRC.requests.includes('action: "approve"') && SRC.requests.includes('/decide'));
  ok("sidebar, breadcrumb, headings and server messages are wired to labels; behaviour pins unchanged");
  console.log(`dealer-tags-labels.test.tsx — ${n} groups passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
