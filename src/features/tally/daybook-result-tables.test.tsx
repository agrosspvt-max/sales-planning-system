import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { validateDaybookCapture } from "./daybook-preview";
import type { DaybookDealerRow, DaybookExcludedVoucher } from "./daybook-result-types";

const prefix = "cb293b57-f31b-464e-b2e1-42d4edb59b7d";
// Exercise actual connector output through the cloud schema and rendered tables.
const xml = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>
<VOUCHER><GUID>${prefix}-00000001</GUID><DATE>20261002</DATE><VOUCHERNUMBER>J-13</VOUCHERNUMBER><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><PARTYLEDGERNAME/><NARRATION>Rent &lt;adjustment&gt;</NARRATION>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent expense</LEDGERNAME><AMOUNT>-250.00</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>250.00</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER>
<VOUCHER><GUID>${prefix}-00000002</GUID><DATE>20261003</DATE><VOUCHERNUMBER>SJ-5</VOUCHERNUMBER><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Item A</STOCKITEMNAME><ACTUALQTY>-10 kg</ACTUALQTY><AMOUNT>-250.00</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>
<VOUCHER><GUID>${prefix}-00000003</GUID><DATE>20261004</DATE><VOUCHERNUMBER>R-31</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><PARTYLEDGERNAME>Dealer A</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Dealer A</LEDGERNAME><AMOUNT>125.50</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
<BILLALLOCATIONS.LIST><NAME>INV-100</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>70.00</AMOUNT></BILLALLOCATIONS.LIST>
<BILLALLOCATIONS.LIST><NAME>INV-101&lt;A&gt;</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>30.00</AMOUNT></BILLALLOCATIONS.LIST>
<BILLALLOCATIONS.LIST><BILLTYPE>On Account</BILLTYPE><AMOUNT>20.00</AMOUNT></BILLALLOCATIONS.LIST>
<BILLALLOCATIONS.LIST><NAME>ADV-1</NAME><BILLTYPE>Advance</BILLTYPE><AMOUNT>5.50</AMOUNT></BILLALLOCATIONS.LIST>
</ALLLEDGERENTRIES.LIST></VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const python = spawnSync(
  "python3",
  [
    "-B",
    "-c",
    `import json,sys; import daybook_capture as d; print(json.dumps(d.parse_vouchers(sys.stdin.buffer.read(),None,'${prefix}','2026-10-01','2026-10-31')))`,
  ],
  {
    cwd: resolve("../tally-connector-v1.3/Tally-Office-Connector"),
    input: xml,
    encoding: "utf8",
  },
);
assert.equal(python.status, 0, python.stderr);
const raw = {
  version: "daybook.capture.v1",
  companyName: "Synthetic Company",
  month: "2026-10",
  fromDate: "2026-10-01",
  throughDate: "2026-10-31",
  observedAt: "2026-11-19T10:00:00Z",
  uploaded: false,
  coverage: "all_vouchers",
  vouchers: JSON.parse(python.stdout),
};
const capture = validateDaybookCapture(
  raw,
  { companyName: raw.companyName, anchorGuid: prefix + "-00000009" },
  "2026-11-19",
);
assert.equal(capture.credits.length, 1);
assert.equal(capture.credits[0].billAllocations?.entries[1].billReference, "INV-101<A>");
assert.equal(capture.excludedVouchers[0].amount, undefined);
assert.equal(capture.excludedVouchers[0].details?.voucher?.ledgerEntries[0].amount, "-250.00");
const load = testLoader({
  "@/lib/api-client": {
    api: {
      get: () => {
        throw new Error("Unexpected product fetch without a published source");
      },
    },
  },
  "next/link": {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  },
});
const { DaybookResultTables } = load<typeof import("./daybook-result-tables")>(
  "src/features/tally/daybook-result-tables.tsx",
);
const excludedVouchers = capture.excludedVouchers as DaybookExcludedVoucher[];
const dealerRows: DaybookDealerRow[] = excludedVouchers.map((v) => ({
  key: "voucher:" + v.guid,
  dealerName: "Not supplied by Tally",
  ledgers: [],
  liveRecovery: "0.00",
  srCr: "0.00",
  other: null,
  status: "Review only",
}));
dealerRows.push({
  key: "dealer-a",
  dealerName: "Dealer A",
  ledgers: ["Dealer A"],
  liveRecovery: "125.50",
  srCr: "0.00",
  other: "0.00",
  status: "Matched",
  creditVouchers: capture.credits,
});
const html = renderToStaticMarkup(
  <DaybookResultTables
    dealerRows={dealerRows}
    excludedVouchers={excludedVouchers}
    coverage="all_vouchers"
  />,
);
for (const text of [
  "J-13",
  "2026-10-02",
  "SJ-5",
  "Rent expense",
  "Bank",
  "Debit",
  "Credit",
  "Item A",
  "-10 kg",
  "Voucher details",
  "250.00",
])
  assert.ok(html.includes(text), text);
assert.match(html, /Rent &lt;adjustment&gt;/);
assert.doesNotMatch(html, /Not supplied by Tally|<adjustment>|<details[^>]*\sopen(?:[=>\s])/);
const oldVoucher = { ...excludedVouchers[0], details: undefined, billAllocations: undefined };
const old = renderToStaticMarkup(
  <DaybookResultTables dealerRows={[dealerRows[0]]} excludedVouchers={[oldVoucher]} />,
);
assert.match(old, /J-13/);
assert.match(old, /2026-10-02/);
assert.match(old, /Install connector 1\.6\.6-test/);
assert.doesNotMatch(old, /Not supplied by Tally/);
const bad = structuredClone(raw);
bad.vouchers[0].details.voucher.guid = prefix + "-00000002";
assert.throws(
  () =>
    validateDaybookCapture(
      bad,
      { companyName: raw.companyName, anchorGuid: prefix + "-00000009" },
      "2026-11-19",
    ),
  /outside the capture scope/,
);
console.log(
  "Daybook unnamed voucher identity, Python evidence, ledger/stock breakdown, legacy captures and scope checks: PASS",
);

for (const text of [
  "R-31",
  "INV-100",
  "INV-101&lt;A&gt;",
  "Agst Ref",
  "Amount adjusted",
  "70.00",
  "30.00",
  "On Account",
  "No specific bill",
  "Advance",
  "ADV-1",
  "Bill adjustments (4)",
])
  assert.ok(html.includes(text), text);
assert.doesNotMatch(html, /<A>|<details[^>]*\sopen(?:[=>\s])/);
const legacy = structuredClone(raw);
delete legacy.vouchers[2].billAllocations;
assert.equal(
  validateDaybookCapture(
    legacy,
    { companyName: raw.companyName, anchorGuid: prefix + "-00000009" },
    "2026-11-19",
  ).credits.length,
  1,
);
for (const mutation of [
  (v: typeof raw) => (v.vouchers[2].billAllocations.entries[0].ledgerName = "Bank"),
  (v: typeof raw) => (v.vouchers[2].billAllocations.entryCount = 0),
  (v: typeof raw) => (v.vouchers[2].billAllocations.entries[1].allocationNumber = 1),
]) {
  const invalid = structuredClone(raw);
  mutation(invalid);
  assert.throws(() =>
    validateDaybookCapture(
      invalid,
      { companyName: raw.companyName, anchorGuid: prefix + "-00000009" },
      "2026-11-19",
    ),
  );
}
console.log(
  "Daybook payment-to-multiple-bills capture/render, partial adjustments, advances/on-account, legacy support and selected-ledger attribution: PASS",
);
