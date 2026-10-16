/**
 * Calendar selected-day list — the REAL CalendarView rendered for one date (the same component serves the desktop panel and the phone agenda).
 *   npx tsx src/features/calendar/calendar-day-list-ui.test.tsx
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS, type LabelKey } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

const DAY = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 3); return d.toISOString().slice(0, 10); })(); // always a future day (Add Task is disabled for past dates)
let selectedDay = DAY;
let overrides: Record<string, string> = {};
let payload: Record<string, unknown> = {};
let expandAll = true;
const dealerQuery: { id: string; name: string }[] = [];
const text = (k: LabelKey) => overrides[k] ?? DEFAULT_LABELS[k];
const entry = (id: string, ownerId: string, ownerName: string, over: Record<string, unknown> = {}) => ({
  id, dateKey: DAY, kind: "TASK", text: null, ownerId, ownerName, ownerRole: "SALES_OFFICER", ownerRoleLabel: "Sales Officer", ownerState: "CG", assignedBy: null,
  task: { section: "RECOVERY", dealerId: "d1", dealerName: "ABC Traders", amount: 25000, paymentMode: "UPI", typedDealerName: null, marketName: null, dealerVisits: null, newPartyVisits: null, entryType: "REGULAR", schemeName: null },
  materialized: false, canEdit: false, canDelete: true, createdAt: `2026-10-10T10:00:0${id.length}Z`, ...over,
});
const billing = { id: "bt1", billingExceptionId: "be1", dateKey: DAY, dealerId: "d9", dealerName: "Billing Dealer", amount: 12000, taskType: "BILLING_EXCEPTION", ownerId: "so1", ownerName: "Suresh Verma", promisedDate: DAY, rescheduled: true, status: "SCHEDULED", confirmed: false };
const people = { so1: { role: "SALES_OFFICER", territory: "Raigarh", state: "CG" }, so2: { role: "SALES_OFFICER", territory: null, state: null }, so3: { role: "SALES_OFFICER", territory: "Bhopal", state: "MP" }, admin: { role: "SUPER_ADMIN", territory: null, state: null } };
const base = (over: Record<string, unknown> = {}) => ({
  events: [], partyEvents: [], notes: [], entries: [], billingTasks: [], canFilterOfficers: true, officers: [{ id: "so1", name: "Suresh Verma", role: "SALES_OFFICER", roleLabel: "Sales Officer", groupId: "g1" }, { id: "so2", name: "Suresh Verma", role: "SALES_OFFICER", roleLabel: "Sales Officer", groupId: null }],
  states: [], view: "team", canTeamView: false, taskSections: ["SALES", "RECOVERY", "APPOINTMENT", "VISITS", "OTHERS"], paymentModes: ["UPI"], myDealers: [], people, canAssign: true, ...over,
});
const load = testLoader({
  react: { ...React, useState: (i: unknown) => [i instanceof Set ? new Set(expandAll ? ["so1", "so2", "so3", "admin"] : []) : i, () => {}] },
  "next/navigation": { useSearchParams: () => new URLSearchParams(`date=${selectedDay}`) },
  "next/link": { __esModule: true, default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> },
  "@tanstack/react-query": {
    useQuery: ({ queryKey }: { queryKey: unknown[] }) => (queryKey[1] === "recipient-dealers" ? { data: dealerQuery } : { data: payload, isLoading: false }),
    useMutation: () => ({ mutate: () => {}, isPending: false }), useQueryClient: () => ({ invalidateQueries: () => {} }),
  },
  "@/lib/api-client": { api: { get: async () => ({}), post: async () => ({}), patch: async () => ({}), del: async () => ({}) } },
  "@/features/labels/label-ui": { useLabel: (k: LabelKey) => text(k) },
  "@/components/layout/page-header": { PageHeader: () => null },
  "@/features/dealers/dealer-table-ui": { useTaggedDealersFirst: () => (rows: unknown[]) => rows },
  "@/features/dealers/dealer-name-ui": { DealerName: ({ name }: { name: string }) => <>{name}</>, useDealerMarkers: () => ({}) },
  "@/features/calendar/party-link": { PartyLink: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  "@/features/daily-work/billing-task-ui": { BillingTaskDetailDialog: () => null },
});
const { CalendarView } = load<typeof import("./calendar-view")>("src/features/calendar/calendar-view.tsx");
const render = (role: Role) => renderToStaticMarkup(<CalendarView role={role} userId="admin" />);
const norm = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
let n = 0; const ok = (m: string) => { n++; console.log(`  ok - ${m}`); };
const section = (html: string, id: string) => { const i = html.indexOf(`data-employee-id="${id}"`); const j = html.indexOf('data-employee-id="', i + 10); return html.slice(i, j < 0 ? undefined : j); };

async function main() {
  // Suresh (so1): Manual Regular + Manual Scheme Recovery, a Manual Visits task, an Auto Billing Exception task, a reminder. Suresh (so2, same name): one task. Admin: personal reminder.
  payload = base({
    entries: [
      entry("a1", "so1", "Suresh Verma"),
      entry("a22", "so1", "Suresh Verma", { task: { section: "RECOVERY", dealerId: "d2", dealerName: "XYZ Stores", amount: 8000, paymentMode: null, typedDealerName: null, marketName: null, dealerVisits: null, newPartyVisits: null, entryType: "SCHEME", schemeName: "Monsoon Offer" } }),
      entry("a333", "so1", "Suresh Verma", { task: { section: "VISITS", dealerId: null, dealerName: null, amount: null, paymentMode: null, typedDealerName: null, marketName: null, dealerVisits: 2, newPartyVisits: 1, entryType: null, schemeName: null }, assignedBy: { id: "admin", name: "Head Office", roleLabel: "Admin" }, materialized: true, canDelete: false }),
      entry("r1", "so1", "Suresh Verma", { kind: "REMINDER", text: "Call the dealers", task: null }),
      entry("b1", "so2", "Suresh Verma", { task: { section: "SALES", dealerId: "d3", dealerName: "Sales Dealer", amount: 500, paymentMode: null, typedDealerName: null, marketName: null, dealerVisits: null, newPartyVisits: null, entryType: "REGULAR", schemeName: null } }),
      entry("ar", "admin", "Head Office", { kind: "REMINDER", text: "Board meeting prep", task: null, ownerRole: "SUPER_ADMIN", ownerRoleLabel: "Admin", ownerState: null }),
    ],
    billingTasks: [billing],
  });
  const html = render(Role.SUPER_ADMIN);

  // 1. Headings: type + real section + real subtype, no redundant metadata lines.
  const headings = [...html.matchAll(/data-testid="item-heading">([^<]*)</g)].map((m) => m[1]);
  assert.ok(headings.includes("Manual Task - Recovery [Regular]") && headings.includes("Manual Task - Recovery [Scheme]") && headings.includes("Auto Task - Recovery [Billing Exception]"), headings.join(" | "));
  assert.ok(headings.includes("Manual Task - Visits") && headings.includes("Manual Task - Sales [Regular]"), "no brackets for a section without a subtype");
  assert.ok(headings.includes("Reminder"), "a reminder keeps its own name");
  assert.ok(!headings.some((h) => /Calendar/.test(h!)) && !/Calendar Task/.test(html) && !/Task Type:|Recovery Type:/.test(norm(html)), "no 'Calendar' type, no Task Type / Recovery Type line");
  assert.ok(!/Scheduled date/.test(norm(html)) && !/Sales Officer:\s*Suresh/.test(norm(html)), "no 'Sales Officer: … Scheduled date: …' line");
  const bill = html.slice(html.indexOf('data-testid="calendar-billing-task"'));
  assert.ok(bill.includes("Billing Dealer") && bill.includes("12,000") && bill.includes("Rescheduled") && bill.includes("Scheduled") && bill.includes("View details"), "billing task keeps dealer, amount, badges and its action");
  assert.ok(html.includes("Scheme: Monsoon Offer") && html.includes("Payment Mode") && html.includes("In Daily Work") && html.includes("Dealer Visits"), "useful details are kept");
  assert.ok(/data-testid="assigned-by">Assigned by: Head Office \(Admin\)/.test(html), "Admin-assigned work keeps its creator");
  assert.ok(!/data-testid="assigned-by">[^<]*Suresh/.test(html), "no 'added by' line for work the employee created themselves");
  ok("headings follow Manual / Auto + real section + real subtype; redundant lines removed; useful details and attribution kept");

  // 2. Employee headers: Name [Territory] State from each employee's own profile; identical names stay separate.
  const heads = [...html.matchAll(/data-testid="employee-header">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(heads, ["Head Office", "Suresh Verma [Raigarh] CG", "Suresh Verma"], "sorted, stable ids: the two Sureshes are separate groups; missing profile values leave no brackets / 'undefined'");
  assert.ok(!/undefined|null|\[\]/.test(heads.join(" ")));
  ok("accordion headers: Name [Territory] State, graceful when missing, identical names kept apart");

  // 3. One shared numbered list per employee (1, 2, 3 …, restarting for each employee), no per-task boxes.
  const nums = (id: string) => [...section(html, id).matchAll(/data-testid="item-number">(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(nums("so1"), [1, 2, 3, 4, 5], "Suresh: Auto billing, 3 manual tasks, reminder → 1..5"); assert.deepEqual(nums("so2"), [1]); assert.deepEqual(nums("admin"), [1]);
  assert.equal((section(html, "so1").match(/<ol/g) ?? []).length, 1, "ONE list inside the employee container");
  assert.ok(!/rounded-md border bg-card p-3/.test(section(html, "so1")), "no bordered box per task");
  const so1Heads = [...section(html, "so1").matchAll(/data-testid="item-heading">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(so1Heads, ["Auto Task - Recovery [Billing Exception]", "Manual Task - Recovery [Regular]", "Manual Task - Recovery [Scheme]", "Manual Task - Visits", "Reminder"], "deterministic order");
  assert.equal(render(Role.SUPER_ADMIN), html, "re-rendering gives the same numbering");
  ok("one numbered list per employee, restarting at 1, deterministic");

  // 4. Totals for Admin and RM (independent of expansion); none for an SO; zero on an empty date.
  assert.ok(html.includes('data-testid="day-totals">No of SO: 2 No of Task: 7<'), "2 Sales Officers; 7 items (the Admin reminder is a task item, not an SO)");
  expandAll = false;
  const collapsed = render(Role.SUPER_ADMIN);
  assert.ok(collapsed.includes("No of SO: 2 No of Task: 7") && !collapsed.includes('data-testid="item-number"'), "totals do not depend on expansion");
  expandAll = true;
  assert.ok(render(Role.REGIONAL_MANAGER).includes("No of SO: 2 No of Task: 7"), "RM sees them too");
  payload = base({ canFilterOfficers: false, canAssign: false, entries: [entry("s1", "so1", "Suresh Verma")], people: { so1: people.so1 } });
  assert.ok(!render(Role.SALES_OFFICER).includes('data-testid="day-totals"'), "a Sales Officer has no totals");
  payload = base({ entries: [], billingTasks: [] });
  assert.ok(render(Role.SUPER_ADMIN).includes("No of SO: 0 No of Task: 0") && render(Role.SUPER_ADMIN).includes('data-testid="day-empty"'), "empty date → zero");
  payload = base({ officers: [], billingTasks: [billing, { ...billing }], entries: [entry("a1", "so1", "Suresh Verma"), entry("a1", "so1", "Suresh Verma"), entry("a2", "so1", "Suresh Verma")] });
  assert.ok(render(Role.SUPER_ADMIN).includes("No of SO: 1 No of Task: 3"), "the same record twice counts once; a genuinely separate one stays");
  ok("totals: Admin / RM only, by Sales Officer and by item, independent of expansion, zero when empty, no double counting");

  // 5. Heading templates, subtype and totals wording come from Edit Labels.
  overrides = { "calendar.heading.manual_sub": "Hand-made {section} / {subtype}", "calendar.heading.auto_sub": "System {section} / {subtype}", "calendar.subtype.regular": "Normal", "calendar.subtype.billing_exception": "Bill Exc", "calendar.totals": "SOs {officers} · Items {tasks}", "calendar.assigned_by": "Given by" };
  payload = base({ entries: [entry("a1", "so1", "Suresh Verma", { assignedBy: { id: "admin", name: "Head Office", roleLabel: "Admin" }, canDelete: false })], billingTasks: [billing] });
  const custom = render(Role.SUPER_ADMIN);
  assert.ok(custom.includes("Hand-made Recovery / Normal") && custom.includes("System Recovery / Bill Exc") && custom.includes("SOs 1 · Items 2") && custom.includes("Given by: Head Office"), "customised labels are what is displayed");
  overrides = {};
  ok("heading templates, subtypes, totals and attribution follow Edit Labels");

  // 6. Admin assignment form: Add Task + Add Reminder for Admin; Sales Officer selector; recipient's dealers; SO / RM unchanged.
  payload = base({ entries: [] });
  const adminHtml = render(Role.SUPER_ADMIN);
  const taskButton = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]).find((b) => b.includes("Add Daily Task"))!;
  assert.ok(!taskButton(adminHtml).includes("disabled="), "Admin Add Task is enabled for a future date");
  selectedDay = "2020-01-01";
  const pastHtml = render(Role.SUPER_ADMIN);
  assert.ok(taskButton(pastHtml).includes("disabled="), "past dates deliberately block task creation");
  assert.ok(norm(pastHtml).includes(DEFAULT_LABELS["calendar.task_past_date"]), "the reason is visible, not only a tooltip");
  selectedDay = DAY;
  assert.ok(adminHtml.includes("Add Daily Task") && adminHtml.includes("Add Reminder"), "Admin has both actions");
  payload = base({ canFilterOfficers: false, canAssign: false, myDealers: [{ id: "d1", name: "Mine" }] });
  const soHtml = render(Role.SALES_OFFICER);
  assert.ok(soHtml.includes("Add Daily Task") && soHtml.includes("Add Reminder") && !soHtml.includes("Select a Sales Officer"), "SO: unchanged, no recipient selector");
  const rmHtml = render(Role.REGIONAL_MANAGER); assert.ok(rmHtml.includes("Add Daily Task") && !rmHtml.includes("Select a Sales Officer"), "RM: no assignment ability");
  const src = (await import("node:fs")).readFileSync("src/features/calendar/calendar-view.tsx", "utf8");
  assert.ok(src.includes("needsRecipient = canAssign && kind === \"TASK\"") && src.includes("enabled: needsRecipient && recipientId !== \"\" && dealerSection") && src.includes("...(assigning ? { ownerId: recipientId } : {})"), "Admin form: recipient required for a task, dealers loaded for the RECIPIENT, ownerId sent only when assigning");
  assert.ok(src.includes('o.role === "SALES_OFFICER" || o.role === "REGIONAL_MANAGER"'), "Admin recipient selector offers both SO and RM, never Admin");
  ok("Admin Add Task supports SO/RM recipients; past dates show why the action is disabled");
  console.log(`calendar-day-list-ui.test.tsx — ${n} groups passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
