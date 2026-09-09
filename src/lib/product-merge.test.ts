/**
 * Phase 12 — Product Merge PURE logic tests (`product-merge.ts`). DB-free.
 *   npx tsx src/lib/product-merge.test.ts
 * Covers: terminal-survivor resolution, self/circular rejection, idempotency, chained merges, catalogue
 * case decision, and read-time aggregation (no double counting).
 */
import assert from "node:assert/strict";
import { terminalSurvivor, effectiveProductId, validateMerge, catalogueGroupAction, foldByEffectiveProduct } from "./product-merge";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const graph = (pairs: [string, string | null][]) => new Map<string, string | null>(pairs);
const ids = (...xs: string[]) => new Set(xs);

/* --------------------------------- terminal survivor --------------------------------- */

test("1. normal product resolves to itself", () => {
  assert.equal(terminalSurvivor("ADAM", graph([["ADAM", null]])), "ADAM");
});

test("2. merged source resolves to its survivor", () => {
  assert.equal(terminalSurvivor("ADAMPLUS", graph([["ADAMPLUS", "ADAM"], ["ADAM", null]])), "ADAM");
});

test("3. chained merges resolve to the TERMINAL survivor (A→B→C ⇒ A→C)", () => {
  const g = graph([["A", "B"], ["B", "C"], ["C", null]]);
  assert.equal(terminalSurvivor("A", g), "C");
  assert.equal(terminalSurvivor("B", g), "C");
  assert.equal(effectiveProductId("C", g), "C");
});

test("4. corrupt cycle never loops (defensive)", () => {
  const g = graph([["A", "B"], ["B", "A"]]);
  const r = terminalSurvivor("A", g);
  assert.ok(r === "A" || r === "B");
});

/* --------------------------------- validation --------------------------------- */

const base = graph([["ADAM", null], ["ADAMPLUS", null], ["EVE", null]]);

test("5. valid merge ADAMPLUS → ADAM", () => {
  const v = validateMerge({ sourceId: "ADAMPLUS", survivorId: "ADAM", existingIds: ids("ADAM", "ADAMPLUS", "EVE"), mergedIntoById: base });
  assert.equal(v.ok, true);
  assert.equal(v.terminalSurvivorId, "ADAM");
  assert.equal(v.alreadyMerged, false);
});

test("6. same product on both sides is rejected", () => {
  const v = validateMerge({ sourceId: "ADAM", survivorId: "ADAM", existingIds: ids("ADAM"), mergedIntoById: base });
  assert.equal(v.ok, false);
  assert.match(v.reason!, /itself/i);
});

test("7. unknown product is rejected", () => {
  const v = validateMerge({ sourceId: "GHOST", survivorId: "ADAM", existingIds: ids("ADAM", "ADAMPLUS"), mergedIntoById: base });
  assert.equal(v.ok, false);
  assert.match(v.reason!, /not found/i);
});

test("8. circular merge is rejected (survivor resolves back to source)", () => {
  // ADAM already merged into ADAMPLUS; now trying ADAMPLUS → ADAM would be circular.
  const g = graph([["ADAM", "ADAMPLUS"], ["ADAMPLUS", null]]);
  const v = validateMerge({ sourceId: "ADAMPLUS", survivorId: "ADAM", existingIds: ids("ADAM", "ADAMPLUS"), mergedIntoById: g });
  assert.equal(v.ok, false);
  assert.match(v.reason!, /circular/i);
});

test("9. re-merging the same pair is idempotent (no-op)", () => {
  const g = graph([["ADAMPLUS", "ADAM"], ["ADAM", null]]);
  const v = validateMerge({ sourceId: "ADAMPLUS", survivorId: "ADAM", existingIds: ids("ADAM", "ADAMPLUS"), mergedIntoById: g });
  assert.equal(v.ok, true);
  assert.equal(v.alreadyMerged, true);
  assert.equal(v.terminalSurvivorId, "ADAM");
});

test("10. source already merged into a DIFFERENT product is rejected", () => {
  const g = graph([["ADAMPLUS", "EVE"], ["EVE", null], ["ADAM", null]]);
  const v = validateMerge({ sourceId: "ADAMPLUS", survivorId: "ADAM", existingIds: ids("ADAM", "ADAMPLUS", "EVE"), mergedIntoById: g });
  assert.equal(v.ok, false);
  assert.match(v.reason!, /already merged/i);
});

test("11. merging into an already-merged survivor folds to its terminal survivor", () => {
  // ADAM merged into EVE; merging ADAMPLUS → ADAM should target EVE (terminal).
  const g = graph([["ADAM", "EVE"], ["EVE", null], ["ADAMPLUS", null]]);
  const v = validateMerge({ sourceId: "ADAMPLUS", survivorId: "ADAM", existingIds: ids("ADAM", "ADAMPLUS", "EVE"), mergedIntoById: g });
  assert.equal(v.ok, true);
  assert.equal(v.terminalSurvivorId, "EVE");
});

/* --------------------------------- catalogue decision --------------------------------- */

test("12. catalogue: survivor already in group → deactivate source only", () => {
  assert.equal(catalogueGroupAction(true), "deactivateSource");
});
test("13. catalogue: survivor absent in group → create survivor from source", () => {
  assert.equal(catalogueGroupAction(false), "createSurvivorFromSource");
});

/* --------------------------------- read-time aggregation --------------------------------- */

test("14. sales from both products aggregate into the survivor, counted once", () => {
  const g = graph([["ADAMPLUS", "ADAM"], ["ADAM", null]]);
  const rows = [
    { productId: "ADAM", qty: 100 },
    { productId: "ADAMPLUS", qty: 50 },
    { productId: "EVE", qty: 20 },
  ];
  const folded = foldByEffectiveProduct(rows, (r) => r.productId, (r) => r.qty, g);
  assert.equal(folded.get("ADAM"), 150); // 100 + 50, once
  assert.equal(folded.get("EVE"), 20);
  assert.equal(folded.has("ADAMPLUS"), false); // never a separate bucket
});

test("15. planned+actual fold independently, no cross-contamination", () => {
  const g = graph([["ADAMPLUS", "ADAM"], ["ADAM", null]]);
  const planned = foldByEffectiveProduct(
    [{ p: "ADAM", v: 100 }, { p: "ADAMPLUS", v: 50 }],
    (r) => r.p, (r) => r.v, g,
  );
  const actual = foldByEffectiveProduct(
    [{ p: "ADAM", v: 80 }, { p: "ADAMPLUS", v: 40 }],
    (r) => r.p, (r) => r.v, g,
  );
  assert.equal(planned.get("ADAM"), 150);
  assert.equal(actual.get("ADAM"), 120);
});

test("16. re-running aggregation does not increase totals (idempotent read)", () => {
  const g = graph([["ADAMPLUS", "ADAM"], ["ADAM", null]]);
  const rows = [{ p: "ADAM", v: 100 }, { p: "ADAMPLUS", v: 50 }];
  const a = foldByEffectiveProduct(rows, (r) => r.p, (r) => r.v, g);
  const b = foldByEffectiveProduct(rows, (r) => r.p, (r) => r.v, g);
  assert.equal(a.get("ADAM"), b.get("ADAM"));
  assert.equal(a.get("ADAM"), 150);
});

console.log(`\n${passed} passed`);
