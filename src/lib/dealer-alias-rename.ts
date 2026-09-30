/**
 * DEALER ALIAS → CANONICAL NAME MIGRATION — pure planner (no I/O).
 *
 * This computes EXACTLY what the one-time migration would change, so the script can preview it (dry-run) and
 * then apply only the rows proven safe. It reuses the app's existing pieces and invents nothing new:
 *   - deterministic alias selection: `pickDisplayAlias` (earliest createdAt, then smallest alias id),
 *   - name-identity comparison: `tightKey` from `@/lib/match-key` (the SAME key the alias matcher/import uses,
 *     so "ABC TRADERS" == "abc traders" == "ABC  TRADERS").
 *
 * It NEVER creates/deletes/merges dealers, never changes ids/foreign keys, and never touches alias rows. The
 * only field it proposes to change is Dealer.name, and only when doing so introduces NO new duplicate name.
 */
import { tightKey } from "@/lib/match-key";
import { pickDisplayAlias, type DealerAliasChoice } from "@/lib/dealer-display-name";

export type RenameStatus = "NO_ALIAS" | "ALREADY_MATCHING" | "SAFE_RENAME" | "COLLISION" | "SKIPPED";

export interface DealerInput {
  id: string;
  name: string;
  aliases: DealerAliasChoice[]; // this dealer's aliases (id, tallyName, createdAt)
}

export interface RenamePlanRow {
  dealerId: string;
  currentName: string;
  selectedAlias: string | null; // the deterministically chosen alias's tally name (null when no usable alias)
  proposedName: string | null; // the name we WOULD set (== selectedAlias) for a rename; null otherwise
  status: RenameStatus;
  /** For COLLISION rows: the other dealers whose (current OR proposed) name shares the same name-key. */
  conflictsWith: { dealerId: string; name: string; via: "CURRENT_NAME" | "SELECTED_ALIAS" }[];
}

export interface RenamePlan {
  rows: RenamePlanRow[];
  totals: {
    totalDealers: number;
    withAlias: number;
    withoutAlias: number;
    safeRenames: number;
    alreadyMatching: number;
    collisions: number;
    skipped: number;
  };
}

interface Candidate {
  dealerId: string;
  currentName: string;
  currentKey: string;
  proposedName: string;
  targetKey: string;
}

/**
 * Plan the migration deterministically. Order of the input does not affect the result.
 *
 * Classification per dealer:
 *   - NO_ALIAS        — no alias rows → left unchanged.
 *   - SKIPPED         — has aliases but none usable (all blank) → cannot propose a name → left unchanged.
 *   - ALREADY_MATCHING— tightKey(current name) === tightKey(selected alias) → already canonical → no write.
 *   - SAFE_RENAME     — rename introduces no duplicate name-key → Dealer.name becomes the selected alias.
 *   - COLLISION       — the selected alias's key would collide with another dealer's final name → left unchanged.
 *
 * Collision guarantee: after applying only SAFE_RENAME rows, NO two dealers share the same tightKey that was
 * not already shared before the migration (the migration never introduces a new duplicate name). This is
 * enforced by a monotonic fixpoint that only ever demotes candidates to COLLISION, never the reverse.
 */
