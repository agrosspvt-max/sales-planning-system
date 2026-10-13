/** Billing Exception — pure rules: Billing Status boundaries, missing payment, and the form / API validation. */
import assert from "node:assert/strict";
import { AUTH_PERSONS, summarizeExceptions, BILLING_BLOCK_DAYS, PAYMENT_DATE_PAST_MESSAGE, parseBillingAmount, BILLING_STATUS_LABEL, billingStatusClickable, billingStatusOf, parseExceptionView, validateBillingExceptionInput } from "./billing-exception";
import { daysSincePayment } from "./last-payment-report";

assert.equal(BILLING_BLOCK_DAYS, 45);
// Boundaries (Days ≤ 45 → Open; > 45 → Blocked unless a current exception exists)
assert.equal(billingStatusOf(0, 0), "OPEN");
assert.equal(billingStatusOf(44, 0), "OPEN");
assert.equal(billingStatusOf(45, 0), "OPEN", "exactly 45 is Open");
assert.equal(billingStatusOf(46, 0), "BLOCKED", "exactly 46 is Blocked");
assert.equal(billingStatusOf(46, 1), "BILLING_EXCEPTION");
assert.equal(billingStatusOf(500, 3), "BILLING_EXCEPTION");
assert.equal(billingStatusOf(45, 2), "OPEN", "an exception never changes an Open dealer");
assert.equal(billingStatusOf(10, 2), "OPEN");
// Missing payment data: a neutral, non-clickable state — never 0, never Open, never Blocked
for (const days of [null, undefined, Number.NaN]) assert.equal(billingStatusOf(days as number | null, 0), "UNAVAILABLE");
assert.equal(billingStatusOf(null, 5), "UNAVAILABLE", "…even when exceptions exist");
assert.deepEqual((["OPEN", "BLOCKED", "BILLING_EXCEPTION", "UNAVAILABLE"] as const).map(billingStatusClickable), [false, true, true, false], "only Blocked and Billing Exception are clickable");
assert.deepEqual(Object.values(BILLING_STATUS_LABEL), ["Open", "Blocked", "Billing Exception", "Unavailable"]);
// ONE Days calculation: the status is fed by the report's own daysSincePayment (calendar dates, no time of day)
assert.equal(billingStatusOf(daysSincePayment("2026-08-21", "2026-10-05"), 0), "OPEN", "2026-08-21 → 2026-10-05 is exactly 45 days");
assert.equal(billingStatusOf(daysSincePayment("2026-08-20", "2026-10-05"), 0), "BLOCKED", "…and one day earlier is 46");
assert.equal(billingStatusOf(daysSincePayment(null, "2026-10-05"), 0), "UNAVAILABLE");

// Auth Person: exactly the two fixed choices
assert.deepEqual([...AUTH_PERSONS], ["Varun sir", "Tej Sir"]);
const good = { dealerId: "d1", billingDate: "2026-10-01", billNo: " INV  7 ", authPerson: "Tej Sir", requestId: "req-12345678", billingAmount: "20,000.50", paymentCondition: "NO" };
const ok = validateBillingExceptionInput(good);
assert.ok("value" in ok && ok.value.billNo === "INV 7" && ok.value.authPerson === "Tej Sir", "Bill No is trimmed / whitespace-collapsed");
const bad = (over: Record<string, unknown>) => { const r = validateBillingExceptionInput({ ...good, ...over }); return "error" in r ? r.error : null; };
assert.equal(bad({ dealerId: "" }), "Select a dealer.");
assert.equal(bad({ billingDate: "" }), "Date of Billing is required.");
assert.equal(bad({ billingDate: "2026-02-30" }), "Enter a valid Date of Billing.");
assert.equal(bad({ billingDate: "01/10/2026" }), "Enter a valid Date of Billing.");
assert.equal(bad({ billNo: "   " }), "Bill No is required.");
assert.match(bad({ billNo: "x".repeat(61) })!, /at most 60/);
assert.equal(bad({ authPerson: "" }), "Select the Auth Person.");
for (const person of ["varun sir", "Varun Sir", "Tej sir", "Someone Else", "Varun sir "]) assert.equal(bad({ authPerson: person }), "Select the Auth Person.", `"${person}" is not an allowed choice`);
assert.match(bad({ requestId: "" })!, /request identity/);
assert.match(bad({ requestId: "short" })!, /request identity/);
// No invented date rule: past and future billing dates are both accepted.
assert.equal(bad({ billingDate: "1999-01-01" }), null);
assert.equal(bad({ billingDate: "2099-12-31" }), null);
assert.equal(validateBillingExceptionInput(null).hasOwnProperty("error"), true);
assert.equal(parseExceptionView("history"), "history");
assert.equal(parseExceptionView("current"), "current");
assert.equal(parseExceptionView(null), "current", "Billing Exception defaults to Current");
assert.equal(parseExceptionView("anything"), "current");

