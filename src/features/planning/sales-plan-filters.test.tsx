/** Sales Planning View/Create Plans column filters: role matrix, OR/AND, scope preservation and rendered tables. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { TestApiError, testLoader } from "@/features/dealer-tags/test-loader";
import { applyPlanFilters, planFilterKeys, planFilterOptions } from "./plan-column-filters";

/* ---------------------------------- fixture: every plan that exists ---------------------------------- */
const officers: Record<string, { name: string; group: string | null }> = {
  arjun: { name: "Arjun Yadav", group: "CG" }, sunil: { name: "Sunil", group: "CG" }, chhitranjan: { name: "Chhitranjan", group: "MP" },
  "rm-1": { name: "RM One", group: "CG" }, rahul: { name: "Rahul Patidar", group: "UP" }, "other-rm": { name: "Other RM", group: "UP" },
};
interface Row { id: string; officerId: string; month: string; status: string; type: "SEASONAL" | "YEARLY"; lifecycle: string }
const seasonal: Row[] = [
  { id: "sp-1", officerId: "arjun", month: "", status: "PENDING_RM", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "sp-2", officerId: "sunil", month: "", status: "APPROVED", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "sp-3", officerId: "chhitranjan", month: "", status: "APPROVED", type: "SEASONAL", lifecycle: "CLOSED" },
  { id: "sp-4", officerId: "rahul", month: "", status: "PENDING_ADMIN", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "sp-5", officerId: "rm-1", month: "", status: "DRAFT", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "sp-6", officerId: "sunil", month: "", status: "PENDING_RM", type: "YEARLY", lifecycle: "ACTIVE" },
  { id: "sp-7", officerId: "other-rm", month: "", status: "PENDING_ADMIN", type: "YEARLY", lifecycle: "ACTIVE" },
];
const monthly: Row[] = [
  { id: "mp-1", officerId: "arjun", month: "September", status: "PENDING_RM", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "mp-2", officerId: "sunil", month: "October", status: "PENDING_RM", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "mp-3", officerId: "sunil", month: "September", status: "APPROVED", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "mp-4", officerId: "chhitranjan", month: "September", status: "APPROVED", type: "SEASONAL", lifecycle: "CLOSED" },
  { id: "mp-5", officerId: "rm-1", month: "August", status: "DRAFT", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "mp-6", officerId: "rahul", month: "September", status: "PENDING_ADMIN", type: "SEASONAL", lifecycle: "ACTIVE" },
  { id: "mp-7", officerId: "other-rm", month: "October", status: "PENDING_ADMIN", type: "SEASONAL", lifecycle: "ACTIVE" },
];
// The role scope the existing server applies (getOfficerScope).
const scopeIds: Record<string, string[] | "all"> = {
  admin: "all", "rm-1": ["rm-1", "arjun", "sunil", "chhitranjan"], arjun: ["arjun"],
};
const ctx = (userId: string, role: Role): AuthContext => ({ userId, username: userId, role, groupId: userId === "rm-1" ? "team" : null });
const admin = ctx("admin", Role.SUPER_ADMIN), rm = ctx("rm-1", Role.REGIONAL_MANAGER), so = ctx("arjun", Role.SALES_OFFICER);
const inScope = (userId: string, officerId: string) => { const s = scopeIds[userId]; return s === "all" || (s as string[]).includes(officerId); };

