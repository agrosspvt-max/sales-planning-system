/**
 * ONE-TIME DATA MIGRATION — rename Dealer.name to its canonical Dealer Alias, where safe.
 *
 * GOAL
 *   For every Dealer that HAS at least one Dealer Alias, set Dealer.name to the deterministically-selected
 *   alias. Dealers with no alias are left exactly as they are. The Dealer id, all foreign keys, all plans /
 *   transactions / history, and every DealerAlias row remain UNCHANGED. This is NOT a merge: two dealers stay
 *   two dealers. Only the Dealer.name string may change.
 *
 * SAFETY
 *   - Deterministic alias selection (earliest createdAt, then smallest alias id) — never random.
 *   - Collision-proof: a rename is applied ONLY when it introduces no new duplicate Dealer name. Name identity
 *     uses the app's EXISTING key (`tightKey`), so "ABC TRADERS" == "abc traders" == "ABC  TRADERS".
 *   - Dealer-name collisions (alias equals another dealer's current name) AND alias-to-alias collisions (two
 *     dealers select the same alias) are detected and LEFT UNCHANGED, then reported.
 *   - Reuses the SAME pure planner covered by unit tests (src/lib/dealer-alias-rename.ts).
 *   - It does NOT touch any parser, the Dealer Alias matching/import, business calculations, or the schema.
 *
 * USAGE (dry-run by default — makes NO database changes)
 *   npm run migrate:dealer-alias-names                 # DRY RUN — preview + totals only
 *   npm run migrate:dealer-alias-names -- --dry-run    # same as above (explicit)
 *   npm run migrate:dealer-alias-names -- --apply      # perform the rename (small batched transactions + audit)
 *   npm run migrate:dealer-alias-names -- --apply --actor <superAdminUserId>   # attribute the audit rows
 *   npm run migrate:dealer-alias-names -- --verbose    # also list ALREADY_MATCHING / NO_ALIAS rows
 *   npm run migrate:dealer-alias-names -- --diagnose   # read-only Prisma connectivity/transaction checks (no writes)
 *
 * CONNECTION: interactive transactions REQUIRE a direct (session) connection. The app runtime uses the pooled
 * DATABASE_URL, but over a transaction-mode pooler (PgBouncer / Neon pooled endpoint) the second query of an
 * interactive transaction can land on a different backend → "Transaction not found" (P2028). Prisma's
 * `directUrl` is used only by the CLI, so this script connects via DIRECT_URL (fallback DATABASE_URL). Set
 * DIRECT_URL to the unpooled endpoint before --apply. Run `--diagnose` to confirm before applying.
 *
 * RELIABILITY: --apply writes in SMALL INDEPENDENT BATCHES (one short transaction each), not one giant
 * interactive transaction. A failed batch rolls itself back and stops the run; already-committed batches stay
 * committed and a re-run resumes safely (the planner treats already-renamed dealers as ALREADY_MATCHING, and
 * the audit is idempotent per dealer).
 *
 * BACKUP: take a database backup before running with --apply. The script is still collision-safe and
 * transactional per batch, but a backup is the last line of defence and is strongly recommended.
 */
import { PrismaClient } from "@prisma/client";
import {
  planDealerAliasRenames,
  applyDealerAliasRenamesInBatches,
  chunk,
  DEALER_ALIAS_BATCH_SIZE,
  type DealerInput,
  type MigrationDb,
} from "@/lib/dealer-alias-rename";

// CONNECTION — interactive transactions MUST use a DIRECT (session) connection, not a transaction-mode pooler.
// The app runtime uses the pooled DATABASE_URL, but over PgBouncer/Neon-pooled endpoints each query in an
// interactive `$transaction` can land on a DIFFERENT backend connection, so the second query reports
// "Transaction not found" (P2028). Prisma's own `directUrl` is used only by the CLI, not the runtime client —
// so this one-off admin script explicitly connects via DIRECT_URL (falling back to DATABASE_URL if unset).
// This changes neither .env, the schema, nor the application's own pooled connection.
const MIGRATION_DB_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
const USING_DIRECT_URL = !!process.env.DIRECT_URL;
const prisma = new PrismaClient(MIGRATION_DB_URL ? { datasources: { db: { url: MIGRATION_DB_URL } } } : undefined);

const APPLY = process.argv.includes("--apply");
const DIAGNOSE = process.argv.includes("--diagnose");
const VERBOSE = process.argv.includes("--verbose");
const actorArg = (() => { const i = process.argv.indexOf("--actor"); return i >= 0 ? process.argv[i + 1] : undefined; })();