// Amount: required, positive, at most two decimals
assert.equal(bad({ billingAmount: undefined }), "Amount is required.");
assert.equal(bad({ billingAmount: "" }), "Amount is required.");
for (const v of ["0", "-5", "abc", "1.234", "1e5", 0, -1, Number.NaN]) assert.match(bad({ billingAmount: v })!, /positive Amount/, String(v));
assert.equal(parseBillingAmount("20,000.50"), 20000.5); assert.equal(parseBillingAmount(250), 250); assert.equal(parseBillingAmount("0.01"), 0.01);
// Payment condition: explicit Yes / No, mutually exclusive; Yes needs a real date, No never carries one
assert.equal(bad({ paymentCondition: undefined }), "Select Yes or No for the payment condition.");
assert.equal(bad({ paymentCondition: "" }), "Select Yes or No for the payment condition.");
assert.equal(bad({ paymentCondition: "MAYBE" }), "Select Yes or No for the payment condition.");
assert.equal(bad({ paymentCondition: "YES" }), "Date of Payment is required when there is a payment condition.");
assert.equal(bad({ paymentCondition: "YES", paymentDate: "2026-02-30" }), "Enter a valid Date of Payment.");
assert.equal(bad({ paymentCondition: "YES", paymentDate: "2026-10-20" }), "Payment is required when there is a payment condition.", "Payment is required — never defaulted from Amount");
assert.equal(bad({ paymentCondition: "YES", paymentDate: "2026-10-20", paymentAmount: "" }), "Payment is required when there is a payment condition.");
for (const v of ["0", "-5", "abc", "1.234", "12,3,4x"]) assert.equal(bad({ paymentCondition: "YES", paymentDate: "2026-10-20", paymentAmount: v }), "Enter a positive Payment with at most two decimals.", `Payment ${v}`);
assert.equal(bad({ paymentCondition: "YES", paymentDate: "2026-10-20", paymentAmount: "15000" }), null);
assert.equal(bad({ paymentCondition: "YES", paymentDate: "2026-10-20", paymentAmount: "1,50,000.50" }), null, "Indian grouping accepted");
const yes = validateBillingExceptionInput({ ...good, paymentCondition: "YES", paymentDate: "2026-10-20", paymentAmount: "15000" });
assert.ok("value" in yes && yes.value.paymentAmount === 15000 && yes.value.billingAmount === 20000.5 && yes.value.paymentDate === "2026-10-20" && yes.value.paymentCondition === "YES" && yes.value.billingAmount === 20000.5);
const no = validateBillingExceptionInput({ ...good, paymentCondition: "NO", paymentDate: "2026-10-20", paymentAmount: "500" });
assert.ok("value" in no && no.value.paymentDate === null && no.value.paymentAmount === null && no.value.paymentCondition === "NO", "switching to No excludes the date");
// today rule (server): a promised date in the past would rewrite submitted work → refused; today and later are fine
const withToday = (date: string, today: string) => { const r = validateBillingExceptionInput({ ...good, paymentCondition: "YES", paymentDate: date, paymentAmount: "1" }, today); return "error" in r ? r.error : null; };
assert.equal(withToday("2026-10-12", "2026-10-13"), PAYMENT_DATE_PAST_MESSAGE);
assert.equal(withToday("2026-10-13", "2026-10-13"), null);
assert.equal(withToday("2026-12-25", "2026-10-13"), null);
/* ---- summary panel: Total Ex. Bills / Dealers / Top Dealers / Top SO ---- */
{
  const src = (exceptionId: string, dealerId: string, party: string, officerId: string | null, amount: number | null, officerName = officerId ? `SO ${officerId}` : null) => ({ exceptionId, dealerId, party, officerId, officerName, billingAmount: amount });
  // the verified case: two exceptions of ONE dealer (₹23,000 + ₹12,000) under one Sales Officer
  const t5 = summarizeExceptions([src("e1", "d5", "test_dealer5", "so1", 23000, "Suresh Verma"), src("e2", "d5", "test_dealer5", "so1", 12000, "Suresh Verma")]);
  assert.deepEqual([t5.totalBills, t5.dealers], [2, 1], "two exceptions, one dealer");
  assert.deepEqual(t5.topDealers.byBills.map((e) => [e.id, e.name, e.bills, e.amount]), [["d5", "test_dealer5", 2, 35000]]);
  assert.deepEqual(t5.topOfficers.byBills.map((e) => [e.id, e.name, e.bills, e.amount]), [["so1", "Suresh Verma", 2, 35000]]);
  assert.equal(summarizeExceptions([]).totalBills, 0); assert.deepEqual(summarizeExceptions([]).topDealers.byBills, []);
  // five exceptions, two dealers → 5 bills, 2 dealers
  const five = summarizeExceptions(["a", "a", "a", "b", "b"].map((d, i) => src(`x${i}`, d, d.toUpperCase(), "so1", 10)));
  assert.deepEqual([five.totalBills, five.dealers], [5, 2]);
  // the same exception id delivered twice (a join duplicate) counts once
  assert.equal(summarizeExceptions([src("e1", "d", "D", "s", 5), src("e1", "d", "D", "s", 5)]).totalBills, 1);
  // each metric's ranking is computed from ALL entries (not a re-sort of the other metric's top few): 7 dealers, the 7th has the biggest amount
  const many = [...Array.from({ length: 6 }, (_, i) => [`d${i}`, 2, 100] as const), ["big", 1, 99999] as const].flatMap(([id, n, amt]) => Array.from({ length: n }, (_, k) => src(`${id}-${k}`, id, id, "so1", amt)));
  const m = summarizeExceptions(many);
  assert.equal(m.topDealers.byBills.length, 5); assert.ok(!m.topDealers.byBills.some((e) => e.id === "big"), "by bills: the one-bill dealer is not in the top five");
  assert.equal(m.topDealers.byAmount[0]!.id, "big", "by amount: it is recomputed and ranks first");
  // ties: deterministic (metric, then the other metric, then name, then id)
  const tie = summarizeExceptions([src("1", "z", "Zed", "s2", 50), src("2", "a", "Alpha", "s1", 50), src("3", "m", "Mid", "s3", 50)]);
  assert.deepEqual(tie.topDealers.byBills.map((e) => e.name), ["Alpha", "Mid", "Zed"], "equal bills and amounts → name order");
  assert.deepEqual(summarizeExceptions([src("1", "z", "Zed", "s", 50), src("2", "z", "Zed", "s", 50), src("3", "a", "Alpha", "s", 500)]).topDealers.byBills.map((e) => e.name), ["Zed", "Alpha"], "bills first");
  assert.deepEqual(summarizeExceptions([src("1", "z", "Zed", "s", 50), src("2", "z", "Zed", "s", 50), src("3", "a", "Alpha", "s", 500)]).topDealers.byAmount.map((e) => e.name), ["Alpha", "Zed"], "amount first");
  // legacy exceptions without a billing amount: no invented amount, flagged incomplete, still counted as bills
  const legacy = summarizeExceptions([src("1", "d", "D", "s", null), src("2", "d", "D", "s", 1000), src("3", "e", "E", "s", null)]);
  assert.deepEqual([legacy.totalBills, legacy.topDealers.byBills[0]!.amount, legacy.topDealers.byBills[0]!.incomplete, legacy.amountsIncomplete], [3, 1000, true, true]);
  assert.deepEqual(legacy.topDealers.byBills.find((e) => e.id === "e"), { id: "e", name: "E", bills: 1, amount: 0, incomplete: true }, "an all-legacy dealer sums to 0, flagged incomplete (not an invented value)");
  // no assigned Sales Officer: in the totals, out of the officer ranking
  const noSo = summarizeExceptions([src("1", "d", "D", null, 10), src("2", "d", "D", "s1", 20)]);
  assert.deepEqual([noSo.totalBills, noSo.topOfficers.byBills.map((e) => [e.id, e.bills, e.amount]), noSo.topDealers.byBills[0]!.amount], [2, [["s1", 1, 20]], 30]);
  // limits: five dealers / three officers
  const lim = summarizeExceptions(Array.from({ length: 9 }, (_, i) => src(`e${i}`, `d${i}`, `D${i}`, `s${i}`, i + 1)));
  assert.deepEqual([lim.topDealers.byBills.length, lim.topOfficers.byBills.length, lim.topOfficers.byAmount[0]!.id], [5, 3, "s8"]);
  // grouped by id, not name: two dealers sharing a name stay separate; one dealer renamed between rows stays one
  assert.equal(summarizeExceptions([src("1", "d1", "Same", "s", 1), src("2", "d2", "Same", "s", 1)]).dealers, 2);
  assert.equal(summarizeExceptions([src("1", "d1", "Old", "s", 1), src("2", "d1", "New", "s", 1)]).dealers, 1);
  // cents-safe sums
  assert.equal(summarizeExceptions([src("1", "d", "D", "s", 0.1), src("2", "d", "D", "s", 0.2)]).topDealers.byBills[0]!.amount, 0.3);
}
console.log("billing-exception.test.ts — all assertions passed");
