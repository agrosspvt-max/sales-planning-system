import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { validateMerge, terminalSurvivor } from "@/lib/product-merge";

/**
 * PRODUCT MERGE / CONSOLIDATION (Phase 12).
 *
 * Consolidates a SOURCE product (e.g. ADAM PLUS) into a SURVIVING product (e.g. ADAM). Fully transactional
 * (all-or-nothing) and idempotent (re-running the same merge is a no-op; chained merges fold to the terminal
 * survivor; circular merges are rejected). Additive + reversible: the source row is never deleted — it is
 * deactivated and pointed at the survivor via `mergedIntoId`, so history/audit survive and name/id resolution
 * maps ADAM PLUS → ADAM.
 *
 * What it TOUCHES (current operational config only):
 *   • GroupProductCatalogue — survivor-wins consolidation (deactivate source entry; create a survivor entry
 *     from the source only where the survivor is absent in that group). Never averages/combines prices.
 *   • SchemeEligibleProduct / SchemeRequirementProduct — reassign source→survivor and DEDUPE. A genuine
 *     conflicting Fixed requirement (survivor already required with DIFFERENT qty/value) ABORTS the merge.
 *   • Product — deactivate source + set mergedIntoId/mergedAt/mergedById.
 *   • ProductMerge — one auditable row carrying the exact impact (for safe reversal).
 *
 * What it DOES NOT touch (preserved for read-time aggregation / history):
 *   • PlanLine / MonthlyEntry / PlanLinePack (plan snapshots — immutable), SchemeSale (upload facts),
 *     AdminEditAudit (historical snapshots). These roll up into the survivor at READ time via the resolver.
 */

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can merge products");
}

const mergeSchema = z.object({
  sourceProductId: z.string().min(1),
  survivingProductId: z.string().min(1),
  note: z.string().max(500).optional(),
});

const num = (d: unknown): number => (d == null ? 0 : Number(d.toString()));

/** Structured, reversible record of everything a merge changed (stored as JSON on ProductMerge). */
interface MergeImpact {
  catalogue: { groupId: string; action: "deactivateSource" | "createSurvivorFromSource"; prevSourceActive: boolean }[];
  eligibleReassignedSchemeIds: string[];
  eligibleDeletedSchemeIds: string[];
  requirementReassignedSchemeIds: string[];
  requirementDeletedSchemes: { schemeId: string; requiredQty: number | null; requiredValue: number | null }[];
}

export interface MergePreview {
  sourceId: string; sourceName: string;
  survivorId: string; survivorName: string;
  alreadyMerged: boolean;
  catalogueGroupsBoth: number;      // groups where BOTH exist (survivor wins; source entry hidden)
  catalogueGroupsSourceOnly: number; // groups where only source exists (survivor entry created)
  schemeEligible: number;            // scheme eligible-pool rows on the source
  schemeRequirement: number;         // scheme requirement rows on the source
  requirementConflicts: { schemeId: string; schemeName: string }[]; // genuine conflicting Fixed requirements
}

/** Load the full merge graph (id → mergedIntoId) + names, for validation + preview. */
async function loadGraph() {
  const rows = (await prisma.product.findMany({ select: { id: true, name: true, mergedIntoId: true } })) as { id: string; name: string; mergedIntoId: string | null }[];
  const mergedIntoById = new Map<string, string | null>(rows.map((r) => [r.id, r.mergedIntoId]));
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const ids = new Set(rows.map((r) => r.id));
  return { mergedIntoById, nameById, ids };
}

/**
 * Dry-run: what a merge would do, including any genuine requirement conflicts (which block the merge).
 * Read-only; never writes.
 */