/* ---------------------------------- the real list services over a fake DB ---------------------------------- */
const matches = (o: string | { in: string[] } | undefined, officerId: string) => o === undefined || (typeof o === "string" ? o === officerId : o.in.includes(officerId));
const officerOf = (id: string) => ({ name: officers[id].name, territory: "T", group: officers[id].group ? { name: officers[id].group } : null });
const when = "2026-10-01T00:00:00.000Z";
const prisma = {
  seasonPlan: {
    findMany: async ({ where }: { where: { officerId?: string | { in: string[] } } }) => seasonal.filter((r) => matches(where.officerId, r.officerId)).map((r) => ({
      id: r.id, seasonId: "s1", season: { name: "Kharif", year: 2026, seasonalMode: "PACK_SIZE" }, officerId: r.officerId, officer: officerOf(r.officerId),
      planningType: r.type, versionName: null, source: "MANUAL", version: 1, status: r.status, lifecycleState: r.lifecycle, isActiveVersion: true,
      lastSavedAt: when, submittedAt: null, createdAt: when, updatedAt: when,
    })),
  },
  monthlyPlan: {
    findMany: async ({ where }: { where: { officerId?: { in: string[] } | undefined } }) => monthly.filter((r) => matches(where.officerId, r.officerId)).map((r) => ({
      id: r.id, seasonPlanId: "sp", seasonMonthId: `m-${r.month}`, seasonPlan: { seasonId: "s1", season: { name: "Kharif", year: 2026 } },
      seasonMonth: { name: r.month, order: 1, calendarMonth: null, calendarYear: null }, officerId: r.officerId, officer: officerOf(r.officerId),
      status: r.status, lifecycleState: r.lifecycle, submittedAt: null, approvedAt: null, lastSavedAt: when, updatedAt: when,
    })),
  },
};
const noop = async () => ({});
const stubs = (names: string[]) => Object.fromEntries(names.map((n) => [n, noop]));
const scopeMock = {
  getOfficerScope: async (c: AuthContext) => { const ids = scopeIds[c.userId]; return ids === "all" ? { all: true, ids: [] } : { all: false, ids }; },
  assertOfficerInScope: noop, getCurrentDealerIds: noop, getCurrentManagerId: noop, isPlanOwner: () => true, isDealerOwnerRole: () => true,
};
const heavy = {
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/scope": scopeMock, "@/lib/audit": { writeAudit: noop },
  "@/features/notifications/service.server": stubs(["createNotification", "notifyMany", "getSuperAdminIds"]),
  "@/features/users/catalogue.server": stubs(["planningProductsForOfficer", "clearanceMapForGroup", "catalogueEntryForOfficerProduct", "clearanceSoldForGroup"]),
  "@/features/products/merge.server": stubs(["loadEffectiveProduct"]),
  "@/features/seasons/service.server": stubs(["findOrCreateSeason"]),
  "@/features/assignments/service.server": stubs(["applyDealerAssignment"]),
  "@/lib/dealer-display-name.server": stubs(["loadDealerAliasNameMap"]),
  "@/lib/dealer-resolver": stubs(["findProbableDealers"]),
  "./monthly.server": stubs(["buildMonthlyDealers"]),
};
const load = testLoader(heavy);
const seasonalService = load<typeof import("./service.server")>("src/features/planning/service.server.ts");
const monthlyService = load<typeof import("./monthly-plan.server")>("src/features/planning/monthly-plan.server.ts");
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
type Listed = { id: string; officerId: string; officerName: string; groupName: string | null; monthName?: string };
const listSeasonal = async (c: AuthContext, mine = false) => plain(await seasonalService.listPlans(c, undefined, mine)) as unknown as Listed[];
const listMonthly = async (c: AuthContext) => plain(await monthlyService.listMonthlyPlans(c)) as unknown as Listed[];

