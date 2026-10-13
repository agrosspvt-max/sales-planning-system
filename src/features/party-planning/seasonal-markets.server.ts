import "server-only";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";
import { getCurrentDealerIds } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { cleanMarketName, marketNameKey } from "@/lib/territory-mapping";

/**
 * Seasonal Planning → which Markets may a planner choose? ONE rule, used both to list the choices and to validate a selected Market on create / edit.
 *
 * For an owner (the Sales Officer / Regional Manager who owns the Seasonal Plan — resolved on the server from the authenticated user, never from the
 * browser) the eligible Markets are the UNION of:
 *   1. EXISTING — the Market each of the owner's CURRENT dealers shows in Territory Mapping → Existing Markets. "Current" = the dealer's current owner
 *      is this officer (same rule as the Territory Mapping list: active, not deleted). A manually edited Market (`marketText`) REPLACES the underlying
 *      Market for that dealer, exactly as it does on screen: the old underlying name is NOT offered, and free text is never trusted as an id — the edited
 *      name is matched (by its normalized name) to an existing Market record. A displayed name with NO Market record is still offered, as a
 *      TERRITORY option referencing the owner's persisted mapping (`territoryMappingId`, no Market id): listing never writes anything. The canonical
 *      Market record is resolved / created only by an explicit, authenticated save (resolveTerritoryMarket), after re-verifying ownership and the name.
 *   2. APPROVED VACANT — Markets the owner requested through Vacant Market that Admin finally approved (request APPROVED and linked to a Market),
 *      whether or not any dealer is assigned to them yet.
 * Nothing else qualifies: other officers' markets / requests, pending or rejected requests and unrelated global Markets are excluded. A Market that
 * qualifies for several officers appears for each; the result is de-duplicated and sorted by name.
 *
 * Existing Seasonal Plan rows are never re-checked against this rule when read — only a NEW selection (create, or changing the Market) is.
 */

export interface SeasonalMarketOption {
  /** The Market record, or null for a displayed territory name that has no Market record yet (then `territoryMappingId` is the selection reference). */
  id: string | null; territoryMappingId: string | null; name: string; potential: string | null; source: string;
}
export interface SeasonalMarketOptions { markets: SeasonalMarketOption[] }

const MARKET_SELECT = { id: true, name: true, potential: true, source: true } as const;
const toOption = (m: { id: string; name: string; potential: string | null; source: string }): SeasonalMarketOption => ({ id: m.id, territoryMappingId: null, name: m.name, potential: m.potential, source: m.source });

export async function listEligibleMarkets(ownerId: string): Promise<SeasonalMarketOptions> {
  const owned = await getCurrentDealerIds(ownerId);
  const dealers = owned.length ? await prisma.dealer.findMany({ where: { id: { in: owned }, deletedAt: null, isActive: true }, select: { id: true } }) : [];
  const dealerIds = dealers.map((d) => d.id);
  const [mappings, requests] = await Promise.all([
    dealerIds.length ? prisma.dealerMarketMapping.findMany({ where: { dealerId: { in: dealerIds } }, select: { id: true, marketId: true, marketText: true, market: { select: MARKET_SELECT } } }) : Promise.resolve([]),
    prisma.marketRequest.findMany({ where: { requesterId: ownerId, status: "APPROVED", marketId: { not: null } }, select: { market: { select: MARKET_SELECT } } }),
  ]);

  const byId = new Map<string, SeasonalMarketOption>();
  const edited = new Map<string, { text: string; mappingId: string }>(); // normalized key → the name shown in Territory Mapping + the (lowest-id) mapping carrying it
  for (const m of mappings) {
    const text = m.marketText?.trim();
    if (text) {
      const key = marketNameKey(text);
      const have = edited.get(key);
      if (key && (!have || m.id < have.mappingId)) edited.set(key, { text: cleanMarketName(text), mappingId: m.id }); // the displayed name wins over the underlying Market
    } else if (m.market) byId.set(m.market.id, toOption(m.market));
  }
  const territory: SeasonalMarketOption[] = [];
  if (edited.size > 0) {
    const found = await prisma.market.findMany({ where: { nameKey: { in: [...edited.keys()] } }, select: { ...MARKET_SELECT, nameKey: true } });
    for (const f of found) { byId.set(f.id, toOption(f)); edited.delete(f.nameKey); }
    for (const e of edited.values()) territory.push({ id: null, territoryMappingId: e.mappingId, name: e.text, potential: null, source: "EXISTING" });
  }
  for (const r of requests) if (r.market) byId.set(r.market.id, toOption(r.market));

  return { markets: [...byId.values(), ...territory].sort((a, b) => a.name.localeCompare(b.name) || (a.id ?? a.territoryMappingId ?? "").localeCompare(b.id ?? b.territoryMappingId ?? "")) };
}

