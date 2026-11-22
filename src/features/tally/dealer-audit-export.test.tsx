import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as XLSX from "xlsx";
import { testLoader } from "../dealer-tags/test-loader";
import type { DealerAuditStatus, DealerAuditSummary } from "./dealer-audit";

async function main() {
  const summary: DealerAuditSummary = {
    scanned: 1127,
    matched: 545,
    unmatched: Array.from({ length: 582 }, (_, index) => ({
      name: index === 0 ? '=SUM(1,2) "कृषि" & Sons' : `Test dealer ${index + 1}`,
      groups: index === 0 ? ["Group A", "Group B"] : ["Test group"],
    })),
  };
  const original = JSON.stringify(summary);
  let filename = "";
  let bytes: Buffer | undefined;
  const load = testLoader({
    xlsx: {
      ...XLSX,
      writeFile: (workbook: XLSX.WorkBook, name: string) => {
        filename = name;
        bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      },
    },
  });
  const { exportMissingDealers } = load<typeof import("./dealer-audit-export")>(
    "src/features/tally/dealer-audit-export.ts",
  );
  await exportMissingDealers(summary, "2026-11-21T10:27:37Z");
  assert.equal(filename, "Tally-Missing-Dealers.xlsx");
  assert.ok(bytes);
  const workbook = XLSX.read(bytes, { type: "buffer" });
  const sheet = workbook.Sheets["Missing Dealers"];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });
  assert.equal(
    rows.length,
    583,
    "all 582 unmatched dealers export, including rows outside the scroll area",
  );
  assert.deepEqual(rows[0], ["No.", "Tally dealer", "Tally group"]);
  assert.deepEqual(rows[1], [1, summary.unmatched[0].name, "Group A, Group B"]);
  assert.deepEqual(rows[582], [582, "Test dealer 582", "Test group"]);
  assert.equal(sheet.B2.t, "s", "dealer names are literal Excel text");
  assert.equal(sheet.B2.f, undefined, "formula-like names are not executable formulas");
  assert.equal(sheet["!autofilter"]?.ref, "A1:C583");
  const details = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets["Scan Details"], {
    header: 1,
  });
  assert.deepEqual(details.slice(2), [
    ["Checked", 1127],
    ["Matched", 545],
    ["Unmatched", 582],
  ]);
  assert.ok(String(details[1][1]).includes("3:57:37"), "scan time is exported in IST");
  assert.equal(JSON.stringify(summary), original, "export does not alter reconciliation data");

  function exportButton(data?: DealerAuditStatus) {
    const uiLoad = testLoader({
      "@/lib/api-client": { api: {} },
      "@tanstack/react-query": {
        useQuery: () => ({ data, isLoading: !data }),
        useMutation: () => ({ isPending: false }),
      },
      "@/components/ui/button": {
        Button: ({
          variant: _variant,
          ...props
        }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
          <button {...props} />
        ),
      },
    });
    const { TallyDealerAudit } = uiLoad<typeof import("./dealer-audit-panel")>(
      "src/features/tally/dealer-audit-panel.tsx",
    );
    const html = renderToStaticMarkup(<TallyDealerAudit />);
    return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .find((button) => button.includes("Export missing dealers"))!;
  }
  const status: DealerAuditStatus = {
    configured: true,
    completedAt: "2026-11-21T10:27:37Z",
    summary,
    failed: false,
    refreshState: null,
  };
  assert.doesNotMatch(exportButton(status), /disabled=/);
  assert.match(
    exportButton({ ...status, summary: { scanned: 1, matched: 1, unmatched: [] } }),
    /disabled=/,
  );
  assert.match(exportButton(), /disabled=/);
  console.log(
    "Missing dealer Excel download: all rows, exact names/groups, literal text, IST scan metadata, unchanged source and button availability: PASS",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