export async function previewMerge(ctx: AuthContext, raw: unknown): Promise<MergePreview> {
  assertAdmin(ctx);
  const { sourceProductId, survivingProductId } = mergeSchema.parse(raw);
  const { mergedIntoById, nameById, ids } = await loadGraph();
  const v = validateMerge({ sourceId: sourceProductId, survivorId: survivingProductId, existingIds: ids, mergedIntoById });
  if (!v.ok) throw new ApiError(422, v.reason ?? "Invalid merge");
  const survivorId = v.terminalSurvivorId!;

  const [srcCat, survCatGroups, eligibleCount, srcReq, survReq] = await Promise.all([
    prisma.groupProductCatalogue.findMany({ where: { productId: sourceProductId }, select: { groupId: true } }),
    prisma.groupProductCatalogue.findMany({ where: { productId: survivorId }, select: { groupId: true } }),
    prisma.schemeEligibleProduct.count({ where: { productId: sourceProductId } }),
    prisma.schemeRequirementProduct.findMany({ where: { productId: sourceProductId }, select: { schemeId: true, requiredQty: true, requiredValue: true, scheme: { select: { schemeName: true } } } }),
    prisma.schemeRequirementProduct.findMany({ where: { productId: survivorId }, select: { schemeId: true, requiredQty: true, requiredValue: true } }),
  ]) as [
    { groupId: string }[], { groupId: string }[], number,
    { schemeId: string; requiredQty: unknown; requiredValue: unknown; scheme: { schemeName: string } }[],
    { schemeId: string; requiredQty: unknown; requiredValue: unknown }[],
  ];

  const survGroups = new Set(survCatGroups.map((g) => g.groupId));
  const both = srcCat.filter((c) => survGroups.has(c.groupId)).length;
  const sourceOnly = srcCat.length - both;

  const survReqByScheme = new Map(survReq.map((r) => [r.schemeId, r] as const));
  const requirementConflicts: { schemeId: string; schemeName: string }[] = [];
  for (const r of srcReq) {
    const s = survReqByScheme.get(r.schemeId);
    if (s && (num(s.requiredQty) !== num(r.requiredQty) || num(s.requiredValue) !== num(r.requiredValue))) {
      requirementConflicts.push({ schemeId: r.schemeId, schemeName: r.scheme.schemeName });
    }
  }

  return {
    sourceId: sourceProductId, sourceName: nameById.get(sourceProductId) ?? sourceProductId,
    survivorId, survivorName: nameById.get(survivorId) ?? survivorId,
    alreadyMerged: !!v.alreadyMerged,
    catalogueGroupsBoth: both, catalogueGroupsSourceOnly: sourceOnly,
    schemeEligible: eligibleCount,
    schemeRequirement: srcReq.length,
    requirementConflicts,
  };
}

export interface MergeResult { merged: boolean; alreadyMerged: boolean; sourceName: string; survivorName: string; mergeId?: string }

