import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "./test-loader";
const metadata = {
  overrides: { tagged: "Dealer Alias" },
  tags: {
    tagged: [
      { id: "fp", name: "Focused Product", markerType: "TEXT", marker: "FP" },
      { id: "hp", name: "High Potential", markerType: "TEXT", marker: "HP" },
      { id: "star", name: "Priority", markerType: "SYMBOL", marker: "⭐" },
    ],
  },
};
const load = testLoader({
  "@tanstack/react-query": {
    useQuery: () => ({ data: metadata }),
    useQueryClient: () => ({ invalidateQueries: async () => {} }),
  },
  "@/lib/api-client": { api: {} },
});
const ui = load<typeof import("@/features/dealers/dealer-name-ui")>(
  "src/features/dealers/dealer-name-ui.tsx",
);
const order = load<typeof import("@/features/dealers/dealer-table-ui")>(
  "src/features/dealers/dealer-table-ui.tsx",
);
const select = load<typeof import("@/components/ui/select")>("src/components/ui/select.tsx");
const wrap = (children: ReactNode) => <ui.DealerNameProvider>{children}</ui.DealerNameProvider>;
const name = renderToStaticMarkup(wrap(<ui.DealerName id="tagged" name="Raw Name" />));
assert(name.startsWith("Dealer Alias<span"));
assert(name.includes(">FP</span>"));
assert(name.includes(">HP</span>"));
assert(name.includes(">⭐</span>"));
assert(name.includes('title="Focused Product"'));
assert(!name.includes("Raw Name"));
assert.equal(renderToStaticMarkup(wrap(<ui.DealerName id="plain" name="Fallback" />)), "Fallback");
const options = renderToStaticMarkup(
  wrap(
    <select.NativeSelect
      dealerOptions
      options={[
        { value: "plain", label: "Alpha" },
        { value: "tagged", label: "Dealer Alias" },
      ]}
      placeholder="Select…"
    />,
  ),
);
assert(options.indexOf('value="tagged"') < options.indexOf('value="plain"'));
assert(options.includes("Dealer Alias [FP] [HP] ⭐"));
assert(!options.includes("<span"));
const nonDealer = renderToStaticMarkup(
  wrap(
    <select.NativeSelect
      options={[
        { value: "plain", label: "First" },
        { value: "tagged", label: "Second" },
      ]}
    />,
  ),
);
assert(nonDealer.indexOf("First") < nonDealer.indexOf("Second"));
assert(!nonDealer.includes("[FP]"));
const rows = [
  <tr key="summary">
    <td>Summary</td>
  </tr>,
  <tr key="plain" data-dealer-id="plain">
    <td>Plain</td>
  </tr>,
  <order.DealerRowGroup key="tagged" data-dealer-id="tagged">
    <tr>
      <td>Tagged</td>
    </tr>
    <tr>
      <td>Expanded</td>
    </tr>
  </order.DealerRowGroup>,
];
const table = renderToStaticMarkup(
  wrap(
    <table>
      <order.DealerTableBody>{rows}</order.DealerTableBody>
    </table>,
  ),
);
assert(table.indexOf("Summary") < table.indexOf("Tagged"));
assert(table.indexOf("Tagged") < table.indexOf("Expanded"));
assert(table.indexOf("Expanded") < table.indexOf("Plain"));
const performance = load<typeof import("@/components/dashboard/performance-table")>(
  "src/components/dashboard/performance-table.tsx",
);
const performanceRows = ["plain", "tagged"].map((id, i) => ({
  id,
  label: id,
  planQty: 10,
  actualQty: 7,
  pendingQty: 3,
  planAmount: 100 - i,
  actualAmount: 70 - i,
  achievementAmount: 70,
  planNbv: 100,
  actualNbv: 70,
}));
const dealerPerformance = renderToStaticMarkup(
  wrap(<performance.PerformanceTable dealerRows rows={performanceRows} labelHeader="Dealer" />),
);
assert(
  dealerPerformance.indexOf('data-dealer-id="tagged"') <
    dealerPerformance.indexOf('data-dealer-id="plain"'),
);
assert(dealerPerformance.includes("Dealer Alias"));
assert(dealerPerformance.includes("FP"));
const productPerformance = renderToStaticMarkup(
  wrap(<performance.PerformanceTable rows={performanceRows} labelHeader="Product" />),
);
assert(!productPerformance.includes("Dealer Alias"));
assert(!productPerformance.includes("data-dealer-id="));
assert.deepEqual(
  performanceRows.map((r) => r.actualAmount),
  [70, 69],
);
for (const f of ["approvals-inbox", "my-approvals"])
  assert(readFileSync(`src/features/planning/${f}.tsx`, "utf8").includes("<DealerTagRequests"));
const inbox = readFileSync("src/features/planning/approvals-inbox.tsx", "utf8");
for (const existing of [
  "/api/planning/approvals",
  "MonthlyApprovals",
  "RecoveryApprovals",
  "CnRequestApprovals",
])
  assert(inbox.includes(existing));
console.log(
  "Dealer Tag UI tests passed: alias/fallback, multiple markers after name, plain native options, stable row groups, existing Approval integration.",
);
