/**
 * Calendar entries (Daily Task / Meeting / Reminder / Other), My vs Team calendar, State + Sales Officer filters and the
 * server-side scope rules. Loads the REAL calendar.server.ts against a DB-free fake. (Materialization into Daily Work is
 * covered by daily-work/calendar-task-materialization.test.ts.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";

/* ---------------------------------- fixture ---------------------------------- */
const GROUPS: Record<string, string> = { g1: "CG", g2: "MP" };
const USERS: Record<string, { name: string; role: Role; groupId: string | null }> = {
  so1: { name: "Rahul Patidar", role: Role.SALES_OFFICER, groupId: "g1" },
  so2: { name: "Deepak", role: Role.SALES_OFFICER, groupId: "g1" },
  so3: { name: "Outsider", role: Role.SALES_OFFICER, groupId: "g2" },
  rm1: { name: "Santosh Tripathi", role: Role.REGIONAL_MANAGER, groupId: "g1" },
  rm2: { name: "Other RM", role: Role.REGIONAL_MANAGER, groupId: "g2" },
  admin: { name: "Admin", role: Role.SUPER_ADMIN, groupId: null },
};
const ctx = (userId: string): AuthContext => ({ userId, username: userId, role: USERS[userId]!.role, groupId: USERS[userId]!.groupId } as AuthContext);
const DEALERS: Record<string, { name: string; officer: string }> = { d1: { name: "ABC Traders", officer: "so1" }, d2: { name: "XYZ Stores", officer: "so2" } };
const TODAY = "2026-10-05"; // currentBusinessDate() is real here; the tests use dates relative to the real "today" instead (below)

type Row = { id: string; ownerId: string; date: Date; kind: string; text: string | null; taskSection: string | null; dealerId: string | null; amount: number | null; entryType: string | null; paymentMode: string | null; typedDealerName: string | null; marketName: string | null; dealerVisits: number | null; newPartyVisits: number | null; materializedAt: Date | null; createdAt: Date };
let store: Row[] = [];
const finalizedDays = new Set<string>(); // "owner|YYYY-MM-DD"
let seq = 0;

const scopeOf = (c: AuthContext): { all: boolean; ids: string[] } => {
  if (c.role === Role.SUPER_ADMIN) return { all: true, ids: [] };
  if (c.role === Role.SALES_OFFICER) return { all: false, ids: [c.userId] };
  return { all: false, ids: [c.userId, ...Object.entries(USERS).filter(([, u]) => u.role === Role.SALES_OFFICER && u.groupId === c.groupId).map(([id]) => id)] };
};
const withOwner = (r: Row) => { const u = USERS[r.ownerId]!; return { ...r, owner: { name: u.name, role: u.role, group: u.groupId ? { id: u.groupId, name: GROUPS[u.groupId]! } : null } }; };

const prisma = {
  calendarEntry: {
    findMany: async ({ where }: { where: { date: { gte: Date; lt: Date }; ownerId?: { in: string[] } } }) =>
      store.filter((r) => r.date >= where.date.gte && r.date < where.date.lt && (!where.ownerId || where.ownerId.in.includes(r.ownerId))).map(withOwner),
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `e${++seq}`, text: null, taskSection: null, dealerId: null, amount: null, entryType: null, paymentMode: null, typedDealerName: null, marketName: null, dealerVisits: null, newPartyVisits: null, materializedAt: null, createdAt: new Date(2026, 0, 1, 0, 0, seq), ...data } as Row; store.push(row); return withOwner(row); },
    findUnique: async ({ where }: { where: { id: string } }) => store.find((r) => r.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const r = store.find((x) => x.id === where.id)!; Object.assign(r, data); return withOwner(r); },
    delete: async ({ where }: { where: { id: string } }) => { store = store.filter((r) => r.id !== where.id); return {}; },
  },
  calendarNote: { findMany: async () => [] },
  dealerSchemePlan: { findMany: async () => [] },
  dealer: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => DEALERS[id]).map((id) => ({ id, name: DEALERS[id]!.name })) },
  user: {
    findMany: async ({ where }: { where: { groupId?: string; id?: { in: string[] }; role?: { in: Role[] } } }) =>
      Object.entries(USERS)
        .filter(([id, u]) => (!where.groupId || u.groupId === where.groupId) && (!where.id || where.id.in.includes(id)) && (!where.role || where.role.in.includes(u.role)))
        .map(([id, u]) => ({ id, name: u.name, role: u.role, group: u.groupId ? { id: u.groupId, name: GROUPS[u.groupId]! } : null })),
  },
  $queryRaw: async (a: unknown, ...rest: unknown[]) => {
    const sql = (Array.isArray(a) ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest) : a) as Prisma.Sql;
    const text = sql.sql.replace(/\s+/g, " ");
    if (text.includes('FROM "PartyPlan"')) return [];
    if (text.includes('FROM "DailyWorkDay"')) { const [owner, date] = sql.values as string[]; return finalizedDays.has(`${owner}|${date}`) ? [{ status: "FINALIZED" }] : []; }
    throw new Error(`Unhandled raw SQL: ${text}`);
  },
};

