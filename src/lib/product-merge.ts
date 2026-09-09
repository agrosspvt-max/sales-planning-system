/**
 * Product Merge / Consolidation (Phase 12) — PURE logic (no DB, no `server-only`). Shared by the merge
 * service, the resolver, and read-time aggregation so "source → survivor" is decided the same way everywhere.
 *
 * Model: a merged (source) product carries `mergedIntoId` pointing at the product it was consolidated into.
 * Chains resolve to the TERMINAL survivor (A→B, B→C ⇒ A resolves to C). The graph must stay acyclic. A
 * product with `mergedIntoId = null` is a normal/surviving product and resolves to itself.
 */

/** Follow the merge chain to the terminal survivor. Cycle/over-long chains are capped and return the last
 *  safe id (validation prevents cycles from being created in the first place). */
export function terminalSurvivor(id: string, mergedIntoById: Map<string, string | null>): string {
  let cur = id;
  const seen = new Set<string>([cur]);
  for (let i = 0; i < 1000; i++) {
    const next = mergedIntoById.get(cur) ?? null;
    if (next == null) return cur; // normal/surviving product
    if (seen.has(next)) return cur; // defensive: never loop on a corrupt cycle
    seen.add(next);
    cur = next;
  }
  return cur;
}

/** The operational product id for any (possibly merged) product id. */
export const effectiveProductId = terminalSurvivor;

export interface MergeValidation {
  ok: boolean;
  reason?: string;
  /** The terminal survivor the source would resolve to (present when ok, or when already merged there). */
  terminalSurvivorId?: string;
  /** True when the source is already consolidated into the same terminal survivor (merge is a no-op). */
  alreadyMerged?: boolean;
}

/**
 * Validate a proposed merge (sourceId → survivorId) against the current merge graph. Enforces:
 *  - source ≠ survivor
 *  - no circular merge (survivor must not resolve back to the source)
 *  - idempotency (already merged into the same terminal survivor ⇒ no-op)
 * `existingIds` is every known product id (to reject unknown ids). `mergedIntoById` maps id → its
 * mergedIntoId (null for normal products).
 */
export function validateMerge(params: {
  sourceId: string;
  survivorId: string;
  existingIds: Set<string>;
  mergedIntoById: Map<string, string | null>;
}): MergeValidation {
  const { sourceId, survivorId, existingIds, mergedIntoById } = params;
  if (!sourceId || !survivorId) return { ok: false, reason: "Both products are required." };
  if (sourceId === survivorId) return { ok: false, reason: "A product cannot be merged into itself." };
  if (!existingIds.has(sourceId)) return { ok: false, reason: "Source product not found." };
  if (!existingIds.has(survivorId)) return { ok: false, reason: "Surviving product not found." };

  // Resolve the survivor's OWN terminal survivor — merging into an already-merged product folds into its
  // terminal survivor rather than creating a chain that points at a hidden product.
  const terminal = terminalSurvivor(survivorId, mergedIntoById);
  if (terminal === sourceId) {
    return { ok: false, reason: "This merge would create a circular relationship (the surviving product resolves back to the source)." };
  }

  const sourceMergedInto = mergedIntoById.get(sourceId) ?? null;
  if (sourceMergedInto != null) {
    // Source already merged. If it already resolves to the same terminal survivor → idempotent no-op.
    if (terminalSurvivor(sourceId, mergedIntoById) === terminal) {
      return { ok: true, terminalSurvivorId: terminal, alreadyMerged: true };
    }
    return { ok: false, reason: "The source product is already merged into a different product. Reverse that merge first." };
  }

  return { ok: true, terminalSurvivorId: terminal, alreadyMerged: false };
}

export type CatalogueGroupAction = "deactivateSource" | "createSurvivorFromSource";

/**
 * Per-group catalogue decision when the SOURCE has an entry in a group (survivor-wins rule):
 *  - survivor already has an entry in that group → just deactivate the source entry (survivor untouched).
 *  - survivor has no entry there → create a survivor entry copying the source's commercial values, then
 *    deactivate the source entry (so the group operationally "has" the survivor). Recorded for safe reversal.
 * When the source has no entry in a group, nothing is done there.
 */
export function catalogueGroupAction(survivorHasEntry: boolean): CatalogueGroupAction {
  return survivorHasEntry ? "deactivateSource" : "createSurvivorFromSource";
}

/**
 * Fold a list of per-(effective)product numeric facts to the operational product, summing across merged
 * sources. Deterministic and idempotent: a fact is attributed to exactly ONE terminal survivor, so a merged
 * source is never counted both separately and inside the survivor. Used by read-time aggregation.
 */
export function foldByEffectiveProduct<T>(
  rows: T[],
  productIdOf: (row: T) => string,
  valueOf: (row: T) => number,
  mergedIntoById: Map<string, string | null>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const eff = terminalSurvivor(productIdOf(row), mergedIntoById);
    out.set(eff, (out.get(eff) ?? 0) + valueOf(row));
  }
  return out;
}
