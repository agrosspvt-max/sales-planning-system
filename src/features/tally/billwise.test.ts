import assert from "node:assert/strict";
import {
  validateResult,
  resolveAliases,
  cents,
  decimal,
  bucket,
  scopeHash,
  indiaDay,
  type ScopeAlias,
} from "./billwise";
const now = new Date("2026-10-28T12:00:00Z"),
  anchor = "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00002385";
const scope: ScopeAlias[] = [
  { name: "DEALER (UP)", dealerId: "existing-cuid", expectedGuid: null },
];
const sample = () => ({
  version: "billwise.sync.v1",
  companyName: "Company",
  asOf: "2026-10-28",
  observedAt: now.toISOString(),
  sourceSha256: "a".repeat(64),
  anchor: { name: "Anchor", guid: anchor, closingBalance: "-100.00" },
  ledgers: [{ name: "DEALER (UP)", guid: anchor, closingBalance: "-100.00" }],
  unavailableNames: [] as string[],
  bills: [
    {
      partyName: "DEALER (UP)",
      billDate: "2023-07-27",
      reference: "old unpaid",
      pendingAmount: "100.00",
      dueDate: "2023-09-25",
    },
  ],
});
let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log("PASS", name);
}
const validate = (r: unknown, s = scope) =>
  validateResult(r, s, "Company", anchor, "2026-10-28", now);
test("exact cents and signed credit", () => {
  assert.equal(decimal(cents("123456789012.12")), "123456789012.12");
  assert.equal(decimal(cents("-0.01")), "-0.01");
  assert.throws(() => cents("NaN"));
  assert.throws(() => cents("1e2"));
});
test("calendar cutoff and month boundary", () => {
  assert.equal(bucket("2026-10-27", "2026-10-28"), "OVERDUE");
  assert.equal(bucket("2026-10-28", "2026-10-28"), "DUE");
  assert.equal(bucket("2026-11-01", "2026-10-28"), "RUNNING");
  assert.equal(indiaDay(new Date("2026-10-28T19:00Z")), "2026-10-29");
});
test("older open bills retained", () =>
  assert.equal(validate(sample()).accepted[0].amounts.overdue, "100.00"));
test("existing alias normalization", () => {
  const x = sample();
  x.bills[0].partyName = "Dealer-UP";
  assert.equal(validate(x).accepted.length, 1);
});
test("unknown parties never fuzzy matched", () => {
  const x = sample();
  x.bills[0].partyName = "DEALER OTHER UP";
  assert.throws(() => validate(x));
});
test("wrong company anchor or date rejected", () => {
  for (const f of ["companyName", "asOf"]) {
    assert.throws(() => validate({ ...sample(), [f]: "wrong" }));
  }
  const x = sample();
  x.anchor.guid = x.anchor.guid.replace("cb293b57", "ab293b57");
  assert.throws(() => validate(x));
});
test("stale/future reads cannot advance freshness", () => {
  const x = sample();
  x.observedAt = "2026-10-27T12:00:00Z";
  assert.throws(() => validate(x));
  x.observedAt = "2026-10-28T13:00:00Z";
  assert.throws(() => validate(x));
});
test("changed pinned GUID rejected", () =>
  assert.throws(() =>
    validate(sample(), [{ ...scope[0], expectedGuid: anchor.replace("2385", "2386") }]),
  ));