/* ---------------------------------- rendered page ---------------------------------- */
let preset: Record<number, unknown> = {};
let stateCall = 0;
let seasonalServed: unknown[] = [], monthlyServed: unknown[] = [];
const pageLoad = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = stateCall++; return [i < 5 && i in preset ? preset[i] : initial, () => {}]; } }, // tab, viewSub, officerFilter, historyFilters, columnFilters
  "next/link": { __esModule: true, default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> },
  "next/navigation": { useRouter: () => ({ push: () => {} }) },
  "@tanstack/react-query": {
    useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled?: boolean }) => {
      const key = queryKey.join("/");
      if (enabled === false) return { data: undefined, isLoading: false };
      if (key === "plans/scope") return { data: seasonalServed, isLoading: false };
      if (key === "plans/mine") return { data: (seasonalServed as Listed[]).filter((p) => p.officerId === "rm-1"), isLoading: false };
      if (key.startsWith("monthly-plans")) return { data: monthlyServed, isLoading: false };
      if (key === "import-options") return { data: { officers: Object.entries(officers).map(([id, o]) => ({ id, name: o.name })) }, isLoading: false };
      return { data: undefined, isLoading: false };
    },
    useMutation: () => ({ mutate: () => {}, isPending: false }),
    useQueryClient: () => ({ invalidateQueries: () => {} }),
  },
  "@/lib/api-client": { api: { get: async () => [], post: async () => ({}) } },
  "@/components/layout/page-header": { PageHeader: () => null },
  "./status-badge": { PlanStateBadge: ({ status }: { status: string }) => <>{status}</> },
});
const { SalesPlanning } = pageLoad<typeof import("./sales-planning")>("src/features/planning/sales-planning.tsx");
async function serve(userId: string, role: Role) {
  seasonalServed = await listSeasonal(ctx(userId, role)); monthlyServed = await listMonthly(ctx(userId, role));
}
const draw = async (role: Role, userId: string, mode: "create" | "view", p: Record<number, unknown> = {}) => {
  await serve(userId, role); preset = p; stateCall = 0;
  return renderToStaticMarkup(<SalesPlanning role={role} userId={userId} mode={mode} />);
};
const filterButtons = (html: string) => [...new Set([...html.matchAll(/aria-label="Filter by ([^"]+)"/g)].map((m) => m[1]))];
const headerTexts = (html: string) => [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim()).slice(0, 9);
const seasonalOpened = (html: string) => [...html.matchAll(/href="\/planning\/(sp-[^"]+)"/g)].map((m) => m[1]).sort();
const monthlyOpened = (html: string) => [...html.matchAll(/href="\/planning\/monthly\/(mp-[^"]+)"/g)].map((m) => m[1]).sort();

async function main() {
  const monthlyAll = plain(await listMonthly(admin)); const seasonalAll = plain(await listSeasonal(admin));
  const f = (filters: Parameters<typeof applyPlanFilters>[1], rows: Listed[] = monthlyAll, keys = planFilterKeys("SUPER_ADMIN")) => ids(applyPlanFilters(rows, filters, keys));

  // 1–3, 10–12: Admin filters Month / Sales Officer / State; several values in one column are OR-ed.
  assert.deepEqual(f({ month: ["October"] }), ["mp-2", "mp-7"]);
  assert.deepEqual(f({ month: ["October", "August"] }), ["mp-2", "mp-5", "mp-7"], "10: Months OR");
  assert.deepEqual(f({ officer: ["arjun"] }), ["mp-1"]);
  assert.deepEqual(f({ officer: ["arjun", "rahul"] }), ["mp-1", "mp-6"], "11: Sales Officers OR");
  assert.deepEqual(f({ state: ["MP"] }), ["mp-4"]);
  assert.deepEqual(f({ state: ["MP", "UP"] }), ["mp-4", "mp-6", "mp-7"], "12: States OR");
  // 13: AND across columns — (Arjun OR Rahul) AND CG AND September.
  assert.deepEqual(f({ officer: ["arjun", "rahul"], state: ["CG"], month: ["September"] }), ["mp-1"], "13: AND");
  assert.deepEqual(f({ officer: ["arjun", "sunil"], state: ["MP"] }), [], "never OR across different filters");
  // 14 / 21: empty selection = All; no filter = same rows as before.
  assert.deepEqual(f({ officer: [] }), ids(monthlyAll));
  assert.deepEqual(f({}), ids(monthlyAll), "21: no filters → same plans as before");

  // Seasonal / Yearly rows: State and Sales Officer filters work; they carry no month so Month is never applied.
  assert.deepEqual(ids(applyPlanFilters(seasonalAll, { officer: ["sunil"], state: ["CG"] }, planFilterKeys("SUPER_ADMIN").filter((k) => k !== "month"))), ["sp-2", "sp-6"]);
  assert.deepEqual(ids(applyPlanFilters(seasonalAll, { month: ["October"] }, ["officer", "state"])), ids(seasonalAll), "Month does not wipe rows that have no month");

  // 4–9: role matrix.
  assert.deepEqual(planFilterKeys("SUPER_ADMIN").sort(), ["month", "officer", "state"]);
  assert.deepEqual(planFilterKeys("CUSTOM_ADMIN").sort(), ["month", "officer", "state"]);
  assert.deepEqual(planFilterKeys("REGIONAL_MANAGER").sort(), ["month", "officer"], "6: RM has no State filter");
  assert.deepEqual(planFilterKeys("SALES_OFFICER"), ["month"], "8/9: SO has neither Sales Officer nor State");
  assert.deepEqual(ids(applyPlanFilters(monthlyAll, { state: ["MP"] }, planFilterKeys("REGIONAL_MANAGER"))), ids(monthlyAll), "an unavailable filter is ignored");

  // 18–20: server scope untouched, filters only narrow it.
  assert.deepEqual(ids(monthlyAll), ids(monthly), "18: Admin sees every monthly plan");
  assert.deepEqual(ids(seasonalAll), ids(seasonal), "18: Admin sees every seasonal/yearly plan");
  const rmMonthly = await listMonthly(rm), rmSeasonal = await listSeasonal(rm);
  assert.deepEqual(ids(rmMonthly), ["mp-1", "mp-2", "mp-3", "mp-4", "mp-5"], "RM scope unchanged");
  assert.deepEqual(ids(rmSeasonal), ["sp-1", "sp-2", "sp-3", "sp-5", "sp-6"]);
  assert.deepEqual(ids(await listSeasonal(rm, true)), ["sp-5"], "RM 'mine' unchanged");
  const rmKeys = planFilterKeys("REGIONAL_MANAGER");
  for (const filters of [{ officer: ["rahul"] }, { officer: ["other-rm", "sunil"] }, { officer: ["rahul", "arjun"], month: ["September"] }]) {
    for (const rows of [rmMonthly, rmSeasonal]) {
      const result = applyPlanFilters(rows, filters, rmKeys);
      assert.ok(result.every((p) => inScope("rm-1", p.officerId)), "19: RM filter parameters never reach outside RM scope");
    }
  }
  assert.deepEqual(ids(applyPlanFilters(rmMonthly, { officer: ["rahul"] }, rmKeys)), []);
  assert.deepEqual(ids(await listMonthly(so)), ["mp-1"], "SO scope unchanged");
  assert.deepEqual(ids(await listSeasonal(so)), ["sp-1"]);
  assert.deepEqual(ids(applyPlanFilters(await listMonthly(so), { month: ["October"] }, planFilterKeys("SALES_OFFICER"))), [], "20: SO filter cannot reach other officers' plans");
  assert.deepEqual(plain(planFilterOptions(rmMonthly, "officer").map((o) => o.value)).sort(), ["arjun", "chhitranjan", "rm-1", "sunil"], "RM options only from RM scope");
  assert.ok(!planFilterOptions(rmMonthly, "officer").some((o) => o.value === "rahul"));
  assert.deepEqual(plain(planFilterOptions(await listMonthly(so), "month").map((o) => o.value)), ["September"], "SO month options from their own plans only");
  assert.deepEqual(plain(planFilterOptions(monthlyAll, "month").map((o) => o.value)), ["August", "September", "October"], "months in calendar order");
  for (const route of ["src/app/api/planning/season-plans/route.ts", "src/app/api/planning/monthly-plans/route.ts"]) {
    const source = readFileSync(route, "utf8");
    assert.ok(!/searchParams\.get\("(officer|salesOfficer|state|month)/i.test(source), `${route}: no officer/state/month filter parameters`);
  }

  /* ---------- rendered tables ---------- */
  const MONTHLY = { 0: "MONTHLY" }, YEARLY = { 0: "YEARLY" };
  for (const mode of ["create", "view"] as const) {
    const sub = mode === "view" ? { 1: "SUBMITTED" } : {};
    // Admin — Monthly shows all three filters in the existing column order.
    let html = await draw(Role.SUPER_ADMIN, "admin", mode, { ...MONTHLY, ...sub });
    assert.deepEqual(filterButtons(html), ["Month", "Sales Officer", "State"], `1–3 (${mode})`);
    assert.deepEqual(headerTexts(html).slice(0, 4), ["Season", "Month", "Sales Officer", "State"]);
    // Admin — Seasonal / Yearly: Sales Officer + State (their tables have no Month column).
    html = await draw(Role.SUPER_ADMIN, "admin", mode, sub);
    assert.deepEqual(filterButtons(html), ["Sales Officer", "State"]);
    assert.deepEqual(headerTexts(html).slice(0, 3), ["Season", "Sales Officer", "State"]);
    // RM — Month + Sales Officer; State stays an ordinary header.
    html = await draw(Role.REGIONAL_MANAGER, "rm-1", mode, { ...MONTHLY, ...sub });
    assert.deepEqual(filterButtons(html), ["Month", "Sales Officer"], "4–6");
    assert.ok(/<th[^>]*>State<\/th>/.test(html), "RM State is a normal header");
    // SO — Month only; no Sales Officer column.
    html = await draw(Role.SALES_OFFICER, "arjun", mode, { ...MONTHLY, ...sub });
    assert.deepEqual(filterButtons(html), ["Month"], "7–9");
    assert.ok(/<th[^>]*>State<\/th>/.test(html) && !html.includes("Sales Officer"));
    html = await draw(Role.SALES_OFFICER, "arjun", mode, sub);
    assert.deepEqual(filterButtons(html), [], "SO Seasonal has no filterable column");
    html = await draw(Role.SUPER_ADMIN, "admin", mode, { ...YEARLY, ...sub });
    assert.deepEqual(filterButtons(html), ["Sales Officer", "State"]);
  }

  // 17 — the Admin "All Sales Officers" selector stays on Create New Plan; View Plans uses the column header instead.
  assert.ok((await draw(Role.SUPER_ADMIN, "admin", "create", MONTHLY)).includes("All Sales Officers"), "17: Create keeps its dropdown");
  assert.ok(!(await draw(Role.SUPER_ADMIN, "admin", "view", { ...MONTHLY, 1: "SUBMITTED" })).includes("All Sales Officers"), "no competing Sales Officer filter on View Plans");

  // 15 / 16 / 21 / 22 — existing tabs: bucket membership, unfiltered rows and Open links are unchanged.
  const adminView = (p: Record<number, unknown>) => draw(Role.SUPER_ADMIN, "admin", "view", p);
  assert.deepEqual(monthlyOpened(await adminView({ ...MONTHLY, 1: "SUBMITTED" })), ["mp-1", "mp-2", "mp-6", "mp-7"], "15: Submitted");
  assert.deepEqual(monthlyOpened(await adminView({ ...MONTHLY, 1: "APPROVED" })), ["mp-3"], "15: Approved");
  assert.deepEqual(monthlyOpened(await adminView({ ...MONTHLY, 1: "HISTORY" })), ["mp-4"], "15: Older Plans");
  assert.deepEqual(seasonalOpened(await adminView({ 1: "SUBMITTED" })), ["sp-1", "sp-4"], "16: Seasonal Submitted");
  assert.deepEqual(seasonalOpened(await adminView({ 1: "APPROVED" })), ["sp-2"]);
  assert.deepEqual(seasonalOpened(await adminView({ 1: "HISTORY" })), ["sp-3"]);
  assert.deepEqual(seasonalOpened(await adminView({ ...YEARLY, 1: "SUBMITTED" })), ["sp-6", "sp-7"], "16: Yearly");
  const create = await draw(Role.SUPER_ADMIN, "admin", "create", MONTHLY);
  assert.deepEqual(monthlyOpened(create), ["mp-5"], "Create New Plan lists only editable plans");
  assert.ok(create.includes('href="/planning/monthly/mp-5"'), "22: Open links unchanged");

  // Active filters narrow each view and show their count; clearing restores the table.
  let html = await adminView({ ...MONTHLY, 1: "SUBMITTED", 4: { officer: ["arjun", "sunil"], state: ["CG"], month: ["September"] } });
  assert.deepEqual(monthlyOpened(html), ["mp-1"], "Monthly + September + CG + (Arjun OR Sunil)");
  assert.ok(html.includes("Month (1)") && html.includes("Sales Officer (2)") && html.includes("State (1)"));
  html = await adminView({ ...MONTHLY, 1: "SUBMITTED", 4: { officer: [], month: [] } });
  assert.deepEqual(monthlyOpened(html), ["mp-1", "mp-2", "mp-6", "mp-7"], "14: All restores the unfiltered tab");
  html = await adminView({ 1: "SUBMITTED", 4: { officer: ["arjun"], month: ["October"] } });
  assert.deepEqual(seasonalOpened(html), ["sp-1"], "Seasonal: officer filter applies; Month (not a Seasonal column) is ignored");
  // The History tab still has its Season filter alongside the header filters, and no duplicate Sales Officer control.
  html = await adminView({ ...MONTHLY, 1: "HISTORY", 4: { state: ["MP"] } });
  assert.deepEqual(monthlyOpened(html), ["mp-4"]);
  const source = readFileSync("src/features/planning/sales-planning.tsx", "utf8");
  assert.ok(source.includes('key: "season"') && !source.includes('key: "officer"'), "Older Plans keeps Season; Sales Officer lives in the column header");
  // Scope again at the page level: an RM/SO only ever renders their own scope, whatever filters are set.
  html = await draw(Role.REGIONAL_MANAGER, "rm-1", "view", { ...MONTHLY, 1: "SUBMITTED", 4: { officer: ["rahul", "other-rm"] } });
  assert.deepEqual(monthlyOpened(html), [], "RM selecting out-of-scope officers renders nothing extra");
  html = await draw(Role.SALES_OFFICER, "arjun", "view", { ...MONTHLY, 1: "SUBMITTED", 4: { officer: ["sunil"], state: ["MP"] } });
  assert.deepEqual(monthlyOpened(html), ["mp-1"], "SO: Sales Officer/State selections have no effect, scope unchanged");
  console.log("sales-plan-filters.test.tsx — all assertions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
