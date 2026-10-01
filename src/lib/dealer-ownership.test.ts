/**
 * Current dealer ownership predicate (pure). DB-free.
 *   npx tsx src/lib/dealer-ownership.test.ts
 *
 * Models the reassignment scenario: after Dealer D moves SO-A → SO-B, current-ownership views show D under
 * SO-B only, never under SO-A — while historical rows (which still name SO-A) are never rewritten.
 */
import assert from "node:assert/strict";
import { isCurrentlyOwnedBy, resolveCurrentOwner } from "./dealer-ownership";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// Simulate a Territory view that lists historical plan rows per officer, then filters to current ownership.
interface PlanDealerRow { dealerId: string; planOfficerId: string } // row sourced from a historical plan
function currentlyOwnedRows(rows: PlanDealerRow[], currentOwner: Map<string, string>): PlanDealerRow[] {
  return rows.filter((r) => isCurrentlyOwnedBy(currentOwner.get(r.dealerId), r.planOfficerId));
}

test("1-4) reassigned dealer resolves to the NEW officer only (not the old one)", () => {
  // Dealer D had a plan row under SO-A (historical) and now also under SO-B; current owner = SO-B.
  const rows: PlanDealerRow[] = [
    { dealerId: "D", planOfficerId: "SO-A" }, // stale historical membership
    { dealerId: "D", planOfficerId: "SO-B" }, // current officer's plan
  ];
  const currentOwner = new Map([["D", "SO-B"]]);
  const visible = currentlyOwnedRows(rows, currentOwner);
  assert.deepEqual(visible.map((r) => r.planOfficerId), ["SO-B"], "D shows under SO-B only");
  assert.ok(!visible.some((r) => r.planOfficerId === "SO-A"), "D must NOT show under SO-A");
});

test("8) reverse reassignment SO-B → SO-A works dynamically", () => {
  const rows: PlanDealerRow[] = [
    { dealerId: "D", planOfficerId: "SO-A" },
    { dealerId: "D", planOfficerId: "SO-B" },
  ];
  const currentOwner = new Map([["D", "SO-A"]]); // moved back
  const visible = currentlyOwnedRows(rows, currentOwner);
  assert.deepEqual(visible.map((r) => r.planOfficerId), ["SO-A"]);
});

test("a never-reassigned dealer still shows under its single owner (no behaviour change)", () => {
  const rows: PlanDealerRow[] = [{ dealerId: "X", planOfficerId: "SO-A" }];
  const currentOwner = new Map([["X", "SO-A"]]);
  assert.deepEqual(currentlyOwnedRows(rows, currentOwner).map((r) => r.dealerId), ["X"]);
});

test("a dealer with NO current assignment keeps legacy visibility (not hidden)", () => {
  const rows: PlanDealerRow[] = [{ dealerId: "L", planOfficerId: "SO-A" }];
  const currentOwner = new Map<string, string>(); // no assignment row
  assert.deepEqual(currentlyOwnedRows(rows, currentOwner).map((r) => r.dealerId), ["L"]);
});

test("a dealer reassigned OUT of the group shows under no in-group officer", () => {
  const rows: PlanDealerRow[] = [
    { dealerId: "D", planOfficerId: "SO-A" },
    { dealerId: "D", planOfficerId: "SO-B" },
  ];
  const currentOwner = new Map([["D", "SO-OTHER-GROUP"]]);
  assert.equal(currentlyOwnedRows(rows, currentOwner).length, 0);
});

test("predicate truth table", () => {
  assert.equal(isCurrentlyOwnedBy("o1", "o1"), true);
  assert.equal(isCurrentlyOwnedBy("o2", "o1"), false);
  assert.equal(isCurrentlyOwnedBy(null, "o1"), true);
  assert.equal(isCurrentlyOwnedBy(undefined, "o1"), true);
});

// resolveCurrentOwner — the real root-cause guard: a dealer may have MORE THAN ONE open assignment if a prior
// reassignment failed to close an older row. The MOST RECENT open assignment (latest effectiveFrom) must win,
// so ownership never resolves to a stale older officer.
test("resolveCurrentOwner: single open assignment", () => {
  assert.equal(resolveCurrentOwner([{ officerId: "SO-B", effectiveFrom: "2026-09-21" }]), "SO-B");
});
test("resolveCurrentOwner: none → null", () => {
  assert.equal(resolveCurrentOwner([]), null);
});
test("resolveCurrentOwner: TWO open rows (old SO-A + new SO-B) → most recent (SO-B) wins, regardless of order", () => {
  // This is the exact reported shape: an older open Sunil row lingering alongside the new open Shivveer row.
  const rows = [
    { officerId: "SO-A", effectiveFrom: "2026-09-07" }, // older open (should have been closed)
    { officerId: "SO-B", effectiveFrom: "2026-09-21" }, // newest open → current owner
  ];
  assert.equal(resolveCurrentOwner(rows), "SO-B");
  assert.equal(resolveCurrentOwner([...rows].reverse()), "SO-B", "order-independent");
});
test("resolveCurrentOwner: equal effectiveFrom → latest createdAt breaks the tie deterministically", () => {
  const same = "2026-09-21T00:00:00Z";
  assert.equal(resolveCurrentOwner([
    { officerId: "SO-A", effectiveFrom: same, createdAt: "2026-09-21T10:00:00Z" },
    { officerId: "SO-B", effectiveFrom: same, createdAt: "2026-09-21T12:00:00Z" },
  ]), "SO-B");
});
test("resolveCurrentOwner handles Date and epoch inputs", () => {
  assert.equal(resolveCurrentOwner([
    { officerId: "SO-A", effectiveFrom: new Date("2026-06-01") },
    { officerId: "SO-B", effectiveFrom: Date.parse("2026-09-21") },
  ]), "SO-B");
});

console.log(`\n${passed} dealer-ownership tests passed`);
