import "server-only";
import { prisma } from "@/lib/prisma";
import { decorate, tightKey, looseKey, similarity, type Keyed } from "@/lib/match-key";

/**
 * The ONE dealer resolver for every importer (Sales Upload, Recovery, …). Resolution order is
 * fixed and shared, so all modules behave identically:
 *
 *   1. Dealer Alias  (Tally name → System dealer, via DealerAlias.tallyKey)
 *   2. Exact         (tightKey)          ┐
 *   3. Loose         (looseKey)          ├─ the shared `matchByName`
 *   4. Fuzzy         (similarity ≥ 0.9)  ┘
 *
 * When an alias exists it wins outright (no fuzzy fallback) — the Tally name maps straight to
 * the system dealer. There is no separate alias table or alias logic anywhere else.
 */
export type DealerMatch = { id: string; name: string } & Keyed;

/** How a raw name resolved to a master dealer — surfaced in previews (same rules, no new matcher). */
export type MatchType = "ALIAS" | "EXACT" | "LOOSE" | "FUZZY";
export interface DealerMatchResult {
  dealer: DealerMatch;
  matchType: MatchType;
  score: number; // 1 for alias/exact, 0.95 for loose, the similarity (≥0.9) for fuzzy
}

/**
 * Three-outcome classification of a raw workbook dealer name, for importers that can ONBOARD new
 * dealers (Seasonal Import / Replace) instead of skipping them:
 *   - EXISTING: matched an active master dealer (alias → exact → loose → fuzzy).
 *   - NEW:      a valid, unmatched name — can be created and assigned.
 *   - INVALID:  a genuinely unusable name (empty/blank) — a real error, never created.
 */
export type DealerResolution =
  | { outcome: "EXISTING"; dealer: DealerMatch }
  | { outcome: "NEW"; rawName: string }
  | { outcome: "INVALID"; rawName: string; reason: string };

export interface DealerResolver {
  dealers: DealerMatch[];
  /** Alias → exact → loose → fuzzy. Returns the master dealer or null. */
  resolve(rawName: string): DealerMatch | null;
  /** Same rules as resolve(), but also reports HOW it matched (ALIAS/EXACT/LOOSE/FUZZY + score). */
  resolveWithReason(rawName: string): DealerMatchResult | null;
  /** Same matching, classified into EXISTING / NEW / INVALID. Reusable by any importer. */
  classify(rawName: string): DealerResolution;
}

export async function loadDealerResolver(): Promise<DealerResolver> {
  const [dealerRows, aliasRows] = await Promise.all([
    // Only ACTIVE dealers participate in matching. Pending (created in Monthly Planning, not yet
    // approved) and Rejected dealers are excluded from every importer/resolver.
    prisma.dealer.findMany({ where: { status: "ACTIVE", isActive: true }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { tallyKey: true, systemDealerId: true } }),
  ]);
  const dealers = decorate(dealerRows as { id: string; name: string }[]);
  const byId = new Map(dealers.map((d) => [d.id, d]));
  const aliasByKey = new Map<string, string>(
    (aliasRows as { tallyKey: string; systemDealerId: string }[]).map((a) => [a.tallyKey, a.systemDealerId]),
  );

  // ONE matching implementation with reasons; resolve() is just the dealer-only projection of it.
  function resolveWithReason(rawName: string): DealerMatchResult | null {
    const t = tightKey(rawName);
    const aliasId = aliasByKey.get(t);
    if (aliasId) {
      const d = byId.get(aliasId);
      if (d) return { dealer: d, matchType: "ALIAS", score: 1 }; // alias wins outright
    }
    if (t) {
      const exact = dealers.find((x) => x.tight === t);
      if (exact) return { dealer: exact, matchType: "EXACT", score: 1 };
    }
    const l = looseKey(rawName);
    if (l) {
      const loose = dealers.find((x) => x.loose === l);
      if (loose) return { dealer: loose, matchType: "LOOSE", score: 0.95 };
    }
    let best: DealerMatchResult | null = null;
    for (const x of dealers) {
      const s = similarity(rawName, x.name);
      if (s >= 0.9 && (!best || s > best.score)) best = { dealer: x, matchType: "FUZZY", score: s };
    }
    return best;
  }
  function resolve(rawName: string): DealerMatch | null {
    return resolveWithReason(rawName)?.dealer ?? null;
  }

  return {
    dealers,
    resolve,
    resolveWithReason,
    classify(rawName: string): DealerResolution {
      const name = rawName.trim();
      if (!name || !tightKey(name)) return { outcome: "INVALID", rawName, reason: "Empty or unusable dealer name" };
      const dealer = resolve(name); // alias → exact → loose → fuzzy
      return dealer ? { outcome: "EXISTING", dealer } : { outcome: "NEW", rawName: name };
    },
  };
}

export interface ProbableDealer {
  id: string;
  name: string;
  reason: "alias" | "exact" | "loose" | "fuzzy";
  score: number;
}

/**
 * Probable existing dealers for a proposed name — powers the "Possible Existing Dealer" dialog
 * shown before creating a dealer from Admin or Monthly Planning. Reuses the SAME rules as the
 * resolver (Alias → exact tightKey → loose → fuzzy) over ACTIVE dealers only, but returns a
 * short RANKED LIST (not a single winner) so the user can decide instead of blindly duplicating.
 */
export async function findProbableDealers(name: string, limit = 5): Promise<ProbableDealer[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const [dealerRows, aliasRows] = await Promise.all([
    prisma.dealer.findMany({ where: { status: "ACTIVE", isActive: true }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { tallyKey: true, systemDealerId: true, tallyName: true } }),
  ]);
  const dealers = decorate(dealerRows as { id: string; name: string }[]);
  const byId = new Map(dealers.map((d) => [d.id, d]));
  const t = tightKey(trimmed);
  const l = looseKey(trimmed);

  const out = new Map<string, ProbableDealer>();
  const add = (id: string, name: string, reason: ProbableDealer["reason"], score: number) => {
    const prev = out.get(id);
    if (!prev || score > prev.score) out.set(id, { id, name, reason, score });
  };

  // 1. Alias (Tally name tightKey → system dealer).
  for (const a of aliasRows as { tallyKey: string; systemDealerId: string; tallyName: string }[]) {
    if (a.tallyKey === t) {
      const d = byId.get(a.systemDealerId);
      if (d) add(d.id, d.name, "alias", 1);
    }
  }
  // 2. Exact tightKey, 3. loose key, 4. fuzzy ≥ 0.6.
  for (const d of dealers) {
    if (d.tight === t) add(d.id, d.name, "exact", 1);
    else if (d.loose === l) add(d.id, d.name, "loose", 0.95);
    else {
      const s = similarity(trimmed, d.name);
      if (s >= 0.6) add(d.id, d.name, "fuzzy", s);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