/**
 * Read-only connectivity diagnostics using the SAME client the migration uses. Proves whether plain queries,
 * interactive transactions, and per-model queries inside a transaction work over the chosen connection. Makes
 * NO data changes (SELECT 1 + findFirst reads only). Run with `--diagnose`.
 */
async function runDiagnostics(): Promise<void> {
  console.log(`\n================ PRISMA DIAGNOSTICS (read-only) ================`);
  console.log(`Connection: ${USING_DIRECT_URL ? "DIRECT_URL (direct/session)" : "DATABASE_URL (pooled — DIRECT_URL not set)"}`);
  const check = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { console.log(`  ✗ ${label} — ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); throw e; }
  };
  // A) plain query, B) interactive tx single query, C) tx auditLog read, D) tx dealer read (all read-only).
  await check("A. SELECT 1", () => prisma.$queryRaw`SELECT 1`);
  await check("B. interactive transaction — SELECT 1", () => prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT 1`; }));
  await check("C. transaction — auditLog.findFirst()", () => prisma.$transaction(async (tx) => { await tx.auditLog.findFirst({ select: { id: true } }); }));
  await check("D. transaction — dealer.findFirst()", () => prisma.$transaction(async (tx) => { await tx.dealer.findFirst({ select: { id: true } }); }));
  // Multi-query interactive transaction — this is the pattern the migration uses and the one that failed with
  // the pooled URL. If this passes, the P2028 cause (pooler + interactive transaction) is resolved.
  await check("E. transaction — TWO sequential reads (the failing pattern)", () => prisma.$transaction(async (tx) => {
    await tx.dealer.findFirst({ select: { id: true } });
    await tx.auditLog.findFirst({ select: { id: true } });
  }));
  console.log(`All diagnostics passed.\n`);
}

/** Load EVERY dealer (any status) with its aliases — all dealers participate in collision detection. */
async function loadDealerInputs(client: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]): Promise<DealerInput[]> {
  const [dealers, aliases] = await Promise.all([
    client.dealer.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    client.dealerAlias.findMany({ select: { id: true, systemDealerId: true, tallyName: true, createdAt: true } }),
  ]);
  const byDealer = new Map<string, DealerInput["aliases"]>();
  for (const a of aliases) {
    const list = byDealer.get(a.systemDealerId) ?? [];
    list.push({ id: a.id, tallyName: a.tallyName, createdAt: a.createdAt });
    byDealer.set(a.systemDealerId, list);
  }
  return dealers.map((d) => ({ id: d.id, name: d.name, aliases: byDealer.get(d.id) ?? [] }));
}

function printReport(plan: ReturnType<typeof planDealerAliasRenames>): void {
  const t = plan.totals;
  const safe = plan.rows.filter((r) => r.status === "SAFE_RENAME");
  const collisions = plan.rows.filter((r) => r.status === "COLLISION");
  const skipped = plan.rows.filter((r) => r.status === "SKIPPED");

  console.log("\n================ DEALER ALIAS → NAME MIGRATION ================");
  console.log(APPLY ? "MODE: APPLY (writing changes)" : "MODE: DRY RUN (no database changes)");
  console.log("--------------------------------------------------------------");
  console.log(`Total Dealers:    ${t.totalDealers}`);
  console.log(`With Alias:       ${t.withAlias}`);
  console.log(`Without Alias:    ${t.withoutAlias}`);
  console.log(`Safe Renames:     ${t.safeRenames}`);
  console.log(`Already Matching: ${t.alreadyMatching}`);
  console.log(`Collisions:       ${t.collisions}`);
  console.log(`Skipped:          ${t.skipped}`);
  console.log("--------------------------------------------------------------");

  if (safe.length > 0) {
    console.log(`\nSAFE RENAMES (${safe.length}) — Dealer.name will become the alias:`);
    for (const r of safe) console.log(`  [${r.dealerId}] "${r.currentName}"  →  "${r.proposedName}"`);
  }
  if (collisions.length > 0) {
    console.log(`\nCOLLISIONS (${collisions.length}) — LEFT UNCHANGED (resolve manually):`);
    for (const r of collisions) {
      const conflicts = r.conflictsWith.map((c) => `${c.dealerId} (${c.via === "CURRENT_NAME" ? "current name" : "selected alias"}: "${c.name}")`).join(", ");
      console.log(`  [${r.dealerId}] current "${r.currentName}"  ✗ proposed "${r.selectedAlias}"  — conflicts with: ${conflicts || "another dealer"}`);
    }
  }
  if (skipped.length > 0) {
    console.log(`\nSKIPPED (${skipped.length}) — has alias rows but none usable (blank tally name); LEFT UNCHANGED:`);
    for (const r of skipped) console.log(`  [${r.dealerId}] "${r.currentName}"`);
  }
  if (VERBOSE) {
    const matching = plan.rows.filter((r) => r.status === "ALREADY_MATCHING");
    const noAlias = plan.rows.filter((r) => r.status === "NO_ALIAS");
    if (matching.length > 0) {
      console.log(`\nALREADY MATCHING (${matching.length}) — no change needed:`);
      for (const r of matching) console.log(`  [${r.dealerId}] "${r.currentName}"`);
    }
    if (noAlias.length > 0) {
      console.log(`\nNO ALIAS (${noAlias.length}) — unchanged:`);
      for (const r of noAlias) console.log(`  [${r.dealerId}] "${r.currentName}"`);
    }
  }
}