const localRequire = createRequire(import.meta.url);
function load(current: { ctx: AuthContext | null }) {
  const filename = resolve("src/features/calendar/calendar.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
  const mocks: Record<string, unknown> = {
    "server-only": {}, "@/lib/prisma": { prisma }, "@/lib/http": { ApiError },
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
    "@/lib/recovery-config": { getCalendarEnabled: async () => true },
    "@/lib/scope": {
      getOfficerScope: async (c: AuthContext) => scopeOf(c),
      assertOfficerInScope: async (c: AuthContext, id: string) => { const s = scopeOf(c); if (!s.all && !s.ids.includes(id)) throw new ApiError(403, "no access"); },
      getCurrentDealerIds: async (officerId: string) => Object.entries(DEALERS).filter(([, d]) => d.officer === officerId).map(([id]) => id),
    },
    "@/lib/calendar": localRequire(resolve("src/lib/calendar.ts")),
  };
  void current;
  runInNewContext(code, { exports, Date, console, require: (id: string) => (id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id)) }, { filename });
  return exports as typeof import("./calendar.server");
}
const svc = load({ ctx: null });

const dayKey = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const FUTURE = dayKey(3); // same month as TODAY is not guaranteed → always query the entry's own month
const monthOf = (dk: string) => ({ year: Number(dk.slice(0, 4)), month: Number(dk.slice(5, 7)) });
/** Structural equality across the VM realm boundary (the service runs in its own context). */
const same = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const status = (fn: () => Promise<unknown>) => fn().then(() => 0, (e: { status?: number }) => e.status ?? -1);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
const owners = (entries: { ownerId: string }[]) => [...new Set(entries.map((e) => e.ownerId))].sort();

