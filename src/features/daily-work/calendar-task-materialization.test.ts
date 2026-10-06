/**
 * Calendar Daily Tasks → Daily Work. Loads the REAL calendar-task-materialization.server.ts against an in-memory DB.
 * Proves: each active section lands in the right Daily Work shape, it is IDEMPOTENT (repeat / concurrent opens never
 * duplicate), only the owner's task for TODAY is used, a finalized day is untouched, No Plan is cleared only by real data,
 * the row is linked for Task Type "Calendar", and CN Auto Tasks are not involved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";

type Cal = { id: string; ownerId: string; date: string; kind: string; taskSection: string; dealerId: string | null; amount: number | null; entryType: string | null; paymentMode: string | null; typedDealerName: string | null; marketName: string | null; dealerVisits: number | null; newPartyVisits: number | null; text: string | null; dailyWorkEntryId: string | null; dailyWorkContribution: number | null; materializedAt: Date | null; createdAt: number };
type Dw = { id: string; officerId: string; dealerId: string | null; rowKey: string; workDate: string; batchId: string; section: string; status: string; todaysPlan: number | null; entryType?: string; paymentMode?: string | null; typedDealerName?: string | null; marketName?: string | null; dealerVisits?: number | null; newPartyVisits?: number | null; others?: string | null; noPlanSections?: string | null };

let seq = 0;
const cal = (over: Partial<Cal>): Cal => ({ id: `c${++seq}`, ownerId: "so-1", date: "2026-10-10", kind: "TASK", taskSection: "RECOVERY", dealerId: "d-1", amount: 25000, entryType: "REGULAR", paymentMode: "UPI", typedDealerName: null, marketName: null, dealerVisits: null, newPartyVisits: null, text: null, dailyWorkEntryId: null, dailyWorkContribution: null, materializedAt: null, createdAt: seq, ...over });

function makeDb(seed: { cal?: Cal[]; dw?: Dw[] }) {
  const calendar = structuredClone(seed.cal ?? []);
  const dw = structuredClone(seed.dw ?? []);
  let ids = 0;
  const execute = async (query: unknown): Promise<unknown> => {
    const sql = query as Prisma.Sql;
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values as unknown[];
    if (text.includes('FROM "CalendarEntry"') && text.includes("FOR UPDATE")) {
      const [owner, date] = v as string[];
      return calendar.filter((c) => c.ownerId === owner && c.kind === "TASK" && c.date === date && !c.materializedAt).sort((a, b) => a.createdAt - b.createdAt)
        .map((c) => ({ ...c, amount: c.amount == null ? null : String(c.amount) }));
    }
    if (text.startsWith('SELECT "id" FROM "DailyWorkEntry"')) {
      const lit = text.includes("'APPOINTMENT'") ? "APPOINTMENT" : text.includes("'SUMMARY'") ? "SUMMARY" : null;
      const [officer, date, batch, a, b] = v as string[];
      const section = lit ?? a, rowKey = lit ? a : b;
      return dw.filter((r) => r.officerId === officer && r.workDate === date && r.batchId === batch && r.section === section && r.rowKey === rowKey && r.status === "DRAFT").map((r) => ({ id: r.id }));
    }
    if (text.startsWith('INSERT INTO "DailyWorkEntry"')) {
      const base = { id: `dw${++ids}`, status: "DRAFT", todaysPlan: null as number | null };
      let row: Dw;
      if (text.includes('"todaysPlan","entryType"')) { const [, officer, dealer, rowKey, date, batch, section, entryType] = v as string[]; row = { ...base, officerId: officer, dealerId: dealer, rowKey, workDate: date, batchId: batch, section, entryType, todaysPlan: 0, }; }
      else if (text.includes("'APPOINTMENT'")) { const [, officer, key, date, batch, name, market] = v as string[]; row = { ...base, officerId: officer, dealerId: null, rowKey: key, workDate: date, batchId: batch, section: "APPOINTMENT", typedDealerName: name, marketName: market }; }
      else { const [, officer, key, date, batch] = v as string[]; row = { ...base, officerId: officer, dealerId: null, rowKey: key, workDate: date, batchId: batch, section: "SUMMARY" }; }
      if (dw.some((r) => r.officerId === row.officerId && r.workDate === row.workDate && r.batchId === row.batchId && r.section === row.section && r.rowKey === row.rowKey)) return 0;
      dw.push(row); return 1;
    }
    if (text.startsWith('UPDATE "CalendarEntry"')) {
      const [rowId, contribution, id] = v as [string, { toString(): string } | null, string];
      const guarded = text.includes('"materializedAt" IS NULL'); // honour the SQL: without the guard a second claim would win
      const c = calendar.find((x) => x.id === id && (!guarded || !x.materializedAt));
      if (!c) return 0;
      c.dailyWorkEntryId = rowId; c.dailyWorkContribution = contribution == null ? null : Number(contribution.toString()); c.materializedAt = new Date(); return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry"') && text.includes('COALESCE("todaysPlan"')) {
      const [amount, id] = v as [{ toString(): string }, string];
      const r = dw.find((x) => x.id === id)!; r.todaysPlan = (r.todaysPlan ?? 0) + Number(amount.toString()); return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry"') && text.includes('"dealerVisits" = COALESCE')) {
      const [dv, npv, id] = v as [number, number, string];
      const r = dw.find((x) => x.id === id)!; r.dealerVisits = (r.dealerVisits ?? 0) + dv; r.newPartyVisits = (r.newPartyVisits ?? 0) + npv; return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry"') && text.includes('"others" = CASE')) {
      const [t1, t2, id] = v as [string, string, string];
      const r = dw.find((x) => x.id === id)!; r.others = !r.others?.trim() ? t1 : `${r.others}\n${t2}`; return 1;
    }
    if (text.startsWith('UPDATE "DailyWorkEntry"') && text.includes("array_remove")) {
      const [section, officer, date, batch] = v as string[];
      for (const r of dw.filter((x) => x.officerId === officer && x.workDate === date && x.batchId === batch && x.section === "SUMMARY")) {
        const rest = (r.noPlanSections ?? "").split(",").filter((s) => s && s !== section).join(","); r.noPlanSections = rest || null;
      }
      return 1;
    }
    throw new Error(`Unhandled: ${text}`);
  };
  const db = { $queryRaw: (q: unknown) => execute(q), $executeRaw: (q: unknown) => execute(q) };
  return { db, calendar, dw };
}

function load(prismaStub: object = {}) {
  const filename = resolve("src/features/daily-work/calendar-task-materialization.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const localRequire = createRequire(import.meta.url);
  const mocks: Record<string, unknown> = {
    "server-only": {}, "@/lib/prisma": { prisma: prismaStub }, "@/lib/http": {}, "@/lib/audit": { writeAudit: async () => undefined },
    "@/lib/daily-work": { currentBusinessDate: () => "2026-10-10" },
    "./day-lock.server": { lockDailyWorkDay: async () => ({ currentBatchId: "batch-current", status: "OPEN", selfRating: null, finalizedAt: null }) },
    "./auto-task-materialization.server": { autoTasksApplyToRole: (role: string) => role === "SALES_OFFICER" || role === "REGIONAL_MANAGER" },
  };
  runInNewContext(code, { exports, console, Buffer, require: (id: string) => id in mocks ? mocks[id] : localRequire(id) }, { filename });
  return exports as typeof import("./calendar-task-materialization.server");
}

const open = { currentBatchId: "batch-current", status: "OPEN" as const, selfRating: null, finalizedAt: null };
const run = (svc: ReturnType<typeof load>, f: ReturnType<typeof makeDb>, officer = "so-1") => svc.materializeDueCalendarTasksInTransaction(f.db as never, officer, "2026-10-10", open);
const rows = (f: ReturnType<typeof makeDb>, section: string, officer = "so-1") => f.dw.filter((r) => r.officerId === officer && r.section === section);

async function main() {
  const svc = load();

  // Recovery → the dealer's Recovery row (amount = Today's Plan, payment mode carried), linked back to the Calendar task.
  {
    const f = makeDb({ cal: [cal({})] });
    assert.equal((await run(svc, f)).materialized, 1);
    const r = rows(f, "RECOVERY");
    assert.equal(r.length, 1); assert.deepEqual([r[0]!.dealerId, r[0]!.todaysPlan, r[0]!.paymentMode, r[0]!.batchId, r[0]!.status], ["d-1", 25000, undefined, "batch-current", "DRAFT"]); // Payment Mode is a Daily Report value: never copied into the Plan
    assert.equal(f.calendar[0]!.dailyWorkEntryId, r[0]!.id, "the Daily Work row references its Calendar task (→ Task Type Calendar)");
    assert.ok(f.calendar[0]!.materializedAt);
    // IDEMPOTENT: opening Daily Work again — sequentially or concurrently — never duplicates.
    assert.equal((await run(svc, f)).materialized, 0);
    assert.equal(rows(f, "RECOVERY").length, 1); assert.equal(rows(f, "RECOVERY")[0]!.todaysPlan, 25000, "amount added exactly once");
    // RACE: two requests that BOTH see the task as due (a fresh task, opened concurrently) still add it exactly once —
    // only the request that wins the atomic claim writes the Daily Work data.
    const race = makeDb({ cal: [cal({})] });
    await Promise.all([run(svc, race), run(svc, race), run(svc, race)]);
    assert.equal(rows(race, "RECOVERY").length, 1); assert.equal(rows(race, "RECOVERY")[0]!.todaysPlan, 25000, "concurrent opens never double-count");
  }

  // An existing manual row for the same dealer: the amount is ADDED; the row's own type/payment mode is kept; no 2nd row.
  {
    const manual: Dw = { id: "m1", officerId: "so-1", dealerId: "d-1", rowKey: "d-1", workDate: "2026-10-10", batchId: "batch-current", section: "RECOVERY", status: "DRAFT", todaysPlan: 5000, paymentMode: "CASH" };
    const f = makeDb({ cal: [cal({})], dw: [manual] });
    await run(svc, f);
    assert.equal(rows(f, "RECOVERY").length, 1); assert.equal(rows(f, "RECOVERY")[0]!.todaysPlan, 30000); assert.equal(rows(f, "RECOVERY")[0]!.paymentMode, "CASH");
    assert.equal(f.calendar[0]!.dailyWorkEntryId, "m1");
  }

  // Sales / Appointment / Visits / Others each land in their own Daily Work shape.
  {
    const f = makeDb({ cal: [
      cal({ taskSection: "SALES", dealerId: "d-2", amount: 1000, paymentMode: null }),
      cal({ taskSection: "APPOINTMENT", dealerId: null, amount: null, paymentMode: null, typedDealerName: "New Dealer", marketName: "Bhopal" }),
      cal({ taskSection: "VISITS", dealerId: null, amount: null, paymentMode: null, dealerVisits: 3, newPartyVisits: 1 }),
      cal({ taskSection: "OTHERS", dealerId: null, amount: null, paymentMode: null, text: "Collect cheque" }),
    ] });
    assert.equal((await run(svc, f)).materialized, 4);
    assert.deepEqual([rows(f, "SALES")[0]!.dealerId, rows(f, "SALES")[0]!.todaysPlan], ["d-2", 1000]);
    assert.deepEqual([rows(f, "APPOINTMENT")[0]!.typedDealerName, rows(f, "APPOINTMENT")[0]!.marketName, rows(f, "APPOINTMENT")[0]!.rowKey], ["New Dealer", "Bhopal", `cal-${f.calendar[1]!.id}`]);
    const summary = rows(f, "SUMMARY"); assert.equal(summary.length, 1, "Visits + Others share the day's single SUMMARY row");
    assert.deepEqual([summary[0]!.dealerVisits, summary[0]!.newPartyVisits, summary[0]!.others], [3, 1, "Collect cheque"]);
    await run(svc, f);
    assert.deepEqual([rows(f, "SUMMARY")[0]!.dealerVisits, rows(f, "SALES").length, rows(f, "APPOINTMENT").length], [3, 1, 1], "re-run changes nothing");
    // A second Visits / Others task ADDS to the existing counts / appends to the note.
    f.calendar.push(cal({ taskSection: "VISITS", dealerId: null, amount: null, paymentMode: null, dealerVisits: 2, newPartyVisits: 0 }), cal({ taskSection: "OTHERS", dealerId: null, amount: null, paymentMode: null, text: "Second" }));
    await run(svc, f);
    assert.deepEqual([rows(f, "SUMMARY")[0]!.dealerVisits, rows(f, "SUMMARY")[0]!.others], [5, "Collect cheque\nSecond"]);
  }

  // Ownership + date: only the OWNER's task for TODAY; others' tasks, future tasks and non-task entries are untouched.
  {
    const f = makeDb({ cal: [cal({ ownerId: "so-2" }), cal({ date: "2026-10-11" }), cal({ date: "2026-10-09" }), cal({ kind: "MEETING", taskSection: "", dealerId: null, amount: null, text: "m" }), cal({ ownerId: "rm-1", dealerId: "d-9", amount: 7 })] });
    assert.equal((await run(svc, f, "so-1")).materialized, 0, "nothing of so-1's is due");
    assert.equal(f.dw.length, 0);
    assert.equal((await run(svc, f, "rm-1")).materialized, 1, "an RM's own task materializes through the same path");
    assert.deepEqual([rows(f, "RECOVERY", "rm-1")[0]!.dealerId, rows(f, "RECOVERY", "rm-1")[0]!.todaysPlan], ["d-9", 7]);
    assert.equal(f.calendar.filter((c) => c.materializedAt).length, 1, "so-2's, future, past and meeting entries are untouched");
  }

  // Lifecycle: a finalized day is never mutated; No Plan is cleared only by real data in THAT section.
  {
    const f = makeDb({ cal: [cal({})] });
    const finalized = await svc.materializeDueCalendarTasksInTransaction(f.db as never, "so-1", "2026-10-10", { ...open, status: "FINALIZED" as never });
    assert.equal(finalized.materialized, 0); assert.equal(f.dw.length, 0); assert.ok(!f.calendar[0]!.materializedAt, "kept for when the day is open");
    const summary: Dw = { id: "s1", officerId: "so-1", dealerId: null, rowKey: "SUMMARY", workDate: "2026-10-10", batchId: "batch-current", section: "SUMMARY", status: "DRAFT", todaysPlan: null, noPlanSections: "RECOVERY,SALES" };
    const g = makeDb({ cal: [cal({})], dw: [summary] });
    await run(svc, g);
    assert.equal(g.dw.find((r) => r.id === "s1")!.noPlanSections, "SALES", "Recovery has data now → its No Plan is cleared; Sales' stays");
  }

  // Role gate: only roles that own Daily Work (the same as CN Auto Tasks) use the read-path entry; others are no-ops.
  {
    const noDb = load({}); // an empty prisma stub proves the database is not touched
    for (const role of [Role.SUPER_ADMIN, Role.CUSTOM_ADMIN]) assert.equal((await noDb.materializeDueCalendarTasks({ userId: "a", role, username: "a", groupId: null } as never)).materialized, 0, role);
    assert.equal((await noDb.calendarLinkedEntryIds([])).length, 0, "no ids → no query");
  }

  // Separation: this module never reads or writes CN Auto Task data.
  const source = readFileSync("src/features/daily-work/calendar-task-materialization.server.ts", "utf8");
  assert.ok(!/CnPaymentEvent|CnRequest|dailyWorkConfirmed|legacyDailyWork/.test(source.replace(/\/\*[\s\S]*?\*\//g, "")), "CN Auto Task tables are not touched");

  // Wiring: Daily Work materializes before it reads, labels the row Calendar, and the CN Auto Task code is unchanged.
  const service = readFileSync("src/features/daily-work/service.server.ts", "utf8");
  for (const fn of ["getDailyWork", "getDailyAppointment", "getDailySummary", "getDailyStatus"]) {
    const body = service.slice(service.indexOf(`export async function ${fn}(`), service.indexOf("\nexport ", service.indexOf(`export async function ${fn}(`) + 10));
    assert.ok(body.includes("materializeCalendarForRead("), `${fn} materializes Calendar tasks before reading`);
  }
  assert.ok(service.includes('workDate === currentBusinessDate()) await materializeDueCalendarTasks(ctx)'), "own, plan-view, today only");
  assert.ok(service.includes("calendarEntryIds"), "payloads expose the Calendar link for Task Type");

  console.log("calendar-task-materialization.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
