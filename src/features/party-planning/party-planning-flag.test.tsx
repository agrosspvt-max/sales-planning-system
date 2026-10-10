/**
 * PARTY_PLANNING_ENABLED + the Create/View Plans reorganisation: the flag fails closed, is enforced server-side for Party Planning pages AND APIs,
 * and never touches Territory Mapping, Sales / Recovery / Scheme Planning, permissions or data.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { isPartyPlanningEnabled, isPartyPlanningPath, PARTY_PLANNING_UNAVAILABLE_MESSAGE } from "@/lib/feature-flags";
import { apiPermission } from "@/features/accounts/route-permissions";
import { mayEnterPage, moduleForPage } from "@/features/accounts/permissions";

const read = (p: string) => readFileSync(p, "utf8");

// 1. The flag fails closed.
for (const on of ["true", "TRUE", " true ", "True"]) assert.equal(isPartyPlanningEnabled({ PARTY_PLANNING_ENABLED: on }), true, `"${on}" enables`);
for (const off of [undefined, "", "false", "FALSE", "0", "1", "yes", "on", "enabled", "tru", "true;", "null"]) assert.equal(isPartyPlanningEnabled({ PARTY_PLANNING_ENABLED: off }), false, `${JSON.stringify(off)} disables (fail closed)`);
assert.equal(isPartyPlanningEnabled({}), false, "missing → disabled");
{ // read per call from the live environment, never captured at import time
  const before = process.env.PARTY_PLANNING_ENABLED;
  process.env.PARTY_PLANNING_ENABLED = "true"; assert.equal(isPartyPlanningEnabled(), true);
  process.env.PARTY_PLANNING_ENABLED = "false"; assert.equal(isPartyPlanningEnabled(), false);
  delete process.env.PARTY_PLANNING_ENABLED; assert.equal(isPartyPlanningEnabled(), false);
  if (before === undefined) delete process.env.PARTY_PLANNING_ENABLED; else process.env.PARTY_PLANNING_ENABLED = before;
}

// 2. Which paths belong to Party Planning — and which never do.
for (const p of ["/planning/party", "/planning/party/", "/planning/party/seasonal", "/planning/party/seasonal/abc", "/planning/party/monthly", "/planning/party/monthly/abc", "/planning/party/view",
  "/api/party-plans", "/api/party-plans/submit", "/api/party-plans/x/act", "/api/seasonal-plans", "/api/seasonal-plans/x/submit", "/api/seasonal-sheets/options", "/api/seasonal-sheets/x",
  "/api/party-monthly-plans/x/appoint", "/api/party-monthly-plans/x/status", "/api/party-monthly-sheets", "/api/party-monthly-sheets/x/act"]) assert.equal(isPartyPlanningPath(p), true, `${p} is Party Planning`);
for (const p of ["/planning/territory-mapping", "/planning/party/territory", "/planning/party/territory/", "/api/territory-mapping/dealers", "/api/territory-mapping/dealers/d1", "/api/territory-mapping/import/preview",
  "/api/territory-mapping/import/commit", "/api/territory-mapping/markets", "/api/territory-mapping/districts", "/api/territory-mapping/market-requests", "/planning/create", "/planning/view", "/planning/sales", "/planning/sales/plans",
  "/planning/recovery", "/planning/scheme", "/planning/scheme/plans", "/planning/party-unavailable", "/planning/calendar", "/api/calendar", "/api/seasons", "/api/planning/season-plans", "/api/scheme-plans", "/api/recovery/plans",
  "/api/party-planning-other", "/api/seasonal-plansx", "/daily-work", "/dashboard"]) assert.equal(isPartyPlanningPath(p), false, `${p} is NOT Party Planning`);

// 3. The server-side guard (what the middleware runs for every request).
class FakeNextResponse {
  constructor(public kind: string, public body: unknown, public init: { status?: number; headers?: Record<string, string> } = {}) {}
  get status() { return this.init.status; } get headers() { return this.init.headers ?? {}; }
  static json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) { return new FakeNextResponse("json", body, init); }
  static rewrite(url: URL, init: { status?: number; headers?: Record<string, string> } = {}) { return new FakeNextResponse("rewrite", url.pathname, init); }
}
const { partyPlanningGuard } = testLoader({ "next/server": { NextResponse: FakeNextResponse } })("src/lib/party-planning-guard.ts") as { partyPlanningGuard: (p: string, u: string, env: Record<string, string | undefined>) => FakeNextResponse | null };
const guard = (path: string, flag: string | undefined) => partyPlanningGuard(path, `https://app.test${path}`, flag === undefined ? {} : { PARTY_PLANNING_ENABLED: flag });
for (const flag of ["false", undefined, "", "banana", "1"]) {
  const api = guard("/api/seasonal-plans", flag)!;
  assert.deepEqual([api.kind, api.status, (api.body as { error: string }).error, (api.body as { code: string }).code], ["json", 503, PARTY_PLANNING_UNAVAILABLE_MESSAGE, "FEATURE_DISABLED"], `API blocked (flag ${JSON.stringify(flag)})`);
  assert.match(api.headers["Cache-Control"]!, /no-store/, "a disabled answer is never cached");
  const page = guard("/planning/party/monthly/abc", flag)!;
  assert.deepEqual([page.kind, page.body, page.status], ["rewrite", "/planning/party-unavailable", 503], `page → friendly unavailable page (flag ${JSON.stringify(flag)})`);
  assert.match(page.headers["Cache-Control"]!, /no-store/);
  for (const write of ["/api/party-plans/submit", "/api/party-monthly-plans/x/appoint", "/api/seasonal-sheets/x/submit", "/api/party-monthly-sheets/x/act"]) assert.equal(guard(write, flag)!.status, 503, `write endpoint ${write} blocked`);
  // Everything else keeps working while Party Planning is off.
  for (const ok of ["/planning/territory-mapping", "/planning/party/territory", "/api/territory-mapping/dealers", "/api/territory-mapping/import/commit", "/api/territory-mapping/markets", "/planning/sales", "/api/planning/season-plans", "/planning/recovery", "/planning/scheme", "/api/scheme-plans", "/api/calendar", "/planning/create"]) assert.equal(guard(ok, flag), null, `${ok} untouched`);
}
for (const path of ["/api/seasonal-plans", "/planning/party/seasonal", "/api/party-plans/submit"]) assert.equal(guard(path, "true"), null, `${path} reachable when enabled`);

// 4. Every API route that uses Party Planning code is covered (guards against a future route slipping outside the flag); Territory Mapping routes are not.
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const routeOf = (file: string) => "/" + file.split(sep).slice(file.split(sep).indexOf("app") + 1, -1).join("/").replace(/\[[^\]]+\]/g, "x");
let covered = 0, territory = 0;
for (const file of walk("src/app/api").filter((f) => f.endsWith("route.ts"))) {
  const route = routeOf(file);
  const usesParty = /features\/party-planning\//.test(read(file)) && !route.startsWith("/api/territory-mapping");
  if (usesParty) { assert.equal(isPartyPlanningPath(route), true, `${route} uses Party Planning code but is outside the flag`); covered += 1; }
  if (route.startsWith("/api/territory-mapping")) { assert.equal(isPartyPlanningPath(route), false, `${route} must stay available`); territory += 1; }
}
assert.ok(covered >= 20 && territory >= 9, `scanned ${covered} party routes and ${territory} territory routes`);
// …and every Party Planning PAGE also carries the page-level gate (defence in depth beside the middleware).
const pageFiles = walk("src/app/(dashboard)/planning/party").filter((f) => f.endsWith("page.tsx") && !f.includes(`${sep}territory${sep}`));
assert.equal(pageFiles.length, 6, "party, view, seasonal, seasonal/[id], monthly, monthly/[id]");
for (const f of pageFiles) assert.ok(/const unavailable = partyPlanningGate\(\);[^\n]*\n\s*if \(unavailable\) return unavailable;/.test(read(f)), `${f} is gated`);

// 5. The middleware runs the guard first; the flag/guard modules never touch the database, permissions or records.
const mw = read("src/middleware.ts");
assert.ok(mw.includes("partyPlanningGuard(req.nextUrl.pathname, req.url)") && mw.includes("if (disabled) return disabled;") && mw.indexOf("if (disabled) return disabled;") < mw.indexOf("NextResponse.next("), "middleware answers a disabled request before any handler");
for (const f of ["src/lib/feature-flags.ts", "src/lib/party-planning-guard.ts"]) assert.ok(!/prisma|writeAudit|migrat/i.test(read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${f} touches no data`);
assert.ok(!readdirSync("prisma/migrations").some((m) => /party_planning_flag/i.test(m)), "no migration");

// 6. Create/View Plans landing: five cards in the required order; Territory Mapping is its own card.
const LandingModule = testLoader({
  "next/link": { __esModule: true, default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> },
  "@/components/layout/page-header": { PageHeader: () => null },
  "@/components/ui/card": { Card: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>, CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3> },
  "@/components/ui/badge": { Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span> },
  "@/features/accounts/permission-ui": { PermissionContext: React.createContext({ role: Role.SUPER_ADMIN }) },
})("src/features/planning/planning-modules.tsx") as { PlanningModules: React.ComponentType<{ mode?: string; schemePlanningEnabled?: boolean; partyPlanningEnabled?: boolean }> };
const cards = (props: { schemePlanningEnabled?: boolean; partyPlanningEnabled?: boolean }) => [...renderToStaticMarkup(<LandingModule.PlanningModules mode="create" {...props} />).matchAll(/<h3>(?:<svg[^>]*>.*?<\/svg>)?([^<]+)<\/h3>/g)].map((m) => m[1]);
assert.equal(cards({ partyPlanningEnabled: true, schemePlanningEnabled: true }).join("|"), "Territory Mapping|Party Planning|Sales Planning|Recovery Planning|Scheme Planning", "five cards in the required order");
assert.equal(cards({ partyPlanningEnabled: false, schemePlanningEnabled: true }).join("|"), "Territory Mapping|Party Planning|Sales Planning|Recovery Planning|Scheme Planning", "Party Planning stays visible (disabled) when the flag is off; the order is unchanged");
assert.equal(cards({}).join("|"), "Territory Mapping|Party Planning|Sales Planning|Recovery Planning|Scheme Planning", "default (no flag passed) fails closed — still listed, but disabled");
{
  // Flag OFF: the card is visible but disabled and cannot navigate; flag ON: a normal link, no disabled styling.
  const off = renderToStaticMarkup(<LandingModule.PlanningModules mode="create" schemePlanningEnabled partyPlanningEnabled={false} />);
  const partyOff = off.slice(off.indexOf("<div aria-disabled"), off.indexOf('<a href="/planning/sales"')); // the Party Planning card only
  assert.ok(!off.includes('href="/planning/party/seasonal"') && !partyOff.includes("<a "), "no link into Party Planning while disabled");
  assert.ok(partyOff.includes("Temporarily Disabled") && partyOff.includes('aria-disabled="true"') && partyOff.includes("cursor-not-allowed") && partyOff.includes("opacity-60") && partyOff.includes("Party Planning is temporarily disabled"), "muted, not-allowed cursor, label + tooltip");
  assert.ok(off.includes('href="/planning/territory-mapping"') && off.includes('href="/planning/sales"') && off.includes('href="/planning/recovery"'), "Territory Mapping and the other modules are unaffected");
  const schemeOff = renderToStaticMarkup(<LandingModule.PlanningModules mode="create" partyPlanningEnabled={false} />);
  const schemeCard = schemeOff.slice(schemeOff.indexOf('<a href="/planning/recovery"'));
  assert.ok(schemeCard.includes("Coming Soon") && !schemeCard.includes("cursor-not-allowed") && !schemeCard.includes("aria-disabled") && schemeCard.includes("opacity-70"), "the Scheme card keeps its own look");
  const on = renderToStaticMarkup(<LandingModule.PlanningModules mode="create" schemePlanningEnabled partyPlanningEnabled />);
  assert.ok(on.includes('href="/planning/party/seasonal"') && !on.includes("Temporarily Disabled") && !on.includes("aria-disabled") && !on.includes("cursor-not-allowed"), "enabled: exactly the normal card");
}
// Other entry points into Party Planning no longer link there while it is disabled (calendar appointments on the dashboard and calendar page).
{
  const { PartyLink } = testLoader({ "next/link": { __esModule: true, default: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => <a href={href} className={className}>{children}</a> } })("src/features/calendar/party-link.tsx") as { PartyLink: React.ComponentType<{ enabled: boolean; className?: string; children: React.ReactNode }> };
  const off = renderToStaticMarkup(<PartyLink enabled={false} className="x">Sharma</PartyLink>), on = renderToStaticMarkup(<PartyLink enabled className="x">Sharma</PartyLink>);
  assert.ok(!off.includes("href") && off.includes("Sharma"), "disabled: same text, no link");
  assert.ok(on.includes('href="/planning/party/view"') && on.includes("hover:underline"), "enabled: the normal link");
  for (const f of ["src/features/calendar/upcoming-card.tsx", "src/features/calendar/calendar-view.tsx"]) assert.ok(!/href="\/planning\/party/.test(read(f)) && read(f).includes("PartyLink"), `${f} has no raw Party Planning link`);
  assert.ok(read("src/app/(dashboard)/dashboard/page.tsx").includes("partyPlanningEnabled={isPartyPlanningEnabled()}") && read("src/app/(dashboard)/planning/calendar/page.tsx").includes("partyPlanningEnabled={isPartyPlanningEnabled()}"), "flag read on the server per request");
}
{
  const html = renderToStaticMarkup(<LandingModule.PlanningModules mode="create" partyPlanningEnabled schemePlanningEnabled />);
  assert.ok(html.includes('href="/planning/territory-mapping"') && !html.includes('href="/planning/party/territory"'), "Territory Mapping opens its own page directly");
  assert.ok(html.includes('href="/planning/party/seasonal"') && html.includes('href="/planning/sales"') && html.includes('href="/planning/recovery"') && html.includes('href="/planning/scheme"'), "the other cards open their existing workspaces");
  assert.ok(html.indexOf("/planning/territory-mapping") < html.indexOf("/planning/party/seasonal") && html.indexOf("/planning/party/seasonal") < html.indexOf("/planning/sales"), "document order");
}
for (const f of ["create", "view"]) assert.ok(read(`src/app/(dashboard)/planning/${f}/page.tsx`).includes("partyPlanningEnabled={isPartyPlanningEnabled()}"), `${f} landing reads the flag on the server per request`);

// 7. Territory Mapping is independent: own route, standalone breadcrumbs, no Party Planning navigation, old URL redirects; permissions unchanged.
{
  const page = read("src/features/party-planning/territory-mapping-page.tsx");
  assert.ok(!page.includes("PartyPlanModeLinks") && !page.includes("party_planning.title"), "no dependency on the Party Planning navigation or title");
  assert.ok(page.includes("{ label: T.createView, href: \"/planning/create\" }, { label: territory }]"), "breadcrumbs: Planning › Create/View Plans › Territory Mapping");
  assert.ok(read("src/app/(dashboard)/planning/territory-mapping/page.tsx").includes("TerritoryMappingPage"));
  assert.ok(/redirect\("\/planning\/territory-mapping"\)/.test(read("src/app/(dashboard)/planning/party/territory/page.tsx")), "old URL redirects");
  assert.ok(!read("src/app/(dashboard)/planning/territory-mapping/page.tsx").includes("partyPlanningGate"), "the standalone page is not behind the Party Planning flag");
  assert.equal(moduleForPage("/planning/territory-mapping"), "partyPlanning", "same page grant as before the move");
  assert.equal(moduleForPage("/planning/party/territory"), "partyPlanning");
  const ops = { role: Role.CUSTOM_ADMIN, permissions: { partyPlanning: ["read"] } } as never, salesOnly = { role: Role.CUSTOM_ADMIN, permissions: { salesPlanning: ["read"] } } as never, none = { role: Role.CUSTOM_ADMIN, permissions: {} } as never;
  assert.equal(mayEnterPage(ops, "/planning/territory-mapping"), true, "a custom Admin with the existing grant still gets in");
  assert.equal(mayEnterPage(salesOnly, "/planning/territory-mapping"), false, "moving the card grants no extra access");
  assert.equal(mayEnterPage(none, "/planning/territory-mapping"), false);
  assert.equal(mayEnterPage({ role: Role.SALES_OFFICER } as never, "/planning/territory-mapping"), true, "SO / RM access is decided by the APIs, as before");
  assert.deepEqual(apiPermission("/api/territory-mapping/dealers", "GET"), ["partyPlanning", "read"]);
  assert.deepEqual(apiPermission("/api/territory-mapping/import/commit", "POST"), ["partyPlanning", "manage"]);
  assert.deepEqual(apiPermission("/api/seasonal-plans", "GET"), ["partyPlanning", "read"], "Party Planning API permission rules are unchanged (the flag adds a gate, it replaces none)");
}

// 8. Configuration.
{
  const env = read(".env.example");
  assert.match(env, /^PARTY_PLANNING_ENABLED="true"$/m, ".env.example enables it for development");
  assert.match(env, /PRODUCTION MUST SET PARTY_PLANNING_ENABLED="false"/);
  assert.ok(!/NEXT_PUBLIC_PARTY/.test(env) && !read("src/features/planning/planning-modules.tsx").includes("process.env"), "the variable is never exposed to the browser");
}
console.log("party-planning-flag.test.tsx — all assertions passed");
