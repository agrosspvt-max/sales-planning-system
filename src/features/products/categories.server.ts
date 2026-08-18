import "server-only";
import { prisma } from "@/lib/prisma";

export interface CategoryDTO {
  id: string;
  name: string;
  nbvPercent: number | null; // fraction, e.g. 0.35 for 35%
  notation: string | null;
  color: string | null;
}

/**
 * Active categories with their NBV%/notation/color — the source for the product Category badge and the
 * Category filter. A product's category is whichever entry's nbvPercent matches its own (client-derived).
 */
export async function listActiveCategories(): Promise<CategoryDTO[]> {
  const rows = (await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, nbvPercent: true, notation: true, color: true },
  })) as { id: string; name: string; nbvPercent: unknown; notation: string | null; color: string | null }[];
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    nbvPercent: c.nbvPercent == null ? null : Number(c.nbvPercent),
    notation: c.notation,
    color: c.color,
  }));
}

/* --------------------- Product ↔ Category (by NBV%) ----------------------- */
// A Product belongs to the Category whose nbvPercent matches its own — there is NO manual mapping.
// NBV% is a Decimal(6,4) fraction; compare on the 4-dp integer grid so 0.35 === 0.3500 always matches.
const nbvKey = (n: number) => Math.round(n * 10000);

/** The active category id whose NBV% equals `nbv` (fraction), or null when none matches. */
export async function categoryIdForNbv(nbv: number): Promise<string | null> {
  const cats = (await prisma.category.findMany({
    where: { isActive: true, nbvPercent: { not: null } },
    select: { id: true, nbvPercent: true },
  })) as { id: string; nbvPercent: unknown }[];
  const key = nbvKey(nbv);
  const hit = cats.find((c) => c.nbvPercent != null && nbvKey(Number(c.nbvPercent)) === key);
  return hit?.id ?? null;
}

/**
 * Re-point every Product's categoryId to the active category matching its NBV% (or null when none). Called
 * after any Category create/edit/(de)activate so "all products with that NBV% adopt the category" holds.
 * Only rows whose mapping actually changes are written. Never touches rate/NBV/snapshots — categoryId only.
 */
export async function resyncAllProductCategories(): Promise<void> {
  const [products, cats] = (await Promise.all([
    prisma.product.findMany({ select: { id: true, nbvPercent: true, categoryId: true } }),
    prisma.category.findMany({ where: { isActive: true, nbvPercent: { not: null } }, select: { id: true, nbvPercent: true } }),
  ])) as [{ id: string; nbvPercent: unknown; categoryId: string | null }[], { id: string; nbvPercent: unknown }[]];
  const byKey = new Map<number, string>();
  for (const c of cats) if (c.nbvPercent != null) byKey.set(nbvKey(Number(c.nbvPercent)), c.id);
  for (const p of products) {
    const want = byKey.get(nbvKey(Number(p.nbvPercent))) ?? null;
    if (want !== p.categoryId) await prisma.product.update({ where: { id: p.id }, data: { categoryId: want } });
  }
}
