import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

type Button = { children?: React.ReactNode; disabled?: boolean; onClick?: () => void };
type Mutation = {
  mutationFn: () => Promise<unknown>;
  onSuccess: () => Promise<void>;
  retry: boolean;
};
let queryError: Error | null = null,
  saveError: Error | null = null,
  pending = false;
let buttons: Button[] = [],
  mutation: Mutation,
  query: { queryKey: unknown[]; retry: boolean };
const calls: unknown[] = [],
  invalidations: unknown[] = [];
let closed = 0,
  done = 0;
let data:
  | {
      source: { id: string; label: string };
      counts: { monthlyEntries: number; recoveryPlans: number; partyMonthlyPlans: number };
      targets: { id: string; label: string }[];
    }
  | undefined = {
  source: { id: "k11", label: "November 2026" },
  counts: { monthlyEntries: 12, recoveryPlans: 2, partyMonthlyPlans: 3 },
  targets: [{ id: "r11", label: "Rabi 2026" }],
};
const wrapper = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
const load = testLoader({
  "@/features/labels/label-ui": {
    useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k],
  },
  "@/lib/api-client": {
    api: {
      del: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    },
  },
  "@tanstack/react-query": {
    useQuery: (q: typeof query) => {
      query = q;
      return { data, isPending: false, error: queryError };
    },
    useQueryClient: () => ({
      invalidateQueries: async (value: unknown) => {
        invalidations.push(value);
      },
    }),
    useMutation: (m: Mutation) => {
      mutation = m;
      return {
        isPending: pending,
        error: saveError,
        mutate: () => {
          void m.mutationFn();
        },
      };
    },
  },
  "@/components/ui/dialog": {
    Dialog: wrapper,
    DialogContent: wrapper,
    DialogHeader: wrapper,
    DialogTitle: wrapper,
    DialogDescription: wrapper,
    DialogFooter: wrapper,
  },
  "@/components/ui/select": {
    NativeSelect: ({
      options,
      value,
    }: {
      options: { value: string; label: string }[];
      value: string;
    }) => (
      <select value={value} onChange={() => {}}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ),
  },
  "@/components/ui/button": {
    Button: (props: Button) => {
      buttons.push(props);
      return <button disabled={props.disabled}>{props.children}</button>;
    },
  },
});
const { RemoveMonthDialog } = load<typeof import("./remove-month-dialog")>(
  "src/features/seasons/remove-month-dialog.tsx",
);
function render() {
  buttons = [];
  return renderToStaticMarkup(
    <RemoveMonthDialog
      seasonId="k"
      monthId="k11"
      onClose={() => closed++}
      onTransferred={() => done++}
    />,
  );
}
async function main() {
  let html = render();
  assert.match(html, /November 2026/);
  assert.match(html, /Rabi 2026/);
  assert.match(html, /12/);
  assert.match(html, /Recovery plans/);
  assert.match(html, /drafts/);
  assert.match(html, /conflicting records stop/);
  assert.equal(calls.length, 0, "opening the dialog never removes anything");
  assert.equal(query!.retry, false);
  assert.equal(mutation!.retry, false, "destructive requests never auto-repeat");
  assert.equal(buttons[1].disabled, false, "single matching destination is automatically chosen");
  await mutation!.mutationFn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["/api/seasons/k/months/k11", { targetMonthId: "r11" }],
  ]);
  await mutation!.onSuccess();
  assert.equal(done, 1);
  assert.equal(closed, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(invalidations)),
    [{ refetchType: "none" }, { queryKey: ["seasons"] }, { queryKey: ["season-months", "k"] }],
    "hidden planning caches are stale without a full-app refetch fanout",
  );
  data!.targets.push({ id: "x11", label: "Another season" });
  render();
  assert.equal(buttons[1].disabled, true, "ambiguous destinations require an explicit choice");
  data!.targets = [];
  html = render();
  assert.match(html, /No other open season/);
  assert.equal(buttons[1].disabled, true);
  data = undefined;
  queryError = Error("The last month cannot be removed");
  html = render();
  assert.match(html, /role="alert"/);
  assert.match(html, /last month/);
  assert.equal(buttons[1].disabled, true);
  queryError = null;
  saveError = Error("Sales overlap. Nothing was transferred or removed.");
  html = render();
  assert.match(html, /Sales overlap/);
  assert.equal(closed, 0, "a failed transfer stays open");
  pending = true;
  html = render();
  assert.match(html, /Transferring/);
  assert.ok(buttons.every((b) => b.disabled));
  console.log(
    "Season month removal UI: preview, explicit confirmation, target choice, conflict/error state and bounded refetches passed",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
