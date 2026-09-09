/**
 * Phase 12 — Product Merge OPERATIONAL-IDENTITY aggregation tests. DB-free.
 *   npx tsx src/features/planning/merge-aggregation.test.ts
 *
 * These assert the shared contract every read/aggregation screen now relies on: group product facts by the
 * EFFECTIVE (survivor) identity BEFORE aggregating, compute amounts per the line's own rate and SUM them
 * (so combined amount = Σ of the sources' amounts, never a re-derivation from combined qty × one rate),
 * let the survivor's metadata win, and never emit the merged source as a separate row. The helpers below
 * mirror the exact logic used in product-plan.tsx / monthly-product-plan.tsx / seasonal-monthly-view.tsx /
 * group-plan.server.ts, built on the same pure primitives (`terminalSurvivor`) the screens import.
 *
 * The centerpiece is the real reported scenario: TAANDAB → TANDAB.
 */
import assert from "node:assert/strict";
import { terminalSurvivor, validateMerge } from "@/lib/product-merge";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }
const graph = (pairs: [string, string | null][]) => new Map<string, string | null>(pairs);
const ids = (...xs: string[]) => new Set(xs);
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/* ---- Shared model of a product-level fact as the planning screens see it ---- */
interface Line {
  productId: string;      // RAW historical id — NEVER rewritten
  name: string;           // raw product name
  rate: number;           // the line's own (snapshot) rate
  nbvPct: number;         // the line's own NBV%
  packs: Record<string, number>;
  qty: number;            // planned qty
  amount: number;         // planned amount (qty × rate at source) — carried, not re-derived
  actualQty: number;
  actualAmount: number;   // actual sales VALUE from the upload
}
interface Meta { name: string; nbvPct: number; }
interface Row {
  productId: string; name: string;
  packs: Record<string, number>;
  qty: number; amount: number; nbv: number;
  actualQty: number; actualAmount: number; actualNbv: number;
}

/** The grouping contract shared by every product-grouping screen. */
function foldProductRows(lines: Line[], mergedIntoById: Map<string, string | null>, metaById: Map<string, Meta>): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const l of lines) {
    const effId = terminalSurvivor(l.productId, mergedIntoById);
    const isSurvivorLine = effId === l.productId;
    let row = rows.get(effId);
    if (!row) {
      row = { productId: effId, name: metaById.get(effId)?.name ?? l.name, packs: {}, qty: 0, amount: 0, nbv: 0, actualQty: 0, actualAmount: 0, actualNbv: 0 };
      rows.set(effId, row);
    }
    if (isSurvivorLine && metaById.get(effId)) row.name = metaById.get(effId)!.name; // survivor wins
    row.qty += l.qty;
    row.amount += l.amount;                       // amounts SUMMED per source (own rate)
    row.nbv += (l.amount * l.nbvPct) / 100;
    row.actualQty += l.actualQty;
    row.actualAmount += l.actualAmount;
    row.actualNbv += (l.actualAmount * l.nbvPct) / 100;
    for (const k of Object.keys(l.packs)) row.packs[k] = (row.packs[k] ?? 0) + l.packs[k];
  }
  return rows;
}

const mkLine = (o: Partial<Line> & { productId: string }): Line => ({
  name: o.productId, rate: 0, nbvPct: 0, packs: {}, qty: 0, amount: 0, actualQty: 0, actualAmount: 0, ...o,
});

/* ---------- 1–4: identity resolution ---------- */

test("1. merged SOURCE resolves to its survivor", () => {
  assert.equal(terminalSurvivor("TAANDAB", graph([["TAANDAB", "TANDAB"], ["TANDAB", null]])), "TANDAB");
});
test("2. SURVIVOR resolves to itself", () => {
  assert.equal(terminalSurvivor("TANDAB", graph([["TAANDAB", "TANDAB"], ["TANDAB", null]])), "TANDAB");
});
test("3. chained A→B→C resolves to terminal survivor C", () => {
  const g = graph([["A", "B"], ["B", "C"], ["C", null]]);
  assert.equal(terminalSurvivor("A", g), "C");
  assert.equal(terminalSurvivor("B", g), "C");
});
test("4. circular merge is rejected", () => {
  const g = graph([["TANDAB", "TAANDAB"], ["TAANDAB", null]]);
  const v = validateMerge({ sourceId: "TAANDAB", survivorId: "TANDAB", existingIds: ids("TAANDAB", "TANDAB"), mergedIntoById: g });
  assert.equal(v.ok, false);
  assert.match(v.reason!, /circular/i);
});

/* ---------- 5: PlanLine (Seasonal Product Plan) aggregation ---------- */

