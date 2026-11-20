import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";

let tab = "month", stateCall = 0;
let staged: Record<string, { plan: number; running: number }> = {};
let pending = 0;
const dealer = (dealerId: string, plan: number, noPlan = false, weeks = {}) => ({
  dealerId, dealerName: dealerId, monthRecoveryPlan: plan, monthRunningRecovery: 0,
  noPlan, completed: plan > 0 || Object.keys(weeks).length > 0, weeks, noPlanReason: "CN not updated", noPlanReasonDetail: null,
  outstanding: 1000, overdue: 1000, due: 0, running: 0, outstandingTillDate: 1000, runningTillDate: 0,
  srCr: 0, liveRecovery: 0, actualRunningRecovery: 0, dueByWeek: {}, prevAging: null,
  lastPaymentDate: null, lastPaymentAmount: null, cnRequestStatus: null,
});
const detail = {
  id: "plan", status: "DRAFT", officerId: "so", officerName: "SO", seasonName: "Rabi 2026", monthName: "November",
  cutoffDate: "2026-11-20", monthEditable: true, weekEditable: true, weeklyEditEnabled: true, weekCount: 4,
  businessWeek: 3, weekLocks: [], lastRefresh: null, dueValidation: false, dealers: [
    dealer("monthly", 50, true),
    dealer("weekly", 0, true, { 1: { weekRecoveryPlan: 25, weekRunningRecovery: 0 } }),
    dealer("empty", 0), dealer("skipped", 0, true),
  ],
};
const nothing = () => null;
const load = testLoader({
  react: { ...React, useState: (initial: unknown) => { const state = React.useState(initial); return stateCall++ === 0 ? [tab, () => {}] : state; } },
  "@tanstack/react-query": {
    useQuery: () => ({ data: detail, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: () => {}, setQueryData: () => {} }),
    useMutation: () => ({ isPending: false, mutate: () => {}, reset: () => {} }),
  },
  "@/lib/api-client": { api: {} },
  "@/features/planning/use-autosave-map": { useAutosaveMap: (seed: object) => ({ values: { ...seed, ...staged }, saving: false, pending, update: () => {}, flush: async () => {} }) },
  "@/features/labels/label-ui": { useLabel: (k: string) => k, Th: () => <th />, LabelSectionHeaderRow: nothing },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</> },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
  "@/components/layout/page-header": { PageHeader: nothing },
  "@/components/layout/mobile-context-bar": { MobileContextBar: nothing },
  "./recovery-actions": { RecoveryActions: nothing },
  "./recovery-history": { RecoveryHistory: nothing },
  "@/features/planning/admin-edit-ui": { AdminEditBar: nothing, EditPlanButton: nothing, ChangeReviewDialog: nothing },
  "@/features/cn-requests/cn-requests-page": { CreateRequestDialog: nothing },
});
const { RecoveryWorkspace } = load<typeof import("./recovery-workspace")>("src/features/recovery/recovery-workspace.tsx");
const render = () => { stateCall = 0; return renderToStaticMarkup(<RecoveryWorkspace id="plan" role={Role.SALES_OFFICER} userId="so" />); };
const row = (html: string, id: string) => html.match(new RegExp(`<tr[^>]*data-dealer-id="${id}"[\\s\\S]*?</tr>`))?.[0] ?? "";
const noPlanDisabled = (html: string) => /<button[^>]*aria-label="Mark No Plan"[^>]*disabled/.test(html);

let html = render();
assert(html.includes("2 Completed") && html.includes("1 No Plan") && html.includes("1 Remaining"), "progress counts value-filled rows once, even with legacy flags");
for (const id of ["monthly", "weekly"]) {
  assert(noPlanDisabled(row(html, id)), "monthly and weekly amounts disable No Plan");
  assert(!row(html, id).includes("opacity-60"), "filled rows are not shown as skipped");
}
assert(!noPlanDisabled(row(html, "empty")), "an empty dealer may still choose No Plan");
assert(row(html, "skipped").includes("Undo"), "empty skipped dealers retain Undo");
staged = { empty: { plan: 15, running: 0 } };
html = render();
assert(noPlanDisabled(row(html, "empty")), "unsaved typed values disable No Plan immediately");
staged = {};
pending = 1;
assert(noPlanDisabled(row(render(), "empty")), "No Plan waits for pending saves");
pending = 0;
tab = "week";
html = render();
assert(!row(html, "monthly").includes("opacity-60") && !row(html, "weekly").includes("opacity-60"), "Week View also prioritizes existing plans");
console.log("recovery-no-plan-ui.test.tsx — all assertions passed");