/** Perform the merge. Transactional + idempotent. Aborts on a genuine conflicting Fixed requirement. */
export async function mergeProducts(ctx: AuthContext, raw: unknown): Promise<MergeResult> {
  assertAdmin(ctx);
  const { sourceProductId, survivingProductId, note } = mergeSchema.parse(raw);
  const { mergedIntoById, nameById, ids } = await loadGraph();
  const v = validateMerge({ sourceId: sourceProductId, survivorId: survivingProductId, existingIds: ids, mergedIntoById });
  if (!v.ok) throw new ApiError(422, v.reason ?? "Invalid merge");
  const survivorId = v.terminalSurvivorId!;
  const sourceName = nameById.get(sourceProductId) ?? sourceProductId;
  const survivorName = nameById.get(survivorId) ?? survivorId;
  if (v.alreadyMerged) return { merged: false, alreadyMerged: true, sourceName, survivorName };

  const mergeId = await prisma.$transaction(async (tx) => {
    const impact: MergeImpact = { catalogue: [], eligibleReassignedSchemeIds: [], eligibleDeletedSchemeIds: [], requirementReassignedSchemeIds: [], requirementDeletedSchemes: [] };

    /* -------- 1. Catalogue consolidation (survivor wins) -------- */
    const srcEntries = (await tx.groupProductCatalogue.findMany({ where: { productId: sourceProductId }, select: { groupId: true, price: true, isActive: true, priceIsInitial: true, isClearance: true, clearanceQty: true } })) as
      { groupId: string; price: unknown; isActive: boolean; priceIsInitial: boolean; isClearance: boolean; clearanceQty: number | null }[];
    const survEntries = (await tx.groupProductCatalogue.findMany({ where: { productId: survivorId }, select: { groupId: true } })) as { groupId: string }[];
    const survGroups = new Set(survEntries.map((e) => e.groupId));
    for (const e of srcEntries) {
      if (survGroups.has(e.groupId)) {
        // BOTH present → survivor entry wins; just hide the source entry.
        impact.catalogue.push({ groupId: e.groupId, action: "deactivateSource", prevSourceActive: e.isActive });
      } else {
        // Only source present → create a survivor entry copying the source's commercial values, then hide source.
        await tx.groupProductCatalogue.create({ data: { groupId: e.groupId, productId: survivorId, price: e.price as number, isActive: e.isActive, priceIsInitial: e.priceIsInitial, isClearance: e.isClearance, clearanceQty: e.clearanceQty } });
        impact.catalogue.push({ groupId: e.groupId, action: "createSurvivorFromSource", prevSourceActive: e.isActive });
      }
      await tx.groupProductCatalogue.update({ where: { groupId_productId: { groupId: e.groupId, productId: sourceProductId } }, data: { isActive: false } });
    }

    /* -------- 2. Scheme config reassign + dedupe (conflicts abort) -------- */
    const srcElig = (await tx.schemeEligibleProduct.findMany({ where: { productId: sourceProductId }, select: { id: true, schemeId: true } })) as { id: string; schemeId: string }[];
    const survEligSchemes = new Set(((await tx.schemeEligibleProduct.findMany({ where: { productId: survivorId }, select: { schemeId: true } })) as { schemeId: string }[]).map((r) => r.schemeId));
    for (const r of srcElig) {
      if (survEligSchemes.has(r.schemeId)) { await tx.schemeEligibleProduct.delete({ where: { id: r.id } }); impact.eligibleDeletedSchemeIds.push(r.schemeId); }
      else { await tx.schemeEligibleProduct.update({ where: { id: r.id }, data: { productId: survivorId } }); impact.eligibleReassignedSchemeIds.push(r.schemeId); survEligSchemes.add(r.schemeId); }
    }

    const srcReq = (await tx.schemeRequirementProduct.findMany({ where: { productId: sourceProductId }, select: { id: true, schemeId: true, requiredQty: true, requiredValue: true, scheme: { select: { schemeName: true } } } })) as
      { id: string; schemeId: string; requiredQty: unknown; requiredValue: unknown; scheme: { schemeName: string } }[];
    const survReq = (await tx.schemeRequirementProduct.findMany({ where: { productId: survivorId }, select: { schemeId: true, requiredQty: true, requiredValue: true } })) as { schemeId: string; requiredQty: unknown; requiredValue: unknown }[];
    const survReqByScheme = new Map(survReq.map((r) => [r.schemeId, r] as const));
    const conflicts: string[] = [];
    for (const r of srcReq) {
      const s = survReqByScheme.get(r.schemeId);
      if (!s) { await tx.schemeRequirementProduct.update({ where: { id: r.id }, data: { productId: survivorId } }); impact.requirementReassignedSchemeIds.push(r.schemeId); continue; }
      if (num(s.requiredQty) === num(r.requiredQty) && num(s.requiredValue) === num(r.requiredValue)) {
        await tx.schemeRequirementProduct.delete({ where: { id: r.id } });
        impact.requirementDeletedSchemes.push({ schemeId: r.schemeId, requiredQty: r.requiredQty == null ? null : num(r.requiredQty), requiredValue: r.requiredValue == null ? null : num(r.requiredValue) });
      } else {
        conflicts.push(r.scheme.schemeName); // genuine differing requirement — do not choose arbitrarily
      }
    }
    if (conflicts.length > 0) {
      throw new ApiError(409, `Cannot merge: ${sourceName} and ${survivorName} have DIFFERENT required qty/value in scheme(s): ${[...new Set(conflicts)].join(", ")}. Resolve the scheme requirement first.`);
    }

    /* -------- 3. Deactivate + point the source product at the survivor -------- */
    await tx.product.update({ where: { id: sourceProductId }, data: { isActive: false, mergedIntoId: survivorId, mergedAt: new Date(), mergedById: ctx.userId } });

    /* -------- 4. Auditable, reversible ProductMerge row -------- */
    const rec = (await tx.productMerge.create({ data: { sourceProductId, survivingProductId: survivorId, performedById: ctx.userId, catalogueImpact: JSON.stringify(impact), note: note?.trim() || null }, select: { id: true } })) as { id: string };

    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "product", entityId: sourceProductId, summary: `Merged product "${sourceName}" into "${survivorName}" (${impact.catalogue.length} catalogue group(s))` }, tx);
    return rec.id;
  });

  return { merged: true, alreadyMerged: false, sourceName, survivorName, mergeId };
}

