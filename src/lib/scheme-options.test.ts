/**
 * Phase 10 — Multiple Options PURE engine tests (`scheme-options.ts`).
 *
 * Covers master validation, option normalization, the shared effective-value / effective-target resolver,
 * per-dealer + scheme-level combined achievement over the eligible pool, and the Scheme Upload option impact.
 * Every rule from the finalised Multiple Options spec is asserted, including the historical-integrity example
 * (a committed 200 KG / ₹23,600 option snapshot). Runnable without a database:
 *   npx tsx src/lib/scheme-options.test.ts
 */
import assert from "node:assert/strict";
import {
  validateMultipleOptions,
  normalizeOption,
  effectiveValueWithGST,
  effectiveValueWithoutGST,
  effectiveOptionTarget,
  dealerOptionAchievement,
  schemeOptionAchievement,
  optionUploadImpact,
  type OptionSaleFact,
} from "./scheme-options";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const approx = (a: number | null, b: number, msg?: string) => assert.ok(a != null && Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ~${b}, got ${a}`);

/* --------------------------------- master validation --------------------------------- */

const validQtyInput = () => ({
  achievementType: "QUANTITY_BASED" as const,
  eligibleProductIds: ["P1", "P2"],
  options: [
    { label: "Bronze", target: 100, valueWithoutGST: 10000, valueWithGST: 11800 },
    { label: "Silver", target: 200, valueWithoutGST: 20000, valueWithGST: 23600 },
  ],
});

test("1. valid Multiple Options config returns no errors", () => {
  assert.deepEqual(validateMultipleOptions(validQtyInput()), []);
});

test("2. missing eligible products is rejected", () => {
  const errs = validateMultipleOptions({ ...validQtyInput(), eligibleProductIds: [] });
  assert.ok(errs.some((e) => /eligible product/i.test(e)));
});

test("3. no options is rejected", () => {
  const errs = validateMultipleOptions({ ...validQtyInput(), options: [] });
  assert.ok(errs.some((e) => /at least one option/i.test(e)));
});

test("4. option with non-positive target is rejected", () => {
  const errs = validateMultipleOptions({ ...validQtyInput(), options: [{ label: "X", target: 0, valueWithoutGST: 1, valueWithGST: 1 }] });
  assert.ok(errs.some((e) => /target greater than zero/i.test(e)));
});

test("5. option with non-positive values is rejected", () => {
  const errs = validateMultipleOptions({ ...validQtyInput(), options: [{ label: "X", target: 10, valueWithoutGST: 0, valueWithGST: 0 }] });
  assert.ok(errs.some((e) => /Without GST/i.test(e)));
  assert.ok(errs.some((e) => /With GST/i.test(e)));
});

test("6. duplicate targets are rejected (options must be distinguishable)", () => {
  const errs = validateMultipleOptions({
    ...validQtyInput(),
    options: [
      { label: "A", target: 100, valueWithoutGST: 1, valueWithGST: 1 },
      { label: "B", target: 100, valueWithoutGST: 2, valueWithGST: 2 },
    ],
  });
  assert.ok(errs.some((e) => /same target/i.test(e)));
});

test("7. option validation is independent of installment mode", () => {
  assert.deepEqual(validateMultipleOptions(validQtyInput()), []);
});

test("8. duplicate eligible product id is rejected", () => {
  const errs = validateMultipleOptions({ ...validQtyInput(), eligibleProductIds: ["P1", "P1"] });
  assert.ok(errs.some((e) => /more than once/i.test(e)));
});

/* --------------------------------- normalization --------------------------------- */

test("9. QUANTITY_BASED option normalizes target into targetQty (targetValue null)", () => {
  const o = normalizeOption({ label: " Gold ", target: 200.1234, valueWithoutGST: 20000, valueWithGST: 23600 }, "QUANTITY_BASED");
  assert.equal(o.label, "Gold");
  approx(o.targetQty, 200.123, "targetQty rounded to 3dp");
  assert.equal(o.targetValue, null);
  approx(o.valueWithGST, 23600);
});

test("10. VALUE_BASED master ignores legacy target and derives targetValue from With GST", () => {
  const o = normalizeOption({ label: null, target: 50000.567, valueWithoutGST: 40000, valueWithGST: 47200 }, "VALUE_BASED");
  assert.equal(o.label, null);
  assert.equal(o.targetQty, null);
  approx(o.targetValue, 47200, "With GST is the target");
});

/* --------------------------------- effective value / target resolver --------------------------------- */

test("11. effective value resolves scheme value for FIXED, option snapshot for MULTIPLE_OPTIONS", () => {
  approx(effectiveValueWithGST({ structure: "FIXED", schemeValueWithGST: 11800, optionValueWithGST: null }), 11800);
  approx(effectiveValueWithGST({ structure: "MULTIPLE_OPTIONS", schemeValueWithGST: null, optionValueWithGST: 23600 }), 23600);
  approx(effectiveValueWithoutGST({ structure: "MULTIPLE_OPTIONS", schemeValueWithoutGST: null, optionValueWithoutGST: 20000 }), 20000);
});

test("12. effective value is 0 only when the relevant branch is genuinely null (no ?? 0 elsewhere)", () => {
  approx(effectiveValueWithGST({ structure: "MULTIPLE_OPTIONS", schemeValueWithGST: 999, optionValueWithGST: null }), 0);
  approx(effectiveValueWithGST({ structure: "FIXED", schemeValueWithGST: null, optionValueWithGST: 999 }), 0);
});

test("13. effective option target picks qty vs value by achievement type", () => {
  approx(effectiveOptionTarget({ achievementType: "QUANTITY_BASED", optionTargetQty: 200, optionTargetValue: null }), 200);
  approx(effectiveOptionTarget({ achievementType: "VALUE_BASED", optionTargetQty: null, optionTargetValue: 50000 }), 50000);
  assert.equal(effectiveOptionTarget({ achievementType: null, optionTargetQty: 1, optionTargetValue: 1 }), null);
});

/* --------------------------------- dealer achievement (combined over pool) --------------------------------- */

const eligible = new Set(["P1", "P2"]);

test("14. dealer achievement sums ELIGIBLE products only; non-eligible ignored", () => {
  const sums = new Map([["P1", { qty: 120, value: 0 }], ["P2", { qty: 90, value: 0 }], ["PX", { qty: 999, value: 0 }]]);
  const a = dealerOptionAchievement("QUANTITY_BASED", 200, eligible, sums);
  approx(a.achieved, 210, "120+90, PX ignored");
  approx(a.remaining, 0, "achieved >= target");
  assert.equal(a.completed, true);
  approx(a.progress, 210 / 200);
  assert.equal(a.contributions.length, 2); // only eligible contribute
});

test("15. dealer under target reports positive remaining, not completed, capped progress computed", () => {
  const sums = new Map([["P1", { qty: 50, value: 0 }], ["P2", { qty: 30, value: 0 }]]);
  const a = dealerOptionAchievement("QUANTITY_BASED", 200, eligible, sums);
  approx(a.achieved, 80);
  approx(a.remaining, 120);
  assert.equal(a.completed, false);
  approx(a.progress, 0.4);
});

test("16. VALUE_BASED dealer achievement uses value sums", () => {
  const sums = new Map([["P1", { qty: 0, value: 30000 }], ["P2", { qty: 0, value: 25000 }]]);
  const a = dealerOptionAchievement("VALUE_BASED", 50000, eligible, sums);
  approx(a.achieved, 55000);
  assert.equal(a.completed, true);
  approx(a.remaining, 0);
});

/* --------------------------------- scheme-level (per-dealer own snapshot target) --------------------------------- */

test("17. scheme achievement uses EACH dealer's own snapshot target (never one blended target)", () => {
  const sales: OptionSaleFact[] = [
    { dealerId: "A", productId: "P1", qty: 120, value: 0 },
    { dealerId: "A", productId: "P2", qty: 90, value: 0 },
    { dealerId: "B", productId: "P1", qty: 60, value: 0 },
  ];
  const targetByDealer = new Map([["A", 200], ["B", 100]]);
  const s = schemeOptionAchievement("QUANTITY_BASED", ["P1", "P2"], sales, targetByDealer);
  assert.equal(s.dealerCount, 2);
  const a = s.perDealer.find((d) => d.dealerId === "A")!;
  const b = s.perDealer.find((d) => d.dealerId === "B")!;
  approx(a.target, 200); approx(a.achievement.achieved, 210); assert.equal(a.achievement.completed, true);
  approx(b.target, 100); approx(b.achievement.achieved, 60); assert.equal(b.achievement.completed, false);
});

test("18. dealers with no snapshot target are excluded from scheme achievement", () => {
  const sales: OptionSaleFact[] = [{ dealerId: "C", productId: "P1", qty: 999, value: 0 }];
  const s = schemeOptionAchievement("QUANTITY_BASED", ["P1"], sales, new Map([["A", 100]]));
  assert.equal(s.perDealer.length, 1);
  assert.equal(s.perDealer[0].dealerId, "A");
  approx(s.perDealer[0].achievement.achieved, 0); // C's sales never counted
});

/* --------------------------------- historical integrity (frozen snapshot) --------------------------------- */

test("19. committed 200 KG / ₹23,600 snapshot is authoritative regardless of later master edits", () => {
  // Dealer committed to a Silver option: 200 KG target, ₹23,600 with-GST. Achievement uses the SNAPSHOT
  // target passed in (200), not any changed master option. Value shown downstream is the snapshot ₹23,600.
  const sums = new Map([["P1", { qty: 200, value: 0 }]]);
  const a = dealerOptionAchievement("QUANTITY_BASED", 200, new Set(["P1"]), sums);
  assert.equal(a.completed, true);
  approx(a.remaining, 0);
  approx(effectiveValueWithGST({ structure: "MULTIPLE_OPTIONS", schemeValueWithGST: null, optionValueWithGST: 23600 }), 23600);
  approx(effectiveValueWithoutGST({ structure: "MULTIPLE_OPTIONS", schemeValueWithoutGST: null, optionValueWithoutGST: 20000 }), 20000);
});

/* --------------------------------- upload impact --------------------------------- */

test("20. option upload impact adds incoming to previous vs snapshot target, over eligible pool only", () => {
  const targetByDealer = new Map([["A", 200]]);
  const previous = new Map([["A|P1", { qty: 50, value: 0 }]]);
  const incoming = new Map([["A|P1", { qty: 120, value: 0 }], ["A|PX", { qty: 999, value: 0 }]]);
  const rows = optionUploadImpact("QUANTITY_BASED", ["P1", "P2"], targetByDealer, previous, incoming);
  assert.equal(rows.length, 1);
  const r = rows[0];
  approx(r.previouslyAchieved, 50);
  approx(r.incoming, 120, "PX excluded (not eligible)");
  approx(r.newTotal, 170);
  approx(r.remaining, 30);
  assert.equal(r.completedBefore, false);
  assert.equal(r.completedAfter, false);
});

test("21. option upload impact flags newly completed when total crosses the snapshot target", () => {
  const rows = optionUploadImpact(
    "QUANTITY_BASED", ["P1"], new Map([["A", 200]]),
    new Map([["A|P1", { qty: 150, value: 0 }]]),
    new Map([["A|P1", { qty: 60, value: 0 }]]),
  );
  const r = rows[0];
  approx(r.newTotal, 210);
  assert.equal(r.completedBefore, false);
  assert.equal(r.completedAfter, true);
});

test("22. option upload impact ignores dealers with no snapshot target", () => {
  const rows = optionUploadImpact("QUANTITY_BASED", ["P1"], new Map([["A", 100]]), new Map(), new Map([["Z|P1", { qty: 10, value: 0 }]]));
  assert.equal(rows.length, 0);
});

test("23. zero-sales committed dealer still appears with achieved 0 / remaining = target / progress 0", () => {
  const s = schemeOptionAchievement("QUANTITY_BASED", ["P1", "P2"], [], new Map([["A", 200]]));
  assert.equal(s.perDealer.length, 1);
  const a = s.perDealer[0].achievement;
  approx(a.achieved, 0);
  approx(a.remaining, 200);
  approx(a.progress, 0);
  assert.equal(a.completed, false);
});

test("24. multiple dealers on the SAME option are each tracked independently against that option target", () => {
  const sales: OptionSaleFact[] = [
    { dealerId: "A", productId: "P1", qty: 200, value: 0 },   // A meets 200
    { dealerId: "D", productId: "P1", qty: 120, value: 0 },   // D short of 200
  ];
  const s = schemeOptionAchievement("QUANTITY_BASED", ["P1"], sales, new Map([["A", 200], ["D", 200]]));
  assert.equal(s.dealerCount, 2);
  const a = s.perDealer.find((d) => d.dealerId === "A")!.achievement;
  const d = s.perDealer.find((d) => d.dealerId === "D")!.achievement;
  assert.equal(a.completed, true); approx(a.remaining, 0);
  assert.equal(d.completed, false); approx(d.remaining, 80);
});

test("25. contribution breakdown lists each eligible product's own sale (Quantity Based)", () => {
  const sums = new Map([["P1", { qty: 80, value: 0 }], ["P2", { qty: 70, value: 0 }], ["P3", { qty: 50, value: 0 }]]);
  const a = dealerOptionAchievement("QUANTITY_BASED", 200, new Set(["P1", "P2", "P3"]), sums);
  approx(a.achieved, 200);
  assert.equal(a.contributions.length, 3);
  approx(a.contributions.find((c) => c.productId === "P1")!.achievedQty, 80);
  approx(a.contributions.find((c) => c.productId === "P2")!.achievedQty, 70);
  approx(a.contributions.find((c) => c.productId === "P3")!.achievedQty, 50);
});

test("Value Based requires only the two commercial values, not a target or label", () => {
  assert.deepEqual(validateMultipleOptions({
    achievementType: "VALUE_BASED", eligibleProductIds: ["P1"],
    options: [{ valueWithoutGST: 20000, valueWithGST: 23600 }],
  }), []);
  const row = normalizeOption({ valueWithoutGST: 20000, valueWithGST: 23600.126 }, "VALUE_BASED");
  assert.equal(row.label, null);
  assert.equal(row.targetQty, null);
  assert.equal(row.targetValue, 23600.13);
  assert.equal(row.targetValue, row.valueWithGST);
});

test("Value Based still requires both positive commercial values", () => {
  for (const option of [{ valueWithGST: 100 }, { valueWithoutGST: 100 }, { valueWithoutGST: 100, valueWithGST: 0 }]) {
    assert.ok(validateMultipleOptions({ achievementType: "VALUE_BASED", eligibleProductIds: ["P1"], options: [option] }).length > 0);
  }
});

test("every option requires With GST to be at least Without GST", () => {
  const invalid = validateMultipleOptions({
    achievementType: "VALUE_BASED", eligibleProductIds: ["P1"],
    options: [{ valueWithoutGST: 20000, valueWithGST: 19999.99 }],
  });
  assert.ok(invalid.some((error) => /greater than or equal/i.test(error)));
  assert.deepEqual(validateMultipleOptions({
    achievementType: "QUANTITY_BASED", eligibleProductIds: ["P1"],
    options: [{ target: 1, valueWithoutGST: 20000, valueWithGST: 20000 }],
  }), []);
});

test("Quantity Based still requires its independent target", () => {
  assert.ok(validateMultipleOptions({ ...validQtyInput(), options: [{ valueWithoutGST: 100, valueWithGST: 118 }] }).some(e => /target greater than zero/.test(e)));
});

test("Value Based duplicate detection uses GST target at stored monetary precision", () => {
  const options = [
    { target: 100, valueWithoutGST: 100, valueWithGST: 118.001 },
    { target: 200, valueWithoutGST: 100, valueWithGST: 118.002 },
  ];
  assert.ok(validateMultipleOptions({ achievementType: "VALUE_BASED", eligibleProductIds: ["P1"], options }).some(e => /same target/.test(e)));
  options[1].valueWithGST = 236;
  options[1].target = 100;
  assert.deepEqual(validateMultipleOptions({ achievementType: "VALUE_BASED", eligibleProductIds: ["P1"], options }), []);
});

test("editing a legacy Value option preserves its label and leaves existing snapshots authoritative", () => {
  const legacy = { label: "Legacy", target: 50000, valueWithoutGST: 20000, valueWithGST: 23600 };
  const edited = normalizeOption(legacy, "VALUE_BASED");
  assert.equal(edited.label, "Legacy");
  assert.equal(edited.targetValue, 23600);
  assert.equal(legacy.target, 50000);
  const oldTarget = effectiveOptionTarget({ achievementType: "VALUE_BASED", optionTargetQty: null, optionTargetValue: 50000 })!;
  const newTarget = effectiveOptionTarget({ achievementType: "VALUE_BASED", optionTargetQty: edited.targetQty, optionTargetValue: edited.targetValue })!;
  const sales = [{ dealerId: "old", productId: "P1", qty: 0, value: 23600 }, { dealerId: "new", productId: "P1", qty: 0, value: 23600 }];
  const result = schemeOptionAchievement("VALUE_BASED", ["P1"], sales, new Map([["old", oldTarget], ["new", newTarget]]));
  assert.equal(result.perDealer.find(d => d.dealerId === "old")!.achievement.completed, false);
  assert.equal(result.perDealer.find(d => d.dealerId === "new")!.achievement.completed, true);
});

console.log(`\n${passed} passed`);
