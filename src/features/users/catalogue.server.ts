import "server-only";
import * as XLSX from "xlsx";
import { z } from "zod";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { writeAudit } from "@/lib/audit";
import { categoryIdForNbv } from "@/features/products/categories.server";

/**
 * Group-wise Product Catalogue (Users → Group → Product Catalogue). A per-(group, product) overlay on the
 * Master Product: group availability, group price, and active/inactive — WITHOUT duplicating products. The
 * Master Product stays the single identity. Plans snapshot the price they use, so editing a group price
 * never rewrites historical plans (see PlanLine.rateSnapshot). Super-Admin managed.
 */

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can manage a group's product catalogue");
}

/** A Prisma client or an interactive transaction client — the seeders call this inside a tx. */
type PrismaLike = typeof prisma;

export interface PlanningProduct {
  productId: string;
  rate: number; // group catalogue price (or Master price on fallback) — SNAPSHOTTED onto the plan line
  nbvPercent: number; // NBV% stays on the Master
  isClearance?: boolean; // group-specific clearance flag (display-only)
  clearanceQty?: number | null;
}

/**
 * The products to seed into an officer's new plan lines: the officer's group's ACTIVE catalogue products
 * priced at the GROUP price. Falls back to ALL active Master products at the Master price when the officer
 * has no group, or the group has no catalogue yet — so planning never breaks before catalogues exist. The
 * returned `rate`/`nbvPercent` are written into PlanLine.rateSnapshot/nbvPercentSnapshot at creation.
 */
export async function planningProductsForOfficer(officerId: string, db: PrismaLike = prisma): Promise<PlanningProduct[]> {
  const officer = (await db.user.findUnique({ where: { id: officerId }, select: { groupId: true } })) as { groupId: string | null } | null;
  const groupId = officer?.groupId ?? null;
  if (groupId) {
    const entries = (await db.groupProductCatalogue.findMany({
      where: { groupId, isActive: true, product: { isActive: true } },
      select: { productId: true, price: true, isClearance: true, clearanceQty: true, product: { select: { nbvPercent: true } } },
    })) as { productId: string; price: unknown; isClearance: boolean; clearanceQty: number | null; product: { nbvPercent: unknown } }[];
    if (entries.length > 0) {
      return entries.map((e) => ({ productId: e.productId, rate: num(e.price), nbvPercent: num(e.product.nbvPercent), isClearance: e.isClearance, clearanceQty: e.clearanceQty }));
    }
  }
  const master = (await db.product.findMany({ where: { isActive: true }, select: { id: true, rate: true, nbvPercent: true } })) as { id: string; rate: unknown; nbvPercent: unknown }[];
  return master.map((p) => ({ productId: p.id, rate: num(p.rate), nbvPercent: num(p.nbvPercent) }));
}

/** The group catalogue price + NBV% for ONE product for an officer's group (for adding a single line),
 *  or null if the officer's group has no active catalogue entry for it. Falls back to Master when the
 *  officer has no group / no catalogue at all. */
export async function catalogueEntryForOfficerProduct(officerId: string, productId: string, db: PrismaLike = prisma): Promise<PlanningProduct | null> {
  const officer = (await db.user.findUnique({ where: { id: officerId }, select: { groupId: true } })) as { groupId: string | null } | null;
  const groupId = officer?.groupId ?? null;
  if (groupId) {
    const anyEntry = await db.groupProductCatalogue.findFirst({ where: { groupId }, select: { id: true } });
    if (anyEntry) {
      const e = (await db.groupProductCatalogue.findUnique({
        where: { groupId_productId: { groupId, productId } },
        select: { price: true, isActive: true, isClearance: true, clearanceQty: true, product: { select: { nbvPercent: true, isActive: true } } },
      })) as { price: unknown; isActive: boolean; isClearance: boolean; clearanceQty: number | null; product: { nbvPercent: unknown; isActive: boolean } } | null;
      if (!e || !e.isActive || !e.product.isActive) return null; // not available in this group
      return { productId, rate: num(e.price), nbvPercent: num(e.product.nbvPercent), isClearance: e.isClearance, clearanceQty: e.clearanceQty };
    }
  }
  const p = (await db.product.findUnique({ where: { id: productId }, select: { rate: true, nbvPercent: true, isActive: true } })) as { rate: unknown; nbvPercent: unknown; isActive: boolean } | null;
  if (!p || !p.isActive) return null;
  return { productId, rate: num(p.rate), nbvPercent: num(p.nbvPercent) };
}
function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

