/** Late report UI: the blocked-plan panel + request dialog (Sales Officer) and Performance → Requests (reviewers). No DB / browser. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const hooks: unknown[] = [];
let cursor = 0;
const calls: { method: string; url: string; body?: unknown }[] = [];
let list: unknown[] = [];
let canDecide = true;
const buttons: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void }[] = [];
const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "@/features/accounts/permission-ui": { useAdminPermission: () => canDecide },
  "@tanstack/react-query": {
    useQuery: (o: { queryKey: unknown[]; queryFn: () => unknown; enabled?: boolean }) => { if (o.enabled !== false) void o.queryFn(); return { data: list, isLoading: false, isError: false }; },
    useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useMutation: (o: { mutationFn: (v: unknown) => Promise<unknown> }) => ({ isPending: false, mutate: (v: unknown) => { void o.mutationFn(v); } }),
  },
  "@/lib/api-client": { api: { get: async (url: string) => { calls.push({ method: "GET", url }); return list; }, post: async (url: string, body: unknown) => { calls.push({ method: "POST", url, body }); return {}; } } },
  "@/components/ui/dialog": { Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void }) => { buttons.push(p); return <button disabled={p.disabled}>{p.children}</button>; } },
};
const load = testLoader(overrides);
const { OutstandingReportPanel, LateRequestDialog } = load("src/features/daily-work/late-report.tsx") as { OutstandingReportPanel: React.ComponentType<Record<string, unknown>>; LateRequestDialog: React.ComponentType<Record<string, unknown>> };
const { LateRequestsView } = load("src/features/daily-work/late-requests-view.tsx") as { LateRequestsView: React.ComponentType<{ active?: boolean }> };
const render = (el: React.ReactElement) => { hooks.length = 0; cursor = 0; buttons.length = 0; const h = renderToStaticMarkup(el); hooks.length = cursor; return h; };
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// Blocked plan area: the report date, its original deadline, the explanation and the request button.
const outstanding = { date: "2026-10-19", deadline: "2026-10-19T18:30:00.000Z", requests: [], canRequest: true };
let html = render(<OutstandingReportPanel outstanding={outstanding} onOpenReport={() => undefined} onChanged={() => undefined} />);
assert.ok(html.includes('data-testid="outstanding-date">19/10/2026') && /data-testid="outstanding-deadline">20\/10\/2026/.test(html), "work date and original deadline (IST)");
assert.ok(text(html).includes("must be submitted before a new Daily Plan can be created") && text(html).includes("Request Late Report Submission"), "explanation + the request button");
// The same panel is actionable within Daily Report, where an Open report link would lead to the current screen.
html = render(<OutstandingReportPanel outstanding={outstanding} onChanged={() => undefined} />);
assert.ok(buttons.some((b) => b.children === "Request Late Report Submission"), "the Report view can request reopening too");
assert.ok(!buttons.some((b) => b.children === DEFAULT_LABELS["daily_work.late.open_report"]), "no redundant Open report action inside the report");
// Pending: the status is shown, the button is gone, the report stays read-only (no duplicate request from the UI).
const req = (status: string, extra: Record<string, unknown> = {}) => ({ id: "r1", workDate: "2026-10-19", deadline: "2026-10-19T18:30:00.000Z", reason: "I was without network all evening", status, requestedAt: "2026-10-22T04:00:00.000Z", decidedByName: null, decidedAt: null, decisionReason: null, ...extra });
html = render(<OutstandingReportPanel outstanding={{ ...outstanding, canRequest: false, requests: [req("PENDING")] }} onOpenReport={() => undefined} onChanged={() => undefined} />);
assert.ok(text(html).includes("Waiting for approval") && text(html).includes("I was without network all evening") && text(html).includes("read-only until the request is approved") && !buttons.some((b) => b.children === "Request Late Report Submission"), "pending: status, reason, no second request button");
html = render(<OutstandingReportPanel outstanding={{ ...outstanding, canRequest: true, requests: [req("REJECTED", { decidedByName: "Rita RM", decidedAt: "2026-10-22T06:00:00.000Z", decisionReason: "Explain more" }), req("REJECTED", { id: "r0" })] }} onOpenReport={() => undefined} onChanged={() => undefined} />);
assert.ok(text(html).includes("Rejected") && text(html).includes("Explain more") && buttons.some((b) => b.children === "Request Late Report Submission") && text(html).includes("Earlier requests"), "rejected: reason shown, a revised request is allowed, history is kept");
html = render(<OutstandingReportPanel outstanding={{ ...outstanding, canRequest: false, requests: [req("APPROVED", { decidedByName: "Rita RM", decidedAt: "2026-10-22T06:00:00.000Z" })] }} onOpenReport={() => undefined} onChanged={() => undefined} />);
assert.ok(text(html).includes("Approved") && text(html).includes("unlocks once it is submitted"), "approved: submit the report; the plan stays locked until then");
// Dialog: the exact report date read-only; Submit stays disabled until the reason is meaningful.
html = render(<LateRequestDialog workDate="2026-10-19" onClose={() => undefined} onSent={() => undefined} />);
assert.ok(/data-testid="late-request-date"[^>]*readOnly=""|readOnly=""[^>]*data-testid="late-request-date"/.test(html) && html.includes('value="19/10/2026"'), "report date is read-only");
assert.equal(buttons.find((b) => b.children === "Submit request")!.disabled, true, "Submit needs a reason");
assert.ok(buttons.some((b) => b.children === "Cancel"));

// Performance → Requests: pending by default; the work date and the requested-at timestamp are separate columns; approve / reject for pending rows.
list = [{ id: "q1", officerId: "so1", officerName: "Bina", territory: "Raigarh", state: "MP", workDate: "2026-10-19", deadline: "2026-10-19T18:30:00.000Z", reason: "No network at all", status: "PENDING", requestedAt: "2026-10-22T04:00:00.000Z", decidedByName: null, decidedByRole: null, decidedAt: null, decisionReason: null, completedAt: null }];
hooks.length = 0; calls.length = 0;
html = render(<LateRequestsView />);
assert.ok(calls[0]!.url.endsWith("view=pending"), "pending is the default view");
assert.ok(text(html).includes("Report work date") && text(html).includes("Requested at") && text(html).includes("Original deadline") && html.includes('data-testid="request-work-date">19/10/2026') && html.includes('data-testid="request-requested-at">22/10/2026'), "work date and requested-at are clearly distinct");
assert.ok(text(html).includes("Bina") && text(html).includes("Raigarh · MP") && text(html).includes("No network at all") && text(html).includes("Approve") && text(html).includes("Reject"));
buttons.find((b) => b.children && JSON.stringify(b.children).includes("Approve"))!.onClick!();
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { method: "POST", url: "/api/daily-work/late-report-requests/q1/decide", body: { action: "approve" } });
canDecide = false;
html = render(<LateRequestsView />);
assert.ok(text(html).includes("Bina") && text(html).includes("No network at all"), "a view-only admin still sees request details");
assert.ok(!text(html).includes("Approve") && !text(html).includes("Reject") && !text(html).includes("Action"), "view-only admins have no decision buttons or action column");
calls.length = 0;
render(<LateRequestsView active={false} />);
assert.equal(calls.length, 0, "leaving Requests disables fetching while preserving its view state");
canDecide = true;
list = [];
assert.ok(text(render(<LateRequestsView />)).includes("No pending requests."));
console.log("late-report-ui.test.tsx — all assertions passed");
