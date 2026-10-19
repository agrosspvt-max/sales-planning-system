/** Territory Mapping → Add Market: the request form lives in a modal opened by "+ Add Market" under the requests table. */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";

const hooks: unknown[] = [];
let cursor = 0;
let invalidations = 0;
const posts: { url: string; body: unknown }[] = [];
let failNext: string | null = null;
let buttons: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
let inputs: { type?: string; value?: string; onChange?: (e: { target: { value: string } }) => void }[] = [];
let selects: { options: { value: string; label: string }[]; onChange?: (e: { target: { value: string } }) => void }[] = [];
let requests: unknown[] = [];
let districtData: { stateName: string | null; districts: { id: string; name: string }[] } = { stateName: "Madhya Pradesh", districts: [{ id: "dist-raj", name: "Rajgarh" }, { id: "dist-sagar", name: "Sagar" }] };
let searchables: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; ariaLabel: string }[] = [];

const overrides = {
  react: { ...React, useState: (initial: unknown) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks[i], (u: unknown) => { hooks[i] = typeof u === "function" ? (u as (v: unknown) => unknown)(hooks[i]) : u; }]; } },
  "@/features/labels/label-ui": { L: ({ k }: { k: string }) => <>{k}</>, useLabel: (k: string) => (DEFAULT_LABELS as Record<string, string>)[k] ?? k },
  "./party-planning-page": { PartyPlanModeLinks: () => null },
  "@/components/ui/column-filter-header": { ColumnFilterHeader: ({ label }: { label: string }) => <th>{label}</th> }, // its own behaviour: market-request-filters-ui.test.tsx
  "@/components/layout/page-header": { PageHeader: () => null },
  "@tanstack/react-query": {
    keepPreviousData: undefined,
    useQuery: (o: { queryKey: unknown[] }) => ({ data: o.queryKey[0] === "market-request-districts" ? districtData : { items: requests, states: [], districts: [], requesters: [], applied: { stateId: "", districtIds: [], requesterIds: [] } }, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: () => { invalidations += 1; } }),
    useMutation: (o: { mutationFn: (v?: unknown) => Promise<unknown>; onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => ({ isPending: false, mutate: (v?: unknown) => { void o.mutationFn(v).then((r) => o.onSuccess?.(r), (e) => o.onError?.(e)); } }),
  },
  "@/lib/api-client": { api: { get: async () => [], post: async (url: string, body: unknown) => { if (failNext) { const m = failNext; failNext = null; throw new Error(m); } posts.push({ url, body }); return {}; } } },
  "@/components/ui/button": { Button: (p: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => { buttons.push(p); return <button>{p.children}</button>; } },
  "@/components/ui/input": { Input: (p: (typeof inputs)[number]) => { inputs.push(p); return <input type={p.type} defaultValue={p.value} />; } },
  "@/components/ui/searchable-select": { SearchableSelect: (p: (typeof searchables)[number]) => { if (p.ariaLabel === "District") searchables.push(p); /* the State filter has its own suite */ return <div data-searchable aria-label={p.ariaLabel} />; } },
  "@/components/ui/select": { NativeSelect: (p: (typeof selects)[number]) => { selects.push(p); return <select />; } },
  "@/components/ui/dialog": {
    Dialog: ({ children }: { children: React.ReactNode }) => <div data-dialog>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
};
const { AddMarket } = testLoader(overrides)("src/features/party-planning/territory-mapping-page.tsx") as { AddMarket: React.ComponentType<{ role: Role }> };
const render = (role: Role = Role.SALES_OFFICER) => { cursor = 0; buttons = []; inputs = []; selects = []; searchables = []; const html = renderToStaticMarkup(<AddMarket role={role} />); hooks.length = cursor; return html; };
const btn = (label: string) => buttons.filter((b) => String(b.children).includes(label)).at(-1)!;
const count = (label: string) => buttons.filter((b) => String(b.children).includes(label)).length;
const tick = () => new Promise((r) => setTimeout(r, 0));
const REQ = (id: string) => ({ id, marketName: `Market ${id}`, potential: "A", numberOfParties: 3, status: "PENDING_RM", requesterName: "Officer One", createdAt: "2026-10-08T00:00:00.000Z", rmDecidedByName: null, rmDecidedAt: null, adminDecidedByName: null, adminDecidedAt: null, rejectionStage: null, rejectionReason: null, districtId: "dist-raj", districtName: "Rajgarh" });

async function main() {
  // zero requests: no always-visible form, the button sits directly under the (empty) table
  requests = [];
  let html = render();
  assert.ok(!html.includes("data-dialog") && !html.includes("Send Request") && !html.includes('type="number"'), "the request form is hidden until + Add Market is clicked");
  assert.ok(html.includes("No requests here.") && /<\/table><\/div><div class="border-t p-2"><button>\+ Add Market<\/button><\/div>/.test(html), "button directly below the empty table");
  // multiple requests: same position, below the rows
  requests = [REQ("1"), REQ("2"), REQ("3")]; html = render();
  assert.ok(/<\/table><\/div><div class="border-t p-2"><button>\+ Add Market<\/button><\/div>/.test(html) && html.lastIndexOf("Market 3") < html.lastIndexOf("+ Add Market"), "below the last row, so it moves down as the table grows");
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.equal(heads.join("|"), "S.No|District|Market Name|Market Potential|No. of Parties|Requested by|Date|Status|Decision", "S.No is the first column, then District");
  assert.ok(/<td[^>]*>1<\/td><td[^>]*>Rajgarh<\/td><td[^>]*>Market 1<\/td>/.test(html), "each row: S.No, then its District Master name, then the Market");
  assert.equal([...html.matchAll(/<tr[^>]*><td[^>]*>(\d+)<\/td>/g)].map((m) => m[1]).join(","), "1,2,3", "unpaginated list: rowIndex + 1");
  requests = [{ ...REQ("legacy"), districtId: null, districtName: null }]; html = render();
  assert.ok(/<td[^>]*>1<\/td><td[^>]*><span class="text-muted-foreground">—<\/span><\/td><td[^>]*>Market legacy<\/td>/.test(html), "a request made before District existed shows \"—\"");
  requests = [REQ("1"), REQ("2"), REQ("3")]; html = render();
  for (const col of ["Market Name", "Market Potential", "No. of Parties", "Requested by", "Date", "Status", "Decision"]) assert.ok(html.includes(`>${col}</th>`), `column ${col}`);
  assert.ok(html.includes("To review") === false && html.includes("My requests") && html.includes("History"), "SO: My requests + History tabs");
  // empty / loading rows span every column: 9 for SO views, 10 where the Action column exists (RM "To review")
  requests = []; assert.ok(render().includes('colSpan="9"') && !render().includes('colSpan="10"'), "SO empty row: 9 columns");
  hooks.length = 0; const rmHtml = render(Role.REGIONAL_MANAGER); hooks.length = 0;
  assert.ok(rmHtml.includes('colSpan="10"'), "RM review empty row: 10 columns (with Action)");
  assert.equal([...rmHtml.matchAll(/<th(?:\s[^>]*)?>/g)].length, 10, "RM review has 10 headings");
  requests = [REQ("1"), REQ("2"), REQ("3")];
  // permissions unchanged: SO + RM can request; Admin cannot
  assert.equal(count("+ Add Market"), 1);
  render(Role.REGIONAL_MANAGER); assert.equal(count("+ Add Market"), 1); assert.ok(render(Role.REGIONAL_MANAGER).includes("To review"));
  render(Role.SUPER_ADMIN); assert.equal(count("+ Add Market"), 0, "Admin does not raise requests");
  // open the modal
  hooks.length = 0; render(); btn("+ Add Market").onClick!(); html = render();
  assert.ok(html.indexOf("District *") > -1 && html.indexOf("District *") < html.indexOf("Market Name *") && html.indexOf("Market Name *") < html.indexOf("Market Potential *"), "District is the FIRST field");
  assert.equal(searchables[0]!.options.map((o) => o.label).join("|"), "Rajgarh|Sagar", "only the requester's State's districts (as returned by the server)");
  assert.equal(searchables[0]!.placeholder, "Select District..."); assert.equal(searchables[0]!.value, "", "starts unselected — an explicit choice is required");
  assert.ok(html.includes("data-dialog") && html.includes("Market Name *") && html.includes("Market Potential *") && html.includes("No. of Parties *") && count("Send Request") === 1 && count("Cancel") === 1, "compact modal: the three fields, Send Request, Cancel");
  assert.equal(selects.at(-1)!.options.map((o) => o.value).join(","), "A,B,C");
  // validation keeps the modal open and sends nothing
  btn("Send Request").onClick!(); html = render();
  assert.ok(html.includes("Select a District.") && posts.length === 0, "no district chosen: refused, nothing sent");
  searchables[0]!.onChange("dist-raj"); render(); btn("Send Request").onClick!(); html = render();
  assert.ok(html.includes("data-dialog") && html.includes("Market Name is required."), "existing validation message, modal stays open"); assert.equal(posts.length, 0);
  // Cancel creates nothing and clears state
  btn("Cancel").onClick!(); html = render();
  assert.ok(!html.includes("data-dialog") && posts.length === 0, "cancel: closed, no request");
  btn("+ Add Market").onClick!(); render();
  assert.ok(inputs.filter((i) => i.type !== "number")[0]!.value === "" && searchables[0]!.value === "", "form state was cleared, District included");
  // a backend failure keeps the modal open with the error
  const fill = () => { searchables[0]!.onChange("dist-sagar"); render(); const text = inputs.filter((i) => i.type !== "number")[0]!; text.onChange!({ target: { value: "Pipariya" } }); render(); selects.at(-1)!.onChange!({ target: { value: "B" } }); render(); inputs.find((i) => i.type === "number")!.onChange!({ target: { value: "12" } }); render(); };
  fill(); failNext = "A Market with this name already exists"; btn("Send Request").onClick!(); await tick(); html = render();
  assert.ok(html.includes("data-dialog") && html.includes("A Market with this name already exists"), "duplicate-market error shown inside the modal"); assert.equal(posts.length, 0);
  // success: POST the same request, close, clear, refresh
  btn("Send Request").onClick!(); await tick(); html = render();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/territory-mapping/market-requests", body: { districtId: "dist-sagar", marketName: "Pipariya", potential: "B", numberOfParties: "12" } }], "the existing request endpoint, unchanged payload");
  assert.ok(!html.includes("data-dialog") && html.includes("Request sent.") && invalidations >= 1, "closed, notice shown, lists refreshed");
  btn("+ Add Market").onClick!(); render(); assert.ok(inputs.filter((i) => i.type !== "number")[0]!.value === "" && searchables[0]!.value === "", "reopening starts clean (District cleared after a successful send)");
  // no State / no districts: a clear message, Send disabled, nothing to pick
  districtData = { stateName: null, districts: [] }; html = render();
  assert.ok(html.includes("Your State could not be identified") && btn("Send Request").disabled === true && searchables[0]!.options.length === 0, "no State: message + blocked");
  districtData = { stateName: "Madhya Pradesh", districts: [] }; html = render();
  assert.ok(html.includes("No active districts are set up for Madhya Pradesh") && btn("Send Request").disabled === true, "no districts: message + blocked");
  // Review: a decision that loses a race shows the server's conflict message and refreshes the list (the row would otherwise stay stale); a normal approval posts once.
  hooks.length = 0; posts.length = 0; requests = [REQ("1")]; districtData = { stateName: "Madhya Pradesh", districts: [{ id: "dist-raj", name: "Rajgarh" }] };
  render(Role.REGIONAL_MANAGER);
  const invBefore = invalidations; failNext = "This request has already been decided. Refresh to see its current status.";
  btn("Approve").onClick!(); await tick(); html = render(Role.REGIONAL_MANAGER);
  assert.ok(html.includes("This request has already been decided.") && invalidations > invBefore && posts.length === 0, "conflict: message shown, list refreshed, nothing recorded");
  btn("Approve").onClick!(); await tick(); render(Role.REGIONAL_MANAGER);
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ url: "/api/territory-mapping/market-requests/1/act", body: { action: "approve" } }], "approval uses the existing act endpoint");
  // Pinned column headings: this page's title scrolls away; both tables pin their column-name row against the page's own scroller.
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("src/features/party-planning/territory-mapping-page.tsx", "utf8");
  assert.ok(/<PageHeader[\s\S]*?pinned=\{false\}/.test(page), "Territory Mapping's title is not pinned");
  assert.equal((page.match(/<Table stickyHeader externalScroll>/g) ?? []).length, 2, "Existing Dealers and Vacant Market tables pin their headings");
  assert.ok(!/overflow-auto rounded-lg border bg-background">\s*<Table stickyHeader/.test(page), "no overflow wrapper around the pinned tables (it would become a second scroll region)");
  assert.ok(/<div className="w-full min-w-\[56rem\] rounded-lg border bg-background">\s*<Table stickyHeader externalScroll>/.test(page) && !page.includes("w-fit rounded-lg"), "Existing Markets fills the content width (no w-fit); it scrolls sideways only below 56rem");
  assert.ok(["w-14\">{L.serial}", "w-72\">{L.district}", "w-[1%]\">{L.market}", "w-32\">{L.potential}", "w-24\">{L.status}"].every((x) => page.includes(`<TableHead className="${x}</TableHead>`)) && page.includes("<TableHead>{L.party}</TableHead>"), "one coherent set of widths: S.No / Potential / Status compact, District for its selector, Market shrink-to-fit, Party Name takes the rest");
  assert.ok(!page.includes("sm:w-[26%]") && !page.includes("w-[15%]"), "the isolated mobile-only Market width is gone");
  assert.ok(!/<TableCell className="p-1[ "]/.test(page.slice(page.indexOf("function ExistingDealers"), page.indexOf("function DistrictCell") > 0 ? page.indexOf("function DistrictCell") : undefined)), "Existing Markets body cells share the headings' px-3 gutter (no p-1 cells)");
  assert.ok(page.includes("flex w-max max-w-[8rem] flex-wrap"), "the Market cell is as wide as its name + tag, capped at 8rem and wrapping beyond");
  for (const f of ["performance-page", "team-performance-page"]) assert.ok(!readFileSync(`src/features/daily-work/${f}.tsx`, "utf8").includes("pinned={false}"), "other pages keep their pinned header");
  console.log("territory-add-market-ui.test.tsx — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