export interface ClearanceInfo { clearanceQty: number | null }

/**
 * The clearance products for ONE group as a Map(productId → { clearanceQty }). Clearance is ALWAYS
 * looked up by groupId + productId (never productId alone) — a product can be clearance in CG and normal
 * in MP. Used to tag products wherever they appear in planning. Display-only; never affects calculations.
 */
export async function clearanceMapForGroup(groupId: string | null | undefined, db: PrismaLike = prisma): Promise<Map<string, ClearanceInfo>> {
  const map = new Map<string, ClearanceInfo>();
  if (!groupId) return map;
  const rows = (await db.groupProductCatalogue.findMany({
    where: { groupId, isClearance: true },
    select: { productId: true, clearanceQty: true },
  })) as { productId: string; clearanceQty: number | null }[];
  for (const r of rows) map.set(r.productId, { clearanceQty: r.clearanceQty });
  return map;
}

/**
 * Actual sold quantity of the given products across THIS group's plans (by groupId + productId, never
 * cross-group). Sales come from MonthlyEntry.saleQty (Sales Upload). Used to derive remaining clearance qty.
 */
export async function clearanceSoldForGroup(groupId: string | null | undefined, productIds: string[], db: PrismaLike = prisma): Promise<Map<string, number>> {
  const sold = new Map<string, number>();
  if (!groupId || productIds.length === 0) return sold;
  const rows = (await db.monthlyEntry.findMany({
    where: { planLine: { productId: { in: productIds }, planDealer: { seasonPlan: { officer: { groupId }, lifecycleState: "ACTIVE" } } } },
    select: { saleQty: true, planLine: { select: { productId: true } } },
  })) as { saleQty: number; planLine: { productId: string } }[];
  for (const r of rows) sold.set(r.planLine.productId, (sold.get(r.planLine.productId) ?? 0) + r.saleQty);
  return sold;
}
async function loadGroupOr404(groupId: string) {
  const g = await prisma.userGroup.findUnique({ where: { id: groupId }, select: { id: true, name: true } });
  if (!g) throw new ApiError(404, "Group not found");
  return g as { id: string; name: string };
}

export interface CatalogueRow {
  productId: string;
  name: string;
  technicalName: string | null;
  nbvPercent: number; // from the Master — drives the Category badge/filter (display-only)
  masterPrice: number;
  masterActive: boolean;
  groupPrice: number;
  isActive: boolean;
  priceIsInitial: boolean;
  isClearance: boolean;
  clearanceQty: number | null; // the initial clearance target
  clearanceSold: number; // actual sales of this product across THIS group's plans (derived)
  clearanceRemaining: number | null; // clearanceQty − clearanceSold (null when no target set)
}

