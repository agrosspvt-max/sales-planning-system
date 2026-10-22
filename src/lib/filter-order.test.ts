/**
 * Standalone filters run from the broadest scope to the narrowest (State → Sales Officer → Market → Dealer) on every screen that has them — and each child resets when its parent changes.
 * Column-header filters, record-editing fields and workflow controls are out of scope. (Behaviour is covered by the screen suites and filter-scope.integration.ts.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const before = (src: string, a: string | RegExp, b: string | RegExp, msg: string) => {
  const ia = typeof a === "string" ? src.indexOf(a) : src.search(a), ib = typeof b === "string" ? src.indexOf(b) : src.search(b);
  assert.ok(ia >= 0 && ib >= 0, `${msg}: both filters exist (${String(a)} / ${String(b)})`);
  assert.ok(ia < ib, `${msg}: ${String(a)} must come before ${String(b)}`);
};

// Territory Mapping → Existing Dealers: State → Sales Officer → Market, parents clear children.
const territory = read("src/features/party-planning/territory-mapping-page.tsx");
const existing = territory.slice(territory.indexOf("function ExistingDealers("), territory.indexOf("function ImportDialog("));
before(existing, "<Label>{L.state}</Label>", "<Label>{L.officer}</Label>", "Territory: State before Sales Officer");
before(existing, "<Label>{L.officer}</Label>", "<Label>{L.market}</Label>", "Territory: Sales Officer before Market");
assert.ok(/const changeState[\s\S]{0,200}setMarket\(""\)/.test(existing) && /const changeOfficer = \(next: string\) => \{ setOfficer\(next\); setMarket\(""\)/.test(existing), "Territory: changing State / Sales Officer clears the dependent Market (and page 1)");
assert.ok(existing.includes('queryKey: ["territory-market-filter", state, officer]'), "Territory: Market choices are requested per (State, Sales Officer) — a stale answer cannot replace newer choices");

// Calendar: State → Sales Officer; State clears the officer.
const calendar = read("src/features/calendar/calendar-view.tsx");
before(calendar, "aria-label={L.allStates}", "aria-label={L.salesOfficer}", "Calendar");
assert.ok(calendar.includes('onChange={(e) => { setGroupId(e.target.value); setOfficerId(""); }}'), "Calendar: State clears the officer");
// Performance → Tasks: State → Employee (State change clears the employee).
const tasks = read("src/features/tasks/task-analysis-view.tsx");
before(tasks, "<Label>{L.state}</Label>", "<Label>{L.employee}</Label>", "Tasks");
assert.ok(tasks.includes('set({ groupId: e.target.value, officerId: "", focusDate: null })'), "Tasks: State clears the employee");
// Admin Daily Work viewer: State → Sales Officer.
const viewer = read("src/features/daily-work/admin-daily-work-viewer.tsx");
before(viewer, "<Label>{L.state}</Label>", "<Label>{L.officer}</Label>", "Daily Work viewer");
// Dealer coverage: Group (State) → Sales Officer.
const coverage = read("src/features/sales-upload/dealer-coverage-panel.tsx");
before(coverage, 'label: "All Groups"', 'label: "All Sales Officers"', "Dealer coverage");
assert.ok(coverage.includes('setGroupId(e.target.value); setOfficerId("");'), "Dealer coverage: the group clears the officer");
// Payments: State → Sales Officer, State clears the officer, State is an id (not a name).
const payments = read("src/features/schemes/scheme-payments-page.tsx");
before(payments, "<Label>State</Label>", "<Label>Sales Officer</Label>", "Payments");
assert.ok(payments.includes('setState(e.target.value); setOfficerId("");') && payments.includes('p.set("stateId", state)'), "Payments: State (by id) clears the officer");
// Vacant Market: State dropdown above the table; District / Requested by are column-header filters.
const vacant = territory.slice(territory.indexOf("export function AddMarket("));
before(vacant, 'ariaLabel={T.stateLabel}', "<ColumnFilterHeader", "Vacant Market");
// The server never lets a filter widen the scope.
const paymentsServer = read("src/features/schemes/scheme-payments.server.ts");
assert.ok(!/\.\.\.\(f\.officerId \? \{ salesOfficerId/.test(paymentsServer) && paymentsServer.includes("AND: [inScope"), "Payments: the officer / State filters are ANDed with the caller's scope");
assert.ok(!/group: \{ name: f\.state/.test(paymentsServer), "Payments: no filtering by State NAME");
console.log("filter-order.test.ts — all assertions passed");
