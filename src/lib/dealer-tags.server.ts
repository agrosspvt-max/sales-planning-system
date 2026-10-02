import "server-only";
import { prisma } from "@/lib/prisma";
import { getOfficerScope, getCurrentOwnerByDealer } from "@/lib/scope";
import type { AuthContext } from "@/lib/http";
import type { DealerMarker, DealerMarkerMap } from "@/lib/dealer-tags";

/** One query for any number of dealer IDs. Only approved assignments and active definitions qualify. */
export async function loadDealerMarkerMap(dealerIds?: readonly string[]): Promise<DealerMarkerMap> {
  if (dealerIds?.length === 0) return {};
  const rows = await prisma.dealerTagAssignment.findMany({
    where: {
      isActive: true,
      tag: { isActive: true },
      ...(dealerIds ? { dealerId: { in: [...new Set(dealerIds)] } } : {}),
    },
    select: {
      dealerId: true,
      tag: { select: { id: true, name: true, marker: true, markerType: true } },
    },
    orderBy: [{ tag: { name: "asc" } }, { tagId: "asc" }],
  });
  const out: Record<string, DealerMarker[]> = {};
  for (const row of rows)
    (out[row.dealerId] ??= []).push({
      ...row.tag,
      markerType: row.tag.markerType as DealerMarker["markerType"],
    });
  return out;
}

/** Display provider includes current permitted dealers and historical dealer rows the existing modules
 * already authorize. It grants no mutation/ownership permission; tagging uses current ownership only. */
export async function loadScopedDealerMarkerMap(ctx: AuthContext): Promise<DealerMarkerMap> {
  const scope = await getOfficerScope(ctx);
  const tags = await loadDealerMarkerMap();
  const ids = Object.keys(tags);
  if (scope.all || !ids.length) return tags;
  const [owners, historical] = await Promise.all([
    getCurrentOwnerByDealer(ids),
    prisma.dealer.findMany({
      where: {
        id: { in: ids },
        OR: [
          { planDealers: { some: { seasonPlan: { officerId: { in: scope.ids } } } } },
          { recoveryPlanDealers: { some: { recoveryPlan: { officerId: { in: scope.ids } } } } },
          { schemePlans: { some: { salesOfficerId: { in: scope.ids } } } },
          { cnRequests: { some: { officerId: { in: scope.ids } } } },
          { dailyWorkEntries: { some: { officerId: { in: scope.ids } } } },
        ],
      },
      select: { id: true },
    }),
  ]);
  const allowed = new Set(historical.map((d) => d.id));
  for (const [id, owner] of owners) if (scope.ids.includes(owner)) allowed.add(id);
  return Object.fromEntries(Object.entries(tags).filter(([id]) => allowed.has(id)));
}
