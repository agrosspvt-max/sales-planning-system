/** Last Payment Report: reuse of the Recovery Last Payment source, Days, sorting, scope, sidebar and rendered page. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import * as realDailyWork from "@/lib/daily-work";
import type { AuthContext } from "@/lib/http";
import { TestApiError, testLoader } from "@/features/dealer-tags/test-loader";
import { navForRole } from "@/features/navigation/nav";
import { resolveNavState } from "@/features/navigation/nav-state";
import {
  DAYBOOK_UPLOAD_AUDIT_ENTITY, DAYBOOK_UPLOAD_AUDIT_PREFIX, applyFilterStep, formatLastUpdate, applyPaymentAging, applyReportFilters, buildPaymentAging, cascadedFilterOptions, pruneReportFilters, reportFilterOptions, sameReportFilters, type ReportFilterable, calendarDaysBetween, daysSincePayment, matchesPaymentAging, parseAgingDays, parseLastPaymentReportParams,
  parsePaymentAging, paymentAgingLabel, paymentAgingToParams, sortByDays, type PaymentAgingFilter,
} from "@/lib/last-payment-report";
import { lastPaymentMonthEnd } from "@/lib/last-payment";

const TODAY = "2026-10-05";

/* ---------------------------------- fixture: master data + Day Book receipts ---------------------------------- */
const officers: Record<string, { name: string; territory: string; group: string }> = {
  arjun: { name: "Arjun Yadav", territory: "BHOPAL", group: "MP" }, sunil: { name: "Sunil", territory: "RAIPUR", group: "CG" },
  chhitranjan: { name: "Chhitranjan", territory: "INDORE", group: "MP" }, "rm-1": { name: "RM One", territory: "HQ", group: "MP" },
  rahul: { name: "Rahul Patidar", territory: "LUCKNOW", group: "UP" },
};
// dealerId → open assignments (the LAST entry is the most recent = the CURRENT owner, as resolveCurrentOwner decides).
const openAssignments: Record<string, string[]> = {
  "d-a": ["arjun"], "d-b": ["sunil"], "d-c": ["chhitranjan"], "d-d": ["rahul"], "d-e": ["rm-1"], "d-h": ["arjun", "rahul"], "d-i": ["arjun"],
};
const dealers = [
  // `status` = the existing Dealer.status (the report's dataset keeps its existing isActive gate, so INACTIVE dealers stay out).
  { id: "d-a", name: "Alpha Traders", isActive: true, status: "ACTIVE" }, { id: "d-b", name: "Beta Stores", isActive: true, status: "ACTIVE" },
  { id: "d-c", name: "Gamma Agro", isActive: true, status: "DEFAULTER" }, { id: "d-d", name: "Delta Outside", isActive: true, status: "ACTIVE" },
  { id: "d-e", name: "Epsilon RM Dealer", isActive: true, status: "PENDING" }, { id: "d-f", name: "Zeta Unassigned", isActive: true, status: "ACTIVE" },
  { id: "d-h", name: "Eta Reassigned", isActive: true, status: "ACTIVE" }, { id: "d-i", name: "Iota Inactive", isActive: false, status: "INACTIVE" },
];
// Legacy per-plan snapshot (RecoveryPlanDealer.lastReceipt*) and the individual receipt history (LastPaymentReceipt).
const legacy = [
  { dealerId: "d-a", date: "2026-09-25", amount: "25000" },
  { dealerId: "d-a", date: "2026-10-02", amount: "50000" }, // the stored per-plan summary of the SAME 10-02 receipts below — must not be added again
];
const history = [
  { dealerId: "d-a", date: "2026-10-02", amount: 30000, active: true },  // two receipts on the newest date → summed (₹50,000)
  { dealerId: "d-a", date: "2026-10-02", amount: 20000, active: true },
  { dealerId: "d-a", date: "2026-09-10", amount: 10000, active: true },
  { dealerId: "d-b", date: "2026-10-05", amount: 7000, active: true },   // paid today → Days 0
  { dealerId: "d-b", date: "2026-10-20", amount: 8000, active: true },   // after today → ignored by the existing selector
  { dealerId: "d-c", date: "2026-09-15", amount: 3000, active: true },
  { dealerId: "d-c", date: "2026-09-01", amount: 100000, active: true }, // an OLDER, larger payment never wins or adds
  { dealerId: "d-c", date: "2026-10-04", amount: 999, active: false },   // belongs to an inactive import → ignored
  { dealerId: "d-d", date: "2026-10-01", amount: 4000, active: true },
  { dealerId: "d-d", date: "2026-10-01", amount: 5000, active: true },   // same-day pair → ₹9,000
];
const scopeIds: Record<string, string[] | "all"> = { admin: "all", "rm-1": ["rm-1", "arjun", "sunil", "chhitranjan"], arjun: ["arjun"] };
const ctx = (userId: string, role: Role): AuthContext => ({ userId, username: userId, role, groupId: userId === "rm-1" ? "team" : null });
const admin = ctx("admin", Role.SUPER_ADMIN), rm = ctx("rm-1", Role.REGIONAL_MANAGER), so = ctx("arjun", Role.SALES_OFFICER);
const currentOwner = (dealerId: string) => openAssignments[dealerId]?.at(-1);

// Day Book upload records the "Last Update" indicator reads. The fake exposes ONLY find* — any write would throw.
let audits: { entity: string; summary: string | null; createdAt: Date }[] = [];
let imports: { createdAt: Date }[] = [];
const newest = <T extends { createdAt: Date }>(rows: T[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
let queries = { legacy: 0, history: 0, dealers: 0 };
let lookedUp: string[] = []; // the dealer ids the (single) Last Payment lookup was asked about
const prisma = {
  dealer: {
    findMany: async ({ where }: { where: { isActive?: boolean; assignments?: { some: { officerId: { in: string[] } } } } }) => {
      queries.dealers++;
      const ids = where.assignments?.some.officerId.in;
      return dealers.filter((d) => (where.isActive === undefined || d.isActive === where.isActive) && (!ids || (openAssignments[d.id] ?? []).some((o) => ids.includes(o))));
    },
  },
  user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id in officers).map((id) => ({ id, name: officers[id].name, territory: officers[id].territory, group: { name: officers[id].group } })) },
  // `loadLastPaymentPoints` calls these tagged-template / findMany APIs — the REAL helper runs against this fake.
  $queryRaw: async (_strings: unknown, dealerIds: string[]) => { queries.legacy++; lookedUp = dealerIds; return legacy.filter((r) => dealerIds.includes(r.dealerId)); },
  auditLog: {
    findFirst: async ({ where }: { where: { entity: string; summary: { startsWith: string } } }) =>
      newest(audits.filter((a) => a.entity === where.entity && (a.summary ?? "").startsWith(where.summary.startsWith))),
  },
  lastPaymentImport: { findFirst: async () => newest(imports) },
  lastPaymentReceipt: {
    findMany: async ({ where }: { where: { dealerId: { in: string[] }; receiptDate: { lte: Date } } }) => {
      queries.history++;
      return history.filter((r) => r.active && where.dealerId.in.includes(r.dealerId) && r.date <= where.receiptDate.lte.toISOString().slice(0, 10))
        .map((r) => ({ dealerId: r.dealerId, receiptDate: new Date(`${r.date}T00:00:00.000Z`), creditAmount: r.amount }));
    },
  },
};
let exportCtx: AuthContext = admin0();
function admin0(): AuthContext { return { userId: "admin", username: "admin", role: Role.SUPER_ADMIN, groupId: null } as AuthContext; }
// Minimal NextResponse so the REAL export route handler can run: it records status, headers and (JSON | binary) body.
class FakeNextResponse { constructor(public body: unknown, public init: { status?: number; headers?: Record<string, string> } = {}) {} get status() { return this.init.status ?? 200; } static json(body: unknown, init: { status?: number } = {}) { return new FakeNextResponse(body, init); } }
const overrides = {
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError, requireAuth: async () => exportCtx },
  "next/server": { NextResponse: FakeNextResponse },
  // The export route has no `today` argument, so pin the business date to the fixture's TODAY (a Date argument still converts normally).
  "@/lib/daily-work": { ...realDailyWork, currentBusinessDate: (d?: Date) => (d ? realDailyWork.currentBusinessDate(d) : TODAY) },
  "@/lib/scope": {
    getOfficerScope: async (c: AuthContext) => { const ids = scopeIds[c.userId]; return ids === "all" ? { all: true, ids: [] } : { all: false, ids }; },
    getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.filter((id) => currentOwner(id)).map((id) => [id, currentOwner(id)!])),
  },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map([["d-b", "Beta Alias"]]) }, // display name = alias ?? name
};
const load = testLoader(overrides);
const report = load<typeof import("./last-payment-report.server")>("src/features/reports/last-payment-report.server.ts");
const recoverySource = load<typeof import("@/lib/last-payment.server")>("src/lib/last-payment.server.ts"); // the exact helper Recovery Planning calls
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const params = (over: Partial<ReturnType<typeof parseLastPaymentReportParams>> = {}) => ({ ...parseLastPaymentReportParams(new URLSearchParams()), pageSize: 200, ...over });
const run = async (c: AuthContext, over = {}) => plain(await report.getLastPaymentReport(c, params(over), TODAY));
const ids = (rows: { dealerId: string }[]) => rows.map((r) => r.dealerId).sort();

