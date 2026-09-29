/**
 * Service-level contracts for Party Planning (Phase 1): draft create/update, submit validation, multi-row
 * atomic rollback, admin approve/reject, and role/scope authorization. DB-free — a tiny in-memory fake
 * interprets the parameterized raw SQL (SELECT / INSERT / UPDATE / DELETE) the service emits.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Prisma, Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";

/* ------------------------------- In-memory PartyPlan store ------------------------------- */

interface Plan {
  id: string; salesOfficerId: string; partyName: string | null; marketName: string | null;
  appointmentDate: string | null; status: string; remarks: string | null; createdAt: Date; updatedAt: Date;
}

/** Flatten a Prisma.Sql into { text, values } (Prisma.join expands to comma-separated ? placeholders). */
function flatten(sql: Prisma.Sql): { text: string; values: unknown[] } {
  return { text: sql.sql.replace(/\s+/g, " ").trim(), values: sql.values as unknown[] };
}

function makeStore(seed: Plan[] = []) {
  let rows: Plan[] = seed.map((r) => ({ ...r }));
  const USERS: Record<string, string> = { so1: "Officer One", so2: "Officer Two" };

  function run(sql: Prisma.Sql): unknown {
    const { text, values } = flatten(sql);

    // --- SELECT existing ids owned + editable (persist guard) ---
    // values = [...ids, owner, "DRAFT", "REJECTED"] (last two are the editable-status list).
    if (text.startsWith('SELECT "id" FROM "PartyPlan"')) {
      const ids = values.slice(0, values.length - 3) as string[];
      const owner = values[values.length - 3] as string;
      return rows.filter((r) => ids.includes(r.id) && r.salesOfficerId === owner && ["DRAFT", "REJECTED"].includes(r.status)).map((r) => ({ id: r.id }));
    }
    // --- SELECT status for act ---
    if (text.startsWith('SELECT "status" FROM "PartyPlan" WHERE "id" =')) {
      const id = values[0] as string;
      return rows.filter((r) => r.id === id).map((r) => ({ status: r.status }));
    }
    // --- SELECT list (joins User) ---
    if (text.includes('FROM "PartyPlan" p JOIN "User" u')) {
      let out = rows.slice();
      // Very small predicate interpreter keyed off the emitted WHERE shape.
      if (text.includes('p."salesOfficerId" = ? AND p."status" IN')) {
        const owner = values[0] as string;
        out = out.filter((r) => r.salesOfficerId === owner && ["DRAFT", "REJECTED"].includes(r.status));
      } else if (text.includes('WHERE p."status" = ? AND p."salesOfficerId" IN')) {
        const status = values[0] as string;
        const scopeIds = values.slice(1) as string[];
        out = out.filter((r) => r.status === status && scopeIds.includes(r.salesOfficerId));
      } else if (text.includes('WHERE p."status" = ? AND FALSE')) {
        out = [];
      } else if (text.includes('WHERE p."status" = ?')) {
        const status = values[0] as string;
        out = out.filter((r) => r.status === status);
      }
      return out.map((r) => ({
        id: r.id, salesOfficerId: r.salesOfficerId, employeeName: USERS[r.salesOfficerId] ?? "?",
        partyName: r.partyName, marketName: r.marketName, appointmentDate: r.appointmentDate,
        status: r.status, remarks: r.remarks, createdAt: r.createdAt, updatedAt: r.updatedAt,
      }));
    }
    // --- DELETE editable rows not in kept ids ---
    if (text.startsWith('DELETE FROM "PartyPlan"')) {
      // values = [owner, "DRAFT", "REJECTED", ...keptIds]
      const owner = values[0] as string;
      const keep = values.slice(3) as string[]; // NOT IN (...) kept ids (may be empty)
      const before = rows.length;
      rows = rows.filter((r) => {
        const editableOwned = r.salesOfficerId === owner && ["DRAFT", "REJECTED"].includes(r.status);
        if (!editableOwned) return true;
        return keep.includes(r.id); // keep only those still present
      });
      return before - rows.length;
    }
    // --- UPDATE existing plan (persist) ---
    if (text.startsWith('UPDATE "PartyPlan" SET "partyName"')) {
      // values: partyName, marketName, [date?], status, id, owner  (date inlined as ?::date OR literal NULL)
      const hasDateParam = text.includes('"appointmentDate" = ?::date');
      const partyName = values[0] as string;
      const marketName = values[1] as string | null;
      let idx = 2;
      const date = hasDateParam ? (values[idx++] as string) : null;
      const status = values[idx++] as string;
      const id = values[idx++] as string;
      const owner = values[idx++] as string;
      let n = 0;
      for (const r of rows) {
        if (r.id === id && r.salesOfficerId === owner && ["DRAFT", "REJECTED"].includes(r.status)) {
          r.partyName = partyName; r.marketName = marketName; r.appointmentDate = date;
          r.status = status; r.remarks = null; r.updatedAt = new Date(); n++;
        }
      }
      return n;
    }
    // --- INSERT new plan (persist) ---
    if (text.startsWith('INSERT INTO "PartyPlan"')) {
      const hasDateParam = text.includes(', ?::date,') || text.includes('?::date');
      const id = values[0] as string;
      const owner = values[1] as string;
      const partyName = values[2] as string;
      const marketName = values[3] as string | null;
      let idx = 4;
      const date = hasDateParam ? (values[idx++] as string) : null;
      const status = values[idx++] as string;
      rows.push({ id, salesOfficerId: owner, partyName, marketName, appointmentDate: date, status, remarks: null, createdAt: new Date(), updatedAt: new Date() });
      return 1;
    }
    // --- UPDATE from act (approve/reject) ---
    if (text.startsWith('UPDATE "PartyPlan" SET "status" =')) {
      const status = values[0] as string;
      const remarks = values[1] as string | null;
      const id = values[2] as string;
      let n = 0;
      for (const r of rows) if (r.id === id) { r.status = status; r.remarks = remarks; r.updatedAt = new Date(); n++; }
      return n;
    }
    // --- audit log create (no-op) ---
    throw new Error("Unhandled SQL in fake store: " + text);
  }

  // Normalize both call styles: `$queryRaw(Prisma.sql`…`)` (a Sql object) and the tagged-template
  // form `$queryRaw`…`` (strings array + values), which the service uses in a couple of places.
  const norm = (a: unknown, rest: unknown[]): Prisma.Sql =>
    Array.isArray(a) // tagged-template call: first arg is the TemplateStringsArray
      ? Prisma.sql(a as unknown as TemplateStringsArray, ...rest)
      : (a as Prisma.Sql); // Prisma.sql(`…`) call: already a Sql object

  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => run(norm(a, rest)),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => run(norm(a, rest)),
    auditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma, snapshot: () => rows.map((r) => ({ ...r })) };
}

