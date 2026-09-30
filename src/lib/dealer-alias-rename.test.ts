/**
 * Dealer Alias → canonical name migration PLANNER (pure). DB-free.
 *   npx tsx src/lib/dealer-alias-rename.test.ts
 *
 * Covers the migration spec: deterministic selection, already-matching, dealer-name and alias-to-alias
 * collisions, case/whitespace normalization, and the "no new duplicate names" guarantee.
 */
import assert from "node:assert/strict";
import {
  planDealerAliasRenames,
  applyDealerAliasRenamesInBatches,
  chunk,
  DEALER_ALIAS_MIGRATION_ENTITY,
  type DealerInput,
  type MigrationDb,
  type RenamePlanRow,
} from "./dealer-alias-rename";
import { tightKey } from "./match-key";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const alias = (id: string, tallyName: string, createdAt: string) => ({ id, tallyName, createdAt });
const dealer = (id: string, name: string, aliases: DealerInput["aliases"] = []): DealerInput => ({ id, name, aliases });
const byId = (plan: ReturnType<typeof planDealerAliasRenames>) => new Map(plan.rows.map((r) => [r.dealerId, r]));

// 1) one alias → renamed to the alias.
test("1) dealer with one alias → SAFE_RENAME to the alias", () => {
  const plan = planDealerAliasRenames([dealer("abc123", "New Nand Beej Bhandar", [alias("a1", "NEW NAND KITNASHAK BHANDAR (TILOKPUR)-UP", "2026-01-01T00:00:00Z")])]);
  const r = byId(plan).get("abc123")!;
  assert.equal(r.status, "SAFE_RENAME");
  assert.equal(r.proposedName, "NEW NAND KITNASHAK BHANDAR (TILOKPUR)-UP");
});

// 2) no alias → unchanged.
test("2) dealer with no alias → NO_ALIAS (unchanged)", () => {
  const r = byId(planDealerAliasRenames([dealer("d1", "ABC Dealer")])).get("d1")!;
  assert.equal(r.status, "NO_ALIAS");
  assert.equal(r.proposedName, null);
});

// 3) multiple aliases → deterministic (earliest createdAt, tiebreak id).
test("3) multiple aliases → deterministic selection (earliest createdAt, then id)", () => {
  const aliases = [
    alias("z", "ABC DEALER BHOPAL", "2026-03-01T00:00:00Z"),
    alias("m", "ABC TRADERS", "2026-01-15T00:00:00Z"),
    alias("a", "ABC TRADERS MP", "2026-02-01T00:00:00Z"),
  ];
  assert.equal(byId(planDealerAliasRenames([dealer("d1", "ABC Dealer", aliases)])).get("d1")!.proposedName, "ABC TRADERS");
  // Order-independent.
  assert.equal(byId(planDealerAliasRenames([dealer("d1", "ABC Dealer", [...aliases].reverse())])).get("d1")!.proposedName, "ABC TRADERS");
});

// 4) already matching (exact) → no change.
test("4) Dealer.name already equals selected alias → ALREADY_MATCHING", () => {
  const r = byId(planDealerAliasRenames([dealer("d1", "ABC TRADERS", [alias("a1", "ABC TRADERS", "2026-01-01T00:00:00Z")])])).get("d1")!;
  assert.equal(r.status, "ALREADY_MATCHING");
  assert.equal(r.proposedName, null);
});

// 5) alias collides with ANOTHER dealer's existing name → skip the rename.
test("5) selected alias equals another dealer's CURRENT name → COLLISION (both left unchanged)", () => {
  const plan = planDealerAliasRenames([
    dealer("A", "ABC Dealer", [alias("a1", "XYZ Dealer", "2026-01-01T00:00:00Z")]),
    dealer("B", "XYZ Dealer"), // no alias; keeps its name
  ]);
  const rows = byId(plan);
  assert.equal(rows.get("A")!.status, "COLLISION");
  assert.equal(rows.get("A")!.proposedName, null);
  assert.deepEqual(rows.get("A")!.conflictsWith.map((c) => c.dealerId), ["B"]);
  assert.equal(rows.get("B")!.status, "NO_ALIAS");
});

