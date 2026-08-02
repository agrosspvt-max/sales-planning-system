import "server-only";
import { prisma } from "@/lib/prisma";
import { decorate, matchByName, tightKey, type Keyed } from "@/lib/match-key";

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

export interface DealerResolver {
  dealers: DealerMatch[];
  /** Alias → exact → loose → fuzzy. Returns the master dealer or null. */
  resolve(rawName: string): DealerMatch | null;
}

export async function loadDealerResolver(): Promise<DealerResolver> {
  const [dealerRows, aliasRows] = await Promise.all([
    prisma.dealer.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { tallyKey: true, systemDealerId: true } }),
  ]);
  const dealers = decorate(dealerRows as { id: string; name: string }[]);
  const byId = new Map(dealers.map((d) => [d.id, d]));
  const aliasByKey = new Map<string, string>(
    (aliasRows as { tallyKey: string; systemDealerId: string }[]).map((a) => [a.tallyKey, a.systemDealerId]),
  );

  return {
    dealers,
    resolve(rawName: string): DealerMatch | null {
      const aliasId = aliasByKey.get(tightKey(rawName));
      if (aliasId) return byId.get(aliasId) ?? null; // alias wins outright
      return matchByName(rawName, dealers, { fuzzy: true, threshold: 0.9 });
    },
  };
}