test("duplicate or incomplete ledger coverage rejected", () => {
  const x = sample();
  x.ledgers = [];
  assert.throws(() => validate(x));
  const y = sample();
  y.ledgers.push(y.ledgers[0]);
  assert.throws(() => validate(y));
});
test("duplicate bill identities rejected", () => {
  const x = sample();
  x.bills.push(x.bills[0]);
  assert.throws(() => validate(x));
});
test("invalid dates rejected", () => {
  const x = sample();
  x.bills[0].dueDate = "2026-02-30";
  assert.throws(() => validate(x));
});
test("ledger mismatch holds old values", () => {
  const x = sample();
  x.ledgers[0].closingBalance = "-90.00";
  const r = validate(x);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.held[0].reason, "BILLS_LEDGER_MISMATCH");
});
test("missing report entry requires an explicit zero ledger", () => {
  const x = sample();
  x.bills = [];
  assert.equal(validate(x).accepted.length, 0);
  x.ledgers[0].closingBalance = "0.00";
  assert.equal(validate(x).accepted[0].amounts.outstanding, "0.00");
});
test("dealer-level unavailable ledger becomes zero under user's Recovery rule", () => {
  const x = sample();
  x.ledgers = [];
  x.unavailableNames = [scope[0].name];
  const r = validate(x);
  assert.equal(r.held.length, 0);
  assert.deepEqual(r.accepted[0].amounts, {
    outstanding: "0.00",
    overdue: "0.00",
    due: "0.00",
    running: "0.00",
  });
  assert.equal(r.accepted[0].ledger, null);
  assert.equal(r.zeroedUnavailable.length, 1);
});
test("credit keeps negative outstanding", () => {
  const x = sample();
  x.ledgers[0].closingBalance = "100.00";
  x.bills[0].pendingAmount = "-100.00";
  assert.equal(validate(x).accepted[0].amounts.outstanding, "-100.00");
  assert.equal(validate(x).accepted[0].amounts.overdue, "0.00");
  assert.equal(validate(x).creditAdvances.length, 1);
});
test("credit advances need no receivable bills and never create recovery buckets", () => {
  const x = sample();
  x.ledgers[0].closingBalance = "5000.00";
  x.bills = [];
  assert.deepEqual(validate(x).accepted[0].amounts, {
    outstanding: "-5000.00",
    overdue: "0.00",
    due: "0.00",
    running: "0.00",
  });
  x.bills = sample().bills;
  assert.equal(validate(x).accepted[0].bills.length, 0);
});
test("verified zero closing clears old bill buckets even if gross bill rows remain", () => {
  const x = sample();
  x.ledgers[0].closingBalance = "0.00";
  assert.deepEqual(validate(x).accepted[0].amounts, {
    outstanding: "0.00",
    overdue: "0.00",
    due: "0.00",
    running: "0.00",
  });
  assert.equal(validate(x).accepted[0].bills.length, 0);
});
test("an unavailable old alias cannot zero a readable alias for the same dealer", () => {
  const x = sample();
  x.unavailableNames = ["Old Alias"];
  const r = validate(x, [
    { name: "Old Alias", dealerId: scope[0].dealerId, expectedGuid: null },
    ...scope,
  ]);
  assert.equal(r.zeroedUnavailable.length, 0);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].amounts.outstanding, "100.00");
});
test("positive debtor closing with a negative recovery bucket stays under review", () => {
  const x = sample();
  x.bills.push({
    ...x.bills[0],
    reference: "credit",
    pendingAmount: "-20.00",
    dueDate: "2026-11-01",
  });
  x.ledgers[0].closingBalance = "-80.00";
  assert.equal(validate(x).held[0].reason, "NEGATIVE_RECOVERY_BUCKET");
});
test("conflicting aliases excluded", () => {
  assert.equal(
    resolveAliases(
      [
        { tallyName: "A-B", systemDealerId: "a" },
        { tallyName: "AB", systemDealerId: "b" },
      ],
      new Set(["a", "b"]),
      new Map(),
    ).length,
    0,
  );
});
test("only current plan dealers scoped", () =>
  assert.equal(
    resolveAliases([{ tallyName: "Other", systemDealerId: "x" }], new Set(["a"]), new Map()).length,
    0,
  ));
test("mapping and plan changes invalidate scope", () => {
  assert.notEqual(scopeHash(scope, ["p"]), scopeHash(scope, ["q"]));
  assert.notEqual(scopeHash(scope, ["p"]), scopeHash([{ ...scope[0], dealerId: "other" }], ["p"]));
});
test("several live ledgers for one dealer held", () => {
  const x = sample();
  x.ledgers.push({
    name: "Second",
    guid: anchor.replace("2385", "2386"),
    closingBalance: "-20.00",
  });
  x.bills.push({ ...x.bills[0], partyName: "Second", pendingAmount: "20.00" });
  const r = validate(x, [
    ...scope,
    { name: "Second", dealerId: scope[0].dealerId, expectedGuid: null },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.held.length, 2);
});
test("oversized bucket held even when the net ledger fits", () => {
  const x = sample();
  x.ledgers[0].closingBalance = "-999999999999.99";
  x.bills = [
    { ...x.bills[0], reference: "one", pendingAmount: "999999999999.99" },
    { ...x.bills[0], reference: "two", pendingAmount: "999999999999.99" },
    {
      ...x.bills[0],
      reference: "credit",
      pendingAmount: "-999999999999.99",
      dueDate: "2026-11-01",
    },
  ];
  const r = validate(x);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.held[0].reason, "AGGREGATE_OUT_OF_RANGE");
});
console.log(`${passed} bill-wise tests passed`);
