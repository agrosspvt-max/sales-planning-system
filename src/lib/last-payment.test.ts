/**
 * Last Payment carry-forward selection (pure). DB-free.
 *   npx tsx src/lib/last-payment.test.ts
 *
 * Mirrors the acceptance scenario: Day Book has 12-Apr ₹10,000 and 06-Jun ₹5,000; each Recovery Plan month
 * shows the latest receipt on or before its explicit month-end, carried forward until a newer receipt supersedes it.
 */
import assert from "node:assert/strict";
import { lastPaymentMonthEnd, latestReceiptAsOf, type ReceiptPoint } from "./last-payment";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// The dealer's individual known receipt points.
const APR: ReceiptPoint = { date: "2026-04-12", amount: 10000 };
const JUN: ReceiptPoint = { date: "2026-06-06", amount: 5000 };
// Explicit calendar month-end boundaries.
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

const forMonth = (points: ReceiptPoint[], calendarMonth: number, calendarYear: number) =>
  latestReceiptAsOf(points, lastPaymentMonthEnd({ calendarMonth, calendarYear })!.toISOString().slice(0, 10));
test("A) multi-year receipts carry forward through all existing April–November months", () => {
  const points = [
    { date: "2024-01-10", amount: 10000 },
    { date: "2025-02-15", amount: 20000 },
    { date: "2026-03-10", amount: 30000 },
  ];
  for (let month = 4; month <= 11; month++)
    assert.deepEqual(forMonth(points, month, 2026), points[2]);
  const later = { date: "2026-07-15", amount: 40000 };
  for (let month = 4; month <= 11; month++)
    assert.deepEqual(forMonth([...points, later], month, 2026), month < 7 ? points[2] : later);
});
test("C) no eligible receipt stays blank before the first payment month", () => {
  const first = { date: "2026-08-10", amount: 123 };
  for (let month = 4; month <= 11; month++)
    assert.deepEqual(forMonth([first], month, 2026), month < 8 ? null : first);
});
test("D) full calendar years and December-to-January boundaries", () => {
  const points = [
    { date: "2025-12-31", amount: 1 },
    { date: "2026-01-31", amount: 2 },
    { date: "2026-12-31", amount: 3 },
  ];
  assert.deepEqual(forMonth(points, 12, 2025), points[0]);
  assert.deepEqual(forMonth(points, 1, 2026), points[1]);
  assert.deepEqual(forMonth(points, 12, 2026), points[2]);
  assert.deepEqual(forMonth(points, 1, 2027), points[2]);
});
test("month-end uses UTC and Gregorian leap-year rules", () => {
  for (const [year, month, expected] of [[2024, 2, "2024-02-29"], [2026, 2, "2026-02-28"], [2100, 2, "2100-02-28"], [2026, 4, "2026-04-30"]] as const)
    assert.equal(lastPaymentMonthEnd({ calendarMonth: month, calendarYear: year })!.toISOString(), `${expected}T00:00:00.000Z`);
  const leap = { date: "2024-02-29", amount: 100 };
  assert.deepEqual(forMonth([leap, { date: "2024-03-01", amount: 200 }], 2, 2024), leap);
});
test("unresolved identities never infer a year from name, order or cutoff", () => {
  for (const period of [
    {}, { calendarMonth: 4 }, { calendarYear: 2026 },
    { calendarMonth: null, calendarYear: null },
    { calendarMonth: 0, calendarYear: 2026 }, { calendarMonth: 13, calendarYear: 2026 },
    { calendarMonth: 4, calendarYear: 1999 }, { calendarMonth: 4, calendarYear: 2101 },
    { calendarMonth: 4.5, calendarYear: 2026 }, { calendarMonth: 4, calendarYear: 2026.5 },
  ]) {
    const legacy = { ...period, name: "April", order: 1, cutoffDate: new Date("2026-04-30") };
    assert.equal(lastPaymentMonthEnd(legacy), null);
  }
});
test("equal-date receipts still select one amount with existing first-on-tie precedence", () => {
  const existing = { date: "2026-04-30", amount: 100 };
  assert.deepEqual(forMonth([existing, { date: existing.date, amount: 999 }], 4, 2026), existing);
});

console.log(`\n${passed} last-payment tests passed`);