/** Throws 422 unless `marketId` is one of the owner's eligible Markets (a Market that merely exists in the global table is not enough). */
export async function assertMarketEligible(ownerId: string, marketId: string): Promise<void> {
  const { markets } = await listEligibleMarkets(ownerId);
  if (!markets.some((m) => m.id === marketId)) throw new ApiError(422, "This market is not in your territory. Choose one from your Existing Markets or an approved Vacant Market of yours.");
}

// The slice of a Prisma transaction client this module needs.
type Tx = Pick<typeof prisma, "dealerMarketMapping" | "dealer" | "market">;

/**
 * An explicit, authenticated SAVE of a territory selection (never called while listing choices): turns "the Market shown for the owner's mapping
 * `mappingId`" into its canonical Market record, inside the caller's transaction.
 *   • the mapping must belong to a dealer the owner CURRENTLY owns (active, not deleted) — otherwise 422;
 *   • its CURRENTLY saved Market name must still be `expectedMarket` (normalized) — a renamed / reverted mapping is 409 ("reload");
 *   • the Market is found by normalized name (existing metadata untouched); only when none exists is one created — source EXISTING, Potential unknown
 *     (null, not invented), audited. Two concurrent saves race on the unique nameKey: the loser gets P2002, rolls back and the caller retries, then
 *     simply finds the winner's Market. Territory mappings, edit history and other plans are never touched.
 */
export async function resolveTerritoryMarket(tx: Tx, actor: { userId: string; designation?: string | null }, ownerId: string, mappingId: string, expectedMarket: string): Promise<{ id: string; name: string }> {
  const NOT_YOURS = "This market is not in your territory. Choose one from your Existing Markets or an approved Vacant Market of yours.";
  const mapping = await tx.dealerMarketMapping.findUnique({ where: { id: mappingId }, select: { id: true, dealerId: true, marketText: true } });
  if (!mapping) throw new ApiError(422, NOT_YOURS);
  const owned = await getCurrentDealerIds(ownerId);
  const dealer = owned.includes(mapping.dealerId) ? await tx.dealer.findMany({ where: { id: { in: [mapping.dealerId] }, deletedAt: null, isActive: true }, select: { id: true } }) : [];
  if (dealer.length === 0) throw new ApiError(422, NOT_YOURS);
  const text = mapping.marketText?.trim();
  const key = text ? marketNameKey(text) : "";
  if (!text || !key || key !== marketNameKey(expectedMarket)) throw new ApiError(409, "This dealer's Market was changed. Reload the choices and select the Market again.");
  const existing = await tx.market.findUnique({ where: { nameKey: key }, select: { id: true, name: true } });
  if (existing) return existing;
  const created = await tx.market.create({ data: { name: cleanMarketName(text), nameKey: key, source: "EXISTING", createdById: actor.userId }, select: { id: true, name: true } });
  await writeAudit({ userId: actor.userId, actorDesignation: actor.designation ?? null, action: "CREATE", entity: "market", entityId: created.id, summary: `Market created from Territory Mapping · ${created.name} (Seasonal Planning)` }, tx as never);
  return created;
}