async function main() {
  void TODAY;
  const month = monthOf(FUTURE);
  const calendar = (who: string, extra: Record<string, unknown> = {}) => svc.calendarMonth(ctx(who), { ...month, ...extra } as never);

  // 1 — the four actions are stored with their creator as owner.
  const task = await svc.createCalendarEntry(ctx("so1"), { kind: "TASK", date: FUTURE, section: "RECOVERY", dealerId: "d1", amount: 25000, paymentMode: "UPI" });
  assert.equal(task.kind, "TASK"); assert.equal(task.ownerId, "so1"); assert.equal(task.ownerName, "Rahul Patidar"); assert.equal(task.ownerRoleLabel, "Sales Officer");
  same([task.task?.section, task.task?.dealerName, task.task?.amount, task.task?.paymentMode], ["RECOVERY", "ABC Traders", 25000, "UPI"]);
  assert.equal(store.find((r) => r.id === task.id)!.entryType, "REGULAR");
  const reminder = await svc.createCalendarEntry(ctx("so2"), { kind: "REMINDER", date: FUTURE, text: "Call dealer" });
  const rmReminder = await svc.createCalendarEntry(ctx("rm1"), { kind: "REMINDER", date: FUTURE, text: "Review distributors" });
  assert.equal(reminder.kind, "REMINDER");
  assert.equal(rmReminder.ownerRoleLabel, "Regional Manager"); assert.equal(rmReminder.ownerState, "CG");
  for (const e of [reminder, rmReminder]) assert.equal(e.task, null, "non-task entries carry no Daily Work payload");
  // Meeting / Other are no longer creatable by anyone (UI removed; the API refuses them and stores nothing).
  const stored = store.length;
  for (const kind of ["MEETING", "OTHER"]) for (const who of ["so1", "rm1", "admin"]) assert.equal(await status(() => svc.createCalendarEntry(ctx(who), { kind, date: FUTURE, text: "x" })), 422, `${kind} by ${who} is refused`);
  assert.equal(store.length, stored, "refused Meeting/Other creates write nothing");

  // 2 — every active Daily Work section is accepted with the Daily Work fields; a disabled/unknown one is rejected.
  const base = { kind: "TASK", date: FUTURE };
  const sales = await svc.createCalendarEntry(ctx("so1"), { ...base, section: "SALES", dealerId: "d1", amount: 1000 });
  const appt = await svc.createCalendarEntry(ctx("so1"), { ...base, section: "APPOINTMENT", dealerName: "New Dealer", marketName: "Bhopal" });
  const visits = await svc.createCalendarEntry(ctx("so1"), { ...base, section: "VISITS", dealerVisits: 3, newPartyVisits: 1 });
  const others = await svc.createCalendarEntry(ctx("so1"), { ...base, section: "OTHERS", text: "Collect cheque" });
  same([sales.task?.amount, appt.task?.typedDealerName, appt.task?.marketName, visits.task?.dealerVisits, visits.task?.newPartyVisits, others.text], [1000, "New Dealer", "Bhopal", 3, 1, "Collect cheque"]);
  const payload0 = await calendar("so1");
  same(payload0.taskSections, ["SALES", "RECOVERY", "APPOINTMENT", "VISITS", "OTHERS"], "task types are exactly the ACTIVE Daily Work sections");
  assert.ok(!payload0.taskSections.includes("SCHEME_CONVERSION"), "the disabled Scheme Conversion section is not offered");
  assert.equal(await status(() => svc.createCalendarEntry(ctx("so1"), { ...base, section: "SCHEME_CONVERSION", dealerId: "d1", amount: 5 })), 422);

  // 3 — Daily Task validation (same rules as Daily Work).
  const bad = async (over: Record<string, unknown>, code: number, why: string) => assert.equal(await status(() => svc.createCalendarEntry(ctx("so1"), { ...base, section: "SALES", dealerId: "d1", amount: 10, ...over })), code, why);
  await bad({ dealerId: "d2" }, 403, "a dealer that is not the officer's own");
  await bad({ dealerId: undefined }, 422, "dealer required");
  await bad({ amount: 0 }, 422, "amount must be positive");
  await bad({ amount: undefined }, 422, "amount required");
  await bad({ date: dayKey(-1) }, 422, "past dates are rejected");
  await bad({ section: "RECOVERY", paymentMode: "BITCOIN" }, 422, "unknown payment mode");
  assert.equal(await status(() => svc.createCalendarEntry(ctx("so1"), { ...base, section: "VISITS" })), 422, "visits need a count");
  assert.equal(await status(() => svc.createCalendarEntry(ctx("so1"), { ...base, section: "APPOINTMENT", dealerName: " " })), 422);
  assert.equal(await status(() => svc.createCalendarEntry(ctx("so1"), { ...base, section: "OTHERS", text: "" })), 422);
  assert.equal(await status(() => svc.createCalendarEntry(ctx("admin"), { ...base, section: "OTHERS", text: "x" })), 403, "only SO/RM own Daily Work");
  assert.equal(await status(() => svc.createCalendarEntry(ctx("admin"), { kind: "REMINDER", date: FUTURE, text: "Board" })), 0, "Admin can still add calendar-only entries");
  // A finalized Daily Work for TODAY is never mutated: today's task is refused, a future one is fine.
  const today = dayKey(0);
  finalizedDays.add(`so1|${today}`);
  assert.equal(await status(() => svc.createCalendarEntry(ctx("so1"), { kind: "TASK", date: today, section: "OTHERS", text: "late" })), 409, "today's Daily Work is finalized");
  assert.equal(await status(() => svc.createCalendarEntry(ctx("so2"), { kind: "TASK", date: today, section: "OTHERS", text: "ok" })), 0, "another officer's open day is unaffected");
  finalizedDays.clear();

  // 4 — visibility. SO: own only (and cannot pick anyone else).
  const so1 = await calendar("so1");
  same(owners(so1.entries), ["so1"], "SO sees only their own entries");
  assert.equal(so1.canFilterOfficers, false); assert.equal(so1.canTeamView, false); assert.equal(so1.officers.length, 0);
  assert.equal(await status(() => calendar("so1", { officerId: "so2" })), 403, "SO cannot view a colleague");
  assert.equal(await status(() => calendar("so1", { view: "team" })), 0); same(owners((await calendar("so1", { view: "team" })).entries), ["so1"], "SO has no team view");

  // 5 — RM: My Calendar = own; Team Calendar = own + group SOs, each entry names its creator; never another team.
  const rmMine = await calendar("rm1", { view: "mine" });
  same(owners(rmMine.entries), ["rm1"], "My Calendar: only the RM's own");
  assert.equal(rmMine.canTeamView, true); assert.equal(rmMine.canFilterOfficers, false);
  const rmTeam = await calendar("rm1", { view: "team" });
  same(owners(rmTeam.entries), ["rm1", "so1", "so2"], "Team Calendar: self + own team");
  assert.ok(!rmTeam.entries.some((e) => e.ownerId === "so3" || e.ownerId === "rm2" || e.ownerId === "admin"), "never another team / admin");
  const santoshReminder = rmTeam.entries.find((e) => e.id === rmReminder.id)!;
  same([santoshReminder.ownerName, santoshReminder.ownerRoleLabel, santoshReminder.text], ["Santosh Tripathi", "Regional Manager", "Review distributors"]);
  assert.equal(rmTeam.entries.find((e) => e.id === task.id)!.ownerName, "Rahul Patidar", "the creator of a team entry is shown");
  assert.equal(rmTeam.entries.find((e) => e.id === task.id)!.canDelete, false, "an RM cannot delete a Sales Officer's entry");
  same(owners((await calendar("rm1")).entries), ["rm1", "so1", "so2"], "no view = the legacy team scope");
  // Filters narrow only inside that set; manipulated parameters never widen it.
  for (const evil of [{ officerId: "so3" }, { officerId: "rm2" }, { officerId: "admin" }]) assert.equal(await status(() => calendar("rm1", { view: "team", ...evil })), 403, JSON.stringify(evil));
  assert.equal(await status(() => calendar("rm1", { view: "mine", officerId: "so1" })), 403, "My Calendar cannot be widened by officerId");
  same(owners((await calendar("rm1", { view: "team", officerId: "so1" })).entries), ["so1"]);
  same(owners((await calendar("rm1", { view: "team", officerId: "rm1" })).entries), ["rm1"], "the RM themself is a valid officer filter");
  same(owners((await calendar("rm1", { view: "team", groupId: "g1" })).entries), ["rm1", "so1", "so2"], "State inside the team");
  same((await calendar("rm1", { view: "team", groupId: "g2" })).entries, [], "another State is empty — not the other team's data");
  same((await calendar("rm1", { view: "team", groupId: "g2", officerId: "so1" })).entries, [], "State AND Sales Officer combine (so1 is not in g2)");
  // The unrelated RM only ever sees their own team.
  same(owners((await calendar("rm2", { view: "team" })).entries), ["so3"].filter((o) => store.some((e) => e.ownerId === o)), "unrelated RM sees only their own team");

  // 6 — options: Sales Officers AND Regional Managers (with role labels), only from the caller's scope; States from those.
  same(rmTeam.officers.map((o) => `${o.name} — ${o.roleLabel}`).sort(), ["Deepak — Sales Officer", "Rahul Patidar — Sales Officer", "Santosh Tripathi — Regional Manager"], "RM filter includes the RM themself and no outsiders");
  same(rmTeam.states.map((s) => s.name), ["CG"]);

  // 7 — Admin: everyone, every State, SOs and RMs; filters combine.
  const admin = await calendar("admin");
  same(owners(admin.entries), ["admin", "rm1", "so1", "so2"], "Admin sees every owner's entries");
  same(admin.officers.map((o) => o.roleLabel).filter((l) => l === "Regional Manager").length, 2, "Admin's Sales Officer filter lists the RMs too");
  same(admin.states.map((s) => s.name).sort(), ["CG", "MP"]);
  same(owners((await calendar("admin", { groupId: "g1" })).entries), ["rm1", "so1", "so2"], "State = CG");
  same(owners((await calendar("admin", { officerId: "rm1" })).entries), ["rm1"], "Sales Officer filter = a Regional Manager");
  same(owners((await calendar("admin", { groupId: "g1", officerId: "so1" })).entries), ["so1"], "State + Sales Officer");
  same((await calendar("admin", { groupId: "g2", officerId: "so1" })).entries, [], "mismatched State + officer → nothing");

  // 8 — writes are owner-only; a Daily Task already in Daily Work cannot be deleted from the calendar.
  assert.equal(await status(() => svc.deleteCalendarEntry(ctx("rm1"), reminder.id)), 403, "RM cannot delete a team member's entry");
  assert.equal(await status(() => svc.updateCalendarEntry(ctx("rm1"), reminder.id, { text: "x" })), 403);
  assert.equal((await svc.updateCalendarEntry(ctx("so2"), reminder.id, { text: "Call dealer (edited)" })).text, "Call dealer (edited)");
  assert.equal(await status(() => svc.updateCalendarEntry(ctx("so1"), task.id, { text: "x" })), 409, "a Daily Task is not edited here");
  store.find((r) => r.id === sales.id)!.materializedAt = new Date();
  assert.equal(await status(() => svc.deleteCalendarEntry(ctx("so1"), sales.id)), 409, "already in Daily Work");
  assert.equal(await status(() => svc.deleteCalendarEntry(ctx("so1"), task.id)), 0, "an un-materialized task can be removed");
  assert.ok(!store.some((r) => r.id === task.id));
  assert.equal(await status(() => svc.deleteCalendarEntry(ctx("so1"), "missing")), 404);

  // 9 — existing behaviour stays: events/notes arrays are still returned, the payload keeps its original fields.
  for (const key of ["events", "partyEvents", "notes", "canFilterOfficers", "officers"]) assert.ok(key in so1, key);
  assert.ok(ids(so1.entries).length > 0 && so1.myDealers.map((d) => d.name).join() === "ABC Traders", "the Daily Task form is offered only the caller's own dealers");
  assert.equal((await calendar("admin")).myDealers.length, 0, "Admin has no Daily Task form data");

  // 10 — UI wiring (source-level): the two actions (Daily Task + Reminder), My/Team switch (RM only), State + Sales Officer filters, creator shown.
  {
    const ui = readFileSync("src/features/calendar/calendar-view.tsx", "utf8");
    for (const needle of ["L.addTask", "L.addReminder"]) assert.ok(ui.includes(needle), `${needle} action`);
    for (const gone of ["L.addMeeting", "L.addOther", "calendar.add_meeting", "calendar.add_other", 'kind: "MEETING", label', 'kind: "OTHER", label']) assert.ok(!ui.includes(gone), `${gone} is no longer offered`);
    const actionsBlock = ui.slice(ui.indexOf("const actions:"), ui.indexOf("];", ui.indexOf("const actions:")));
    assert.equal((actionsBlock.match(/kind: "/g) ?? []).length, 2, "the date dialog defines exactly two actions: Task (SO/RM only) and Reminder");
    assert.ok(ui.includes("role === Role.REGIONAL_MANAGER && (") && ui.includes("L.myCalendar") && ui.includes("L.teamCalendar"), "My/Team switch is RM-only");
    assert.ok(ui.includes('params.set("groupId", groupId)') && ui.includes('params.set("view", view)'), "filters travel to the server (which re-validates them)");
    assert.ok(ui.includes("`${o.name} — ${o.roleLabel}`"), "Sales Officer filter shows name + role (RMs included)");
    assert.ok(ui.includes("L.addedBy") && ui.includes("e.ownerName") && ui.includes("e.ownerRoleLabel"), "every entry shows who added it");
    assert.ok(!ui.includes("L.addNote"), "the old Add Note button is replaced by the two actions (existing notes still render)");
    assert.ok(ui.includes("function NotesSection") && ui.includes("L.editNote"), "existing notes keep view/edit/delete");
    assert.ok(readFileSync("src/features/calendar/calendar-view.tsx", "utf8").includes("payload?.taskSections"), "Daily Task types come from the server's ACTIVE Daily Work sections, not a hard-coded list");
  }

  console.log("calendar-entries.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