/** The group's catalogue with summary cards + Master price for comparison. */
export async function listGroupCatalogue(ctx: AuthContext, groupId: string) {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const entries = (await prisma.groupProductCatalogue.findMany({
    where: { groupId },
    include: { product: { select: { name: true, technicalName: true, rate: true, nbvPercent: true, isActive: true } } },
    orderBy: { product: { name: "asc" } },
  })) as {
    productId: string; price: unknown; isActive: boolean; priceIsInitial: boolean; isClearance: boolean; clearanceQty: number | null;
    product: { name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown; isActive: boolean };
  }[];

  const rows: CatalogueRow[] = entries.map((e) => ({
    productId: e.productId,
    name: e.product.name,
    technicalName: e.product.technicalName,
    nbvPercent: num(e.product.nbvPercent),
    masterPrice: num(e.product.rate),
    masterActive: e.product.isActive,
    groupPrice: num(e.price),
    isActive: e.isActive,
    priceIsInitial: e.priceIsInitial,
    isClearance: e.isClearance,
    clearanceQty: e.clearanceQty,
    clearanceSold: 0,
    clearanceRemaining: e.clearanceQty,
  }));

  // Remaining clearance qty = clearance target − ACTUAL sold of this product across THIS group's plans.
  // (Sales come from MonthlyEntry.saleQty written by Sales Upload — the single source of actual sales.)
  const clearanceIds = rows.filter((r) => r.isClearance).map((r) => r.productId);
  if (clearanceIds.length > 0) {
    const soldRows = (await prisma.monthlyEntry.findMany({
      where: { planLine: { productId: { in: clearanceIds }, planDealer: { seasonPlan: { officer: { groupId }, lifecycleState: "ACTIVE" } } } },
      select: { saleQty: true, planLine: { select: { productId: true } } },
    })) as { saleQty: number; planLine: { productId: string } }[];
    const soldByProduct = new Map<string, number>();
    for (const s of soldRows) soldByProduct.set(s.planLine.productId, (soldByProduct.get(s.planLine.productId) ?? 0) + s.saleQty);
    for (const r of rows) {
      if (!r.isClearance) continue;
      r.clearanceSold = soldByProduct.get(r.productId) ?? 0;
      r.clearanceRemaining = r.clearanceQty != null ? Math.max(0, r.clearanceQty - r.clearanceSold) : null;
    }
  }

  const summary = {
    total: rows.length,
    active: rows.filter((r) => r.isActive).length,
    inactive: rows.filter((r) => !r.isActive).length,
    usingInitialPrice: rows.filter((r) => r.priceIsInitial).length,
    clearance: rows.filter((r) => r.isClearance).length,
  };
  // Active Master products NOT yet in this group's catalogue — the "Add Product" candidates.
  const inCatalogue = new Set(rows.map((r) => r.productId));
  const master = (await prisma.product.findMany({
    where: { isActive: true },
    select: { id: true, name: true, rate: true },
    orderBy: { name: "asc" },
  })) as { id: string; name: string; rate: unknown }[];
  const addable = master.filter((m) => !inCatalogue.has(m.id)).map((m) => ({ productId: m.id, name: m.name, masterPrice: num(m.rate) }));

  return { groupId: group.id, groupName: group.name, summary, rows, addable };
}

/** Initialize (or top-up) the group's catalogue from all active Master products. Idempotent — existing
 *  entries are left untouched; only missing products are added at the current Master price. */
export async function initializeFromMaster(ctx: AuthContext, groupId: string) {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const [master, existing] = (await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, rate: true } }),
    prisma.groupProductCatalogue.findMany({ where: { groupId }, select: { productId: true } }),
  ])) as [{ id: string; rate: unknown }[], { productId: string }[]];
  const have = new Set(existing.map((e) => e.productId));
  const toCreate = master.filter((m) => !have.has(m.id));
  if (toCreate.length > 0) {
    await prisma.groupProductCatalogue.createMany({
      data: toCreate.map((m) => ({ groupId, productId: m.id, price: m.rate, isActive: true, priceIsInitial: true })),
    });
  }
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "groupProductCatalogue", entityId: groupId, summary: `Initialized ${group.name} catalogue from Master (${toCreate.length} added)` });
  return { added: toCreate.length, alreadyPresent: have.size };
}

