import assert from "node:assert/strict";
import { outstandingChanges, savedOutstandingChanges } from "./changes";
const candidate = (dealerId: string, outstanding: string, ledger: unknown | null = {}) => ({
  alias: { dealerId, name: "Dealer " + dealerId },
  ledger,
  amounts: { outstanding },
});
const before = new Map([
  ["same", 10000n],
  ["changed", 10000n],
  ["credit", 0n],
  ["zero", 10000n],
  ["already-zero", 0n],
  ["penny", 10000n],
]);
const records = outstandingChanges(
  [
    candidate("same", "100.00"),
    candidate("changed", "80.00"),
    candidate("credit", "-5000.00"),
    candidate("zero", "0.00", null),
    candidate("already-zero", "0.00", null),
    candidate("penny", "100.01"),
  ],
  before,
);
assert.deepEqual(
  records.map((x) => x.dealerId),
  ["changed", "credit", "zero", "penny"],
);
assert.equal(records[0].before, "100.00");
assert.equal(records[0].after, "80.00");
assert.equal(records[1].reason, "CREDIT_ADVANCE");
assert.equal(records[2].reason, "UNAVAILABLE_ZERO");
assert.equal(records[3].after, "100.01", "penny changes must not be rounded away");
before.set("changed", 99900n);
assert.equal(records[0].before, "100.00", "history must retain the amount captured at publication");
assert.throws(
  () => outstandingChanges([candidate("missing", "10.00")], before),
  /MISSING_PREVIOUS/,
);
assert.deepEqual(savedOutstandingChanges(JSON.stringify({ outstandingChanges: [] })), {
  recorded: true,
  changes: [],
});
assert.equal(
  savedOutstandingChanges('{"source":"TALLY"}').recorded,
  false,
  "older snapshots must not invent previous values",
);
assert.equal(savedOutstandingChanges("invalid").recorded, false);
assert.equal(savedOutstandingChanges(null).recorded, false);
const saved = savedOutstandingChanges(
  JSON.stringify({
    outstandingChanges: [...records, { ...records[0], before: "80.00", after: "80.00" }],
  }),
);
assert.equal(saved.changes.length, 4, "same-before/after records must always be excluded");
assert.deepEqual(saved.changes, records);
console.log(
  "PASS outstanding change capture: identical exclusion, exact amounts, credits, zero rule and legacy history",
);
