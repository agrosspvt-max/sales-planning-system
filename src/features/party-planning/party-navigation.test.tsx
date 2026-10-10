/** Party Planning navigation hierarchy: [Planning | View], with Seasonal | Monthly under Planning. Territory Mapping is NOT part of it (standalone module). */
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
const primaryOf = (html: string) => anchors(html).filter((a) => a.cls.includes("rounded px-3") && !a.href.includes("?stage="));
const lifecycleOf = (html: string) => anchors(html).filter((a) => a.cls.includes("rounded px-3") && a.href.includes("?stage="));
const secondaryOf = (html: string) => anchors(html).filter((a) => a.cls.includes("border-b-2"));
const activePrimary = (html: string) => primaryOf(html).filter((a) => a.cls.includes("bg-primary")).map((a) => a.label);
const activeSecondary = (html: string) => secondaryOf(html).filter((a) => a.cls.includes("border-primary")).map((a) => a.label);

// PRIMARY navigation is the same on every page: Seasonal Planning / Monthly Planning are no longer primary items.
for (const mode of ["seasonal", "monthly", "create", "view"]) {
  assert.deepEqual(primaryOf(render(mode)).map((a) => [a.label, a.href]), [
    ["Planning", "/planning/party/seasonal"], ["View", "/planning/party/view"],
  ], `primary navigation on ${mode}`);
  assert.ok(!primaryOf(render(mode)).some((a) => /Seasonal Planning|Monthly Planning/.test(a.label)));
}
// Which primary item is active per route.
assert.ok(!render("seasonal").includes("Territory Mapping"), "Territory Mapping is no longer inside Party Planning navigation");
assert.deepEqual(activePrimary(render("seasonal")), ["Planning"]);
assert.deepEqual(activePrimary(render("monthly")), ["Planning"], "Monthly keeps Planning active");
assert.deepEqual(activePrimary(render("create")), [], "the legacy page has no active item — Create Plan is not in the navigation");
for (const mode of ["seasonal", "monthly", "create", "view"]) assert.ok(!render(mode).includes("Create Plan"), `no "Create Plan" on ${mode}`);
assert.deepEqual(activePrimary(render("view")), ["View"]);
// SECONDARY tabs exist only under Planning, in the Sales Planning underline style, route-based, with the right one active.
for (const mode of ["create", "view"]) assert.equal(secondaryOf(render(mode)).length, 0, `no Seasonal / Monthly tabs on ${mode}`);
assert.deepEqual(secondaryOf(render("seasonal")).map((a) => [a.label, a.href]), [["Seasonal", "/planning/party/seasonal?stage=create"], ["Monthly", "/planning/party/monthly?stage=create"]]);
// PLAN LIFECYCLE switch (Create | Submitted | Approved | Older Plans): only under Planning, between the primary nav and Seasonal | Monthly, route-state links.
for (const mode of ["create", "view"]) assert.equal(lifecycleOf(render(mode)).length, 0, `no lifecycle switch on ${mode}`);
for (const mode of ["seasonal", "monthly"]) {
  assert.deepEqual(lifecycleOf(render(mode)).map((a) => [a.label, a.href]), [["Create", `/planning/party/${mode}?stage=create`], ["Submitted", `/planning/party/${mode}?stage=submitted`], ["Approved", `/planning/party/${mode}?stage=approved`], ["Older Plans", `/planning/party/${mode}?stage=older`]], `lifecycle links on ${mode}`);
  for (const stage of ["create", "submitted", "approved", "older"]) assert.deepEqual(lifecycleOf(render(mode, stage)).filter((a) => a.cls.includes("bg-primary")).map((a) => a.label.toLowerCase().replace(" plans", "")), [stage], `${stage} is the active section`);
}
const html = render("monthly", "approved");
assert.ok(html.indexOf(">Planning<") < html.indexOf("Create") && html.indexOf("Create") < html.indexOf(">Seasonal<"), "order: primary nav → lifecycle → Seasonal | Monthly");
assert.deepEqual(secondaryOf(render("monthly", "approved")).map((a) => a.href), ["/planning/party/seasonal?stage=approved", "/planning/party/monthly?stage=approved"], "switching Seasonal ↔ Monthly keeps the lifecycle section");
assert.deepEqual(activeSecondary(render("seasonal")), ["Seasonal"]);
assert.deepEqual(activeSecondary(render("monthly")), ["Monthly"]);
assert.ok(render("monthly").includes('aria-current="page"'));
// The tabs use the SAME classes as the Sales Planning tab strip.
const sales = readFileSync("src/features/planning/sales-planning.tsx", "utf8");
const salesClasses = /border-b-2 px-3 py-2 text-sm font-medium transition-colors \$\{tab === t \? "([^"]+)" : "([^"]+)"\}/.exec(sales)!;
const tabs = readFileSync("src/components/ui/underline-tabs.tsx", "utf8");
assert.ok(tabs.includes("flex gap-1 border-b") && tabs.includes(`border-b-2 px-3 py-2 text-sm font-medium transition-colors`) && tabs.includes(salesClasses[1]!) && tabs.includes(salesClasses[2]!), "identical styling to the Sales Planning Seasonal / Monthly / Yearly tabs");
assert.ok(sales.includes('<div className="flex gap-1 border-b">'), "Sales Planning's own tab strip is unchanged");

// Routes: every Party Planning page still exists at its original URL; Territory Mapping is standalone (own route, own [Existing Dealers | Add Market]).
const pageSource = (p: string) => readFileSync(p, "utf8");
assert.ok(pageSource("src/features/party-planning/seasonal-planning-page.tsx").includes('<PartyPlanModeLinks mode="seasonal" stage='));
assert.ok(pageSource("src/features/party-planning/monthly-planning-page.tsx").includes('<PartyPlanModeLinks mode="monthly" stage='));
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
  assert.ok(src.includes('<PartyPlanModeLinks mode="' + (f.startsWith("seasonal") ? "seasonal" : "monthly") + '" stage='), `${f}: Planning stays active with the Seasonal | Monthly switch (list and detail)`);
  assert.ok(!/router\.(replace|push)|window\.history|history\.(push|replace)State/.test(src), `${f}: plain links only — no programmatic history manipulation, so Back / Forward behave`);
}
assert.ok(readFileSync("src/components/ui/underline-tabs.tsx", "utf8").includes("<Link") && readFileSync("src/features/party-planning/plan-list-parts.tsx", "utf8").includes("<Link"), "the secondary tabs and the Open buttons are route links");
// From a detail page the secondary tabs lead to the LIST routes, so switching Seasonal ↔ Monthly never needs a Back first.
assert.deepEqual(secondaryOf(render("seasonal")).map((a) => a.href), ["/planning/party/seasonal?stage=create", "/planning/party/monthly?stage=create"]);
const create = pageSource("src/features/party-planning/party-planning-page.tsx");
assert.ok(create.includes('<PartyPlanModeLinks mode="create" />') && create.includes('<PartyPlanModeLinks mode="view" />'), "Create Plan / View keep the primary navigation and no Seasonal / Monthly tabs");

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
  assert.ok(withAction.indexOf("Plan Type") < withAction.indexOf("Create Seasonal Plan"));
}
// Detail pages are opened FROM a section and keep it (route state), so Back and the nav stay in the right section.
for (const route of ["seasonal", "monthly"]) {
  const page = pageSource(`src/app/(dashboard)/planning/party/${route}/[id]/page.tsx`);
  assert.ok(page.includes("searchParams: Promise<{ stage?: string }>") && page.includes("stage={parseStage(stage)}"), `${route}/[id]: the section comes from ?stage=`);
}
console.log("party-navigation.test.tsx — all assertions passed");
