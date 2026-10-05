/** Sales Officers column + header filter on the Dealer Tags page: server scoping/filtering and the rendered table. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { TestApiError, testLoader } from "./test-loader";

const ctx = (userId: string, role: Role, groupId: string | null): AuthContext => ({ userId, username: userId, role, groupId });
const admin = ctx("admin", Role.SUPER_ADMIN, null);
const rm = ctx("rm", Role.REGIONAL_MANAGER, "team");
const otherRm = ctx("other-rm", Role.REGIONAL_MANAGER, "other");
const so = ctx("so-a", Role.SALES_OFFICER, "team");

// dealerId → current owner (the open DealerAssignment). "orphan" has no current assignment.
const owners = new Map([
  ["alpha", "so-a"], ["gamma", "so-a"], ["beta", "so-b"], ["delta", "rm"], ["outside", "other-so"], ["contested", "other-so"],
]);
// A reassigned dealer whose older assignment to "so-a" was never closed: it still has an OPEN row for an in-scope
// officer, but its current owner (most recent open assignment) is out of scope.
const openAssignments = new Map([["contested", ["so-a", "other-so"]]]);
const dealerRows = [
  ...["alpha", "beta", "contested", "delta", "gamma", "outside"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), isActive: true })),
  { id: "orphan", name: "Orphan", isActive: true },
];
const userNames: Record<string, string> = { "so-a": "Rahul Patidar", "so-b": "Amit Sharma", rm: "Regional Manager", "other-so": "Outside Officer" };
const scopeOf = (c: AuthContext) => c.role === Role.SUPER_ADMIN ? { all: true, ids: [] as string[] }
  : c.userId === "rm" ? { all: false, ids: ["rm", "so-a", "so-b"] }
    : c.userId === "other-rm" ? { all: false, ids: ["other-rm", "other-so"] } : { all: false, ids: [c.userId] };

const prisma = {
  dealer: {
    // Mirrors the scope clause the service sends: any open assignment held by an officer in scope.
    findMany: async ({ where }: { where: { assignments?: { some: { officerId: { in: string[] } } } } }) => {
      const ids = where.assignments?.some.officerId.in;
      return dealerRows.filter((d) => !ids || (openAssignments.get(d.id) ?? [owners.get(d.id) ?? "\u0000"]).some((o) => ids.includes(o)));
    },
  },
  user: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id in userNames).map((id) => ({ id, name: userNames[id] })),
  },
  dealerTagAssignment: { findMany: async () => [] },
};
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/scope": {
    getOfficerScope: async (c: AuthContext) => scopeOf(c),
    getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.filter((id) => owners.has(id)).map((id) => [id, owners.get(id)!])),
    getCurrentManagerId: async () => null,
  },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
  "@/lib/dealer-tags.server": { loadDealerMarkerMap: async () => ({}) },
  "@/lib/audit": { writeAudit: async () => {} },
  "@/features/notifications/service.server": { notifyMany: async () => {}, getSuperAdminIds: async () => [] },
});
const svc = load<typeof import("./service.server")>("src/features/dealer-tags/service.server.ts");
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
// The service runs in the loader's VM realm; normalise so deepEqual compares plain structures.
const plain = async <T,>(work: Promise<T>): Promise<T> => JSON.parse(JSON.stringify(await work));
const listDealers = (c: AuthContext, filter?: { officerIds?: string[] }) => plain(svc.listTagDealers(c, filter));
const listOfficers = (c: AuthContext) => plain(svc.listTagSalesOfficers(c));

async function service() {
  // Test 2 — each dealer carries its existing (current-owner) Sales Officer; none → empty list.
  const all = await listDealers(admin);
  assert.deepEqual(all.find((d) => d.id === "alpha")?.salesOfficers, [{ id: "so-a", name: "Rahul Patidar" }]);
  assert.deepEqual(all.find((d) => d.id === "orphan")?.salesOfficers, [], "no association → empty (rendered as —)");

  // Test 4 — one officer.
  assert.deepEqual(ids(await listDealers(admin, { officerIds: ["so-a"] })), ["alpha", "gamma"]);
  // Test 5 — several officers are OR-ed, never AND-ed.
  assert.deepEqual(ids(await listDealers(admin, { officerIds: ["so-a", "so-b"] })), ["alpha", "beta", "gamma"]);
  // Test 6 — empty / absent filter = All.
  assert.deepEqual(ids(await listDealers(admin, { officerIds: [] })), ids(all));
  assert.deepEqual(ids(await listDealers(admin)), ids(all));

  // Test 8 — Admin filters across every dealer and officer already available to them.
  assert.equal(all.length, 7);
  assert.deepEqual(ids(await listDealers(admin, { officerIds: ["other-so"] })), ["contested", "outside"]);
  assert.deepEqual((await listOfficers(admin)).map((o) => o.id), ["so-b", "other-so", "rm", "so-a"].sort((a, b) => userNames[a].localeCompare(userNames[b])));

  // Test 9 — an RM's options contain only officers inside their existing scope.
  const rmOptions = await listOfficers(rm);
  assert.deepEqual(rmOptions.map((o) => o.id).sort(), ["rm", "so-a", "so-b"]);
  assert.ok(!rmOptions.some((o) => o.id === "other-so"));
  assert.deepEqual((await listOfficers(otherRm)).map((o) => o.id), ["other-so"], "another RM sees only their own scope");

  // Test 10 — an RM cannot reach out-of-scope dealers by manipulating the filter.
  assert.deepEqual(ids(await listDealers(rm)), ["alpha", "beta", "delta", "gamma"], "baseline scope is unchanged (a dealer whose CURRENT owner is out of scope stays hidden)");
  assert.deepEqual(await listDealers(rm, { officerIds: ["other-so"] }), [], "out-of-scope officer matches nothing");
  assert.deepEqual(ids(await listDealers(rm, { officerIds: ["so-a", "other-so"] })), ["alpha", "gamma"], "mixed ids only ever return in-scope dealers");
  assert.deepEqual(await listDealers(rm, { officerIds: ["admin", "unknown"] }), []);
  // Existing scope behaviour for a Sales Officer is unchanged.
  assert.deepEqual(ids(await listDealers(so)), ["alpha", "gamma"]);
}

/* ---------------------------------- rendered page ---------------------------------- */
const tagDealer = (id: string, name: string, officer?: [string, string]) => ({ id, name, isActive: true, tags: [], assignedTags: [], salesOfficers: officer ? [{ id: officer[0], name: officer[1] }] : [] });
const everyone = [tagDealer("alpha", "Alpha", ["so-a", "Rahul Patidar"]), tagDealer("beta", "Beta", ["so-b", "Amit Sharma"]), tagDealer("orphan", "Orphan")];
const filteredRows = [tagDealer("alpha", "Alpha", ["so-a", "Rahul Patidar"]), tagDealer("alpine", "Alpine", ["so-a", "Rahul Patidar"])];
const options = [{ id: "so-a", name: "Rahul Patidar" }, { id: "so-b", name: "Amit Sharma" }];
const queries: string[] = [];
let preset: { search?: string; officerIds?: string[] } = {};
let stateCall = 0;
const pageLoad = testLoader({
  react: { ...React, useState: (initial: unknown) => {
    const index = stateCall++ % 5; // dealerId, tagId, operation, search, officerIds
    if (index === 3 && preset.search !== undefined) return [preset.search, () => {}];
    if (index === 4 && preset.officerIds) return [preset.officerIds, () => {}];
    return [initial, () => {}];
  } },
  "@tanstack/react-query": {
    useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled?: boolean }) => {
      const key = queryKey.join("/");
      queries.push(`${key}${enabled === false ? " (disabled)" : ""}`);
      if (key === "dealer-tags/dealers") return { data: everyone };
      if (key.startsWith("dealer-tags/dealers/by-officer")) return { data: enabled === false ? undefined : filteredRows };
      if (key === "dealer-tags/sales-officers") return { data: options };
      return { data: [] };
    },
    useMutation: () => ({ mutate: () => {}, isPending: false, isSuccess: false }),
    useQueryClient: () => ({ invalidateQueries: async () => {} }),
  },
  "@/lib/api-client": { api: { get: async () => [], post: async () => ({}) } },
  "@/components/layout/page-header": { PageHeader: () => null },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
  "./dealer-tag-requests": { DealerTagRequests: () => null },
});
const { DealerTagsPage } = pageLoad<typeof import("./dealer-tags-page")>("src/features/dealer-tags/dealer-tags-page.tsx");
const filterModule = pageLoad<typeof import("./sales-officer-filter")>("src/features/dealer-tags/sales-officer-filter.tsx");
const render = (role: Role, p: typeof preset = {}) => { preset = p; stateCall = 0; queries.length = 0; return renderToStaticMarkup(<DealerTagsPage role={role} />); };
const heads = (html: string) => [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());
const rowNames = (html: string) => [...html.matchAll(/<tr[^>]*data-dealer-id="([^"]+)"/g)].map((m) => m[1]);