async function service() {
  const adminReport = await run(admin);
  const byId = Object.fromEntries(adminReport.items.map((r) => [r.dealerId, r]));

  // 3, 16 — dealer information comes from the authoritative sources: dealer (alias-preferred name) + CURRENT owner.
  assert.deepEqual(plain(byId["d-a"]), { dealerId: "d-a", party: "Alpha Traders", status: "ACTIVE", state: "MP", territory: "BHOPAL", salesOfficer: "Arjun Yadav", lastPaymentDate: "2026-10-02", amount: 50000, days: 3 });
  assert.equal(byId["d-b"].party, "Beta Alias", "alias-preferred display name");
  assert.deepEqual([byId["d-c"].state, byId["d-c"].territory, byId["d-c"].salesOfficer], ["MP", "INDORE", "Chhitranjan"]);
  assert.deepEqual([byId["d-h"].salesOfficer, byId["d-h"].state], ["Rahul Patidar", "UP"], "a reassigned dealer reports its CURRENT owner");

  // 4, 5, 19 — date and amount are exactly what the Recovery helper returns (same helper, same rules).
  const recoveryValues = await recoverySource.latestReceiptAsOfByDealer(dealers.map((d) => d.id), new Date(`${TODAY}T00:00:00.000Z`));
  for (const row of adminReport.items) {
    const expected = recoveryValues.get(row.dealerId);
    assert.equal(row.lastPaymentDate, expected?.date ?? null, `${row.dealerId}: date matches Recovery's source`);
    assert.equal(row.amount, expected ? expected.amount : null, `${row.dealerId}: amount comes from the SAME receipt row`);
  }
  assert.equal(byId["d-a"].lastPaymentDate, "2026-10-02", "newest eligible receipt wins over the older legacy snapshot");
  // Same-day aggregation: the latest date's receipts are summed; the stored summary and older dates are not added.
  assert.equal(byId["d-a"].amount, 50000, "₹30,000 + ₹20,000 (not 100,000: the stored summary of the same receipts is not added)");
  assert.equal(byId["d-d"].amount, 9000, "₹4,000 + ₹5,000");
  assert.equal(byId["d-b"].amount, 7000, "a single receipt is unchanged");
  assert.equal(byId["d-c"].amount, 3000, "the latest date wins even though an older payment is larger");
  assert.equal(byId["d-a"].days, 3, "the amount does not affect Days");
  assert.equal(byId["d-b"].lastPaymentDate, "2026-10-05", "a receipt after today is ignored (existing as-of rule)");
  assert.equal(byId["d-c"].lastPaymentDate, "2026-09-15", "receipts of an inactive import are ignored (existing rule)");
  // Recovery asks the same helper "as of the plan month-end"; the earlier as-of date selects the legacy snapshot, not a conflict.
  const septEnd = lastPaymentMonthEnd({ calendarMonth: 9, calendarYear: 2026 } as never)!;
  assert.equal((await recoverySource.latestReceiptAsOfByDealer(["d-a"], septEnd)).get("d-a")?.date, "2026-09-25");
  const octEnd = lastPaymentMonthEnd({ calendarMonth: 10, calendarYear: 2026 } as never)!;
  assert.deepEqual(
    plain((await recoverySource.latestReceiptAsOfByDealer(["d-a"], octEnd)).get("d-a")),
    { date: byId["d-a"].lastPaymentDate, amount: byId["d-a"].amount },
    "Recovery Planning and the report return identical Date + Amount (₹50,000)",
  );
  assert.equal((await recoverySource.latestReceiptAsOfByDealer(["d-a"], septEnd)).get("d-a")?.amount, 25000, "an earlier month-end still shows its own (single snapshot) value");

  // 6, 7, 8 — Days is calendar-date arithmetic; dealers with no payment get null, never a fake number.
  assert.deepEqual([byId["d-a"].days, byId["d-b"].days, byId["d-c"].days, byId["d-d"].days], [3, 0, 20, 4]);
  assert.equal(byId["d-e"].lastPaymentDate, null); assert.equal(byId["d-e"].amount, null); assert.equal(byId["d-e"].days, null);
  assert.equal(calendarDaysBetween("2026-10-02", "2026-10-05"), 3);
  assert.equal(calendarDaysBetween("2026-09-25", "2026-10-05"), 10);
  assert.equal(calendarDaysBetween("2026-02-28", "2026-03-01"), 1, "month boundary");
  assert.equal(calendarDaysBetween("2024-02-28", "2024-03-01"), 2, "leap day");
  assert.equal(daysSincePayment(null, TODAY), null);
  // Today advancing changes Days without anything stored.
  const later = plain(await report.getLastPaymentReport(admin, params(), "2026-10-10")).items.find((r) => r.dealerId === "d-a")!;
  assert.equal(later.days, 8);

  // 9, 10, 11 — numeric sorting; payment-less dealers stay together at the end for BOTH directions.
  const desc = (await run(admin, { sort: "days_desc" })).items, asc = (await run(admin, { sort: "days_asc" })).items;
  assert.deepEqual(desc.filter((r) => r.days !== null).map((r) => r.days), [20, 4, 3, 0]);
  assert.deepEqual(asc.filter((r) => r.days !== null).map((r) => r.days), [0, 3, 4, 20]);
  for (const list of [asc, desc]) {
    const firstEmpty = list.findIndex((r) => r.days === null);
    assert.ok(list.slice(firstEmpty).every((r) => r.days === null), "no-payment dealers are contiguous at the end");
    assert.equal(list.length - firstEmpty, 3);
  }
  const numeric = sortByDays([{ days: 10, party: "a", dealerId: "1" }, { days: 9, party: "b", dealerId: "2" }, { days: 2, party: "c", dealerId: "3" }, { days: 100, party: "d", dealerId: "4" }, { days: null, party: "e", dealerId: "5" }], "days_asc");
  assert.deepEqual(numeric.map((r) => r.days), [2, 9, 10, 100, null], "10 sorts after 9 (numeric, not lexicographic)");

  // 12–14 — scope: the existing officer scope, enforced by the query and on each dealer's current owner.
  assert.deepEqual(ids(adminReport.items), ["d-a", "d-b", "d-c", "d-d", "d-e", "d-f", "d-h"], "Admin: every active dealer (inactive excluded)");
  assert.deepEqual(ids((await run(rm)).items), ["d-a", "d-b", "d-c", "d-e"], "RM: own + team dealers only; the reassigned dealer's current owner is out of scope");
  assert.deepEqual(ids((await run(so)).items), ["d-a"], "Sales Officer: own dealers only");
  // 15 — scope cannot be widened through parameters.
  const hostile = parseLastPaymentReportParams(new URLSearchParams("officerId=rahul&scope=all&dealerId=d-d&search=&sort=days_asc"));
  assert.deepEqual(Object.keys(hostile).sort(), ["filters", "page", "pageSize", "paymentAging", "search", "sort"], "only search/sort/page/pageSize/filters/paymentAging exist");
  assert.deepEqual(plain(hostile.filters), {}, "officerId/scope/dealerId are not filter parameters and are ignored");
  assert.deepEqual(ids(plain(await report.getLastPaymentReport(rm, hostile, TODAY)).items), ["d-a", "d-b", "d-c", "d-e"]);
  assert.deepEqual(ids(plain(await report.getLastPaymentReport(so, hostile, TODAY)).items), ["d-a"]);
  assert.deepEqual(ids((await run(rm, { search: "Delta" })).items), [], "searching for an out-of-scope party finds nothing");
  assert.equal(report.getLastPaymentReport.length, 2, "the service takes only (ctx, params): no officer/scope argument exists");

  // 13 — search (alias-aware) works together with sorting and scope.
  assert.deepEqual(ids((await run(admin, { search: "beta alias" })).items), ["d-b"]);
  assert.deepEqual((await run(admin, { search: "a", sort: "days_asc" })).items.filter((r) => r.days !== null).map((r) => r.days), [0, 3, 4, 20], "search and Days sorting combine");
  assert.deepEqual((await run(admin, { search: "ALPHA" })).items.map((r) => r.dealerId), ["d-a"], "case-insensitive");
  assert.deepEqual((await run(admin, { search: "" })).items.length, 7);
  // paging is server-side
  const paged = await run(admin, { pageSize: 3, page: 2, sort: "days_asc" });
  assert.deepEqual([paged.page, paged.totalPages, paged.total, paged.items.length], [2, 3, 7, 3]);

  // Performance: one batched receipt lookup however many dealers, never per dealer.
  queries = { legacy: 0, history: 0, dealers: 0 };
  await run(admin);
  assert.deepEqual(queries, { legacy: 1, history: 1, dealers: 1 }, "no N+1: one dealers query, one legacy lookup, one history lookup");
}

/* ---------------------------------- column filters ---------------------------------- */
async function filters() {
  const ALL = ["d-a", "d-b", "d-c", "d-e", "d-f", "d-h"].concat(["d-d"]).sort();
  const f = async (c: AuthContext, filter: Record<string, string[]>, over = {}) => run(c, { filters: filter, ...over });
  const unfiltered = await run(admin);
  const rowsOf = (r: { items: { dealerId: string }[] }) => ids(r.items);
  assert.deepEqual(rowsOf(unfiltered), ALL.filter((x) => x !== "d-i"), "baseline: Admin scope");

  // 5–8, 9 — each filter supports several selections, OR-ed within the column.
  assert.deepEqual(rowsOf(await f(admin, { party: ["d-a", "d-b"] })), ["d-a", "d-b"], "Party OR");
  assert.deepEqual(rowsOf(await f(admin, { state: ["MP"] })), ["d-a", "d-c", "d-e"]);
  assert.deepEqual(rowsOf(await f(admin, { state: ["MP", "CG"] })), ["d-a", "d-b", "d-c", "d-e"], "State OR");
  assert.deepEqual(rowsOf(await f(admin, { territory: ["BHOPAL", "RAIPUR"] })), ["d-a", "d-b"], "Territory OR");
  assert.deepEqual(rowsOf(await f(admin, { officer: ["arjun", "sunil"] })), ["d-a", "d-b"], "Sales Officer OR");
  // 10 — different filters AND together.
  assert.deepEqual(rowsOf(await f(admin, { state: ["MP", "CG"], officer: ["arjun", "sunil"] })), ["d-a", "d-b"]);
  // Cascading: arjun is an MP officer, so under State = CG his selection is incompatible and is cleared (the table is not left empty).
  assert.deepEqual(rowsOf(await f(admin, { state: ["CG"], officer: ["arjun"] })), ["d-b"], "State = CG: the incompatible officer is dropped, CG dealers remain");
  assert.deepEqual(rowsOf(await f(admin, { state: ["MP"], territory: ["INDORE"], officer: ["arjun"] })), ["d-c"], "MP + INDORE: arjun (BHOPAL) does not fit and is cleared → INDORE dealers");
  assert.deepEqual(rowsOf(await f(admin, { party: ["d-a", "d-b", "d-c"], state: ["MP"], territory: ["BHOPAL", "INDORE"], officer: ["arjun", "chhitranjan"] })), ["d-a", "d-c"], "all four combine");
  // 11 — clearing restores the unfiltered state.
  assert.deepEqual(rowsOf(await f(admin, { state: [], officer: [] })), rowsOf(unfiltered));
  assert.deepEqual(rowsOf(await f(admin, { state: ["MP"], officer: [] })), ["d-a", "d-c", "d-e"], "clearing one leaves the others");
  // a dealer lacking the column value never matches an active filter on it
  assert.ok(!rowsOf(await f(admin, { state: ["MP", "CG", "UP"] })).includes("d-f"));

  // 12, 13 — search keeps working and combines with the filters.
  assert.deepEqual(rowsOf(await run(admin, { search: "agro" })), ["d-c"]);
  assert.deepEqual(rowsOf(await f(admin, { state: ["MP"] }, { search: "agro" })), ["d-c"], "search AND state");
  assert.deepEqual(rowsOf(await f(admin, { state: ["CG"] }, { search: "agro" })), [], "search AND a non-matching state");
  assert.deepEqual(rowsOf(await f(admin, { officer: ["sunil"] }, { search: "beta alias" })), ["d-b"]);

  // 14, 15 — filters with Days ascending / descending (payment-less dealers stay last).
  const mpAsc = (await f(admin, { state: ["MP"] }, { sort: "days_asc" })).items, mpDesc = (await f(admin, { state: ["MP"] }, { sort: "days_desc" })).items;
  assert.deepEqual(mpAsc.map((r) => r.dealerId), ["d-a", "d-c", "d-e"]);
  assert.deepEqual(mpAsc.map((r) => r.days), [3, 20, null]);
  assert.deepEqual(mpDesc.map((r) => r.dealerId), ["d-c", "d-a", "d-e"]);
  assert.deepEqual(mpDesc.map((r) => r.days), [20, 3, null]);

  // 22, 23 — Last Payment values are untouched by filtering: each filtered row equals its unfiltered row.
  const before = Object.fromEntries(unfiltered.items.map((r) => [r.dealerId, r]));
  for (const row of (await f(admin, { state: ["MP", "CG"] })).items) assert.deepEqual(plain(row), plain(before[row.dealerId]), `${row.dealerId}: unchanged`);
  // The Last Payment lookup is still ONE batched call, and now only for the dealers that survive scope + search + filters.
  queries = { legacy: 0, history: 0, dealers: 0 };
  await f(admin, { state: ["CG"] });
  assert.deepEqual(queries, { legacy: 1, history: 1, dealers: 1 });
  assert.deepEqual([...lookedUp].sort(), ["d-b"], "receipts are only looked up for the filtered dealers");

  // 18 — options are built from the caller's scoped dataset only.
  const values = (o: { value: string }[]) => o.map((x) => x.value).sort();
  const adminOpts = unfiltered.options;
  assert.deepEqual(values(adminOpts.officer), ["arjun", "chhitranjan", "rahul", "rm-1", "sunil"]);
  assert.deepEqual(values(adminOpts.state), ["CG", "MP", "UP"]);
  assert.deepEqual(values(adminOpts.territory), ["BHOPAL", "HQ", "INDORE", "LUCKNOW", "RAIPUR"]);
  assert.deepEqual(values(adminOpts.party), ["d-a", "d-b", "d-c", "d-d", "d-e", "d-f", "d-h"], "Admin Party options: every dealer in scope, including those with no officer");
  assert.equal(adminOpts.party.find((p) => p.value === "d-b")?.label, "Beta Alias", "Party options use the displayed name");
  const rmOpts = (await run(rm)).options;
  assert.deepEqual(values(rmOpts.officer), ["arjun", "chhitranjan", "rm-1", "sunil"], "RM options: no officer outside RM scope");
  assert.deepEqual(values(rmOpts.state), ["CG", "MP"]);
  assert.deepEqual(values(rmOpts.territory), ["BHOPAL", "HQ", "INDORE", "RAIPUR"]);
  assert.deepEqual(values(rmOpts.party), ["d-a", "d-b", "d-c", "d-e"], "RM Party options: only RM-scope dealers (not the reassigned or other-team ones)");
  assert.deepEqual(plain((await f(rm, {}, { search: "agro" })).options), plain(rmOpts), "search text does not shape the options (only the other column filters do)");
  assert.deepEqual(plain((await f(rm, { state: ["MP"] }, { search: "agro" })).options), plain((await f(rm, { state: ["MP"] })).options), "…and neither does search under an active filter");
  const soOpts = (await run(so)).options;
  assert.deepEqual([values(soOpts.party), values(soOpts.officer), values(soOpts.state)], [["d-a"], ["arjun"], ["MP"]], "SO options: only their own");

  // 19, 20, 21 — manipulated filter parameters can never reach outside the existing scope.
  const hostileFilters: Record<string, string[]>[] = [{ officer: ["rahul"] }, { party: ["d-d"] }, { state: ["UP"] }, { territory: ["LUCKNOW"] }, { party: ["d-h"] }];
  for (const hostile of hostileFilters) {
    assert.deepEqual(rowsOf(await f(rm, hostile)), [], `RM ${JSON.stringify(hostile)} returns nothing`);
  }
  assert.deepEqual(rowsOf(await f(rm, { party: ["d-a", "d-d"], officer: ["arjun", "rahul"] })), ["d-a"], "mixed in/out of scope → only in-scope");
  assert.deepEqual(rowsOf(await f(rm, { state: ["MP", "UP"] })), ["d-a", "d-c", "d-e"]);
  assert.deepEqual(rowsOf(await f(so, { party: ["d-a", "d-b", "d-d"] })), ["d-a"], "Sales Officer cannot widen to others' dealers");
  assert.deepEqual(rowsOf(await f(so, { officer: ["sunil"] })), []);
  assert.deepEqual(rowsOf(await f(admin, {})), rowsOf(unfiltered), "21: Admin keeps the existing scope");

  // Parameter parsing: repeated params, de-duplicated, only the four filter keys.
  const parsed = parseLastPaymentReportParams(new URLSearchParams("state=CG&state=MP&state=CG&officer=sunil&party=&bogus=1&sort=days_asc&search=x"));
  assert.deepEqual(plain(parsed.filters), { state: ["CG", "MP"], officer: ["sunil"] });
  assert.deepEqual([parsed.sort, parsed.search], ["days_asc", "x"]);
}