const unmergeSchema = z.object({ sourceProductId: z.string().min(1) });

/**
 * Reverse a merge. Transactional. Restores the source product (reactivate + clear mergedIntoId), reverses the
 * catalogue consolidation exactly (reactivate hidden source entries to their PREVIOUS active state; delete the
 * survivor entries the merge created), and reverses the scheme reassign/dedupe from the stored impact. Never
 * creates duplicate catalogue rows and never touches historical plan/sale data.
 */
export async function unmergeProduct(ctx: AuthContext, raw: unknown): Promise<{ ok: true; sourceName: string }> {
  assertAdmin(ctx);
  const { sourceProductId } = unmergeSchema.parse(raw);
  const product = (await prisma.product.findUnique({ where: { id: sourceProductId }, select: { id: true, name: true, mergedIntoId: true } })) as { id: string; name: string; mergedIntoId: string | null } | null;
  if (!product) throw new ApiError(404, "Product not found");
  if (product.mergedIntoId == null) throw new ApiError(422, "This product is not merged.");
  const survivorId = product.mergedIntoId;

  const rec = (await prisma.productMerge.findFirst({ where: { sourceProductId, survivingProductId: survivorId, reversedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, catalogueImpact: true } })) as { id: string; catalogueImpact: string | null } | null;
  const impact: MergeImpact = rec?.catalogueImpact ? (JSON.parse(rec.catalogueImpact) as MergeImpact) : { catalogue: [], eligibleReassignedSchemeIds: [], eligibleDeletedSchemeIds: [], requirementReassignedSchemeIds: [], requirementDeletedSchemes: [] };

  await prisma.$transaction(async (tx) => {
    /* -------- Catalogue reversal -------- */
    for (const c of impact.catalogue) {
      if (c.action === "createSurvivorFromSource") {
        // Remove the survivor entry the merge created (if still present).
        await tx.groupProductCatalogue.deleteMany({ where: { groupId: c.groupId, productId: survivorId } });
      }
      // Restore the source entry to its previous active state.
      await tx.groupProductCatalogue.updateMany({ where: { groupId: c.groupId, productId: sourceProductId }, data: { isActive: c.prevSourceActive } });
    }

    /* -------- Scheme config reversal -------- */
    for (const schemeId of impact.eligibleReassignedSchemeIds) {
      await tx.schemeEligibleProduct.updateMany({ where: { schemeId, productId: survivorId }, data: { productId: sourceProductId } });
    }
    for (const schemeId of impact.eligibleDeletedSchemeIds) {
      const exists = await tx.schemeEligibleProduct.findFirst({ where: { schemeId, productId: sourceProductId }, select: { id: true } });
      if (!exists) await tx.schemeEligibleProduct.create({ data: { schemeId, productId: sourceProductId } });
    }
    for (const schemeId of impact.requirementReassignedSchemeIds) {
      await tx.schemeRequirementProduct.updateMany({ where: { schemeId, productId: survivorId }, data: { productId: sourceProductId } });
    }
    for (const d of impact.requirementDeletedSchemes) {
      const exists = await tx.schemeRequirementProduct.findFirst({ where: { schemeId: d.schemeId, productId: sourceProductId }, select: { id: true } });
      if (!exists) await tx.schemeRequirementProduct.create({ data: { schemeId: d.schemeId, productId: sourceProductId, requiredQty: d.requiredQty, requiredValue: d.requiredValue } });
    }

    /* -------- Restore the source product + close the merge record -------- */
    await tx.product.update({ where: { id: sourceProductId }, data: { isActive: true, mergedIntoId: null, mergedAt: null, mergedById: null } });
    if (rec) await tx.productMerge.update({ where: { id: rec.id }, data: { reversedAt: new Date(), reversedById: ctx.userId } });
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "product", entityId: sourceProductId, summary: `Reversed merge of "${product.name}"` }, tx);
  });

  return { ok: true, sourceName: product.name };
}

