import "server-only";
import { prisma } from "@/lib/prisma";
import { decorate, matchByName, tightKey, type Keyed } from "@/lib/match-key";
import { terminalSurvivor } from "@/lib/product-merge";

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
  /** Selectable products only (active + not merged) — the fuzzy/canonical match set. */
  products: ProductMasterItem[];
  /** id → own name, for EVERY loaded product (active + merged sources), for historical display. */
  productNameById: Map<string, string>;
  /** Resolve an uploaded name to the operational SURVIVING product (a merged source name → its survivor). */
  resolveProduct: (rawName: string) => ProductMasterItem | null;
  /** The operational product id for any (possibly merged) product id (terminal survivor). */
  effectiveProductId: (productId: string) => string;
  /** id → its terminal-survivor id, for every loaded product (merged source → survivor; else itself). */
  mergedIntoById: Map<string, string | null>;
}

export async function loadProductResolver(): Promise<ProductResolver> {
  // Load active/normal products PLUS merged sources (isActive false but mergedIntoId set): the merged source
  // names must still resolve to their survivor even though the source is hidden operationally.
  const allRows = (await prisma.product.findMany({
    where: { OR: [{ isActive: true }, { mergedIntoId: { not: null } }] },
    select: { id: true, name: true, canonicalName: true, isActive: true, mergedIntoId: true },
  })) as { id: string; name: string; canonicalName: string | null; isActive: boolean; mergedIntoId: string | null }[];

  const mergedIntoById = new Map<string, string | null>(allRows.map((p) => [p.id, p.mergedIntoId]));
  const effectiveProductId = (id: string) => terminalSurvivor(id, mergedIntoById);

  // Decorate the FULL set for name matching (so a merged source spelling still matches), but expose only
  // selectable products (active + not merged) as `products`.
  const decoratedAll: ProductMasterItem[] = decorate(allRows.map((p) => ({ id: p.id, name: p.name, canonicalName: p.canonicalName })));
  const metaById = new Map(allRows.map((p) => [p.id, p]));
  const itemById = new Map(decoratedAll.map((p) => [p.id, p]));
  const products = decoratedAll.filter((p) => { const m = metaById.get(p.id); return m && m.isActive && m.mergedIntoId == null; });
  const productNameById = new Map(decoratedAll.map((p) => [p.id, p.name]));

  // Given any matched item, return the SURVIVING product's item (never a merged source).
  const survivorItem = (item: ProductMasterItem): ProductMasterItem => itemById.get(effectiveProductId(item.id)) ?? item;

  const canonicalTargetByKey = new Map<string, ProductMasterItem>();
  const selfCanonical = new Map<string, ProductMasterItem>(); // tightKey(canonicalName) -> the master row
  for (const p of decoratedAll) {
    if (p.canonicalName && tightKey(p.name) === tightKey(p.canonicalName)) selfCanonical.set(tightKey(p.canonicalName), p);
  }
  for (const p of decoratedAll) {
    if (!p.canonicalName) continue;
    const target = selfCanonical.get(tightKey(p.canonicalName));
    if (!target) continue; // canonical/master row not present → don't arbitrarily choose; fall back
    canonicalTargetByKey.set(tightKey(p.name), target);            // Tally sends this spelling → canonical
    canonicalTargetByKey.set(tightKey(p.canonicalName), target);   // Tally sends the canonical spelling → canonical
  }
  const resolveProduct = (rawName: string): ProductMasterItem | null => {
    const matched = canonicalTargetByKey.get(tightKey(rawName)) ?? matchByName(rawName, decoratedAll, { fuzzy: true, threshold: 0.9 });
    return matched ? survivorItem(matched) : null; // ALWAYS return the operational survivor
  };

  return { products, productNameById, resolveProduct, effectiveProductId, mergedIntoById };
}
