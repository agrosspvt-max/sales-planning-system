import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  explainRecovery,
  recoveryDaybookVouchers,
  type RecoveryDaybookSource,
} from "./recovery-diagnostic";
import { publicRecoverySummary, recoveryEvidence } from "./recovery-evidence";
import { testLoader } from "../dealer-tags/test-loader";
import type { BillResult } from "./billwise";

const ledger = "MANSOON TEST";
const capturedAt = "2026-11-27T06:00:00.000Z";
const source = (
  id: string,
  date: string,
  movement: string,
  allocations: [string | null, string, string][],
  kind: RecoveryDaybookSource["kind"] = "credit",
): RecoveryDaybookSource => ({
  jobId: "job-" + date.slice(0, 7),
  monthKey: date.slice(0, 7),
  capturedAt,
  kind,
  voucher: {
    guid: id,
    ledgerName: ledger,
    date,
    voucherNumber: id,
    voucherType: kind === "credit" ? "Receipt" : "Sales",
    ...(kind === "credit"
      ? { creditAmount: movement.replace("-", "") }
      : { amount: movement, direction: "debit" }),
    billAllocations: {
      entryCount: allocations.length,
      entries: allocations.map(([billReference, referenceType, amount], i) => ({
        ledgerName: ledger,
        billReference,
        referenceType,
        amount,
        ledgerLineNumber: 1,
        allocationNumber: i + 1,
      })),
    },
  },
});
const sources = [
  source("CR/0112", "2026-07-14", "-38472.00", [
    ["14", "Agst Ref", "9970.00"],
    ["15", "Agst Ref", "2851.00"],
    ["old309", "Agst Ref", "8880.00"],
    ["old338", "Agst Ref", "1872.00"],
    ["CR/0112", "New Ref", "14899.00"],
  ]),
  source("0046", "2026-07-24", "13073.00", [["CR/0112", "Agst Ref", "-13073.00"]], "other"),
  source(
    "0141",
    "2026-09-10",
    "24885.00",
    [
      ["CR/0112", "Agst Ref", "-1826.00"],
      ["0141", "New Ref", "-23059.00"],
    ],
    "other",
  ),
  source("0152", "2026-09-14", "37958.00", [["0152", "New Ref", "-37958.00"]], "other"),
  source("Receipt1594", "2026-10-14", "-61017.00", [
    ["0141", "Agst Ref", "23059.00"],
    ["0152", "Agst Ref", "37958.00"],
  ]),
  source("Return0025", "2026-10-17", "-3142.00", [[null, "On Account", "3142.00"]]),
  source("0324", "2026-11-25", "8474.00", [["0324", "New Ref", "-8474.00"]], "other"),
];
// Gross party evidence and the displayed receipt/other source describe the same GUID.
const product: RecoveryDaybookSource = {
  ...sources[1],
  kind: "product",
  voucher: {
    guid: "0046",
    billDate: "2026-07-24",
    billNumber: "0046",
    typeName: "Sales",
    cancelled: false,
    optional: false,
    ledgerEntries: [
      { name: ledger, amount: "-13073.00" },
      { name: "CGST", amount: "311.25" },
    ],
  },
};
const coverage = Array.from({ length: 8 }, (_, i) => ({
  month: `2026-${String(i + 4).padStart(2, "0")}`,
  throughDate: i === 7 ? "2026-11-27" : "2026-10-31",
  capturedAt,
  complete: true,
}));
const base = {
  jobId: "job",
  ledgerName: ledger,
  dealerName: "Dealer",
  asOf: "2026-11-27",
  recoveryCapturedAt: capturedAt,
  reason: "BILLS_LEDGER_MISMATCH",
  coverage,
  evidence: {
    name: ledger,
    dealerId: "dealer",
    reason: "BILLS_LEDGER_MISMATCH",
    guid: "ledger-guid",
    closingOutstanding: "5332.00",
    pendingTotal: "8474.00",
    difference: "-3142.00",
    bills: [
      {
        reference: "0324",
        billDate: "2026-11-25",
        dueDate: "2026-11-25",
        pendingAmount: "8474.00",
      },
    ],
  },
};
const before = JSON.stringify({ base, sources, product });
const result = explainRecovery(base, [...sources, product]);
assert.equal(result.daybook.vouchers.length, 7);
assert.equal(result.daybook.movement, "-18241.00");
assert.equal(result.daybook.onAccount, "-3142.00");
assert.equal(result.daybook.allocationComplete, true);
assert.ok(result.messages.some((message) => message.includes("exactly matches")));
assert.equal(
  result.daybook.references.find((row) => row.reference === "CR/0112")?.movement,
  "0.00",
);
assert.equal(result.daybook.references.find((row) => row.reference === "0324")?.difference, "0.00");
assert.equal(result.daybook.references.find((row) => row.reference === "14")?.difference, null);
assert.equal(
  result.daybook.references.find((row) => row.reference === "14")?.openingReference,
  true,
);
assert.equal(JSON.stringify({ base, sources, product }), before);
const legacy = explainRecovery({ ...base, evidence: null }, sources);
assert.ok(legacy.messages.some((message) => message.includes("next Recovery sync")));
assert.ok(!legacy.messages.some((message) => message.includes("exactly matches")));
const partial = explainRecovery(
  { ...base, coverage: [{ ...coverage[0], complete: false }] },
  sources,
);
assert.equal(partial.coverageComplete, false);
assert.ok(!partial.messages.some((message) => message.includes("exactly matches")));
const truncated = explainRecovery(base, sources, true);
assert.equal(truncated.daybook.movement, null);
assert.equal(truncated.daybook.allocationComplete, false);
const withoutRefs = explainRecovery(base, [product]);
assert.equal(withoutRefs.daybook.allocationComplete, false);
const excluded = {
  ...sources[0],
  voucher: { ...(sources[0].voucher as object), reason: "cancelled" },
};
assert.equal(explainRecovery(base, [excluded]).daybook.movement, "0.00");
const newest = { ...excluded, jobId: "newer", capturedAt: "2026-11-27T07:00:00.000Z" };
assert.equal(
  explainRecovery(base, [sources[0], newest]).daybook.movement,
  "0.00",
  "latest cancellation suppresses older source",
);
const wrong = {
  ...product,
  voucher: {
    ...(product.voucher as object),
    ledgerEntries: [{ name: ledger, amount: "-13074.00" }],
  },
};
assert.equal(explainRecovery(base, [sources[1], wrong]).daybook.allocationComplete, false);
assert.equal(explainRecovery(base, [sources[1], wrong]).daybook.movement, null);
const afterCutoff = {
  ...sources[0],
  voucher: { ...(sources[0].voucher as object), date: "2026-11-28" },
};
assert.equal(recoveryDaybookVouchers([afterCutoff], ledger, base.asOf).vouchers.length, 0);
const report = {
  companyName: "Company",
  asOf: base.asOf,
  observedAt: capturedAt,
  ledgers: [{ name: ledger, guid: "g", closingBalance: "-5332.00" }],
  bills: [{ partyName: ledger, ...base.evidence.bills[0] }],
} as unknown as BillResult;
const saved = recoveryEvidence(
  report,
  [{ name: ledger, dealerId: "d", expectedGuid: null }],
  [{ name: ledger, reason: base.reason }],
);
assert.equal(saved.ledgers[0].difference, "-3142.00");
assert.equal(saved.ledgers[0].bills.length, 1);
assert.deepEqual(publicRecoverySummary({ held: [ledger], _recoveryEvidence: saved }), {
  held: [ledger],
});
const { RecoveryDiagnosticBody } = testLoader({ "@/lib/api-client": { api: {} } })(
  "src/features/tally/recovery-diagnostic-dialog.tsx",
) as typeof import("./recovery-diagnostic-dialog");
const html = renderToStaticMarkup(<RecoveryDiagnosticBody data={result} />);
assert.match(html, /Ledger closing outstanding/);
assert.match(html, /₹5,332.00/);
assert.match(html, /-₹3,142.00/);
assert.match(html, /Return0025/);
assert.match(html, /On Account/);
assert.match(html, /including GST/);
assert.match(html, /Opening balances are not inferred/);
assert.match(renderToStaticMarkup(<RecoveryDiagnosticBody data={legacy} />), /older Recovery read/);
console.log(
  "Recovery diagnostic: exact retained gap, gross signed Daybook/allocations, duplicate/version/flag guards, opening/coverage limits, private status and rendered evidence passed.",
);
