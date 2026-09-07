/**
 * Phase 7 — Scheme Upload tests.
 *
 * The upload's pure decision logic (date-range validation, per-scheme validity, enrolled+required
 * contribution filter) lives in `scheme-upload-logic.ts` and is tested directly. The achievement
 * arithmetic is the Phase 4 engine (`uploadImpact`), tested via the exact previous+incoming scenarios the
 * upload composes. The DB-level flows (analyze/commit against Postgres) cannot run in this sandbox (no DB
 * + Prisma engine 403), so isolation / atomicity / supersede-history are asserted STATICALLY against the
 * committed server source (mandatory isolation regression), and the DB behaviour is documented in the
 * report. Runnable: `npx tsx src/lib/scheme-upload.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRange, schemeRangeInvalidReason, filterIncoming, type SchemeRangeMeta } from "./scheme-upload-logic";
import { uploadImpact, type SchemeRequirement } from "./scheme-achievement";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const fact = (dealerId: string, productId: string, qty: number, value: number) => ({ dealerId, productId, qty, value });
const matchedMap = (fs: { dealerId: string; productId: string; qty: number; value: number }[]) =>
  new Map(fs.map((f) => [`${f.dealerId}|${f.productId}`, f]));
const qv = (pairs: [string, { qty: number; value: number }][]) => new Map(pairs);

/* ------------------------- 1 & 2: date range validation ------------------------- */

test("1. Date range validation: required, and Start ≤ End", () => {
  assert.equal(validateRange("", "2026-09-10").ok, false);
  assert.equal(validateRange("2026-08-25", "").ok, false);
  assert.equal(validateRange("2026-09-10", "2026-08-25").ok, false); // start after end
  assert.equal(validateRange("2026-08-25", "2026-08-25").ok, true);  // single day inclusive
});
test("2. Cross-month range is valid", () => {
  const r = validateRange("2026-08-25", "2026-09-10");
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.range.start.getTime() < r.range.end.getTime());
});

/* ------------------------- 24: NONE + out-of-period validity ------------------------- */

const range = (() => { const r = validateRange("2026-08-25", "2026-09-10"); if (!r.ok) throw new Error("bad"); return r.range; })();
const meta = (o: Partial<SchemeRangeMeta>): SchemeRangeMeta => ({ requirementType: "PRODUCT_BASED", isPerpetual: false, startDate: null, endDate: null, ...o });

test("24. NONE-requirement scheme is rejected for upload", () => {
  assert.match(schemeRangeInvalidReason(meta({ requirementType: "NONE" }), range) ?? "", /NONE/);
});
test("6b. Scheme is not silently processed outside its valid period", () => {
  assert.match(schemeRangeInvalidReason(meta({ startDate: new Date("2026-09-01"), endDate: new Date("2026-09-30") }), range) ?? "", /before the scheme/);
  assert.match(schemeRangeInvalidReason(meta({ startDate: new Date("2026-08-01"), endDate: new Date("2026-09-05") }), range) ?? "", /after the scheme/);
  assert.equal(schemeRangeInvalidReason(meta({ startDate: new Date("2026-08-01"), endDate: new Date("2026-09-30") }), range), null); // range within period
  assert.equal(schemeRangeInvalidReason(meta({ isPerpetual: true }), range), null); // perpetual always in period
});

/* ------------------------- 3,4,7,8,9,10,14,20: contribution filter ------------------------- */

const FILE = matchedMap([
  fact("ABC", "ADAM", 700, 70000),   // enrolled + required (Adam) AND required in Special too
  fact("ABC", "ROTOMAXX", 300, 30000), // not required by Adam
  fact("XYZ", "ADAM", 500, 50000),   // XYZ not enrolled in Adam
  fact("ABC", "JUNK", 10, 1000),      // not a required product anywhere
]);