async function main(): Promise<void> {
  if (DIAGNOSE) { await runDiagnostics(); return; }

  // Preview against the current data first (this is what a dry run reports).
  const previewPlan = planDealerAliasRenames(await loadDealerInputs(prisma));
  printReport(previewPlan);

  if (!APPLY) {
    console.log("\nDry run complete. No changes were made. Re-run with --apply to perform the migration.\n");
    return;
  }

  // Resolve an actor for the audit rows (AuditLog.userId is required). Prefer --actor; else any active Super Admin.
  let actorId = actorArg ?? null;
  if (!actorId) {
    const admin = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true, deletedAt: null }, select: { id: true } });
    actorId = admin?.id ?? null;
  }
  if (!actorId) {
    console.error("\nABORTED: no audit actor available. Pass --actor <superAdminUserId>. No changes were made.\n");
    process.exitCode = 1;
    return;
  }

  // Re-plan against fresh data (authoritative — guards against any drift since the preview). Already-renamed
  // dealers become ALREADY_MATCHING here, so a re-run naturally skips them: the planner IS the resume state.
  const plan = planDealerAliasRenames(await loadDealerInputs(prisma));
  const safe = plan.rows.filter((r) => r.status === "SAFE_RENAME");
  const totalBatches = chunk(safe, DEALER_ALIAS_BATCH_SIZE).length;

  console.log(`\n================ APPLY MODE ================`);
  console.log(`Connection: ${USING_DIRECT_URL ? "DIRECT_URL (direct/session — required for interactive transactions)" : "DATABASE_URL (pooled — DIRECT_URL not set; interactive transactions may fail with P2028)"}`);
  console.log(`Batch size: ${DEALER_ALIAS_BATCH_SIZE}`);
  console.log(`Safe renames to apply: ${safe.length}  (in ${totalBatches} batch${totalBatches === 1 ? "" : "es"})\n`);

  // Apply in small, independent, atomic batches. Each batch is its own short transaction (no giant interactive
  // transaction that can expire — that was the P2028 cause). A failed batch rolls itself back and stops the run.
  const result = await applyDealerAliasRenamesInBatches(prisma as unknown as MigrationDb, safe, {
    actorId,
    batchSize: DEALER_ALIAS_BATCH_SIZE,
    onBatch: (o) => {
      if (o.committed) console.log(`Batch ${o.index}/${o.total}: ${o.size} rename(s)\n  ✓ committed`);
      else {
        console.error(`Batch ${o.index}/${o.total}: ${o.size} rename(s)\n  ✗ FAILED — the entire batch was rolled back.`);
        console.error(`  Batches 1–${o.index - 1} remain committed. No partial changes from batch ${o.index} were committed.`);
      }
    },
  });

  console.log(`\n================ SUMMARY ================`);
  console.log(`Renamed:          ${result.renamed}`);
  console.log(`Already matching: ${plan.totals.alreadyMatching}`);
  console.log(`Already applied:  ${result.alreadyApplied}  (safe rows found already at target on this run)`);
  console.log(`Skipped:          ${plan.totals.skipped}`);
  console.log(`Collisions:       ${plan.totals.collisions}`);
  console.log(`Audit rows added: ${result.auditsCreated}`);
  console.log(`Failed:           ${result.failedBatch === null ? 0 : 1}`);

  if (result.failedBatch !== null) {
    console.error(`\nMigration STOPPED at batch ${result.failedBatch}: ${result.error}`);
    console.error(`Earlier batches remain committed. Fix the cause and re-run --apply; it will resume safely.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nMigration completed successfully. Collisions/skipped rows were left unchanged (see report above).\n`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
