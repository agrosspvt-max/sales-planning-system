/** SearchableDropdown: a select-style trigger with a chevron, a PORTALLED list with its own search box, unique ids per instance, and no free-text path. (Open / keyboard / viewport behaviour: verified in a real browser.) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const { SearchableDropdown } = testLoader({})("src/components/ui/searchable-dropdown.tsx") as { SearchableDropdown: React.ComponentType<Record<string, unknown>> };
const props = { options: [{ value: "p1", label: "Alpha Market" }, { value: "p2", label: "Beta Market" }], placeholder: "Select a market…", searchPlaceholder: "Search markets…", emptyText: "none", noMatchText: "No markets found", ariaLabel: "Market", searchLabel: "Search markets", onChange: () => {} };

const empty = renderToStaticMarkup(<SearchableDropdown {...props} value="" />);
assert.ok(empty.includes("Select a market…") && /role="combobox"/.test(empty) && empty.includes("lucide-chevron-down"), "placeholder + dropdown arrow");
assert.ok(!/<input/.test(empty), "closed: no text input at all — typing can never create a market");
const chosen = renderToStaticMarkup(<SearchableDropdown {...props} value="p2" />);
assert.ok(chosen.includes("Beta Market") && !chosen.includes("Select a market…"), "shows the selected market's name");
const two = renderToStaticMarkup(<><SearchableDropdown {...props} value="" /><SearchableDropdown {...props} value="p1" /></>);
const ids = [...two.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
assert.equal(new Set(ids).size, ids.length, "each row's selector has its own ids");

const src = readFileSync("src/components/ui/searchable-dropdown.tsx", "utf8");
assert.ok(src.includes("DropdownMenuContent") && !/position:\s*absolute|absolute z-/.test(src), "the list is the portalled dropdown content, not an absolutely positioned child of the table cell");
assert.ok(src.includes('role="searchbox"') && src.includes("filterSearchableOptions") && src.includes("setQuery") && !/onChange\(query|onChange\(e\.target/.test(src), "search text is its own state and is never passed to onChange");
// Wiring: the Daily Plan uses it, wording from Edit Labels.
const page = readFileSync("src/features/daily-work/daily-work-page.tsx", "utf8");
assert.ok(page.includes("<SearchableDropdown ariaLabel={L.market}") && !page.includes("<SearchableSelect"), "the Market selector is the portal dropdown");
for (const k of ["select_market", "search_market", "search_market_placeholder", "no_markets_found", "no_approved_markets"]) assert.ok((DEFAULT_LABELS as Record<string, string>)[`daily_work.appointment.${k}`], `label ${k}`);
console.log("searchable-dropdown.test.tsx — all assertions passed");
