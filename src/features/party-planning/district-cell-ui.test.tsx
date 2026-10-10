/** Territory Mapping → Existing Dealers → District: a state-specific searchable dropdown with an explicit Save (nothing saves on pick or blur). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const hooks: unknown[] = [];
let cursor = 0;
const puts: { url: string; body: unknown }[] = [];
let failNext: string | null = null;
let invalidations = 0;
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let selects: { options: { value: string; label: string }[]; value: string; placeholder?: string; onChange: (v: string) => void; ariaLabel: string }[] = [];

const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { L: ({ k }: { k: string }) => <>{k}</>, useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "./party-planning-page": { PartyPlanModeLinks: () => null },
  "@/components/layout/page-header": { PageHeader: () => null },
  "@tanstack/react-query": {
    keepPreviousData: undefined, useQuery: () => ({ data: undefined, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: () => { invalidations += 1; } }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then((r) => o.onSuccess?.(r), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => [], put: async (url: string, body: unknown) => { if (failNext) { const m = failNext; failNext = null; throw new Error(m); } puts.push({ url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => { buttons.push(p); return <button disabled={p.disabled}>{p.children}</button>; } },
  "@/components/ui/badge": { Badge: ({ children, title }: { children?: React.ReactNode; title?: string }) => <span data-badge title={title}>{children}</span> },
  "@/components/ui/searchable-select": { SearchableSelect: (p: (typeof selects)[number]) => { selects.push(p); return <div data-select aria-label={p.ariaLabel} />; } },
};
const { DistrictCell } = testLoader(overrides)("src/features/party-planning/territory-mapping-page.tsx") as { DistrictCell: React.ComponentType<{ row: Row; options: { id: string; name: string }[] | undefined }> };
interface Row { dealerId: string; partyName: string; district: string | null; districtId: string | null; stateId: string | null; stateName: string | null; districtReview: "LEGACY" | "WRONG_STATE" | null; [k: string]: unknown }
const row = (o: Partial<Row> = {}): Row => ({ dealerId: "d1", partyName: "ABC Traders", status: "ACTIVE", marketId: null, marketName: null, marketEdited: false, potential: null, district: null, districtId: null, stateId: "g1", stateName: "Madhya Pradesh", districtReview: null, ...o });
const MP = [{ id: "raj", name: "Rajgarh" }, { id: "sag", name: "Sagar" }];
let props: { row: Row; options: { id: string; name: string }[] | undefined } = { row: row(), options: MP };
const render = () => { cursor = 0; buttons = []; selects = []; const html = renderToStaticMarkup(<DistrictCell {...props} />); hooks.length = cursor; return html; };
const save = () => buttons.find((b) => String(b.children) === "Save")!;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // Only the dealer's own state's active districts, plus an explicit Clear option; the dropdown is the shared SearchableSelect (no free text).
  let html = render();
  assert.equal(selects[0]!.options.map((o) => o.label).join("|"), "— Clear district —|Rajgarh|Sagar", "options = Clear + the state's districts only");
  assert.equal(selects[0]!.ariaLabel, "District for ABC Traders"); assert.equal(selects[0]!.placeholder, "Select a district…");
  assert.ok(html.includes("data-select") && !html.includes("<input"), "a searchable dropdown, no text box");
  assert.equal(save().disabled, true, "Save is disabled until a different district is picked");

  // Picking does NOT save; Save does, with the district id; success is announced and the list refreshed.
  selects[0]!.onChange("sag"); html = render();
  assert.equal(puts.length, 0, "no save on pick");
  assert.equal(save().disabled, false);
  save().onClick!(); await tick(); html = render();
  assert.equal(JSON.stringify(puts), JSON.stringify([{ url: "/api/territory-mapping/dealers/d1", body: { districtId: "sag" } }]));
  assert.ok(html.includes("District saved.") && invalidations === 1, "success message + refresh");
  assert.ok(!JSON.stringify(puts).includes("Sagar"), "the id is sent, never text");

  // Server rejection (e.g. a district of another state) is shown, and nothing pretends to be saved.
  hooks.length = 0; props = { row: row(), options: MP }; render();
  selects[0]!.onChange("raj"); render(); failNext = "\"Kannauj\" does not belong to this dealer's state (Madhya Pradesh)."; save().onClick!(); await tick(); html = render();
  assert.ok(html.includes("does not belong to this dealer") && html.includes("text-destructive"), "server error shown");

  // Clear: explicit option, sends null; only available when there is something to clear.
  hooks.length = 0; puts.length = 0; props = { row: row({ districtId: "raj", district: "Rajgarh" }), options: MP }; render();
  assert.equal(selects[0]!.value, "raj", "the current district is preselected");
  assert.equal(save().disabled, true, "re-selecting the current district is not a change");
  selects[0]!.onChange("__clear__"); render(); assert.equal(save().disabled, false); save().onClick!(); await tick();
  assert.equal(JSON.stringify(puts[0]!.body), JSON.stringify({ districtId: null }), "Clear removes the assignment");

  // No state → no list, no assignment, with the reason; the existing value stays visible.
  hooks.length = 0; props = { row: row({ stateId: null, stateName: null, district: "Old text", districtReview: "LEGACY" }), options: undefined };
  html = render();
  assert.equal(selects.length, 0, "no dropdown when the state cannot be determined");
  assert.ok(html.includes("State not set") && html.includes("can&#x27;t be assigned yet") && html.includes("Old text"), "clear explanation; value kept");
  assert.equal(buttons.length, 0, "and nothing can be saved");

  // A state with no districts yet: explained, not an unrestricted list.
  hooks.length = 0; props = { row: row(), options: [] };
  html = render(); assert.equal(selects.length, 0); assert.ok(html.includes("No districts have been added for Madhya Pradesh yet."));

  // Existing unresolved / wrong-state values are flagged for review but stay visible.
  hooks.length = 0; props = { row: row({ district: "Raj-garh", districtReview: "LEGACY" }), options: MP };
  html = render(); assert.ok(html.includes("Needs review") && html.includes("Raj-garh") && html.includes("free text"), "legacy value flagged");
  hooks.length = 0; props = { row: row({ districtId: "kan", district: "Kannauj", districtReview: "WRONG_STATE" }), options: MP };
  html = render(); assert.ok(html.includes("Needs review") && html.includes("Kannauj") && html.includes("does not belong to the dealer&#x27;s current state (Madhya Pradesh)"), "wrong-state value flagged; correctable");

  // Wiring: the Existing Dealers table uses the cell with the state's list; no blur-save text box remains.
  const page = readFileSync("src/features/party-planning/territory-mapping-page.tsx", "utf8");
  assert.ok(page.includes("<DistrictCell") && page.includes("districtsByState?.[row.stateId]") && page.includes("/api/territory-mapping/districts"), "options come from the server, by the row's state");
  assert.ok(!page.includes("onBlur") && !page.includes("DISTRICT_MAX"), "no blur-save, no free-text District input");
  console.log("district-cell-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
