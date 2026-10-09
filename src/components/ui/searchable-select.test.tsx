/** SearchableSelect: one field = search box + dropdown; the value is always a real option. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";

const hooks: unknown[] = [];
let cursor = 0;
let inputProps: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
const changes: string[] = [];
const opens: boolean[] = [];
const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (u: unknown) => { hooks[i] = u; }]; } },
  "@/components/ui/input": { Input: (p: Record<string, unknown>) => { inputProps = p; return <input role={p.role as string} aria-label={p["aria-label"] as string} placeholder={p.placeholder as string} defaultValue={p.value as string} />; } },
};
const mod = testLoader(overrides)("src/components/ui/searchable-select.tsx") as typeof import("./searchable-select");
const OPTIONS = [{ value: "a", label: "Pipariya — ABC" }, { value: "b", label: "Bareli — XYZ" }, { value: "c", label: "Bareilly Road — LMN" }];
const render = (value = "") => {
  cursor = 0;
  const html = renderToStaticMarkup(<mod.SearchableSelect ariaLabel="Market" options={OPTIONS} value={value} onChange={(v) => changes.push(v)} onOpenChange={(o) => opens.push(o)} placeholder="Search or select" emptyText="No markets found" />);
  return html;
};
const reset = () => { hooks.length = 0; changes.length = 0; opens.length = 0; };
const labels = (html: string) => [...html.matchAll(/role="option"[^>]*>([^<]*)</g)].map((m) => m[1]);

// pure helpers
assert.deepEqual(mod.filterSearchableOptions(OPTIONS, "  BARE ").map((o) => o.value), ["b", "c"], "partial, case-insensitive");
assert.deepEqual(mod.filterSearchableOptions(OPTIONS, "Pipariya — ABC").map((o) => o.value), ["a"], "complete name");
assert.deepEqual(mod.filterSearchableOptions(OPTIONS, "zzz"), []);
assert.equal(mod.filterSearchableOptions(OPTIONS, "").length, 3);
assert.deepEqual([mod.moveActive(-1, 1, 3), mod.moveActive(2, 1, 3), mod.moveActive(0, -1, 3), mod.moveActive(-1, -1, 3), mod.moveActive(0, 1, 0)], [0, 0, 2, 2, -1]);

// closed: a single field showing the selected label; no list
reset();
let html = render("b");
assert.ok(!html.includes("role=\"listbox\"") && html.includes("Bareli — XYZ") && (html.match(/<input/g) ?? []).length === 1, "one field, closed");
assert.equal(inputProps.role, "combobox"); assert.equal(inputProps["aria-expanded"], false);
// click/focus opens the list with every market
inputProps.onClick(); html = render();
assert.deepEqual(labels(html), OPTIONS.map((o) => o.label)); assert.deepEqual(opens, [true]);
// typing filters the same field; editing clears a previous selection so free text can never be submitted
render("b"); // a market is currently selected
inputProps.onChange({ target: { value: "bare" } }); html = render("b");
assert.deepEqual(labels(html), ["Bareli — XYZ", "Bareilly Road — LMN"]);
assert.deepEqual(changes, [""], "typing clears the selected value");
// no match → empty state, no options
inputProps.onChange({ target: { value: "nothing" } }); html = render();
assert.ok(html.includes("No markets found") && labels(html).length === 0, "empty state");
inputProps.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} }); assert.deepEqual(changes, ["", ""], "Enter with no result selects nothing");
// keyboard: ArrowDown highlights, Enter picks, list closes
reset();
inputProps.onChange({ target: { value: "bare" } }); html = render();
let prevented = 0; const key = (k: string) => inputProps.onKeyDown({ key: k, preventDefault: () => { prevented += 1; }, stopPropagation() {} });
key("ArrowDown"); html = render();
assert.ok(/py-1\.5 bg-muted"[^>]*>Bareilly Road/.test(html) && !/py-1\.5 bg-muted"[^>]*>Bareli —/.test(html), "second row highlighted");
changes.length = 0; key("Enter"); assert.deepEqual(changes, ["c"], "Enter picks the highlighted market"); assert.ok(prevented >= 2, "Enter / arrows do not submit the dialog");
html = render("c"); assert.ok(!html.includes("role=\"listbox\"") && html.includes("Bareilly Road — LMN"), "closed after picking, showing the selection");
// Escape closes the list (and is consumed)
reset(); inputProps.onFocus(); render(); let stopped = false;
inputProps.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation: () => { stopped = true; } }); html = render();
assert.ok(stopped && !html.includes("role=\"listbox\"") && opens.at(-1) === false, "Escape closes the list first");
// blur without choosing restores the selected label (never leaves stray text)
reset(); inputProps.onChange({ target: { value: "xx" } }); render(); inputProps.onBlur(); html = render("b");
assert.ok(html.includes("Bareli — XYZ") && !html.includes("xx"));
console.log("searchable-select.test.tsx — all assertions passed");
