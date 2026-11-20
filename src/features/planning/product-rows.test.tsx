import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { hasPlanningFigures } from "@/lib/product-row-order";

let expandedScope: string | null = null;
const load = testLoader({ react: { ...React, useState: (initial: unknown) => {
  const state = React.useState(initial);
  return initial === null ? [expandedScope, () => {}] : state;
} } });
const { ProductRows } = load<typeof import("./product-rows")>("src/features/planning/product-rows.tsx");
const source = [
  { id: "z", name: "Zulu", qty: 0, actual: 0 }, { id: "n", name: "Ninja", qty: 0, actual: -1496 },
  { id: "b", name: "Beta", qty: 10, actual: 0 }, { id: "a", name: "Alpha", qty: 0, actual: 0 },
];
const render = (scope = "officer1") => renderToStaticMarkup(<table><tbody>
  <ProductRows rows={source} nameOf={(r) => r.name} idOf={(r) => r.id} hasValues={(r) => hasPlanningFigures(r.qty, r.actual)} columns={3} scope={scope}>
    {(r) => <tr key={r.id} data-product={r.id}><td>{r.name}</td><td>{r.qty}</td><td>{r.actual}</td></tr>}
  </ProductRows>
</tbody><tfoot><tr><td>Total</td><td>{source.reduce((t, r) => t + r.qty, 0)}</td><td>{source.reduce((t, r) => t + r.actual, 0)}</td></tr></tfoot></table>);
const ids = (html: string) => [...html.matchAll(/data-product="(.*?)"/g)].map((m) => m[1]);
const footer = (html: string) => html.slice(html.indexOf("<tfoot>"));
const closed = render();
assert.deepEqual(ids(closed), ["b", "n"]);
assert(closed.includes("Show more") && closed.includes("2 zero-value products") && closed.includes('aria-expanded="false"'));
expandedScope = "officer1";
const open = render();
assert.deepEqual(ids(open), ["b", "n", "a", "z"], "each group is alphabetical; expanding does not mix the two");
assert(open.includes("Show less") && open.includes('aria-expanded="true"'));
assert.equal(footer(open), footer(closed), "collapse/expand never changes totals");
assert.deepEqual(ids(render("officer2")), ["b", "n"], "changing officers does not expose the previous officer's empty group");
source[3]!.qty = 2;
assert.deepEqual(ids(render()), ["a", "b", "n", "z"], "an edited product moves to the active group");
source[0]!.qty = 1;
assert(!render().includes("Show less"), "no empty group means no toggle");
console.log("product-rows.test.tsx — all assertions passed");
