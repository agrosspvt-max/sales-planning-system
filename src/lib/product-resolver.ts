import "server-only";
import { prisma } from "@/lib/prisma";
import { decorate, matchByName, tightKey, type Keyed } from "@/lib/match-key";

/**
 * The ONE authoritative product-name resolver for Tally-style uploads (Sales Upload AND Scheme Upload).
 *
 * Extracted VERBATIM from the Sales Upload matcher so both upload pipelines resolve an uploaded product
 * name to the same master product — there is no second product matcher. Identity chain:
 *   Canonical Name (exact) → tight → loose → fuzzy (via the shared `matchByName`).
 *
 * Canonical Name handling: for each `canonicalName` group, the "target" is the product whose OWN name
 * equals the canonicalName (the master/canonical row), so an alternate spelling never becomes the selected
 * product. Both the canonical spelling and every alternate spelling point to that target. If no
 * self-canonical product exists, the group is skipped (no arbitrary pick) and matching falls back to the
 * name logic. Products without a canonicalName are never indexed here. PURE matching — no writes.
 */

export type ProductMasterItem = { id: string; name: string; canonicalName: string | null } & Keyed;

export interface ProductResolver {
  products: ProductMasterItem[];
  productNameById: Map<string, string>;
  resolveProduct: (rawName: string) => ProductMasterItem | null;
}

export async function loadProductResolver(): Promise<ProductResolver> {
  const productRows = await prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true, canonicalName: true } });
  const products: ProductMasterItem[] = decorate(productRows as { id: string; name: string; canonicalName: string | null }[]);
  const productNameById = new Map(products.map((p) => [p.id, p.name]));

  const canonicalTargetByKey = new Map<string, ProductMasterItem>();
  const selfCanonical = new Map<string, ProductMasterItem>(); // tightKey(canonicalName) -> the master row
  for (const p of products) {
    if (p.canonicalName && tightKey(p.name) === tightKey(p.canonicalName)) selfCanonical.set(tightKey(p.canonicalName), p);
  }
  for (const p of products) {
    if (!p.canonicalName) continue;
    const target = selfCanonical.get(tightKey(p.canonicalName));
    if (!target) continue; // canonical/master row not present → don't arbitrarily choose; fall back
    canonicalTargetByKey.set(tightKey(p.name), target);            // Tally sends this spelling → canonical
    canonicalTargetByKey.set(tightKey(p.canonicalName), target);   // Tally sends the canonical spelling → canonical
  }
  const resolveProduct = (rawName: string): ProductMasterItem | null =>
    canonicalTargetByKey.get(tightKey(rawName)) ?? matchByName(rawName, products, { fuzzy: true, threshold: 0.9 });

  return { products, productNameById, resolveProduct };
}
