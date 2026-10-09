/** Seasonal Plan detail: the "Add Market" popup (no inline form; bottom / empty-state button) saves a row INTO THIS plan via POST /api/seasonal-plans { sheetId, … }. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

let hooks: unknown[] = [];
let cursor = 0;
const posts: { url: string; body: unknown }[] = [];
let invalidations = 0;
let plans: unknown[] = [];
let selects: { value?: string; options: { value: string; label: string }[]; onChange?: (e: unknown) => void }[] = [];
let sheet: Record<string, unknown> = { id: "sh1", seasonName: "Kharif 2026", seasonOpen: true, ownerName: "Officer One", status: "Draft", own: true };
const season = { id: "s1", name: "Kharif", year: 2026, period: "Apr 2026 → Nov 2026", months: [{ name: "April" }] };
const MARKETS = [{ id: "m-pip", name: "Pipariya" }, { id: "m-bar", name: "Bareli" }];
let buttons: { children?: React.ReactNode; onClick?: () => void }[] = [];
let inputs: { placeholder?: string; value?: string; onChange?: (e: { target: { value: string } }) => void; list?: string }[] = [];

const overrides = {
  react: {
    ...React,
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }];
    },
  },
  "@/features/labels/label-ui": { L: ({ k }: { k: LabelKey }) => <>{DEFAULT_LABELS[k]}</>, useLabel: (k: LabelKey) => DEFAULT_LABELS[k] },
  "@/features/party-planning/party-planning-page": { PartyPlanModeLinks: () => null },
  "./party-planning-page": { PartyPlanModeLinks: () => null },
  "@/components/layout/page-header": { PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => <h1>{title}<p>{subtitle}</p></h1> },
  "@tanstack/react-query": {
    useQuery: ({ queryKey }: { queryKey: string[] }) => {
      if (queryKey[0] === "territory-markets") return { data: MARKETS };
      return { data: { sheet, season, plans }, isLoading: false }; // ["seasonal-sheet", id, search]
    },
    useQueryClient: () => ({ invalidateQueries: () => { invalidations += 1; } }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: () => void; onError?: (e: unknown) => void }) => ({
      isPending: false,
      mutate: (v?: unknown) => { void o.mutationFn(v).then(() => o.onSuccess?.(), (e) => o.onError?.(e)); },
    }),
  },
  "@/lib/api-client": { api: { get: async () => [], put: async () => ({}), del: async () => ({}), post: async (url: string, body: unknown) => { posts.push({ url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void }) => { buttons.push(p); return <button>{p.children}</button>; } },
  "@/components/ui/input": { Input: (p: { placeholder?: string; value?: string; list?: string }) => { inputs.push(p as (typeof inputs)[number]); return <input placeholder={p.placeholder} defaultValue={p.value} list={p.list} />; } },
  "@/components/ui/select": { NativeSelect: (p: { value?: string; options: { value: string; label: string }[]; onChange?: (e: unknown) => void }) => { selects.push(p as (typeof selects)[number]); return <select defaultValue={p.value}>{p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>; } },
  "@/components/ui/dialog": {
    Dialog: ({ children }: { children: React.ReactNode }) => <div data-dialog>{children}</div>,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
};
const { SeasonalPlanDetailPage } = testLoader(overrides)("src/features/party-planning/seasonal-planning-page.tsx") as { SeasonalPlanDetailPage: React.ComponentType<{ role: Role; sheetId: string; stage?: string }> };

const render = (role: Role = Role.SALES_OFFICER, stage: string = "create") => {
  cursor = 0; buttons = []; inputs = []; selects = [];
  const html = renderToStaticMarkup(<SeasonalPlanDetailPage role={role} sheetId="sh1" stage={stage} />);
  hooks.length = cursor; // a component that is no longer rendered (the closed popup) loses its state, like a real unmount
  return html;
};
const click = (label: string) => { const b = buttons.filter((x) => String(x.children).includes(label)); assert.ok(b.length >= 1, `button "${label}"`); b[b.length - 1]!.onClick!(); };
const count = (html: string, text: string) => html.split(text).length - 1;
const type = (placeholder: string, value: string) => inputs.filter((i) => i.placeholder === placeholder).at(-1)!.onChange!({ target: { value } });
const tick = () => new Promise((r) => setTimeout(r, 0));
const PLAN = { id: "p1", sheetId: "sh1", canReview: false, seasonName: "Kharif", ownerName: "Officer One", marketId: "m-pip", marketName: "Pipariya", type: "Existing", marketPotential: "B", status: "—", appointmentDate: null, approvalStatus: "DRAFT", rejectionStage: null, rejectionReason: null, rmDecidedByName: null, rmDecidedAt: null, adminDecidedByName: null, adminDecidedAt: null, createdAt: "2026-10-07T00:00:00.000Z", editable: true };

async function main() {
  // 1) Empty list: no inline form, the empty state carries ONE "+ Add Market" button.
  let html = render();
  assert.ok(html.includes("No Seasonal Plans here yet."));
  assert.ok(!html.includes("Tentative party name") && !html.includes("Search Market…") && !/Add plan/.test(html), "the permanent inline Market / Party Name / Add plan form is gone");
  assert.equal(buttons.filter((b) => String(b.children).includes("Add Market")).length, 1, "exactly one Add Market button in the empty state");
  // Same layout as the populated state: the message stays in the table; the button is in the separate bottom row, outside the table.
  const emptyCell = /<td[^>]*>No Seasonal Plans here yet\.<\/td>/.exec(html);
  assert.ok(emptyCell && !emptyCell[0].includes("Add Market"), "the empty-state cell holds only the message");
  assert.ok(html.lastIndexOf("Add Market") > html.lastIndexOf("</table>"), "the Add Market button is below the table, in the footer row");
  assert.match(html, /border-t p-2"><div><button>[^]*Add Market<\/button><\/div>/, "the SAME footer row (border-t p-2) as the populated state");
  assert.ok(!html.includes("data-dialog"), "no popup until the button is clicked");

  // 2) Click → the popup opens with Market*, Party Name*, Cancel, Add Plan.
  click("Add Market");
  html = render();
  for (const text of ["Market *", "Cancel", "Add Plan", "Search Market…"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes("Party Name") && !html.includes("Tentative party name") && inputs.filter((i) => i.placeholder !== "Search Market…" && i.placeholder !== "Search Market...").length === 0, "the popup asks for the Market only — no Party Name field");
  assert.ok(inputs.some((i) => i.list === "seasonal-add-markets"), "the same searchable Market selector (datalist of eligible Markets)");
  assert.ok(html.includes('<option value="Pipariya"') && html.includes('<option value="Bareli"'), "options are the eligible Markets only");

  // 3) Cancel closes without calling the API.
  click("Cancel");
  html = render();
  assert.ok(!html.includes("data-dialog") && posts.length === 0, "Cancel closes the popup without any change");

  // 4) Validation still works (nothing is sent).
  click("Add Market"); render();
  click("Add Plan"); html = render();
  assert.ok(html.includes("Select a Market from the list.") && posts.length === 0, "a Market is required");
  type("Search Market…", "Not A Market"); render();
  click("Add Plan"); html = render();
  assert.ok(html.includes("Select a Market from the list.") && posts.length === 0, "arbitrary text is not a Market");
  type("Search Market…", "pipariya"); render();

  // 5) Add: the SAME endpoint + payload as before; popup closes, list refreshes, state is cleared, button stays available.
  click("Add Plan"); await tick(); // a chosen Market is all that is needed
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/seasonal-plans", body: { sheetId: "sh1", marketId: "m-pip" } }], "POST /api/seasonal-plans { sheetId, marketId } — no party name; the row joins THIS plan");
  assert.ok(invalidations >= 1, "the plan is refreshed");
  plans = [PLAN];
  html = render();
  assert.ok(!html.includes("data-dialog"), "the popup closed");
  assert.ok(html.includes("Pipariya"), "the new row is in the table");
  assert.ok(!html.includes(">Party Name</th>") && !html.includes("Party Name"), "no Party Name column");
  assert.ok(!html.includes("Season: Kharif") && !html.includes("Apr 2026 → Nov 2026"), "the redundant season banner is gone");
  assert.ok(!html.includes("Search market or party"), "the global search is gone");
  assert.ok(!inputs.some((i) => i.placeholder === "Search Market...") && selects.length === 0 && !html.includes("Search Market..."), "no Market search box and no Market Potential dropdown in the header");
  assert.deepEqual([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ["Market", "Type", "Market Potential", "Status", "Date", "Approval", "Action"], "plain headers: no controls, no gaps; the Market Potential column itself stays");
  for (const gone of ["My plans", "To review", "All plans"]) assert.ok(!html.includes(gone), `the old "${gone}" tab is gone`);
  assert.ok(!html.includes("No Seasonal Plans here yet."));
  assert.equal(buttons.filter((b) => String(b.children).includes("Add Market")).length, 1, "ONE Add Market button remains, at the bottom of the list");
  assert.ok(html.lastIndexOf("Add Market") > html.lastIndexOf("</table>"), "…below the table");
  assert.match(html, /border-t p-2"><div><button>[^]*Add Market<\/button><\/div>/, "the same footer row as the empty state");
  // Several rows: all shown, nothing filtered, values unchanged
  plans = [PLAN, { ...PLAN, id: "p2", marketName: "Bareli", marketPotential: "A" }]; html = render();
  assert.ok(html.includes("Pipariya") && html.includes("Bareli") && html.includes(">B<") && html.includes(">A<"), "market names and potentials are displayed as before");
  for (const stage of ["submitted", "approved", "older"]) { html = render(Role.SALES_OFFICER, stage); assert.ok(!html.includes("Search Market...") && selects.length === 0 && html.includes("Bareli"), `${stage}: same plain table`); }
  plans = [PLAN]; html = render();
  click("Add Market"); html = render();
  assert.ok(html.includes("data-dialog"), "it reopens");
  assert.equal(inputs.filter((i) => i.placeholder === "Search Market…").at(-1)!.value, "");

  // 6) Server errors surface inside the popup (here a rejected request).
  hooks = []; plans = [];
  (overrides["@/lib/api-client"].api as { post: unknown }).post = async () => { throw new Error("That Market is not eligible"); };
  render(); click("Add Market"); render(); type("Search Market…", "Bareli"); render(); click("Add Plan"); await tick();
  assert.ok(render().includes("That Market is not eligible"), "backend validation errors are shown, popup stays open");

  // 7) Who sees the button: SO / RM with an open season only (Admin never creates plans; no season → none).
  hooks = []; plans = [];
  for (const role of [Role.SALES_OFFICER, Role.REGIONAL_MANAGER]) { render(role); assert.equal(buttons.filter((b) => String(b.children).includes("Add Market")).length, 1, String(role)); }
  render(Role.SUPER_ADMIN); assert.equal(buttons.filter((b) => String(b.children).includes("Add Market")).length, 0, "Admin has no Add Market button");
  sheet = { ...sheet, seasonOpen: false }; render(); assert.equal(buttons.filter((b) => String(b.children).includes("Add Market")).length, 0, "a closed season's plan is read-only: no button");
  sheet = { ...sheet, seasonOpen: true, own: false, ownerName: "Officer Two" }; html = render(Role.REGIONAL_MANAGER);
  assert.equal(buttons.filter((b) => String(b.children).includes("Add Market")).length, 0, "someone else's plan: no Add Market");
  assert.ok(html.includes("Officer Two"), "…and the owner is shown");
  // Review actions live on the rows the caller can act on (they replaced the "To review" tab).
  plans = [{ ...PLAN, editable: false, canReview: true, approvalStatus: "PENDING_RM" }, { ...PLAN, id: "p2", marketName: "Bareli", editable: false, canReview: false, approvalStatus: "PENDING_ADMIN" }];
  render(Role.REGIONAL_MANAGER);
  assert.equal(buttons.filter((b) => String(b.children).includes("Approve")).length, 1, "Approve / Reject only on the row the caller can review");
  assert.equal(buttons.filter((b) => String(b.children).includes("Reject")).length, 1);
  assert.equal(buttons.filter((b) => String(b.children).includes("Submit")).length, 0, "…and no owner actions on someone else's plan");

  // 8) Source-level guards: it is NOT the Territory Mapping request, and nothing server-side changed.
  const src = readFileSync("src/features/party-planning/seasonal-planning-page.tsx", "utf8");
  assert.ok(!src.includes("market-requests") && !src.includes("territory-mapping/market-requests"), "no Market Request / approval workflow is invoked from Seasonal Planning");
  assert.equal(count(src, 'api.post("/api/seasonal-plans", { sheetId, marketId })'), 1, "one create call, in the popup");
  // Create is the persistent workspace: Add Market + Submit all only there; other sections are read-only views of the same plan.
  sheet = { ...sheet, seasonOpen: true, own: true }; plans = [PLAN, { ...PLAN, id: "p2", editable: false }];
  render(Role.SALES_OFFICER, "create");
  assert.deepEqual([buttons.filter((b) => String(b.children).includes("Add Market")).length, buttons.filter((b) => String(b.children).includes("Submit all")).length], [1, 1], "Create: Add Market + Submit all");
  (overrides["@/lib/api-client"].api as { post: unknown }).post = async (url: string, body: unknown) => { posts.push({ url, body }); return {}; }; // (an earlier step swapped in a failing post)
  posts.length = 0; click("Submit all"); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/seasonal-sheets/sh1/submit", body: {} }], "one batch submit for the plan");
  for (const st of ["submitted", "approved", "older"]) { html = render(Role.SALES_OFFICER, st); assert.deepEqual([buttons.filter((b) => String(b.children).includes("Add Market")).length, buttons.filter((b) => String(b.children).includes("Submit all")).length], [0, 0], `${st}: no workspace controls`); assert.ok(!html.includes("No Seasonal Plans here yet.")); }
  plans = []; assert.ok(render(Role.SALES_OFFICER, "approved").includes("No approved entries in this plan."));
  console.log("seasonal-add-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
