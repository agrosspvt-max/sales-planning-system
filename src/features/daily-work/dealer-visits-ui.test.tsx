/** Dealer Visits UI: the Visits table (Dealer / Task Type / Purpose / Action), Add Relationship Visits, the Follow-up Type and Purpose requirements of the shared Add Dealer dialog. No DB / browser. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const L = DEFAULT_LABELS as Record<string, string>;
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m); // arrays from the VM loader are cross-realm
let cursor = 0;
let summary: unknown;
type Sel = { value: string; options: { value: string; label: string }[]; onChange: (e: { target: { value: string } }) => void; "aria-label"?: string; required?: boolean; disabled?: boolean };
let selects: Sel[] = []; let areas: { value: string; onChange: (e: { target: { value: string } }) => void }[] = [];
let buttons: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void }[] = [];
const hooks: unknown[] = [];
const useState = (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = i in seedByIndex ? seedByIndex[i] : typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (v: unknown) => { hooks[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks[i]) : v; }]; };
let seedByIndex: Record<number, unknown> = {};
const load = testLoader({
  react: { ...React, useState, useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }) },
  "@tanstack/react-query": { useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({ data: queryKey[0] === "dealer-choices" ? { dealers: [{ id: "d9", name: "Zeta" }], owners: [] } : summary, isLoading: false, isFetching: false, isError: false }), useQueryClient: () => ({ invalidateQueries: () => undefined }), useMutation: () => ({ isPending: false, mutate: () => undefined }), keepPreviousData: undefined },
  "@/lib/api-client": { api: { get: async () => ({}), post: async () => ({}) } },
  "@/features/labels/label-ui": { useLabel: (k: string) => L[k] ?? k, useLabelResolver: () => (k: string) => L[k] ?? k },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/components/ui/select": { NativeSelect: (p: Sel) => { selects.push(p); return <select aria-label={p["aria-label"]} />; } },
  "@/components/ui/textarea": { Textarea: (p: { value: string; onChange: (e: { target: { value: string } }) => void }) => { areas.push(p); return <textarea value={p.value} readOnly />; } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void; "aria-label"?: string }) => { buttons.push(p); return <button aria-label={p["aria-label"]} disabled={p.disabled}>{p.children}</button>; } },
  "@/components/ui/dialog": { Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div> },
  "@/components/ui/searchable-dropdown": { SearchableDropdown: () => <div data-dropdown /> },
  "./daily-work-page-stubs": {},
});
const page = load("src/features/daily-work/daily-work-page.tsx") as { SummarySection: React.ComponentType<Record<string, unknown>>; AddDealerDialog: React.ComponentType<Record<string, unknown>>; SectionStatusIcon: React.ComponentType<Record<string, unknown>> };
// Report completion must never turn a No Plan / untouched section into a green double tick.
const icon = (props: Record<string, unknown>) => renderToStaticMarkup(<page.SectionStatusIcon {...props} />);
assert.ok(icon({ status: "FILLED" }).includes('aria-label="Filled"'), "Plan keeps its existing tick");
assert.ok(icon({ status: "FILLED", report: true }).includes('aria-label="Plan filled; report pending"'), "submitted plan, unanswered report: single tick");
assert.ok(icon({ status: "FILLED", report: true, reported: true }).includes('lucide-check-check'), "completed report: double tick");
assert.ok(!icon({ status: "FILLED", reported: true }).includes('lucide-check-check'), "report completion does not double the Plan tick");
assert.ok(icon({ status: "NO_PLAN", report: true, reported: true }).includes('text-noplan'), "No Plan keeps its purple marker even on finalized reports");
assert.ok(!icon({ status: "REMAINING", report: true, reported: true }).includes('<svg'), "untouched sections have no icon");
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const base = { section: "SUMMARY", workDate: "2026-10-23", dealerVisits: 2, newPartyVisits: 3, others: "", actualDealerVisits: null, actualNewPartyVisits: null, status: "DRAFT", batches: [], canPickDealerOwner: false };
const renderVisits = (data: unknown, rel: unknown[] = [], view = "PLAN") => { summary = data; cursor = 0; selects = []; areas = []; buttons = []; hooks.length = 0; seedByIndex = { 0: rel }; return renderToStaticMarkup(<page.SummarySection workDate="2026-10-23" focus="VISITS" view={view} locked={false} />); };

// 1. The Visits table replaces the editable Dealer Visits number.
let html = renderVisits({ ...base, visitRows: [{ dealerId: "d1", dealerName: "Alpha", sources: ["SALES", "RECOVERY"], purpose: null, alreadyPlanned: false }, { dealerId: "d2", dealerName: "Beta", sources: ["SALES"], purpose: null, alreadyPlanned: true }] },
  [{ dealerId: "d3", dealerName: "Gamma", purpose: "Review stock" }]);
let t = text(html);
for (const k of ["col.dealer", "daily_work.col.task_type", "daily_work.visits.col.purpose", "daily_work.visits.col.action"]) assert.ok(t.includes(L[k]!), `column ${k}`);
assert.ok(t.includes(L["daily_work.visits.add_relationship"]!), "Add Relationship Visits button");
assert.ok(!/<input[^>]*type="number"[^>]*>[^]*?<\/div>[^]*?New Party/.test(html) || (html.match(/type="number"/g) ?? []).length === 1, "only ONE numeric input remains (New Party Visits)");
assert.equal((html.match(/type="number"/g) ?? []).length, 1, "the Dealer Visits number input is gone; New Party Visits stays");
assert.ok(t.includes(L["daily_work.visits.new_party_visits"]!), "New Party Visits is unchanged");
// Rows: one per dealer; Task Type = every source; purpose shown for a Relationship visit.
same([...html.matchAll(/data-testid="visit-task-type">([^<]*)</g)].map((m) => m[1]), ["Sales, Recovery", "Sales", "Relationship"]);
assert.ok(t.includes("Review stock"), "the Relationship purpose is shown");
assert.ok(t.includes(L["daily_work.visits.already_planned"]!), "a dealer already planned in an earlier batch is marked");
// Planned total = unique dealers not already counted (a derived number, not an input).
assert.equal(/data-testid="planned-dealer-visits">(\d+)</.exec(html)![1], "2", "Alpha + Gamma counted; Beta was counted in an earlier submission");
// Actions: only a Relationship component is removable; source-linked rows cannot be deleted here.
assert.equal((html.match(/aria-label="Remove relationship visit"/g) ?? []).length, 1, "a remove action for the Relationship row only");
// A relationship + sales row keeps both facts.
html = renderVisits({ ...base, visitRows: [{ dealerId: "d1", dealerName: "Alpha", sources: ["SALES"], purpose: null, alreadyPlanned: false }] }, [{ dealerId: "d1", dealerName: "Alpha", purpose: "Intro" }]);
same([...html.matchAll(/data-testid="visit-task-type">([^<]*)</g)].map((m) => m[1]), ["Relationship, Sales"], "one row, Relationship + Sales");
assert.equal((html.match(/data-dealer-id="d1"/g) ?? []).length, 1, "one dealer, one row");
// Empty state.
t = text(renderVisits({ ...base, dealerVisits: 0, visitRows: [] }));
assert.ok(t.includes(L["daily_work.visits.empty"]!), "empty state");
// Legacy Daily Report batches retain their numeric table.
html = renderVisits({ ...base, visitRows: [], batches: [{ entryId: "e1", batchId: "b1", dealerVisits: 2, newPartyVisits: 3, actualDealerVisits: null, actualNewPartyVisits: null, others: "", noPlanSections: null, status: "PLAN_SUBMITTED" }] }, [], "REPORT");
assert.ok(html.includes(L["daily_work.visits.planned_dealer_visits"]!) && !html.includes('data-testid="dealer-visits-table"'), "Report: planned counts per batch and the existing actual-count entry");

// Identifiable dealer visits require an explicit result per row, with no preselected answer or editable total.
const reportData = { ...base, status: "PLAN_SUBMITTED", visitRows: [], reportVisitRows: [
  { entryId: "e1", batchId: "b1", dealerId: "d1", dealerName: "Alpha", sources: ["SALES", "RECOVERY"], purpose: null, result: null },
  { entryId: "e1", batchId: "b1", dealerId: "d2", dealerName: "Beta", sources: ["RELATIONSHIP"], purpose: "Review stock", result: null },
], batches: [{ entryId: "e1", batchId: "b1", dealerVisits: 2, newPartyVisits: 3, actualDealerVisits: null, actualNewPartyVisits: null, others: "", noPlanSections: null, status: "PLAN_SUBMITTED" }] };
html = renderVisits(reportData, [], "REPORT");
assert.ok(html.includes('data-testid="report-dealer-visits"') && text(html).includes("Sales, Recovery") && text(html).includes("Review stock"));
assert.equal(selects.length, 2, "one choice for every unique dealer, across all sources");
for (const select of selects) { same(select.options.map((option) => option.value), ["", "VISITED", "NOT_VISITED"]); assert.equal(select.value, ""); assert.equal(select.required, true); }
assert.equal((html.match(/type="number"/g) ?? []).length, 1, "only New Party Visits remains a number for dealer-based reports");
selects[0].onChange({ target: { value: "VISITED" } }); selects[1].onChange({ target: { value: "NOT_VISITED" } });
cursor = 0; selects = [];
html = renderToStaticMarkup(<page.SummarySection workDate="2026-10-23" focus="VISITS" view="REPORT" locked={false} />);
assert.ok(html.includes('data-testid="derived-visited-count">1</span>'), "Not Visited counts zero; the total follows the choices");
same(selects.map((select) => select.value), ["VISITED", "NOT_VISITED"], "rerender retains each edited choice");
cursor = 0; selects = [];
renderToStaticMarkup(<page.SummarySection workDate="2026-10-23" focus="VISITS" view="REPORT" locked={true} />);
assert.ok(selects.every((select) => select.disabled), "finalized reports lock both result choices");

// 2. The shared Add Dealer dialog: Follow-up Type and Purpose are opt-in.
const labels = { title: "Add", choose: "Choose Dealer", select: "Select", noMore: "None", cancel: "Cancel", add: "Add Dealer" };
const added: unknown[][] = [];
const dlg = (props: Record<string, unknown>) => { cursor = 0; selects = []; areas = []; buttons = []; return renderToStaticMarkup(<page.AddDealerDialog labels={labels} available={[{ id: "d1", name: "Alpha" }]} onClose={() => undefined} onAdd={(...a: unknown[]) => added.push(a)} {...props} />); };
const followUp = { label: "Follow-up Type", placeholder: "Select Follow-up Type…", options: [{ value: "VISIT", label: "Visit" }, { value: "TELEPHONIC", label: "Telephonic" }] };
hooks.length = 0; seedByIndex = {};
dlg({});
assert.ok(!selects.some((s) => s["aria-label"] === "Follow-up Type") && areas.length === 0, "a dialog without the options (Scheme Conversion …) shows neither field");
hooks.length = 0; dlg({ followUp });
const fu = selects.find((s) => s["aria-label"] === "Follow-up Type")!;
same(fu.options.map((o) => o.label), ["Select Follow-up Type…", "Visit", "Telephonic"], "placeholder first, then Visit and Telephonic; neither is selected");
assert.equal(fu.value, "", "no option is selected initially");
const add = () => buttons.find((b) => b.children === "Add Dealer")!;
assert.equal(add().disabled, true, "Add is disabled with nothing chosen");
// choose a dealer (state index 0 is the dealer id) — still disabled without a follow-up type
hooks[0] = "d1"; dlg({ followUp });
assert.equal(add().disabled, true, "a dealer alone is not enough: the Follow-up Type is compulsory");
hooks[1] = "VISIT"; dlg({ followUp });
assert.equal(add().disabled ?? false, false); add().onClick!();
same(added.at(-1)!.slice(2), [{ followUpType: "VISIT" }], "the choice is handed to the caller");
// Purpose: blank / whitespace refused.
hooks.length = 0; hooks[0] = "d1"; dlg({ purpose: { label: "Purpose", placeholder: "Why?", required: "Enter the purpose of the visit." } });
assert.equal(add().disabled, true, "no purpose → disabled");
hooks[2] = "   "; hooks[3] = true; const ph = dlg({ purpose: { label: "Purpose", placeholder: "Why?", required: "Enter the purpose of the visit." } });
assert.equal(add().disabled, true, "whitespace-only purpose → disabled");
assert.ok(ph.includes("Enter the purpose of the visit."), "the validation message is shown");
hooks[2] = "  Quarterly review "; dlg({ purpose: { label: "Purpose", placeholder: "Why?", required: "x" } });
assert.equal(add().disabled ?? false, false); add().onClick!();
same(added.at(-1)!.slice(2), [{ purpose: "Quarterly review" }], "the trimmed purpose is handed to the caller");

// 3. Wiring: Sales / Recovery use the Follow-up dropdown; Scheme Conversion does not; manual rows display the Follow-up Type as a compact badge.
const src = readFileSync("src/features/daily-work/daily-work-page.tsx", "utf8");
const conv = src.slice(src.indexOf("SECTION 4 — Scheme Conversion"), src.indexOf("SECTIONS 5 + 6"));
assert.ok(!conv.includes("followUp="), "Scheme Conversion's dialog is untouched");
assert.ok(src.includes("followUp={{ label: L.followUp") && src.includes('data-follow-up={r.followUpType}'), "Sales / Recovery dialogs and rows carry the Follow-up Type");
console.log("dealer-visits-ui.test.tsx — all assertions passed");
