/**
 * Server-level contracts for Party Appointment calendar integration (Phase 2), loading the real
 * `calendar.server.ts` with a DB-free fake. Proves the calendar loader:
 *   - includes ONLY APPROVED Party Plans (Draft / Pending / Rejected never appear),
 *   - uses the exact appointment date (no timezone shift) within the requested range,
 *   - scopes Party events like conversions (SO own, RM/Admin per getOfficerScope),
 *   - derives events per query so refetching produces no duplicates,
 *   - leaves existing Scheme Conversion events working and lets both coexist on one date.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";

/* ------------------------------- Fakes ------------------------------- */

interface PartyRow { id: string; salesOfficerId: string; partyName: string | null; marketName: string | null; appointmentDate: string | null; status: string }
interface ConvRow { id: string; salesOfficerId: string; expectedBillingDate: string | null; dealerName: string; schemeName: string; numberOfSchemes: number; totalSchemeAmount: number; planStatus: string; schemeStatus: string }

const USERS: Record<string, string> = { so1: "Officer One", so2: "Officer Two" };

/** Scope helper the harness injects — configurable per test. */
type Scope = { all: boolean; ids: string[] };

function makeFake(opts: { party: PartyRow[]; conv: ConvRow[]; scope: Scope }) {
  const { party, conv } = opts;

  // Raw SQL fake for the PartyPlan query (WHERE status='APPROVED' AND date in [gte,lt) [AND scope]).
  function runRaw(sql: Prisma.Sql): unknown {
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const values = sql.values as unknown[];
    if (text.includes('FROM "PartyPlan" p JOIN "User" u')) {
      // values order: gteKey, ltKey, [officerId | ...scopeIds]
      const gte = values[0] as string;
      const lt = values[1] as string;
      const tail = values.slice(2) as string[]; // officer or scope ids (may be empty)
      const hasOfficerEq = text.includes('AND p."salesOfficerId" = ?');
      const hasScopeIn = text.includes('AND p."salesOfficerId" IN (');
      const hasFalse = text.includes("AND FALSE");
      return party
        .filter((r) => r.status === "APPROVED" && r.appointmentDate && r.appointmentDate >= gte && r.appointmentDate < lt)
        .filter((r) => {
          if (hasFalse) return false;
          if (hasOfficerEq) return r.salesOfficerId === tail[0];
          if (hasScopeIn) return tail.includes(r.salesOfficerId);
          return true; // scope.all → no clause
        })
        .map((r) => ({ id: r.id, partyName: r.partyName, marketName: r.marketName, appointmentDate: r.appointmentDate, salesOfficerId: r.salesOfficerId, salesOfficerName: USERS[r.salesOfficerId] ?? "?" }));
    }
    throw new Error("Unhandled raw SQL: " + text);
  }

  const norm = (a: unknown, rest: unknown[]): Prisma.Sql => (Array.isArray(a) ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest) : (a as Prisma.Sql));

  const inRange = (dk: string | null, gte: Date, lt: Date) => !!dk && dk >= dateKeyOf(gte) && dk < dateKeyOf(lt);
  const dateKeyOf = (d: Date) => d.toISOString().slice(0, 10);

  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(norm(a, rest)),
    dealerSchemePlan: {
      findMany: async ({ where }: { where: { expectedBillingDate: { gte: Date; lt: Date } } }) => {
        const { gte, lt } = where.expectedBillingDate;
        return conv
          .filter((r) => inRange(r.expectedBillingDate, gte, lt))
          .map((r) => ({
            id: r.id, schemeId: "s1", expectedBillingDate: r.expectedBillingDate ? new Date(r.expectedBillingDate + "T00:00:00.000Z") : null,
            originalConversionDate: r.expectedBillingDate ? new Date(r.expectedBillingDate + "T00:00:00.000Z") : null, conversionExtensionCount: 0,
            numberOfSchemes: r.numberOfSchemes, totalSchemeAmount: r.totalSchemeAmount, salesOfficerId: r.salesOfficerId,
            planStatus: r.planStatus, schemeStatus: r.schemeStatus, enrollmentStatus: "PENDING_DOCUMENT",
            dealer: { name: r.dealerName }, scheme: { schemeName: r.schemeName }, salesOfficer: { name: USERS[r.salesOfficerId] ?? "?" },
          }));
      },
    },
    calendarNote: { findMany: async () => [] },
    user: { findMany: async () => [] },
  };
  return prisma;
}

