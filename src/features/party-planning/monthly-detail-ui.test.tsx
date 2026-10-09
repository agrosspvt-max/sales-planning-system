/** Monthly Plan detail (Create / Submitted / Approved / Older views): Market | Party Options | Conversion Date | Days, Add Market dialog, Submit / review. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

const hooks: unknown[] = [];
let cursor = 0;
let invalidations = 0;
const posts: { url: string; body: unknown }[] = [];
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let inputs: { placeholder?: string; value?: string; type?: string; onChange?: (e: { target: { value: string } }) => void }[] = [];
let combos: { ariaLabel: string; placeholder?: string; emptyText?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }[] = [];
let plans: unknown[] = [];
let sheet: Record<string, unknown> = {};
const SEASONAL_PLANS = [{ id: "sp1", marketName: "Pipariya", marketPotential: "B", type: "Existing" }, { id: "sp2", marketName: "Bareli", marketPotential: "A", type: "New" }];

/* eslint-disable @typescript-eslint/no-explicit-any */
let dealerProps: Record<string, any> | null = null;
const dp = (): Record<string, any> => dealerProps as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */
const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { L: ({ k }: { k: LabelKey }) => <>{DEFAULT_LABELS[k]}</>, useLabel: (k: LabelKey) => DEFAULT_LABELS[k] },
  "./party-planning-page": { PartyPlanModeLinks: ({ mode, stage }: { mode: string; stage?: string }) => <nav data-mode={mode} data-stage={stage} /> },
  "@/components/layout/page-header": { PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => <h1>{title}<p>{subtitle}</p></h1> },
  "@tanstack/react-query": {
    useQuery: () => ({ data: { sheet, season: { id: "s1", name: "Kharif", year: 2026, period: "Apr 2026 → Nov 2026" }, month: { id: "sm", name: "June", label: "June 2026", key: "2026-06" }, seasonalPlans: SEASONAL_PLANS, plans }, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: () => { invalidations += 1; } }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: () => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then(() => o.onSuccess?.(), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => ({}), put: async () => ({}), post: async (url: string, body: unknown) => { posts.push({ url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => { buttons.push(p); return <button>{p.children}</button>; } },
  "@/components/ui/input": { Input: (p: (typeof inputs)[number]) => { inputs.push(p); return <input placeholder={p.placeholder} defaultValue={p.value} type={p.type} />; } },
  "@/features/sales-upload/create-dealer-dialog": { DealerDialog: (p: Record<string, unknown>) => { dealerProps = p; return <div data-dealer-dialog />; } },
  "@/components/ui/searchable-select": { SearchableSelect: (p: (typeof combos)[number]) => { combos.push(p); return <input role="combobox" aria-expanded={false} aria-controls="x" aria-label={p.ariaLabel} placeholder={p.placeholder} />; } },
  "@/components/ui/dialog": {
    Dialog: ({ children }: { children: React.ReactNode }) => <div data-dialog>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
};
const { MonthlyPlanDetailPage, StatusDialog, StatusTimelineDialog } = testLoader(overrides)("src/features/party-planning/monthly-planning-page.tsx") as { MonthlyPlanDetailPage: React.ComponentType<{ role: Role; sheetId: string; stage?: string }>; StatusDialog: React.ComponentType<{ plan: never; onClose: () => void; onChanged: () => void }>; StatusTimelineDialog: React.ComponentType<{ plan: never; onClose: () => void }> };
const render = (role: Role = Role.SALES_OFFICER, stage: string = "create") => { cursor = 0; buttons = []; inputs = []; combos = []; const html = renderToStaticMarkup(<MonthlyPlanDetailPage role={role} sheetId="ms1" stage={stage} />); hooks.length = cursor; return html; };
const click = (label: string) => { const b = buttons.filter((x) => String(x.children).includes(label)); assert.ok(b.length >= 1, `button "${label}"`); b[b.length - 1]!.onClick!(); };
const count = (label: string) => buttons.filter((b) => String(b.children).includes(label)).length;
const base = { id: "ms1", seasonOpen: true, own: true, status: "Draft", counts: { create: 1, submitted: 0, approved: 0, pendingRm: 0, pendingAdmin: 0, rejected: 0 }, submittedAt: null, rejectionStage: null, rejectionReason: null, canEdit: true, canSubmit: false, canReview: false };
const option = (n: number, party: string) => ({ id: `o${n}`, optionNo: n, partyName: party });
const PLAN = { id: "p1", ownerId: "so1", ownerGroupId: "g1", appointedDealerId: null, appointedDealerName: null, monthLabel: "June 2026", monthKey: "2026-06", ownerName: "Officer One", marketName: "Pipariya", marketPotential: "B", planDate: "2026-06-15", canManage: true, options: [option(1, "Party A"), option(2, "Party B")], opStatus: "NONE", statusLabel: "Draft", statusChangedAt: null, allowedStatuses: [] as { to: string; label: string }[], sentInfo: null, receivedInfo: null, statusEvents: [] as unknown[], canEditDate: true, dateChangeCount: 0, seasonalAddedOn: "2026-06-01", days: 3, daysFinal: false, dateHistory: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // Create, EMPTY table: no banner / search / status filter / always-visible form; Add Market is in the footer row, left-aligned.
  sheet = { ...base }; plans = [];
  let html = render();
  assert.ok(!html.includes("Season:") && !html.includes("Month:") && !html.includes("Apr 2026 → Nov 2026") && !html.includes("Officer One"), "the season / month / officer banner is gone");
  assert.ok(!html.includes("Search market or party") && !html.includes("All statuses"), "search and status filter are gone");
  assert.ok(!html.includes("Add Monthly Plan") && !html.includes("Option 1 Party *") && !html.includes("Select a market"), "the always-visible entry form is gone");
  assert.ok(html.includes('data-stage="create"') && html.includes('data-mode="monthly"'));
  assert.equal(count("Add Market"), 1);
  const footerEmpty = /<div class="flex flex-wrap items-center justify-between gap-2 border-t p-2"><div><button>[^]*?Add Market<\/button><\/div>/.exec(html);
  assert.ok(footerEmpty, "Add Market: first child of the footer row, left-aligned (not centered in the empty state)");
  assert.ok(html.lastIndexOf("Add Market") > html.lastIndexOf("</table>"), "…directly below the table");
  // populated: the SAME footer row
  plans = [PLAN]; html = render();
  assert.ok(/border-t p-2"><div><button>[^]*?Add Market<\/button><\/div>/.test(html), "same position with rows");
  assert.deepEqual([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ["Market", "Party Options", "Status", "Conversion Date", "Days"]);
  assert.ok(html.includes("Party A") && html.includes("Party B") && html.includes("Pipariya"));
  // Add Market dialog: market (searchable), Conversion Date, Option 1 required, Option 2 optional → POST → stays in Create
  click("Add Market"); html = render();
  assert.ok(html.includes("data-dialog") && html.includes("Market *") && html.includes("Conversion Date") && html.includes("Option 1 Party *") && html.includes("Option 2 Party"));
  assert.equal(combos.length, 1, "ONE searchable field replaces the separate search box and dropdown");
  assert.ok(!html.includes("Search market…") && !html.includes("Select a market…") && !inputs.some((i) => i.placeholder === "Search market…"), "no redundant search input / plain dropdown");
  assert.deepEqual([combos[0]!.ariaLabel, combos[0]!.emptyText], ["Market", "No markets found"]);
  assert.deepEqual(combos[0]!.options.map((o) => o.label), ["Pipariya", "Bareli"], "options come from the eligible Seasonal markets only");
  render(); assert.equal(buttons.filter((b) => String(b.children) === "Add").at(-1)!.disabled, true, "no market selected → Add is blocked");
  combos.at(-1)!.onChange("sp2"); render();
  assert.equal(combos.at(-1)!.value, "sp2", "the selection is a market record id");
  const field = (i: number, value: string) => { const text = inputs.filter((x) => !x.type && x.placeholder !== "Search market…"); (i < 0 ? inputs.filter((x) => x.type === "date").at(-1)! : text[i]!).onChange!({ target: { value } }); render(); };
  field(-1, "2026-06-20"); field(0, "Party One"); field(1, "Party Two");
  buttons.filter((b) => String(b.children) === "Add").at(-1)!.onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans", body: { sheetId: "ms1", seasonalPlanId: "sp2", planDate: "2026-06-20", option1Party: "Party One", option2Party: "Party Two" } }], "persisted through the existing endpoint, for THIS plan");
  assert.ok(invalidations >= 1 && !render().includes("data-dialog"), "closes and refreshes; the user stays in Create");
  // Submit
  sheet = { ...base, canSubmit: true }; html = render();
  assert.equal(count("Submit"), 1); posts.length = 0; click("Submit"); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-sheets/ms1/submit", body: {} }]);
  sheet = { ...base, canSubmit: false }; render(); assert.equal(count("Submit"), 0, "no Submit when nothing to submit");
  // Submitted / Approved / Older: no editing controls, same table, the nav knows the section
  for (const [stage, text] of [["submitted", "No submitted entries"], ["approved", "No approved entries"], ["older", "No older entries"]] as const) {
    sheet = { ...base, canEdit: false, canSubmit: false, seasonOpen: stage !== "older" };
    plans = []; html = render(Role.SALES_OFFICER, stage);
    assert.equal(count("Add Market"), 0, `${stage}: no Add Market`); assert.equal(count("Submit"), 0); assert.ok(!html.includes("Add Monthly Plan"));
    assert.ok(html.includes(`data-stage="${stage}"`) && html.includes(">Days</th>") && html.includes(text), `${stage}: the same table, section-specific empty text`);
    plans = [PLAN]; html = render(Role.SALES_OFFICER, stage); assert.ok(html.includes("Party A"));
  }
  sheet = { ...base, seasonOpen: false, canEdit: false }; assert.ok(render(Role.SALES_OFFICER, "older").includes("season closed"), "older plans are marked read-only");
  // Create stays a workspace: Add Market + Submit are offered ONLY in the Create section, even when the plan has other (submitted / approved) entries
  sheet = { ...base, counts: { ...base.counts, submitted: 2, approved: 3 }, canSubmit: true }; plans = [PLAN];
  render(Role.SALES_OFFICER, "create"); assert.deepEqual([count("Add Market"), count("Submit")], [1, 1]);
  for (const st of ["submitted", "approved", "older"]) { render(Role.SALES_OFFICER, st); assert.deepEqual([count("Add Market"), count("Submit")], [0, 0], `${st}: no workspace controls`); }
  // Review: only in Submitted, only when the server says canReview
  sheet = { ...base, canEdit: false, own: false, canReview: true, counts: { ...base.counts, submitted: 1, pendingRm: 1 } }; plans = [PLAN];
  render(Role.REGIONAL_MANAGER, "submitted");
  assert.deepEqual([count("Approve"), count("Reject"), count("Add Market"), count("Submit")], [1, 1, 0, 0]);
  posts.length = 0; click("Approve"); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-sheets/ms1/act", body: { action: "approve" } }]);
  render(Role.REGIONAL_MANAGER, "approved"); assert.equal(count("Approve"), 0, "no review buttons outside the Submitted section");
  sheet = { ...sheet, canReview: false }; render(Role.SALES_OFFICER, "submitted"); assert.equal(count("Approve"), 0, "review buttons only when the server says canReview");
  // Returned (rejected) entries: reason visible in Create, still editable
  sheet = { ...base, rejectionStage: "RM", rejectionReason: "Wrong parties", canSubmit: true };
  html = render(); assert.ok(html.includes("Returned by RM: Wrong parties") && count("Add Market") === 1 && count("Submit") === 1);
  // ---- Status column + dialogs ----
  const approved = { ...base, canEdit: false };
  const SO_ROW = { ...PLAN, statusLabel: "Approved", allowedStatuses: [{ to: "DOC_SENT", label: "Doc Send By SO" }] };
  sheet = approved; plans = [SO_ROW]; html = render();
  assert.ok(html.includes("Approved ▾") && html.includes('aria-label="Change status of Pipariya"'), "the SO can click the status");
  plans = [{ ...PLAN, statusLabel: "Approved", allowedStatuses: [] }]; html = render();
  assert.ok(!html.includes("Change status of") && html.includes(">Approved<"), "no clickable status without an allowed move");
  plans = [{ ...PLAN, statusLabel: "Draft" }]; sheet = { ...base }; assert.ok(render().includes(">Draft<"));
  // ---- Status dialog (state seeded through the hook store: [to, doc, remarks, confirming, error]) ----
  const dlg = (plan: unknown, seed: unknown[] = []) => { hooks.length = 0; seed.forEach((v, i) => { hooks[i] = v; }); cursor = 0; buttons = []; const out = renderToStaticMarkup(<StatusDialog plan={plan as never} onClose={() => {}} onChanged={() => { invalidations += 100; }} />); hooks.length = cursor; return out; };
  const btn = (label: string) => buttons.filter((b) => String(b.children).includes(label)).at(-1)!;
  // SO · Doc Send By SO
  let d = dlg(SO_ROW);
  assert.ok(d.includes("Document Sent") && d.includes("Check Send") && d.includes("Other (optional)"), "SO fields: Document Sent, Check Send, optional Other");
  assert.equal(btn("Continue").disabled, true, "at least one of Document Sent / Check Send is required");
  d = dlg(SO_ROW, ["DOC_SENT", { documents: false, checks: false, other: "just text" }]);
  assert.equal(btn("Continue").disabled, true, "Other alone does not satisfy the requirement");
  d = dlg(SO_ROW, ["DOC_SENT", { documents: false, checks: true, other: "GST" }]);
  assert.equal(btn("Continue").disabled, false);
  posts.length = 0;
  d = dlg(SO_ROW, ["DOC_SENT", { documents: false, checks: true, other: "GST" }, "", true]);
  assert.ok(d.includes("Change the status of") && d.includes("Doc Send By SO") && d.includes("Confirm Doc Send By SO"), "the SO must confirm before saving");
  assert.equal(posts.length, 0, "nothing is saved before Confirm");
  btn("Confirm Doc Send By SO").onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans/p1/status", body: { to: "DOC_SENT", sent: { documents: false, checks: true, other: "GST" } } }], "saved through the row status endpoint");
  assert.ok(invalidations >= 100, "the table is refreshed");
  posts.length = 0; btn("Back").onClick!(); assert.equal(posts.length, 0, "Back / Cancel never save");
  // Admin · Doc Received
  const ADMIN_ROW = { ...PLAN, opStatus: "DOC_SENT", statusLabel: "Doc Send By SO", allowedStatuses: [{ to: "DOC_RECEIVED", label: "Doc Received" }, { to: "REJECTED", label: "Rejected" }, ], sentInfo: { documents: true, checks: false, other: "GST certificate" } };
  d = dlg(ADMIN_ROW, ["DOC_RECEIVED"]);
  assert.ok(d.includes("Submitted by the Sales Officer") && d.includes("Document Sent: <b>Selected</b>") && d.includes("Check Send: <b>Not selected</b>") && d.includes("Other: <b>GST certificate</b>"), "Admin sees exactly what the SO submitted");
  assert.ok(d.includes("Actually Received") && d.includes("Document Received") && d.includes("Check Received"), "…and a separate Actually Received section");
  assert.equal(btn("Continue").disabled, true, "nothing is assumed received: Admin must tick something");
  posts.length = 0;
  dlg(ADMIN_ROW, ["DOC_RECEIVED", { documents: false, checks: true, other: "Cheque only" }, "", true]); btn("Confirm Doc Received").onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans/p1/status", body: { to: "DOC_RECEIVED", received: { documents: false, checks: true, other: "Cheque only" } } }], "received is sent separately (the SO's submission is not part of the request)");
  // Admin · SD Bounce / Appointed / Rejected: optional remarks + confirmation
  const LATE = { ...ADMIN_ROW, opStatus: "DOC_RECEIVED", statusLabel: "Doc Received", allowedStatuses: [{ to: "SD_BOUNCE", label: "SD Bounce" }, { to: "APPOINTED", label: "Appointed" }, { to: "REJECTED", label: "Rejected" }] };
  d = dlg(LATE, ["SD_BOUNCE"]); assert.ok(d.includes("Remarks (optional)") && !d.includes("Actually Received"));
  assert.equal(btn("Continue").disabled, false, "remarks are optional");
  posts.length = 0; dlg(LATE, ["REJECTED", { documents: false, checks: false, other: "" }, "  not eligible ", true]); assert.equal(posts.length, 0);
  btn("Confirm Rejected").onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans/p1/status", body: { to: "REJECTED", remarks: "  not eligible " } }]);
  // ---- Appointed → straight to the existing Create Dealer form (no candidate choice, no remarks, no extra button) ----
  const LATE2 = { ...LATE, options: [{ id: "o1", optionNo: 1, partyName: "Party A" }, { id: "o2", optionNo: 2, partyName: "Party B" }] };
  const showDlg = () => { cursor = 0; buttons = []; dealerProps = null; const out = renderToStaticMarkup(<StatusDialog plan={LATE2 as never} onClose={() => {}} onChanged={() => { invalidations += 1000; }} />); hooks.length = cursor; return out; };
  hooks.length = 0; posts.length = 0;
  d = showDlg();
  assert.ok(buttons.some((b) => String(b.children).includes("Appointed")), "Appointed is one of the Admin's choices");
  assert.equal(dp(), null, "nothing opens until Appointed is clicked");
  btn("Appointed").onClick!(); // ONE click
  d = showDlg();
  assert.ok(dp(), "the EXISTING Dealer Alias create-dealer dialog opens immediately");
  assert.ok(!d.includes("Which candidate was appointed?") && !d.includes("Continue to Create Dealer") && !d.includes("Remarks (optional)"), "no candidate choice, no remarks, no intermediate Continue");
  assert.deepEqual(JSON.parse(JSON.stringify(dp().prefill)), { groupId: "g1", officerId: "so1" }, "only the owner / group are prefilled; the Admin enters the dealer (Options stay visible in the drawer)");
  assert.equal(dp().allowAssignExisting, false); assert.equal(dp().open, true);
  assert.equal(posts.length, 0, "nothing saved yet");
  const created = invalidations;
  await dp().submitCreate({ name: "Real Dealer", aliasName: "REAL DEALER", officerId: "so1", groupId: "g1", addToSeasonalPlan: true }); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans/p1/appoint", body: { dealer: { name: "Real Dealer", aliasName: "REAL DEALER", officerId: "so1", groupId: "g1", addToSeasonalPlan: true } } }], "the form's body goes to the Appointed endpoint (dealer + status in one transaction)");
  dp().onCreated({}); assert.equal(invalidations, created + 1000, "only a successful creation completes the status change");
  // Cancel / close the dealer form → back to the status dialog, nothing saved, previous status intact, can retry
  posts.length = 0; dp().onOpenChange(false);
  d = showDlg();
  assert.ok(dp() === null && buttons.some((b) => String(b.children).includes("Appointed")), "cancelling returns to the status dialog, where Appointed can be tried again");
  assert.equal(posts.length, 0, "cancel saves nothing");
  btn("Appointed").onClick!(); d = showDlg(); assert.ok(dp(), "retry opens the form again");
  // Timeline
  const tl = renderToStaticMarkup(<StatusTimelineDialog plan={{ ...LATE, statusEvents: [
    { id: "e1", previousStatus: "NONE", newStatus: "DOC_SENT", previousLabel: "Approved", newLabel: "Doc Send By SO", actorName: "Officer One", actorRole: "SALES_OFFICER", remarks: null, sentInfo: { documents: true, checks: false, other: "GST" }, receivedInfo: null, createdAt: "2026-10-08T10:00:00.000Z" },
    { id: "e2", previousStatus: "DOC_SENT", newStatus: "DOC_RECEIVED", previousLabel: "Doc Send By SO", newLabel: "Doc Received", actorName: "Admin", actorRole: "SUPER_ADMIN", remarks: "ok", sentInfo: null, receivedInfo: { documents: false, checks: true, other: null }, createdAt: "2026-10-08T11:00:00.000Z" },
  ] } as never} onClose={() => {}} />);
  assert.ok(tl.includes("Approved → Doc Send By SO") && tl.includes("Doc Send By SO → Doc Received") && tl.includes("Officer One") && tl.includes("Remarks: ok") && tl.includes("Actually received (Admin)") && tl.indexOf("Officer One") < tl.indexOf("Admin"), "timeline: transitions, actors, remarks, sent vs received, chronological");
  console.log("monthly-detail-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