/* ---------------------------------- Payment Aging filter ---------------------------------- */
async function paymentAging() {
  const gt = (value: number): PaymentAgingFilter => ({ operator: "gt", value });
  const a = async (c: AuthContext, paymentAging: PaymentAgingFilter | null, over: Record<string, unknown> = {}) => run(c, { paymentAging, ...over });
  const rowsOf = (r: { items: { dealerId: string }[] }) => ids(r.items);
  const ordered = (r: { items: { dealerId: string }[] }) => r.items.map((x) => x.dealerId);
  const unfiltered = await run(admin);
  // Admin Days: d-b 0, d-a 3, d-d 4, d-c 20; d-e / d-f / d-h have no payment (null).

  // 1–4, 5 — operators (numeric), boundaries inclusive for Between.
  assert.deepEqual(rowsOf(await a(admin, { operator: "lt", value: 4 })), ["d-a", "d-b"], "Days < 4");
  assert.deepEqual(rowsOf(await a(admin, gt(3))), ["d-c", "d-d"], "Days > 3");
  assert.deepEqual(rowsOf(await a(admin, { operator: "eq", value: 4 })), ["d-d"], "Days = 4");
  assert.deepEqual(rowsOf(await a(admin, { operator: "between", from: 3, to: 4 })), ["d-a", "d-d"], "3 <= Days <= 4 (both ends included)");
  assert.deepEqual(rowsOf(await a(admin, { operator: "between", from: 4, to: 4 })), ["d-d"], "From = To is a valid single value");
  assert.deepEqual(rowsOf(await a(admin, { operator: "between", from: 5, to: 19 })), [], "nothing between 5 and 19");
  assert.deepEqual(rowsOf(await a(admin, { operator: "between", from: 0, to: 20 })), ["d-a", "d-b", "d-c", "d-d"], "0 and 20 are inclusive");
  // numeric, not lexicographic: "20" > "3" numerically though "20" < "3" as text
  assert.deepEqual(rowsOf(await a(admin, gt(3))).includes("d-c"), true);
  assert.equal(matchesPaymentAging(100, { operator: "gt", value: 45 }), true);
  assert.equal(matchesPaymentAging(9, { operator: "lt", value: 10 }), true, "9 < 10 numerically");
  assert.equal(matchesPaymentAging(45, gt(45)), false); assert.equal(matchesPaymentAging(46, gt(45)), true);
  assert.equal(matchesPaymentAging(45, { operator: "lt", value: 45 }), false); assert.equal(matchesPaymentAging(44, { operator: "lt", value: 45 }), true);

  // 8 — a dealer with no payment never matches (never treated as 0), whichever operator.
  for (const filter of [{ operator: "lt", value: 100 }, gt(0), { operator: "eq", value: 0 }, { operator: "between", from: 0, to: 1000 }] as PaymentAgingFilter[]) {
    const got = rowsOf(await a(admin, filter));
    assert.ok(!["d-e", "d-f", "d-h"].includes(got.find((x) => ["d-e", "d-f", "d-h"].includes(x)) ?? ""), `no-payment dealers excluded: ${JSON.stringify(filter)}`);
  }
  assert.deepEqual(rowsOf(await a(admin, { operator: "eq", value: 0 })), ["d-b"], "Days = 0 is only the dealer who paid today");
  assert.deepEqual(rowsOf(await a(admin, { operator: "lt", value: 1 })), ["d-b"], "null is not 0");
  assert.equal(matchesPaymentAging(null, { operator: "lt", value: 99999 }), false);
  assert.equal(matchesPaymentAging(null, null), true, "no filter keeps everyone");

  // 9, 10, 11, 12 — Days sorting is independent: filter + asc / desc, and neither resets the other.
  const f3 = gt(0);
  assert.deepEqual(ordered(await a(admin, f3, { sort: "days_desc" })), ["d-c", "d-d", "d-a"], "filtered + descending");
  assert.deepEqual(ordered(await a(admin, f3, { sort: "days_asc" })), ["d-a", "d-d", "d-c"], "filtered + ascending");
  assert.deepEqual(ordered(await a(admin, null, { sort: "days_desc" })).slice(0, 4), ["d-c", "d-d", "d-a", "d-b"], "sort alone unchanged");
  // 13–17 — combined with Party / State / Territory / Sales Officer / search (AND).
  assert.deepEqual(rowsOf(await a(admin, gt(3), { filters: { party: ["d-a", "d-c"] } })), ["d-c"], "Aging + Party");
  assert.deepEqual(rowsOf(await a(admin, gt(3), { filters: { state: ["MP"] } })), ["d-c"], "Aging + State");
  assert.deepEqual(rowsOf(await a(admin, gt(3), { filters: { state: ["UP"] } })), ["d-d"]);
  assert.deepEqual(rowsOf(await a(admin, gt(3), { filters: { territory: ["INDORE", "BHOPAL"] } })), ["d-c"], "Aging + Territory");
  assert.deepEqual(rowsOf(await a(admin, gt(3), { filters: { officer: ["rahul"] } })), ["d-d"], "Aging + Sales Officer");
  assert.deepEqual(rowsOf(await a(admin, gt(3), { search: "agro" })), ["d-c"], "Aging + search");
  assert.deepEqual(rowsOf(await a(admin, gt(3), { search: "alpha" })), [], "search matches but Days does not");
  assert.deepEqual(rowsOf(await a(admin, gt(3), { search: "agro", filters: { state: ["CG"] } })), [], "search AND state AND aging");
  // 18, 19 — AND across filter types, OR inside each.
  const f = { state: ["MP", "UP"], officer: ["chhitranjan", "rahul"] };
  assert.deepEqual(ordered(await a(admin, gt(3), { filters: f, sort: "days_desc" })), ["d-c", "d-d"], "Example F: (Days>3) AND (MP OR UP) AND (Chhitranjan OR Rahul), Days descending");
  assert.deepEqual(rowsOf(await a(admin, gt(3), { filters: { state: ["MP", "CG"], officer: ["arjun", "sunil"] } })), [], "Days>3 excludes both (3 and 0); never OR-ed with the other filters");
  assert.deepEqual(rowsOf(await a(admin, { operator: "lt", value: 4 }, { filters: { state: ["MP", "CG"], officer: ["arjun", "sunil"] } })), ["d-a", "d-b"], "OR within State and Officer");
  // 20 — scope can never be widened through the aging parameters.
  assert.deepEqual(rowsOf(await a(rm, gt(0))), ["d-a", "d-c"], "RM sees only in-scope dealers with Days > 0");
  assert.ok(!rowsOf(await a(rm, { operator: "between", from: 0, to: 99999 })).includes("d-d"), "d-d (Days 4) belongs to another team and stays out of RM's results");
  assert.deepEqual(rowsOf(await a(so, { operator: "between", from: 0, to: 99999 })), ["d-a"]);
  const hostile = parseLastPaymentReportParams(new URLSearchParams("paymentAgingOperator=between&paymentAgingFrom=0&paymentAgingTo=99999&officerId=rahul&scope=all&dealerId=d-d"));
  assert.deepEqual(ids(plain(await report.getLastPaymentReport(rm, hostile, TODAY)).items), ["d-a", "d-b", "d-c"], "hostile URL parameters on the API");
  assert.deepEqual(ids(plain(await report.getLastPaymentReport(so, hostile, TODAY)).items), ["d-a"]);
  // 21 — clearing restores the unfiltered result.
  assert.deepEqual(plain((await a(admin, null)).items), plain(unfiltered.items));
  assert.deepEqual(rowsOf(await run(admin, { paymentAging: parsePaymentAging(new URLSearchParams("")) })), rowsOf(unfiltered));
  // 24 — Last Payment values are untouched: each filtered row equals its unfiltered row.
  const before = Object.fromEntries(unfiltered.items.map((r) => [r.dealerId, r]));
  for (const row of (await a(admin, gt(0))).items) assert.deepEqual(plain(row), plain(before[row.dealerId]), `${row.dealerId}: unchanged`);
  // options are not narrowed by Payment Aging (they describe the scoped dataset)
  assert.deepEqual(plain((await a(admin, gt(3))).options), plain(unfiltered.options));
  // Performance: still ONE batched lookup, no per-dealer query.
  queries = { legacy: 0, history: 0, dealers: 0 };
  await a(admin, gt(3), { filters: { state: ["MP"] } });
  assert.deepEqual(queries, { legacy: 1, history: 1, dealers: 1 });

  // 6, 7 — validation of the form text.
  const draft = (operator: "lt" | "gt" | "eq" | "between", value = "", from = "", to = "") => buildPaymentAging({ operator, value, from, to });
  assert.deepEqual(plain(draft("gt", " 45 ")), { filter: { operator: "gt", value: 45 } }, "trimmed, numeric");
  assert.deepEqual(plain(draft("between", "", "30", "60")), { filter: { operator: "between", from: 30, to: 60 } });
  for (const bad of ["", "   ", "abc", "-1", "4.5", "1e3", "12a", "0x10", "+5", "9999999"]) {
    assert.ok("error" in draft("gt", bad), `rejected single value ${JSON.stringify(bad)}`);
    assert.ok("error" in draft("between", "", bad, "10") && "error" in draft("between", "", "1", bad), `rejected Between value ${JSON.stringify(bad)}`);
  }
  assert.equal(parseAgingDays("0"), 0, "0 is a valid number of days");
  const reversed = draft("between", "", "60", "30");
  assert.ok("error" in reversed && /less than or equal/.test(reversed.error), "From must be <= To");
  assert.ok("filter" in draft("between", "", "30", "30"));
  assert.ok("error" in draft("between", "", "", ""), "empty Between");

  // 22, 23 — the filter travels as clear query parameters, round-trips exactly, and bad parameters are ignored.
  const q = (filter: PaymentAgingFilter | null) => { const u = new URLSearchParams(); paymentAgingToParams(filter, u); return u; };
  assert.equal(q(gt(45)).toString(), "paymentAgingOperator=gt&paymentAgingValue=45");
  assert.equal(q({ operator: "between", from: 30, to: 60 }).toString(), "paymentAgingOperator=between&paymentAgingFrom=30&paymentAgingTo=60");
  assert.equal(q(null).toString(), "", "clearing removes every aging parameter");
  for (const filter of [gt(45), { operator: "lt", value: 0 }, { operator: "eq", value: 45 }, { operator: "between", from: 30, to: 60 }] as PaymentAgingFilter[]) {
    assert.deepEqual(plain(parsePaymentAging(q(filter))), filter, `round-trip ${paymentAgingLabel(filter)}`);
  }
  for (const bad of ["paymentAgingOperator=gt", "paymentAgingOperator=gt&paymentAgingValue=", "paymentAgingOperator=gt&paymentAgingValue=-5", "paymentAgingOperator=gt&paymentAgingValue=abc",
    "paymentAgingOperator=nope&paymentAgingValue=5", "paymentAgingOperator=between&paymentAgingFrom=60&paymentAgingTo=30", "paymentAgingOperator=between&paymentAgingFrom=5", "paymentAgingValue=5"]) {
    assert.equal(parsePaymentAging(new URLSearchParams(bad)), null, `invalid URL ignored: ${bad}`);
  }
  assert.deepEqual(plain(parseLastPaymentReportParams(new URLSearchParams("state=CG&sort=days_asc&search=x&paymentAgingOperator=gt&paymentAgingValue=45"))),
    { search: "x", sort: "days_asc", page: 1, pageSize: 50, filters: { state: ["CG"] }, paymentAging: gt(45) }, "aging sits beside — never replaces — the other parameters");
  assert.equal(paymentAgingLabel(gt(45)), "> 45"); assert.equal(paymentAgingLabel({ operator: "between", from: 30, to: 60 }), "30–60");
  assert.deepEqual(applyPaymentAging([{ days: 5 }, { days: null }, { days: 50 }], gt(10)), [{ days: 50 }]);
}