// 6) two dealers select the SAME alias → both skipped.
test("6) two dealers select the same alias name → both COLLISION", () => {
  const plan = planDealerAliasRenames([
    dealer("A", "Dealer A", [alias("a1", "ABC", "2026-01-01T00:00:00Z")]),
    dealer("B", "Dealer B", [alias("b1", "ABC", "2026-02-01T00:00:00Z")]),
  ]);
  const rows = byId(plan);
  assert.equal(rows.get("A")!.status, "COLLISION");
  assert.equal(rows.get("B")!.status, "COLLISION");
  assert.equal(plan.totals.collisions, 2);
  assert.equal(plan.totals.safeRenames, 0);
});

// 7) case / whitespace normalization uses the existing tightKey identity.
test("7) case/whitespace-only differences are ALREADY_MATCHING, not renames or collisions", () => {
  const rows = byId(planDealerAliasRenames([
    dealer("d1", "ABC TRADERS", [alias("a1", "abc traders", "2026-01-01T00:00:00Z")]),
    dealer("d2", "XY Store", [alias("a2", "XY  STORE", "2026-01-01T00:00:00Z")]),
  ]));
  assert.equal(rows.get("d1")!.status, "ALREADY_MATCHING");
  assert.equal(rows.get("d2")!.status, "ALREADY_MATCHING");
});

test("case-collision across dealers is caught (alias 'ABC' vs another name 'abc')", () => {
  const rows = byId(planDealerAliasRenames([
    dealer("A", "Alpha", [alias("a1", "ABC", "2026-01-01T00:00:00Z")]),
    dealer("B", "abc"),
  ]));
  assert.equal(rows.get("A")!.status, "COLLISION", "ABC and abc share a tightKey");
});

// GUARANTEE: applying only SAFE_RENAME rows never introduces a duplicate name-key.
test("no new duplicate name-keys are introduced by the safe renames", () => {
  const dealers = [
    dealer("A", "Alpha One", [alias("a1", "SHARED NAME", "2026-01-01T00:00:00Z")]),
    dealer("B", "Beta Two", [alias("b1", "SHARED NAME", "2026-02-01T00:00:00Z")]), // collides with A's alias
    dealer("C", "Gamma", [alias("c1", "GAMMA CANONICAL", "2026-01-01T00:00:00Z")]), // safe
    dealer("D", "Delta"), // no alias
    dealer("E", "GAMMA CANONICAL"), // existing name equals C's alias → C must be a collision
  ];
  const plan = planDealerAliasRenames(dealers);
  const rows = byId(plan);
  assert.equal(rows.get("C")!.status, "COLLISION", "C's alias equals E's existing name");
  // Simulate applying only SAFE_RENAME rows and assert no duplicate final keys arise from OUR changes.
  const finalName = new Map(dealers.map((d) => [d.id, d.name]));
  for (const r of plan.rows) if (r.status === "SAFE_RENAME") finalName.set(r.dealerId, r.proposedName!);
  const keys = [...finalName.values()].map(tightKey);
  const seen = new Map<string, number>();
  for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  // Only pre-existing duplicates may remain; none of the renamed dealers may share a key with anyone else.
  for (const r of plan.rows) {
    if (r.status !== "SAFE_RENAME") continue;
    assert.equal(seen.get(tightKey(r.proposedName!)), 1, `renamed ${r.dealerId} must be unique`);
  }
});

test("a genuinely safe rename among collisions still proceeds", () => {
  const plan = planDealerAliasRenames([
    dealer("A", "Alpha", [alias("a1", "DUP", "2026-01-01T00:00:00Z")]),
    dealer("B", "Beta", [alias("b1", "DUP", "2026-01-02T00:00:00Z")]),
    dealer("C", "Gamma", [alias("c1", "UNIQUE CANON", "2026-01-01T00:00:00Z")]),
  ]);
  const rows = byId(plan);
  assert.equal(rows.get("A")!.status, "COLLISION");
  assert.equal(rows.get("B")!.status, "COLLISION");
  assert.equal(rows.get("C")!.status, "SAFE_RENAME");
});

// SKIPPED — has an alias row but it is blank/unusable.
test("blank/unusable alias → SKIPPED (never renamed to empty)", () => {
  const r = byId(planDealerAliasRenames([dealer("d1", "Real Name", [alias("a1", "   ", "2026-01-01T00:00:00Z")])])).get("d1")!;
  assert.equal(r.status, "SKIPPED");
  assert.equal(r.proposedName, null);
});

