/** Party Planning navigation hierarchy (same as Sales Planning): [Create New Plan | View Plans]; View Plans adds the Plan Type box [Submitted | Approved | Older Plans]; then Seasonal | Monthly. Territory Mapping is NOT part of it (standalone module). */
import assert from "node:assert/strict";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

const overrides = {
  "next/link": { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> },
  "@/features/labels/label-ui": { L: ({ k }: { k: LabelKey }) => <>{DEFAULT_LABELS[k]}</>, useLabel: (k: LabelKey) => DEFAULT_LABELS[k] },
  "@tanstack/react-query": { useMutation: () => ({}), useQuery: () => ({}), useQueryClient: () => ({}) },
  "@/lib/api-client": { api: {} },
};
const { PartyPlanModeLinks } = testLoader(overrides)("src/features/party-planning/party-planning-page.tsx") as { PartyPlanModeLinks: React.ComponentType<{ mode: string; stage?: string }> };
const render = (mode: string, stage?: string) => renderToStaticMarkup(<PartyPlanModeLinks mode={mode} stage={stage} />);
const anchors = (html: string) => [...html.matchAll(/<a href="([^"]+)"([^>]*)>([^<]*)<\/a>/g)].map((m) => ({ href: m[1]!, cls: m[2]!, label: m[3]!.trim() }));
const secondaryOf = (html: string) => anchors(html).filter((a) => a.cls.includes("border-b-2"));
const activeSecondary = (html: string) => secondaryOf(html).filter((a) => a.cls.includes("border-primary")).map((a) => a.label);

const mainOf = (html: string) => anchors(html).filter((a) => a.cls.includes("rounded px-3") && ["Create New Plan", "View Plans"].includes(a.label));
const activeMain = (html: string) => mainOf(html).filter((a) => a.cls.includes("bg-primary")).map((a) => a.label);
const stageLinks = (html: string) => anchors(html).filter((a) => a.cls.includes("rounded px-3") && !["Create New Plan", "View Plans"].includes(a.label));
const activeStage = (html: string) => stageLinks(html).filter((a) => a.cls.includes("bg-primary")).map((a) => a.label);

for (const mode of ["seasonal", "monthly"]) {
  // Level 1: the same two switch items on both modes; each keeps the selected Seasonal / Monthly type and lands on Create / Submitted.
  for (const stage of ["create", "submitted", "approved", "older"]) assert.deepEqual(mainOf(render(mode, stage)).map((a) => [a.label, a.href]), [["Create New Plan", `/planning/party/${mode}?stage=create`], ["View Plans", `/planning/party/${mode}?stage=submitted`]], `main switch keeps ${mode} on ${stage}`);
  // The active side is derived from the stage.
  assert.deepEqual(activeMain(render(mode, "create")), ["Create New Plan"]);
  for (const stage of ["submitted", "approved", "older"]) assert.deepEqual(activeMain(render(mode, stage)), ["View Plans"], `${stage} → View Plans`);
  // Create New Plan: no Plan Type box, no lifecycle options (and no separate "Create" option).
  const create = render(mode, "create");
  assert.ok(!create.includes("Plan Type") && stageLinks(create).length === 0 && !/>Create</.test(create) && !/Older Plans|Submitted|Approved/.test(create), "Create New Plan has no lifecycle selector");
  // View Plans: exactly Submitted | Approved | Older Plans inside the labelled Plan Type container.
  for (const stage of ["submitted", "approved", "older"]) {
    const view = render(mode, stage);
    assert.deepEqual(stageLinks(view).map((a) => [a.label, a.href]), [["Submitted", `/planning/party/${mode}?stage=submitted`], ["Approved", `/planning/party/${mode}?stage=approved`], ["Older Plans", `/planning/party/${mode}?stage=older`]], `lifecycle options on ${mode}/${stage}`);
    assert.deepEqual(activeStage(view).map((l) => l.toLowerCase().replace(" plans", "")), [stage], `${stage} is the active section`);
    assert.ok(view.indexOf("Create New Plan") < view.indexOf("Plan Type") && view.indexOf("Plan Type") < view.indexOf(">Submitted<") && view.indexOf(">Older Plans<") < view.indexOf(">Seasonal<"), "order: main switch → Plan Type → Seasonal | Monthly");
  }
  // Level 3 in both modes: Seasonal | Monthly underline tabs, correct one active, stage retained on switching.
  for (const stage of ["create", "submitted", "approved", "older"]) {
    assert.deepEqual(secondaryOf(render(mode, stage)).map((a) => [a.label, a.href]), [["Seasonal", `/planning/party/seasonal?stage=${stage}`], ["Monthly", `/planning/party/monthly?stage=${stage}`]], `${mode}/${stage}: type tabs retain the section`);
    assert.deepEqual(activeSecondary(render(mode, stage)), [mode === "seasonal" ? "Seasonal" : "Monthly"]);
  }
}
// Both switches share Sales Planning's pill classes (padding, weight, active blue, inactive colours).
const sp = readFileSync("src/features/planning/sales-planning.tsx", "utf8");
const pillClasses = /className=\{`rounded px-3 py-1\.5 font-medium \$\{isCreate \? "([^"]+)" : "([^"]+)"\}`\}/.exec(sp)!;
const nav1 = render("seasonal", "submitted");
assert.ok(nav1.includes(`rounded px-3 py-1.5 font-medium ${pillClasses[1]}`) && nav1.includes(`rounded px-3 py-1.5 font-medium ${pillClasses[2]}`), "main and lifecycle switches use Sales Planning's pill styling");
assert.ok(nav1.includes("inline-flex flex-wrap rounded-md border bg-background p-0.5 text-sm") && nav1.includes("space-y-1.5 rounded-lg border bg-muted/20 p-3"), "same container styling as Sales Planning");
// Legacy appointment pages keep a main switch with neither side active, and no sheet tabs.
for (const mode of ["create", "view"]) {
  const legacy = render(mode);
  assert.deepEqual([activeMain(legacy), stageLinks(legacy).length, secondaryOf(legacy).length], [[], 0, 0], `legacy ${mode}: nothing active, no lifecycle, no tabs`);
  assert.ok(!legacy.includes("Territory Mapping"));
}

