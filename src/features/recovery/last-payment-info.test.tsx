import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const load = testLoader({
  "@/features/labels/label-ui": { useLabel: (key: keyof typeof DEFAULT_LABELS) => DEFAULT_LABELS[key] },
});
const { PaymentHistoryContent, LastPaymentInfo } = load<typeof import("./last-payment-info")>("src/features/recovery/last-payment-info.tsx");
const render = (payments: { date: string; amount: number; kind?: "snapshot" }[]) => renderToStaticMarkup(<PaymentHistoryContent payments={payments} />);
const five = render(Array.from({ length: 6 }, (_, index) => ({ date: `2026-11-${String(20 - index).padStart(2, "0")}`, amount: 100.01 })));
assert.ok(five.includes("Total (5)") && five.includes("₹500.05"), "total includes only the five displayed receipts, with cents preserved");
assert.ok(five.includes("20/11/2026") && !five.includes("15/11/2026"));
const fewer = render([{ date: "2026-10-31", amount: 12000 }, { date: "2026-10-15", amount: 5000, kind: "snapshot" }]);
assert.ok(fewer.includes("Total (1)") && fewer.includes("₹12,000") && !fewer.includes("Daily summary") && !fewer.includes("₹17,000"), "saved summaries are excluded from both the receipt list and its total");
assert.ok(render([]).includes("No individual receipts available for this period."));
const icon = renderToStaticMarkup(<LastPaymentInfo dealerName="Alpha Traders" payments={[]} throughDate="2026-11-30" />);
assert.ok(icon.includes('aria-label="Last 5 receipts: Alpha Traders"') && icon.includes('aria-haspopup="dialog"'));
assert.ok(!icon.includes('data-testid="recent-payments"'), "history is initially hidden");
console.log("last-payment-info.test.tsx — all assertions passed");