test("5. PlanLine qty+amount aggregate under the survivor as ONE row", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 10 }]]);
  const lines = [
    mkLine({ productId: "TANDAB", name: "TANDAB", rate: 2000, nbvPct: 10, qty: 200, amount: 400000 }),
    mkLine({ productId: "TAANDAB", name: "TAANDAB", rate: 2500, nbvPct: 10, qty: 300, amount: 500000 }),
  ];
  const rows = foldProductRows(lines, g, meta);
  assert.equal(rows.size, 1);
  const r = rows.get("TANDAB")!;
  assert.equal(r.name, "TANDAB");
  assert.equal(r.qty, 500);
  assert.equal(r.amount, 900000);
  assert.equal(rows.has("TAANDAB"), false);
});

/* ---------- 6: Monthly per-source-rate amounts ---------- */

test("6. monthly amounts sum per-source-rate (not qty × single rate)", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }]]);
  // Different rates — a naive (combined qty × survivor rate) would give 500×2000 = 1,000,000 (WRONG).
  const lines = [
    mkLine({ productId: "TANDAB", rate: 2000, qty: 200, amount: 400000 }),
    mkLine({ productId: "TAANDAB", rate: 2500, qty: 300, amount: 750000 }),
  ];
  const r = foldProductRows(lines, g, meta).get("TANDAB")!;
  assert.equal(r.qty, 500);
  assert.equal(r.amount, 1150000); // 400k + 750k — the true sum of the sources' amounts
});

/* ---------- 7: Territory aggregation across officers ---------- */

test("7. Territory Plan folds both products across team members under the survivor", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 10 }]]);
  const lines = [
    // officer A
    mkLine({ productId: "TANDAB", rate: 2000, nbvPct: 10, qty: 100, amount: 200000, actualQty: 30, actualAmount: 60000 }),
    mkLine({ productId: "TAANDAB", rate: 2500, nbvPct: 10, qty: 150, amount: 250000, actualQty: 40, actualAmount: 70000 }),
    // officer B
    mkLine({ productId: "TANDAB", rate: 2000, nbvPct: 10, qty: 100, amount: 200000, actualQty: 20, actualAmount: 40000 }),
    mkLine({ productId: "TAANDAB", rate: 2500, nbvPct: 10, qty: 150, amount: 150000, actualQty: 30, actualAmount: 60000 }),
  ];
  const r = foldProductRows(lines, g, meta).get("TANDAB")!;
  assert.equal(r.qty, 500);              // 100+150+100+150
  assert.equal(r.amount, 800000);        // 200k+250k+200k+150k
  assert.equal(r.actualQty, 120);        // 30+40+20+30
  assert.equal(r.actualAmount, 230000);  // 60k+70k+40k+60k
});

/* ---------- 8: amounts + NBV with different rates ---------- */

test("8. NBV aggregates from per-line amounts (survivor + source)", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 10 }]]);
  const lines = [
    mkLine({ productId: "TANDAB", nbvPct: 10, amount: 400000 }),
    mkLine({ productId: "TAANDAB", nbvPct: 20, amount: 500000 }),
  ];
  const r = foldProductRows(lines, g, meta).get("TANDAB")!;
  assert.ok(approx(r.nbv, 40000 + 100000)); // 10% of 400k + 20% of 500k
});

/* ---------- 9: packaging quantities ---------- */

test("9. packaging quantities aggregate per pack column", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }]]);
  const lines = [
    mkLine({ productId: "TANDAB", packs: { P1: 10, P5: 4 } }),
    mkLine({ productId: "TAANDAB", packs: { P1: 5, P5: 1, P10: 2 } }),
  ];
  const r = foldProductRows(lines, g, meta).get("TANDAB")!;
  assert.deepEqual(r.packs, { P1: 15, P5: 5, P10: 2 });
});

/* ---------- 10: Reports don't show the source ---------- */

test("10. report fact fold attributes source rows to the survivor only", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }]]);
  const rows = foldProductRows([
    mkLine({ productId: "TAANDAB", qty: 10, amount: 1000 }),
  ], g, meta);
  assert.equal(rows.has("TAANDAB"), false);
  assert.equal(rows.get("TANDAB")!.qty, 10);
});

/* ---------- 11: State Catalogue — no duplicate, source hidden ---------- */

test("11. State Catalogue hides the merged source, keeps ONE survivor row (survivor price wins)", () => {
  // Operational catalogue rows come from entries whose product is NOT a merged source.
  const entries = [
    { productId: "TANDAB", price: 1850, mergedIntoId: null as string | null },
    { productId: "TAANDAB", price: 1970, mergedIntoId: "TANDAB" as string | null },
  ];
  const operational = entries.filter((e) => e.mergedIntoId === null);
  assert.equal(operational.length, 1);
  assert.equal(operational[0].productId, "TANDAB");
  assert.equal(operational[0].price, 1850); // survivor price, not the source's 1970
  assert.equal(operational.filter((e) => e.productId === "TANDAB").length, 1); // no duplicate survivor row
});

/* ---------- 12: selectors exclude the source ---------- */

