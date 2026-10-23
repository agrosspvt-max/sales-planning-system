import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS, labelCatalog, resolveLabels } from "@/features/labels/labels";
import {
  cnReviewStatusKey,
  validCnReviewPrice,
  CN_REVIEW_LABELS,
  type CnReview,
} from "@/lib/cn-review";
import { mayEnterPage } from "@/features/accounts/permissions";
import { assertApiAccess } from "@/features/accounts/route-permissions";
import { Role } from "@prisma/client";
import { cnFilterValue, filterCnRequests } from "@/lib/cn-request-filters";
import { cnRequestAgeDays } from "@/lib/cn-request";

const t = (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k;
const current: CnReview = {
  id: "a",
  cnRequestId: "cn",
  kind: "RATE_CONFIRMATION",
  status: "PENDING",
  assignedToId: "so",
  assignedToName: "Officer (@officer) (Sales Officer)",
  sentByName: "Admin (@admin) (Super Admin)",
  createdAt: "2026-10-22T10:00:00Z",
  respondedAt: null,
  note: null,
  products: [{ id: "p", name: "Product Alpha", price: null }],
  fileName: null,
  mimeType: null,
  partyName: "Dealer Alpha",
};
const wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
let history: CnReview[] = [];
const navs: Array<{ options: Array<{ value: string; label: string }> }> = [];
const loads: string[] = [];
const load = testLoader({
  "@/features/labels/label-ui": { useLabel: t, useLabelResolver: () => t },
  "@/lib/api-client": { api: { get: async () => [], post: async () => ({}) } },
  "@tanstack/react-query": {
    useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useQuery: ({ queryKey }: { queryKey: string[] }) => {
      loads.push(queryKey[0]);
      return {
        isLoading: false,
        error: null,
        data:
          queryKey[0] === "cn-review-choices"
            ? {
                people: [
                  { id: "so", name: "Officer (@officer) (Sales Officer)", administrative: false },
                  { id: "acc", name: "Accounts (@accounts) (Accounts Officer)", administrative: true },
                ],
                products: [{ id: "p", name: "Product Alpha" }],
              }
            : queryKey[0] === "cn-review-inbox"
              ? [current]
              : history,
      };
    },
    useMutation: () => ({ isPending: false, error: null, mutate: () => undefined }),
  },
  "@/components/ui/dialog": {
    Dialog: wrap,
    DialogContent: wrap,
    DialogHeader: wrap,
    DialogFooter: wrap,
    DialogTitle: wrap,
  },
  "@/components/ui/select": {
    NativeSelect: (p: { options: Array<{ value: string; label: string }> }) => {
      navs.push(p);
      return (
        <select>
          {p.options.map((o) => (
            <option key={o.value}>{o.label}</option>
          ))}
        </select>
      );
    },
  },
  "@/components/ui/searchable-select": {
    SearchableSelect: ({ options }: { options: Array<{ value: string; label: string }> }) => (
      <select data-searchable>
        {options.map((o) => (
          <option key={o.value}>{o.label}</option>
        ))}
      </select>
    ),
  },
  "@/components/ui/searchable-multi-select": {
    SearchableMultiSelect: () => <div data-multiselect />,
  },
});
const ui = load<typeof import("./cn-review-ui")>("src/features/cn-requests/cn-review-ui.tsx");
const dialog = (canHandle = true) =>
  renderToStaticMarkup(
    <ui.CnProcessingDialog
      requestId="cn"
      underProcess={history.length > 0}
      canHandle={canHandle}
      canAccept={canHandle}
      canPost={canHandle}
      canReject={canHandle}
      onClose={() => undefined}
      onDecision={() => undefined}
    />,
  );
let html = dialog();
assert(html.includes("data-multiselect"));
assert(html.includes("Depends On") && html.includes("data-searchable"));
assert(!html.includes("@officer") && !html.includes("@accounts") && !html.includes("Accounts Officer"), "person choices show only names even with older snapshot data");
assert(
  !html.includes("CN Expiry Date") && !html.includes("Grace Period"),
  "entering Under Process never asks for expiry/grace",
);
assert.equal(
  JSON.stringify(navs[0].options.map((o) => o.value)),
  JSON.stringify(["RATE_CONFIRMATION", "CN_APPROVAL"]),
);
history = [current];
html = dialog();
assert(
  html.includes("Reason for proceeding without confirmation"),
  "a pending review requires the additional bypass reason",
);
assert(
  html.includes(t("cn_requests.view.accepted_not_posted")) &&
    html.includes("Posted in Ledger") &&
    html.includes("Reject"),
  "final actions remain available before confirmation",
);
history = [{ ...current, status: "REJECTED", note: "Wrong product" }];
html = dialog();
assert(
  html.includes("Rate Confirmation Rejected") &&
    html.includes("Replace / Reassign") &&
    html.includes("Wrong product"),
);
history = [
  {
    ...current,
    status: "CONFIRMED",
    products: [{ id: "p", name: "Product Alpha", price: 112.35 }],
  },
];
html = dialog();
assert(!html.includes("Reason for proceeding without confirmation"));
assert(html.includes("112.35") && html.includes("litre/kg"));
html = dialog(false);
assert(
  !html.includes("Send Request") && !html.includes("Replace / Reassign"),
  "SO/RM history does not expose handler actions",
);
html = renderToStaticMarkup(<ui.CnReviewInbox />);
assert(html.includes("CN Reviews Assigned to Me") && html.includes("Open Review"));
assert(html.includes("Admin") && !html.includes("@admin") && !html.includes("Super Admin"), "inbox sender is displayed by name only");
html = renderToStaticMarkup(
  <ui.CnReviewResponseDialog
    review={current}
    onClose={() => undefined}
    onChanged={() => undefined}
  />,
);
assert(
  html.includes("Product Alpha") &&
    html.includes("Price (₹ per litre/kg)") &&
    html.includes('step="0.01"'),
);
assert(html.includes("Submit Prices") && html.includes("Reject Review"));
html = renderToStaticMarkup(
  <ui.CnReviewResponseDialog
    review={{
      ...current,
      kind: "CN_APPROVAL",
      products: [],
      fileName: "CN.pdf",
      mimeType: "application/pdf",
    }}
    onClose={() => undefined}
    onChanged={() => undefined}
  />,
);
assert(html.includes("/api/cn-reviews/a/document?download=1") && html.includes('target="_blank"'));
assert(!html.includes('type="number"') && html.includes("Approve"));
for (const value of [0, 0.01, 123.45, 9999999999.99]) assert(validCnReviewPrice(value));
for (const value of [-1, NaN, Infinity, 1.001, null, "12"]) assert(!validCnReviewPrice(value));
assert.equal(
  t(cnReviewStatusKey({ kind: "CN_APPROVAL", status: "REJECTED" })),
  "CN Approval Rejected",
);
const overrides = { "cn_requests.processing.tab": "Processing Queue" };
assert.equal(resolveLabels(overrides)["cn_requests.processing.tab"], "Processing Queue");
const catalog = labelCatalog(overrides);
for (const key of Object.keys(CN_REVIEW_LABELS))
  assert(
    catalog.some((item) => item.key === key && item.module === "CN Requests"),
    `${key} is editable through Labels`,
  );
const account = { role: Role.CUSTOM_ADMIN, permissions: {} };
assert(
  mayEnterPage(account, "/planning/approvals"),
  "every assigned account can open its personal approvals without general CN access",
);
assertApiAccess(account, "/api/cn-reviews/inbox", "GET");
assert.throws(() => assertApiAccess(account, "/api/cn-requests", "GET"));
console.log("CN processing UI, labels, price validation and narrow Approvals access passed.");

const filterBase = {
  dealerId: "d",
  cnType: "CD",
  amount: null,
  paymentStatus: null,
  officerId: "so",
  state: "MP",
  territory: "North",
  status: "UNDER_PROCESS",
  days: 1,
  expiryDate: null,
};
const pending = {
  ...filterBase,
  processingReview: { kind: "RATE_CONFIRMATION", status: "PENDING" },
};
const confirmed = {
  ...filterBase,
  processingReview: { kind: "RATE_CONFIRMATION", status: "CONFIRMED" },
};
assert.equal(
  filterCnRequests([pending, confirmed], { status: [cnFilterValue(confirmed, "status")] }).length,
  1,
  "review-status filters distinguish pending and confirmed rows",
);
assert.equal(
  cnRequestAgeDays(
    { status: "UNDER_PROCESS", createdAt: "2026-10-20T04:00:00Z" },
    new Date("2026-10-22T04:00:00Z"),
  ),
  3,
  "response time keeps counting while Under Process",
);

// The API also exposes names only. Legacy stored snapshots remain intact and identities stay ID-based.
async function personPresentation() {
  const raw = { ...current, createdAt: new Date(current.createdAt), sentById: "admin" };
  const choices = [{ id: "one", name: "Alex", username: "alex_one", designation: "Accounts Officer", role: Role.CUSTOM_ADMIN }, { id: "two", name: "Alex", username: "alex_two", designation: null, role: Role.CUSTOM_ADMIN }];
  const server = testLoader({
    "@/lib/prisma": { prisma: {
      user: { findMany: async () => choices }, product: { findMany: async () => [] },
      cnRequest: { findUnique: async () => ({ officerId: "so" }) },
      cnReviewAttempt: { findMany: async () => [raw] },
    } },
    "@/features/labels/service.server": { getResolvedLabels: async () => DEFAULT_LABELS },
  })<typeof import("./cn-review.server")>("src/features/cn-requests/cn-review.server.ts");
  const ctx = { userId: "admin", username: "admin", role: Role.SUPER_ADMIN, groupId: null };
  const result = await server.cnReviewChoices(ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(result.people)), [{ id: "one", name: "Alex", administrative: true }, { id: "two", name: "Alex", administrative: true }]);
  const resultHistory = await server.cnReviewHistory(ctx, "cn");
  assert.equal(resultHistory[0]!.sentByName, "Admin");
  assert.equal(resultHistory[0]!.assignedToName, "Officer");
  assert.equal(raw.sentByName, "Admin (@admin) (Super Admin)", "display changes do not rewrite audit snapshots");
  console.log("CN person choices and historical display return names only, preserving account IDs");
}
void personPresentation().catch(error => { console.error(error); process.exit(1); });
