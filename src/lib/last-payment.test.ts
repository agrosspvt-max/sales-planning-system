/**
 * Last Payment carry-forward selection (pure). DB-free.
 *   npx tsx src/lib/last-payment.test.ts
 *
 * Mirrors the acceptance scenario: Day Book has 12-Apr ₹10,000 and 06-Jun ₹5,000; each Recovery Plan month
 * shows the latest receipt on or before its cutoff, carried forward until a newer receipt supersedes it.
 */
import assert from "node:assert/strict";
import { latestReceiptAsOf, type ReceiptPoint } from "./last-payment";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// The dealer's known receipt points (as persisted per-month by the Day Book upload).
const APR: ReceiptPoint = { date: "2026-04-12", amount: 10000 };
const JUN: ReceiptPoint = { date: "2026-06-06", amount: 5000 };
// Month cutoffs (end-of-month style; any date within the month works the same for the comparison).
const cut = { apr: "2026-04-30", may: "2026-05-31", jun: "2026-06-30", jul: "2026-07-31", aug: "2026-08-31", mar: "2026-03-31" };

// 1) April shows the April receipt.
test("1) April → 12-Apr ₹10,000", () => {
  assert.deepEqual(latestReceiptAsOf([APR], cut.apr), APR);
});
// 2-3) No new receipt in May/June → April receipt carries forward.
test("2) May (no new receipt) → still 12-Apr ₹10,000", () => {
  assert.deepEqual(latestReceiptAsOf([APR], cut.may), APR);
});
test("3) June (before a June receipt exists) → still 12-Apr ₹10,000", () => {
  assert.deepEqual(latestReceiptAsOf([APR], cut.jun), APR);
});
// 4) A June receipt now exists → June shows the June receipt.
test("4) June (06-Jun receipt present) → 06-Jun ₹5,000", () => {
  assert.deepEqual(latestReceiptAsOf([APR, JUN], cut.jun), JUN);
});
// 5) July/August with no newer receipt → carry the June receipt.
test("5) July carries 06-Jun ₹5,000", () => {
  assert.deepEqual(latestReceiptAsOf([APR, JUN], cut.jul), JUN);
});
test("5b) August carries 06-Jun ₹5,000", () => {
  assert.deepEqual(latestReceiptAsOf([APR, JUN], cut.aug), JUN);
});
// 6) A receipt AFTER the plan cutoff must not affect that historical plan (May must stay 12-Apr even though a
//    06-Jun receipt exists in the data).
test("6) receipt after cutoff is ignored → May stays 12-Apr even though 06-Jun exists", () => {
  assert.deepEqual(latestReceiptAsOf([APR, JUN], cut.may), APR);
});
// 8) Multiple receipts → latest on or before cutoff.
test("8) multiple receipts → latest on/before cutoff", () => {
  const pts: ReceiptPoint[] = [{ date: "2026-05-02", amount: 1 }, { date: "2026-05-20", amount: 2 }, { date: "2026-05-10", amount: 3 }];
  assert.deepEqual(latestReceiptAsOf(pts, cut.may), { date: "2026-05-20", amount: 2 });
});
// 9) Date and amount come from the SAME receipt (not the largest amount).
test("9) date and amount from the same receipt row", () => {
  const pts: ReceiptPoint[] = [{ date: "2026-04-12", amount: 10000 }, { date: "2026-04-01", amount: 999999 }];
  assert.deepEqual(latestReceiptAsOf(pts, cut.apr), { date: "2026-04-12", amount: 10000 });
});
// 10) No receipt history → null (empty state).
test("10) no receipts → null", () => {
  assert.equal(latestReceiptAsOf([], cut.jul), null);
});
// 11) Historical stability: adding a July receipt does not change May's result.
test("11) adding a later receipt does not change an earlier month", () => {
  const before = latestReceiptAsOf([APR], cut.may);
  const after = latestReceiptAsOf([APR, { date: "2026-07-03", amount: 777 }], cut.may);
  assert.deepEqual(after, before, "May unchanged by a July upload");
  assert.deepEqual(after, APR);
});
// Order-independence (deterministic).
test("order-independent result", () => {
  assert.deepEqual(latestReceiptAsOf([JUN, APR], cut.aug), JUN);
  assert.deepEqual(latestReceiptAsOf([APR, JUN], cut.aug), JUN);
});
// All receipts after cutoff → null (e.g. a plan month earlier than the first receipt).
test("all receipts after cutoff → null (empty state for an earlier month)", () => {
  assert.equal(latestReceiptAsOf([APR, JUN], cut.mar), null);
});

console.log(`\n${passed} last-payment tests passed`);