function page() {
  for (const role of [Role.SUPER_ADMIN, Role.REGIONAL_MANAGER]) {
    // Test 1 — the Sales Officers column sits immediately after Dealer (Admin and RM share the page).
    const html = render(role);
    assert.deepEqual(heads(html), ["Dealer", "Sales Officers", "Status", "Assignments"]);
    // Test 3 — the header itself is the filter control.
    assert.ok(/<th[^>]*>\s*<button[^>]*aria-label="Filter by Sales Officers"[^>]*>Sales Officers/.test(html), "the column header is a clickable filter trigger");
    // Test 2 — officers shown per dealer; an unassociated dealer shows the empty marker.
    assert.ok(html.includes("<td class=\"px-3 py-2 align-middle break-words\">Rahul Patidar</td>"));
    assert.ok(html.includes(">Amit Sharma</td>"));
    assert.ok(html.includes(">—</td>"));
    assert.deepEqual(rowNames(html), ["alpha", "beta", "orphan"]);
    // No filter → the filtered query is not issued.
    assert.ok(queries.includes("dealer-tags/dealers/by-officer/ (disabled)"));
  }
  // Tests 4/6/7 — with a filter active the table uses the server-filtered rows, search still narrows them, and the
  // header shows the count plus a clear control.
  let html = render(Role.SUPER_ADMIN, { officerIds: ["so-a"] });
  assert.deepEqual(rowNames(html), ["alpha", "alpine"]);
  assert.ok(html.includes("Sales Officers (1)") && html.includes("Clear Sales Officer filter (1)"));
  html = render(Role.SUPER_ADMIN, { officerIds: ["so-a"], search: "alpi" });
  assert.deepEqual(rowNames(html), ["alpine"], "search works together with the officer filter");
  html = render(Role.SUPER_ADMIN, { search: "bet" });
  assert.deepEqual(rowNames(html), ["beta"], "search alone is unchanged");
  assert.ok(!render(Role.SUPER_ADMIN).includes("Clear Sales Officer filter"), "no clear control without a filter");

  // The filter helpers: toggle adds/removes (multi-select); header label shows the active count.
  const { toggleOfficerId, salesOfficersHeaderLabel } = filterModule;
  assert.equal(JSON.stringify(toggleOfficerId([], "a")), JSON.stringify(["a"]));
  assert.equal(JSON.stringify(toggleOfficerId(["a"], "b")), JSON.stringify(["a", "b"]));
  assert.equal(JSON.stringify(toggleOfficerId(["a", "b"], "a")), JSON.stringify(["b"]));
  assert.equal(salesOfficersHeaderLabel(0), "Sales Officers");
  assert.equal(salesOfficersHeaderLabel(2), "Sales Officers (2)");

  // Test 11 — assignment / revocation workflow untouched: same endpoints, and the dealer picker still uses the
  // unfiltered list rather than the filtered one.
  const source = readFileSync("src/features/dealer-tags/dealer-tags-page.tsx", "utf8");
  assert.ok(source.includes('"/api/dealer-tags/direct" : "/api/dealer-tags/requests"'));
  assert.ok(source.includes("options={(dealers.data ?? []).map((d) => ({ value: d.id, label: d.name }))}"));
  assert.ok(source.includes("const selected = dealers.data?.find((d) => d.id === dealerId);"));
  const route = readFileSync("src/app/api/dealer-tags/dealers/route.ts", "utf8");
  assert.ok(route.includes("requireAuth()") && route.includes("officerIds"), "the filter is read by an authenticated route and applied server-side");
  const permissions = readFileSync("src/features/accounts/route-permissions.ts", "utf8");
  assert.ok(permissions.includes('p === "dealer-tags/sales-officers"'), "the options endpoint is guarded like the dealers endpoint");
}

service().then(() => { page(); console.log("dealer-tags-officer-filter.test.tsx — all assertions passed"); }).catch((error) => { console.error(error); process.exitCode = 1; });