const updateSchema = z.object({
  price: z.coerce.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

/** Update a group catalogue entry's price and/or active status. Editing the price clears the
 *  "initial Master price" flag. Products are never deleted — only deactivated. */
export async function updateCatalogueEntry(ctx: AuthContext, groupId: string, productId: string, raw: unknown) {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const data = updateSchema.parse(raw);
  const entry = (await prisma.groupProductCatalogue.findUnique({
    where: { groupId_productId: { groupId, productId } },
    select: { id: true, price: true },
  })) as { id: string; price: unknown } | null;
  if (!entry) throw new ApiError(404, "Product is not in this group's catalogue");

  // A price change NO LONGER auto-propagates to existing plans. New plans always snapshot the latest price
  // at creation; existing plans stay frozen until the admin EXPLICITLY applies a refresh (refreshPriceImpact
  // / applyPriceRefresh). We only report whether the price changed so the UI can offer that modal.
  const priceChanged = data.price !== undefined && num(entry.price) !== data.price;
  const patch: Record<string, unknown> = {};
  if (data.price !== undefined) {
    patch.price = data.price;
    patch.priceIsInitial = false; // an admin-set price is no longer the copied Master price
  }
  if (data.isActive !== undefined) patch.isActive = data.isActive;
  if (Object.keys(patch).length === 0) return { ok: true, priceChanged: false };

  await prisma.groupProductCatalogue.update({ where: { groupId_productId: { groupId, productId } }, data: patch });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "groupProductCatalogue", entityId: productId, summary: `Updated ${group.name} catalogue entry${priceChanged ? " (price changed)" : ""}` });
  return { ok: true, priceChanged };
}

/* ------------------------ Clearance products (per group) ------------------ */

const clearanceSchema = z.object({
  productIds: z.array(z.string().min(1)).min(1),
  clearanceQty: z.coerce.number().int().min(0).nullable().optional(),
});

/** Mark products as clearance for THIS group (with an optional clearance quantity). Group-specific. */
export async function setClearance(ctx: AuthContext, groupId: string, raw: unknown) {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const { productIds, clearanceQty } = clearanceSchema.parse(raw);
  await prisma.groupProductCatalogue.updateMany({
    where: { groupId, productId: { in: productIds } },
    data: { isClearance: true, clearanceQty: clearanceQty ?? null },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "groupProductCatalogue", entityId: groupId, summary: `Marked ${productIds.length} product(s) as clearance in ${group.name}` });
  return { ok: true };
}

/** Remove the clearance flag/quantity for products in THIS group. */
export async function removeClearance(ctx: AuthContext, groupId: string, raw: unknown) {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const { productIds } = z.object({ productIds: z.array(z.string().min(1)).min(1) }).parse(raw);
  await prisma.groupProductCatalogue.updateMany({
    where: { groupId, productId: { in: productIds } },
    data: { isClearance: false, clearanceQty: null },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "groupProductCatalogue", entityId: groupId, summary: `Removed clearance from ${productIds.length} product(s) in ${group.name}` });
  return { ok: true };
}

/* ---------------------- Explicit price refresh system --------------------- */

export interface PriceRefreshImpact {
  groupId: string;
  groupName: string;
  productId: string;
  currentPrice: number;
  draft: number; // editable Draft plans that would refresh
  returned: number; // Returned plans (editable) that would refresh
  submitted: number; // Submitted plans (protected unless selected)
  approvedSeasons: { seasonId: string; seasonName: string; count: number }[]; // Approved, grouped by season
}

/** How many plans in this group use this product, by status (Approved grouped by season). Nothing is
 *  changed — this powers the "Price Update Impact" modal. */
