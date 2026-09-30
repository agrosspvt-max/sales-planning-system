/**
 * DEALER DISPLAY NAME — the ONE rule for choosing what a dealer is CALLED on screen.
 *
 * This is a DISPLAY layer only. It never renames Dealer records, never changes Dealer.id, foreign keys,
 * ownership, plans, transactions or history, and it is completely independent of the alias MATCHING/import
 * layer (`dealer-resolver.ts`), which continues to map imported Tally names → Dealer.id exactly as before.
 *
 * Rule:
 *   - Dealer has ≥1 alias  → show the deterministically-selected alias's Tally name.
 *   - Dealer has no alias   → show the dealer's own name.
 *
 * Determinism (so the displayed name never changes between page loads): the DealerAlias model has no
 * "primary" flag, so the selected alias is the EARLIEST-created one, with the alias id as a stable tiebreak.
 */

export interface DealerAliasChoice {
  id: string;
  tallyName: string;
  createdAt: Date | string | number;
}

const toMillis = (value: Date | string | number): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Pick the single alias used as a dealer's display name from that dealer's aliases.
 * Deterministic order: earliest createdAt, then smallest id. Returns null when there are no usable aliases.
 */
export function pickDisplayAlias(aliases: readonly DealerAliasChoice[]): DealerAliasChoice | null {
  let chosen: DealerAliasChoice | null = null;
  for (const alias of aliases) {
    if (!alias || typeof alias.tallyName !== "string" || alias.tallyName.trim() === "") continue;
    if (chosen === null) { chosen = alias; continue; }
    const a = toMillis(alias.createdAt);
    const c = toMillis(chosen.createdAt);
    if (a < c || (a === c && alias.id < chosen.id)) chosen = alias;
  }
  return chosen;
}

/**
 * The display name for one dealer: the selected alias's Tally name when an alias exists, else the dealer's
 * own name. `fallbackName` is the real Dealer.name and is returned unchanged when there is no alias.
 */
export function dealerDisplayName(fallbackName: string, aliases: readonly DealerAliasChoice[] | null | undefined): string {
  const chosen = aliases && aliases.length > 0 ? pickDisplayAlias(aliases) : null;
  return chosen ? chosen.tallyName : fallbackName;
}
