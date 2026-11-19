import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "../dealer-tags/test-loader";
import type { DaybookBillProducts } from "./daybook-bill-products";

const result: DaybookBillProducts = {
  status: "matched",
  bill: {
    number: "INV-101",
    date: "2026-05-03",
    type: "Sales",
    partyName: "Original party",
    cancelled: false,
    optional: false,
    items: [
      {
        lineNo: 0,
        productName: "NEON <original pack>",
        quantity: "1.500000",
        unit: "Kg",
        amount: "100.25",
      },
      {
        lineNo: 1,
        productName: "Unmapped original product",
        quantity: "2.000000",
        unit: "Nos",
        amount: "45.00",
      },
    ],
  },
};
const entry = {
  ledgerLineNumber: 1,
  allocationNumber: 2,
  ledgerName: "Original party",
  billReference: "INV-101",
  referenceType: "Agst Ref",
  amount: "3.00",
};
const source = {
  jobId: "123e4567-e89b-42d3-a456-426614174000",
  voucherGuid: "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00000001",
};
let open = false;
let options: { enabled: boolean; queryFn: () => Promise<DaybookBillProducts> };
let requests: string[] = [];
let error: Error | null = null;
const load = testLoader({
  react: { ...React, useState: () => [open, () => {}] },
  "@/lib/api-client": {
    api: {
      get: async (url: string) => {
        requests.push(url);
        return result;
      },
    },
  },
  "@tanstack/react-query": {
    useQuery: (input: typeof options) => {
      options = input;
      return { data: result, isPending: false, error, refetch: () => {} };
    },
  },
});
async function main() {
  const { DaybookReferencedBillProducts, DaybookBillProductResult } = load<
    typeof import("./daybook-referenced-bill-products")
  >("src/features/tally/daybook-referenced-bill-products.tsx");
  const render = () =>
    renderToStaticMarkup(<DaybookReferencedBillProducts source={source} entry={entry} />);
  const closed = render();
  assert.match(closed, /Products in bill INV-101/);
  assert.doesNotMatch(closed, /NEON|<details[^>]*\sopen(?:[=>\s])/);
  assert.equal(options!.enabled, false);
  assert.equal(requests.length, 0, "closed disclosures do not fetch product rows");
  await options!.queryFn();
  const query = new URL(requests[0], "https://test.example").searchParams;
  assert.equal(query.get("jobId"), source.jobId);
  assert.equal(query.get("voucherGuid"), source.voucherGuid);
  assert.equal(query.get("allocationNumber"), "2");
  assert.equal(query.get("reference"), "INV-101");
  open = true;
  const html = render();
  for (const text of [
    "NEON &lt;original pack&gt;",
    "Unmapped original product",
    "1.5",
    "Kg",
    "Nos",
    "100.25",
    "full original bill",
    "adjusted by this payment",
  ])
    assert.ok(html.includes(text), text);
  assert.equal(options!.enabled, true);
  assert.doesNotMatch(html, /<original pack>/);
  error = new Error("Bill products are temporarily unavailable");
  assert.match(render(), /Retry loading products/);
  assert.match(render(), /role="alert"/);
  for (const status of ["missing", "ambiguous", "unlinked"] as const) {
    const message = `Specific ${status} explanation`;
    const output = renderToStaticMarkup(<DaybookBillProductResult result={{ status, message }} />);
    assert.match(output, new RegExp(message));
    assert.doesNotMatch(output, /<table/);
  }
  const empty = structuredClone(result);
  empty.bill!.items = [];
  empty.bill!.cancelled = true;
  const emptyHtml = renderToStaticMarkup(<DaybookBillProductResult result={empty} />);
  assert.match(emptyHtml, /Cancelled bill/);
  assert.match(emptyHtml, /no product lines/);
  const { DaybookBillAllocationTable } = load<typeof import("./daybook-bill-allocation-table")>(
    "src/features/tally/daybook-bill-allocation-table.tsx",
  );
  const advance = renderToStaticMarkup(
    <DaybookBillAllocationTable
      source={source}
      allocations={{
        scope: "selected_credit",
        entryCount: 1,
        entries: [{ ...entry, referenceType: "Advance" }],
      }}
    />,
  );
  assert.doesNotMatch(advance, /Products in bill/);
  assert.match(advance, /no specific sales bill is linked/);
  console.log(
    "Daybook bill-product disclosures: lazy source-bound requests, original product quantities/units/amounts, escaped names, empty/cancelled/missing/ambiguous/advance cases and retry: PASS",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