export function planDealerAliasRenames(dealers: readonly DealerInput[]): RenamePlan {
  const rowByDealer = new Map<string, RenamePlanRow>();
  const candidates = new Map<string, Candidate>();

  for (const dealer of dealers) {
    const currentKey = tightKey(dealer.name);
    if (!dealer.aliases || dealer.aliases.length === 0) {
      rowByDealer.set(dealer.id, { dealerId: dealer.id, currentName: dealer.name, selectedAlias: null, proposedName: null, status: "NO_ALIAS", conflictsWith: [] });
      continue;
    }
    const chosen = pickDisplayAlias(dealer.aliases);
    if (!chosen) {
      // Has alias rows but none usable (blank tally name) — cannot derive a canonical name.
      rowByDealer.set(dealer.id, { dealerId: dealer.id, currentName: dealer.name, selectedAlias: null, proposedName: null, status: "SKIPPED", conflictsWith: [] });
      continue;
    }
    const proposedName = chosen.tallyName;
    const targetKey = tightKey(proposedName);
    if (!targetKey) {
      rowByDealer.set(dealer.id, { dealerId: dealer.id, currentName: dealer.name, selectedAlias: proposedName, proposedName: null, status: "SKIPPED", conflictsWith: [] });
      continue;
    }
    if (targetKey === currentKey) {
      // Already canonical (equal under the existing name-identity key, so also covers case/whitespace-only).
      rowByDealer.set(dealer.id, { dealerId: dealer.id, currentName: dealer.name, selectedAlias: proposedName, proposedName: null, status: "ALREADY_MATCHING", conflictsWith: [] });
      continue;
    }
    // Provisional rename candidate — subject to collision resolution below.
    rowByDealer.set(dealer.id, { dealerId: dealer.id, currentName: dealer.name, selectedAlias: proposedName, proposedName, status: "SAFE_RENAME", conflictsWith: [] });
    candidates.set(dealer.id, { dealerId: dealer.id, currentName: dealer.name, currentKey, proposedName, targetKey });
  }

  // Every dealer's "current name" occupies its current key (a dealer being renamed VACATES its current key).
  const currentKeyByDealer = new Map<string, string>();
  for (const dealer of dealers) currentKeyByDealer.set(dealer.id, tightKey(dealer.name));

  // Fixpoint: a candidate is unsafe if its target key is (or becomes) shared with any OTHER dealer's FINAL name
  // key. Final key = a still-active candidate's target key, else the dealer's current key. Demote unsafe
  // candidates to COLLISION and recompute, until stable. Monotonic (candidates only shrink) ⇒ it terminates.
  for (;;) {
    const finalKeyCount = new Map<string, number>();
    const finalKeyByDealer = new Map<string, string>();
    for (const dealer of dealers) {
      const cand = candidates.get(dealer.id);
      const key = cand ? cand.targetKey : currentKeyByDealer.get(dealer.id)!;
      finalKeyByDealer.set(dealer.id, key);
      finalKeyCount.set(key, (finalKeyCount.get(key) ?? 0) + 1);
    }
    const unsafe: string[] = [];
    for (const cand of candidates.values()) {
      if ((finalKeyCount.get(cand.targetKey) ?? 0) > 1) unsafe.push(cand.dealerId);
    }
    if (unsafe.length === 0) break;
    for (const id of unsafe) candidates.delete(id);
  }

  // Anyone still a candidate is a SAFE_RENAME; everyone else who WAS a candidate becomes a COLLISION.
  // Build the final-key map once more (post-fixpoint) to attribute conflicts precisely.
  const finalKeyByDealer = new Map<string, string>();
  const dealersByFinalKey = new Map<string, { dealerId: string; name: string; via: "CURRENT_NAME" | "SELECTED_ALIAS" }[]>();
  for (const dealer of dealers) {
    const cand = candidates.get(dealer.id);
    const key = cand ? cand.targetKey : currentKeyByDealer.get(dealer.id)!;
    finalKeyByDealer.set(dealer.id, key);
    const via: "CURRENT_NAME" | "SELECTED_ALIAS" = cand ? "SELECTED_ALIAS" : "CURRENT_NAME";
    const name = cand ? cand.proposedName : dealer.name;
    const list = dealersByFinalKey.get(key) ?? [];
    list.push({ dealerId: dealer.id, name, via });
    dealersByFinalKey.set(key, list);
  }

  for (const row of rowByDealer.values()) {
    if (row.status !== "SAFE_RENAME") continue;
    if (candidates.has(row.dealerId)) continue; // still safe
    // Demoted by the fixpoint → COLLISION. Attribute to the other dealers sharing its target key.
    row.status = "COLLISION";
    row.proposedName = null;
    const targetKey = tightKey(row.selectedAlias ?? "");
    row.conflictsWith = (dealersByFinalKey.get(targetKey) ?? []).filter((d) => d.dealerId !== row.dealerId);
  }

  const rows = dealers.map((d) => rowByDealer.get(d.id)!);
  const totals = {
    totalDealers: dealers.length,
    withAlias: rows.filter((r) => r.status !== "NO_ALIAS").length,
    withoutAlias: rows.filter((r) => r.status === "NO_ALIAS").length,
    safeRenames: rows.filter((r) => r.status === "SAFE_RENAME").length,
    alreadyMatching: rows.filter((r) => r.status === "ALREADY_MATCHING").length,
    collisions: rows.filter((r) => r.status === "COLLISION").length,
    skipped: rows.filter((r) => r.status === "SKIPPED").length,
  };
  return { rows, totals };
}

