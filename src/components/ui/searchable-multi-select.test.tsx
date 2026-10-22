import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";

let values: string[] = [];
const items: { onSelect: (e: { preventDefault: () => void }) => void; "aria-checked": boolean }[] = [];
const hooks: unknown[] = [];
let cursor = 0;
const Wrapper = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
const { SearchableMultiSelect } = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (next: unknown) => { hooks[i] = next; }]; } },
  "@/components/ui/dropdown-menu": { DropdownMenu: Wrapper, DropdownMenuTrigger: Wrapper, DropdownMenuContent: Wrapper,
    DropdownMenuItem: (p: { children: React.ReactNode } & (typeof items)[number]) => { items.push(p); return <div role="menuitemcheckbox" aria-checked={p["aria-checked"]}>{p.children}</div>; } },
})<typeof import("./searchable-multi-select")>("src/components/ui/searchable-multi-select.tsx");
const render = () => { cursor = 0; items.length = 0; return renderToStaticMarkup(<SearchableMultiSelect options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} value={values} onChange={(next) => { values = next; }} label="Linked Dealers" placeholder="Select dealers" searchPlaceholder="Search dealers" emptyText="No dealers" noMatchText="No matches" removeLabel="Remove {name}" unavailableLabel="Unavailable" />); };
let html = render(); assert.ok(html.includes('type="search"') && html.includes("Select dealers"));
let prevented = false;
items[0]!.onSelect({ preventDefault: () => { prevented = true; } });
assert.equal(prevented, true, "selecting keeps the dropdown open");
html = render(); assert.equal(JSON.stringify(values), JSON.stringify(["a"])); assert.equal(items[0]!["aria-checked"], true);
assert.ok(html.includes('aria-label="Remove Alpha"'), "selected dealers have individual removal controls");
items[1]!.onSelect({ preventDefault: () => {} }); html = render(); assert.equal(JSON.stringify(values), JSON.stringify(["a", "b"]));
assert.ok(html.includes("Linked Dealers (2)") && html.includes('aria-label="Remove Beta"'));
items[0]!.onSelect({ preventDefault: () => {} }); render(); assert.equal(JSON.stringify(values), JSON.stringify(["b"]), "checkbox can deselect one dealer without losing the other");
console.log("searchable-multi-select.test.tsx — selection, deselection, removal controls and search field passed");
