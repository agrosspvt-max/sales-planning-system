/** Last Payment Report: reuse of the Recovery Last Payment source, Days, sorting, scope, sidebar and rendered page. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { TestApiError, testLoader } from "@/features/dealer-tags/test-loader";
import { navForRole } from "@/features/navigation/nav";
import { resolveNavState } from "@/features/navigation/nav-state";
import {
  applyPaymentAging, buildPaymentAging, calendarDaysBetween, daysSincePayment, matchesPaymentAging, parseAgingDays, parseLastPaymentReportParams,
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
  { id: "d-a", name: "Alpha Traders", isActive: true }, { id: "d-b", name: "Beta Stores", isActive: true },
  { id: "d-c", name: "Gamma Agro", isActive: true }, { id: "d-d", name: "Delta Outside", isActive: true },
  { id: "d-e", name: "Epsilon RM Dealer", isActive: true }, { id: "d-f", name: "Zeta Unassigned", isActive: true },
  { id: "d-h", name: "Eta Reassigned", isActive: true }, { id: "d-i", name: "Iota Inactive", isActive: false },
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
  lastPaymentReceipt: {
    findMany: async ({ where }: { where: { dealerId: { in: string[] }; receiptDate: { lte: Date } } }) => {
      queries.history++;
      return history.filter((r) => r.active && where.dealerId.in.includes(r.dealerId) && r.date <= where.receiptDate.lte.toISOString().slice(0, 10))
        .map((r) => ({ dealerId: r.dealerId, receiptDate: new Date(`${r.date}T00:00:00.000Z`), creditAmount: r.amount }));
    },
  },
};
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/scope": {
    getOfficerScope: async (c: AuthContext) => { const ids = scopeIds[c.userId]; return ids === "all" ? { all: true, ids: [] } : { all: false, ids }; },
    getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.filter((id) => currentOwner(id)).map((id) => [id, currentOwner(id)!])),
  },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map([["d-b", "Beta Alias"]]) }, // display name = alias ?? name
});
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
  assert.deepEqual(plain(byId["d-a"]), { dealerId: "d-a", party: "Alpha Traders", state: "MP", territory: "BHOPAL", salesOfficer: "Arjun Yadav", lastPaymentDate: "2026-10-02", amount: 50000, days: 3 });
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
  assert.deepEqual(rowsOf(await f(admin, { state: ["CG"], officer: ["arjun"] })), [], "never OR across different filters");
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
  assert.deepEqual(plain((await f(rm, { state: ["MP"] }, { search: "agro" })).options), plain(rmOpts), "options stay stable while filtering/searching");
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
  assert.ok(navForRole(Role.CUSTOM_ADMIN, true, { reports: ["read"] }).some((n) => n.href === "/reports/last-payment"), "Reports permission grants it");
  assert.ok(!navForRole(Role.CUSTOM_ADMIN, true, { dashboard: ["read"] }).some((n) => n.href === "/reports/last-payment"), "no Reports permission → no item");
}

/* ---------------------------------- rendered page ---------------------------------- */
let requested = ""; let preset: Record<number, unknown> = {}; let stateCall = 0; let served: unknown = { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
const pageLoad = testLoader({
  react: { ...React, useState: (initial: unknown) => { const i = stateCall++; return [i < 5 && i in preset ? preset[i] : initial, () => {}]; } }, // search, sort, page, filters, aging
  "@tanstack/react-query": { keepPreviousData: {}, useQuery: ({ queryFn }: { queryFn: () => unknown }) => { void queryFn(); return { data: served, isLoading: false, error: null }; } },
  "@/lib/api-client": { api: { get: async (url: string) => { requested = url; return {}; } } },
  "@/components/layout/page-header": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/features/dealers/dealer-table-ui": { DealerTableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody> },
});
const { LastPaymentReportPage } = pageLoad<typeof import("./last-payment-report-page")>("src/features/reports/last-payment-report-page.tsx");
const draw = async (c: AuthContext, over = {}, p: Record<number, unknown> = {}) => { served = await run(c, over); preset = p; stateCall = 0; return renderToStaticMarkup(<LastPaymentReportPage />); };

async function page() {
  let html = await draw(admin);
  // 1 — the page renders; columns appear in the required order.
  assert.ok(html.includes("Last Payment Report"));
  assert.deepEqual([...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim()), ["Party", "State", "Territory", "Sales Officer", "Last Payment Date", "Amount", "Days"]);
  const row = (id: string) => (html.match(new RegExp(`<tr[^>]*data-dealer-id="${id}"[^>]*>(.*?)</tr>`)) ?? [])[1] ?? "";
  const cells = (id: string) => [...row(id).matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());
  // 3, 6 — formatting conventions: date, ₹ currency, Days.
  assert.deepEqual(cells("d-a"), ["Alpha Traders", "MP", "BHOPAL", "Arjun Yadav", "2 Oct 2026", "₹50,000", "3"]);
  // 8 — empty representation.
  assert.deepEqual(cells("d-e"), ["Epsilon RM Dealer", "MP", "HQ", "RM One", "—", "—", "—"]);
  assert.deepEqual(cells("d-f"), ["Zeta Unassigned", "—", "—", "—", "—", "—", "—"], "a dealer with no owner shows empty values");
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
  assert.deepEqual([...new Set([...html.matchAll(/aria-label="Filter by ([^"]+)"/g)].map((m) => m[1]))], ["Party", "State", "Territory", "Sales Officer", "Payment Aging"]);
  assert.ok(!html.includes("Filter by Last Payment Date") && !html.includes("Filter by Amount") && !html.includes("Filter by Days"));
  assert.ok(/<th[^>]*>Last Payment Date<\/th>/.test(html) || /<th[^>]*text-right[^>]*>Last Payment Date<\/th>/.test(html), "Last Payment Date stays a plain header");
  // 16, 17 — active filters show their count; the Days sort and search state are untouched by them.
  const active = { party: ["d-a", "d-b"], state: ["MP", "CG"], officer: ["arjun"] };
  html = await draw(admin, { sort: "days_asc", search: "a", filters: active }, { 0: "a", 1: "days_asc", 3: active });
  for (const label of ["Party (2)", "State (2)", "Sales Officer (1)"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes("Territory") && !html.includes("Territory ("), "an inactive filter shows no count");
  assert.ok(html.includes('aria-sort="ascending"'), "applying filters does not reset the Days sort");
  const url = new URL(requested, "http://x");
  assert.equal(url.searchParams.get("sort"), "days_asc"); assert.equal(url.searchParams.get("search"), "a");
  assert.deepEqual(url.searchParams.getAll("state"), ["MP", "CG"]); assert.deepEqual(url.searchParams.getAll("party"), ["d-a", "d-b"]);
  assert.deepEqual(url.searchParams.getAll("officer"), ["arjun"]); assert.deepEqual(url.searchParams.getAll("territory"), []);
  html = await draw(admin, { sort: "days_desc", filters: active }, { 1: "days_desc", 3: active });
  assert.ok(html.includes("State (2)") && html.includes('aria-sort="descending"'), "changing the Days sort keeps the filters");
  assert.equal(new URL(requested, "http://x").searchParams.get("sort"), "days_desc");
  assert.deepEqual(new URL(requested, "http://x").searchParams.getAll("state"), ["MP", "CG"]);

  // 16, 17 — behaviour of the handlers themselves: a filter change only edits that column's selection (and returns to
  // page 1); a Days-sort change only flips the sort (and returns to page 1). Neither touches search or the other state.
  const pageSource = readFileSync("src/features/reports/last-payment-report-page.tsx", "utf8");
  const filterHandler = pageSource.slice(pageSource.indexOf("onChange={(next) =>"), pageSource.indexOf("/>", pageSource.indexOf("onChange={(next) =>")));
  assert.ok(filterHandler.includes("setFilters((current) => ({ ...current, [key]: next }))") && filterHandler.includes("setPage(1)"), "filter change merges into the existing filters");
  assert.ok(!/setSort|setSearch/.test(filterHandler), "applying a filter never resets the Days sort or search");
  const sortHandler = pageSource.slice(pageSource.indexOf('aria-label="Sort by Days"'), pageSource.indexOf("Days\n"));
  assert.ok(/setSort\(/.test(sortHandler) && !/setFilters|setSearch/.test(sortHandler), "changing the Days sort never clears filters or search");
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
  html = await draw(admin, { sort: "days_desc", search: "kr", filters: { state: ["CG"] }, paymentAging: { operator: "between", from: 30, to: 60 } }, { 0: "kr", 1: "days_desc", 3: { state: ["CG"] }, 4: { operator: "between", from: 30, to: 60 } });
  assert.ok(html.includes("30–60") && html.includes("State (1)") && html.includes('aria-sort="descending"'), "aging, a column filter and the sort are all shown together");
  u = new URL(requested, "http://x");
  assert.deepEqual([u.searchParams.get("paymentAgingOperator"), u.searchParams.get("paymentAgingFrom"), u.searchParams.get("paymentAgingTo"), u.searchParams.get("paymentAgingValue")], ["between", "30", "60", null]);
  assert.deepEqual([u.searchParams.get("search"), u.searchParams.getAll("state").join(), u.searchParams.get("sort")], ["kr", "CG", "days_desc"], "the other parameters are not disturbed");
  await draw(admin);
  assert.ok(![...new URL(requested, "http://x").searchParams.keys()].some((k) => k.startsWith("paymentAging")), "cleared → no aging parameters");
  // handlers: applying/clearing aging only edits aging (+ page 1); sort / search / column filters never touch it.
  assert.ok(/onChange=\{\(next\) => \{ setAging\(next\); setPage\(1\); \}\}/.test(pageSource), "aging change only sets aging and page 1");
  const sortBtn = pageSource.slice(pageSource.indexOf('aria-label="Sort by Days"'), pageSource.indexOf("<PaymentAgingFilterControl"));
  assert.ok(/setSort\(/.test(sortBtn) && !/setAging|setFilters|setSearch/.test(sortBtn), "sorting never clears aging");
  assert.ok(!/setSort|setSearch|setFilters/.test(pageSource.slice(pageSource.indexOf("<PaymentAgingFilterControl"), pageSource.indexOf("</TableHead>", pageSource.indexOf("<PaymentAgingFilterControl")))), "applying aging never resets sort / search / filters");
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

service().then(() => filters()).then(() => paymentAging()).then(() => { sidebar(); return page(); }).then(() => { wiring(); console.log("last-payment-report.test.tsx — all assertions passed"); })
  .catch((error) => { console.error(error); process.exitCode = 1; });
