/**
 * Monthly Create New Plan = unfinished work; create-or-resume; Create-dialog defaults; per-option Tentative Turnover — on a REAL disposable PostgreSQL database.
 *
 *   createdb seasonal_market_test && DATABASE_URL=postgresql://localhost:5432/seasonal_market_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   SEASONAL_MARKET_TEST_URL=postgresql://localhost:5432/seasonal_market_test npm run test:monthly-create:db
 */
import assert from "node:assert/strict";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import { defaultMonthlySelection, monthIdForKey } from "@/lib/monthly-plan";
import { currentBusinessDate } from "@/lib/daily-work";

const url = process.env.SEASONAL_MARKET_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/seasonal_market_test")
  throw new Error("Only a local database named seasonal_market_test is permitted (set SEASONAL_MARKET_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
// The service sees the database through a thin spy so the tests can observe ordering and inject failures; every query still runs against the real database.
const trace: string[] = [];
const faults = { auditFails: false, txClosed: false, readFails: false };
let lastTxOptions: unknown = null;
const spied = new Proxy(prisma, { get(target, prop) {
  const value = Reflect.get(target, prop, target) as unknown;
  if (prop === "$transaction") return (fn: unknown, options?: unknown) => {
    lastTxOptions = options; trace.push("tx:start");
    if (faults.txClosed) { faults.txClosed = false; return Promise.reject(new Prisma.PrismaClientKnownRequestError("Transaction already closed", { code: "P2028", clientVersion: "test" })); }
    return (target.$transaction as unknown as (f: unknown, o?: unknown) => Promise<unknown>)(fn, options).finally(() => trace.push("tx:end"));
  };
  if (prop === "partyMonthlyPlan") return new Proxy(value as object, { get: (m, name) => name === "findUnique" ? async (...args: unknown[]) => {
    trace.push("read");
    if (faults.readFails) { faults.readFails = false; throw new Error("connection reset"); }
    return (m as { findUnique: (...a: unknown[]) => Promise<unknown> }).findUnique(...args);
  } : Reflect.get(m, name, m) });
  return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
} });
const load = testLoader({
  "@/lib/prisma": { prisma: spied }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => { if (faults.auditFails && data.entity === "partyMonthlyPlan") throw new Error("injected audit failure"); return tx.auditLog.create({ data }); } },
  "@/features/seasons/service.server": { listSeasons: async (_q: string, activeOnly: boolean) => (await prisma.season.findMany({ where: activeOnly ? { status: "OPEN" } : {} })).map((s) => ({ id: s.id })) },
  "@/features/planning/monthly-plan.server": { createDealerForOfficer: async () => ({}) },
});
const svc = load("src/features/party-planning/monthly.server.ts") as typeof import("./monthly.server");
const ctx = (userId: string, role: Role, groupId: string | null) => ({ userId, role, username: userId, groupId, designation: null }) as unknown as AuthContext;
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const msg = (p: Promise<unknown>) => p.then(() => "", (e: { message?: string }) => e.message ?? "");
const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const createList = async (c: AuthContext) => (await svc.listMonthlySheets(c, { stage: "create" })).map((s) => s.id);

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "PartyMonthlyOption","PartyMonthlyPlan","PartyMonthlySheet","SeasonalPlan","SeasonalPlanSheet","Market","AuditLog","SeasonMonth","Season","User","UserGroup" CASCADE`);
  const g = await prisma.userGroup.create({ data: { name: "State A" } });
  const mk = (u: string, role: Role) => prisma.user.create({ data: { passwordHash: "x", name: u, username: u, role, groupId: g.id } });
  const so1 = await mk("so1", Role.SALES_OFFICER), so2 = await mk("so2", Role.SALES_OFFICER);
  const A = ctx(so1.id, Role.SALES_OFFICER, g.id), B = ctx(so2.id, Role.SALES_OFFICER, g.id);
  // A season spanning two calendar years (Nov 2026 → Feb 2027), created in a scrambled order on purpose.
  const season = await prisma.season.create({ data: { name: "Rabi", year: 2026, status: "OPEN" } });
  const months = new Map<string, string>();
  for (const [i, [name, m, y]] of ([["Jan", 1, 2027], ["Nov", 11, 2026], ["Feb", 2, 2027], ["Dec", 12, 2026]] as const).entries())
    months.set(`${y}-${String(m).padStart(2, "0")}`, (await prisma.seasonMonth.create({ data: { seasonId: season.id, name, order: i + 1, calendarMonth: m, calendarYear: y } })).id);
  const closed = await prisma.season.create({ data: { name: "Kharif", year: 2025, status: "CLOSED" } });
  const closedMonth = await prisma.seasonMonth.create({ data: { seasonId: closed.id, name: "Jul", order: 1, calendarMonth: 7, calendarYear: 2025 } });
  const mkt = await Promise.all(["M1", "M2", "M3", "M4"].map((n) => prisma.market.create({ data: { name: n, nameKey: n.toLowerCase() } })));
  const sheet = await prisma.seasonalPlanSheet.create({ data: { seasonId: season.id, ownerId: so1.id } });
  const sp = await Promise.all(mkt.map((m) => prisma.seasonalPlan.create({ data: { sheetId: sheet.id, seasonId: season.id, ownerId: so1.id, marketId: m.id, approvalStatus: "APPROVED" } })));
  const jan = months.get("2027-01")!;
  const opt = (partyName: unknown, turnoverCategory: unknown, extra: Record<string, unknown> = {}) => ({ partyName, turnoverCategory, ...extra });
  const two = (i: number) => [opt(`P${i}`, "LT_50L"), opt(`S${i}`, "GT_4CR")];
  const body = (i: number, extra: Record<string, unknown> = {}) => ({ seasonalPlanId: sp[i]!.id, options: two(i), ...extra });

  // ---------- Create list = unfinished work; create-or-resume; concurrency
  same(await createList(A), [], "nothing yet");
  const first = await svc.createMonthlySheet(A, { seasonId: season.id, seasonMonthId: jan });
  same(await createList(A), [], "an empty editor (opened, Add Market cancelled, left) is not listed");
  const racers = await Promise.all(Array.from({ length: 8 }, () => svc.createMonthlySheet(A, { seasonId: season.id, seasonMonthId: jan }).then((s) => s.id, () => "failed")));
  assert.ok(racers.every((id) => id === first.id), `concurrent create-or-resume converges: ${racers.join()}`);
  assert.equal(await prisma.partyMonthlySheet.count(), 1);
  assert.equal(await prisma.auditLog.count({ where: { entity: "partyMonthlySheet", action: "CREATE" } }), 1, "one creation audit record");
  const fresh = await Promise.all([1, 2, 3].map(() => svc.createMonthlySheet(A, { seasonId: season.id, seasonMonthId: months.get("2026-12")! }).then((s) => s.id)));
  assert.equal(new Set(fresh).size, 1, "concurrent FIRST creation → exactly one sheet");
  assert.equal(await prisma.partyMonthlySheet.count({ where: { seasonMonthId: months.get("2026-12")! } }), 1);
  assert.equal(await code(svc.createMonthlySheet(B, { seasonId: season.id, seasonMonthId: jan })), 422, "no approved Seasonal market → still refused");
  assert.equal(await code(svc.createMonthlySheet(A, { seasonId: closed.id, seasonMonthId: closedMonth.id })), 409, "closed season");
  assert.equal(await code(svc.createMonthlySheet(A, { seasonId: season.id, seasonMonthId: closedMonth.id })), 422, "a month of another season");
  assert.equal(await code(svc.createMonthlyPlan(B, { sheetId: first.id, ...body(0) })), 404, "another owner cannot add to the sheet");

  // ---------- party options: variable number, at least two complete, each with its own turnover
  const e0 = await svc.createMonthlyPlan(A, { sheetId: first.id, ...body(0, { options: [opt("P0", "LT_50L"), opt("Q0", "GT_4CR"), opt("R0", "1CR_TO_2CR")] }) });
  same(e0.options.map((o) => [o.optionNo, o.partyName, o.turnoverCategory]), [[1, "P0", "LT_50L"], [2, "Q0", "GT_4CR"], [3, "R0", "1CR_TO_2CR"]], "three options, each keeps its OWN value, ordered by number");
  const e1 = await svc.createMonthlyPlan(A, { sheetId: first.id, ...body(1, { options: [opt("P1", "2CR_TO_4CR"), opt("  Q1  ", "50L_TO_1CR")] }) });
  same(e1.options.map((o) => [o.partyName, o.turnoverCategory]), [["P1", "2CR_TO_4CR"], ["Q1", "50L_TO_1CR"]], "two options is enough; names are trimmed");
  assert.equal(await prisma.partyMonthlyPlan.count({ where: { sheetId: first.id } }), 2, "extra options are NOT extra market entries");
  same(await createList(A), [first.id], "a saved draft appears in Create");
  same((await svc.getMonthlySheet(A, first.id, "create")).plans.length, 2, "reopening the editor shows the persisted drafts (no extra Save)");
  const bad = async (options: unknown, i = 2) => code(svc.createMonthlyPlan(A, { sheetId: first.id, seasonalPlanId: sp[i]!.id, options }));
  assert.equal(await bad(undefined), 422, "options are required");
  assert.equal(await bad("P,Q"), 422, "must be an array");
  assert.equal(await bad([]), 422); assert.equal(await bad([opt("P", "LT_50L")]), 422, "one option is not enough");
  assert.equal(await bad([opt("P", "LT_50L"), opt("", "LT_50L")]), 422, "every option needs a party name");
  assert.equal(await bad([opt("P", "LT_50L"), opt("   ", "LT_50L")]), 422, "a blank name is not a name");
  assert.equal(await bad([opt("P", "LT_50L"), opt("Q", "")]), 422, "every option needs a turnover");
  assert.equal(await bad([opt("P", "LT_50L"), opt("Q", undefined)]), 422);
  assert.equal(await bad([opt("P", "LT_50L"), opt("Q", "MILLION")]), 422, "unknown category");
  assert.equal(await bad([opt("P", "LT_50L"), opt("Q", "50 Lakh to 1 CR")]), 422, "display wording is not a value");
  assert.equal(await bad([opt("P", "LT_50L"), opt("Q".repeat(201), "LT_50L")]), 422, "the 200-character party-name limit");
  assert.equal(await bad([opt("P", "LT_50L", { optionNo: 1 }), opt("Q", "LT_50L", { optionNo: 1 })]), 422, "duplicate option numbers");
  assert.equal(await bad([opt("P", "LT_50L", { optionNo: 0 }), opt("Q", "LT_50L")]), 422); assert.equal(await bad([opt("P", "LT_50L", { optionNo: 11 }), opt("Q", "LT_50L")]), 422, "numbers are 1..10");
  assert.equal(await bad([opt("P", "LT_50L", { optionNo: 1.5 }), opt("Q", "LT_50L")]), 422);
  assert.equal(await bad(Array.from({ length: 11 }, (_, n) => opt(`P${n}`, "LT_50L"))), 422, "at most 10 options");
  assert.match(await msg(svc.createMonthlyPlan(A, { sheetId: first.id, seasonalPlanId: sp[2]!.id, options: [opt("P", "LT_50L"), opt("Q", "")] })), /Option 2: Tentative Turnover is required/);
  assert.match(await msg(svc.createMonthlyPlan(A, { sheetId: first.id, seasonalPlanId: sp[2]!.id, options: [opt("P", "LT_50L"), opt("Q", "LT_50L"), opt("", "LT_50L")] })), /Option 3: enter the party name/);
  assert.equal(await prisma.partyMonthlyPlan.count({ where: { sheetId: first.id } }), 2, "refused saves wrote nothing");
  assert.equal(await prisma.partyMonthlyOption.count({ where: { monthlyPlan: { sheetId: first.id } } }), 5);
  // ten options is fine; the legacy two-option database CHECK no longer limits the number
  const ten = await svc.createMonthlyPlan(A, { sheetId: first.id, seasonalPlanId: sp[2]!.id, options: Array.from({ length: 10 }, (_, n) => opt(`T${n}`, "LT_50L")) });
  assert.equal(ten.options.length, 10);
  await prisma.partyMonthlyOption.deleteMany({ where: { monthlyPlanId: ten.id } }); await prisma.partyMonthlyPlan.delete({ where: { id: ten.id } });
  // editing the COMPLETE list of a draft: existing options keep their ids; new ones are appended with the next numbers; removed ones are deleted
  const o1 = e1.options;
  const grown = await svc.updateMonthlyPlan(A, e1.id, { options: [...o1.map((o) => opt(o.partyName, o.turnoverCategory, { id: o.id })), opt("Added", "1CR_TO_2CR")] });
  same(grown.options.map((o) => [o.optionNo, o.partyName, o.turnoverCategory]), [[1, "P1", "2CR_TO_4CR"], [2, "Q1", "50L_TO_1CR"], [3, "Added", "1CR_TO_2CR"]], "an option added to an existing draft");
  same(grown.options.slice(0, 2).map((o) => o.id), o1.map((o) => o.id), "unchanged options keep their ids (not recreated)");
  const changed = await svc.updateMonthlyPlan(A, e1.id, { options: grown.options.map((o) => opt(o.optionNo === 2 ? "Q1 renamed" : o.partyName, o.optionNo === 3 ? "GT_4CR" : o.turnoverCategory, { id: o.id })) });
  same(changed.options.map((o) => [o.partyName, o.turnoverCategory]), [["P1", "2CR_TO_4CR"], ["Q1 renamed", "50L_TO_1CR"], ["Added", "GT_4CR"]]);
  const shrunk = await svc.updateMonthlyPlan(A, e1.id, { options: changed.options.filter((o) => o.optionNo !== 2).map((o) => opt(o.partyName, o.turnoverCategory, { id: o.id })) });
  same(shrunk.options.map((o) => o.optionNo), [1, 3], "a removed option leaves the others' numbers alone");
  const regrown = await svc.updateMonthlyPlan(A, e1.id, { options: [...shrunk.options.map((o) => opt(o.partyName, o.turnoverCategory, { id: o.id })), opt("Again", "LT_50L")] });
  same(regrown.options.map((o) => o.optionNo), [1, 2, 3], "a new option takes the lowest free number");
  const badUpdate = (options: unknown) => code(svc.updateMonthlyPlan(A, e1.id, { options }));
  assert.equal(await badUpdate(regrown.options.slice(0, 1).map((o) => opt(o.partyName, o.turnoverCategory, { id: o.id }))), 422, "the RESULTING list must still have two complete options");
  assert.equal(await badUpdate([...regrown.options.map((o) => opt(o.partyName, o.turnoverCategory, { id: o.id })), opt("", "")]), 422, "a blank extra option must be completed or removed");
  assert.equal(await badUpdate(regrown.options.map((o, n) => opt(o.partyName, n === 0 ? "" : o.turnoverCategory, { id: o.id }))), 422, "…and no option may lose its turnover");
  assert.equal(await badUpdate([opt("X", "LT_50L", { id: "someone-elses" }), opt("Y", "LT_50L")]), 422, "an unknown option id is refused");
  assert.equal(await badUpdate("nope"), 422);
  same((await svc.getMonthlySheet(A, first.id, "create")).plans.find((p) => p.id === e1.id)!.options.map((o) => o.partyName), regrown.options.map((o) => o.partyName), "persistence after refresh");
  // an option that already has history cannot be removed (it would orphan that history); the entry is untouched by the refusal
  await prisma.partyMonthlyEvent.create({ data: { monthlyPlanId: e0.id, optionId: e0.options[2]!.id, eventType: "PLAN_CREATED", toStatus: "PENDING", actorId: so1.id, actorName: "so1", actorRole: "SALES_OFFICER" } });
  assert.equal(await code(svc.updateMonthlyPlan(A, e0.id, { options: e0.options.slice(0, 2).map((o) => opt(o.partyName, o.turnoverCategory, { id: o.id })) })), 409);
  assert.equal((await prisma.partyMonthlyOption.count({ where: { monthlyPlanId: e0.id } })), 3);
  // a failed edit rolls back completely (nothing half-applied)
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pmo_fail2() RETURNS trigger AS $$ BEGIN IF NEW."partyName" = 'BOOM' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER pmo_fail2_t BEFORE INSERT ON "PartyMonthlyOption" FOR EACH ROW EXECUTE FUNCTION pmo_fail2()`);
  const beforeEdit = JSON.stringify((await prisma.partyMonthlyOption.findMany({ where: { monthlyPlanId: e1.id }, orderBy: { optionNo: "asc" } })).map((o) => [o.id, o.partyName, o.turnoverCategory]));
  assert.equal(await code(svc.updateMonthlyPlan(A, e1.id, { options: [opt("Renamed", "GT_4CR", { id: regrown.options[0]!.id }), opt(regrown.options[1]!.partyName, regrown.options[1]!.turnoverCategory, { id: regrown.options[1]!.id }), opt("BOOM", "LT_50L")] })), -1);
  await prisma.$executeRawUnsafe(`DROP TRIGGER pmo_fail2_t ON "PartyMonthlyOption"`); await prisma.$executeRawUnsafe(`DROP FUNCTION pmo_fail2()`);
  assert.equal(JSON.stringify((await prisma.partyMonthlyOption.findMany({ where: { monthlyPlanId: e1.id }, orderBy: { optionNo: "asc" } })).map((o) => [o.id, o.partyName, o.turnoverCategory])), beforeEdit, "an edit that fails part-way leaves the options exactly as they were");
  // the database still refuses a turnover without a party and unknown codes; and an out-of-range option number
  assert.equal(await code(prisma.partyMonthlyOption.update({ where: { id: regrown.options[0]!.id }, data: { turnoverCategory: "bogus" } })), -1, "…an unknown code");
  assert.equal(await code(prisma.partyMonthlyOption.create({ data: { monthlyPlanId: e1.id, optionNo: 11, partyName: "x", turnoverCategory: "LT_50L" } })), -1, "…and option numbers beyond the limit");
  assert.equal(await code(prisma.partyMonthlyOption.create({ data: { monthlyPlanId: e1.id, optionNo: 1, partyName: "dup", turnoverCategory: "LT_50L" } })), -1, "…and a repeated number within one entry");

  // ---------- the save transaction: short, atomic, bounded; response built after commit; no duplicates; clear failures
  const counts = async () => ({ plans: await prisma.partyMonthlyPlan.count(), options: await prisma.partyMonthlyOption.count(), audit: await prisma.auditLog.count({ where: { entity: "partyMonthlyPlan" } }) });
  let before = await counts();
  trace.length = 0;
  const saved = await svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3, { options: [opt("P3", "1CR_TO_2CR"), opt("Q3", "2CR_TO_4CR")] }) });
  same(trace, ["tx:start", "tx:end", "read"], "the entry is re-read AFTER the write transaction has completed — one write transaction, one read");
  same(lastTxOptions, { timeout: 15000, maxWait: 10000 }, "a bounded timeout for this save only (the global default is untouched)");
  same(saved.options.map((o) => o.turnoverCategory), ["1CR_TO_2CR", "2CR_TO_4CR"], "both turnover values are stored exactly as selected");
  before = await counts();
  await prisma.partyMonthlyPlan.delete({ where: { id: saved.id } }).catch(() => undefined); // (options first)
  await prisma.partyMonthlyOption.deleteMany({ where: { monthlyPlanId: saved.id } }); await prisma.partyMonthlyPlan.deleteMany({ where: { id: saved.id } });
  before = await counts();
  // complete rollback: an audit failure, and a failing option write, leave no entry, no orphaned option and no audit record
  faults.auditFails = true;
  assert.equal(await code(svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3) })), -1, "an audit failure fails the save");
  faults.auditFails = false;
  same(await counts(), before, "…and nothing is left behind");
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pmo_fail() RETURNS trigger AS $$ BEGIN IF NEW."optionNo" = 2 THEN RAISE EXCEPTION 'injected option failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER pmo_fail_t BEFORE INSERT ON "PartyMonthlyOption" FOR EACH ROW EXECUTE FUNCTION pmo_fail()`);
  assert.equal(await code(svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3) })), -1, "a failing option write fails the save");
  await prisma.$executeRawUnsafe(`DROP TRIGGER pmo_fail_t ON "PartyMonthlyOption"`); await prisma.$executeRawUnsafe(`DROP FUNCTION pmo_fail()`);
  same(await counts(), before, "…with no half-created entry and no orphaned first option");
  // a closed transaction (P2028) / busy database: recognised, not a generic 500, nothing written, never retried automatically
  faults.txClosed = true; trace.length = 0;
  const closedRes = await svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3) }).then(() => null, (e: { status?: number; message?: string }) => e);
  assert.equal(closedRes?.status, 503); assert.match(closedRes?.message ?? "", /database is busy/);
  same(trace, ["tx:start"], "no automatic retry"); same(await counts(), before);
  // the write committed but reading it back failed: the entry IS saved, the error says so, and the write is NOT run again
  faults.readFails = true; trace.length = 0;
  const readRes = await svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3) }).then(() => null, (e: { status?: number; message?: string }) => e);
  assert.equal(readRes?.status, 503); assert.match(readRes?.message ?? "", /was saved/);
  same(trace, ["tx:start", "tx:end", "read"], "exactly one write transaction");
  assert.equal((await counts()).plans, before.plans + 1, "the entry exists");
  await prisma.partyMonthlyOption.deleteMany({ where: { monthlyPlanId: (await prisma.partyMonthlyPlan.findFirstOrThrow({ where: { sheetId: first.id }, orderBy: { createdAt: "desc" } })).id } });
  await prisma.partyMonthlyPlan.deleteMany({ where: { sheetId: first.id, seasonalPlanId: sp[3]!.id } });
  before = await counts();
  // repeated / concurrent identical saves: exactly one entry
  const dup = await Promise.all(Array.from({ length: 6 }, () => code(svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3) }))));
  assert.equal(dup.filter((c) => c === 0).length, 1, `one winner: ${dup.join()}`);
  assert.ok(dup.filter((c) => c !== 0).every((c) => c === 409), "the rest get the clear 409 conflict, never a generic 500");
  const after = await counts();
  same([after.plans - before.plans, after.options - before.options, after.audit - before.audit], [1, 2, 1], "one entry, its two options, one audit record");
  await prisma.partyMonthlyOption.deleteMany({ where: { monthlyPlan: { seasonalPlanId: sp[3]!.id } } }); await prisma.partyMonthlyPlan.deleteMany({ where: { seasonalPlanId: sp[3]!.id } });

  // ---------- historical rows: null turnover is "not recorded", never guessed, and blocks nothing unrelated
  const legacy = await svc.createMonthlyPlan(A, { sheetId: first.id, ...body(2) });
  // simulate a pre-migration draft: Option 1 has a party but no turnover, Option 2 is the blank placeholder every old entry had
  await prisma.partyMonthlyOption.updateMany({ where: { monthlyPlanId: legacy.id }, data: { turnoverCategory: null } });
  await prisma.partyMonthlyOption.updateMany({ where: { monthlyPlanId: legacy.id, optionNo: 2 }, data: { partyName: null } });
  same((await svc.getMonthlySheet(A, first.id, "create")).plans.find((p) => p.id === legacy.id)!.options[0]!.turnoverCategory, null);
  assert.equal(await code(svc.updateMonthlyPlan(A, legacy.id, { planDate: "2027-01-15" })), 0, "an unrelated edit of a legacy row is not blocked");
  assert.equal(await code(svc.submitMonthlySheet(A, first.id)), 422, "submission revalidates: a legacy draft needs two complete options first");
  assert.equal(await prisma.partyMonthlyPlan.count({ where: { sheetId: first.id, approvalStatus: "DRAFT" } }), 3, "nothing was submitted");
  const legacyOpts = (await svc.getMonthlySheet(A, first.id, "create")).plans.find((p) => p.id === legacy.id)!.options;
  assert.equal(await code(svc.updateMonthlyPlan(A, legacy.id, { options: legacyOpts.map((o) => opt(o.partyName ?? "", "LT_50L", { id: o.id })) })), 422, "the blank legacy placeholder must be completed (or removed) — and with it removed only one option would remain");
  const fixed = await svc.updateMonthlyPlan(A, legacy.id, { options: legacyOpts.map((o) => opt(o.optionNo === 2 ? "Filled in" : o.partyName, "LT_50L", { id: o.id })) });
  same(fixed.options.map((o) => o.id), legacyOpts.map((o) => o.id), "the persisted option rows (and their ids) are reused");

  // ---------- partial submission, full submission, reopen the same month
  await prisma.partyMonthlyPlan.update({ where: { id: e0.id }, data: { approvalStatus: "REJECTED", rejectionReason: "fix", rejectionStage: "RM" } });
  same((await svc.getMonthlySheet(A, first.id, "create")).plans.length, 3, "rejected entries awaiting correction stay editable in Create");
  const sub = await svc.submitMonthlySheet(A, first.id);
  assert.equal(sub.counts.submitted, 3);
  same(await createList(A), [], "after Submit All the month leaves Create");
  same((await svc.listMonthlySheets(A, { stage: "submitted" })).map((s) => s.id), [first.id], "…and sits under Submitted");
  const again = await svc.createMonthlySheet(A, { seasonId: season.id, seasonMonthId: jan });
  assert.equal(again.id, first.id, "Create Monthly Plan reopens the same month");
  same((await svc.getMonthlySheet(A, again.id, "create")).plans.length, 0, "blank create-stage editor; earlier entries are kept");
  same((await svc.getMonthlySheet(A, again.id, "create")).seasonalPlans.map((p) => p.id), [sp[3]!.id], "only markets not yet planned this month are offered");
  const late = await svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3) });
  same(await createList(A), [first.id], "a new draft puts the month back in Create while the others stay submitted");
  assert.equal(await code(svc.createMonthlyPlan(A, { sheetId: first.id, ...body(3) })), 409, "duplicate market in a month");
  // an approved legacy row (no turnover) is displayed as such and its operational edits are not blocked
  await prisma.partyMonthlyPlan.update({ where: { id: legacy.id }, data: { approvalStatus: "APPROVED" } });
  await prisma.partyMonthlyOption.updateMany({ where: { monthlyPlanId: legacy.id }, data: { turnoverCategory: null } });
  assert.equal((await svc.getMonthlySheet(A, first.id, "approved")).plans[0]!.options[0]!.turnoverCategory, null, "historical value is null (displayed as Not recorded)");
  assert.equal(await code(svc.updateMonthlyPlan(A, legacy.id, { planDate: "2027-01-20" })), 0, "operational edits on historical rows are not blocked by the missing turnover");
  void late;

  // ---------- Create dialog defaults: stored calendar identity, year boundaries, overlaps
  const opts = await svc.getMonthlyOptions(A);
  assert.equal(opts.currentMonthKey, currentBusinessDate().slice(0, 7), "the running month comes from the Asia/Kolkata business date");
  const rabi = opts.seasons.find((s) => s.id === season.id)!;
  same(rabi.months.map((m) => m.key), ["2026-11", "2026-12", "2027-01", "2027-02"], "calendar order, spanning two years");
  const pick = (key: string, seasons = opts.seasons) => defaultMonthlySelection(seasons, key);
  same(pick("2027-01"), { seasonId: season.id, monthId: jan }, "January 2027 inside a Nov 2026 – Feb 2027 season");
  same(pick("2026-12"), { seasonId: season.id, monthId: months.get("2026-12")! }, "an existing sheet for the month does not disqualify the default");
  same(pick("2026-01"), { seasonId: "", monthId: "" }, "January 2026 is not January 2027 (identity, not month name)");
  same(pick("2027-03"), { seasonId: "", monthId: "" }, "outside the season");
  assert.equal(monthIdForKey(rabi.months, "2027-02"), months.get("2027-02"));
  same(pick("2027-01", opts.seasons.map((s) => ({ ...s, eligibleCount: 0 }))), { seasonId: "", monthId: "" }, "no approved markets → nothing suggested");
  same(pick("2027-01", [...opts.seasons, { ...rabi, id: "overlap", eligibleCount: 1 }]), { seasonId: "", monthId: "" }, "overlapping qualifying seasons → left for explicit selection");
  console.log("monthly-create-resume.integration.ts — all scenarios passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
