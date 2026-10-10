/** Territory Mapping → Existing Dealers filter row: Market (searchable) for everyone, Sales Officer for RM / Admin, State for Admin only; no Search party. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { filterSearchableOptions } from "@/components/ui/searchable-select";

const hooks: unknown[] = [];
let cursor = 0;
const urls: string[] = [];
type Sel = { options: { value: string; label: string }[]; value: string; onChange: (e: { target: { value: string } }) => void };
let selects: Sel[] = [];
let searchables: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; ariaLabel: string }[] = [];
const FILTERS = { officers: [{ id: "so1", name: "Rahul Patidar", groupId: "mp" }, { id: "so2", name: "Anil Rao", groupId: "up" }], states: [{ id: "mp", name: "Madhya Pradesh" }, { id: "up", name: "Uttar Pradesh" }] };
const MARKETS = [{ id: "m1", name: "BIRRA", potential: "A", source: "X" }, { id: "m2", name: "Pipariya", potential: null, source: "X" }];

const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { L: ({ k }: { k: string }) => <>{k}</>, useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "./party-planning-page": { PartyPlanModeLinks: () => null },
  "@/components/layout/page-header": { PageHeader: () => null },
  "@tanstack/react-query": {
    keepPreviousData: undefined,
    useQuery: (o: { queryKey: unknown[]; enabled?: boolean }) => {
      const key = String(o.queryKey[0]);
      if (key === "territory-dealers") urls.push(JSON.stringify(o.queryKey.slice(1)));
      if (o.enabled === false) return { data: undefined, isLoading: false };
      return { data: key === "territory-markets" ? MARKETS : key === "territory-filters" ? FILTERS : key === "territory-dealers" ? { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1, mapped: 4, unmapped: 2 } : undefined, isLoading: false };
    },
    useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useMutation: () => ({ isPending: false, mutate: () => undefined }),
  },
  "@/lib/api-client": { api: { get: async () => ({}) } },
  "@/components/ui/select": { NativeSelect: (p: Sel) => { selects.push(p); return <select />; } },
  "@/components/ui/searchable-select": { SearchableSelect: (p: (typeof searchables)[number]) => { searchables.push(p); return <div data-searchable />; } },
  "./dealer-status-requests": { StatusRequestCell: () => null, StatusRequestsTab: () => null },
};
const { TerritoryMappingPage } = testLoader(overrides)("src/features/party-planning/territory-mapping-page.tsx") as { TerritoryMappingPage: React.ComponentType<{ role: Role }> };
let role: Role = Role.SALES_OFFICER;
const render = () => { cursor = 0; selects = []; searchables = []; const html = renderToStaticMarkup(<TerritoryMappingPage role={role} />); hooks.length = cursor; return html; };
const reset = (r: Role) => { hooks.length = 0; urls.length = 0; role = r; return render(); };

async function main() {
  // The Search party field is gone for everyone; Market is a searchable dropdown with All Markets as the default.
  for (const r of [Role.SALES_OFFICER, Role.REGIONAL_MANAGER, Role.SUPER_ADMIN]) {
    const html = reset(r);
    assert.ok(!html.includes("Search party"), `${r}: no Search party`);
    assert.equal(searchables.length, 1, `${r}: Market is the searchable dropdown`);
    assert.equal(searchables[0]!.options[0]!.label, "All Markets"); assert.equal(searchables[0]!.value, "", "All Markets is the default");
    assert.ok(html.includes("4 mapped · 2 unmapped") && html.includes("Import Excel"), `${r}: counts and Import Excel stay`);
    assert.ok(html.indexOf("Market") < (html.indexOf("Sales Officer") === -1 ? Infinity : html.indexOf("Sales Officer")), `${r}: Market comes first`);
  }
  // SO: Market only.
  let html = reset(Role.SALES_OFFICER);
  assert.equal(selects.length, 0, "SO: no Sales Officer / State dropdowns"); assert.ok(!html.includes(">State<") && !html.includes(">Sales Officer<"));
  // RM: Market + Sales Officer (their team's list only), no State.
  html = reset(Role.REGIONAL_MANAGER);
  assert.equal(selects.length, 1, "RM: one dropdown (Sales Officer)"); assert.ok(html.includes(">Sales Officer<") && !html.includes(">State<"));
  assert.equal(selects[0]!.options.map((o) => o.label).join("|"), "All Sales Officers|Rahul Patidar|Anil Rao", "default All + the officers the server returned");
  // Admin: Market + Sales Officer + State, in that order.
  html = reset(Role.SUPER_ADMIN);
  assert.equal(selects.length, 2); assert.ok(html.indexOf(">Market<") < html.indexOf(">Sales Officer<") && html.indexOf(">Sales Officer<") < html.indexOf(">State<"), "Market → Sales Officer → State");
  assert.equal(selects[1]!.options.map((o) => o.label).join("|"), "All States|Madhya Pradesh|Uttar Pradesh", "States come from the server list");

  // Combined filters go to the server together; changing one keeps the others, All restores.
  searchables[0]!.onChange("m1"); render();
  selects[0]!.onChange({ target: { value: "so1" } }); render();
  assert.equal(urls.at(-1), JSON.stringify(["m1", "so1", "", 1]), "market + officer");
  selects[1]!.onChange({ target: { value: "mp" } }); render();
  assert.equal(urls.at(-1), JSON.stringify(["m1", "so1", "mp", 1]), "State added; the other valid selections are kept");
  assert.equal(selects[0]!.options.map((o) => o.label).join("|"), "All Sales Officers|Rahul Patidar", "Sales Officer choices narrow to the chosen State");
  selects[1]!.onChange({ target: { value: "up" } }); render();
  assert.equal(urls.at(-1), JSON.stringify(["m1", "", "up", 1]), "an officer outside the new State is cleared safely");
  selects[1]!.onChange({ target: { value: "" } }); searchables[0]!.onChange(""); render();
  assert.equal(urls.at(-1), JSON.stringify(["", "", "", 1]), "All / All / All restores the full set");

  // Market search is case-insensitive.
  assert.equal(filterSearchableOptions(searchables[0]!.options, "birr").map((o) => o.label).join(), "BIRRA");
  assert.equal(filterSearchableOptions(searchables[0]!.options, "PIPAR").map((o) => o.label).join(), "Pipariya");
  console.log("territory-filters-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