export async function refreshPriceImpact(ctx: AuthContext, groupId: string, productId: string): Promise<PriceRefreshImpact> {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const entry = (await prisma.groupProductCatalogue.findUnique({ where: { groupId_productId: { groupId, productId } }, select: { price: true } })) as { price: unknown } | null;
  if (!entry) throw new ApiError(404, "Product is not in this group's catalogue");

  const plans = (await prisma.seasonPlan.findMany({
    where: { officer: { groupId }, dealers: { some: { lines: { some: { productId } } } }, lifecycleState: "ACTIVE" },
    select: { status: true, seasonId: true, season: { select: { name: true, year: true } } },
  })) as { status: PlanStatus; seasonId: string; season: { name: string; year: number } }[];

  const approvedBySeason = new Map<string, { seasonName: string; count: number }>();
  for (const p of plans) {
    if (p.status !== PlanStatus.APPROVED) continue;
    const cur = approvedBySeason.get(p.seasonId) ?? { seasonName: `${p.season.name} ${p.season.year}`, count: 0 };
    cur.count += 1;
    approvedBySeason.set(p.seasonId, cur);
  }
  return {
    groupId: group.id,
    groupName: group.name,
    productId,
    currentPrice: num(entry.price),
    draft: plans.filter((p) => p.status === PlanStatus.DRAFT).length,
    returned: plans.filter((p) => p.status === PlanStatus.RETURNED).length,
    submitted: plans.filter((p) => p.status === PlanStatus.PENDING_RM || p.status === PlanStatus.PENDING_ADMIN).length,
    approvedSeasons: [...approvedBySeason.entries()].map(([seasonId, v]) => ({ seasonId, seasonName: v.seasonName, count: v.count })).sort((a, b) => a.seasonName.localeCompare(b.seasonName)),
  };
}

const applyRefreshSchema = z.object({
  draft: z.boolean().optional(),
  submitted: z.boolean().optional(),
  approved: z.boolean().optional(),
  seasonIds: z.array(z.string()).optional(), // approved seasons to include
});

/** Apply the CURRENT group price to the admin-selected plan sets (writes rateSnapshot). Approved plans
 *  update ONLY for the explicitly-selected seasons. Never touches other groups. */
export async function applyPriceRefresh(ctx: AuthContext, groupId: string, productId: string, raw: unknown) {
  assertAdmin(ctx);
  await loadGroupOr404(groupId);
  const sel = applyRefreshSchema.parse(raw);
  const entry = (await prisma.groupProductCatalogue.findUnique({ where: { groupId_productId: { groupId, productId } }, select: { price: true } })) as { price: unknown } | null;
  if (!entry) throw new ApiError(404, "Product is not in this group's catalogue");
  const price = num(entry.price);

  // Draft + Returned are the editable buckets; Submitted is protected-unless-selected; Approved only for
  // the chosen seasons. Build the seasonPlan status/season filter explicitly.
  const statusFilters: unknown[] = [];
  if (sel.draft) statusFilters.push({ status: { in: [PlanStatus.DRAFT, PlanStatus.RETURNED] } });
  if (sel.submitted) statusFilters.push({ status: { in: [PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN] } });
  if (sel.approved && sel.seasonIds && sel.seasonIds.length > 0) statusFilters.push({ status: PlanStatus.APPROVED, seasonId: { in: sel.seasonIds } });
  if (statusFilters.length === 0) return { updatedLines: 0 };

  const res = (await prisma.planLine.updateMany({
    where: { productId, planDealer: { seasonPlan: { officer: { groupId }, OR: statusFilters } } },
    data: { rateSnapshot: price },
  })) as { count: number };
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "groupProductCatalogue", entityId: productId, summary: `Applied price refresh to ${res.count} plan line(s) in one group` });
  return { updatedLines: res.count };
}

const addSchema = z.object({
  productId: z.string().min(1),
  price: z.coerce.number().min(0).optional(), // defaults to the Master price
});