/* ---------------------------------- cascading (dependent) filters ---------------------------------- */
async function cascading() {
  const R = (dealerId: string, party: string, state: string, territory: string, officer: string, status = "ACTIVE"): ReportFilterable => ({ dealerId, party, status, state, territory, salesOfficer: officer, salesOfficerId: officer.toLowerCase() });
  const rows: ReportFilterable[] = [
    R("p1", "Alpha", "UP", "LUCKNOW", "Vinay"), R("p2", "Bravo", "UP", "LUCKNOW", "Vinay"), R("p3", "Charlie", "UP", "LUCKNOW", "Santosh"),
    R("p4", "Delta", "UP", "GORAKHPUR", "Vinay"), R("p5", "Echo", "UP", "GORAKHPUR", "Deepak"), R("p6", "Foxtrot", "UP", "BARABANKI", "Deepak"),
    R("p7", "Golf", "MP", "BHOPAL", "Arjun"), R("p8", "Hotel", "MP", "INDORE", "Chhitranjan"), R("p9", "India", "CG", "RAIPUR", "Sunil"),
  ];
  const labels = (o: { label: string }[]) => o.map((x) => x.label).sort();
  const opts = (filters: Record<string, string[]>) => cascadedFilterOptions(rows, pruneReportFilters(rows, filters));
  const same = (actual: unknown, expected: unknown, message: string) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

  // Initial: every dropdown spans the whole authorized dataset.
  same(labels(opts({}).state), ["CG", "MP", "UP"], "initial states");
  same(opts({}), JSON.parse(JSON.stringify(reportFilterOptions(rows))), "no filter == the plain option lists");
  // 1–3 — State = UP narrows Territory, Sales Officer and Party; all filters stay present.
  same(labels(opts({ state: ["UP"] }).territory), ["BARABANKI", "GORAKHPUR", "LUCKNOW"], "UP territories only");
  same(labels(opts({ state: ["UP"] }).officer), ["Deepak", "Santosh", "Vinay"], "UP officers only");
  same(labels(opts({ state: ["UP"] }).party), ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"], "UP dealers only");
  assert.deepEqual(Object.keys(opts({ state: ["UP"] })).sort(), ["officer", "party", "state", "status", "territory"], "no filter disappears");
  same(labels(opts({ state: ["UP"] }).state), ["CG", "MP", "UP"], "a column's own options are not narrowed by itself (more values can be added)");
  // 4–5 — State + Territory narrows Sales Officer and Party.
  same(labels(opts({ state: ["UP"], territory: ["LUCKNOW"] }).officer), ["Santosh", "Vinay"], "UP + LUCKNOW officers");
  same(labels(opts({ state: ["UP"], territory: ["LUCKNOW"] }).party), ["Alpha", "Bravo", "Charlie"], "UP + LUCKNOW dealers");
  // 6–7 — State + Sales Officer narrows Territory and Party (the other direction).
  same(labels(opts({ state: ["UP"], officer: ["vinay"] }).territory), ["GORAKHPUR", "LUCKNOW"], "Vinay's UP territories");
  same(labels(opts({ state: ["UP"], officer: ["vinay"] }).party), ["Alpha", "Bravo", "Delta"], "Vinay's UP dealers");
  // 8 — all three.
  same(labels(opts({ state: ["UP"], territory: ["LUCKNOW"], officer: ["vinay"] }).party), ["Alpha", "Bravo"], "UP + LUCKNOW + Vinay → exactly those dealers");
  // Narrowing works in every direction: a Territory alone narrows State, Sales Officer alone narrows Territory.
  same(labels(opts({ territory: ["BHOPAL"] }).state), ["MP"], "Territory narrows State");
  same(labels(opts({ officer: ["deepak"] }).territory), ["BARABANKI", "GORAKHPUR"], "Sales Officer narrows Territory");
  same(labels(opts({ party: ["p5"] }).officer), ["Deepak"], "a selected Party narrows the other filters to its own values");
  // 9 — changing State clears incompatible Territory / Officer / Party; compatible ones survive.
  same(pruneReportFilters(rows, { state: ["MP"], territory: ["LUCKNOW"], officer: ["vinay"], party: ["p1"] }), {  state: ["MP"] }, "State = MP clears the UP selections");
  same(pruneReportFilters(rows, { state: ["UP"], territory: ["LUCKNOW", "BHOPAL"], officer: ["vinay"] }), { state: ["UP"], territory: ["LUCKNOW"], officer: ["vinay"] }, "only the incompatible value is dropped");
  same(pruneReportFilters(rows, { state: ["UP"], territory: ["GORAKHPUR"], officer: ["santosh"] }), { state: ["UP"], territory: ["GORAKHPUR"] }, "Santosh has no GORAKHPUR dealers → cleared");
  same(pruneReportFilters(rows, { state: ["UP", "MP"], territory: ["BHOPAL"] }), { state: ["UP", "MP"], territory: ["BHOPAL"] }, "OR within a column keeps compatible values");
  // 10 — clearing a filter expands the dependent options again.
  same(labels(opts({ state: ["UP"], territory: ["LUCKNOW"] }).party), ["Alpha", "Bravo", "Charlie"], "UP + LUCKNOW dealers (before clearing)");
  same(labels(opts({ state: ["UP"] }).party), ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"], "Territory = All → UP still applies, options expand back to all UP");
  same(labels(opts({}).party).length, 9, "State = All → the full authorized dataset");
  // Hostile / unknown values are NOT silently dropped into "no filter": they stay and match nothing.
  same(pruneReportFilters(rows, { officer: ["not-in-scope"] }), { officer: ["not-in-scope"] }, "unknown values are kept (→ empty result, never a widened one)");
  assert.equal(applyReportFilters(rows, pruneReportFilters(rows, { officer: ["not-in-scope"] })).length, 0);
  assert.ok(sameReportFilters({ state: ["UP"], territory: [] }, { state: ["UP"] }) && !sameReportFilters({ state: ["UP"] }, { state: ["MP"] }));

  // Service level — real dataset, scope and the existing Last Payment values.
  const filtersOf = async (c: AuthContext, filter: Record<string, string[]>, over = {}) => run(c, { filters: filter, ...over });
  const mp = await filtersOf(admin, { state: ["MP"] });
  assert.deepEqual(labels(mp.options.territory), ["BHOPAL", "HQ", "INDORE"], "State = MP → MP territories only (no UP/CG)");
  assert.deepEqual(mp.options.officer.map((o) => o.value).sort(), ["arjun", "chhitranjan", "rm-1"], "State = MP → MP officers only");
  assert.deepEqual(mp.options.party.map((o) => o.value).sort(), ["d-a", "d-c", "d-e"], "State = MP → MP dealers only");
  const stale = await filtersOf(admin, { state: ["MP"], territory: ["LUCKNOW"], officer: ["rahul"], party: ["d-d"] });
  assert.deepEqual(plain(stale.appliedFilters), { state: ["MP"] }, "the incompatible UP selections are reported as cleared");
  assert.deepEqual(ids(stale.items), ["d-a", "d-c", "d-e"], "the table shows exactly the applied filters (MP), not an empty stale combination");
  assert.deepEqual(plain((await filtersOf(admin, { state: ["MP"], territory: ["INDORE"] })).appliedFilters), { state: ["MP"], territory: ["INDORE"] });
  // Payment Aging + cascade: State = MP AND officer = arjun AND Days > 0 → only arjun's d-a (Days 3).
  assert.deepEqual(ids((await filtersOf(admin, { state: ["MP"], officer: ["arjun"] }, { paymentAging: { operator: "gt", value: 0 } })).items), ["d-a"], "State + Sales Officer + Days > 0");
  assert.deepEqual(ids((await filtersOf(admin, { state: ["MP"], officer: ["arjun"] }, { paymentAging: { operator: "gt", value: 3 } })).items), [], "…and Days > 3 excludes it (aging is just another AND filter)");
  assert.deepEqual(plain((await filtersOf(admin, { state: ["MP"] }, { paymentAging: { operator: "gt", value: 99 } })).options.party.map((o: { value: string }) => o.value).sort()), ["d-a", "d-c", "d-e"], "Payment Aging does not shape the options");
  // Days sorting happens AFTER filtering and is unchanged.
  const asc = (await filtersOf(admin, { state: ["MP"] }, { sort: "days_asc" })).items, desc = (await filtersOf(admin, { state: ["MP"] }, { sort: "days_desc" })).items;
  assert.deepEqual(asc.map((r) => r.days), [3, 20, null]); assert.deepEqual(desc.map((r) => r.days), [20, 3, null]);
  // Role scope: the options and the rows never reach outside the caller's authorized dealers.
  const rmAll = await run(rm);
  for (const key of ["state", "territory", "officer", "party"] as const) {
    for (const o of rmAll.options[key]) assert.ok(!["UP", "LUCKNOW", "rahul", "d-d", "d-h"].includes(o.value), `RM option ${key}:${o.value} is in scope`);
  }
  assert.deepEqual((await filtersOf(rm, { state: ["MP"] })).options.officer.map((o) => o.value).sort(), ["arjun", "chhitranjan", "rm-1"], "RM cascade stays inside the RM's team");
  const rmUp = await filtersOf(rm, { state: ["UP"] });
  assert.deepEqual(ids(rmUp.items), [], "an RM cannot reach UP (another team) through the State filter");
  assert.deepEqual(rmUp.options.party.map((o) => o.value), [], "…nor see UP options");
  const soUp = await filtersOf(so, { state: ["MP"], officer: ["arjun"] });
  assert.deepEqual(ids(soUp.items), ["d-a"]); assert.deepEqual(soUp.options.officer.map((o) => o.value), ["arjun"], "SO sees only themselves");
  // Last Payment values are untouched by cascading.
  const before = Object.fromEntries((await run(admin)).items.map((r) => [r.dealerId, r]));
  for (const row of (await filtersOf(admin, { state: ["MP"], territory: ["BHOPAL"] })).items) assert.deepEqual(plain(row), plain(before[row.dealerId]), `${row.dealerId} unchanged`);
  // Page wiring: all four filters stay visible; the page adopts the server's applied (pruned) selections.
  const page = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  assert.ok(page.includes("sameReportFilters(cleaned, pending)") && page.includes("setPending(cleaned)") && page.includes("!optionsQuery.isPlaceholderData"), "an invalid child selection is cleared from the PENDING state");
  assert.equal((page.match(/<ColumnFilterHeader/g) ?? []).length, 1, "the four filters are still rendered (one mapped header), never hidden");
}

/* ---------------------------------- Status column + cascading Status filter ---------------------------------- */
async function statusFilter() {
  const R = (dealerId: string, party: string, state: string, territory: string, officer: string, status: string): ReportFilterable => ({ dealerId, party, status, state, territory, salesOfficer: officer, salesOfficerId: officer.toLowerCase() });
  const rows: ReportFilterable[] = [
    R("p1", "Alpha", "UP", "LUCKNOW", "Vinay", "ACTIVE"), R("p2", "Bravo", "UP", "LUCKNOW", "Vinay", "DEFAULTER"), R("p3", "Charlie", "UP", "LUCKNOW", "Santosh", "ACTIVE"),
    R("p4", "Delta", "UP", "GORAKHPUR", "Vinay", "PENDING"), R("p5", "Echo", "UP", "GORAKHPUR", "Deepak", "ACTIVE"), R("p6", "Foxtrot", "UP", "BARABANKI", "Deepak", "ACTIVE"),
    R("p7", "Golf", "MP", "BHOPAL", "Arjun", "DEFAULTER"), R("p8", "Hotel", "MP", "INDORE", "Chhitranjan", "ACTIVE"),
  ];
  const labels = (o: { label: string }[]) => o.map((x) => x.label).sort();
  const j = (x: unknown) => JSON.parse(JSON.stringify(x));
  const opts = (filters: Record<string, string[]>) => cascadedFilterOptions(rows, pruneReportFilters(rows, filters));

  // The Status options are the statuses ACTUALLY present (existing Dealer.status values, shown with their normal labels) — nothing hard-coded.
  assert.deepEqual(labels(opts({}).status), ["Active", "Defaulter", "Pending"], "only statuses present in the dataset (no Inactive: none of these dealers has it)");
  assert.deepEqual(opts({}).status.map((o) => o.value).sort(), ["ACTIVE", "DEFAULTER", "PENDING"], "values are the stored statuses");
  // 3–4 — State + Status narrows Territory / Sales Officer / Party.
  assert.deepEqual(j(labels(opts({ state: ["UP"], status: ["ACTIVE"] }).territory)), ["BARABANKI", "GORAKHPUR", "LUCKNOW"], "UP + Active territories");
  assert.deepEqual(j(labels(opts({ state: ["UP"], status: ["DEFAULTER"] }).territory)), ["LUCKNOW"], "UP + Defaulter → only LUCKNOW");
  assert.deepEqual(j(labels(opts({ state: ["UP"], status: ["ACTIVE"] }).officer)), ["Deepak", "Santosh", "Vinay"]);
  assert.deepEqual(j(labels(opts({ state: ["UP"], status: ["PENDING"] }).officer)), ["Vinay"], "UP + Pending → only Vinay");
  assert.deepEqual(j(labels(opts({ state: ["UP"], status: ["ACTIVE"] }).party)), ["Alpha", "Charlie", "Echo", "Foxtrot"], "UP + Active dealers only");
  // 5 — Territory + Status narrows Sales Officer and Party.
  assert.deepEqual(j(labels(opts({ state: ["UP"], territory: ["LUCKNOW"], status: ["ACTIVE"] }).officer)), ["Santosh", "Vinay"]);
  assert.deepEqual(j(labels(opts({ state: ["UP"], territory: ["LUCKNOW"], status: ["ACTIVE"] }).party)), ["Alpha", "Charlie"], "UP + LUCKNOW + Active");
  assert.deepEqual(j(labels(opts({ state: ["UP"], territory: ["LUCKNOW"], status: ["DEFAULTER"] }).officer)), ["Vinay"]);
  // 6 — Sales Officer + Status narrows Party (and a Sales Officer narrows the Status options themselves).
  assert.deepEqual(j(labels(opts({ officer: ["vinay"], status: ["ACTIVE"] }).party)), ["Alpha"], "Vinay + Active");
  assert.deepEqual(j(labels(opts({ officer: ["vinay"] }).status)), ["Active", "Defaulter", "Pending"], "statuses represented in Vinay's dealers");
  assert.deepEqual(j(labels(opts({ officer: ["deepak"] }).status)), ["Active"], "Deepak only has Active dealers");
  assert.deepEqual(j(labels(opts({ territory: ["BHOPAL"] }).status)), ["Defaulter"], "Territory narrows Status");
  assert.deepEqual(j(labels(opts({ state: ["MP"] }).status)), ["Active", "Defaulter"], "State narrows Status");
  // 7 — clearing Status expands the dependent options again.
  assert.deepEqual(j(labels(opts({ state: ["UP"] }).party)).length, 6, "Status = All → every UP dealer");
  // 8 — changing State clears incompatible Status / Territory / SO / Party.
  assert.deepEqual(j(pruneReportFilters(rows, { state: ["MP"], status: ["PENDING"], territory: ["LUCKNOW"], officer: ["vinay"], party: ["p1"] })), { state: ["MP"] }, "MP has no Pending dealers, and the UP selections are all dropped");
  assert.deepEqual(j(pruneReportFilters(rows, { state: ["MP"], status: ["DEFAULTER"], territory: ["BHOPAL"], officer: ["arjun"], party: ["p7"] })), { state: ["MP"], territory: ["BHOPAL"], officer: ["arjun"], status: ["DEFAULTER"], party: ["p7"] }, "a fully compatible selection survives");
  assert.deepEqual(j(pruneReportFilters(rows, { state: ["UP"], officer: ["vinay"], status: ["ACTIVE", "PENDING"] })), { state: ["UP"], officer: ["vinay"], status: ["ACTIVE", "PENDING"] });
  assert.deepEqual(j(pruneReportFilters(rows, { officer: ["deepak"], status: ["DEFAULTER"] })), { officer: ["deepak"] }, "Deepak has no Defaulter dealers → the Status is cleared");

  // Service level — real dataset, scope, search, aging, sorting.
  const f = async (c: AuthContext, filter: Record<string, string[]>, over = {}) => run(c, { filters: filter, ...over });
  const all = await run(admin);
  const byId = Object.fromEntries(all.items.map((r) => [r.dealerId, r]));
  // 1 — the column carries each dealer's CURRENT Dealer.status.
  assert.deepEqual(Object.fromEntries(all.items.map((r) => [r.dealerId, r.status])), { "d-a": "ACTIVE", "d-b": "ACTIVE", "d-c": "DEFAULTER", "d-d": "ACTIVE", "d-e": "PENDING", "d-f": "ACTIVE", "d-h": "ACTIVE" });
  dealers.find((d) => d.id === "d-c")!.status = "ACTIVE"; // master data changes → the report follows (no cached copy)
  assert.equal((await run(admin)).items.find((r) => r.dealerId === "d-c")!.status, "ACTIVE", "reflects the dealer's current status");
  dealers.find((d) => d.id === "d-c")!.status = "DEFAULTER";
  // 2 — the filter itself (OR within, AND across).
  assert.deepEqual(ids((await f(admin, { status: ["ACTIVE"] })).items), ["d-a", "d-b", "d-d", "d-f", "d-h"]);
  assert.deepEqual(ids((await f(admin, { status: ["DEFAULTER", "PENDING"] })).items), ["d-c", "d-e"], "Status OR");
  assert.deepEqual(ids((await f(admin, { status: ["ACTIVE"], state: ["MP"] })).items), ["d-a"], "Status AND State");
  assert.deepEqual(ids((await f(admin, { status: ["INACTIVE"] })).items), [], "Inactive dealers are outside this report's existing dataset");
  // 3 — Status participates in the cascade on the real dataset.
  const mpActive = await f(admin, { state: ["MP"], status: ["ACTIVE"] });
  assert.deepEqual(mpActive.options.territory.map((o) => o.value).sort(), ["BHOPAL"], "State + Status → territories");
  assert.deepEqual(mpActive.options.officer.map((o) => o.value), ["arjun"]); assert.deepEqual(mpActive.options.party.map((o) => o.value), ["d-a"]);
  assert.deepEqual(labels((await f(admin, { state: ["MP"] })).options.status), ["Active", "Defaulter", "Pending"], "State narrows the Status options");
  assert.deepEqual(labels((await f(admin, { officer: ["chhitranjan"] })).options.status), ["Defaulter"], "Sales Officer narrows the Status options");
  // 8/9 — State change clears the incompatible Status / Territory.
  const cleared = await f(admin, { state: ["CG"], status: ["DEFAULTER"], territory: ["INDORE"] });
  assert.deepEqual(plain(cleared.appliedFilters), { state: ["CG"] }, "CG has no Defaulter dealers and no INDORE");
  assert.deepEqual(ids(cleared.items), ["d-b"], "the table shows exactly the applied filters");
  // 10 — Party search + Status.
  assert.deepEqual(ids((await f(admin, { status: ["ACTIVE"] }, { search: "alpha" })).items), ["d-a"], "Status AND search");
  assert.deepEqual(ids((await f(admin, { status: ["ACTIVE"] }, { search: "agro" })).items), [], "Gamma Agro is a Defaulter → excluded by Status");
  assert.deepEqual(ids((await f(admin, { status: ["DEFAULTER"] }, { search: "agro" })).items), ["d-c"]);
  // 11 — Payment Aging + Status (Days: d-b 0, d-a 3, d-d 4, d-c 20).
  assert.deepEqual(ids((await f(admin, { status: ["ACTIVE"] }, { paymentAging: { operator: "gt", value: 0 } })).items), ["d-a", "d-d"]);
  assert.deepEqual(ids((await f(admin, { status: ["DEFAULTER"] }, { paymentAging: { operator: "gt", value: 0 } })).items), ["d-c"]);
  assert.deepEqual(ids((await f(admin, { status: ["ACTIVE"], state: ["MP"] }, { paymentAging: { operator: "gt", value: 3 } })).items), [], "State + Status + Days > 3");
  // 12 — Days sorting after filtering, unchanged (payment-less dealers stay last).
  assert.deepEqual((await f(admin, { status: ["ACTIVE"] }, { sort: "days_asc" })).items.map((r) => r.days), [0, 3, 4, null, null]);
  assert.deepEqual((await f(admin, { status: ["ACTIVE"] }, { sort: "days_desc" })).items.map((r) => r.days), [4, 3, 0, null, null]);
  // 13 — scope: the Status column/filter/options obey the caller's scope exactly.
  assert.deepEqual(labels((await run(rm)).options.status), ["Active", "Defaulter", "Pending"], "RM sees statuses of their own scope");
  assert.deepEqual(labels((await run(so)).options.status), ["Active"], "a Sales Officer only sees the status of their own dealer");
  assert.deepEqual(ids((await f(rm, { status: ["ACTIVE"] })).items), ["d-a", "d-b"], "RM + Status stays inside the RM's team (d-d / d-h are another team's)");
  assert.deepEqual(ids((await f(so, { status: ["PENDING"] })).items), [], "SO cannot reach another officer's Pending dealer");
  // 14 — Last Payment values untouched.
  for (const row of (await f(admin, { status: ["ACTIVE"] })).items) assert.deepEqual(plain(row), plain(byId[row.dealerId]), `${row.dealerId}: unchanged`);
  // URL / API parameter.
  assert.deepEqual(plain(parseLastPaymentReportParams(new URLSearchParams("status=ACTIVE&status=PENDING&status=ACTIVE")).filters), { status: ["ACTIVE", "PENDING"] });
  // Layout: Status right after Party; fixed layout with compact widths for the short columns.
  const page = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  assert.ok(page.indexOf('key: "status"') > page.indexOf('key: "party"') && page.indexOf('key: "status"') < page.indexOf('key: "state"'), "Status sits immediately after Party");
  assert.ok(page.includes('table-fixed') && /key: "status", label: "Status", width: "w-\d+"/.test(page) && page.includes("w-40 text-right"), "balanced, fixed column widths");
  // The Sales Officer column was 12rem (w-48) → the empty space before the right-aligned Last Payment Date; it is now compact and the date column was NOT widened.
  assert.ok(page.includes('key: "officer", label: "Sales Officer", width: "w-36"') && !page.includes('width: "w-48"'), "Sales Officer is compact (9rem)");
  assert.ok(page.includes('<TableHead className="w-40 text-right">Last Payment Date') && page.includes('key: "territory", label: "Territory", width: "w-40"'), "Last Payment Date / Territory widths unchanged");
}

/* ---------------------------------- Last Update (latest successful Day Book upload) ---------------------------------- */
async function lastUpdate() {
  const stamp = (iso: string) => new Date(iso);
  const DAYBOOK = (name: string) => `Day Book upload for Season · October (${name}): 12 dealer(s) updated — Receipts ₹1000, SR/CR ₹0`;
  const lastUpdateOf = async () => (await run(admin)).lastUpdate;
  // 6 — no upload history at all → handled gracefully.
  audits = []; imports = [];
  assert.equal(await lastUpdateOf(), null, "no Day Book has ever been uploaded");
  assert.equal(formatLastUpdate(null), null);
  let html = await draw(admin);
  assert.ok(/data-testid="last-update"[^>]*>Last Update: —</.test(html), "the page shows a dash, not an error");
  // 1, 2 — the newest successful upload wins (monthly upload records and Historical Day Book imports both count).
  audits = [{ entity: "recoveryPlan", summary: DAYBOOK("a.xlsx"), createdAt: stamp("2026-10-01T06:00:00Z") }, { entity: "recoveryPlan", summary: DAYBOOK("b.xlsx"), createdAt: stamp("2026-10-03T06:00:00Z") }];
  imports = [{ createdAt: stamp("2026-10-02T06:00:00Z") }];
  assert.equal(await lastUpdateOf(), "2026-10-03", "newest of several uploads");
  audits.push({ entity: "recoveryPlan", summary: DAYBOOK("c.xlsx"), createdAt: stamp("2026-10-06T06:00:00Z") });
  assert.equal(await lastUpdateOf(), "2026-10-06", "a new upload automatically becomes the Last Update");
  imports.push({ createdAt: stamp("2026-10-08T06:00:00Z") });
  assert.equal(await lastUpdateOf(), "2026-10-08", "a Historical Day Book import is a Day Book upload too");
  // 3 — failed / unrelated attempts leave no upload record (the commit writes its audit entry only after success) → unchanged,
  //     and look-alike records are ignored.
  audits.push(
    { entity: "recoveryPlan", summary: "Recovery plan approved", createdAt: stamp("2026-10-20T06:00:00Z") },
    { entity: "scheme", summary: DAYBOOK("not-ours.xlsx"), createdAt: stamp("2026-10-21T06:00:00Z") },
    { entity: "recoveryPlan", summary: null, createdAt: stamp("2026-10-22T06:00:00Z") },
  );
  assert.equal(await lastUpdateOf(), "2026-10-08", "failed uploads / other audit entries never move the date");
  // India calendar date, not UTC and not the browser's: 20:00 UTC on 5 Oct is already 6 Oct in India.
  audits = [{ entity: "recoveryPlan", summary: DAYBOOK("late.xlsx"), createdAt: stamp("2026-10-05T20:00:00Z") }]; imports = [];
  assert.equal(await lastUpdateOf(), "2026-10-06", "Asia/Kolkata business date");
  // 5 — rendered exactly DD/MM/YYYY, read-only text (no input / button / date picker).
  assert.equal(formatLastUpdate("2026-10-06"), "06/10/2026"); assert.equal(formatLastUpdate("2026-01-09"), "09/01/2026"); assert.equal(formatLastUpdate("garbage"), null);
  html = await draw(admin);
  assert.ok(/data-testid="last-update"[^>]*>Last Update: 06\/10\/2026</.test(html), "Last Update: 06/10/2026");
  // Layout: ONE row — the Search input on the left, the read-only Last Update on the right (not in the page header / table header).
  const rowStart = html.indexOf("flex flex-wrap items-center justify-between gap-x-4"); const row = html.slice(rowStart, html.indexOf('data-testid="last-update"') + 120);
  assert.ok(row.indexOf("<input") >= 0 && row.indexOf("<input") < row.indexOf('data-testid="last-update"'), "Search parties… is left of Last Update on the same row");
  assert.ok(row.includes("Last Update: 06/10/2026") && !/<(button|select|a)\b/.test(row.slice(row.indexOf('data-testid="last-update"'))), "Last Update stays read-only text");
  assert.ok(!(html.match(/data-slot="actions">([\s\S]*?)<\/div>/) ?? [])[1]?.includes("Last Update"), "no longer in the page header");
  assert.ok(!/<th[^>]*>[^<]*Last Update/.test(html), "not in the table header");
  // 4 — read-only: the loader writes nothing and does not touch Day Book data (the fake has no write methods; also check the source).
  const server = readFileSync("src/features/reports/last-payment-report.server.ts", "utf8");
  assert.ok(!/\.(create|update|upsert|delete|deleteMany|updateMany|createMany)\(|\$executeRaw/.test(server), "the report service performs no writes");
  // The indicator is bound to what the Day Book commit really writes — pin that coupling to the source.
  const recovery = readFileSync("src/features/recovery/service.server.ts", "utf8");
  const commit = recovery.slice(recovery.indexOf("export async function commitDaybook"));
  assert.ok(commit.includes('entity: "recoveryPlan"') && commit.includes("summary: `Day Book upload for ") && commit.indexOf("retainRegularReceipts") < commit.indexOf("Day Book upload for "), "the monthly commit writes its audit entry only after a successful commit");
  assert.equal(DAYBOOK_UPLOAD_AUDIT_PREFIX, "Day Book upload for "); assert.equal(DAYBOOK_UPLOAD_AUDIT_ENTITY, "recoveryPlan");
  // 7 — everything else is untouched: rows and filters are identical with and without upload history.
  audits = []; imports = [];
  const without = await run(admin);
  audits = [{ entity: "recoveryPlan", summary: DAYBOOK("x.xlsx"), createdAt: stamp("2026-10-06T06:00:00Z") }];
  const withHistory = await run(admin);
  assert.deepEqual(plain(withHistory.items), plain(without.items), "Last Payment rows unchanged");
  assert.deepEqual(plain(withHistory.options), plain(without.options), "filter options unchanged");
  assert.deepEqual(ids((await run(admin, { filters: { state: ["MP"] }, paymentAging: { operator: "gt", value: 0 } })).items), ["d-a", "d-c"], "filters + Payment Aging unchanged");
  audits = []; imports = [];
}

/* ---------------------------------- Excel export (all filtered rows, current state) ---------------------------------- */
async function exportTests() {
  const exportRoute = load<{ GET: (req: { nextUrl: { searchParams: URLSearchParams } }) => Promise<FakeNextResponse> }>("src/app/api/reports/last-payment/export/route.ts");
  // Reads the REAL generated workbook back (ExcelJS): title, Last Update, headers, then one line per exported row.
  const ExcelJS = (await import("exceljs")).default;
  type Sheet = { status: number; error?: string; title?: string; meta: string[]; headers: string[]; rows: Record<string, string | number | null>[]; filename?: string; contentType?: string };
  const exportFile = async (query: string, who: AuthContext = admin): Promise<Sheet> => {
    exportCtx = who;
    const res = await exportRoute.GET({ nextUrl: { searchParams: new URLSearchParams(query) } });
    if (res.status !== 200) return { status: res.status, error: (res.body as { error: string }).error, meta: [], headers: [], rows: [] };
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0]!;
    const cell = (r: number, c: number) => { const v = ws.getCell(r, c).value; return v == null || v === "" ? null : (v as string | number); };
    const headerRow = 4; // title (1), Last Update (2), blank (3), headers (4)
    const headers = Array.from({ length: 8 }, (_, i) => String(cell(headerRow, i + 1)));
    const rows: Sheet["rows"] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) rows.push(Object.fromEntries(headers.map((h, i) => [h, cell(r, i + 1)])));
    return { status: 200, title: String(cell(1, 1)), meta: [String(cell(2, 1))], headers, rows, filename: res.init.headers?.["Content-Disposition"], contentType: res.init.headers?.["Content-Type"] };
  };
  const parties = (sheet: Sheet) => sheet.rows.map((r) => r["Party"]).sort();
  audits = [{ entity: "recoveryPlan", summary: "Day Book upload for Season · October (a.xlsx): 3 dealer(s) updated", createdAt: new Date("2026-10-05T20:00:00Z") }]; imports = [];

  // 1 + 9 + 10 — no filters: every authorized row, the table's columns/order, the existing Last Update, no pagination info.
  const all = await exportFile("");
  assert.equal(all.status, 200); assert.match(all.contentType!, /spreadsheetml/); assert.match(all.filename!, /Last_Payment_Report\.xlsx/);
  assert.equal(all.title, "Last Payment Report");
  assert.deepEqual(all.meta, ["Last Update: 06/10/2026"], "the SAME Last Update the page shows (Day Book upload date, India date) above the table");
  assert.deepEqual(all.headers, ["Party", "Status", "State", "Territory", "Sales Officer", "Last Payment Date", "Amount", "Days"], "same columns and order as the UI");
  assert.equal(all.rows.length, 7, "all authorized dealers");
  const pageHtml = await draw(admin);
  assert.deepEqual([...pageHtml.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim()).slice(0, 8), all.headers, "export headers == UI headers");
  const a = all.rows.find((r) => r["Party"] === "Alpha Traders")!;
  assert.deepEqual([a["Status"], a["State"], a["Territory"], a["Sales Officer"], a["Last Payment Date"], a["Amount"], a["Days"]], ["Active", "MP", "BHOPAL", "Arjun Yadav", "02/10/2026", 50000, 3], "display labels, DD/MM/YYYY, numeric amount/days — the page's calculated values");
  const e = all.rows.find((r) => r["Party"] === "Epsilon RM Dealer")!;
  assert.deepEqual([e["Status"], e["Last Payment Date"], e["Amount"], e["Days"]], ["Pending", null, null, null], "no payment → blank cells, not zeros");
  assert.ok(!all.rows.some((r) => Object.values(r).some((v) => /Page \d|Generated/i.test(String(v)))) && !all.meta.some((m) => /Generated|Page /i.test(m)), "no pagination / generation timestamp");
  assert.equal((await exportFile("")).rows.length, (await run(admin, { pageSize: 200 })).total, "exported count == the report's pre-pagination total");

  // 2–7 — every filter is honoured; combinations are exact intersections.
  assert.deepEqual(parties(await exportFile("state=MP")), ["Alpha Traders", "Epsilon RM Dealer", "Gamma Agro"], "State");
  assert.deepEqual(parties(await exportFile("state=MP&territory=INDORE")), ["Gamma Agro"], "State + Territory");
  assert.deepEqual(parties(await exportFile("state=MP&officer=arjun")), ["Alpha Traders"], "State + Sales Officer");
  assert.deepEqual(parties(await exportFile("status=PENDING")), ["Epsilon RM Dealer"], "Status");
  assert.deepEqual(parties(await exportFile("search=agro")), ["Gamma Agro"], "Party search");
  assert.deepEqual(parties(await exportFile("state=MP&status=ACTIVE&paymentAgingOperator=gt&paymentAgingValue=0")), ["Alpha Traders"], "State + Status + Payment Aging");
  assert.deepEqual(parties(await exportFile("state=MP&territory=INDORE&search=agro&status=DEFAULTER&officer=chhitranjan")), ["Gamma Agro"], "everything together");
  assert.deepEqual(parties(await exportFile("state=MP&territory=BHOPAL&officer=chhitranjan")), parties(await exportFile("state=MP&territory=BHOPAL")), "an incompatible Sales Officer is cleared exactly like the table does");
  // The export always follows the CURRENT selection: clearing a filter and exporting again widens the file.
  assert.equal((await exportFile("state=MP&territory=INDORE")).rows.length, 1);
  assert.equal((await exportFile("state=MP")).rows.length, 3, "Territory cleared → expanded result");
  // Days sort is honoured in the file too.
  assert.deepEqual((await exportFile("state=MP&sort=days_asc")).rows.map((r) => r["Days"]), [3, 20, null]);
  assert.deepEqual((await exportFile("state=MP&sort=days_desc")).rows.map((r) => r["Days"]), [20, 3, null]);

  // 8 + 13 — a result that spans several UI pages exports ALL of it; the paged report itself is unchanged.
  const paged = await run(admin, { pageSize: 3, page: 1 });
  assert.equal(paged.items.length, 3); assert.equal(paged.total, 7); assert.equal(paged.totalPages, 3);
  assert.equal((await exportFile("pageSize=3&page=1")).rows.length, 7, "pageSize / page are ignored by the export: all 7, not the 3 on page 1");
  assert.equal((await exportFile("pageSize=3&page=3")).rows.length, 7, "…and not the last page's 1 row either");
  assert.deepEqual(plain((await run(admin, { pageSize: 3, page: 3 })).items.length), 1, "the UI still paginates normally");

  // 11 — scope: only what the caller may already see; hostile scope parameters are ignored / match nothing.
  assert.deepEqual(parties(await exportFile("", rm)), ["Alpha Traders", "Beta Alias", "Epsilon RM Dealer", "Gamma Agro"], "RM: own team only");
  assert.deepEqual(parties(await exportFile("", so)), ["Alpha Traders"], "SO: own dealers only");
  assert.deepEqual(parties(await exportFile("officerId=rahul&scope=all&dealerId=d-d", rm)), ["Alpha Traders", "Beta Alias", "Epsilon RM Dealer", "Gamma Agro"], "scope parameters are not accepted");
  const hostile = await exportFile("officer=rahul&state=UP", rm);
  assert.equal(hostile.status, 422, "another team's officer/State yields nothing to export — never their rows");
  // 12 — no matching rows → a clear message instead of a misleading empty file.
  const none = await exportFile("search=zzzz");
  assert.equal(none.status, 422); assert.equal(none.error, "No data available to export for the selected filters."); assert.equal(none.title, undefined, "no workbook is produced");
  // No Day Book history → the file still exports and says Last Update: —.
  audits = []; imports = [];
  assert.deepEqual((await exportFile("")).meta, ["Last Update: —"]);

  // Read-only + UI wiring (source level): ONE query builder feeds both the paged table and the export; loading state; no duplicate clicks.
  const page = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  assert.ok(page.includes("const reportQuery = ") && page.includes("reportQuery({ page: String(page)") && page.includes("/api/reports/last-payment/export?${reportQuery()}"), "export is built from the same query as the table (current state at click time)");
  assert.ok(page.includes("if (exporting) return;") && page.includes("disabled={exporting || isLoading}") && page.includes('"Exporting…"'), "disabled + loading state, no duplicate requests");
  assert.ok(page.includes("NO_EXPORT_DATA_MESSAGE") && page.includes("data.total === 0"), "empty result shows the message");
  const route = readFileSync("src/app/api/reports/last-payment/export/route.ts", "utf8");
  assert.ok(route.includes("getLastPaymentReportExport(ctx, params)") && !/officerId|scope/i.test(route.replace(/ctx|session scope|scope parameter/g, "")), "same service + session scope, no scope input");
  const service = readFileSync("src/features/reports/last-payment-report.server.ts", "utf8");
  assert.equal((service.match(/applyReportFilters\(/g) ?? []).length, 1, "ONE filtering implementation shared by the page and the export");
  assert.equal(report.getLastPaymentReport.length, 2, "the paged service signature is unchanged");
}

/* ---------------------------------- explicit "Apply Filters" (pending vs applied) ---------------------------------- */
async function applyWorkflow() {
  const query = (url: string) => new URL(url, "http://x").searchParams;
  // 1–4 — choosing a filter changes only the PENDING selection: the table request keeps the APPLIED filters, the header shows the pending count.
  for (const [key, label, pendingValue] of [["state", "State", "MP"], ["territory", "Territory", "INDORE"], ["status", "Status", "PENDING"], ["officer", "Sales Officer", "arjun"], ["party", "Party", "d-a"]] as const) {
    const html = await draw(admin, {}, { 3: { [key]: [pendingValue] } }); // pending = {key}, applied = {} (all)
    assert.deepEqual(query(requested).getAll(key), [], `${key}: selecting it does NOT change the table request`);
    assert.ok(html.includes(`${label} (1)`), `${key}: the dropdown shows the pending selection`);
    assert.deepEqual(query(requestedOptions).getAll(key), [pendingValue], `${key}: …and only the dropdown OPTIONS follow it (options-only request)`);
    assert.equal(query(requestedOptions).get("optionsOnly"), "1");
  }
  // Applied UP, pending MP → the table is still UP until Apply Filters is clicked.
  await draw(admin, {}, { 3: { state: ["MP"] }, 5: { state: ["UP"] } });
  assert.deepEqual(query(requested).getAll("state"), ["UP"], "table keeps the APPLIED filter (UP)");
  assert.deepEqual(query(requestedOptions).getAll("state"), ["MP"], "options cascade from the PENDING selection (MP)");
  assert.equal(query(requested).get("optionsOnly"), null, "the table request is a normal report request");

  // 5, 8 — Apply Filters applies ALL pending selections at once; a real change resets to page 1; nothing happens without a change.
  const pending = { state: ["MP"], territory: ["INDORE"], status: ["DEFAULTER"], officer: ["chhitranjan"] };
  const step = applyFilterStep({ pending, applied: { state: ["UP"] }, page: 3, applying: false });
  assert.deepEqual(plain(step), { applied: pending, page: 1, applying: true, changed: true }, "all pending selections applied together, page 3 → 1");
  const idle = applyFilterStep({ pending: { state: ["UP"] }, applied: { state: ["UP"] }, page: 3, applying: false });
  assert.deepEqual([idle.changed, idle.page, idle.applying], [false, 3, false], "no pending change → no refetch, page untouched");
  assert.equal(applyFilterStep({ pending: { state: ["UP"] }, applied: { state: ["UP"] }, page: 1, applying: false }).applied.state?.[0], "UP");
  // 7 — duplicate clicks while applying are ignored.
  const dup = applyFilterStep({ pending, applied: { state: ["UP"] }, page: 3, applying: true });
  assert.deepEqual([dup.changed, dup.page, dup.applying], [false, 3, true], "a second click during applying does nothing");
  // 6 — loading state: spinner + "Applying…", disabled and busy; otherwise "Apply Filters".
  let html = await draw(admin, {}, { 3: { state: ["MP"] }, 5: { state: ["UP"] }, 6: true });
  const busy = html.slice(html.indexOf("Applying…") - 700, html.indexOf("Applying…") + 20);
  assert.ok(html.includes("Applying…") && /disabled=""/.test(busy) && busy.includes('aria-busy="true"') && busy.includes("animate-spin"), "spinner + disabled while applying");
  html = await draw(admin, {}, { 3: { state: ["MP"] }, 5: { state: ["UP"] } });
  assert.ok(html.includes("Apply Filters") && !html.includes("Applying…"), "idle label");
  assert.ok(html.indexOf("Search parties") < html.indexOf("Apply Filters") && html.indexOf("Apply Filters") < html.indexOf("Last Update"), "Apply Filters sits with the search controls");
  // The current table stays visible while loading (no blank table): placeholder data is kept and the skeleton is first-load only.
  const page = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  assert.ok(page.includes("placeholderData: keepPreviousData") && page.includes("isLoading ? ("), "previous results stay on screen while the new ones load");

  // 9, 10 — cascading options follow the pending selection (options-only request: no table rows, no receipt lookups) and clear invalid children.
  const labels = (o: { label: string }[]) => o.map((x) => x.label).sort();
  queries = { legacy: 0, history: 0, dealers: 0 };
  const mp = plain(await report.getLastPaymentReportOptions(admin, { state: ["MP"] }));
  assert.deepEqual(labels(mp.options.territory), ["BHOPAL", "HQ", "INDORE"], "pending State = MP → MP territories only");
  assert.deepEqual(mp.options.officer.map((o: { value: string }) => o.value).sort(), ["arjun", "chhitranjan", "rm-1"]);
  assert.deepEqual(plain(mp.appliedFilters), { state: ["MP"] });
  assert.deepEqual([queries.legacy, queries.history], [0, 0], "no Last Payment lookup for an options-only request");
  const cleared = plain(await report.getLastPaymentReportOptions(admin, { state: ["MP"], territory: ["LUCKNOW"], officer: ["rahul"], status: ["PENDING"] }));
  assert.deepEqual(plain(cleared.appliedFilters), { state: ["MP"], status: ["PENDING"] }, "invalid children (UP territory / officer) are cleared; the compatible Status stays");
  assert.deepEqual(plain((await report.getLastPaymentReportOptions(admin, {})).options), plain((await run(admin)).options), "no selection == the report's own options");
  // 13 — scope: options for pending selections never reach outside the caller's authorized rows.
  const rmUp = plain(await report.getLastPaymentReportOptions(rm, { state: ["UP"] }));
  assert.deepEqual([rmUp.options.party.length, rmUp.options.officer.length], [0, 0], "an RM sees no UP options");
  assert.ok(!JSON.stringify((await report.getLastPaymentReportOptions(rm, {})).options).includes("rahul"), "no unauthorized officer in the RM's options");
  assert.deepEqual(plain((await report.getLastPaymentReportOptions(so, {})).options.party.map((o) => o.value)), ["d-a"], "SO: own dealers only");
  assert.equal(report.getLastPaymentReport.length, 2, "the report service signature is unchanged");

  // 11 — Export uses the APPLIED filters, never the pending ones.
  const reportQuerySource = page.slice(page.indexOf("const reportQuery = "), page.indexOf("const canExport")).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(reportQuerySource.includes("applied[key]") && !reportQuerySource.includes("pending"), "the shared query builder reads APPLIED filters only");
  assert.ok(page.includes("/api/reports/last-payment/export?${reportQuery()}") && page.includes("reportQuery({ page: String(page)"), "export and table both use that builder");
  // 12 — URL: opened with filters → both pending AND applied start from them; only Apply writes the URL.
  html = await draw(admin, { filters: { state: ["UP"], status: ["ACTIVE"] } }, {}, "state=UP&status=ACTIVE&profile=x");
  assert.deepEqual([query(requested).getAll("state"), query(requested).getAll("status")], [["UP"], ["ACTIVE"]], "applied initialised from the URL");
  assert.deepEqual([query(requestedOptions).getAll("state"), query(requestedOptions).getAll("status")], [["UP"], ["ACTIVE"]], "pending initialised from the URL");
  assert.ok(html.includes("State (1)") && html.includes("Status (1)"));
  const onChange = page.slice(page.indexOf("onChange={(next) =>"), page.indexOf("/>", page.indexOf("onChange={(next) =>")));
  assert.ok(!onChange.includes("replaceState") && page.slice(page.indexOf("const applyFilters")).includes("window.history.replaceState"), "the URL changes on Apply, not on every dropdown click");
  // Route: options-only is a read-only mode of the same endpoint.
  const route = readFileSync("src/app/api/reports/last-payment/route.ts", "utf8");
  assert.ok(route.includes('get("optionsOnly") === "1"') && route.includes("getLastPaymentReportOptions(ctx, params.filters)") && !/officerId|scope\s*=/.test(route.replace(/scope comes from the session/i, "")), "same session scope, no scope input");
  // 14 — Search, Days sort and Payment Aging stay immediate; calculations/last update unchanged.
  assert.ok(/onChange=\{\(event\) => \{ setSearch\(event\.target\.value\); setPage\(1\); \}\}/.test(page) && page.includes("setSort(sort === "), "search and Days sort remain immediate");
  assert.ok(page.includes("formatLastUpdate(data?.lastUpdate)"), "Last Update unchanged");
}

/* ---------------------------------- sidebar ---------------------------------- */
function sidebar() {
  for (const role of [Role.SUPER_ADMIN, Role.REGIONAL_MANAGER, Role.SALES_OFFICER]) {
    const items = navForRole(role);
    const item = items.find((n) => n.href === "/reports/last-payment");
    assert.ok(item, `${role}: sidebar item present`);
    assert.equal(item!.label, "Last Payment Report"); assert.equal(item!.group, "Insights");
    assert.ok(items.some((n) => n.href === "/reports" && n.label === "Reports"), "existing Reports entry unchanged");
    assert.deepEqual(resolveNavState("/reports/last-payment", items), { activeHref: "/reports/last-payment", activeGroup: "Insights" }, "exactly one active leaf");
    assert.equal(resolveNavState("/reports", items).activeHref, "/reports");
  }
  assert.ok(navForRole(Role.CUSTOM_ADMIN, true, { lastPaymentReport: ["read"] }).some((n) => n.href === "/reports/last-payment"), "its own permission grants it");
  assert.ok(!navForRole(Role.CUSTOM_ADMIN, true, { reports: ["read"] }).some((n) => n.href === "/reports/last-payment"), "the Reports permission alone no longer grants it");
  assert.ok(!navForRole(Role.CUSTOM_ADMIN, true, { dashboard: ["read"] }).some((n) => n.href === "/reports/last-payment"), "no permission → no item");
}

/* ---------------------------------- rendered page ---------------------------------- */
let requested = ""; let requestedOptions = ""; let urlQuery = ""; let servedOptions: unknown; let preset: Record<number, unknown> = {}; let stateCall = 0; let served: unknown = { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
const pageLoad = testLoader({
  // useState order: 0 search, 1 sort, 2 page, 3 pending filters, 4 Payment Aging, 5 applied filters, 6 applying
  react: { ...React, useState: (initial: unknown) => { const i = stateCall++; return [i < 7 && i in preset ? preset[i] : initial, () => {}]; } },
  "next/navigation": { useSearchParams: () => new URLSearchParams(urlQuery) },
  "@tanstack/react-query": { keepPreviousData: {}, useQuery: ({ queryKey, queryFn }: { queryKey: unknown[]; queryFn: () => unknown }) => { void queryFn(); return queryKey[0] === "last-payment-report-options" ? { data: servedOptions, isLoading: false, isFetching: false, isPlaceholderData: false, error: null } : { data: served, isLoading: false, isFetching: false, isPlaceholderData: false, error: null }; } },
  "@/lib/api-client": { api: { get: async (url: string) => { if (url.includes("optionsOnly=1")) requestedOptions = url; else requested = url; return {}; } } },
  "@/components/layout/page-header": { PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => <><h1>{title}</h1><div data-slot="actions">{actions}</div></> },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
});
const { LastPaymentReportPage } = pageLoad<typeof import("./last-payment-report-page")>("src/features/reports/last-payment-report-page.tsx");
const draw = async (c: AuthContext, over = {}, p: Record<number, unknown> = {}, url = "") => { served = await run(c, over); servedOptions = undefined; urlQuery = url; preset = p; stateCall = 0; return renderToStaticMarkup(<LastPaymentReportPage />); };

async function page() {
  let html = await draw(admin);
  // 1 — the page renders; columns appear in the required order.
  assert.ok(html.includes("Last Payment Report"));
  assert.deepEqual([...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim()), ["Party", "Status", "State", "Territory", "Sales Officer", "Last Payment Date", "Amount", "Days"]);
  const row = (id: string) => (html.match(new RegExp(`<tr[^>]*data-dealer-id="${id}"[^>]*>(.*?)</tr>`)) ?? [])[1] ?? "";
  const cells = (id: string) => [...row(id).matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());
  // 3, 6 — formatting conventions: date, ₹ currency, Days.
  assert.deepEqual(cells("d-a"), ["Alpha Traders", "Active", "MP", "BHOPAL", "Arjun Yadav", "2 Oct 2026", "₹50,000", "3"]);
  // 8 — empty representation.
  assert.deepEqual(cells("d-e"), ["Epsilon RM Dealer", "Pending", "MP", "HQ", "RM One", "—", "—", "—"]);
  assert.deepEqual(cells("d-f"), ["Zeta Unassigned", "Active", "—", "—", "—", "—", "—", "—"], "a dealer with no owner shows empty values");
  // 9, 10 — the clickable Days header with a direction indicator (default: most days first).
  assert.ok(html.includes('aria-label="Sort by Days"') && html.includes('aria-sort="descending"') && html.includes('aria-label="descending"'));
  html = await draw(admin, { sort: "days_asc" }, { 1: "days_asc" });
  assert.ok(html.includes('aria-sort="ascending"') && html.includes('aria-label="ascending"'));
  assert.deepEqual([...html.matchAll(/data-dealer-id="([^"]+)"/g)].map((m) => m[1]).slice(0, 4), ["d-b", "d-a", "d-d", "d-c"], "rows follow the server's ascending Days order");
  // 12–14 — each role renders only its scope.
  assert.deepEqual([...(await draw(rm)).matchAll(/data-dealer-id="([^"]+)"/g)].map((m) => m[1]).sort(), ["d-a", "d-b", "d-c", "d-e"]);
  assert.deepEqual([...(await draw(so)).matchAll(/data-dealer-id="([^"]+)"/g)].map((m) => m[1]), ["d-a"]);
  assert.ok((await draw(admin, { search: "zzz" })).includes("No dealers found."));
  // 1–4 — Party / State / Territory / Sales Officer are clickable filters; Last Payment Date and Amount are not; Days sorts.
  html = await draw(admin);
  assert.deepEqual([...new Set([...html.matchAll(/aria-label="Filter by ([^"]+)"/g)].map((m) => m[1]))], ["Party", "Status", "State", "Territory", "Sales Officer", "Payment Aging"]);
  assert.ok(!html.includes("Filter by Last Payment Date") && !html.includes("Filter by Amount") && !html.includes("Filter by Days"));
  assert.ok(/<th[^>]*>Last Payment Date<\/th>/.test(html) || /<th[^>]*text-right[^>]*>Last Payment Date<\/th>/.test(html), "Last Payment Date stays a plain header");
  // 16, 17 — active filters show their count; the Days sort and search state are untouched by them.
  const active = { party: ["d-a", "d-b"], state: ["MP", "CG"], officer: ["arjun"] };
  html = await draw(admin, { sort: "days_asc", search: "a", filters: active }, { 0: "a", 1: "days_asc", 3: active, 5: active });
  for (const label of ["Party (2)", "State (2)", "Sales Officer (1)"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes("Territory") && !html.includes("Territory ("), "an inactive filter shows no count");
  assert.ok(html.includes('aria-sort="ascending"'), "applying filters does not reset the Days sort");
  const url = new URL(requested, "http://x");
  assert.equal(url.searchParams.get("sort"), "days_asc"); assert.equal(url.searchParams.get("search"), "a");
  assert.deepEqual(url.searchParams.getAll("state"), ["MP", "CG"]); assert.deepEqual(url.searchParams.getAll("party"), ["d-a", "d-b"]);
  assert.deepEqual(url.searchParams.getAll("officer"), ["arjun"]); assert.deepEqual(url.searchParams.getAll("territory"), []);
  html = await draw(admin, { sort: "days_desc", filters: active }, { 1: "days_desc", 3: active, 5: active });
  assert.ok(html.includes("State (2)") && html.includes('aria-sort="descending"'), "changing the Days sort keeps the filters");
  assert.equal(new URL(requested, "http://x").searchParams.get("sort"), "days_desc");
  assert.deepEqual(new URL(requested, "http://x").searchParams.getAll("state"), ["MP", "CG"]);

  // 16, 17 — behaviour of the handlers themselves: a filter change only edits that column's selection (and returns to
  // page 1); a Days-sort change only flips the sort (and returns to page 1). Neither touches search or the other state.
  const pageSource = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  const filterHandler = pageSource.slice(pageSource.indexOf("onChange={(next) =>"), pageSource.indexOf("/>", pageSource.indexOf("onChange={(next) =>")));
  assert.ok(filterHandler.includes("setPending((current) => ({ ...current, [key]: next }))") && !/setPage|setApplied|setFilters/.test(filterHandler), "choosing a filter only edits the PENDING selection (no refetch, no page change)");
  assert.ok(!/setSort|setSearch/.test(filterHandler), "choosing a filter never resets the Days sort or search");
  const sortHandler = pageSource.slice(pageSource.indexOf('aria-label="Sort by Days"'), pageSource.indexOf("Days\n"));
  assert.ok(/setSort\(/.test(sortHandler) && !/setPending|setApplied|setSearch/.test(sortHandler), "changing the Days sort never clears filters or search");
  assert.ok(/onChange=\{\(event\) => \{ setSearch\(event\.target\.value\); setPage\(1\); \}\}/.test(pageSource), "search only edits search");

  // Payment Aging — a separate control beside the Days sort: active state shows next to Days; the sort stays as it was.
  html = await draw(admin);
  assert.ok(html.includes('aria-label="Filter by Payment Aging"') && !html.includes('data-testid="aging-active"'), "no indicator while inactive");
  const aging: PaymentAgingFilter = { operator: "gt", value: 45 };
  html = await draw(admin, { sort: "days_asc", paymentAging: aging }, { 1: "days_asc", 4: aging });
  assert.ok(/data-testid="aging-active">&gt; 45</.test(html), "active filter shows '> 45' on the Days header");
  assert.ok(html.includes('aria-sort="ascending"') && html.includes('aria-label="ascending"'), "…while the Days sort is still shown");
  assert.ok(html.includes('aria-label="Sort by Days"'), "the Days sort button remains");
  let u = new URL(requested, "http://x");
  assert.deepEqual([u.searchParams.get("paymentAgingOperator"), u.searchParams.get("paymentAgingValue"), u.searchParams.get("sort")], ["gt", "45", "days_asc"]);
  html = await draw(admin, { sort: "days_desc", search: "kr", filters: { state: ["CG"] }, paymentAging: { operator: "between", from: 30, to: 60 } }, { 0: "kr", 1: "days_desc", 3: { state: ["CG"] }, 4: { operator: "between", from: 30, to: 60 }, 5: { state: ["CG"] } });
  assert.ok(html.includes("30–60") && html.includes("State (1)") && html.includes('aria-sort="descending"'), "aging, a column filter and the sort are all shown together");
  u = new URL(requested, "http://x");
  assert.deepEqual([u.searchParams.get("paymentAgingOperator"), u.searchParams.get("paymentAgingFrom"), u.searchParams.get("paymentAgingTo"), u.searchParams.get("paymentAgingValue")], ["between", "30", "60", null]);
  assert.deepEqual([u.searchParams.get("search"), u.searchParams.getAll("state").join(), u.searchParams.get("sort")], ["kr", "CG", "days_desc"], "the other parameters are not disturbed");
  await draw(admin);
  assert.ok(![...new URL(requested, "http://x").searchParams.keys()].some((k) => k.startsWith("paymentAging")), "cleared → no aging parameters");
  // handlers: applying/clearing aging only edits aging (+ page 1); sort / search / column filters never touch it.
  assert.ok(/onChange=\{\(next\) => \{ setAging\(next\); setPage\(1\); \}\}/.test(pageSource), "aging change only sets aging and page 1");
  const sortBtn = pageSource.slice(pageSource.indexOf('aria-label="Sort by Days"'), pageSource.indexOf("<PaymentAgingFilterControl"));
  assert.ok(/setSort\(/.test(sortBtn) && !/setAging|setPending|setApplied|setSearch/.test(sortBtn), "sorting never clears aging");
  assert.ok(!/setSort|setSearch|setPending|setApplied/.test(pageSource.slice(pageSource.indexOf("<PaymentAgingFilterControl"), pageSource.indexOf("</TableHead>", pageSource.indexOf("<PaymentAgingFilterControl")))), "applying aging never resets sort / search / filters");
  const control = readFileSync("src/features/reports/payment-aging-filter.tsx", "utf8");
  assert.ok(/buildPaymentAging\(draft\)/.test(control) && /role="alert"/.test(control) && /Less than/.test(control) && /Greater than/.test(control) && /Exactly/.test(control) && /Between/.test(control) && /Apply/.test(control), "operators, validation message and Apply");

  // Read-only: no editing controls anywhere on the page.
  assert.ok(!/<input[^>]*type="(checkbox|number)"|<textarea|<select/.test(await draw(admin)) && !(await draw(admin)).includes("Save"));
}

/* ---------------------------------- wiring / unchanged behaviour ---------------------------------- */
function wiring() {
  const read = (p: string) => readFileSync(p, "utf8");
  const server = read("src/features/reports/last-payment-report.server.ts");
  // 19 — a single calculation: the report imports the existing helper and has no receipt query/selection of its own.
  assert.ok(server.includes('import { latestReceiptAsOfByDealer } from "@/lib/last-payment.server"'));
  assert.ok(!/lastPaymentReceipt|RecoveryPlanDealer|latestReceiptAsOf\(|\$queryRaw/.test(server.replace(/latestReceiptAsOfByDealer/g, "")), "no second Last Payment implementation");
  const route = read("src/app/api/reports/last-payment/route.ts");
  assert.ok(route.includes("await requireAuth()") && route.includes("parseLastPaymentReportParams") && !/officer|scope/i.test(route.replace(/ctx|Scope comes from/g, "")), "scope is the session's; the route reads no officer parameter");
  // 17 — Recovery's Last Payment path is the same, untouched helper.
  const recovery = read("src/features/recovery/service.server.ts");
  assert.ok(recovery.includes('import { latestReceiptAsOfByDealer } from "@/lib/last-payment.server"') && recovery.includes("latestReceiptAsOfByDealer(recoveryDealerIds, lastPaymentEnd)"));
  // 18/20 — the Day Book upload and the existing Reports page are not touched by this feature.
  assert.ok(read("src/app/(dashboard)/reports/page.tsx").includes("<ReportsPage />"));
}

service().then(() => filters()).then(() => paymentAging()).then(() => cascading()).then(() => statusFilter()).then(() => lastUpdate()).then(() => exportTests()).then(() => applyWorkflow()).then(() => { sidebar(); return page(); }).then(() => { wiring(); console.log("last-payment-report.test.tsx — all assertions passed"); })
  .catch((error) => { console.error(error); process.exitCode = 1; });