/* =====================================================================================
 * BATCHED APPLY — small independent transactions, resume-safe, idempotent audit.
 *
 * The rename decisions come ENTIRELY from `planDealerAliasRenames` above (the source of truth). This section
 * only decides HOW to write the already-decided SAFE_RENAME rows to the database: in small batches, each its
 * own transaction, so no single interactive transaction lives long enough to expire (the P2028 cause).
 * ===================================================================================== */

/** Default dealers-per-transaction. Small + independent so a batch can never outlive the transaction window. */
export const DEALER_ALIAS_BATCH_SIZE = 50;

/**
 * Deterministic per-dealer audit marker for THIS migration. It is intentionally a DEDICATED entity (never the
 * app's own `entity: "dealer"` audits), so the idempotency lookup can find "did I already log this dealer's
 * migration rename?" without ever matching a normal dealer edit. This introduces no new business audit meaning.
 */
export const DEALER_ALIAS_MIGRATION_ENTITY = "dealerAliasNameMigration";

/** Split an array into fixed-size chunks (last chunk may be smaller). size ≤ 0 → one chunk. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return items.length ? [[...items]] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The minimal Prisma-shaped client the batched apply needs — injected so it is unit-testable without a DB. */
export interface MigrationTx {
  dealer: {
    findUnique(args: { where: { id: string }; select: { name: true } }): Promise<{ name: string } | null>;
    updateMany(args: { where: { id: string; name: string }; data: { name: string } }): Promise<{ count: number }>;
  };
  auditLog: {
    findFirst(args: { where: { entity: string; entityId: string }; select: { id: true } }): Promise<{ id: string } | null>;
    create(args: { data: { userId: string; action: string; entity: string; entityId?: string | null; summary?: string | null } }): Promise<unknown>;
  };
}
export interface MigrationDb {
  $transaction<T>(fn: (tx: MigrationTx) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
}

export interface BatchOutcome { index: number; total: number; size: number; committed: boolean }
export interface ApplyResult {
  renamed: number; // dealers whose name was changed in THIS run
  alreadyApplied: number; // safe rows found already at their target name (a previous run/batch did them)
  auditsCreated: number;
  batches: BatchOutcome[];
  failedBatch: number | null; // 1-based index of the batch that failed, or null on full success
  error: string | null;
}

/**
 * Apply the SAFE_RENAME rows in independent, atomic batches. Each batch is one transaction: all its dealer
 * updates + audit rows commit together, or the whole batch rolls back. On the first batch failure the run
 * STOPS (no later batches) and returns failedBatch — earlier committed batches stay committed.
 *
 * Resume-safe: a re-run re-plans first, so already-renamed dealers are ALREADY_MATCHING and never appear here.
 * As a second guard, each row is re-checked inside its transaction against the live name:
 *   - live name already equals the target  → treat as already-applied (no rename), ensure the audit exists.
 *   - live name equals the expected old name → rename + audit (guarded by `where {id, name}`).
 *   - live name is NEITHER old nor target    → UNEXPECTED STATE → throw (rolls back the batch, stops the run).
 * Audit is idempotent via the deterministic per-dealer marker, so re-runs never duplicate audit rows.
 */
export async function applyDealerAliasRenamesInBatches(
  db: MigrationDb,
  safeRows: readonly RenamePlanRow[],
  opts: { actorId: string; batchSize?: number; timeoutMs?: number; maxWaitMs?: number; onBatch?: (o: BatchOutcome) => void },
): Promise<ApplyResult> {
  const batchSize = opts.batchSize ?? DEALER_ALIAS_BATCH_SIZE;
  const timeout = opts.timeoutMs ?? 30_000;
  const maxWait = opts.maxWaitMs ?? 10_000;
  const batches = chunk(safeRows, batchSize);
  const result: ApplyResult = { renamed: 0, alreadyApplied: 0, auditsCreated: 0, batches: [], failedBatch: null, error: null };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const batchResult = await db.$transaction(async (tx) => {
        let renamed = 0, alreadyApplied = 0, auditsCreated = 0;
        for (const row of batch) {
          const targetName = row.proposedName;
          const expectedOld = row.currentName;
          if (!targetName) throw new Error(`Dealer ${row.dealerId}: no proposed name (unexpected for a SAFE_RENAME row).`);
          const live = await tx.dealer.findUnique({ where: { id: row.dealerId }, select: { name: true } });
          if (!live) throw new Error(`Dealer ${row.dealerId} not found while applying rename (unexpected state).`);

          if (tightKey(live.name) === tightKey(targetName)) {
            // Already at the canonical alias (a prior committed batch/run). Idempotent: no rename; ensure audit.
            alreadyApplied += 1;
            if (await ensureRenameAudit(tx, row.dealerId, expectedOld, targetName, opts.actorId)) auditsCreated += 1;
            continue;
          }
          if (live.name !== expectedOld) {
            // Neither the expected old name nor the target — do NOT blindly overwrite.
            throw new Error(`Dealer ${row.dealerId} is in an unexpected state: live name "${live.name}" is neither the expected current name "${expectedOld}" nor the proposed alias "${targetName}". Stopping without changing it.`);
          }
          const upd = await tx.dealer.updateMany({ where: { id: row.dealerId, name: expectedOld }, data: { name: targetName } });
          if (upd.count !== 1) throw new Error(`Dealer ${row.dealerId} guard failed (its name changed concurrently). Stopping.`);
          renamed += 1;
          if (await ensureRenameAudit(tx, row.dealerId, expectedOld, targetName, opts.actorId)) auditsCreated += 1;
        }
        return { renamed, alreadyApplied, auditsCreated };
      }, { timeout, maxWait });

      result.renamed += batchResult.renamed;
      result.alreadyApplied += batchResult.alreadyApplied;
      result.auditsCreated += batchResult.auditsCreated;
      const outcome: BatchOutcome = { index: i + 1, total: batches.length, size: batch.length, committed: true };
      result.batches.push(outcome);
      opts.onBatch?.(outcome);
    } catch (error) {
      const outcome: BatchOutcome = { index: i + 1, total: batches.length, size: batch.length, committed: false };
      result.batches.push(outcome);
      opts.onBatch?.(outcome);
      result.failedBatch = i + 1;
      result.error = error instanceof Error ? error.message : String(error);
      break; // do NOT continue into later batches after a failed batch
    }
  }
  return result;
}

/** Create the per-dealer migration audit row only if it does not already exist (deterministic marker). */
async function ensureRenameAudit(tx: MigrationTx, dealerId: string, oldName: string, newName: string, actorId: string): Promise<boolean> {
  const existing = await tx.auditLog.findFirst({ where: { entity: DEALER_ALIAS_MIGRATION_ENTITY, entityId: dealerId }, select: { id: true } });
  if (existing) return false;
  await tx.auditLog.create({
    data: { userId: actorId, action: "UPDATE", entity: DEALER_ALIAS_MIGRATION_ENTITY, entityId: dealerId, summary: `Dealer renamed to canonical alias: "${oldName}" → "${newName}"` },
  });
  return true;
}
