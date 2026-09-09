/**
 * Recovery Plan dealer POPULATION / SCOPE — PURE logic (no DB, no `server-only`). Extracted so the ONE
 * rule "the Sales Officer's assigned dealers decide WHO appears; Aging/Daybook only decide the VALUES"
 * is defined once and unit-tested without a database. `service.server.ts` imports these helpers.
 *
 * Invariant across the whole Recovery flow:
 *   population(plan) = every ACTIVE dealer assigned to the officer (DealerAssignment, effectiveTo=null)
 * Aging fills values for the dealers it contains; every other assigned dealer is a normal ZERO row.
 */

/** Unique-preserving list helper. */
function uniq(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}

/**
 * The assigned dealers that must be inserted as ZERO Recovery rows: assigned to the officer but ABSENT
 * from the Aging report. (Aging dealers are, by construction, a subset of the officer's assigned dealers,
 * since Aging resolves each dealer to its active-assignment officer.)
 */
export function zeroPopulationDealers(agingDealerIds: Iterable<string>, assignedDealerIds: Iterable<string>): string[] {
  const aging = new Set(agingDealerIds);
  return uniq(assignedDealerIds).filter((id) => !aging.has(id));
}

/**
 * The FULL Recovery population for one officer = every assigned dealer, unioned with any Aging dealer
 * (the union is defensive; Aging ⊆ assigned in practice). Deterministic, deduplicated — no duplicate rows.
 */
export function recoveryPopulation(agingDealerIds: Iterable<string>, assignedDealerIds: Iterable<string>): string[] {
  return uniq([...assignedDealerIds, ...agingDealerIds]);
}

export interface DaybookScopeDecision {
  /** Dealers whose Day Book values will be written (existing row updated OR a new zero row created). */
  process: string[];
  /** Subset of `process` that has no Recovery row yet → commit must CREATE the zero row first. */
  needsRowCreate: string[];
  /** Resolved dealers that are NOT assigned to any month officer → genuinely out of scope. */
  skip: string[];
}

/**
 * Decide Day Book processing scope from the AUTHORITATIVE assignment list, NOT from which dealers already
 * have a Recovery row. A resolved dealer is processed when it is assigned to one of the month's officers —
 * even with no prior Aging record, no recovery value and no existing row (that row is created on commit).
 * Only dealers outside every month officer's assignment are skipped.
 */
export function daybookScopeDecision(
  resolvedDealerIds: Iterable<string>,
  existingRowDealerIds: Iterable<string>,
  assignedDealerIds: Iterable<string>,
): DaybookScopeDecision {
  const existing = new Set(existingRowDealerIds);
  const assigned = new Set(assignedDealerIds);
  const process: string[] = [];
  const needsRowCreate: string[] = [];
  const skip: string[] = [];
  for (const id of uniq(resolvedDealerIds)) {
    if (existing.has(id)) {
      process.push(id);
    } else if (assigned.has(id)) {
      process.push(id);
      needsRowCreate.push(id);
    } else {
      skip.push(id);
    }
  }
  return { process, needsRowCreate, skip };
}