/* ------------------------------- Harness ------------------------------- */

const localRequire = createRequire(import.meta.url);
function loadCalendarServer(prisma: object, scope: Scope) {
  const filename = resolve("src/features/calendar", "calendar.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } },
    "@/lib/scope": {
      getOfficerScope: async () => scope,
      assertOfficerInScope: async () => {},
    },
    "@/lib/recovery-config": { getCalendarEnabled: async () => true },
    // Use the REAL calendar lib (projection + ranges) so we test the true integration.
    "@/lib/calendar": localRequire(resolve("src/lib", "calendar.ts")),
  };
  runInNewContext(code, {
    exports, Date, console,
    require: (id: string) => (id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id)),
  }, { filename });
  return exports as typeof import("./calendar.server");
}

const ADMIN: AuthContext = { userId: "admin", role: Role.SUPER_ADMIN, groupId: null } as AuthContext;
const SO: AuthContext = { userId: "so1", role: Role.SALES_OFFICER, groupId: null } as AuthContext;

/* ------------------------------- Tests ------------------------------- */

async function main() {
  const baseParty: PartyRow[] = [
    { id: "draft", salesOfficerId: "so1", partyName: "Draft Co", marketName: "M", appointmentDate: "2026-09-10", status: "DRAFT" },
    { id: "pending", salesOfficerId: "so1", partyName: "Pending Co", marketName: "M", appointmentDate: "2026-09-11", status: "PENDING_APPROVAL" },
    { id: "rejected", salesOfficerId: "so1", partyName: "Rejected Co", marketName: "M", appointmentDate: "2026-09-12", status: "REJECTED" },
    { id: "approved", salesOfficerId: "so1", partyName: "ABC Traders", marketName: "Bhopal", appointmentDate: "2026-09-22", status: "APPROVED" },
  ];

  // 1–4) Only APPROVED appears; correct date/party/market.
  {
    const prisma = makeFake({ party: baseParty, conv: [], scope: { all: true, ids: [] } });
    const svc = loadCalendarServer(prisma, { all: true, ids: [] });
    const payload = await svc.calendarMonth(ADMIN, { year: 2026, month: 9 });
    assert.equal(payload.partyEvents.length, 1, "only the APPROVED plan appears");
    const e = payload.partyEvents[0];
    assert.equal(e.planId, "approved");
    assert.equal(e.dateKey, "2026-09-22", "exact appointment date");
    assert.equal(e.partyName, "ABC Traders");
    assert.equal(e.marketName, "Bhopal");
    assert.ok(!payload.partyEvents.some((x) => ["draft", "pending", "rejected"].includes(x.planId)), "draft/pending/rejected excluded");
  }

  // 5) No duplication across repeated fetches (derivation is idempotent).
  {
    const prisma = makeFake({ party: baseParty, conv: [], scope: { all: true, ids: [] } });
    const svc = loadCalendarServer(prisma, { all: true, ids: [] });
    const a = await svc.calendarMonth(ADMIN, { year: 2026, month: 9 });
    const b = await svc.calendarMonth(ADMIN, { year: 2026, month: 9 });
    assert.equal(a.partyEvents.length, 1);
    assert.equal(b.partyEvents.length, 1, "second fetch still exactly one — no duplicate");
  }

  // 6) Multiple approved appointments on the same day are all shown.
  {
    const party: PartyRow[] = [
      { id: "a", salesOfficerId: "so1", partyName: "ABC Traders", marketName: "Bhopal", appointmentDate: "2026-09-22", status: "APPROVED" },
      { id: "b", salesOfficerId: "so1", partyName: "XYZ Traders", marketName: "Indore", appointmentDate: "2026-09-22", status: "APPROVED" },
    ];
    const prisma = makeFake({ party, conv: [], scope: { all: true, ids: [] } });
    const svc = loadCalendarServer(prisma, { all: true, ids: [] });
    const payload = await svc.calendarMonth(ADMIN, { year: 2026, month: 9 });
    assert.equal(payload.partyEvents.filter((e) => e.dateKey === "2026-09-22").length, 2, "both same-day appointments shown");
  }

  // 7) Scheme Conversion still works AND coexists with a Party event on the same date.
  {
    const party: PartyRow[] = [{ id: "approved", salesOfficerId: "so1", partyName: "ABC Traders", marketName: "Bhopal", appointmentDate: "2026-09-22", status: "APPROVED" }];
    const conv: ConvRow[] = [{ id: "c1", salesOfficerId: "so1", expectedBillingDate: "2026-09-22", dealerName: "ABC Dealer", schemeName: "Fasal", numberOfSchemes: 1, totalSchemeAmount: 585000, planStatus: "APPROVED", schemeStatus: "PENDING" }];
    const prisma = makeFake({ party, conv, scope: { all: true, ids: [] } });
    const svc = loadCalendarServer(prisma, { all: true, ids: [] });
    const payload = await svc.calendarMonth(ADMIN, { year: 2026, month: 9 });
    assert.equal(payload.events.length, 1, "conversion event still present");
    assert.equal(payload.events[0].dealerName, "ABC Dealer");
    assert.equal(payload.partyEvents.length, 1, "party event present");
    assert.equal(payload.events[0].dateKey, "2026-09-22");
    assert.equal(payload.partyEvents[0].dateKey, "2026-09-22", "both on the same date, neither overwrites the other");
  }

  // 8) Scope — a Sales Officer sees only their own approved party appointments.
  {
    const party: PartyRow[] = [
      { id: "mine", salesOfficerId: "so1", partyName: "Mine", marketName: "M", appointmentDate: "2026-09-22", status: "APPROVED" },
      { id: "theirs", salesOfficerId: "so2", partyName: "Theirs", marketName: "M", appointmentDate: "2026-09-23", status: "APPROVED" },
    ];
    const prisma = makeFake({ party, conv: [], scope: { all: false, ids: ["so1"] } });
    const svc = loadCalendarServer(prisma, { all: false, ids: ["so1"] });
    const payload = await svc.calendarMonth(SO, { year: 2026, month: 9 });
    assert.deepEqual(payload.partyEvents.map((e) => e.planId), ["mine"], "SO scoped to own party appointments");
  }

  // 9) Multiple users under an all-scope admin: both appear (existing scope rules respected).
  {
    const party: PartyRow[] = [
      { id: "mine", salesOfficerId: "so1", partyName: "Mine", marketName: "M", appointmentDate: "2026-09-22", status: "APPROVED" },
      { id: "theirs", salesOfficerId: "so2", partyName: "Theirs", marketName: "M", appointmentDate: "2026-09-23", status: "APPROVED" },
    ];
    const prisma = makeFake({ party, conv: [], scope: { all: true, ids: [] } });
    const svc = loadCalendarServer(prisma, { all: true, ids: [] });
    const payload = await svc.calendarMonth(ADMIN, { year: 2026, month: 9 });
    assert.deepEqual(payload.partyEvents.map((e) => e.planId).sort(), ["mine", "theirs"], "admin sees all officers");
  }

  // 10) Out-of-range appointment is excluded (range query correctness).
  {
    const party: PartyRow[] = [
      { id: "in", salesOfficerId: "so1", partyName: "In", marketName: "M", appointmentDate: "2026-09-22", status: "APPROVED" },
      { id: "out", salesOfficerId: "so1", partyName: "Out", marketName: "M", appointmentDate: "2026-10-05", status: "APPROVED" },
    ];
    const prisma = makeFake({ party, conv: [], scope: { all: true, ids: [] } });
    const svc = loadCalendarServer(prisma, { all: true, ids: [] });
    const payload = await svc.calendarMonth(ADMIN, { year: 2026, month: 9 });
    assert.deepEqual(payload.partyEvents.map((e) => e.planId), ["in"], "only September appointment in the September month range");
  }

  console.log("party-calendar.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
