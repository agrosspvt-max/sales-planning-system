/** CN expiry UI: the four Accepted tabs, Grace Ends column, the calendar date + grace fields of the Accept dialog, and the Reopen dialog. No database. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { addCnDays } from "@/lib/cn-expiry";
import { cnRequestBusinessDateKey } from "@/lib/cn-request";

const hooks: unknown[] = [];
let cursor = 0;
type Nav = { value: string; items: { value: string; label: string }[]; onChange: (v: string) => void };
type Sel = { "aria-label"?: string; value: string; onChange: (e: { target: { value: string } }) => void; options: { value: string; label: string }[] };
type DateProps = { value: string; min?: string; onChange: (iso: string) => void; "aria-label"?: string; required?: boolean };
let navs: Nav[] = [];
let selects: Sel[] = [];
let dates: DateProps[] = [];
const menu: Record<string, () => void> = {};
const inputs: Record<string, { value: string; onChange: (e: { target: { value: string } }) => void }> = {};
let filterOptions: Record<string, { value: string; label: string }[]> = {};
const clicks: Record<string, () => void> = {};
const posts: { url: string; body: unknown }[] = [];
const urls: string[] = [];
const edited: Record<string, string> = {}; // administrator-edited wording (Labels screen)
const TODAY = cnRequestBusinessDateKey(new Date())!;
const L = DEFAULT_LABELS as Record<string, string>;
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, dealerId: "d1", partyName: "Alpha", cnType: "CD", amount: 1000, postedAmount: null, paymentStatus: "Pending", paymentVerified: false, paymentTrackingMode: "PAYMENT_V1", paymentOriginalAmount: 1000, paymentOutstandingAmount: 1000,
  officerId: "so1", employeeName: "SO", state: "MP", territory: "North", status: "ACCEPTED_NOT_POSTED", details: null, remarks: null, rejectionReason: null, rejectionReasonDetails: null, acceptanceReason: "PAYMENT_PENDING", acceptanceReasonDetails: null,
  expiryDate: "2026-10-25", graceDays: 5, graceEndDate: "2026-10-30", policyStage: "WORKING", policyCycle: 1, cnWorking: null, finalCn: null, createdAt: "2026-10-19T05:00:00Z", days: 1, ...over,
});
let rows = [row("w1")];
const load = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (v: unknown) => { hooks[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks[i]) : v; }]; } },
  "@/features/labels/label-ui": { useLabel: (k: string) => edited[k] ?? L[k] ?? k, useLabelResolver: () => (k: string) => edited[k] ?? L[k] ?? k },
  "@/features/accounts/permission-ui": { useAdminPermission: () => true },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <span>{name}</span> },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
  "@/components/ui/column-filter-header": { ColumnFilterHeader: (p: { label: string; options: { value: string; label: string }[] }) => { filterOptions[p.label] = p.options; return <th>{p.label}</th>; } },
  "@/components/ui/input": { Input: (p: { "aria-label"?: string; value: string; onChange: (e: { target: { value: string } }) => void }) => { if (p["aria-label"]) inputs[p["aria-label"]] = p; return <input value={p.value} readOnly />; } },
  "@/components/ui/dropdown-menu": { DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => { if (typeof children === "string") menu[children] = onSelect; return <div>{children}</div>; } },
  "@/components/ui/select": { NativeSelect: (p: Sel) => { selects.push(p); return <select aria-label={p["aria-label"]} />; } },
  "@/components/ui/date-input-dmy": { DateInputDMY: (p: DateProps) => { dates.push(p); return <input data-date={p["aria-label"]} value={p.value} readOnly />; } },
  "@/components/ui/dialog": { Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  "@/features/planning/plan-list-ui": { PillNav: (p: Nav) => { navs.push(p); return <div />; }, UnderlineTabs: (p: Nav) => { navs.push(p); return <div />; } },
  "@/components/layout/page-header": { PageHeader: () => null },
  "./cn-payment-dialog": { CnPaymentDialog: () => null },
  "./cn-request-detail-dialog": { CnRequestDetailDialog: () => null },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => { if (typeof p.children === "string" && p.onClick) clicks[p.children] = p.onClick; return <button disabled={p.disabled}>{p.children}</button>; } },
  "@/lib/api-client": { api: { get: async (url: string) => { urls.push(url); return rows; }, post: async (url: string, body: unknown) => { posts.push({ url, body }); return {}; } } },
  "@tanstack/react-query": {
    useQuery: (o: { queryFn?: () => unknown }) => { void o.queryFn?.(); return { data: rows, isLoading: false }; }, useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useMutation: (o: { mutationFn: (v: never) => unknown }) => ({ isPending: false, mutate: (v: never) => { void o.mutationFn(v); } }),
  },
});
const { CnRequestsPage } = load<{ CnRequestsPage: React.ComponentType<{ role: Role; userId: string }> }>("src/features/cn-requests/cn-requests-page.tsx");
const render = (role: Role = Role.SUPER_ADMIN) => { cursor = 0; navs = []; selects = []; dates = []; filterOptions = {}; for (const k of Object.keys(menu)) delete menu[k]; const html = renderToStaticMarkup(<CnRequestsPage role={role} userId="admin" />); hooks.length = cursor; return html; };
const same = (a: unknown, b: unknown, why: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), why);
const tabs = () => navs.find((n) => n.items.some((i) => i.value === "accepted-not-posted"))!;

// ---- four Accepted tabs, in order, with editable labels
let html = render();
navs[0]!.onChange("accepted"); html = render();
same(tabs().items.map((i) => i.value), ["under-process", "accepted-not-posted", "posted-in-ledger", "cn-near-expire", "expired-cn"], "CN Working Shared, Posted in Ledger, CN in Grace, Expired CN");
same(tabs().items.map((i) => i.label), [L["cn_requests.processing.tab"], L["cn_requests.view.accepted_not_posted"], L["cn_requests.view.posted_in_ledger"], L["cn_requests.view.cn_in_grace"], L["cn_requests.view.expired"]], "labels come from the labels system");
assert.ok(html.includes(L["cn_requests.col.expires"]) && !html.includes(L["cn_requests.col.grace_ends"]), "Working Shared shows Expires only");
assert.ok(!html.includes(L["cn_requests.reopen.action"]), "no Reopen action outside the Expired tab");

// ---- Grace tab: Grace Ends column; status shows CN in Grace
rows = [row("g1", { policyStage: "GRACE" })];
tabs().onChange("cn-near-expire"); html = render();
assert.ok(!html.includes(L["cn_requests.col.grace_ends"]) && html.includes("Grace +5"), "Near Expire shows expiry with granted grace, without a second deadline column");
assert.ok(html.includes(L["cn_requests.view.cn_in_grace"]), "status badge says CN in Grace");
assert.ok(!html.includes(L["cn_requests.reopen.action"]));

// ---- Expired tab: Reopen only for administrators (with the approval permission)
rows = [row("x1", { policyStage: "EXPIRED" })];
tabs().onChange("expired-cn"); html = render();
assert.ok(html.includes(L["cn_requests.reopen.action"]), "Reopen CN is offered in the Expired tab");
assert.ok(html.includes(L["cn_requests.view.expired"]));
hooks.length = 0; navs = [];
render(Role.SALES_OFFICER); navs[0]!.onChange("accepted"); render(Role.SALES_OFFICER); tabs().onChange("expired-cn");
assert.ok(!render(Role.SALES_OFFICER).includes(L["cn_requests.reopen.action"]), "an SO never sees the administrative reopen action");
hooks.length = 0;

// ---- Reopen dialog: calendar date (not before today), grace shown and kept, mandatory reason + authorizer, nothing sent while invalid
render(); navs[0]!.onChange("accepted"); render(); tabs().onChange("expired-cn"); render();
clicks[L["cn_requests.reopen.action"]!]!(); html = render();
assert.ok(html.includes(L["cn_requests.reopen.title"]));
const picker = dates.find((d) => d["aria-label"] === L["cn_requests.reopen.new_expiry"])!;
assert.equal(picker.min, TODAY, "the calendar cannot go before today");
assert.ok(html.includes(L["cn_requests.reopen.authorized_by"]) && html.includes(L["cn_requests.reopen.reason"]));
assert.ok(!html.includes(L["cn_requests.reopen.grace_days"]), "reopening does not configure automatic grace");
clicks[L["cn_requests.reopen.confirm"]!]!(); html = render();
assert.ok(html.includes(L["cn_requests.validation.expiry_required"]) && posts.length === 0, "a new expiry is required before anything is sent");
picker.onChange(addCnDays(TODAY, 9)); html = render();
assert.ok(!html.includes(L["cn_requests.acceptance.grace_ends_on"]), "there is only one effective expiry date");
clicks[L["cn_requests.reopen.confirm"]!]!(); html = render();
assert.ok(html.includes(L["cn_requests.validation.reopen_reason_required"]) && posts.length === 0, "reason is mandatory");

// ---- Accept dialog: calendar date + Grace Period (default 5, editable) + live Grace Ends On; Other is exempt; direct posting has it too
hooks.length = 0; rows = [row("s1", { status: "SUBMITTED", policyStage: null, graceDays: null, graceEndDate: null, expiryDate: null, paymentStatus: null })];
render(); html = render();
const action = selects.find((s) => s["aria-label"] === L["cn_requests.acceptance.status"])!;
action.onChange({ target: { value: "ACCEPTED_NOT_POSTED" } }); html = render();
const reason = selects.filter((s) => s["aria-label"] === L["cn_requests.acceptance.status"]).length ? selects.find((s) => s.options.some((o) => o.value === "PAYMENT_PENDING"))! : undefined;
assert.ok(reason, "the acceptance reason is chosen first");
assert.ok(!html.includes(L["cn_requests.acceptance.grace_days"]), "no expiry fields before the reason is known");
reason!.onChange({ target: { value: "PAYMENT_PENDING" } }); html = render();
const expiry = dates.find((d) => d["aria-label"] === L["cn_requests.acceptance.expiry_days"])!;
assert.ok(expiry, "CN Expiry Date is a calendar date field (the shared DD/MM/YYYY DateInputDMY)");
assert.equal(expiry.min, TODAY, "past dates cannot be picked");
assert.ok(!html.includes(L["cn_requests.acceptance.grace_days"]), "no grace field at acceptance");
assert.ok(!html.includes(L["cn_requests.acceptance.grace_ends_on"] + ":"), "no Grace Ends On until a date is chosen");
expiry.onChange("2026-10-25"); html = render();
assert.ok(!html.includes("30/10/2026"), "acceptance never adds automatic grace");
reason!.onChange({ target: { value: "OTHER" } }); html = render();
assert.ok(!html.includes(L["cn_requests.acceptance.grace_days"]), "reason Other is not governed by the expiry policy");
const status = selects.find((s) => s.value === "ACCEPTED_NOT_POSTED" && s.options.some((o) => o.value === "POSTED_IN_LEDGER"))!;
status.onChange({ target: { value: "POSTED_IN_LEDGER" } }); html = render();
assert.ok(!html.includes(L["cn_requests.acceptance.grace_days"]) && html.includes(L["cn_requests.acceptance.posted_amount"]), "direct posting requires its amount but does not ask for expiry or grace");
// ---- Labels: editing the wording changes ONLY the wording — tab identifiers, queried views and permissions stay the same
hooks.length = 0; rows = [row("x2", { policyStage: "EXPIRED" })];
Object.assign(edited, { "cn_requests.view.expired": "Lapsed CN", "cn_requests.view.cn_in_grace": "Extension Period", "cn_requests.reopen.action": "Revive CN", "cn_requests.reopen.title": "Revive Lapsed CN", "cn_requests.reopen.authorized_by": "Authorised By Whom", "cn_requests.acceptance.grace_days": "Extension (Days)", "cn_requests.col.grace_ends": "Extension Ends" });
render(); navs[0]!.onChange("accepted"); render();
same(tabs().items.map((i) => i.value), ["under-process", "accepted-not-posted", "posted-in-ledger", "cn-near-expire", "expired-cn"], "identifiers are unchanged by an edit");
same(tabs().items.slice(-2).map((i) => i.label), ["Extension Period", "Lapsed CN"], "the edited tab wording is shown");
tabs().onChange("expired-cn"); html = render();
assert.ok(urls.at(-1)!.endsWith("view=expired-cn"), "the data is still requested by the fixed view id, not by the label");
assert.ok(html.includes("Lapsed CN") && !html.includes("Extension Ends") && html.includes("Revive CN") && !html.includes("Expired CN"), "badge, column heading and action use the edited wording");
clicks["Revive CN"]!(); html = render();
assert.ok(html.includes("Revive Lapsed CN") && html.includes("Authorised By Whom"), "dialog title and field use the edited wording");
clicks[edited["cn_requests.reopen.confirm"] ?? L["cn_requests.reopen.confirm"]!]!(); html = render();
assert.ok(html.includes(L["cn_requests.validation.expiry_required"]) && posts.length === 0, "validation and behaviour are unchanged by the wording");
for (const key of Object.keys(edited)) delete edited[key];
console.log("cn-expiry-ui.test.tsx — all assertions passed");

// Manual extension is offered in the row menu only to handlers, validates days, previews the new date, and sends a retry-safe request.
hooks.length = 0; rows = [row("manual", { expiryDate: addCnDays(TODAY, 10), graceDays: 0 })];
render(); navs[0]!.onChange("accepted"); html = render();
assert.ok(menu[L["cn_requests.grace.action"]!]);
same(filterOptions[L["cn_requests.col.expires"]!], [{ value: "WITHOUT_GRACE", label: L["cn_requests.grace.without"] }], "expiry filter categorizes grace instead of listing dates");
menu[L["cn_requests.grace.action"]!]!(); html = render();
assert.ok(html.includes(L["cn_requests.grace.title"]));
assert.ok(html.includes('value="5"'));
assert.ok(html.includes(addCnDays(TODAY, 15).split("-").reverse().join("/")), "new effective expiry is previewed");
inputs[L["cn_requests.grace.days"]!]!.onChange({ target: { value: "0" } }); render();
clicks[L["cn_requests.grace.confirm"]!]!(); html = render();
assert.ok(html.includes(L["cn_requests.grace.invalid"]));
assert.equal(posts.length, 0);
inputs[L["cn_requests.grace.days"]!]!.onChange({ target: { value: "5" } }); render();
clicks[L["cn_requests.grace.confirm"]!]!();
assert.equal(posts.at(-1)!.url, "/api/cn-requests/manual/grace");
const sent = posts.at(-1)!.body as { days: number; requestKey: string; fromExpiry: string; fromCycle: number };
assert.equal(sent.days, 5); assert.equal(sent.fromExpiry, addCnDays(TODAY, 10)); assert.ok(sent.requestKey.length > 8);
hooks.length = 0;
render(Role.SALES_OFFICER); navs[0]!.onChange("accepted"); render(Role.SALES_OFFICER);
assert.ok(!menu[L["cn_requests.grace.action"]!], "SO cannot grant grace");
console.log("Manual grace row menu, form, preview, categorical filter and permissions passed");