/** Add an EXISTING Master product to the group's catalogue (no product duplication). */
export async function addCatalogueProduct(ctx: AuthContext, groupId: string, raw: unknown) {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const data = addSchema.parse(raw);
  const product = (await prisma.product.findUnique({ where: { id: data.productId }, select: { id: true, name: true, rate: true } })) as
    | { id: string; name: string; rate: unknown }
    | null;
  if (!product) throw new ApiError(404, "Master product not found");
  const clash = await prisma.groupProductCatalogue.findUnique({ where: { groupId_productId: { groupId, productId: product.id } }, select: { id: true } });
  if (clash) throw new ApiError(409, "That product is already in this group's catalogue");

  const price = data.price ?? num(product.rate);
  await prisma.groupProductCatalogue.create({
    data: { groupId, productId: product.id, price, isActive: true, priceIsInitial: data.price === undefined },
  });
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "groupProductCatalogue", entityId: product.id, summary: `Added ${product.name} to ${group.name} catalogue` });
  return { ok: true };
}

/* -------------------- Master view: product → available groups ------------- */

export interface ProductGroupsRow {
  productId: string;
  name: string;
  masterPrice: number;
  masterActive: boolean;
  groups: { groupId: string; groupName: string; price: number; isActive: boolean }[];
}

/** Every Master product with its group availability (relationship view, not per-group columns). Super
 *  Admin only. Powers the "Available Groups" section of the Master Product view. */
export async function productGroupOverview(ctx: AuthContext): Promise<ProductGroupsRow[]> {
  assertAdmin(ctx);
  const products = (await prisma.product.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, rate: true, isActive: true,
      groupCatalogues: { select: { groupId: true, price: true, isActive: true, group: { select: { name: true } } } },
    },
  })) as {
    id: string; name: string; rate: unknown; isActive: boolean;
    groupCatalogues: { groupId: string; price: unknown; isActive: boolean; group: { name: string } }[];
  }[];
  return products.map((p) => ({
    productId: p.id,
    name: p.name,
    masterPrice: num(p.rate),
    masterActive: p.isActive,
    groups: p.groupCatalogues
      .map((g) => ({ groupId: g.groupId, groupName: g.group.name, price: num(g.price), isActive: g.isActive }))
      .sort((a, b) => a.groupName.localeCompare(b.groupName)),
  }));
}

/* --------------------- Product Master (global + group prices) -------------- */

export interface ProductMasterRow {
  productId: string;
  name: string;
  technicalName: string | null;
  masterPrice: number;
  nbvPercent: number;
  isActive: boolean;
  categoryId: string | null;
  brandId: string | null;
  // groupId -> group price entry (present only where the product is in that group's catalogue).
  groupPrices: Record<string, { price: number; isActive: boolean; isClearance: boolean; clearanceQty: number | null }>;
}

/** Product Master with EVERY group's price for each product (dynamic — new groups appear automatically),
 *  plus the group list (for dynamic columns) and category/brand options (for the edit form). */
export async function listProductMaster(ctx: AuthContext) {
  assertAdmin(ctx);
  const [products, groups, categories, brands] = (await Promise.all([
    prisma.product.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, technicalName: true, rate: true, nbvPercent: true, isActive: true, categoryId: true, brandId: true,
        groupCatalogues: { select: { groupId: true, price: true, isActive: true, isClearance: true, clearanceQty: true } },
      },
    }),
    prisma.userGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.category.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ])) as [
    { id: string; name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown; isActive: boolean; categoryId: string | null; brandId: string | null;
      groupCatalogues: { groupId: string; price: unknown; isActive: boolean; isClearance: boolean; clearanceQty: number | null }[] }[],
    { id: string; name: string }[], { id: string; name: string }[], { id: string; name: string }[],
  ];

  const rows: ProductMasterRow[] = products.map((p) => ({
    productId: p.id,
    name: p.name,
    technicalName: p.technicalName,
    masterPrice: num(p.rate),
    nbvPercent: num(p.nbvPercent),
    isActive: p.isActive,
    categoryId: p.categoryId,
    brandId: p.brandId,
    groupPrices: Object.fromEntries(p.groupCatalogues.map((g) => [g.groupId, { price: num(g.price), isActive: g.isActive, isClearance: g.isClearance, clearanceQty: g.clearanceQty }])),
  }));
  return { groups, categories, brands, products: rows };
}

