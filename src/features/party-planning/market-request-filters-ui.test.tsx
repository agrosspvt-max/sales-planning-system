/** Vacant Market requests: State dropdown + searchable District / Requested By column filters (the real AddMarket component, mocked data). No DB / browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { readFileSync } from "node:fs";

const hooks: unknown[] = [];
let cursor = 0;
const urls: string[] = [];
type Header = { label: string; options: { value: string; label: string }[]; selected: string[]; onChange: (n: string[]) => void; searchable?: boolean };
let headers: Header[] = [];
let states: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; ariaLabel: string }[] = [];
const clicks: Record<string, () => void> = {};
let list: Record<string, unknown>;
const req = (id: string, extra: Record<string, unknown> = {}) => ({ requesterTerritory: "Korba", id, marketName: `Market ${id}`, potential: "A", numberOfParties: 2, status: "PENDING_ADMIN", requesterName: "X", createdAt: "2026-10-01T00:00:00Z", rmDecidedByName: null, rmDecidedAt: null, adminDecidedByName: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null, districtId: "d1", districtName: "Balod", ...extra });
const FULL = { items: [req("1"), req("2")], states: [{ id: "s1", name: "State A" }, { id: "s2", name: "State B" }], districts: [{ id: "d1", name: "Balod" }, { id: "d2", name: "Durg" }], requesters: [{ id: "u1", name: "Chittranjan", territory: "Korba" }, { id: "u2", name: "Anil", territory: null }], applied: { stateId: "", districtIds: [], requesterIds: [] } };

const load = testLoader({
  react: { ...React,
    useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; },
    useEffect: (fn: () => void) => fn(),
  },
  "@/features/labels/label-ui": { useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@/components/layout/page-header": { PageHeader: () => null },
  "./party-planning-page": { PartyPlanModeLinks: () => null },
  "@tanstack/react-query": {
    keepPreviousData: undefined,
    useQuery: (o: { queryKey: unknown[]; queryFn: () => unknown; enabled?: boolean }) => { if (o.enabled === false) return { data: undefined, isLoading: false }; if (o.queryKey[0] === "market-requests") { void o.queryFn(); return { data: list, isLoading: false }; } return { data: undefined, isLoading: false }; },
    useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useMutation: () => ({ isPending: false, mutate: () => undefined }),
  },
  "@/lib/api-client": { api: { get: async (u: string) => { urls.push(u); return {}; } } },
  "@/components/ui/column-filter-header": { ColumnFilterHeader: (p: Header) => { headers.push(p); return <th data-filter={p.label}>{p.label}</th>; } },
  "@/components/ui/searchable-select": { SearchableSelect: (p: (typeof states)[number]) => { states.push(p); return <div data-searchable />; } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void }) => { if (typeof p.children === "string") clicks[p.children] = p.onClick!; return <button>{p.children}</button>; } },
});
const { AddMarket } = load("src/features/party-planning/territory-mapping-page.tsx") as { AddMarket: React.ComponentType<{ role: Role }> };
const render = (role = Role.SUPER_ADMIN) => { cursor = 0; headers = []; states = []; const h = renderToStaticMarkup(<AddMarket role={role} />); hooks.length = cursor; return h; };
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const last = () => decodeURIComponent(urls[urls.length - 1]!);

list = FULL;
let html = render();
same(states[0]!.options.map((o) => o.label), ["All States", "State A", "State B"], "a searchable State dropdown defaulting to All States");
assert.equal(states[0]!.value, "");
same(headers.map((h) => [h.label, h.searchable]), [["District", true], ["Requested by", true]], "District and Requested By are searchable column filters");
same(headers[0]!.options.map((o) => o.label), ["Balod", "Durg"]);
assert.ok(html.includes('data-testid="market-filters"') && html.includes("2 markets"));
assert.ok(!html.includes("Clear filters"), "no Clear while nothing is filtered");

// Selecting a State is sent to the server (the parent filter) and resets nothing it should keep.
list = { ...FULL, applied: { stateId: "s1", districtIds: [], requesterIds: [] } }; // what the server echoes back
states[0]!.onChange("s1"); html = render();
assert.ok(last().includes("stateId=s1"), "the State goes to the server");
assert.ok(html.includes("Clear filters"), "a visible way back to the authorized view");
// District + requester selections are sent as repeated, id-based params (never names).
list = { ...FULL, applied: { stateId: "s1", districtIds: ["d1", "d2"], requesterIds: ["u1"] } };
headers[0]!.onChange(["d1", "d2"]); headers[1]!.onChange(["u1"]); html = render();
assert.ok(/stateId=s1/.test(last()) && /districtId=d1&districtId=d2/.test(last()) && /requesterId=u1/.test(last()), "State AND District(s) AND Requester(s), by id");
same(headers[0]!.selected, ["d1", "d2"]);
// Server reconciliation: choices that stopped being valid (State / tab change) are dropped, valid ones kept — no invisible stale filter.
list = { ...FULL, districts: [{ id: "d2", name: "Durg" }], applied: { stateId: "s1", districtIds: ["d2"], requesterIds: [] } };
render(); html = render();
same([headers[0]!.selected, headers[1]!.selected], [["d2"], []], "invalid selections removed, valid kept");
// Nothing matches → a clear empty state; Clear restores the unfiltered view.
list = { ...FULL, items: [], applied: { stateId: "s1", districtIds: ["d2"], requesterIds: [] } };
html = render();
assert.ok(html.includes("No matching markets") && html.includes("0 markets"), "filtered + nothing → No matching markets");
clicks["Clear filters"]!(); list = FULL; html = render();
assert.ok(/view=review$/.test(last()) && !html.includes("No matching markets"), "Clear filters restores the authorized view");
// Unfiltered empty keeps its own message.
list = { ...FULL, items: [] }; assert.ok(render().includes("No requests here."), "no filters + no rows → the original empty text");

// The column-filter component itself: search box narrows choices, never creates values (static wiring).
const cf = readFileSync("src/components/ui/column-filter-header.tsx", "utf8");
assert.ok(cf.includes("o.secondary") && cf.includes("filter-secondary"), "options can show a muted second line that is searchable too");
assert.ok(cf.includes("searchable") && cf.includes("filter-search") && cf.includes("filter-no-match") && cf.includes("stopPropagation"), "search box inside the popup, with a no-match state");
assert.ok(cf.includes("onChange(toggleFilterValue(selected, o.value))") && !cf.includes("onChange([query"), "only existing options can be selected");
// Requested by: territory first (main), the requester's name below it (muted); missing territory has a clear fallback; filter options use the same two lines, identity = user id.
list = { ...FULL, items: [req("1"), req("2", { requesterName: "Anil", requesterTerritory: null })] };
html = render();
assert.ok(/data-testid="requested-by"><div class="font-medium leading-tight"><span[^>]*>Korba<\/span><\/div><div class="text-xs leading-tight text-muted-foreground">X<\/div>/.test(html), "territory above the name");
assert.ok(/No territory assigned<\/span><\/div><div[^>]*>Anil</.test(html), "fallback above the name when no territory is recorded");
same(headers[1]!.options, [{ value: "u1", label: "Korba", secondary: "Chittranjan" }, { value: "u2", label: "No territory assigned", secondary: "Anil" }], "two-line options keyed by user id");
import { filterColumnOptions } from "@/components/ui/column-filter-header";
const opts = [{ value: "u1", label: "Korba", secondary: "Chittranjan" }, { value: "u2", label: "Raigarh", secondary: "Chittranjan" }, { value: "u3", label: "Raigarh", secondary: "Anil" }];
same(filterColumnOptions(opts, "RAIG").map((o) => o.value), ["u2", "u3"], "search by territory (case-insensitive, partial); same-territory requesters stay separate");
same(filterColumnOptions(opts, "chittra").map((o) => o.value), ["u1", "u2"], "search by requester name");
same(filterColumnOptions(opts, "zzz"), [], "no match → nothing (never a new value)");
same(filterColumnOptions(opts, "  ").map((o) => o.value), ["u1", "u2", "u3"]);
console.log("market-request-filters-ui.test.tsx — all assertions passed");
