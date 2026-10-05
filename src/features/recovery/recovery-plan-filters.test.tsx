/** Recovery Planning column filters: role matrix, OR/AND semantics, scope preservation and the rendered tables. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { TestApiError, testLoader } from "@/features/dealer-tags/test-loader";
import { applyRecoveryPlanFilters, recoveryFilterKeys, recoveryFilterOptions, type RecoveryFilterablePlan } from "./recovery-plan-filters";

/* ---------------------------------- fixture: every plan that exists ---------------------------------- */
interface Plan extends RecoveryFilterablePlan {
  id: string; seasonName: string; status: string; lifecycleState: string; cutoffDate: string; territory: string | null; updatedAt: string;
}
const plan = (id: string, officerId: string, officerName: string, groupName: string | null, monthName: string, status = "DRAFT"): Plan => ({
  id, seasonName: "Kharif 2026", monthName, officerId, officerName, groupName, territory: "T", status, lifecycleState: "ACTIVE",
  cutoffDate: "2026-09-30T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
});
const ALL_PLANS: Plan[] = [
  plan("p1", "arjun", "Arjun Yadav", "CG", "September"),
  plan("p2", "sunil", "Sunil", "CG", "October"),
  plan("p3", "sunil", "Sunil", "CG", "September"),
  plan("p4", "chhitranjan", "Chhitranjan", "MP", "September"),
  plan("p5", "rm-1", "RM One", "CG", "August"),
  plan("p6", "other-so", "Outside Officer", "UP", "September"), // belongs to another RM's team
  plan("p7", "other-rm", "Other RM", "UP", "October"),
  plan("p8", "nostate", "No State", null, "July"),
];
// The role scope the existing server applies (getOfficerScope): who each caller may see.
const scopeIds: Record<string, string[] | "all"> = {
  admin: "all",
  "rm-1": ["rm-1", "arjun", "sunil", "chhitranjan"],
  arjun: ["arjun"],
};
const ctx = (userId: string, role: Role): AuthContext => ({ userId, username: userId, role, groupId: userId === "rm-1" ? "team" : null });
const admin = ctx("admin", Role.SUPER_ADMIN), rm = ctx("rm-1", Role.REGIONAL_MANAGER), so = ctx("arjun", Role.SALES_OFFICER);

/* ---------------------------------- the real listRecoveryPlans, over a fake DB ---------------------------------- */
let lastWhere: { officerId?: unknown } = {};
const prisma = {
  recoveryPlan: {
    findMany: async ({ where }: { where: { officerId?: string | { in: string[] } } }) => {
      lastWhere = where;
      const o = where.officerId;
      return ALL_PLANS.filter((p) => o === undefined || (typeof o === "string" ? p.officerId === o : o.in.includes(p.officerId))).map((p) => ({
        id: p.id, officerId: p.officerId, status: p.status, lifecycleState: "ACTIVE", cutoffDate: p.cutoffDate, lastSavedAt: null, updatedAt: p.updatedAt,
        season: { name: "Kharif", year: 2026 }, seasonMonth: { name: p.monthName },
        officer: { name: p.officerName, territory: "T", group: p.groupName ? { name: p.groupName } : null },
      }));
    },
  },
};
const stub = (names: string[]) => Object.fromEntries(names.map((n) => [n, async () => ({})]));
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/scope": {
    getOfficerScope: async (c: AuthContext) => { const ids = scopeIds[c.userId]; return ids === "all" ? { all: true, ids: [] } : { all: false, ids }; },
    assertOfficerInScope: async () => {}, isPlanOwner: () => true,
  },
  "@/lib/audit": { writeAudit: async () => {} },
  "@/features/assignments/service.server": stub(["createAndAssignDealer"]),
  "@/features/cn-requests/service.server": stub(["latestCnRequestStatusByDealer"]),
  "@/features/historical-daybook/service.server": stub(["retainRegularReceipts"]),
  "@/lib/last-payment.server": stub(["latestReceiptAsOfByDealer"]),
  "@/lib/dealer-display-name.server": stub(["loadDealerAliasNameMap"]),
  "@/lib/dealer-resolver": stub(["loadDealerResolver"]),
  "@/lib/recovery-config": stub(["getRecoveryConfig"]),
  "@/features/planning/lifecycle.server": { assertLifecycleEditable: async () => {}, officerVisibilityWhere: () => ({}), isHiddenFromOfficer: () => false, isHiddenByArchivedParent: () => false },
});
const service = load<typeof import("./service.server")>("src/features/recovery/service.server.ts");
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const listFor = async (c: AuthContext, mine = false) => plain(await service.listRecoveryPlans(c, undefined, mine)) as unknown as Plan[];

