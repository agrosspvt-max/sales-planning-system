import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { salesMonths } from "./sales-range";
assert.deepEqual(salesMonths("2026-04", "2026-06", "2026-10-31"), [
  "2026-04",
  "2026-05",
  "2026-06",
]);
assert.deepEqual(salesMonths("2026-10", "2026-10", "2026-10-31"), ["2026-10"]);
for (const [from, to] of [
  ["2026-06", "2026-05"],
  ["2026-03", "2026-04"],
  ["2026-10", "2026-11"],
  ["2026-00", "2026-04"],
  ["", "2026-04"],
])
  assert.throws(() => salesMonths(from, to, "2026-10-31"));
let fail = false,
  cached = false;
const load = testLoader({
  "@/lib/api-client": { api: {}, ApiRequestError: class extends Error {} },
  "@/components/ui/button": {
    Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  },
  "@tanstack/react-query": {
    useQuery: ({ queryKey }: { queryKey: string[] }) => ({
      error: fail ? new Error("Network unavailable") : null,
      data:
        queryKey[0] === "tally-sales-range"
          ? { configured: true, months: [], lastSeenAt: null }
          : cached
            ? {
                configured: true,
                snapshot: {
                  observedAt: "2026-10-31T10:00:00Z",
                  throughDate: "2026-10-31",
                  summary: { changedRows: 4 },
                },
              }
            : undefined,
      refetch: () => {},
    }),
    useMutation: () => ({ mutate: () => {}, isPending: false }),
    useQueryClient: () => ({ invalidateQueries: () => {} }),
  },
});
const { TallySalesRefresh } = load<typeof import("./sales-refresh")>(
  "src/features/tally/sales-refresh.tsx",
);
const render = () => renderToStaticMarkup(<TallySalesRefresh chooseMonth />);
assert.match(render(), /Sales from month/);
assert.match(render(), /Sales to month/);
fail = true;
cached = true;
const html = render();
assert.match(html, /Sales from month/);
assert.match(html, /Sales to month/);
assert.match(html, /temporarily unavailable/);
assert.match(html, /4 product rows changed/);
assert.doesNotMatch(html, /not enabled for this test website/);
console.log("Sales range validation and rendered controls/saved data during status errors: PASS");