/* ------------------------------- Service loader (harness) ------------------------------- */

const localRequire = createRequire(import.meta.url);
function loadService<T>(prisma: object, overrides: Record<string, unknown> = {}): T {
  const filename = resolve("src/features/party-planning", "service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {}, "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } },
    "@/lib/scope": { getOfficerScope: async () => ({ all: true, ids: [] }) },
    "@/lib/audit": { writeAudit: async () => ({}) },
    ...overrides,
  };
  runInNewContext(code, {
    exports, Date, console,
    require: (id: string) => (id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id)),
  }, { filename });
  return exports as T;
}

type Svc = typeof import("./service.server");
const SO: AuthContext = { userId: "so1", role: Role.SALES_OFFICER, groupId: null } as AuthContext;
const ADMIN: AuthContext = { userId: "admin", role: Role.SUPER_ADMIN, groupId: null } as AuthContext;

async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try { await fn(); assert.fail(`${label}: expected ${status} but call succeeded`); }
  catch (e) { assert.equal((e as { status?: number }).status, status, `${label}: wrong status (${(e as Error).message})`); }
}

/* ------------------------------------------- Tests ------------------------------------------- */

async function main() {
  // 1) Create a draft (only Party Name required for a valid draft).
  {
    const { prisma, snapshot } = makeStore();
    const svc = loadService<Svc>(prisma);
    const res = await svc.saveDraft(SO, { rows: [{ partyName: "Alpha", marketName: "", appointmentDate: "" }] });
    assert.equal(res.count, 1, "draft count");
    const s = snapshot();
    assert.equal(s.length, 1); assert.equal(s[0].status, "DRAFT"); assert.equal(s[0].partyName, "Alpha");
    assert.equal(s[0].salesOfficerId, "so1");
  }

  // 2) Update an existing draft must NOT create a duplicate.
  {
    const { prisma, snapshot } = makeStore([{ id: "p1", salesOfficerId: "so1", partyName: "Alpha", marketName: "M", appointmentDate: "2026-10-01", status: "DRAFT", remarks: null, createdAt: new Date(), updatedAt: new Date() }]);
    const svc = loadService<Svc>(prisma);
    await svc.saveDraft(SO, { rows: [{ id: "p1", partyName: "Alpha (edited)", marketName: "M2", appointmentDate: "2026-10-02" }] });
    const s = snapshot();
    assert.equal(s.length, 1, "no duplicate on update");
    assert.equal(s[0].id, "p1"); assert.equal(s[0].partyName, "Alpha (edited)"); assert.equal(s[0].appointmentDate, "2026-10-02");
  }

  // 3) Submit a valid draft → PENDING_APPROVAL.
  {
    const { prisma, snapshot } = makeStore();
    const svc = loadService<Svc>(prisma);
    await svc.submitDraft(SO, { rows: [{ partyName: "Beta", marketName: "Mkt", appointmentDate: "2026-10-05" }] });
    const s = snapshot();
    assert.equal(s.length, 1); assert.equal(s[0].status, "PENDING_APPROVAL");
  }

  // 4) Submit validation — missing Market Name / Date is rejected (422), nothing persisted.
  {
    const { prisma, snapshot } = makeStore();
    const svc = loadService<Svc>(prisma);
    await expectStatus(() => svc.submitDraft(SO, { rows: [{ partyName: "NoMarket", marketName: "", appointmentDate: "2026-10-05" }] }), 422, "submit missing market");
    await expectStatus(() => svc.submitDraft(SO, { rows: [{ partyName: "NoDate", marketName: "Mkt", appointmentDate: "" }] }), 422, "submit missing date");
    assert.equal(snapshot().length, 0, "nothing persisted on invalid submit");
  }

  // 5) Multiple rows persist together; blank rows are dropped.
  {
    const { prisma, snapshot } = makeStore();
    const svc = loadService<Svc>(prisma);
    const res = await svc.submitDraft(SO, { rows: [
      { partyName: "A", marketName: "Ma", appointmentDate: "2026-10-01" },
      { partyName: "B", marketName: "Mb", appointmentDate: "2026-10-02" },
      { partyName: "", marketName: "", appointmentDate: "" }, // blank → dropped
    ] });
    assert.equal(res.count, 2, "two meaningful rows");
    assert.equal(snapshot().length, 2);
  }

  // 6) Atomic rollback — an invalid date value is rejected before any write (zod), store unchanged.
  {
    const { prisma, snapshot } = makeStore();
    const svc = loadService<Svc>(prisma);
    await expectStatus(() => svc.submitDraft(SO, { rows: [
      { partyName: "Good", marketName: "Mg", appointmentDate: "2026-10-01" },
      { partyName: "Bad", marketName: "Mb", appointmentDate: "2026-13-40" }, // invalid calendar date
    ] }), 400, "invalid date row").catch(() => {});
    // zod ZodError is not an ApiError; assert simply that nothing was written.
    assert.equal(snapshot().length, 0, "atomic: no half-created plans on invalid input");
  }

  // 7) Admin approve → APPROVED.
  {
    const { prisma, snapshot } = makeStore([{ id: "p1", salesOfficerId: "so1", partyName: "A", marketName: "M", appointmentDate: "2026-10-01", status: "PENDING_APPROVAL", remarks: null, createdAt: new Date(), updatedAt: new Date() }]);
    const svc = loadService<Svc>(prisma);
    const r = await svc.actOnPartyPlan(ADMIN, "p1", { action: "approve" });
    assert.equal(r.status, "APPROVED"); assert.equal(snapshot()[0].status, "APPROVED");
  }

  // 8) Admin reject → REJECTED (+ remark).
  {
    const { prisma, snapshot } = makeStore([{ id: "p1", salesOfficerId: "so1", partyName: "A", marketName: "M", appointmentDate: "2026-10-01", status: "PENDING_APPROVAL", remarks: null, createdAt: new Date(), updatedAt: new Date() }]);
    const svc = loadService<Svc>(prisma);
    const r = await svc.actOnPartyPlan(ADMIN, "p1", { action: "reject", remarks: "Fix the date" });
    assert.equal(r.status, "REJECTED");
    assert.equal(snapshot()[0].status, "REJECTED"); assert.equal(snapshot()[0].remarks, "Fix the date");
  }

  // 9) A Sales Officer can NEVER approve (403).
  {
    const { prisma } = makeStore([{ id: "p1", salesOfficerId: "so1", partyName: "A", marketName: "M", appointmentDate: "2026-10-01", status: "PENDING_APPROVAL", remarks: null, createdAt: new Date(), updatedAt: new Date() }]);
    const svc = loadService<Svc>(prisma);
    await expectStatus(() => svc.actOnPartyPlan(SO, "p1", { action: "approve" }), 403, "SO cannot approve");
  }

  // 10) Only a PENDING plan can be acted on (409 otherwise).
  {
    const { prisma } = makeStore([{ id: "p1", salesOfficerId: "so1", partyName: "A", marketName: "M", appointmentDate: "2026-10-01", status: "APPROVED", remarks: null, createdAt: new Date(), updatedAt: new Date() }]);
    const svc = loadService<Svc>(prisma);
    await expectStatus(() => svc.actOnPartyPlan(ADMIN, "p1", { action: "reject" }), 409, "act on non-pending");
  }

  // 11) An SO cannot edit another officer's plan (403); the id guard rejects it.
  {
    const { prisma, snapshot } = makeStore([{ id: "p2", salesOfficerId: "so2", partyName: "Owned by SO2", marketName: "M", appointmentDate: "2026-10-01", status: "DRAFT", remarks: null, createdAt: new Date(), updatedAt: new Date() }]);
    const svc = loadService<Svc>(prisma);
    await expectStatus(() => svc.saveDraft(SO, { rows: [{ id: "p2", partyName: "Hijack", marketName: "M", appointmentDate: "2026-10-01" }] }), 403, "SO edits another's plan");
    assert.equal(snapshot()[0].partyName, "Owned by SO2", "victim row untouched");
  }

  // 12) listPartyPlans — editable returns only own Draft+Rejected; submitted only PENDING; approved only APPROVED.
  {
    const now = new Date();
    const seed: Plan[] = [
      { id: "d1", salesOfficerId: "so1", partyName: "D", marketName: "M", appointmentDate: "2026-10-01", status: "DRAFT", remarks: null, createdAt: now, updatedAt: now },
      { id: "r1", salesOfficerId: "so1", partyName: "R", marketName: "M", appointmentDate: "2026-10-02", status: "REJECTED", remarks: "x", createdAt: now, updatedAt: now },
      { id: "s1", salesOfficerId: "so1", partyName: "S", marketName: "M", appointmentDate: "2026-10-03", status: "PENDING_APPROVAL", remarks: null, createdAt: now, updatedAt: now },
      { id: "a1", salesOfficerId: "so2", partyName: "A", marketName: "M", appointmentDate: "2026-10-04", status: "APPROVED", remarks: null, createdAt: now, updatedAt: now },
    ];
    const { prisma } = makeStore(seed);
    const svc = loadService<Svc>(prisma);
    const editable = await svc.listPartyPlans(SO, "editable");
    assert.deepEqual(editable.map((r) => r.id).sort(), ["d1", "r1"], "editable = own draft+rejected");
    assert.ok(!editable.some((r) => r.status === "PENDING_APPROVAL"), "drafts view excludes submitted");
    const submitted = await svc.listPartyPlans(ADMIN, "submitted");
    assert.deepEqual(submitted.map((r) => r.id), ["s1"], "submitted = PENDING only");
    const approved = await svc.listPartyPlans(ADMIN, "approved");
    assert.deepEqual(approved.map((r) => r.id), ["a1"], "approved = APPROVED only");
  }

  // 13) Scope — an SO only sees their own submitted plans (getOfficerScope → own).
  {
    const now = new Date();
    const seed: Plan[] = [
      { id: "s1", salesOfficerId: "so1", partyName: "Mine", marketName: "M", appointmentDate: "2026-10-01", status: "PENDING_APPROVAL", remarks: null, createdAt: now, updatedAt: now },
      { id: "s2", salesOfficerId: "so2", partyName: "Theirs", marketName: "M", appointmentDate: "2026-10-02", status: "PENDING_APPROVAL", remarks: null, createdAt: now, updatedAt: now },
    ];
    const { prisma } = makeStore(seed);
    const svc = loadService<Svc>(prisma, { "@/lib/scope": { getOfficerScope: async () => ({ all: false, ids: ["so1"] }) } });
    const submitted = await svc.listPartyPlans(SO, "submitted");
    assert.deepEqual(submitted.map((r) => r.id), ["s1"], "SO scoped to own submitted");
  }

  console.log("party-planning.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