// Totals add up and are real (no fake numbers).
test("totals partition every dealer exactly once", () => {
  const plan = planDealerAliasRenames([
    dealer("A", "Alpha", [alias("a1", "ALPHA CANON", "2026-01-01T00:00:00Z")]),
    dealer("B", "Beta"),
    dealer("C", "Gamma", [alias("c1", "Gamma", "2026-01-01T00:00:00Z")]),
    dealer("D", "Delta", [alias("d1", "DUP2", "2026-01-01T00:00:00Z")]),
    dealer("E", "Epsilon", [alias("e1", "DUP2", "2026-01-01T00:00:00Z")]),
  ]);
  const t = plan.totals;
  assert.equal(t.totalDealers, 5);
  assert.equal(t.withAlias + t.withoutAlias, t.totalDealers);
  assert.equal(t.safeRenames + t.alreadyMatching + t.collisions + t.skipped, t.withAlias);
  assert.equal(t.safeRenames, 1); // A
  assert.equal(t.alreadyMatching, 1); // C
  assert.equal(t.collisions, 2); // D + E
  assert.equal(t.withoutAlias, 1); // B
});

/* ============================ BATCHED APPLY (reliability fix) ============================ */

// In-memory Prisma-shaped fake with real transaction ROLLBACK semantics, plus an immutable alias list and a
// foreign-key table (planDealer → dealerId) so we can assert ids / aliases / FKs never change.
interface AliasRow { id: string; systemDealerId: string; tallyName: string; createdAt: string }
function makeFakeDb(seedDealers: { id: string; name: string }[], seedAliases: AliasRow[], fkDealerIds: string[]) {
  const dealers = new Map(seedDealers.map((d) => [d.id, { name: d.name }]));
  const aliases = seedAliases.map((a) => ({ ...a })); // never mutated by the migration
  const fks = [...fkDealerIds]; // planDealer.dealerId references — must stay pointing at the same ids
  const audits: { userId: string; action: string; entity: string; entityId?: string | null; summary?: string | null }[] = [];
  let failOnDealerUpdateId: string | null = null;

  const tx: () => import("./dealer-alias-rename").MigrationTx = () => ({
    dealer: {
      findUnique: async ({ where }) => (dealers.has(where.id) ? { name: dealers.get(where.id)!.name } : null),
      updateMany: async ({ where, data }) => {
        const d = dealers.get(where.id);
        if (d && d.name === where.name) {
          if (where.id === failOnDealerUpdateId) throw new Error(`simulated DB failure updating ${where.id}`);
          d.name = data.name;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    auditLog: {
      findFirst: async ({ where }) => (audits.some((a) => a.entity === where.entity && a.entityId === where.entityId) ? { id: "x" } : null),
      create: async ({ data }) => { audits.push({ ...data }); return {}; },
    },
  });

  const db: MigrationDb = {
    $transaction: async (fn) => {
      const snapDealers = new Map([...dealers].map(([k, v]) => [k, { ...v }] as const));
      const snapAudits = audits.map((a) => ({ ...a }));
      try {
        return await fn(tx());
      } catch (error) {
        dealers.clear();
        for (const [k, v] of snapDealers) dealers.set(k, v);
        audits.length = 0;
        audits.push(...snapAudits);
        throw error;
      }
    },
  };
  return { db, dealers, aliases, fks, audits, setFailOnUpdate: (id: string | null) => { failOnDealerUpdateId = id; } };
}

const dealerInputsFrom = (dealers: Map<string, { name: string }>, aliases: AliasRow[]): DealerInput[] =>
  [...dealers].map(([id, d]) => ({ id, name: d.name, aliases: aliases.filter((a) => a.systemDealerId === id).map((a) => ({ id: a.id, tallyName: a.tallyName, createdAt: a.createdAt })) }));
const safeRowsFor = (dealers: Map<string, { name: string }>, aliases: AliasRow[]): RenamePlanRow[] =>
  planDealerAliasRenames(dealerInputsFrom(dealers, aliases)).rows.filter((r) => r.status === "SAFE_RENAME");

async function asyncTest(name: string, fn: () => Promise<void>) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

// 6) Batch processing divides candidates correctly.
test("chunk() splits into fixed-size batches (last may be smaller)", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(chunk(Array.from({ length: 281 }, (_, i) => i), 50).length, 6); // 50*5 + 31
  assert.deepEqual(chunk([], 50), []);
});

async function batchedAppliesMain() {
  const A = (id: string, tally: string, createdAt = "2026-01-01T00:00:00Z"): AliasRow => ({ id: `al-${id}`, systemDealerId: id, tallyName: tally, createdAt });

  // 7) A successful batch commits Dealer.name changes AND AuditLog entries.
  await asyncTest("7) successful batches rename dealers and write one audit each", async () => {
    const seed = [{ id: "d1", name: "Old One" }, { id: "d2", name: "Old Two" }, { id: "d3", name: "Old Three" }];
    const aliases = [A("d1", "ALIAS ONE"), A("d2", "ALIAS TWO"), A("d3", "ALIAS THREE")];
    const fake = makeFakeDb(seed, aliases, ["d1", "d2", "d3"]);
    const res = await applyDealerAliasRenamesInBatches(fake.db, safeRowsFor(fake.dealers, aliases), { actorId: "admin", batchSize: 2 });
    assert.equal(res.renamed, 3);
    assert.equal(res.failedBatch, null);
    assert.equal(res.batches.length, 2, "3 rows / batch 2 → 2 batches");
    assert.equal(fake.dealers.get("d1")!.name, "ALIAS ONE");
    assert.equal(fake.dealers.get("d3")!.name, "ALIAS THREE");
    assert.equal(fake.audits.filter((a) => a.entity === DEALER_ALIAS_MIGRATION_ENTITY).length, 3);
    // 12/13/14) ids, aliases and FKs unchanged.
    assert.deepEqual([...fake.dealers.keys()].sort(), ["d1", "d2", "d3"]);
    assert.deepEqual(fake.aliases.map((a) => a.tallyName).sort(), ["ALIAS ONE", "ALIAS THREE", "ALIAS TWO"]);
    assert.deepEqual(fake.fks.sort(), ["d1", "d2", "d3"]);
  });

  // 8/9) A failed batch rolls back ENTIRELY; earlier committed batches remain; run stops (no later batches).
  await asyncTest("8/9) failed batch rolls back fully; earlier batches stay; run stops", async () => {
    const seed = [
      { id: "d1", name: "Old 1" }, { id: "d2", name: "Old 2" }, // batch 1
      { id: "d3", name: "Old 3" }, { id: "d4", name: "Old 4" }, // batch 2 (d4 fails)
      { id: "d5", name: "Old 5" }, // batch 3 (never reached)
    ];
    const aliases = seed.map((d) => A(d.id, `CANON ${d.id.toUpperCase()}`));
    const fake = makeFakeDb(seed, aliases, seed.map((d) => d.id));
    fake.setFailOnUpdate("d4");
    const res = await applyDealerAliasRenamesInBatches(fake.db, safeRowsFor(fake.dealers, aliases), { actorId: "admin", batchSize: 2 });
    assert.equal(res.failedBatch, 2);
    assert.ok(res.error && res.error.includes("d4"));
    // batch 1 committed:
    assert.equal(fake.dealers.get("d1")!.name, "CANON D1");
    assert.equal(fake.dealers.get("d2")!.name, "CANON D2");
    // batch 2 fully rolled back (d3 was updated before d4 failed, but the whole batch reverted):
    assert.equal(fake.dealers.get("d3")!.name, "Old 3");
    assert.equal(fake.dealers.get("d4")!.name, "Old 4");
    // batch 3 never processed:
    assert.equal(fake.dealers.get("d5")!.name, "Old 5");
    assert.equal(res.renamed, 2, "only the two batch-1 dealers");
    assert.equal(fake.audits.filter((a) => a.entity === DEALER_ALIAS_MIGRATION_ENTITY).length, 2);

    // 10/11) Re-run --apply after the partial failure: fixed the cause; must not re-rename batch 1 or duplicate
    // audits, and must complete the rest. The planner is the resume state.
    fake.setFailOnUpdate(null);
    const res2 = await applyDealerAliasRenamesInBatches(fake.db, safeRowsFor(fake.dealers, aliases), { actorId: "admin", batchSize: 2 });
    assert.equal(res2.failedBatch, null);
    assert.equal(res2.renamed, 3, "d3, d4, d5 now renamed");
    for (const d of seed) assert.equal(fake.dealers.get(d.id)!.name, `CANON ${d.id.toUpperCase()}`);
    // Exactly ONE migration audit per dealer — no duplicates for the already-renamed batch-1 dealers.
    const perDealer = new Map<string, number>();
    for (const a of fake.audits.filter((x) => x.entity === DEALER_ALIAS_MIGRATION_ENTITY)) perDealer.set(a.entityId!, (perDealer.get(a.entityId!) ?? 0) + 1);
    assert.deepEqual([...perDealer.values()], [1, 1, 1, 1, 1]);
  });

  // 10/11 (direct) Re-running a full apply is a no-op with no duplicate audits.
  await asyncTest("10/11) re-running after full success renames nothing and adds no audits", async () => {
    const seed = [{ id: "d1", name: "Old One" }, { id: "d2", name: "Old Two" }];
    const aliases = [A("d1", "ALIAS ONE"), A("d2", "ALIAS TWO")];
    const fake = makeFakeDb(seed, aliases, ["d1", "d2"]);
    await applyDealerAliasRenamesInBatches(fake.db, safeRowsFor(fake.dealers, aliases), { actorId: "admin", batchSize: 50 });
    const auditsAfterFirst = fake.audits.length;
    // Second run: planner now sees both as ALREADY_MATCHING → no safe rows → nothing happens.
    const safeAgain = safeRowsFor(fake.dealers, aliases);
    assert.equal(safeAgain.length, 0, "already-renamed dealers are ALREADY_MATCHING on re-plan");
    const res2 = await applyDealerAliasRenamesInBatches(fake.db, safeAgain, { actorId: "admin", batchSize: 50 });
    assert.equal(res2.renamed, 0);
    assert.equal(fake.audits.length, auditsAfterFirst, "no duplicate audit rows");
  });

  // 15) A dealer in an unexpected state (live name is neither the expected old NOR the target) is NOT overwritten.
  await asyncTest("15) unexpected live state stops the batch instead of blindly overwriting", async () => {
    const seed = [{ id: "d1", name: "Old One" }];
    const aliases = [A("d1", "ALIAS ONE")];
    const fake = makeFakeDb(seed, aliases, ["d1"]);
    const safe = safeRowsFor(fake.dealers, aliases); // expects currentName "Old One"
    // Someone changed the dealer to an unrelated third value after planning.
    fake.dealers.get("d1")!.name = "SOMETHING ELSE ENTIRELY";
    const res = await applyDealerAliasRenamesInBatches(fake.db, safe, { actorId: "admin", batchSize: 50 });
    assert.equal(res.failedBatch, 1);
    assert.ok(res.error && res.error.includes("unexpected state"));
    assert.equal(fake.dealers.get("d1")!.name, "SOMETHING ELSE ENTIRELY", "left exactly as found, not overwritten");
    assert.equal(fake.audits.length, 0);
  });

  // Idempotent "already at target": a safe row whose live name already equals the target only backfills audit.
  await asyncTest("already-at-target safe row backfills a missing audit without renaming", async () => {
    const seed = [{ id: "d1", name: "ALIAS ONE" }]; // already at target
    const aliases = [A("d1", "ALIAS ONE")];
    const fake = makeFakeDb(seed, aliases, ["d1"]);
    // Force a SAFE_RENAME row even though it's already at target (simulates a concurrent apply completing it).
    const forced: RenamePlanRow[] = [{ dealerId: "d1", currentName: "Old One", selectedAlias: "ALIAS ONE", proposedName: "ALIAS ONE", status: "SAFE_RENAME", conflictsWith: [] }];
    const res = await applyDealerAliasRenamesInBatches(fake.db, forced, { actorId: "admin", batchSize: 50 });
    assert.equal(res.renamed, 0);
    assert.equal(res.alreadyApplied, 1);
    assert.equal(res.auditsCreated, 1, "missing audit backfilled once");
    assert.equal(fake.dealers.get("d1")!.name, "ALIAS ONE", "no rename");
    // Running again creates no further audit (idempotent).
    const res2 = await applyDealerAliasRenamesInBatches(fake.db, forced, { actorId: "admin", batchSize: 50 });
    assert.equal(res2.auditsCreated, 0);
  });
}

batchedAppliesMain()
  .then(() => { console.log(`\n${passed} dealer-alias-rename tests passed`); })
  .catch((error) => { console.error(error); process.exit(1); });
