import assert from "node:assert/strict";
import { hasPlanningFigures, partitionProductRows } from "./product-row-order";

const rows = [
  { id: "z", name: "Zebra", plan: 0, sales: 0, amount: 0, rate: 500 },
  { id: "b", name: "beta", plan: 1, sales: 0, amount: 0, rate: 500 },
  { id: "a", name: "Alpha", plan: 0, sales: 0, amount: 0, rate: 500 },
  { id: "n", name: "Ninja", plan: 0, sales: 0, amount: -1496, rate: 500 },
  { id: "s", name: "Agora", plan: 0, sales: 12, amount: 0, rate: 500 },
];
const snapshot = JSON.stringify(rows);
const split = (input: typeof rows) => partitionProductRows(input, (r) => r.name, (r) => r.id, (r) => hasPlanningFigures(r.plan, r.sales, r.amount));
const first = split(rows);
assert.deepEqual(first.active.map((r) => r.name), ["Agora", "beta", "Ninja"], "sales-only and negative amount-only products stay visible");
assert.deepEqual(first.empty.map((r) => r.name), ["Alpha", "Zebra"], "prices do not make a product active");
assert.equal(JSON.stringify(rows), snapshot, "sorting never changes source data");
assert.deepEqual(split([...rows].reverse()), first, "officer/query insertion order cannot change product ordering");
assert(hasPlanningFigures(0, null, undefined, -0.01), "do not round small non-zero amounts away");
assert(!hasPlanningFigures(0, null, undefined), "unset inputs count as zero");
const promoted = split(rows.map((r) => r.id === "a" ? { ...r, plan: 5 } : r));
assert.deepEqual(promoted.active.map((r) => r.name), ["Agora", "Alpha", "beta", "Ninja"], "an edited zero product joins the active alphabetical group");
assert.deepEqual(promoted.empty.map((r) => r.name), ["Zebra"]);
const ties = partitionProductRows([{ id: "2", name: "MAXX" }, { id: "1", name: "maxx" }], (r) => r.name, (r) => r.id, () => true);
assert.deepEqual(ties.active.map((r) => r.id), ["1", "2"], "equal display names have a stable identity tie-break");
console.log("product-row-order.test.ts — all assertions passed");
