/** Add Dealer dialog: the RM's Sales Officer filter (My Dealers default), the searchable dealer dropdown, tags, loading / failure handling. No DB / browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { readFileSync } from "node:fs";

const hooks: unknown[] = [];
let cursor = 0;
type Opt = { value: string; label: string };
let ownerSelect: { value: string; options: Opt[]; onChange: (e: { target: { value: string } }) => void } | null = null;
let dealerDropdown: { options: Opt[]; value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean; emptyText: string; noMatchText: string } | null = null;
let addButton: { disabled?: boolean; onClick?: () => void } | null = null;
const queries: Record<string, { data?: unknown; isFetching?: boolean; isError?: boolean }> = {};
const keys: string[] = [];
const TAGS: Record<string, { markerType: "TEXT" | "SYMBOL"; marker: string }[]> = { d2: [{ markerType: "TEXT", marker: "VIP" }] };

const load = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@/features/dealers/dealer-name-ui": { DealerName: () => null, useDealerMarkers: () => TAGS },
  "@tanstack/react-query": {
    keepPreviousData: undefined,
    useQuery: (o: { queryKey: unknown[]; enabled?: boolean }) => { if (o.enabled === false) return { data: undefined }; const k = o.queryKey.slice(1).join("|"); keys.push(k); return queries[k] ?? { data: undefined, isFetching: true }; },
    useQueryClient: () => ({ invalidateQueries: () => undefined }), useMutation: () => ({ isPending: false, mutate: () => undefined }),
  },
  "@/lib/api-client": { api: { get: async () => ({}) } },
  "@/components/ui/dialog": { Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  "@/components/ui/select": { NativeSelect: (p: NonNullable<typeof ownerSelect>) => { ownerSelect = p; return <select />; } },
  "@/components/ui/searchable-dropdown": { SearchableDropdown: (p: NonNullable<typeof dealerDropdown>) => { dealerDropdown = p; return <div data-dropdown />; } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void }) => { if (p.children === "Add Dealer" || p.children === DEFAULT_LABELS["daily_work.action.add_dealer"]) addButton = p; return <button>{p.children}</button>; } },
  "./daily-work-page-stubs": {},
});
const { AddDealerDialog } = load("src/features/daily-work/daily-work-page.tsx") as { AddDealerDialog: React.ComponentType<Record<string, unknown>> };
const labels = { title: "Add Dealer", choose: "Choose Dealer", select: "Select dealer", noMore: "No dealers left", cancel: "Cancel", add: "Add Dealer" };
const added: unknown[] = [];
const render = (props: Record<string, unknown>) => { cursor = 0; keys.length = 0; ownerSelect = null; dealerDropdown = null; addButton = null; const h = renderToStaticMarkup(<AddDealerDialog labels={labels} onAdd={(...a: unknown[]) => added.push(a)} onClose={() => undefined} available={[]} {...props} />); hooks.length = cursor; return h; };
const dealer = (id: string, name: string) => ({ id, name, monthlyPlan: 100, actual: 10, pending: 90 });
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const ROW = { section: "RECOVERY", taken: new Set<string>() };

// Sales Officer / non-RM: no owner filter, the dealer list is the caller's own; search is in the dropdown.
hooks.length = 0;
render({ available: [{ id: "d1", name: "Alpha" }, { id: "d2", name: "Beta" }] });
assert.equal(ownerSelect, null, "no Sales Officer filter for an SO");
same(dealerDropdown!.options, [{ value: "d2", label: "Beta [VIP]" }, { value: "d1", label: "Alpha" }], "tagged dealers first, markers kept next to the name");
assert.equal(dealerDropdown!.placeholder, "Select dealer");
assert.equal(addButton!.disabled, true, "Add Dealer stays disabled until a valid dealer is selected");
dealerDropdown!.onChange("d1"); render({ available: [{ id: "d1", name: "Alpha" }, { id: "d2", name: "Beta" }] });
assert.equal(addButton!.disabled, false); addButton!.onClick!();
same(added.pop(), ["d1", undefined], "an existing dealer id is submitted");
hooks.length = 0; render({ available: [] }); assert.equal(dealerDropdown!.emptyText, "No dealers left", "clear empty message");
assert.equal(dealerDropdown!.noMatchText, "No dealer matches your search", "clear no-match message");

// RM: My Dealers by default, then each authorized officer; each choice is its own request.
hooks.length = 0;
queries["RECOVERY|"] = { data: { section: "RECOVERY", ownerId: "rm", owners: [{ id: "so2", name: "Anil" }, { id: "so1", name: "Bina" }], dealers: [dealer("r1", "Rita Own")] } };
queries["RECOVERY|so1"] = { data: { section: "RECOVERY", ownerId: "so1", owners: [], dealers: [dealer("a1", "Alpha"), dealer("d2", "Beta")] } };
queries["RECOVERY|so2"] = { isFetching: true };
render({ owner: ROW });
same(ownerSelect!.options.map((o) => o.label), ["My Dealers", "Anil", "Bina"], "My Dealers first, then officers by name");
assert.equal(ownerSelect!.value, "", "My Dealers is the default");
same(dealerDropdown!.options, [{ value: "r1", label: "Rita Own" }], "only the RM's own dealers");
dealerDropdown!.onChange("r1"); render({ owner: ROW }); assert.equal(addButton!.disabled, false);
// Changing the officer clears the previous dealer and shows only that officer's dealers.
ownerSelect!.onChange({ target: { value: "so1" } }); render({ owner: ROW });
assert.ok(keys.includes("RECOVERY|so1"));
assert.equal(dealerDropdown!.value, "", "the previously selected dealer is cleared");
assert.equal(addButton!.disabled, true);
same(dealerDropdown!.options, [{ value: "d2", label: "Beta [VIP]" }, { value: "a1", label: "Alpha" }], "that officer's dealers only (tags kept)");
// While the next officer's list loads — or fails — nothing from the previous officer stays selectable.
ownerSelect!.onChange({ target: { value: "so2" } }); render({ owner: ROW });
same([dealerDropdown!.options, dealerDropdown!.disabled, dealerDropdown!.placeholder], [[], true, "Loading dealers…"], "no stale options while loading");
queries["RECOVERY|so2"] = { isError: true }; render({ owner: ROW });
same(dealerDropdown!.options, [], "a failed request retains no options");
assert.equal(addButton!.disabled, true);
// A dealer this editor already holds a manual row for is not offered again.
queries["RECOVERY|so1"] = { data: { section: "RECOVERY", ownerId: "so1", owners: [], dealers: [dealer("a1", "Alpha"), dealer("d2", "Beta")] } };
ownerSelect!.onChange({ target: { value: "so1" } }); render({ owner: { section: "RECOVERY", taken: new Set(["a1"]) } });
same(dealerDropdown!.options.map((o) => o.value), ["d2"]);
dealerDropdown!.onChange("d2"); render({ owner: ROW }); addButton!.onClick!();
const sent = added.pop() as [string, { dealer: { id: string }; ownerId?: string }];
same([sent[0], sent[1].dealer.id, sent[1].ownerId], ["d2", "d2", "so1"], "the officer's id travels with the row (the server re-validates it)");

// Wiring: the dropdown is the shared searchable component; the native select is gone from this dialog.
const page = readFileSync("src/features/daily-work/daily-work-page.tsx", "utf8");
const dlg = page.slice(page.indexOf("export function AddDealerDialog("), page.indexOf("/* ==================================== SECTION 3"));
assert.ok(dlg.includes("<SearchableDropdown") && !dlg.includes("dealerOptions"), "searchable dropdown replaces the native dealer selector");
console.log("add-dealer-dialog.test.tsx — all assertions passed");