export interface ProductMergeRow { id: string; sourceProductId: string; sourceName: string; survivingProductId: string; survivorName: string; performedByName: string; note: string | null; reversedAt: string | null; createdAt: string }

/** Recent merges (auditable history) — Super Admin only. Shows active + reversed. */
export async function listProductMerges(ctx: AuthContext): Promise<ProductMergeRow[]> {
  assertAdmin(ctx);
  const rows = (await prisma.productMerge.findMany({ orderBy: { createdAt: "desc" }, take: 100 })) as
    { id: string; sourceProductId: string; survivingProductId: string; performedById: string; note: string | null; reversedAt: Date | null; createdAt: Date }[];
  const ids = [...new Set(rows.flatMap((r) => [r.sourceProductId, r.survivingProductId, r.performedById]))];
  const [products, users] = (await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ])) as [{ id: string; name: string }[], { id: string; name: string }[]];
  const pName = new Map(products.map((p) => [p.id, p.name]));
  const uName = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    sourceProductId: r.sourceProductId, sourceName: pName.get(r.sourceProductId) ?? r.sourceProductId,
    survivingProductId: r.survivingProductId, survivorName: pName.get(r.survivingProductId) ?? r.survivingProductId,
    performedByName: uName.get(r.performedById) ?? "—", note: r.note,
    reversedAt: r.reversedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  }));
}

// terminalSurvivor re-exported for callers that fold read-time aggregation without re-deriving the map.
export { terminalSurvivor };

/**
 * Lightweight map (productId → mergedIntoId) for READ-TIME aggregation. Read paths fold a fact's productId to
 * its terminal survivor before grouping, so merged sources roll up into the survivor without any historical
 * data being rewritten. Returns an empty-ish map when no merges exist (zero-cost, behaviour unchanged).
 */
export async function loadProductMergeMap(): Promise<Map<string, string | null>> {
  const rows = (await prisma.product.findMany({ where: { mergedIntoId: { not: null } }, select: { id: true, mergedIntoId: true } })) as { id: string; mergedIntoId: string | null }[];
  return new Map<string, string | null>(rows.map((r) => [r.id, r.mergedIntoId]));
}

export interface EffectiveProductMeta { name: string; technicalName: string | null; rate: number; nbvPercent: number }
export interface EffectiveProductResolver {
  /** The operational product id for any (possibly merged) product id — terminal survivor. */
  effId: (productId: string) => string;
  /** Survivor product meta (name/technicalName/rate/nbvPercent) for id — for aggregators that relabel rows. */
  meta: (productId: string) => EffectiveProductMeta | null;
  /** True when at least one merge exists (callers can short-circuit to their original behaviour otherwise). */
  hasMerges: boolean;
}

/**
 * The ONE reusable server-side effective-product resolver for READ aggregation. `effId(productId)` maps a
 * merged source to its surviving product; `meta(id)` gives the survivor's display fields so a folded row
 * shows the survivor's name/NBV. Zero DB cost beyond the merge map when no merges exist.
 */
export async function loadEffectiveProduct(): Promise<EffectiveProductResolver> {
  const map = await loadProductMergeMap();
  if (map.size === 0) return { effId: (id) => id, meta: () => null, hasMerges: false };
  const metas = (await prisma.product.findMany({ select: { id: true, name: true, technicalName: true, rate: true, nbvPercent: true } })) as { id: string; name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown }[];
  const metaById = new Map<string, EffectiveProductMeta>(metas.map((m) => [m.id, { name: m.name, technicalName: m.technicalName, rate: num(m.rate), nbvPercent: num(m.nbvPercent) }]));
  return { effId: (id) => terminalSurvivor(id, map), meta: (id) => metaById.get(id) ?? null, hasMerges: true };
}