test("7,9. Enrolled dealer + required product is accepted", () => {
  const incoming = filterIncoming(FILE, new Set(["ABC"]), new Set(["ADAM", "ODIN"]));
  assert.ok(incoming.has("ABC|ADAM"));
  assert.deepEqual(incoming.get("ABC|ADAM"), { qty: 700, value: 70000 });
});
test("8. Non-enrolled dealer is excluded", () => {
  const incoming = filterIncoming(FILE, new Set(["ABC"]), new Set(["ADAM"]));
  assert.ok(!incoming.has("XYZ|ADAM"));
});
test("10. Non-required product is excluded", () => {
  const incoming = filterIncoming(FILE, new Set(["ABC"]), new Set(["ADAM"]));
  assert.ok(!incoming.has("ABC|ROTOMAXX"));
  assert.ok(!incoming.has("ABC|JUNK"));
});
test("20. Zero valid contributions when nothing enrolled+required", () => {
  const incoming = filterIncoming(FILE, new Set(["NOONE"]), new Set(["ADAM"]));
  assert.equal(incoming.size, 0);
});
test("14. Same uploaded fact contributes independently to two schemes", () => {
  // ABC|ADAM is enrolled+required in BOTH schemes → present in both incoming sets (never globally consumed).
  const adam = filterIncoming(FILE, new Set(["ABC"]), new Set(["ADAM", "ODIN"]));
  const special = filterIncoming(FILE, new Set(["ABC"]), new Set(["ADAM"]));
  assert.deepEqual(adam.get("ABC|ADAM"), { qty: 700, value: 70000 });
  assert.deepEqual(special.get("ABC|ADAM"), { qty: 700, value: 70000 });
});

/* ------------------------- 11: Product Based quantity calculation (uploadImpact) ------------------------- */

const productReq: SchemeRequirement = {
  type: "PRODUCT_BASED", valueMode: null, combinedRequiredValue: null,
  products: [{ productId: "ADAM", requiredQty: 1000, requiredValue: null }, { productId: "ODIN", requiredQty: 1000, requiredValue: null }],
};

test("11. Product Based: previous + incoming → new total & remaining", () => {
  const previous = qv([["ABC|ADAM", { qty: 500, value: 0 }], ["ABC|ODIN", { qty: 900, value: 0 }]]);
  const incoming = qv([["ABC|ADAM", { qty: 300, value: 0 }], ["ABC|ODIN", { qty: 200, value: 0 }]]);
  const rows = uploadImpact(productReq, previous, incoming, ["ABC"]);
  const adam = rows.find((r) => r.productId === "ADAM")!;
  const odin = rows.find((r) => r.productId === "ODIN")!;
  assert.deepEqual([adam.totalAchievedQty, adam.remainingQty, adam.completedAfter], [800, 200, false]);
  assert.deepEqual([odin.totalAchievedQty, odin.remainingQty, odin.completedAfter], [1100, 0, true]);
});

/* ------------------------- 12: Value Based INDIVIDUAL (uploadImpact) ------------------------- */

const valueIndReq: SchemeRequirement = {
  type: "VALUE_BASED", valueMode: "INDIVIDUAL", combinedRequiredValue: null,
  products: [{ productId: "ADAM", requiredQty: null, requiredValue: 200000 }, { productId: "ODIN", requiredQty: null, requiredValue: 150000 }],
};

test("12. Value Based INDIVIDUAL: per-product value totals & completion", () => {
  const previous = qv([["ABC|ADAM", { qty: 0, value: 100000 }]]);
  const incoming = qv([["ABC|ADAM", { qty: 0, value: 100000 }], ["ABC|ODIN", { qty: 0, value: 150000 }]]);
  const rows = uploadImpact(valueIndReq, previous, incoming, ["ABC"]);
  const adam = rows.find((r) => r.productId === "ADAM")!;
  const odin = rows.find((r) => r.productId === "ODIN")!;
  assert.deepEqual([adam.totalAchievedValue, adam.remainingValue, adam.completedAfter], [200000, 0, true]);
  assert.deepEqual([odin.totalAchievedValue, odin.remainingValue, odin.completedAfter], [150000, 0, true]);
});

/* ------------------------- 13: Value Based COMBINED (per-dealer rollup) ------------------------- */

const valueCombinedReq: SchemeRequirement = {
  type: "VALUE_BASED", valueMode: "COMBINED", combinedRequiredValue: 500000,
  products: [{ productId: "ADAM", requiredQty: null, requiredValue: null }, { productId: "ODIN", requiredQty: null, requiredValue: null }],
};

