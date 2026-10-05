/**
 * Day Book per-dealer aggregation — "Last Payment" source (pure). DB-free.
 *   npx tsx src/lib/daybook-aggregate.test.ts
 *
 * Covers the Last Payment rules: only Receipts count, latest Receipt wins, date+amount from the SAME row,
 * CN/SR ignored, per-dealer independence, and the empty state.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregateDaybookByDealer, type ClassifiedDaybookRow } from "./daybook-aggregate";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const receipt = (dealerId: string, dateISO: string | null, amount: number): ClassifiedDaybookRow =>
  ({ dealerId, isReceipt: true, isSrCr: false, date: dateISO ? new Date(dateISO) : null, creditAmount: amount });
const srcr = (dealerId: string, dateISO: string, amount: number): ClassifiedDaybookRow =>
  ({ dealerId, isReceipt: false, isSrCr: true, date: new Date(dateISO), creditAmount: amount });
const other = (dealerId: string, dateISO: string, amount: number): ClassifiedDaybookRow =>
  ({ dealerId, isReceipt: false, isSrCr: false, date: new Date(dateISO), creditAmount: amount });
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// 1) One Receipt → that Receipt's date and Credit Amount.
test("1) one Receipt → its date and credit amount", () => {
  const agg = aggregateDaybookByDealer([receipt("d1", "2026-09-25", 20000)]);
  const a = agg.get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-09-25");
  assert.equal(a.lastReceiptAmount, 20000);
  assert.equal(a.receipt, 20000);
});

// 2) Multiple Receipts → ONLY the latest Receipt's date + its amount (not a sum, not an earlier row).
test("2) multiple Receipts → latest date and ITS amount", () => {
  const agg = aggregateDaybookByDealer([
    receipt("d1", "2026-09-10", 5000),
    receipt("d1", "2026-09-25", 20000), // latest
    receipt("d1", "2026-09-18", 12000),
  ]);
  const a = agg.get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-09-25");
  assert.equal(a.lastReceiptAmount, 20000, "amount from the latest row, not summed (would be 37000)");
  assert.equal(a.receipt, 37000, "receipt SUM is still the total, but Last Payment uses the latest row only");
});

// 3) Receipt + CN → CN is ignored for Last Payment.
test("3) Receipt + CN → CN ignored", () => {
  const agg = aggregateDaybookByDealer([
    receipt("d1", "2026-09-20", 8000),
    srcr("d1", "2026-09-28", 3000), // CN/SR — a LATER date, but not a Receipt → must be ignored
  ]);
  const a = agg.get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-09-20", "CN's later date does not become Last Payment");
  assert.equal(a.lastReceiptAmount, 8000);
  assert.equal(a.srCr, 3000);
});

// 4) Receipt + SR + other → only Receipt determines Last Payment.
test("4) Receipt + SR + other types → only Receipt counts", () => {
  const agg = aggregateDaybookByDealer([
    other("d1", "2026-09-30", 99999), // Journal/Invoice etc — ignored entirely
    srcr("d1", "2026-09-29", 4000),
    receipt("d1", "2026-09-22", 15000),
  ]);
  const a = agg.get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-09-22");
  assert.equal(a.lastReceiptAmount, 15000);
});

// 5) No Receipt → empty Last Payment.
test("5) no Receipt → null date/amount (empty state)", () => {
  const agg = aggregateDaybookByDealer([srcr("d1", "2026-09-29", 4000), other("d1", "2026-09-30", 100)]);
  const a = agg.get("d1")!;
  assert.equal(a.lastReceiptDate, null);
  assert.equal(a.lastReceiptAmount, null);
  assert.equal(a.srCr, 4000);
});

// 6) Multiple dealers → each gets its OWN latest Receipt.
test("6) multiple dealers → independent latest Receipt each", () => {
  const agg = aggregateDaybookByDealer([
    receipt("d1", "2026-09-10", 1000),
    receipt("d2", "2026-09-11", 2000),
    receipt("d1", "2026-09-27", 7000), // d1 latest
    receipt("d2", "2026-09-05", 500),
  ]);
  assert.equal(iso(agg.get("d1")!.lastReceiptDate), "2026-09-27");
  assert.equal(agg.get("d1")!.lastReceiptAmount, 7000);
  assert.equal(iso(agg.get("d2")!.lastReceiptDate), "2026-09-11");
  assert.equal(agg.get("d2")!.lastReceiptAmount, 2000);
});

// 7) Date and amount always come from the SAME Receipt row (never mismatched).
test("7) latest date and amount are from the same row", () => {
  const agg = aggregateDaybookByDealer([
    receipt("d1", "2026-09-25", 20000), // latest date, its own amount 20000
    receipt("d1", "2026-09-01", 999999), // biggest amount but earliest date → must NOT be used
  ]);
  const a = agg.get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-09-25");
  assert.equal(a.lastReceiptAmount, 20000, "not the largest amount — the latest row's amount");
});

test("undated receipts add to the sum but never become the latest", () => {
  const agg = aggregateDaybookByDealer([receipt("d1", null, 5000), receipt("d1", "2026-09-02", 3000)]);
  const a = agg.get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-09-02");
  assert.equal(a.lastReceiptAmount, 3000);
  assert.equal(a.receipt, 8000);
  // Only undated receipts → no displayable Last Payment.
  const agg2 = aggregateDaybookByDealer([receipt("d9", null, 5000)]);
  assert.equal(agg2.get("d9")!.lastReceiptDate, null);
});

// 9) Column order: the Last Payment header sits IMMEDIATELY after Outstanding Till in the Month View.
test("9) Month View header order: Last Payment immediately after Outstanding Till", () => {
  const src = readFileSync(resolve("src/features/recovery/recovery-workspace.tsx"), "utf8");
  // Month View is the header block that has recovery.due right after overdue (Week View has thisWeeksDue).
  const monthHeader = src.slice(src.indexOf('labelKey="recovery.currentOutstanding"'));
  const till = monthHeader.indexOf('labelKey="recovery.outstandingTillDate"');
  const last = monthHeader.indexOf('labelKey="recovery.lastPayment"');
  const overdue = monthHeader.indexOf('labelKey="recovery.overdue"');
  assert.ok(till >= 0 && last >= 0 && overdue >= 0, "all three headers present");
  assert.ok(till < last && last < overdue, "order is Outstanding Till → Last Payment → Overdue");
});

test("10) Week View reuses the same dealer-level Last Payment immediately after Outstanding Till", () => {
  const src = readFileSync(resolve("src/features/recovery/recovery-workspace.tsx"), "utf8");
  const weekView = src.slice(src.indexOf("function WeekView"));
  const till = weekView.indexOf('labelKey="recovery.outstandingTillDate"');
  const last = weekView.indexOf('labelKey="recovery.lastPayment"');
  const overdue = weekView.indexOf('labelKey="recovery.overdue"');
  assert.ok(till >= 0 && last >= 0 && overdue >= 0, "all three Week View headers are present");
  assert.ok(till < last && last < overdue, "Week View order is Outstanding Till → Last Payment → Overdue");
  assert.equal((src.match(/<LastPaymentCell date=\{d\.lastPaymentDate\} amount=\{d\.lastPaymentAmount\} outstanding=\{d\.outstanding\} unavailableReason=\{d\.lastPaymentUnavailableReason\} \/>/g) ?? []).length, 2,
    "Month and Week View render the exact same dealer-level Last Payment fields through one shared cell");
  assert.ok(!weekView.slice(weekView.indexOf("<LastPaymentCell"), weekView.indexOf("<LastPaymentCell") + 100).includes("weekNo"),
    "Last Payment is independent of the selected week");
});

// 8) Last Payment is informational: the aggregate exposes it as a SEPARATE field and never feeds receipt/srCr
// math (the recovery figures Overdue/Due/Running/etc. are computed elsewhere and are untouched here).
test("8) Last Payment does not alter the receipt/srCr aggregation used by recovery figures", () => {
  const withReceipts = aggregateDaybookByDealer([receipt("d1", "2026-09-25", 20000), receipt("d1", "2026-09-10", 5000)]);
  // receipt/srCr sums are identical whether or not we look at lastReceipt — Last Payment is derived, not a driver.
  assert.equal(withReceipts.get("d1")!.receipt, 25000);
  assert.equal(withReceipts.get("d1")!.srCr, 0);
});

// 9) Same-day Receipts: the Last Payment DATE is the latest dated Receipt (unchanged); the AMOUNT is the sum of the
// Receipts on that date only — older dates, CN/SR and undated Receipts never contribute.
test("9) several Receipts on the latest date → their SUM; older dates excluded", () => {
  const agg = aggregateDaybookByDealer([
    receipt("d1", "2026-10-05", 20000), receipt("d1", "2026-10-05", 15000), receipt("d1", "2026-10-05", 10000),
    receipt("d1", "2026-10-03", 50000),
  ]);
  const a = agg.get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-10-05");
  assert.equal(a.lastReceiptAmount, 45000, "20,000 + 15,000 + 10,000 — not 10,000, 20,000, 50,000 or 95,000");
  assert.equal(a.receipt, 95000, "the receipt total used by recovery figures is untouched");
});
test("10) latest date with a smaller total than an older date still wins", () => {
  const a = aggregateDaybookByDealer([receipt("d1", "2026-10-05", 20000), receipt("d1", "2026-10-05", 10000), receipt("d1", "2026-10-03", 100000)]).get("d1")!;
  assert.equal(iso(a.lastReceiptDate), "2026-10-05");
  assert.equal(a.lastReceiptAmount, 30000);
});
test("11) the sum is order-independent and ignores CN/SR/other and undated rows", () => {
  const rows = [
    receipt("d1", "2026-10-05", 20000), srcr("d1", "2026-10-05", 7000), other("d1", "2026-10-05", 9000),
    receipt("d1", null, 12345), receipt("d1", "2026-10-05", 15000), receipt("d1", "2026-10-04", 1),
  ];
  for (const ordered of [rows, [...rows].reverse()]) {
    const a = aggregateDaybookByDealer(ordered).get("d1")!;
    assert.equal(iso(a.lastReceiptDate), "2026-10-05");
    assert.equal(a.lastReceiptAmount, 35000, "only the dated Receipts of that day");
  }
});
test("12) a single Receipt, and a dealer with only undated Receipts, are unchanged", () => {
  assert.equal(aggregateDaybookByDealer([receipt("d1", "2026-10-05", 20000)]).get("d1")!.lastReceiptAmount, 20000);
  const undated = aggregateDaybookByDealer([receipt("d1", null, 5000)]).get("d1")!;
  assert.equal(undated.lastReceiptDate, null); assert.equal(undated.lastReceiptAmount, null);
});
test("13) dealers are summed independently", () => {
  const agg = aggregateDaybookByDealer([receipt("d1", "2026-10-05", 1), receipt("d2", "2026-10-05", 10), receipt("d1", "2026-10-05", 2), receipt("d2", "2026-10-05", 20)]);
  assert.deepEqual([agg.get("d1")!.lastReceiptAmount, agg.get("d2")!.lastReceiptAmount], [3, 30]);
});

console.log(`\n${passed} daybook-aggregate tests passed`);