const productMasterUpdateSchema = z.object({
  name: z.string().min(1).max(200),
  technicalName: z.string().max(200).optional().nullable(),
  categoryId: z.string().optional().nullable(),
  brandId: z.string().optional().nullable(),
  nbvPercent: z.coerce.number().min(0),
  masterPrice: z.coerce.number().min(0),
  // groupId -> group price. Upserts the group catalogue entry (never writes Product.rate).
  groupPrices: z.record(z.string(), z.coerce.number().min(0)).optional(),
});

/** Edit a product's Master info + Master price, AND per-group prices. Group prices write ONLY to
 *  GroupProductCatalogue.price (upsert); the Master price writes Product.rate (fallback/default). */
export async function updateProductMaster(ctx: AuthContext, productId: string, raw: unknown) {
  assertAdmin(ctx);
  const data = productMasterUpdateSchema.parse(raw);
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true } });
  if (!product) throw new ApiError(404, "Product not found");

  // Category is auto-derived from NBV% (no manual mapping); brandId is left untouched here.
  const categoryId = await categoryIdForNbv(data.nbvPercent);
  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        name: data.name.trim(),
        technicalName: data.technicalName?.trim() || null,
        categoryId,
        nbvPercent: data.nbvPercent,
        rate: data.masterPrice, // Master price = fallback/default only
      },
    });
    for (const [groupId, price] of Object.entries(data.groupPrices ?? {})) {
      // Upsert the group price WITHOUT touching Product.rate. Creating an entry makes the product
      // available in that group at the given price (priceIsInitial=false since it was set explicitly).
      await tx.groupProductCatalogue.upsert({
        where: { groupId_productId: { groupId, productId } },
        create: { groupId, productId, price, isActive: true, priceIsInitial: false },
        update: { price, priceIsInitial: false },
      });
    }
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "product", entityId: productId, summary: `Edited product ${data.name} (master + group prices)` });
  return { ok: true };
}

/* --------------------------------- Excel ---------------------------------- */

/** Download the group's catalogue as an .xlsx. Columns (NO internal Product ID exposed):
 *  Product Name, Technical Name, Master Price, Group Price, Status. */
