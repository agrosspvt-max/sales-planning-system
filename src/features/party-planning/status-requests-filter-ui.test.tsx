/** Territory Mapping → Request: the Requested by column filter (multi-select, territory over name, by user id), per tab. No DB / browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { filterColumnOptions } from "@/components/ui/column-filter-header";
import { readFileSync } from "node:fs";

const hooks: unknown[] = [];
let cursor = 0;
const urls: string[] = [];
type Header = { label: string; options: { value: string; label: string; secondary?: string; displayLabel?: string }[]; selected: string[]; onChange: (n: string[]) => void; searchable?: boolean };
let headers: Header[] = [];
let buttons: { children?: React.ReactNode; onClick?: () => void }[] = [];
let list: Record<string, unknown>;
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, dealerId: `d${id}`, partyName: `Party ${id}`, statusAtRequest: "ACTIVE", currentStatus: "ACTIVE", reason: "INACTIVE", description: null, requestedById: "u1", requestedByName: "Bina", requestedByTerritory: "Raigarh", requestedByRole: "SALES_OFFICER", createdAt: "2026-10-01T00:00:00Z", status: "PENDING", resolvedByName: null, resolvedAt: null, resolutionNotes: null, editDealer: null, ...extra });
const FULL = { items: [row("1"), row("2", { requestedById: "u2", requestedByTerritory: null, requestedByName: "Rita" })], requesters: [{ id: "u1", name: "Bina", territory: "Raigarh" }, { id: "u3", name: "Bina", territory: "Raigarh" }, { id: "u2", name: "Rita", territory: null }], applied: { requesterIds: [] } };

const load = testLoader({
  react: { ...React,
    useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; },
    useEffect: (fn: () => void) => fn(),
  },
  "@/features/labels/label-ui": { useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@tanstack/react-query": {
    useQuery: (o: { queryFn: () => unknown }) => { void o.queryFn(); return { data: list, isLoading: false }; },
    useQueryClient: () => ({ invalidateQueries: () => undefined }), useMutation: () => ({ isPending: false, mutate: () => undefined }),
  },
  "@/lib/api-client": { api: { get: async (u: string) => { urls.push(decodeURIComponent(u)); return list; }, post: async () => ({}) } },
  "@/components/ui/column-filter-header": { ColumnFilterHeader: (p: Header) => { headers.push(p); return <th>{p.label}</th>; } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void }) => { buttons.push(p); return <button>{p.children}</button>; } },
  "@/features/sales-upload/create-dealer-dialog": { DealerDialog: () => null },
});
const { StatusRequestsTab } = load("src/features/party-planning/dealer-status-requests.tsx") as { StatusRequestsTab: React.ComponentType };
const render = () => { cursor = 0; headers = []; buttons = []; const h = renderToStaticMarkup(<StatusRequestsTab />); hooks.length = cursor; return h; };
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const last = () => urls[urls.length - 1]!;

list = FULL;
let html = render();
assert.ok(headers.some((h) => h.label === "Requested By" && h.searchable) || headers.some((h) => /requested/i.test(h.label) && h.searchable), "Requested by is a searchable column filter");
const hdr = () => headers.find((h) => /requested/i.test(h.label))!;
same(hdr().options.map((o) => [o.value, o.label, o.secondary]), [["u1", "Raigarh", "Bina"], ["u3", "Raigarh", "Bina"], ["u2", "No territory assigned", "Rita"]], "territory over name; same name + territory = separate options keyed by user id");
assert.ok(last().endsWith("view=pending"), "pending is the default tab; no selection = All");
// Multi-select: every id is sent (OR on the server); the row cell shows territory above the name with the full text as a tooltip.
list = { ...FULL, applied: { requesterIds: ["u1", "u2"] } };
hdr().onChange(["u1", "u2"]); html = render();
assert.ok(/requesterId=u1&requesterId=u2/.test(last()), "several requesters are sent together");
assert.ok(html.includes('data-testid="requested-by"') && html.includes('title="Raigarh"') && html.includes("No territory assigned") && html.includes("Bina"), "two-line cell with tooltip + fallback");
// A selection that is no longer valid (e.g. after a tab change) is replaced by what the server applied.
list = { ...FULL, applied: { requesterIds: ["u2"] } };
render(); render();
same(hdr().selected, ["u2"], "invalid selections are dropped, valid ones kept");
// No match → the clear message; with no selection the original empty text stays.
list = { ...FULL, items: [], applied: { requesterIds: ["u2"] } };
assert.ok(render().includes("No matching requests"), "filtered + nothing → No matching requests");
list = { ...FULL, items: [], applied: { requesterIds: [] } };
hdr().onChange([]); assert.ok(render().includes("No status change requests here."), "no selection + nothing → the original empty text");
// Search matches the territory OR the requester's name (case-insensitive, partial).
const opts = hdr().options;
same(filterColumnOptions(opts, "RAIG").map((o) => o.value), ["u1", "u3"], "by territory");
same(filterColumnOptions(opts, "rit").map((o) => o.value), ["u2"], "by name");
same(filterColumnOptions(opts, "bina").map((o) => o.value), ["u1", "u3"], "duplicate names stay separate");
// Actions are untouched.
list = FULL; render();
assert.ok(buttons.some((b) => b.children === "Resolve") || buttons.some((b) => JSON.stringify(b.children).includes("Resolve")), "Edit / Resolve actions remain");
assert.ok(readFileSync("src/features/party-planning/dealer-status-requests.tsx", "utf8").includes("RequesterCell"), "the shared requester cell is reused");
console.log("status-requests-filter-ui.test.tsx — all assertions passed");
