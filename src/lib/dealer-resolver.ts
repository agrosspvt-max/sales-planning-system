import "server-only";
import { prisma } from "@/lib/prisma";
import { decorate, dealerNameProfile, dealerSimilarityWithProfile, tightKey, looseKey, type DealerNameProfile, type Keyed } from "@/lib/match-key";

/**
 * The ONE dealer resolver for every importer (Sales Upload, Recovery, …). Resolution order is
 * fixed and shared, so all modules behave identically:
 *
 *   1. Dealer Alias  (Tally name → System dealer, via DealerAlias.tallyKey)
 *   2. Exact         (tightKey)          ┐
 *   3. Loose         (looseKey)          ├─ the shared `matchByName`
 *   4. Fuzzy         (dealer score ≥ 0.78)  ┘
 *
 * When an alias exists it wins outright (no fuzzy fallback) — the Tally name maps straight to
 * the system dealer. There is no separate alias table or alias logic anywhere else.
 */
export type DealerMatch = { id: string; name: string; profile: DealerNameProfile } & Keyed;
export const DEALER_FUZZY_THRESHOLD = 0.78;

/** How a raw name resolved to a master dealer — surfaced in previews (same rules, no new matcher). */
export type MatchType = "ALIAS" | "EXACT" | "LOOSE" | "FUZZY";
export interface DealerMatchResult {
  dealer: DealerMatch;
  matchType: MatchType;
  score: number; // 1 for alias/exact, 0.95 for loose, the dealer fuzzy score for fuzzy
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
    // Matching gates on isActive (source of truth: status !== "INACTIVE"). Pending, Active AND
    // Defaulter dealers all participate in uploads/matching/recovery; only Inactive is excluded.
    // (Planning eligibility is enforced separately — see the DEFAULTER exclusions in planning queries.)
    prisma.dealer.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { tallyKey: true, tallyName: true, systemDealerId: true } }),
  ]);
  const dealers: DealerMatch[] = decorate(dealerRows as { id: string; name: string }[]).map((dealer) => ({
    ...dealer,
    profile: dealerNameProfile(dealer.name),
  }));
  const byId = new Map(dealers.map((d) => [d.id, d]));
  // Key each alias by re-deriving tightKey from its stored Tally NAME (not the stored tallyKey), so the
  // alias side is normalised with the exact same function used on the incoming raw name — leading/trailing
  // (and, per tightKey's existing rules, all) whitespace can never cause a mismatch, even for any legacy
  // row whose stored tallyKey was saved un-normalised. Falls back to the stored key if the name is blank.
  const aliasByKey = new Map<string, string>(
    (aliasRows as { tallyKey: string; tallyName: string; systemDealerId: string }[]).map((a) => [
      tightKey(a.tallyName) || a.tallyKey,
      a.systemDealerId,
    ]),
  );

  // ONE matching implementation with reasons; resolve() is just the dealer-only projection of it.
  function resolveWithReason(rawName: string): DealerMatchResult | null {
    const t = tightKey(rawName);
    const l = looseKey(rawName);

    // 1. Alias
    const aliasId = aliasByKey.get(t);
    if (aliasId) {
      const d = byId.get(aliasId);
      if (d) {
        return {
          dealer: d,
          matchType: "ALIAS",
          score: 1,
        };
      }
    }

    // 2. Exact
    if (t) {
      const exact = dealers.find((x) => x.tight === t);
      if (exact) {
        return {
          dealer: exact,
          matchType: "EXACT",
          score: 1,
        };
      }
    }

    // 3. Loose
    if (l) {
      const loose = dealers.find((x) => x.loose === l);
      if (loose) {
        return {
          dealer: loose,
          matchType: "LOOSE",
          score: 0.95,
        };
      }
    }

    // 4. Fuzzy
    let best: DealerMatchResult | null = null;
    for (const x of dealers) {
      const s = dealerSimilarityWithProfile(rawName, x.profile);
      if (s >= DEALER_FUZZY_THRESHOLD) {
        if (!best || s > best.score) {
          best = {
            dealer: x,
            matchType: "FUZZY",
            score: s,
          };
        }
      }
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
  const dealers: DealerMatch[] = decorate(dealerRows as { id: string; name: string }[]).map((dealer) => ({
    ...dealer,
    profile: dealerNameProfile(dealer.name),
  }));
  const byId = new Map(dealers.map((d) => [d.id, d]));
  const t = tightKey(trimmed);
  const l = looseKey(trimmed);

  const out = new Map<string, ProbableDealer>();
  const add = (id: string, name: string, reason: ProbableDealer["reason"], score: number) => {
    const prev = out.get(id);
    if (!prev || score > prev.score) out.set(id, { id, name, reason, score });
  };

  // 1. Alias (Tally name → system dealer). Re-derive the alias key from the stored Tally NAME with the
  // same tightKey used on the input, so both sides are normalised identically (whitespace-safe, robust to
  // any legacy un-normalised stored key).
  for (const a of aliasRows as { tallyKey: string; systemDealerId: string; tallyName: string }[]) {
    if ((tightKey(a.tallyName) || a.tallyKey) === t) {
      const d = byId.get(a.systemDealerId);
      if (d) add(d.id, d.name, "alias", 1);
    }
  }
  // 2. Exact tightKey, 3. loose key, 4. the same dealer fuzzy scorer.
  for (const d of dealers) {
    if (d.tight === t) add(d.id, d.name, "exact", 1);
    else if (d.loose === l) add(d.id, d.name, "loose", 0.95);
    else {
      const s = dealerSimilarityWithProfile(trimmed, d.profile);
      if (s >= DEALER_FUZZY_THRESHOLD) add(d.id, d.name, "fuzzy", s);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