test("12. product selectors exclude merged sources, survivor stays selectable", () => {
  const master = [
    { id: "TANDAB", isActive: true, mergedIntoId: null as string | null },
    { id: "TAANDAB", isActive: false, mergedIntoId: "TANDAB" as string | null },
    { id: "EVE", isActive: true, mergedIntoId: null as string | null },
  ];
  const selectable = master.filter((m) => m.isActive && m.mergedIntoId === null).map((m) => m.id);
  assert.deepEqual(selectable.sort(), ["EVE", "TANDAB"]);
  assert.equal(selectable.includes("TAANDAB"), false);
});

/* ---------- 13: re-run idempotent ---------- */

test("13. re-running the same fold does not inflate totals", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }]]);
  const lines = [
    mkLine({ productId: "TANDAB", qty: 200, amount: 400000 }),
    mkLine({ productId: "TAANDAB", qty: 300, amount: 500000 }),
  ];
  const a = foldProductRows(lines, g, meta).get("TANDAB")!;
  const b = foldProductRows(lines, g, meta).get("TANDAB")!;
  assert.equal(a.qty, b.qty);
  assert.equal(a.amount, b.amount);
  assert.equal(a.amount, 900000);
});

/* ---------- 14: historical records untouched ---------- */

test("14. raw productId on every line is preserved after folding (read-time only)", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }]]);
  const lines = [mkLine({ productId: "TAANDAB", qty: 300, amount: 500000 })];
  foldProductRows(lines, g, meta);
  assert.equal(lines[0].productId, "TAANDAB"); // never rewritten
});

/* ---------- 15: survivor-wins metadata regardless of line order ---------- */

test("15. survivor metadata wins even when the source line is seen first", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB (survivor)", nbvPct: 10 }]]);
  const sourceFirst = [
    mkLine({ productId: "TAANDAB", name: "TAANDAB", qty: 300, amount: 500000 }),
    mkLine({ productId: "TANDAB", name: "TANDAB", qty: 200, amount: 400000 }),
  ];
  assert.equal(foldProductRows(sourceFirst, g, meta).get("TANDAB")!.name, "TANDAB (survivor)");
});

/* ---------- 16: unrelated products unaffected ---------- */

test("16. unrelated products are not merged or altered", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null], ["EVE", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }], ["EVE", { name: "EVE", nbvPct: 0 }]]);
  const rows = foldProductRows([
    mkLine({ productId: "TAANDAB", qty: 300, amount: 500000 }),
    mkLine({ productId: "TANDAB", qty: 200, amount: 400000 }),
    mkLine({ productId: "EVE", qty: 10, amount: 5000 }),
  ], g, meta);
  assert.equal(rows.get("EVE")!.qty, 10);
  assert.equal(rows.get("EVE")!.amount, 5000);
  assert.equal(rows.size, 2); // TANDAB + EVE
});

/* ---------- 17: THE reported scenario, exactly ---------- */

test("17. TAANDAB → TANDAB exact scenario: 500 / 150 / ₹900k / ₹250k, ONE row", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }]]);
  const lines = [
    //                           planned  actual    plannedAmt  actualAmt
    mkLine({ productId: "TAANDAB", qty: 300, actualQty: 100, amount: 500000, actualAmount: 150000 }),
    mkLine({ productId: "TANDAB",  qty: 200, actualQty: 50,  amount: 400000, actualAmount: 100000 }),
  ];
  const rows = foldProductRows(lines, g, meta);
  assert.equal(rows.size, 1);
  const r = rows.get("TANDAB")!;
  assert.equal(r.name, "TANDAB");
  assert.equal(r.qty, 500);              // 300 + 200
  assert.equal(r.actualQty, 150);        // 100 + 50
  assert.equal(r.amount, 900000);        // ₹500k + ₹400k
  assert.equal(r.actualAmount, 250000);  // ₹150k + ₹100k
  assert.equal(rows.has("TAANDAB"), false); // source never shown separately
});

/* ---------- 18: no double counting when source & survivor both present ---------- */

test("18. a merged source is counted once — never separately AND inside the survivor", () => {
  const g = graph([["TAANDAB", "TANDAB"], ["TANDAB", null]]);
  const meta = new Map<string, Meta>([["TANDAB", { name: "TANDAB", nbvPct: 0 }]]);
  const rows = foldProductRows([
    mkLine({ productId: "TANDAB", qty: 200, amount: 400000 }),
    mkLine({ productId: "TAANDAB", qty: 300, amount: 500000 }),
  ], g, meta);
  let totalQty = 0, totalAmt = 0;
  for (const r of rows.values()) { totalQty += r.qty; totalAmt += r.amount; }
  assert.equal(totalQty, 500);    // not 800 (would be double counting)
  assert.equal(totalAmt, 900000); // not 1.4M
});

console.log(`\n${passed} passed`);
