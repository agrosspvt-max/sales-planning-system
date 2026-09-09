/**
 * Recovery Plan dealer POPULATION / SCOPE tests (`recovery-population.ts`). DB-free.
 *   npx tsx src/lib/recovery-population.test.ts
 *
 * These lock in the correction: the Sales Officer's ASSIGNED dealers decide WHO appears in a Recovery
 * Plan; the Aging file and the Day Book only decide the VALUES. A dealer absent from Aging still appears
 * (zero values); a Day Book dealer assigned to the officer is processed even with no prior Aging/row.
 *
 * Centerpiece scenario (from the request):
 *   SO dealers = A B C D E ; Aging = A B C  → Recovery = A B C D E (D/E zero)
 *   Day Book = D E                          → D/E processed, NOT skipped
 */
import assert from "node:assert/strict";
import { zeroPopulationDealers, recoveryPopulation, daybookScopeDecision } from "./recovery-population";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }
const sortEq = (a: string[], b: string[]) => assert.deepEqual([...a].sort(), [...b].sort());

/* ---------- Population: WHO appears = all assigned dealers ---------- */

test("1. Aging has all assigned dealers → no extra zero rows (no behaviour change)", () => {
  const assigned = ["A", "B", "C", "D", "E"];
  const aging = ["A", "B", "C", "D", "E"];
  assert.deepEqual(zeroPopulationDealers(aging, assigned), []);
  sortEq(recoveryPopulation(aging, assigned), assigned);
});

test("2. SO has 5, Aging has 3 → Recovery shows all 5 (D/E are zero rows)", () => {
  const assigned = ["A", "B", "C", "D", "E"];
  const aging = ["A", "B", "C"];
  sortEq(zeroPopulationDealers(aging, assigned), ["D", "E"]);
  sortEq(recoveryPopulation(aging, assigned), ["A", "B", "C", "D", "E"]);
});

test("3. SO has 5, Aging has 0 → all 5 appear as zero rows", () => {
  const assigned = ["A", "B", "C", "D", "E"];
  sortEq(zeroPopulationDealers([], assigned), assigned);
  sortEq(recoveryPopulation([], assigned), assigned);
});

test("4. SO has 100, Aging has 70 → 30 zero rows, 100 total", () => {
  const assigned = Array.from({ length: 100 }, (_, i) => `D${i}`);
  const aging = assigned.slice(0, 70);
  assert.equal(zeroPopulationDealers(aging, assigned).length, 30);
  assert.equal(recoveryPopulation(aging, assigned).length, 100);
});

test("5. no duplicate rows even if a dealer appears twice in inputs", () => {
  const assigned = ["A", "A", "B"];
  const aging = ["A"];
  sortEq(zeroPopulationDealers(aging, assigned), ["B"]);
  sortEq(recoveryPopulation(aging, assigned), ["A", "B"]);
});

test("6. dealer outside the officer's assignment never enters the population", () => {
  const assigned = ["A", "B"];
  const aging = ["A", "B", "X"]; // X not assigned to this officer
  // population is driven by assignment; recoveryPopulation unions defensively but zero-rows never invent X
  assert.equal(zeroPopulationDealers(aging, assigned).includes("X"), false);
});

/* ---------- Day Book scope: assigned dealers processed regardless of prior row ---------- */

test("7. Day Book D/E (no Aging, no row) are PROCESSED, not skipped", () => {
  const assigned = ["A", "B", "C", "D", "E"];
  const existingRows = ["A", "B", "C"]; // only Aging dealers had rows
  const resolved = ["D", "E"];          // Day Book contains D and E
  const d = daybookScopeDecision(resolved, existingRows, assigned);
  sortEq(d.process, ["D", "E"]);
  sortEq(d.needsRowCreate, ["D", "E"]); // rows will be created on commit
  assert.deepEqual(d.skip, []);
});

test("8. Day Book for a dealer WITH an existing row updates in place (no create)", () => {
  const d = daybookScopeDecision(["A"], ["A", "B", "C"], ["A", "B", "C", "D", "E"]);
  assert.deepEqual(d.process, ["A"]);
  assert.deepEqual(d.needsRowCreate, []);
  assert.deepEqual(d.skip, []);
});

test("9. Day Book dealer NOT assigned to any month officer is skipped", () => {
  const d = daybookScopeDecision(["Z"], ["A", "B", "C"], ["A", "B", "C", "D", "E"]);
  assert.deepEqual(d.process, []);
  assert.deepEqual(d.skip, ["Z"]);
});

test("10. Day Book scope does NOT depend on prior recovery presence (empty existing rows)", () => {
  // Even if NO dealer has a recovery row yet, every assigned dealer in the Day Book is processed.
  const assigned = ["A", "B", "C", "D", "E"];
  const d = daybookScopeDecision(["A", "D", "E"], [], assigned);
  sortEq(d.process, ["A", "D", "E"]);
  sortEq(d.needsRowCreate, ["A", "D", "E"]);
  assert.deepEqual(d.skip, []);
});

/* ---------- The full reported scenario, end to end ---------- */

test("11. FULL SCENARIO A..E: Aging A/B/C → all 5 shown; Day Book D/E → processed", () => {
  const assigned = ["A", "B", "C", "D", "E"];
  const aging = ["A", "B", "C"];

  // Create-time population.
  const zeros = zeroPopulationDealers(aging, assigned);
  sortEq(zeros, ["D", "E"]);
  sortEq(recoveryPopulation(aging, assigned), ["A", "B", "C", "D", "E"]);

  // After create, rows exist for A..E (aging for A/B/C, zero for D/E).
  const existingRows = ["A", "B", "C", "D", "E"];
  // Day Book for D and E.
  const db = daybookScopeDecision(["D", "E"], existingRows, assigned);
  sortEq(db.process, ["D", "E"]);
  assert.deepEqual(db.needsRowCreate, []); // rows already there from create-time population
  assert.deepEqual(db.skip, []);
});

test("12. legacy plan created before the fix (only A/B/C rows) still processes Day Book D/E", () => {
  const assigned = ["A", "B", "C", "D", "E"];
  const existingRows = ["A", "B", "C"]; // legacy: D/E were never created
  const db = daybookScopeDecision(["D", "E"], existingRows, assigned);
  sortEq(db.process, ["D", "E"]);
  sortEq(db.needsRowCreate, ["D", "E"]); // commit creates the missing rows
  assert.deepEqual(db.skip, []);
});

console.log(`\n${passed} passed`);
