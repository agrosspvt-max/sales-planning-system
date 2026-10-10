/**
 * PARTY_PLANNING_ENABLED + the Create/View Plans reorganisation: the flag fails closed, is read by ONE helper in ONE (Node) runtime for the card, the pages AND the APIs,
 * and never touches Territory Mapping, Sales / Recovery / Scheme Planning, permissions or data.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { isPartyPlanningEnabled, PARTY_PLANNING_UNAVAILABLE_MESSAGE } from "@/lib/feature-flags";
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

// 2. ONE helper, ONE runtime: the flag is read in exactly one place, and never in the edge middleware (whose environment snapshot goes stale
//    after a .env reload — the root cause of "card enabled, route unavailable").
{
  const walk0 = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk0(p) : [p]; });
  const readers = walk0("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test.") && /PARTY_PLANNING_ENABLED/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  assert.deepEqual(readers, [join("src", "lib", "feature-flags.ts")], "only the helper names the variable");
  assert.ok(!/party|feature-flags/i.test(read("src/middleware.ts")), "the edge middleware does not touch the flag");
}

// 3. API enforcement (Node runtime): disabled → 503 before authentication or any data access; enabled → exactly the normal requireAuth().
const apiChecks = (async () => {
  let authCalls = 0;
  const { assertPartyPlanningEnabled, requirePartyAuth } = testLoader({ "@/lib/http": { ApiError: TestApiError, requireAuth: async () => { authCalls += 1; return { userId: "u1" }; } } })("src/lib/party-planning-access.ts") as {
    assertPartyPlanningEnabled: (env: Record<string, string | undefined>) => void; requirePartyAuth: () => Promise<{ userId: string }>;
  };
  const before = process.env.PARTY_PLANNING_ENABLED;
  try {
    for (const off of [undefined, "", "false", "banana", "1", "yes"]) {
      if (off === undefined) delete process.env.PARTY_PLANNING_ENABLED; else process.env.PARTY_PLANNING_ENABLED = off;
      await assert.rejects(requirePartyAuth(), (e: unknown) => (e as TestApiError).status === 503 && (e as Error).message === PARTY_PLANNING_UNAVAILABLE_MESSAGE, `flag ${JSON.stringify(off)} → 503`);
      assert.throws(() => assertPartyPlanningEnabled({ PARTY_PLANNING_ENABLED: off }), /temporarily unavailable/);
    }
    assert.equal(authCalls, 0, "a disabled request never reaches authentication or data");
    // Toggling the live environment takes effect on the very next call (no restart-dependent snapshot in this runtime).
    process.env.PARTY_PLANNING_ENABLED = "true";
    assert.deepEqual(await requirePartyAuth(), { userId: "u1" }); assert.equal(authCalls, 1, "enabled: identical to requireAuth()");
    process.env.PARTY_PLANNING_ENABLED = "false";
    await assert.rejects(requirePartyAuth(), (e: unknown) => (e as TestApiError).status === 503);
    process.env.PARTY_PLANNING_ENABLED = "true";
    assert.deepEqual(await requirePartyAuth(), { userId: "u1" });

    // A real Party Planning route end to end: 503 when disabled (service never called), normal result when enabled, authorization unchanged.
    let serviceCalls = 0, authFails = false;
    const access = load0();
    function load0() {
      return testLoader({
        "next/server": {},
        "@/lib/http": {
          ApiError: TestApiError, ok: (v: unknown) => ({ status: 200, body: v }),
          handle: (fn: () => Promise<unknown>) => fn().catch((e: TestApiError) => ({ status: e.status, body: { error: e.message } })),
          requireAuth: async () => { authCalls += 1; if (authFails) throw new TestApiError(401, "Not authenticated"); return { userId: "u1" }; },
        },
        "@/features/party-planning/seasonal.server": { listSeasonalSheets: async () => { serviceCalls += 1; return ["sheet"]; }, createSeasonalSheet: async () => { serviceCalls += 1; return {}; } },
      })("src/app/api/seasonal-sheets/route.ts") as { GET: (r: unknown) => Promise<{ status: number; body: unknown }>; POST: (r: unknown) => Promise<{ status: number; body: unknown }> };
    }
    const req = { nextUrl: { searchParams: new URLSearchParams() }, json: async () => ({}) };
    process.env.PARTY_PLANNING_ENABLED = "false"; authCalls = 0;
    const blockedGet = await access.GET(req), blockedPost = await access.POST(req);
    assert.deepEqual([blockedGet.status, blockedPost.status, serviceCalls, authCalls], [503, 503, 0, 0], "disabled: reads AND writes are rejected, nothing runs");
    process.env.PARTY_PLANNING_ENABLED = "true";
    const okGet = await access.GET(req);
    assert.deepEqual([okGet.status, okGet.body, serviceCalls], [200, ["sheet"], 1], "enabled: the route works as before");
    authFails = true;
    assert.equal((await access.GET(req)).status, 401, "enabled does NOT bypass authentication");

    // The page gate (same helper as the card): enabled → no gate (the real page renders); disabled → the friendly unavailable page. Territory Mapping has no gate.
    const { partyPlanningGate } = testLoader({
      "next/link": { __esModule: true, default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> },
      "@/components/layout/page-header": { PageHeader: ({ subtitle }: { subtitle?: string }) => <p>{subtitle}</p> },
      "@/components/ui/card": { Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3> },
      "@/components/ui/badge": { Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span> },
      "@/components/ui/button": { Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button> },
    })("src/features/party-planning/party-planning-unavailable.tsx") as { partyPlanningGate: () => React.ReactNode | null };
    process.env.PARTY_PLANNING_ENABLED = "true";
    assert.equal(partyPlanningGate(), null, "enabled: no unavailable screen on /planning/party/*");
    process.env.PARTY_PLANNING_ENABLED = "false";
    assert.ok(renderToStaticMarkup(<>{partyPlanningGate()}</>).includes("temporarily unavailable"), "disabled: direct navigation shows the unavailable page");
    process.env.PARTY_PLANNING_ENABLED = "true";
    assert.equal(partyPlanningGate(), null, "and it follows the live value straight back");
  } finally { if (before === undefined) delete process.env.PARTY_PLANNING_ENABLED; else process.env.PARTY_PLANNING_ENABLED = before; }
})();

// 4. Every API route that uses Party Planning code is behind requirePartyAuth (a future route cannot slip outside the flag); Territory Mapping routes are not.
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const routeOf = (file: string) => "/" + file.split(sep).slice(file.split(sep).indexOf("app") + 1, -1).join("/").replace(/\[[^\]]+\]/g, "x");
let covered = 0, territory = 0;
for (const file of walk("src/app/api").filter((f) => f.endsWith("route.ts"))) {
  const route = routeOf(file), src = read(file);
  if (route.startsWith("/api/territory-mapping")) { assert.ok(!src.includes("requirePartyAuth"), `${route} must stay available`); territory += 1; continue; }
  if (/features\/party-planning\//.test(src)) { assert.ok(src.includes("requirePartyAuth()") && !/\brequireAuth\(\)/.test(src), `${route} uses Party Planning code but is not behind the flag`); covered += 1; }
}
assert.ok(covered >= 20 && territory >= 9, `scanned ${covered} party routes and ${territory} territory routes`);
// …and every Party Planning PAGE carries the page-level gate (same helper, same runtime).
const pageFiles = walk("src/app/(dashboard)/planning/party").filter((f) => f.endsWith("page.tsx") && !f.includes(`${sep}territory${sep}`));
assert.equal(pageFiles.length, 6, "party, view, seasonal, seasonal/[id], monthly, monthly/[id]");
for (const f of pageFiles) assert.ok(/const unavailable = partyPlanningGate\(\);[^\n]*\n\s*if \(unavailable\) return unavailable;/.test(read(f)), `${f} is gated`);
assert.ok(read("src/features/party-planning/party-planning-unavailable.tsx").includes("isPartyPlanningEnabled()"), "the page gate uses the same helper as the card");
for (const f of ["src/lib/feature-flags.ts", "src/lib/party-planning-access.ts"]) assert.ok(!/prisma|writeAudit|migrat/i.test(read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${f} touches no data`);
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
apiChecks.then(() => console.log("party-planning-flag.test.tsx — all assertions passed")).catch((e) => { console.error(e); process.exit(1); });
