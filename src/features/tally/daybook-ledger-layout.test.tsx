import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import { daybookDiagnosticsSchema } from "./daybook-diagnostics";

const xml = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><VOUCHER>
<GUID>cb293b57-f31b-464e-b2e1-42d4edb59b7d-0000f2ff</GUID><DATE>20260408</DATE><VOUCHERNUMBER>CR/26-27/0001</VOUCHERNUMBER><VOUCHERTYPENAME>CREDIT NOTE-OTHER</VOUCHERTYPENAME><PARTYLEDGERNAME>Example dealer</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Example dealer</LEDGERNAME><AMOUNT>9999.40</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><BILLALLOCATIONS.LIST><NAME>INV-A</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>9999.40</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>Example dealer</LEDGERNAME><AMOUNT>9999.40</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><BILLALLOCATIONS.LIST><NAME>INV-B&lt;changed&gt;</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>9999.40</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>
</VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`;
const result = spawnSync(
  "python3",
  [
    "-B",
    "-c",
    `import sys,json; import daybook_capture as d
try:
 d.parse_vouchers(sys.stdin.buffer.read(),None,'cb293b57-f31b-464e-b2e1-42d4edb59b7d','2026-04-01','2026-04-30')
except d.DaybookRejected as e:
 print(json.dumps(e.details))`,
  ],
  { cwd: resolve("../tally-connector-v1.3/Tally-Office-Connector"), input: xml, encoding: "utf8" },
);
assert.equal(result.status, 0, result.stderr);
const details = daybookDiagnosticsSchema.parse(JSON.parse(result.stdout));
assert.equal(details.voucher!.ledgerLayouts!.length, 2);
assert.equal(details.voucher!.layoutResolution, "conflicting");
assert.notEqual(
  details.voucher!.ledgerLayouts![0].entries[0].sourceHash,
  details.voucher!.ledgerLayouts![1].entries[0].sourceHash,
);
const Wrapper = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
const load = testLoader({
  "@/components/ui/dialog": Object.fromEntries(
    [
      "Dialog",
      "DialogContent",
      "DialogDescription",
      "DialogHeader",
      "DialogTitle",
      "DialogTrigger",
    ].map((name) => [name, Wrapper]),
  ),
  "@/components/ui/button": { Button: Wrapper },
});
const { DaybookErrorDetails } = load<typeof import("./daybook-error-details")>(
  "src/features/tally/daybook-error-details.tsx",
);
const render = (diagnostics: typeof details) =>
  renderToStaticMarkup(
    <DaybookErrorDetails
      month="2026-04"
      code="DAYBOOK_LEDGER_LAYOUT_AMBIGUOUS"
      diagnostics={diagnostics}
    />,
  );
const html = render(details);
for (const value of [
  "CR/26-27/0001",
  "ALLLEDGERENTRIES.LIST",
  "LEDGERENTRIES.LIST",
  "INV-A",
  "INV-B&lt;changed&gt;",
  "9999.40",
  "whole-voucher layout issue",
])
  assert.ok(html.includes(value), value);
assert.doesNotMatch(html, /Problem ledger|Problem amount|<changed>/);
const legacy = structuredClone(details);
delete legacy.voucher!.ledgerLayouts;
delete legacy.voucher!.layoutResolution;
assert.match(render(legacy), /Install connector 1\.6\.7-test/);
assert.doesNotMatch(render(legacy), /Problem ledger|Problem amount/);
console.log(
  "Actual Python conflicting-layout evidence: schema, both source sections, nested bill differences, safe rendering and legacy error guidance: PASS",
);