// The tabs use the SAME classes as the Sales Planning tab strip.
const sales = readFileSync("src/features/planning/sales-planning.tsx", "utf8");
const salesClasses = /border-b-2 px-3 py-2 text-sm font-medium transition-colors \$\{tab === t \? "([^"]+)" : "([^"]+)"\}/.exec(sales)!;
const tabs = readFileSync("src/components/ui/underline-tabs.tsx", "utf8");
assert.ok(tabs.includes("flex gap-1 border-b") && tabs.includes(`border-b-2 px-3 py-2 text-sm font-medium transition-colors`) && tabs.includes(salesClasses[1]!) && tabs.includes(salesClasses[2]!), "identical styling to the Sales Planning Seasonal / Monthly / Yearly tabs");
assert.ok(sales.includes('<div className="flex gap-1 border-b">'), "Sales Planning's own tab strip is unchanged");

// Routes: every Party Planning page still exists at its original URL; Territory Mapping is standalone (own route, own [Existing Dealers | Add Market]).
const pageSource = (p: string) => readFileSync(p, "utf8");
for (const [f, mode] of [["seasonal-planning-page.tsx", "seasonal"], ["monthly-planning-page.tsx", "monthly"]] as const) {
  const detailSrc = pageSource(`src/features/party-planning/${f}`);
  assert.ok(detailSrc.includes("<PlanDetailBar") && detailSrc.includes("backHref={`/planning/party/" + mode + "?stage=${stage}`}"), `${f}: an opened plan has only the compact Back + breadcrumbs, and Back keeps the stage`);
  assert.ok(!detailSrc.includes("<PartyPlanModeLinks") && !detailSrc.includes("<PageHeader"), `${f}: no title/subtitle header and no mode switch / Seasonal | Monthly tabs on an opened plan`);
}
const territory = pageSource("src/features/party-planning/territory-mapping-page.tsx");
assert.ok(!territory.includes("PartyPlanModeLinks") && territory.includes("<UnderlineTabs") && !territory.includes("onClick={() => setTab(key)}") && territory.includes("tab_existing") && territory.includes("tab_add_market"));
assert.ok(pageSource("src/app/(dashboard)/planning/territory-mapping/page.tsx").includes("TerritoryMappingPage"), "standalone Territory Mapping route");
assert.ok(/redirect\("\/planning\/territory-mapping"\)/.test(pageSource("src/app/(dashboard)/planning/party/territory/page.tsx")), "the old Party Planning URL still works (redirect)");
for (const [route, text] of [["seasonal", "SeasonalPlanListPage"], ["monthly", "MonthlyPlanListPage"]] as const) assert.ok(pageSource(`src/app/(dashboard)/planning/party/${route}/page.tsx`).includes(text), `${route}: the list route is unchanged`);
// Detail routes: ONE plan by id (refresh-safe — the id comes from the URL and everything is loaded from it), under the same Planning navigation.
for (const [route, text] of [["seasonal", "SeasonalPlanDetailPage"], ["monthly", "MonthlyPlanDetailPage"]] as const) {
  const detailRoute = pageSource(`src/app/(dashboard)/planning/party/${route}/[id]/page.tsx`);
  assert.ok(detailRoute.includes(text) && detailRoute.includes("params: Promise<{ id: string }>") && detailRoute.includes("sheetId={id}"), `${route}/[id] opens the exact plan from the URL`);
}
for (const f of ["seasonal-planning-page.tsx", "monthly-planning-page.tsx", "seasonal-plan-list-page.tsx", "monthly-plan-list-page.tsx"]) {
  const src = pageSource(`src/features/party-planning/${f}`);
  if (f.includes("list")) assert.ok(src.includes('<PartyPlanModeLinks mode="' + (f.startsWith("seasonal") ? "seasonal" : "monthly") + '" stage='), `${f}: the overview lists keep the full navigation`);
  // (the one exception: the Create dialog opens the chosen season's / month's editor once, right after creating it)
  assert.ok(!/router\.(replace|push)|window\.history|history\.(push|replace)State/.test(src.replace(/router\.push\(`\/planning\/party\/(seasonal|monthly)\/\$\{id\}\?stage=create`\);/, "")), `${f}: plain links only — no programmatic history manipulation, so Back / Forward behave`);
}
assert.ok(readFileSync("src/components/ui/underline-tabs.tsx", "utf8").includes("<Link") && readFileSync("src/features/party-planning/plan-list-parts.tsx", "utf8").includes("<Link"), "the secondary tabs and the Open buttons are route links");
// From a detail page the secondary tabs lead to the LIST routes, so switching Seasonal ↔ Monthly never needs a Back first.
const create = pageSource("src/features/party-planning/party-planning-page.tsx");
assert.ok(create.includes('<PartyPlanModeLinks mode="create" />') && create.includes('<PartyPlanModeLinks mode="view" />'), "the legacy pages keep the main switch and no Seasonal / Monthly tabs");
assert.ok(/redirect|PartyCreatePlanPage/.test(pageSource("src/app/(dashboard)/planning/party/page.tsx")) && pageSource("src/app/(dashboard)/planning/party/view/page.tsx").includes("PartyViewPage"), "legacy routes still exist (their records stay reachable)");
assert.ok(pageSource("src/features/planning/planning-modules.tsx").includes('href: "/planning/party/seasonal"'), "default entry: Create New Plan → Seasonal");

// Lifecycle section is ROUTE state: the list pages read ?stage= on the server (survives refresh / Back / Forward), the nav uses plain links, and an unknown value falls back to Create.
for (const route of ["seasonal", "monthly"]) {
  const page = pageSource(`src/app/(dashboard)/planning/party/${route}/page.tsx`);
  assert.ok(page.includes("searchParams: Promise<{ stage?: string }>") && page.includes("parseStage(stage)"), `${route}: ?stage= selects the section on the server`);
}
import("../../lib/monthly-plan").then(({ parseStage }) => assert.deepEqual(["create", "submitted", "approved", "older", "nope", undefined].map(parseStage), ["create", "submitted", "approved", "older", "create", "create"]));
// A page action lives in the SAME row as Seasonal | Monthly, after the tabs (far right), not in the lifecycle container.
{
  const withAction = renderToStaticMarkup(<PartyPlanModeLinks mode="seasonal" stage="create" {...{ actions: <button>Create Seasonal Plan</button> }} />);
  const row = withAction.slice(withAction.indexOf("justify-between"));
  assert.ok(row.indexOf(">Seasonal<") < row.indexOf(">Monthly<") && row.indexOf(">Monthly<") < row.indexOf("Create Seasonal Plan"), "tabs left, action after them in one row");
  assert.ok(!renderToStaticMarkup(<PartyPlanModeLinks mode="seasonal" stage="submitted" {...{ actions: <button>Create Seasonal Plan</button> }} />).includes("Create Seasonal Plan"), "View Plans never shows creation actions");
}
// Detail pages are opened FROM a section and keep it (route state), so Back and the nav stay in the right section.
for (const route of ["seasonal", "monthly"]) {
  const page = pageSource(`src/app/(dashboard)/planning/party/${route}/[id]/page.tsx`);
  assert.ok(page.includes("searchParams: Promise<{ stage?: string }>") && page.includes("stage={parseStage(stage)}"), `${route}/[id]: the section comes from ?stage=`);
}
console.log("party-navigation.test.tsx — all assertions passed");
