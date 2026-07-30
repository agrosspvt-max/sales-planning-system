import "server-only";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { getOfficerScope, getCurrentDealerIds } from "@/lib/scope";

export interface SearchHit {
  type: "Product" | "Dealer" | "User" | "Season" | "Announcement";
  id: string;
  label: string;
  sublabel?: string;
  href: string;
}

const TAKE = 5;

/**
 * Global search across masters. Permission-scoped:
 * products/seasons/announcements are readable by all; dealers are scoped to the
 * user's assignments; users are Super-Admin-only.
 */
export async function globalSearch(ctx: AuthContext, q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const contains = { contains: term, mode: "insensitive" as const };
  const hits: SearchHit[] = [];

  // Products
  const products = await prisma.product.findMany({
    where: { OR: [{ name: contains }, { technicalName: contains }] },
    take: TAKE,
    orderBy: { name: "asc" },
  });
  for (const p of products) {
    hits.push({ type: "Product", id: p.id, label: p.name, sublabel: p.technicalName ?? undefined, href: "/masters/products" });
  }

  // Dealers — scoped
  const scope = await getOfficerScope(ctx);
  let dealerWhere: Record<string, unknown> = { name: contains };
  if (!scope.all) {
    const dealerIds: string[] = [];
    for (const officerId of scope.ids) dealerIds.push(...(await getCurrentDealerIds(officerId)));
    dealerWhere = { AND: [{ name: contains }, { id: { in: dealerIds } }] };
  }
  const dealers = await prisma.dealer.findMany({ where: dealerWhere, take: TAKE, orderBy: { name: "asc" } });
  for (const d of dealers) {
    hits.push({ type: "Dealer", id: d.id, label: d.name, sublabel: d.town ?? undefined, href: "/masters/dealers" });
  }

  // Seasons
  const seasons = await prisma.season.findMany({ where: { name: contains }, take: TAKE, orderBy: { year: "desc" } });
  for (const s of seasons) {
    hits.push({ type: "Season", id: s.id, label: `${s.name} ${s.year}`, href: "/seasons" });
  }

  // Announcements
  const anns = await prisma.announcement.findMany({
    where: { title: contains, isActive: true },
    take: TAKE,
    orderBy: { createdAt: "desc" },
  });
  for (const a of anns) {
    hits.push({ type: "Announcement", id: a.id, label: a.title, href: "/announcements" });
  }

  // Users — Super Admin only
  if (ctx.role === Role.SUPER_ADMIN) {
    const users = await prisma.user.findMany({
      where: { OR: [{ name: contains }, { username: contains }] },
      take: TAKE,
      orderBy: { name: "asc" },
    });
    for (const u of users) {
      hits.push({ type: "User", id: u.id, label: u.name, sublabel: `@${u.username}`, href: "/masters/users" });
    }
  }

  return hits;
}