test("13. Value Based COMBINED: one target across products, per-dealer completion", () => {
  const previous = qv([["ABC|ADAM", { qty: 0, value: 100000 }], ["ABC|ODIN", { qty: 0, value: 50000 }]]);
  const incoming = qv([["ABC|ADAM", { qty: 0, value: 200000 }], ["ABC|ODIN", { qty: 0, value: 150000 }]]);
  const rows = uploadImpact(valueCombinedReq, previous, incoming, ["ABC"]);
  // Per-dealer combined = Σ product values (each counted once) — the server's combinedByDealer derivation.
  const prevCombined = rows.reduce((s, r) => s + r.previouslyAchievedValue, 0);
  const afterCombined = rows.reduce((s, r) => s + r.totalAchievedValue, 0);
  assert.equal(prevCombined, 150000);
  assert.equal(afterCombined, 500000);
  assert.equal(afterCombined >= 500000, true); // newly complete (was 150000 < 500000)
});

/* ------------------------- 19: existing exact scope excluded from "previous" ------------------------- */

test("19. Replacement: previous excludes the exact-range scope (no self double-count)", () => {
  // computeSchemeUploadImpact excludes the exact-range scope from `previous`; here we pass previous = only
  // OTHER active scopes, so projected = other + incoming, never other + oldSameRange + incoming.
  const otherActive = qv([["ABC|ADAM", { qty: 200, value: 0 }]]); // a different date range's active data
  const incoming = qv([["ABC|ADAM", { qty: 700, value: 0 }]]);    // the re-uploaded range
  const rows = uploadImpact(productReq, otherActive, incoming, ["ABC"]);
  const adam = rows.find((r) => r.productId === "ADAM")!;
  assert.equal(adam.totalAchievedQty, 900); // 200 + 700, NOT 200 + oldSameRange + 700
});

/* ------------------------- 21,22,23: static isolation / atomicity / history guarantees ------------------------- */

const serverSrc = readFileSync(fileURLToPath(new URL("../features/schemes/scheme-upload.server.ts", import.meta.url)), "utf8");

test("21. ISOLATION (mandatory): Scheme Upload server never accesses normal Sales Planning tables", () => {
  // Match ACTUAL Prisma accessors (dotted, case-sensitive) so doc-comment mentions like "MonthlyEntry"
  // don't false-positive. None of these client accessors may appear in the Scheme Upload server.
  for (const accessor of [".monthlyEntry", ".planLine", ".planDealer", ".salesUploadRun", ".seasonPlan", ".monthlyEntry"]) {
    assert.ok(!serverSrc.includes(accessor), `scheme-upload.server.ts must not access ${accessor}`);
  }
  assert.ok(!serverSrc.includes("commitSalesUpload"), "must not call the normal Sales Upload commit");
  // It DOES write only the three scheme tracking tables.
  for (const allowed of ["schemeUploadBatch", "schemeUploadBatchScheme", "schemeSale"]) {
    assert.ok(new RegExp(allowed, "i").test(serverSrc), `scheme-upload.server.ts should write ${allowed}`);
  }
});
test("22. Commit is atomic (wrapped in a single prisma.$transaction)", () => {
  assert.ok(/prisma\.\$transaction/.test(serverSrc));
});
test("23. Replacement supersedes (never deletes) — history is preserved", () => {
  assert.ok(/SUPERSEDED/.test(serverSrc));
  assert.ok(!/schemeSale\.delete/i.test(serverSrc), "SchemeSale rows must never be deleted");
  assert.ok(!/deleteMany/i.test(serverSrc), "Scheme Upload commit must not delete any rows");
});
test("17. Supersede is scoped by scheme + exact range (replacing A never affects B)", () => {
  // updateMany filters by schemeId + exact startDate/endDate, so only the re-uploaded scheme's scope flips.
  assert.ok(/updateMany\(\{\s*where:\s*\{\s*schemeId/.test(serverSrc.replace(/\n/g, " ")) || /schemeId: p\.schemeId, status: SchemeUploadStatus\.ACTIVE, startDate: range\.start, endDate: range\.end/.test(serverSrc));
});

console.log(`\n${passed} passed`);
