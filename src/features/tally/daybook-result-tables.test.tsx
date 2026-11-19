import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { validateDaybookCapture } from "./daybook-preview";
import type { DaybookExcludedVoucher } from "./daybook-result-types";

const prefix = "cb293b57-f31b-464e-b2e1-42d4edb59b7d";
// Exercise actual connector output through the cloud schema and rendered tables.
const xml = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>
<VOUCHER><GUID>${prefix}-00000001</GUID><DATE>20261002</DATE><VOUCHERNUMBER>J-13</VOUCHERNUMBER><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><PARTYLEDGERNAME/><NARRATION>Rent &lt;adjustment&gt;</NARRATION>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent expense</LEDGERNAME><AMOUNT>-250.00</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>250.00</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER>
<VOUCHER><GUID>${prefix}-00000002</GUID><DATE>20261003</DATE><VOUCHERNUMBER>SJ-5</VOUCHERNUMBER><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Item A</STOCKITEMNAME><ACTUALQTY>-10 kg</ACTUALQTY><AMOUNT>-250.00</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>
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
assert.equal(capture.credits.length, 0);
assert.equal(capture.excludedVouchers[0].amount, undefined);
assert.equal(capture.excludedVouchers[0].details?.voucher?.ledgerEntries[0].amount, "-250.00");
const load = testLoader({
  "next/link": {
    default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  },
});
const { DaybookResultTables } = load<typeof import("./daybook-result-tables")>(
  "src/features/tally/daybook-result-tables.tsx",
);
const excludedVouchers = capture.excludedVouchers as DaybookExcludedVoucher[];
const dealerRows = excludedVouchers.map((v) => ({
  key: "voucher:" + v.guid,
  dealerName: "Not supplied by Tally",
  ledgers: [],
  liveRecovery: "0.00",
  srCr: "0.00",
  other: null,
  status: "Review only",
}));
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
const oldVoucher = { ...excludedVouchers[0], details: undefined };
const old = renderToStaticMarkup(
  <DaybookResultTables dealerRows={[dealerRows[0]]} excludedVouchers={[oldVoucher]} />,
);
assert.match(old, /J-13/);
assert.match(old, /2026-10-02/);
assert.match(old, /Install connector 1\.6\.5-test/);
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