export async function buildCatalogueWorkbook(ctx: AuthContext, groupId: string): Promise<{ buffer: Buffer; filename: string }> {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const { rows } = await listGroupCatalogue(ctx, groupId);
  const data: (string | number)[][] = [
    ["Product Name", "Technical Name", "Master Price", "Group Price", "Status"],
    ...rows.map((r) => [r.name, r.technicalName ?? "", r.masterPrice, r.groupPrice, r.isActive ? "Active" : "Inactive"]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "State Catalogue");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return { buffer, filename: `${group.name}_Product_Catalogue.xlsx` };
}

export interface CatalogueUploadResult {
  updated: number; // CASE 1 — already in this group
  added: number; // CASE 2 — in Master, added to this group
  createdMaster: number; // CASE 3 — created Master + entry (only when confirmed)
  needsMaster: string[]; // CASE 3 candidates awaiting confirmation (not created this pass)
  skipped: number;
  errors: string[];
}

const HEADER = /^(product\s*name|technical\s*name|master\s*price|group\s*price|status)$/i;
const truthyActive = (v: string) => !/^(inactive|no|false|0)$/i.test(v.trim());

/**
 * Upload a catalogue workbook. Columns (NO Product ID): Product Name | Technical Name | Master Price |
 * Group Price | Status. Products are matched by Product Name first, then Technical Name (never by internal id).
 *   CASE 1 product already in this group        → update Group Price + Status.
 *   CASE 2 product in Master, not this group     → add a catalogue entry.
 *   CASE 3 product nowhere                        → only created (Master + entry) when createMissingMaster
 *                                                  is confirmed; otherwise returned in `needsMaster`.
 * Reuses the existing product master + catalogue services — no parallel product system.
 */
export async function importCatalogueExcel(ctx: AuthContext, groupId: string, buffer: Buffer, createMissingMaster = false): Promise<CatalogueUploadResult> {
  assertAdmin(ctx);
  const group = await loadGroupOr404(groupId);
  const wb = readWorkbook(buffer);
  const sheet = sheetNames(wb)[0];
  if (!sheet) throw new ApiError(422, "The workbook has no sheets");
  const rows = sheetRows(wb, sheet);

  const [products, entries] = (await Promise.all([
    prisma.product.findMany({ select: { id: true, name: true, technicalName: true } }),
    prisma.groupProductCatalogue.findMany({ where: { groupId }, select: { productId: true } }),
  ])) as [{ id: string; name: string; technicalName: string | null }[], { productId: string }[]];
  const norm = (s: string) => s.trim().toLowerCase();
  const byName = new Map(products.map((p) => [norm(p.name), p] as const));
  const byTech = new Map(products.filter((p) => p.technicalName).map((p) => [norm(p.technicalName as string), p] as const));
  const inGroup = new Set(entries.map((e) => e.productId));

  const r: CatalogueUploadResult = { updated: 0, added: 0, createdMaster: 0, needsMaster: [], skipped: 0, errors: [] };

  for (const row of rows) {
    const name = String(row[0] ?? "").trim();
    const technicalName = String(row[1] ?? "").trim();
    const masterPrice = Number(String(row[2] ?? "").trim());
    const groupPriceRaw = String(row[3] ?? "").trim();
    const groupPrice = Number(groupPriceRaw);
    const status = String(row[4] ?? "").trim();
    if (!name && !technicalName) continue;
    if (HEADER.test(name)) continue; // header row
    const isActive = status ? truthyActive(status) : true;
    const price = Number.isFinite(groupPrice) && groupPriceRaw ? groupPrice : undefined;

    try {
      // Match by Product Name first, then Technical Name — never by internal id.
      const product = (name && byName.get(norm(name))) || (technicalName && byTech.get(norm(technicalName))) || null;
      if (product) {
        if (inGroup.has(product.id)) {
          // CASE 1 — update price/status.
          const patch: Record<string, unknown> = { isActive };
          if (price !== undefined) { patch.price = price; patch.priceIsInitial = false; }
          await prisma.groupProductCatalogue.update({ where: { groupId_productId: { groupId, productId: product.id } }, data: patch });
          r.updated += 1;
        } else {
          // CASE 2 — add to this group.
          await prisma.groupProductCatalogue.create({ data: { groupId, productId: product.id, price: price ?? 0, isActive, priceIsInitial: price === undefined } });
          inGroup.add(product.id);
          r.added += 1;
        }
      } else {
        // CASE 3 — not in Master.
        if (!createMissingMaster) { r.needsMaster.push(name || technicalName); r.skipped += 1; continue; }
        if (!name) { r.errors.push(`Row "${technicalName}": a Product Name is required to create a new Master product`); continue; }
        const created = (await prisma.product.create({ data: { name, technicalName: technicalName || null, rate: Number.isFinite(masterPrice) ? masterPrice : 0, nbvPercent: 0 }, select: { id: true, name: true, technicalName: true } })) as { id: string; name: string; technicalName: string | null };
        byName.set(norm(created.name), created); if (created.technicalName) byTech.set(norm(created.technicalName), created);
        await prisma.groupProductCatalogue.create({ data: { groupId, productId: created.id, price: price ?? (Number.isFinite(masterPrice) ? masterPrice : 0), isActive, priceIsInitial: price === undefined } });
        inGroup.add(created.id);
        r.createdMaster += 1;
      }
    } catch (e) {
      r.errors.push(`Row "${name || technicalName}": ${(e as Error).message}`);
    }
  }

  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "groupProductCatalogue", entityId: groupId, summary: `${group.name} catalogue Excel: ${r.updated} updated, ${r.added} added, ${r.createdMaster} created, ${r.errors.length} errors` });
  return r;
}
