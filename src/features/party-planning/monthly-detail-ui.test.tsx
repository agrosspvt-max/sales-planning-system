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
let buttons: { "aria-label"?: string; children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let inputs: { placeholder?: string; value?: string; type?: string; onChange?: (e: { target: { value: string } }) => void }[] = [];
let combos: { ariaLabel: string; placeholder?: string; emptyText?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }[] = [];
type Sel = { "aria-label"?: string; value: string; placeholder?: string; disabled?: boolean; options: { value: string; label: string }[]; onChange: (e: { target: { value: string } }) => void };
let selects: Sel[] = [];
let failPost = false;
let plans: unknown[] = [];
let sheet: Record<string, unknown> = {};
const SEASONAL_PLANS = [{ id: "sp1", marketName: "Pipariya", marketPotential: "B", type: "Existing" }, { id: "sp2", marketName: "Bareli", marketPotential: "A", type: "New" }];

/* eslint-disable @typescript-eslint/no-explicit-any */
let dealerProps: Record<string, any> | null = null;
const dp = (): Record<string, any> => dealerProps as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */
const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { L: ({ k }: { k: LabelKey }) => <>{DEFAULT_LABELS[k]}</>, useLabel: (k: LabelKey) => DEFAULT_LABELS[k],
    LabelSectionHeaderRow: ({ leading = 0, sections }: { leading?: number; sections: { labelKey: LabelKey; span: number; tone: string; color?: string }[] }) => <tr data-section-row>{leading > 0 && <th colSpan={leading} />}{sections.map((x, i) => <th key={i} colSpan={x.span} data-tone={x.tone} data-color={x.color}>{DEFAULT_LABELS[x.labelKey]}</th>)}</tr> },
  "@/components/ui/select": { NativeSelect: (p: Sel) => { selects.push(p); return <select aria-label={p["aria-label"]} />; } },
  "./party-planning-page": { PartyPlanModeLinks: ({ mode, stage }: { mode: string; stage?: string }) => <nav data-mode={mode} data-stage={stage} /> },
  "@/components/layout/page-header": { PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => <h1>{title}<p>{subtitle}</p></h1> },
  "@tanstack/react-query": {
    useQuery: () => ({ data: { sheet, season: { id: "s1", name: "Kharif", year: 2026, period: "Apr 2026 → Nov 2026" }, month: { id: "sm", name: "June", label: "June 2026", key: "2026-06" }, seasonalPlans: SEASONAL_PLANS, plans }, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: () => { invalidations += 1; } }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: () => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then(() => o.onSuccess?.(), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => ({}), put: async (url: string, body: unknown) => { posts.push({ url, body }); return {}; }, post: async (url: string, body: unknown) => { posts.push({ url, body }); if (failPost) throw new Error("The market could not be saved because the database is busy."); return {}; } } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean; "aria-label"?: string }) => { buttons.push(p); return <button aria-label={p["aria-label"]}>{p.children}</button>; } },
  "@/components/ui/date-input-dmy": { DateInputDMY: (p: { value: string; onChange: (v: string) => void }) => { inputs.push({ ...p, type: "date", onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) } as (typeof inputs)[number]); return <input type="text" defaultValue={p.value} />; } }, // the shared DD/MM/YYYY field (ISO inside)
  "@/components/ui/input": { Input: (p: (typeof inputs)[number]) => { inputs.push(p); return <input placeholder={p.placeholder} defaultValue={p.value} type={p.type} />; } },
  "@/features/sales-upload/create-dealer-dialog": { DealerDialog: (p: Record<string, unknown>) => { dealerProps = p; return <div data-dealer-dialog />; } },
  "@/components/ui/searchable-select": { SearchableSelect: (p: (typeof combos)[number]) => { combos.push(p); return <input role="combobox" aria-expanded={false} aria-controls="x" aria-label={p.ariaLabel} placeholder={p.placeholder} />; } },
  "@/components/ui/dialog": {
    Dialog: ({ children }: { children: React.ReactNode }) => <div data-dialog>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
};
const { MonthlyPlanDetailPage, StatusDialog, StatusTimelineDialog } = testLoader(overrides)("src/features/party-planning/monthly-planning-page.tsx") as { MonthlyPlanDetailPage: React.ComponentType<{ role: Role; sheetId: string; stage?: string }>; StatusDialog: React.ComponentType<{ plan: never; onClose: () => void; onChanged: () => void }>; StatusTimelineDialog: React.ComponentType<{ plan: never; onClose: () => void }> };
const render = (role: Role = Role.SALES_OFFICER, stage: string = "create") => { cursor = 0; buttons = []; inputs = []; combos = []; selects = []; const html = renderToStaticMarkup(<MonthlyPlanDetailPage role={role} sheetId="ms1" stage={stage} />); hooks.length = cursor; return html; };
/** Monthly keeps the subtle column tints but NO grouped heading row: one header row only, and the colgroup covers exactly the rendered columns (S.No included). */
const assertPlainHeader = (html: string) => {
  assert.ok(!html.includes("data-section-row") && !/Party Options<\/th><th[^>]*>Progress|>Progress</.test(html), "no grouped heading row");
  const head = /<thead[^>]*>(.*?)<\/thead>/.exec(html)![1]!;
  assert.equal((head.match(/<tr/g) ?? []).length, 1, "a single header row — nothing above the column headings");
  const columns = (head.match(/<th[ >]/g) ?? []).length;
  const cols = [...html.matchAll(/<col span="(\d+)"([^>]*)\/>/g)];
  assert.equal(cols.reduce((n, m) => n + Number(m[1]), 0), columns, "column tints line up with the rendered columns");
  assert.ok(cols.some((m) => /bg-amber-50/.test(m[2]!)) && cols.some((m) => /bg-green-50/.test(m[2]!)) && cols.some((m) => /bg-blue-50/.test(m[2]!)), "the subtle body colours remain");
  assert.ok(!/#FF3445/.test(html), "no red heading background");
};
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
  // Opened plan = compact Back + breadcrumbs only: no title/subtitle header, no mode switch, no Seasonal | Monthly tabs.
  assert.ok(!html.includes("<h1") && !html.includes("data-mode") && !html.includes("data-stage") && !html.includes("Party Planning</h1>"), "no large title, subtitle or navigation switches");
  assert.ok(html.includes('data-testid="plan-detail-bar"') && html.includes('href="/planning/party/monthly?stage=create"') && html.includes("Kharif 2026 · June 2026"), "Back to the Create list; the season + month stay in the breadcrumbs");
  assert.equal(count("Add Market"), 1);
  const footerEmpty = /<div class="flex flex-wrap items-center justify-between gap-2 border-t p-2"><div><button>[^]*?Add Market<\/button><\/div>/.exec(html);
  assert.ok(footerEmpty, "Add Market: first child of the footer row, left-aligned (not centered in the empty state)");
  assert.ok(html.lastIndexOf("Add Market") > html.lastIndexOf("</table>"), "…directly below the table");
  // populated: the SAME footer row
  plans = [PLAN]; html = render();
  assert.ok(/border-t p-2"><div><button>[^]*?Add Market<\/button><\/div>/.test(html), "same position with rows");
  assert.deepEqual([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ["S.No", "Market", "Party Options", "Status", "Conversion Date", "Days"], "column headings and their order are unchanged (the group row sits above them)");
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
  assert.ok(html.includes("Option 1 Party *") && html.includes("Option 2 Party *") && !html.includes("Option 3 Party"), "two mandatory option rows to start with");
  const addBtn = () => buttons.filter((b) => String(b.children).includes("Add Option")).at(-1)!;
  const removeBtns = () => buttons.filter((b) => b["aria-label"]?.startsWith("Remove Option"));
  assert.equal(removeBtns().length, 0, "the two required rows cannot be removed");
  field(-1, "2026-06-20"); field(0, "Party One"); field(1, "Party Two");
  const turnoverSel = (n: number) => selects.filter((x) => x["aria-label"]?.includes("Tentative Turnover"))[n - 1]!;
  const rowsNow = () => selects.filter((x) => x["aria-label"]?.includes("Tentative Turnover")).length;
  assert.equal(JSON.stringify([turnoverSel(1).placeholder, turnoverSel(1).value, turnoverSel(2).value]), JSON.stringify(["Select Turnover…", "", ""]), "nothing is preselected");
  assert.equal(JSON.stringify(turnoverSel(1).options.map((o) => o.label)), JSON.stringify(["Less than 50 Lakh", "50 Lakh to 1 CR", "1 CR to 2 CR", "2 CR to 4 CR", "4 CR+"]));
  assert.equal(JSON.stringify(turnoverSel(1).options.map((o) => o.value)), JSON.stringify(["LT_50L", "50L_TO_1CR", "1CR_TO_2CR", "2CR_TO_4CR", "GT_4CR"]), "stable stored codes, not wording");
  const addClick = async () => { buttons.filter((b) => String(b.children) === "Add").at(-1)!.onClick!(); await tick(); return render(); };
  assert.ok((await addClick()).includes("Option 1: Tentative Turnover is required.") && posts.length === 0, "a missing turnover blocks the save");
  turnoverSel(1).onChange({ target: { value: "50L_TO_1CR" } }); render();
  assert.ok((await addClick()).includes("Option 2: Tentative Turnover is required.") && posts.length === 0, "every option needs its own turnover — Option 2 is mandatory too");
  turnoverSel(2).onChange({ target: { value: "GT_4CR" } }); render();
  // Add Option → Option 3 (party + turnover); an empty extra option must be completed or removed; removing keeps the other rows' entries.
  addBtn().onClick!(); let h = render();
  assert.ok(h.includes("Option 3 Party *") && rowsNow() === 3 && removeBtns().length === 1, "Add Option adds a party-and-turnover pair, removable");
  assert.ok((await addClick()).includes("Option 3: enter the party name.") && posts.length === 0, "a blank extra option blocks the save");
  field(2, "Party Three"); turnoverSel(3).onChange({ target: { value: "1CR_TO_2CR" } }); render();
  addBtn().onClick!(); h = render();
  assert.ok(h.includes("Option 4 Party *") && removeBtns().length === 2);
  field(3, "Party Four"); turnoverSel(4).onChange({ target: { value: "LT_50L" } }); render();
  removeBtns()[0]!.onClick!(); h = render(); // remove Option 3 (the first removable): Option 4 becomes Option 3 and nothing else is lost
  assert.equal(rowsNow(), 3); assert.ok(h.includes("Party One") && h.includes("Party Two") && h.includes("Party Four") && !h.includes("Party Three"), "removal keeps the other rows' names");
  assert.equal(JSON.stringify([turnoverSel(1).value, turnoverSel(2).value, turnoverSel(3).value]), JSON.stringify(["50L_TO_1CR", "GT_4CR", "LT_50L"]), "…and their turnover selections");
  // A failed save (e.g. the busy / timeout message): the message is shown, EVERY entered value is kept, the dialog stays open and Add is available again.
  failPost = true; invalidations = 0;
  const failedHtml = await addClick();
  assert.ok(failedHtml.includes("database is busy"), "a useful message is shown");
  assert.equal(JSON.stringify([turnoverSel(1).value, turnoverSel(2).value, turnoverSel(3).value, combos.at(-1)!.value]), JSON.stringify(["50L_TO_1CR", "GT_4CR", "LT_50L", "sp2"]), "turnover choices and market are retained");
  assert.ok(failedHtml.includes("Party One") && failedHtml.includes("Party Two") && failedHtml.includes("Party Four") && failedHtml.includes("2026-06-20"), "party names and date are retained");
  assert.equal(invalidations, 0, "a failed save does not close the dialog or refresh as if it succeeded");
  assert.equal(buttons.filter((b) => String(b.children) === "Add").at(-1)!.disabled, false, "Add is usable again after the failure");
  failPost = false; posts.length = 0;
  buttons.filter((b) => String(b.children) === "Add").at(-1)!.onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans", body: { sheetId: "ms1", seasonalPlanId: "sp2", planDate: "2026-06-20", options: [
    { partyName: "Party One", turnoverCategory: "50L_TO_1CR" }, { partyName: "Party Two", turnoverCategory: "GT_4CR" }, { partyName: "Party Four", turnoverCategory: "LT_50L" }] } }], "a structured options array — one entry per option, each with its OWN turnover");
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
    assert.ok(html.includes(`href="/planning/party/monthly?stage=${stage}"`) && !html.includes("data-mode") && html.includes(">Days</th>") && html.includes(text), `${stage}: the same table, section-specific empty text`);
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
  const SO_ROW = { ...PLAN, statusLabel: "Pending", allowedStatuses: [{ to: "DOC_SENT", label: "Doc Send By SO" }] };
  sheet = approved; plans = [SO_ROW]; html = render();
  assert.ok(html.includes("Pending ▾") && html.includes('aria-label="Change status of Pipariya"'), "the SO can click the status");
  plans = [{ ...PLAN, statusLabel: "Pending", allowedStatuses: [] }]; html = render();
  assert.ok(!html.includes("Change status of") && html.includes(">Pending<"), "no clickable status without an allowed move");
  plans = [{ ...PLAN, statusLabel: "Draft" }]; sheet = { ...base }; assert.ok(render().includes(">Draft<"));
  // ---- Status dialog (state seeded through the hook store: [to, doc, remarks, confirming, error, dealerOpen, sent]) ----
  const dlg = (plan: unknown, seed: unknown[] = []) => { hooks.length = 0; seed.forEach((v, i) => { hooks[i] = v; }); cursor = 0; buttons = []; const out = renderToStaticMarkup(<StatusDialog plan={plan as never} onClose={() => {}} onChanged={() => { invalidations += 100; }} />); hooks.length = cursor; return out; };
  const btn = (label: string) => buttons.filter((b) => String(b.children).includes(label)).at(-1)!;
  // SO · Doc Send By SO — Document / Cheque × Complete / Incomplete, plus "Appointed, Document Not Sent" at the top
  const NONE = { notSent: false, documentStatus: null, chequeStatus: null, other: "" };
  const seedSend = (sent: Record<string, unknown>, confirming = false) => ["DOC_SENT", { documents: false, checks: false, other: "" }, "", confirming, null, false, { ...NONE, ...sent }];
  const box = (html: string, id: string) => { const m = new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`).exec(html); assert.ok(m, `checkbox ${id}`); return { checked: /checked=""/.test(m![0]), disabled: /disabled=""/.test(m![0]) }; };
  const IDS = ["document-complete", "document-incomplete", "cheque-complete", "cheque-incomplete"];
  let d = dlg(SO_ROW);
  assert.ok(d.includes("Appointed, Document Not Sent") && d.includes("Complete") && d.includes("Incomplete") && d.includes("Document") && d.includes("Cheque") && d.includes("Other Details (Optional)"), "special option + the Document / Cheque × Complete / Incomplete grid + optional Other Details");
  assert.ok(!d.includes("Document Sent") && !d.includes("Check Send"), "the old single checkboxes are gone");
  assert.ok(d.indexOf("Appointed, Document Not Sent") < d.indexOf("Complete") && d.indexOf("Appointed, Document Not Sent") < d.indexOf("Cheque"), "the special option sits above the Document / Cheque choices");
  assert.ok(/text-base[^"]*font-medium/.test(d) && d.includes('class="h-5 w-5"'), "…and is slightly larger");
  for (const id of IDS) assert.deepEqual(box(d, id), { checked: false, disabled: false }, `${id}: nothing is preselected`);
  assert.equal(box(d, "not-sent-special").checked, false);
  assert.equal(btn("Continue").disabled, true, "both answers are required");
  assert.ok(d.includes('data-testid="sent-hint"'), "the unanswered hint is shown");
  d = dlg(SO_ROW, seedSend({ documentStatus: "COMPLETE" })); assert.equal(btn("Continue").disabled, true, "Cheque unanswered");
  d = dlg(SO_ROW, seedSend({ chequeStatus: "INCOMPLETE" })); assert.equal(btn("Continue").disabled, true, "Document unanswered");
  d = dlg(SO_ROW, seedSend({ other: "just text" })); assert.equal(btn("Continue").disabled, true, "Other alone does not satisfy the requirement");
  d = dlg(SO_ROW, seedSend({ documentStatus: "COMPLETE", chequeStatus: "INCOMPLETE" }));
  assert.deepEqual([box(d, "document-complete").checked, box(d, "document-incomplete").checked, box(d, "cheque-complete").checked, box(d, "cheque-incomplete").checked], [true, false, false, true], "one choice per item");
  assert.equal(btn("Continue").disabled, false);
  d = dlg(SO_ROW, seedSend({ documentStatus: "INCOMPLETE", chequeStatus: "INCOMPLETE" })); assert.equal(btn("Continue").disabled, false, "both Incomplete is a valid explicit answer");
  // Special option: clears + disables the four boxes, allows Continue, keeps Other Details
  d = dlg(SO_ROW, seedSend({ notSent: true, other: "courier" }));
  for (const id of IDS) assert.deepEqual(box(d, id), { checked: false, disabled: true }, `${id} cleared and disabled`);
  assert.equal(box(d, "not-sent-special").checked, true); assert.equal(btn("Continue").disabled, false);
  assert.ok(!d.includes('data-testid="sent-hint"') && d.includes("Other Details (Optional)"), "no answers required; Other Details stays available");
  // Un-checking leaves the four unanswered and enabled again (previous choices are NOT silently restored)
  d = dlg(SO_ROW, seedSend({ notSent: false }));
  for (const id of IDS) assert.deepEqual(box(d, id), { checked: false, disabled: false });
  assert.equal(btn("Continue").disabled, true);
  posts.length = 0;
  d = dlg(SO_ROW, seedSend({ documentStatus: "COMPLETE", chequeStatus: "INCOMPLETE", other: "GST" }, true));
  assert.ok(d.includes("Change the status of") && d.includes("Doc Send By SO") && d.includes("Confirm Doc Send By SO") && d.includes("Complete") && d.includes("Incomplete"), "the SO must confirm; the summary shows the answers");
  assert.ok(d.includes('data-testid="sent-document">Complete<') && d.includes('data-testid="sent-cheque">Incomplete<'), "confirmation summary: Document Complete, Cheque Incomplete");
  assert.equal(posts.length, 0, "nothing is saved before Confirm");
  btn("Confirm Doc Send By SO").onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans/p1/status", body: { to: "DOC_SENT", sent: { documentNotSent: false, documentStatus: "COMPLETE", chequeStatus: "INCOMPLETE", other: "GST" } } }], "saved through the row status endpoint with the explicit answers");
  assert.ok(invalidations >= 100, "the table is refreshed");
  posts.length = 0; btn("Back").onClick!(); assert.equal(posts.length, 0, "Back / Cancel never save");
  // Special option: confirmation names the resulting status; the saved body carries no Document / Cheque answers
  posts.length = 0;
  d = dlg(SO_ROW, seedSend({ notSent: true, documentStatus: "COMPLETE", other: "courier" }, true));
  assert.ok(d.includes("Confirm Document Not Sent") && d.includes('data-testid="sent-not-sent"'), "confirms Document Not Sent");
  assert.equal(posts.length, 0, "ticking the option alone saves nothing");
  btn("Confirm Document Not Sent").onClick!(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans/p1/status", body: { to: "DOC_SENT", sent: { documentNotSent: true, documentStatus: null, chequeStatus: null, other: "courier" } } }], "stale answers are never sent with the special option");
  // Later submission from a Document Not Sent row (same form; allowed move is Doc Send By SO)
  const NOT_SENT_ROW = { ...SO_ROW, opStatus: "DOC_NOT_SENT", statusLabel: "Document Not Sent" };
  d = dlg(NOT_SENT_ROW);
  assert.ok(d.includes("Document Not Sent") && d.includes("Appointed, Document Not Sent") && d.includes("Cheque"), "a Document Not Sent row reopens the same form, shows its current status");
  for (const id of IDS) assert.equal(box(d, id).checked, false, "unanswered, nothing restored");
  assert.equal(btn("Continue").disabled, true);
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
    { id: "e1", previousStatus: "NONE", newStatus: "DOC_SENT", previousLabel: "Pending", newLabel: "Doc Send By SO", actorName: "Officer One", actorRole: "SALES_OFFICER", remarks: null, sentInfo: { documents: true, checks: false, other: "GST" }, receivedInfo: null, createdAt: "2026-10-08T10:00:00.000Z" },
    { id: "e2", previousStatus: "DOC_SENT", newStatus: "DOC_RECEIVED", previousLabel: "Doc Send By SO", newLabel: "Doc Received", actorName: "Admin", actorRole: "SUPER_ADMIN", remarks: "ok", sentInfo: null, receivedInfo: { documents: false, checks: true, other: null }, createdAt: "2026-10-08T11:00:00.000Z" },
  ] } as never} onClose={() => {}} />);
  assert.ok(tl.includes("Pending → Doc Send By SO") && tl.includes("Doc Send By SO → Doc Received") && tl.includes("Officer One") && tl.includes("Remarks: ok") && tl.includes("Actually received (Admin)") && tl.indexOf("Officer One") < tl.indexOf("Admin"), "timeline: transitions, actors, remarks, sent vs received, chronological");
  // Legacy history stays readable and keeps its original meaning (the old "sent" booleans are NOT turned into Complete / Incomplete)
  assert.ok(tl.includes("Document Sent: <b>Selected</b>") && tl.includes("Check Send: <b>Not selected</b>") && tl.includes("completeness not recorded") && !tl.includes('data-testid="sent-document"'), "legacy record: original meaning, completeness unrecorded");
  const tl2 = renderToStaticMarkup(<StatusTimelineDialog plan={{ ...LATE, statusEvents: [
    { id: "n1", previousStatus: "NONE", newStatus: "DOC_NOT_SENT", previousLabel: "Pending", newLabel: "Document Not Sent", actorName: "Officer One", actorRole: "SALES_OFFICER", remarks: null, sentInfo: { documentStatus: null, chequeStatus: null, documentNotSent: true, other: "courier" }, receivedInfo: null, createdAt: "2026-10-09T10:00:00.000Z" },
    { id: "n2", previousStatus: "DOC_NOT_SENT", newStatus: "DOC_SENT", previousLabel: "Document Not Sent", newLabel: "Doc Send By SO", actorName: "Officer One", actorRole: "SALES_OFFICER", remarks: null, sentInfo: { documentStatus: "INCOMPLETE", chequeStatus: "COMPLETE", documentNotSent: false, other: null }, receivedInfo: null, createdAt: "2026-10-10T10:00:00.000Z" },
  ] } as never} onClose={() => {}} />);
  assert.ok(tl2.includes("Pending → Document Not Sent") && tl2.includes("Document Not Sent → Doc Send By SO") && tl2.includes('data-testid="sent-not-sent"') && tl2.includes('data-testid="sent-document">Incomplete<') && tl2.includes('data-testid="sent-cheque">Complete<'), "timeline shows the special answer and the later Complete / Incomplete answers");
  // Editing the options of an existing editable entry (older drafts reach the two-complete-options rule here); non-editable entries have no edit control.
  {
    const legacyOpts = [{ id: "o1", optionNo: 1, partyName: "Party A", turnoverCategory: null }, { id: "o2", optionNo: 2, partyName: null, turnoverCategory: null }];
    hooks.length = 0; posts.length = 0; plans = [{ ...PLAN, canEditEntry: true, options: legacyOpts }];
    let h = render();
    assert.ok(h.includes('aria-label="Edit party options for Pipariya"') && h.includes("Not recorded"), "an editable entry offers Edit Options; the missing turnover reads Not recorded");
    buttons.find((b) => b["aria-label"] === "Edit party options for Pipariya")!.onClick!(); h = render();
    assert.ok(h.includes("Edit Party Options") && h.includes("Option 1 Party *") && h.includes("Option 2 Party *"), "the saved rows (incl. the blank legacy slot) are shown");
    const save = () => buttons.filter((b) => String(b.children) === "Save").at(-1)!;
    save().onClick!(); await tick(); h = render();
    assert.ok(h.includes("Option 1: Tentative Turnover is required.") && posts.length === 0, "an older incomplete draft cannot be saved until it is complete");
    selects.filter((x) => x["aria-label"]?.includes("Tentative Turnover"))[0]!.onChange({ target: { value: "LT_50L" } }); render();
    inputs.filter((x) => !x.type && x.placeholder !== "Search market…")[1]!.onChange!({ target: { value: "Party B" } }); render();
    selects.filter((x) => x["aria-label"]?.includes("Tentative Turnover"))[1]!.onChange({ target: { value: "GT_4CR" } }); render();
    save().onClick!(); await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/party-monthly-plans/p1", body: { options: [{ id: "o1", partyName: "Party A", turnoverCategory: "LT_50L" }, { id: "o2", partyName: "Party B", turnoverCategory: "GT_4CR" }] } }].map((x) => x), "persisted options keep their ids");
    hooks.length = 0; plans = [{ ...PLAN, canEditEntry: false, options: legacyOpts }];
    assert.ok(!render().includes("Edit party options for"), "submitted / in-workflow entries cannot be edited");
    // three options display in the table, ordered, each with its turnover
    plans = [{ ...PLAN, options: [option(1, "Party A"), option(2, "Party B"), option(3, "Party C")] }]; hooks.length = 0;
    assert.ok(/Party A[^]*Party B[^]*Party C/.test(render()), "every option is displayed");
  }
  // Plain single header row (with the subtle column tints) on every stage/role.
  hooks.length = 0; plans = [PLAN];
  for (const [role, stage] of [[Role.SALES_OFFICER, "create"], [Role.SALES_OFFICER, "submitted"], [Role.REGIONAL_MANAGER, "approved"], [Role.SUPER_ADMIN, "older"]] as const) {
    hooks.length = 0; assertPlainHeader(render(role, stage));
  }
  hooks.length = 0; plans = []; assertPlainHeader(render()); // the empty state keeps the same header
  console.log("monthly-detail-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
