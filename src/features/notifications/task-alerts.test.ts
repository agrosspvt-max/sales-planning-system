/**
 * New automatic task / new Billing Exception alerts — the REAL task-alerts + links modules over a DB-free fake.
 *   npx tsx src/features/notifications/task-alerts.test.ts
 * (The flows that call them are covered where they live: billing-exception.test.tsx, calendar-entries.test.ts, cn-requests.test.ts.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { testLoader } from "@/features/dealer-tags/test-loader";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const users: Record<string, Row> = {
  so1: { id: "so1", name: "Arjun", role: Role.SALES_OFFICER, isActive: true, deletedAt: null, groupId: "g1" },
  soInactive: { id: "soInactive", name: "Gone", role: Role.SALES_OFFICER, isActive: false, deletedAt: null, groupId: "g1" },
  rm1: { id: "rm1", name: "Santosh", role: Role.REGIONAL_MANAGER, isActive: true, deletedAt: null, groupId: "g1" },
  so9: { id: "so9", name: "Lonely", role: Role.SALES_OFFICER, isActive: true, deletedAt: null, groupId: "g9" }, // group without an RM
  admin: { id: "admin", name: "Admin", role: Role.SUPER_ADMIN, isActive: true, deletedAt: null, groupId: null },
  admin2: { id: "admin2", name: "Admin 2", role: Role.SUPER_ADMIN, isActive: true, deletedAt: null, groupId: null },
  adminOff: { id: "adminOff", name: "Retired", role: Role.SUPER_ADMIN, isActive: false, deletedAt: null, groupId: null },
  other: { id: "other", name: "Unrelated SO", role: Role.SALES_OFFICER, isActive: true, deletedAt: null, groupId: "g2" },
  otherRm: { id: "otherRm", name: "Unrelated RM", role: Role.REGIONAL_MANAGER, isActive: true, deletedAt: null, groupId: "g2" },
};
let created: Row[] = [];
const db = {
  user: {
    findUnique: async ({ where }: Row) => users[where.id] ?? null,
    findMany: async ({ where }: Row) => Object.values(users).filter((u) => u.role === where.role && u.isActive === where.isActive && u.deletedAt === where.deletedAt).map((u) => ({ id: u.id })),
    findFirst: async ({ where }: Row) => Object.values(users).find((u) => u.role === where.role && u.groupId === where.groupId && u.isActive && !u.deletedAt && u.id !== where.id.not) ?? null,
  },
  dealer: { findUnique: async ({ where }: Row) => (where.id === "d1" ? { name: "Alpha Traders" } : null) },
  dealerMarketMapping: { findUnique: async ({ where }: Row) => (where.dealerId === "d1" ? { marketText: null, market: { name: "Pipariya" } } : null) },
  notification: { createMany: async ({ data }: { data: Row[] }) => { created.push(...data); return { count: data.length }; } },
  billingExceptionTask: { findMany: async ({ where }: Row) => tasks.filter((t) => where.id.in.includes(t.id)) },
  cnPaymentEvent: { findMany: async ({ where }: Row) => events.filter((t) => where.id.in.includes(t.id)) },
  calendarEntry: { findMany: async ({ where }: Row) => entries.filter((t) => where.id.in.includes(t.id)) },
};
const tasks: Row[] = [{ id: "bt1", taskDate: new Date("2026-11-20T00:00:00Z") }];
const events: Row[] = [{ id: "ev1", taskDate: new Date("2026-11-03T00:00:00Z") }, { id: "ev2", taskDate: null }];
const entries: Row[] = [{ id: "ce1", date: new Date("2026-12-01T00:00:00Z") }];
let overrides: Record<string, string> = {};
const load = testLoader({
  "@/lib/prisma": { prisma: db },
  "@/features/labels/service.server": { getResolvedLabels: async () => ({ ...DEFAULT_LABELS, ...overrides }) },
  // The real Regional-Manager lookup (same query shape as scope.getCurrentManagerId), without the rest of scope.
  "@/lib/scope": {
    getCurrentManagerId: async (officerId: string, client: typeof db) => { const o = await client.user.findUnique({ where: { id: officerId } } as Row); return o?.groupId ? ((await client.user.findFirst({ where: { role: "REGIONAL_MANAGER", groupId: o.groupId, id: { not: officerId } } } as Row))?.id ?? null) : null; },
    getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.filter((i) => i === "d1").map((i) => [i, "so1"])),
  },
});
const alerts = load<typeof import("./task-alerts.server")>("src/features/notifications/task-alerts.server.ts");
const links = load<typeof import("./links.server")>("src/features/notifications/links.server.ts");
const ids = () => created.map((n) => n.userId).sort();
const labels = async () => alerts.alertLabels();
let n = 0; const ok = (m: string) => { n++; console.log(`  ok - ${m}`); };

async function main() {
  // Recipients: SO + that SO's RM + active admins; deduplicated; nobody unrelated.
  const r = async (owner: string | null) => [...(await alerts.alertRecipients(db as never, owner))].sort();
  assert.deepEqual(await r("so1"), ["admin", "admin2", "rm1", "so1"]);
  assert.deepEqual(await r("rm1"), ["admin", "admin2", "rm1"], "RM-owned: the RM + admins (no second RM)");
  assert.deepEqual(await r("so9"), ["admin", "admin2", "so9"], "no RM in the group: SO + admins");
  assert.deepEqual(await r("soInactive"), ["admin", "admin2"], "inactive owner is not notified");
  assert.deepEqual(await r(null), ["admin", "admin2"], "no assignment: admins only");
  assert.deepEqual(await r("nobody"), ["admin", "admin2"], "unknown owner id: admins only");
  for (const who of await r("so1")) assert.ok(!["other", "otherRm", "adminOff", "so9"].includes(who));
  ok("recipients: SO, RM, admins; RM-owned; missing RM / owner; inactive and unrelated users excluded; no duplicates");

  // Auto task: source → section, dealer, market, employee, DD/MM/YYYY, planned amount; future dates alert immediately.
  created = [];
  await alerts.notifyAutoTaskCreated(db as never, await labels(), { source: "CN", section: "RECOVERY", ownerId: "so1", dealerId: "d1", date: "2027-01-05", amount: 12000, entityType: "CnPaymentEvent", entityId: "ev1" });
  assert.deepEqual(ids(), ["admin", "admin2", "rm1", "so1"]);
  const t = created[0];
  assert.equal(t.title, "New automatic task");
  for (const part of ["CN Request → Recovery", "Alpha Traders", "Arjun", "05/01/2027", "Market: Pipariya", "Planned amount: ₹12,000"]) assert.ok(t.message.includes(part), `${part} in ${t.message}`);
  assert.ok(!/2027-01-05/.test(t.message), "no ISO date in the text");
  assert.deepEqual([t.type, t.relatedEntityType, t.relatedEntityId], ["SYSTEM", "CnPaymentEvent", "ev1"]);
  assert.ok(!("isRead" in t), "created unread (database default false) → counted in the bell badge");
  ok("automatic task alert carries source/section, dealer, market, employee, DD/MM/YYYY date and planned amount, for a future date");

  // Calendar sources without a dealer / amount degrade cleanly.
  created = [];
  await alerts.notifyAutoTaskCreated(db as never, await labels(), { source: "CALENDAR", section: "VISITS", ownerId: "rm1", date: "2026-10-30", entityType: "CalendarEntry", entityId: "ce1" });
  assert.deepEqual(ids(), ["admin", "admin2", "rm1"]);
  assert.equal(created[0].message, "Calendar → Visits task was assigned to Santosh, scheduled for 30/10/2026.");
  created = [];
  await alerts.notifyAutoTaskCreated(db as never, await labels(), { source: "CALENDAR", section: "APPOINTMENT", ownerId: "so1", dealerName: "Typed Dealer", marketName: "Sehore", date: "2026-10-30", entityType: "CalendarEntry", entityId: "ce1" });
  assert.ok(created[0].message.includes("for Typed Dealer") && created[0].message.includes("Market: Sehore"));
  ok("calendar tasks (no dealer / typed dealer + market)");

  // Billing Exception: Yes uses the PROMISED payment amount; No has no promise; one message per recipient.
  created = [];
  await alerts.notifyBillingExceptionCreated(db as never, await labels(), { exceptionId: "x1", dealerId: "d1", dealerName: "Alpha Traders", billNo: "B-7", billingDate: "2026-10-01", billingAmount: 50000, authPerson: "Varun sir", paymentCondition: true, paymentDate: "2026-10-20", paymentAmount: 12000, taskOfficerId: "so1" });
  assert.equal(created.length, 4);
  assert.equal(created[0].title, "New Billing Exception · Recovery task assigned");
  assert.ok(created[0].message.includes("Billing Amount ₹50,000") && created[0].message.includes("Promised payment ₹12,000 on 20/10/2026") && created[0].message.includes("Arjun") && created[0].message.includes("B-7") && created[0].message.includes("01/10/2026") && created[0].message.includes("Varun sir"));
  created = [];
  await alerts.notifyBillingExceptionCreated(db as never, await labels(), { exceptionId: "x2", dealerId: "d1", dealerName: "Alpha Traders", billNo: "B-8", billingDate: "2026-10-01", billingAmount: 70000, authPerson: "Varun sir", paymentCondition: false, paymentDate: null, paymentAmount: null, taskOfficerId: null });
  assert.deepEqual(ids(), ["admin", "admin2", "rm1", "so1"], "No: the owner is the dealer's authoritative assignment");
  assert.equal(created[0].title, "New Billing Exception"); assert.ok(created[0].message.endsWith("Payment condition: No.") && !created[0].message.includes("Promised"));
  ok("Billing Exception alert: Yes (promised amount) and No (no task), recipients from the dealer's assignment");

  // Edit Labels: every title / message part comes from the label map.
  created = [];
  overrides = { "notifications.auto_task.title": "Naya auto task", "notifications.auto_task.message": "{section} ({source}){dealer_part} → {employee} · {date}", "notifications.section.recovery": "Vasooli", "notifications.auto_task.amount_part": " · Rs {amount}" };
  await alerts.notifyAutoTaskCreated(db as never, await alerts.alertLabels(), { source: "BILLING_EXCEPTION", section: "RECOVERY", ownerId: "so1", dealerId: "d1", date: "2026-11-02", amount: 500, entityType: "BillingExceptionTask", entityId: "bt1" });
  assert.equal(created[0].title, "Naya auto task");
  assert.equal(created[0].message, "Vasooli (Billing Exception) for Alpha Traders → Arjun · 02/11/2026 Market: Pipariya. · Rs ₹500");
  overrides = {};
  ok("titles and message text follow Edit Labels");

  // Links (resolved per feed on the server from the live entity).
  const map = await links.resolveNotificationLinks([
    { id: "n1", relatedEntityType: "BillingException", relatedEntityId: "x1" }, { id: "n2", relatedEntityType: "BillingExceptionTask", relatedEntityId: "bt1" },
    { id: "n3", relatedEntityType: "CnPaymentEvent", relatedEntityId: "ev1" }, { id: "n4", relatedEntityType: "CnPaymentEvent", relatedEntityId: "ev2" },
    { id: "n5", relatedEntityType: "CalendarEntry", relatedEntityId: "ce1" }, { id: "n6", relatedEntityType: "SeasonPlan", relatedEntityId: "p1" }, { id: "n7", relatedEntityType: "CalendarEntry", relatedEntityId: "gone" },
  ]);
  assert.equal(map.get("n1"), "/reports/last-payment?exception=x1");
  assert.equal(map.get("n2"), "/planning/calendar?date=2026-11-20");
  assert.equal(map.get("n3"), "/planning/calendar?date=2026-11-03");
  assert.equal(map.get("n5"), "/planning/calendar?date=2026-12-01");
  for (const k of ["n4", "n6", "n7"]) assert.equal(map.has(k), false, `${k} has no server link (existing handling / missing record)`);
  tasks[0].taskDate = new Date("2026-11-25T00:00:00Z"); // rescheduled later → the link follows
  assert.equal((await links.resolveNotificationLinks([{ id: "n2", relatedEntityType: "BillingExceptionTask", relatedEntityId: "bt1" }])).get("n2"), "/planning/calendar?date=2026-11-25");
  ok("links: exception report, calendar day (follows a reschedule); no link for missing / unrelated records");

  // Wiring + safety nets (source level).
  const src = (f: string) => readFileSync(f, "utf8");
  const be = src("src/features/reports/billing-exception.server.ts");
  assert.ok(be.lastIndexOf("notifyBillingExceptionCreated(tx") > be.indexOf("return { row: existing, duplicate: true }") && be.includes("duplicate: false"), "alert only after the duplicate short-circuit, inside the save transaction");
  const cn = src("src/features/cn-requests/service.server.ts");
  assert.equal((cn.match(/await alertNewCnTask\(/g) ?? []).length, 3, "all three CN task-creation points alert");
  const mat = [src("src/features/daily-work/auto-task-materialization.server.ts"), src("src/features/daily-work/billing-task.server.ts"), src("src/features/daily-work/calendar-task-materialization.server.ts"), src("src/features/calendar/calendar.server.ts").split("export async function createCalendarEntry")[0].split("\n").filter((l) => !l.startsWith("import")).join("\n")];
  for (const m of mat) assert.ok(!/task-alerts|notifyAutoTaskCreated|notifyMany/.test(m), "reads / materialization / reschedule never alert");
  assert.ok(/notification\.createMany|notifyMany/.test(src("src/features/notifications/task-alerts.server.ts")));
  const schema = src("prisma/schema.prisma");
  assert.match(schema.slice(schema.indexOf("model Notification")), /isRead\s+Boolean\s+@default\(false\)/);
  const feed = src("src/app/api/notifications/route.ts");
  assert.ok(feed.includes("resolveNotificationLinks") && feed.includes("requireAuth"), "feed is the caller's own, links added on the server");
  assert.ok(src("src/features/calendar/calendar-view.tsx").includes('searchParams?.get("date")') && src("src/features/calendar/calendar-view.tsx").includes("useState<string | null>(linkedDate)"), "Calendar opens on ?date=");
  assert.ok(src("src/features/reports/last-payment-report-page.tsx").includes('get("exception")'), "report opens the linked exception");
  for (const f of ["notification-bell.tsx", "notifications-page.tsx"]) assert.ok(src(`src/features/notifications/${f}`).includes("if (n.href) return n.href;"), `${f} follows the server link`);
  ok("wiring: save-time only, same transaction, three CN points, no alert from reads / materialization / reschedule");
  console.log(`task-alerts.test.ts — ${n} groups passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
