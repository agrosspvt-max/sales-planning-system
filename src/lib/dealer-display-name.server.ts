import "server-only";
import { prisma } from "@/lib/prisma";
import { dealerDisplayName, pickDisplayAlias, type DealerAliasChoice } from "@/lib/dealer-display-name";

/**
 * Server-side batched loader for dealer DISPLAY names (alias-preferred). This is the single place every
 * feature should call to turn Dealer.id(s) into what the user should SEE. It reads DealerAlias rows only —
 * it never writes, never renames dealers, and is entirely separate from the alias matching/import layer.
 */

/** Group a flat list of alias rows by their systemDealerId. */
function groupAliases(rows: { id: string; systemDealerId: string; tallyName: string; createdAt: Date }[]): Map<string, DealerAliasChoice[]> {
  const byDealer = new Map<string, DealerAliasChoice[]>();
  for (const row of rows) {
    const list = byDealer.get(row.systemDealerId) ?? [];
    list.push({ id: row.id, tallyName: row.tallyName, createdAt: row.createdAt });
    byDealer.set(row.systemDealerId, list);
  }
  return byDealer;
}

/**
 * Map of dealerId → the ONE display alias name, for dealers that HAVE an alias. Dealers without an alias are
 * intentionally absent (callers fall back to the dealer's own name). Pass `dealerIds` to scope the query to
 * just the dealers on the current page; omit it to load every alias override (used by the client provider).
 */
export async function loadDealerAliasNameMap(dealerIds?: readonly string[], db: Pick<typeof prisma, "dealerAlias"> = prisma): Promise<Map<string, string>> {
  if (dealerIds && dealerIds.length === 0) return new Map();
  const rows = (await db.dealerAlias.findMany({
    where: dealerIds ? { systemDealerId: { in: [...new Set(dealerIds)] } } : undefined,
    select: { id: true, systemDealerId: true, tallyName: true, createdAt: true },
  })) as { id: string; systemDealerId: string; tallyName: string; createdAt: Date }[];
  const byDealer = groupAliases(rows);
  const out = new Map<string, string>();
  for (const [dealerId, aliases] of byDealer) {
    const chosen = pickDisplayAlias(aliases);
    if (chosen) out.set(dealerId, chosen.tallyName);
  }
  return out;
}

/**
 * Resolve display names for a set of dealers given their {id, name}. Returns id → display name for ALL the
 * given dealers (alias when present, else the dealer's own name). Convenience over loadDealerAliasNameMap for
 * callers that already hold the dealers' fallback names.
 */
export async function resolveDealerDisplayNames(
  dealers: readonly { id: string; name: string }[],
): Promise<Map<string, string>> {
  const aliasMap = await loadDealerAliasNameMap(dealers.map((d) => d.id));
  const out = new Map<string, string>();
  for (const dealer of dealers) out.set(dealer.id, aliasMap.get(dealer.id) ?? dealer.name);
  return out;
}

/**
 * Decorate a list of rows in place-free fashion: return new rows whose display-name field is replaced with the
 * alias-preferred name, WITHOUT touching the dealer id or any other field. `getId` reads the row's dealer id;
 * `nameKey` is the field holding the display name to overwrite (defaults to "dealerName").
 *
 * The id is the business identity and is never changed — only the human-facing name string is swapped.
 */
export async function decorateDealerNames<T extends object>(
  rows: readonly T[],
  getId: (row: T) => string | null | undefined,
  nameKey: keyof T = "dealerName" as keyof T,
): Promise<T[]> {
  const ids = rows.map(getId).filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return rows.map((row) => ({ ...row }));
  const aliasMap = await loadDealerAliasNameMap(ids);
  return rows.map((row) => {
    const id = getId(row);
    const alias = id ? aliasMap.get(id) : undefined;
    if (!alias) return { ...row };
    return { ...row, [nameKey]: alias } as T;
  });
}

export { dealerDisplayName };
