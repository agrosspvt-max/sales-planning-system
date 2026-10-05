import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { latestReceiptAsOf } from "@/lib/last-payment";
import { aggregateDaybookByDealer } from "@/lib/daybook-aggregate";

async function run() {
  const load = testLoader({});
  const parser = load<typeof import("./parser")>("src/features/historical-daybook/parser.ts");
  const monthly = load<typeof import("@/features/recovery/daybook-parser")>(
    "src/features/recovery/daybook-parser.ts",
  );
  const header = ["Date", "Particulars", "Vch Type", "Vch No.", "Credit Amount"];
  function book(rows: unknown[][], date1904 = false) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Day Book");
    wb.Workbook = { WBProps: { date1904 } };
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }
  for (const [input, expected] of [
    ["10/05/2025", "2025-05-10"],
    ["2024-02-29", "2024-02-29"],
    ["1-Apr-24", "2024-04-01"],
    ["10 December 2025", "2025-12-10"],
    [45292, "2024-01-01"],
  ] as const)
    assert.equal(parser.receiptDate(input), expected);
  assert.equal(parser.receiptDate(0, true), "1904-01-01");
  for (const input of ["29/02/2025", "31/04/2025", "", null, "not a date", -1])
    assert.equal(parser.receiptDate(input), null);
  assert.equal(parser.receiptAmount("1,00,000.25"), "100000.25");
  for (const input of ["", null, "oops", "-10", "0", "1.001", "1000000000000", Infinity])
    assert.equal(parser.receiptAmount(input), null);
  const input = book([
    ["Company title"],
    header,
    ["10/05/2025", "Dealer A", "Receipt", "R1", 10000],
    [],
    header,
    ["15/07/2025", "Dealer A", "Receipt", "R2", 20000],
    ["10/12/2025", "Dealer A", "Receipt", "R3", 15000],
    ["10/12/2025", "Dealer A", "Receipt", "R4", 15000],
    ["2024-01-01", "Dealer A", "Receipt", "R5", 100],
    ["2025-12-30", "Dealer A", "Credit Note", "C1", 999],
    [null, "Grand Total", "Receipt", "", 900],
    ["invalid", "Dealer A", "Receipt", "R6", "invalid"],
  ]);
  const parsed = parser.parseHistoricalDaybook(input);
  assert.equal(parsed.rows.length, 6);
  assert.equal(parsed.rows[0].sourceOrder, 3);
  assert.equal(
    parsed.rows[1].sourceOrder,
    6,
    "physical row identity survives blank and repeated header rows",
  );
  assert.equal(parsed.rows[0].voucherNumber, "R1");
  assert.equal(parsed.rows[5].errors.length, 2);
  assert.equal(
    new Set(parsed.rows.map((r) => r.rowKey)).size,
    6,
    "identical same-day receipts are distinct source rows",
  );
  const points = parsed.rows
    .filter((r) => !r.errors.length)
    .map((r) => ({ date: r.date!, amount: Number(r.amount) }));
  for (const [cutoff, expectedDate, amount] of [
    ["2025-05-31", "2025-05-10", 10000],
    ["2025-06-30", "2025-05-10", 10000],
    ["2025-07-31", "2025-07-15", 20000],
    ["2025-11-30", "2025-07-15", 20000],
    // R3 + R4: two distinct ₹15,000 receipts on the selected date are now totalled (Last Payment = that day's sum).
    ["2025-12-31", "2025-12-10", 30000],
  ] as const)
    assert.deepEqual(latestReceiptAsOf(points, cutoff), { date: expectedDate, amount });
  assert.throws(
    () =>
      parser.parseHistoricalDaybook(
        book([
          ["Party", "Type"],
          ["A", "Receipt"],
        ]),
      ),
    /headers/,
  );
  const normal = monthly.parseDaybook(
    book([
      header,
      ["2025-05-10", "Dealer A", "Receipt", "R1", 100],
      ["2025-05-20", "Dealer A", "Credit Note", "C1", 50],
    ]),
  );
  const agg = aggregateDaybookByDealer(
    normal.rows.map((r) => ({
      dealerId: "a",
      date: r.date,
      creditAmount: r.creditAmount,
      isReceipt: monthly.isReceiptVoucher(r.vchType),
      isSrCr: monthly.isSrCrVoucher(r.vchType),
    })),
  ).get("a")!;
  assert.equal(agg.receipt, 100);
  assert.equal(agg.srCr, 50);
  assert.equal(agg.lastReceiptAmount, 100);

  const resolverLoad = testLoader({
    "@/lib/prisma": {
      prisma: {
        dealer: {
          findMany: async () => [
            { id: "a", name: "Same Dealer" },
            { id: "b", name: "Same Dealer" },
          ],
        },
        dealerAlias: {
          findMany: async () => [
            { tallyKey: "olddealer", tallyName: "Old Dealer", systemDealerId: "a" },
          ],
        },
      },
    },
  });
  const resolver = await resolverLoad<typeof import("@/lib/dealer-resolver")>(
    "src/lib/dealer-resolver.ts",
  ).loadDealerResolver();
  assert.equal(resolver.resolve("Old Dealer")?.id, "a", "existing alias matching unchanged");
  assert.equal(
    resolver.candidates("Same Dealer").length,
    2,
    "ambiguous exact matches are exposed for review",
  );
  assert.equal(resolver.candidates("Unknown XYZ").length, 0);

  const uiLoad = testLoader({
    "@/lib/api-client": { api: {} },
    "@tanstack/react-query": {
      useQueryClient: () => ({ invalidateQueries() {} }),
      useQuery: () => ({ data: [] }),
      useMutation: () => ({ isPending: false }),
    },
    "@/features/labels/label-ui": {
      useLabel: (key: keyof typeof DEFAULT_LABELS) => DEFAULT_LABELS[key],
    },
    "@/features/dealers/dealer-name-ui": { DealerName: () => null },
  });
  const Wizard = uiLoad<typeof import("./wizard")>(
    "src/features/historical-daybook/wizard.tsx",
  ).HistoricalDaybookWizard;
  const html = renderToStaticMarkup(React.createElement(Wizard));
  assert.ok(
    html.includes("Historical Daybook") &&
      html.includes('accept=".xlsx"') &&
      html.includes("Analyze"),
  );
  assert.ok(!html.includes("Choose the month") && html.includes("No Recovery Month is required"));
  const analysis: import("./types").HistoricalAnalysis = {
    fileHash: "test", previewToken: "test", workbookName: "history.xlsx", sheet: "Day Book",
    ignoredSheets: [], totalRows: 1, ignoredRows: 0,
    rows: [{ ...parsed.rows[0], dealerId: "a", candidates: [], reviewReasons: [], duplicate: false, excluded: false, ready: true }],
    summary: { receipts: 1, valid: 1, dealers: 1, invalid: 0, unmatched: 0, review: 0, duplicates: 0, excluded: 0, importing: 1 },
    changes: [{ dealerId: "a", dealerName: "Dealer A", calendarMonth: 7, calendarYear: 2026, monthEnd: "2026-07-31", plans: 1, before: null, after: { date: "2026-07-15", amount: 40000 } }],
    unresolvedPeriods: [{ planId: "unresolved", seasonMonthId: "unknown", monthName: "July" }],
    canCommit: true, alreadyImported: false,
  };
  let stateIndex = 0;
  const previewLoad = testLoader({
    react: { ...React, useState: (initial: unknown) => React.useState(stateIndex++ === 1 ? analysis : initial) },
    "@/lib/api-client": { api: {} },
    "@tanstack/react-query": {
      useQueryClient: () => ({ invalidateQueries() {} }),
      useQuery: () => ({ data: [{ id: "a", name: "Dealer A" }] }),
      useMutation: () => ({ isPending: false }),
    },
    "@/features/labels/label-ui": { useLabel: (key: keyof typeof DEFAULT_LABELS) => DEFAULT_LABELS[key] },
    "@/features/dealers/dealer-name-ui": { DealerName: () => null, useDealerMarkers: () => ({}) },
  });
  const Preview = previewLoad<typeof import("./wizard")>("src/features/historical-daybook/wizard.tsx").HistoricalDaybookWizard;
  const previewHtml = renderToStaticMarkup(React.createElement(Preview));
  assert.ok(previewHtml.includes("existing recovery months") && previewHtml.includes("Recovery month / Plans"));
  assert.match(previewHtml.replace(/<!--.*?-->/g, ""), /July 2026 \/ 1/);
  assert.ok(previewHtml.includes("15/07/2026") && previewHtml.includes("40,000"));
  assert.ok(!previewHtml.includes("Cutoff / Plans") && !previewHtml.includes("existing plan cutoffs"));
  assert.ok(previewHtml.includes("unresolved calendar month/year") && previewHtml.includes("valid receipt history can still be imported"));
  console.log(
    "Historical Daybook unit/UI tests passed: dates/amounts, multi-year rows, provenance, distinct receipts, month/year preview, unresolved-period notice, matching ambiguity, unchanged monthly aggregation and isolated upload UI.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