/* ---------------------------------- rendered page ---------------------------------- */
let preset: Record<number, unknown> = {};
let stateCall = 0;
let servedPlans: Plan[] = [];
const pageLoad = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = stateCall++; return [i < 4 && i in preset ? preset[i] : initial, () => {}]; } }, // the page's own first four: viewSub, historyFilters, columnFilters, open
  "next/link": { __esModule: true, default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> },
  "@tanstack/react-query": { useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey.includes("scope") ? servedPlans : queryKey.includes("mine") ? servedPlans.filter((p) => p.officerId === "rm-1") : undefined, isLoading: false }) },
  "@/lib/api-client": { api: { get: async () => [] } },
  "@/components/layout/page-header": { PageHeader: () => null },
  "@/features/planning/status-badge": { StatusBadge: ({ status }: { status: string }) => <>{status}</> },
  "@/features/recovery/recovery-import-wizard": { RecoveryImportWizard: () => null },
});
const { RecoveryPlanning } = pageLoad<typeof import("./recovery-planning")>("src/features/recovery/recovery-planning.tsx");
const render = (role: Role, userId: string, mode: "create" | "view", p: Record<number, unknown> = {}) => {
  preset = p; stateCall = 0;
  servedPlans = (plain(ALL_PLANS) as Plan[]).filter((x) => { const s = scopeIds[userId]; return s === "all" || (s as string[]).includes(x.officerId); });
  return renderToStaticMarkup(<RecoveryPlanning role={role} userId={userId} mode={mode} />);
};
const headerCells = (html: string) => [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
const filterButtons = (html: string) => [...new Set([...html.matchAll(/aria-label="Filter by ([^"]+)"/g)].map((m) => m[1]))];
const openedPlans = (html: string) => [...html.matchAll(/href="\/planning\/recovery\/([^"/]+)"/g)].map((m) => m[1]).filter((id) => id !== "plans").sort(); // "plans" is the View Plans toggle

async function main() {
  const all = ALL_PLANS;
  const idsOf = (f: Parameters<typeof applyRecoveryPlanFilters>[1], keys = recoveryFilterKeys("SUPER_ADMIN")) => ids(applyRecoveryPlanFilters(all, f, keys));

  // Tests 1–3 / 10–12: Admin filters by Sales Officer, State, Month; several values in one column are OR-ed.
  assert.deepEqual(idsOf({ officer: ["arjun"] }), ["p1"]);
  assert.deepEqual(idsOf({ officer: ["arjun", "sunil"] }), ["p1", "p2", "p3"], "10: Sales Officers OR");
  assert.deepEqual(idsOf({ state: ["MP"] }), ["p4"]);
  assert.deepEqual(idsOf({ state: ["MP", "UP"] }), ["p4", "p6", "p7"], "11: States OR");
  assert.deepEqual(idsOf({ month: ["October"] }), ["p2", "p7"]);
  assert.deepEqual(idsOf({ month: ["October", "August"] }), ["p2", "p5", "p7"], "12: Months OR");
  // 13: different columns AND — (Arjun OR Sunil) AND CG AND September.
  assert.deepEqual(idsOf({ officer: ["arjun", "sunil"], state: ["CG"], month: ["September"] }), ["p1", "p3"], "13: AND across columns");
  assert.deepEqual(idsOf({ officer: ["arjun", "sunil"], state: ["MP"] }), [], "no OR across different filters");
  // 14: empty selection = All = unfiltered; 19: no filter returns every row unchanged.
  assert.deepEqual(idsOf({ officer: [] }), ids(all));
  assert.deepEqual(idsOf({}), ids(all), "19: no filter → same plans as before");
  assert.deepEqual(idsOf({ officer: ["arjun"], state: [] }), ["p1"], "clearing one column leaves the others");
  assert.deepEqual(idsOf({ state: ["CG"] }).includes("p8"), false, "a plan with no State never matches a State filter");

  // Tests 4–9: role matrix — which columns are filters.
  assert.deepEqual(recoveryFilterKeys("SUPER_ADMIN").sort(), ["month", "officer", "state"]);
  assert.deepEqual(recoveryFilterKeys("CUSTOM_ADMIN").sort(), ["month", "officer", "state"]);
  assert.deepEqual(recoveryFilterKeys("REGIONAL_MANAGER").sort(), ["month", "officer"], "5: RM has no State filter");
  assert.deepEqual(recoveryFilterKeys("SALES_OFFICER"), ["month"], "7/8: SO has no Sales Officer or State filter");
  // A filter the role cannot use is ignored even if somehow supplied.
  assert.deepEqual(ids(applyRecoveryPlanFilters(all, { state: ["MP"] }, recoveryFilterKeys("REGIONAL_MANAGER"))), ids(all), "RM state selection has no effect");
  assert.deepEqual(ids(applyRecoveryPlanFilters(all, { officer: ["sunil"], month: ["September"] }, recoveryFilterKeys("SALES_OFFICER"))), ["p1", "p3", "p4", "p6"], "SO: only Month applies");

  // Filter options come from the rows passed in (the caller's scope), calendar-ordered for months.
  assert.deepEqual(plain(recoveryFilterOptions(all, "month").map((o) => o.value)), ["July", "August", "September", "October"]);
  assert.deepEqual(plain(recoveryFilterOptions(all, "state").map((o) => o.value)), ["CG", "MP", "UP"], "plans with no State add no option");
  assert.deepEqual(plain(recoveryFilterOptions(all, "officer").find((o) => o.value === "arjun")), { value: "arjun", label: "Arjun Yadav" });

  // Tests 16–18: the existing server scope is untouched, and filtering can only narrow what each role already receives.
  const adminPlans = await listFor(admin), rmPlans = await listFor(rm), soPlans = await listFor(so);
  assert.deepEqual(ids(adminPlans), ids(all), "16: Admin scope unchanged");
  assert.equal((lastWhere.officerId as { in: string[] }).in.join(), "arjun", "SO query is still narrowed to their own officer id");
  assert.deepEqual(ids(rmPlans), ["p1", "p2", "p3", "p4", "p5"], "RM scope unchanged: own + team only");
  assert.deepEqual(ids(soPlans), ["p1"], "SO scope unchanged: own only");
  assert.equal(ids(await listFor(rm, true)).join(), "p5", "RM 'mine' unchanged");
  const rmKeys = recoveryFilterKeys("REGIONAL_MANAGER");
  for (const f of [{ officer: ["other-so"] }, { officer: ["other-rm", "sunil"] }, { month: ["September"], officer: ["other-so", "arjun"] }]) {
    const result = applyRecoveryPlanFilters(rmPlans, f, rmKeys);
    assert.ok(result.every((p) => ids(rmPlans).includes(p.id)), "17: RM filtering returns only plans already in RM scope");
    assert.ok(!result.some((p) => ["p6", "p7"].includes(p.id)), "17: another team's plans never appear");
  }
  assert.deepEqual(ids(applyRecoveryPlanFilters(rmPlans, { officer: ["other-so"] }, rmKeys)), []);
  assert.deepEqual(ids(applyRecoveryPlanFilters(soPlans, { month: ["October"] }, recoveryFilterKeys("SALES_OFFICER"))), [], "18: SO filter cannot reach other officers' plans");
  assert.deepEqual(plain(recoveryFilterOptions(rmPlans, "officer").map((o) => o.value)).sort(), ["arjun", "chhitranjan", "rm-1", "sunil"], "RM Sales Officer options only from RM scope");
  assert.ok(!recoveryFilterOptions(rmPlans, "officer").some((o) => o.value === "other-so"));
  assert.ok(!recoveryFilterOptions(soPlans, "month").some((o) => o.value === "October"), "SO month options only from their own plans");
  // The plans API accepts no filter parameters of its own, so there is nothing to manipulate server-side.
  const route = readFileSync("src/app/api/recovery/plans/route.ts", "utf8");
  assert.ok(!/salesOfficerId|officerId|state|month/i.test(route.replace(/listRecoveryPlans/g, "")), "plans route has no filter parameters");

  // Rendered tables — header filters by role (Create and View both), and navigation is unchanged.
  for (const mode of ["create", "view"] as const) {
    const status = mode === "create" ? "DRAFT" : "PENDING_ADMIN";
    for (const p of ALL_PLANS) p.status = status;
    // Admin: Month, Sales Officer, State filters; column order unchanged.
    let html = render(Role.SUPER_ADMIN, "admin", mode);
    assert.deepEqual(filterButtons(html), ["Month", "Sales Officer", "State"], `1–3 (${mode})`);
    assert.deepEqual(headerCells(html).map((c) => c.replace(/<[^>]*>/g, "").trim()), ["Season", "Month", "Sales Officer", "State", "Territory", "Cutoff", "Status", "Open"]);
    assert.deepEqual(openedPlans(html), ids(ALL_PLANS), "20/19: every plan is listed and opens its own page");
    // RM: Month + Sales Officer filter; State is a plain header.
    html = render(Role.REGIONAL_MANAGER, "rm-1", mode);
    assert.deepEqual(filterButtons(html), ["Month", "Sales Officer"], "4–6");
    assert.ok(/<th[^>]*>State<\/th>/.test(html), "RM State is a normal non-clickable header");
    // SO: Month filter only; no Sales Officer column at all (existing behaviour).
    html = render(Role.SALES_OFFICER, "arjun", mode);
    assert.deepEqual(filterButtons(html), ["Month"], "7–9");
    assert.ok(/<th[^>]*>State<\/th>/.test(html) && !html.includes("Sales Officer"));
    assert.deepEqual(openedPlans(html), ["p1"], "18: SO sees only their own plan");
  }
  for (const p of ALL_PLANS) p.status = "DRAFT";

  // Active filters narrow the rendered rows and show their count in the header; clearing restores everything.
  let html = render(Role.SUPER_ADMIN, "admin", "create", { 2: { officer: ["arjun", "sunil"], state: ["CG"], month: ["September"] } });
  assert.deepEqual(openedPlans(html), ["p1", "p3"], "13 (rendered)");
  assert.ok(html.includes("Month (1)") && html.includes("Sales Officer (2)") && html.includes("State (1)"), "active filters show their count");
  assert.ok(html.includes("text-primary"), "an active filter is highlighted");
  html = render(Role.SUPER_ADMIN, "admin", "create", { 2: { officer: [], month: [] } });
  assert.deepEqual(openedPlans(html), ids(ALL_PLANS), "14: All restores the unfiltered table");
  assert.ok(!html.includes("Month (") && !html.includes("Sales Officer ("));
  // 15: the existing History "+ Add Filter" keeps working together with the new column filters.
  for (const p of ALL_PLANS) { p.status = "APPROVED"; p.lifecycleState = "CLOSED"; }
  servedPlans = [];
  html = render(Role.SUPER_ADMIN, "admin", "view", { 0: "HISTORY", 1: { officer: ["sunil", "chhitranjan"] }, 2: { month: ["September"] } });
  assert.deepEqual(openedPlans(html), ["p3", "p4"], "15: History filter AND column filter");
  // Plan opening links are unchanged.
  assert.ok(html.includes('href="/planning/recovery/p3"') && html.includes('href="/planning/recovery/p4"'));

  console.log("recovery-plan-filters.test.tsx — all assertions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
