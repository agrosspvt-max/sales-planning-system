import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { effectiveProceedingSchemeUnits, effectiveProductQuantityTarget } from "@/lib/scheme-plan-quantity";

/**
 * Data access for `DealerSchemeBillProduct` (per-bill, per-product quantities for product-rate billing).
 * Product Quantity Based and Value Based schemes share this snapshot architecture.
 * The rate is snapshotted onto each row at conversion, so later Scheme Master edits never change historical
 * bills. Bill amounts are derived from these rows and written to DealerSchemeBill (the installment base).
 */

/** Whether completion itself is quantity-target based (unchanged existing business rule). */
export function isProductQuantityScheme(structure: string, requirementType: string | null | undefined, optionAchievementType: string | null | undefined): boolean {
  return structure === "MULTIPLE_OPTIONS" ? optionAchievementType === "QUANTITY_BASED" : requirementType === "PRODUCT_BASED";
}

/** Whether bills are derived from product quantities × Scheme Master rates. Value Based schemes join the
 * existing Product Quantity billing infrastructure, but keep monetary target validation. */
export function usesProductRateBilling(structure: string, requirementType: string | null | undefined, optionAchievementType: string | null | undefined): boolean {
  return isProductQuantityScheme(structure, requirementType, optionAchievementType)
    || (structure === "MULTIPLE_OPTIONS" ? optionAchievementType === "VALUE_BASED" : requirementType === "VALUE_BASED");
}

export interface CommittedProduct {
  productId: string;
  name: string;
  committedQty: number | null;
  /** Present only while the target still comes from Scheme Master/the selected-option plan snapshot. */
  perSchemeCommittedQty?: number | null;
  rateWithoutGST: number;
  rateWithGST: number;
  historicalSnapshot?: boolean;
}

const asNum = (v: unknown): number => (v == null ? 0 : Number(v.toString()));

/**
 * The committed products (per-product committed quantity + snapshot rates) for a plan's scheme:
 *   FIXED + PRODUCT_BASED   → each SchemeRequirementProduct (requiredQty + its rate).
 *   OPTIONS + QUANTITY_BASED → the single SchemeEligibleProduct (its rate); committed qty = the plan's
 *                              selected option target (`optionTargetQty`), preserving the option snapshot.
 *   OPTIONS + VALUE_BASED    → every eligible product and its rate; committed qty = null because the selected
 *                              option's frozen monetary values are the target.
 *   FIXED + VALUE_BASED      → every requirement product and its rate; committed qty = null because the
 *                              scheme-level monetary values are the target.
 *
 * When bill-product rows already exist, their snapshotted rates/products are authoritative. This keeps SO
 * edits and Admin verification stable after later Scheme Master product/rate changes.
 */
export async function committedProductsForScheme(
  schemeId: string,
  structure: string,
  optionAchievementType: string | null | undefined,
  requirementType: string | null | undefined,
  optionTargetQty: number | null | undefined,
  proceedingUnits: number,
  planId?: string,
): Promise<CommittedProduct[]> {
  if (!usesProductRateBilling(structure, requirementType, optionAchievementType)) return [];
  if (planId) {
    const snapshots = await prisma.$queryRaw<{ productId: string; name: string; soQty: unknown; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
      SELECT bp."productId", p."name", bp."soQty", bp."rateWithoutGST", bp."rateWithGST"
      FROM "DealerSchemeBillProduct" bp
      JOIN "DealerSchemeBill" b ON b."id" = bp."billId"
      JOIN "Product" p ON p."id" = bp."productId"
      WHERE b."planId" = ${planId}
      ORDER BY b."partNumber" ASC`;
    if (snapshots.length > 0) {
      const grouped = new Map<string, CommittedProduct>();
      for (const row of snapshots) {
        const current = grouped.get(row.productId);
        const quantityTarget = isProductQuantityScheme(structure, requirementType, optionAchievementType);
        grouped.set(row.productId, {
          productId: row.productId,
          name: row.name,
          // Existing bill rows are the historical TOTAL target for this conversion. Sum them for both Fixed
          // and Options so a later Scheme Master/option edit can never change the committed quantity.
          committedQty: !quantityTarget ? null : (current?.committedQty ?? 0) + asNum(row.soQty),
          rateWithoutGST: asNum(row.rateWithoutGST),
          rateWithGST: asNum(row.rateWithGST),
          historicalSnapshot: true,
        });
      }
      return [...grouped.values()];
    }
  }
  if (structure === "MULTIPLE_OPTIONS") {
    const rows = await prisma.$queryRaw<{ productId: string; name: string; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
      SELECT ep."productId", p."name", ep."rateWithoutGST", ep."rateWithGST"
      FROM "SchemeEligibleProduct" ep JOIN "Product" p ON p."id" = ep."productId"
      WHERE ep."schemeId" = ${schemeId} ORDER BY ep."createdAt" ASC`;
    const quantityTarget = optionAchievementType === "QUANTITY_BASED";
    const perScheme = optionTargetQty ?? 0;
    return rows.map((r) => ({ productId: r.productId, name: r.name, committedQty: quantityTarget ? effectiveProductQuantityTarget(perScheme, proceedingUnits) : null, perSchemeCommittedQty: quantityTarget ? perScheme : null, rateWithoutGST: asNum(r.rateWithoutGST), rateWithGST: asNum(r.rateWithGST) }));
  }
  const rows = await prisma.$queryRaw<{ productId: string; name: string; requiredQty: unknown; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
    SELECT rp."productId", p."name", rp."requiredQty", rp."rateWithoutGST", rp."rateWithGST"
    FROM "SchemeRequirementProduct" rp JOIN "Product" p ON p."id" = rp."productId" WHERE rp."schemeId" = ${schemeId} ORDER BY rp."createdAt" ASC`;
  const quantityTarget = requirementType === "PRODUCT_BASED";
  return rows.map((r) => { const perScheme = asNum(r.requiredQty); return { productId: r.productId, name: r.name, committedQty: quantityTarget ? effectiveProductQuantityTarget(perScheme, proceedingUnits) : null, perSchemeCommittedQty: quantityTarget ? perScheme : null, rateWithoutGST: asNum(r.rateWithoutGST), rateWithGST: asNum(r.rateWithGST) }; });
}

export interface BillProductInput {
  billId: string;
  productId: string;
  soQty?: number | null;
  adminQty?: number | null;
  rateWithoutGST: number;
  rateWithGST: number;
}

/** Minimal raw-SQL client — satisfied by both `prisma` and a transaction client. */
export type RawExecClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$executeRawUnsafe">;

/**
 * Upsert one bill-product row (by billId+productId). `soQty`/`adminQty` are only written when provided
 * (undefined leaves the existing value — so Admin verify can set adminQty without erasing soQty, and vice
 * versa). The rate snapshot is always (re)written from the caller's snapshot value.
 */
export async function upsertBillProduct(db: RawExecClient, row: BillProductInput): Promise<void> {
  // COALESCE on conflict: a NULL side PRESERVES the existing value, so SO can set soQty and Admin can later
  // set adminQty without erasing the other. The rate snapshot is always (re)written.
  await db.$executeRawUnsafe(
    `INSERT INTO "DealerSchemeBillProduct" ("id","billId","productId","soQty","adminQty","rateWithoutGST","rateWithGST","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT ("billId","productId") DO UPDATE SET
       "soQty" = COALESCE($4, "DealerSchemeBillProduct"."soQty"),
       "adminQty" = COALESCE($5, "DealerSchemeBillProduct"."adminQty"),
       "rateWithoutGST" = $6, "rateWithGST" = $7, "updatedAt" = NOW()`,
    randomUUID(),          // $1
    row.billId,            // $2
    row.productId,         // $3
    row.soQty ?? null,     // $4
    row.adminQty ?? null,  // $5
    row.rateWithoutGST,    // $6
    row.rateWithGST,       // $7
  );
}

/**
 * Parameterized bulk equivalent of `upsertBillProduct`. Used by Admin Verification, where as many as five
 * bills × 200 products may be verified in one atomic request. Existing row identity/createdAt and the other
 * actor's quantity are preserved; duplicate input keys retain the previous sequential behavior (last wins).
 */
export async function upsertBillProducts(db: RawExecClient, rows: BillProductInput[]): Promise<void> {
  if (rows.length === 0) return;
  const byKey = new Map<string, BillProductInput>();
  for (const row of rows) byKey.set(`${row.billId}\u0000${row.productId}`, row);
  const values = [...byKey.values()].map((row) => Prisma.sql`(
    ${randomUUID()},
    ${row.billId},
    ${row.productId},
    ${row.soQty == null ? null : new Prisma.Decimal(row.soQty)},
    ${row.adminQty == null ? null : new Prisma.Decimal(row.adminQty)},
    ${new Prisma.Decimal(row.rateWithoutGST)},
    ${new Prisma.Decimal(row.rateWithGST)},
    NOW()
  )`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "DealerSchemeBillProduct"
      ("id","billId","productId","soQty","adminQty","rateWithoutGST","rateWithGST","updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("billId","productId") DO UPDATE SET
      "soQty" = COALESCE(EXCLUDED."soQty", "DealerSchemeBillProduct"."soQty"),
      "adminQty" = COALESCE(EXCLUDED."adminQty", "DealerSchemeBillProduct"."adminQty"),
      "rateWithoutGST" = EXCLUDED."rateWithoutGST",
      "rateWithGST" = EXCLUDED."rateWithGST",
      "updatedAt" = EXCLUDED."updatedAt"
  `);
}

export interface BillProductRow {
  billId: string;
  productId: string;
  soQty: number | null;
  adminQty: number | null;
  rateWithoutGST: number;
  rateWithGST: number;
}

/** Read all bill-product rows for a set of bill ids (empty → none). */
export async function billProductsByBillIds(billIds: string[]): Promise<BillProductRow[]> {
  if (billIds.length === 0) return [];
  const rows = await prisma.$queryRaw<{ billId: string; productId: string; soQty: unknown; adminQty: unknown; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
    SELECT "billId", "productId", "soQty", "adminQty", "rateWithoutGST", "rateWithGST"
    FROM "DealerSchemeBillProduct" WHERE "billId" = ANY(${billIds})`;
  return rows.map((r) => ({
    billId: r.billId, productId: r.productId,
    soQty: r.soQty == null ? null : asNum(r.soQty),
    adminQty: r.adminQty == null ? null : asNum(r.adminQty),
    rateWithoutGST: asNum(r.rateWithoutGST), rateWithGST: asNum(r.rateWithGST),
  }));
}

export interface ProductBilling {
  active: true;
  mode: "QUANTITY_TARGET" | "VALUE_TARGET";
  products: CommittedProduct[];
  bills: { partNumber: number; productId: string; soQty: number | null; adminQty: number | null }[];
}
export interface PlanForProductBilling {
  id: string; schemeId: string; structure: string;
  requirementType: string | null; optionAchievementType: string | null; optionTargetQty: number | null;
  numberOfSchemes: number; billMode: boolean;
}
/**
 * Batched product-rate billing snapshot for the SO/Admin billing UI. Existing bill-product snapshot rows win
 * over current Scheme Master rows, preserving historical rates and removed/changed products.
 */
export async function productBillingForPlans(plans: PlanForProductBilling[]): Promise<Map<string, ProductBilling>> {
  const map = new Map<string, ProductBilling>();
  const pq = plans.filter((p) => usesProductRateBilling(p.structure, p.requirementType, p.optionAchievementType));
  if (pq.length === 0) return map;
  const schemeIds = [...new Set(pq.map((p) => p.schemeId))];
  const planIds = pq.map((p) => p.id);
  const reqRows = await prisma.$queryRaw<{ schemeId: string; productId: string; name: string; requiredQty: unknown; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
    SELECT rp."schemeId", rp."productId", p."name", rp."requiredQty", rp."rateWithoutGST", rp."rateWithGST"
    FROM "SchemeRequirementProduct" rp JOIN "Product" p ON p."id" = rp."productId" WHERE rp."schemeId" = ANY(${schemeIds}) ORDER BY rp."createdAt" ASC`;
  const eligRows = await prisma.$queryRaw<{ schemeId: string; productId: string; name: string; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
    SELECT ep."schemeId", ep."productId", p."name", ep."rateWithoutGST", ep."rateWithGST"
    FROM "SchemeEligibleProduct" ep JOIN "Product" p ON p."id" = ep."productId" WHERE ep."schemeId" = ANY(${schemeIds})`;
  const bpRows = await prisma.$queryRaw<{ planId: string; partNumber: number; productId: string; name: string; soQty: unknown; adminQty: unknown; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
    SELECT b."planId", b."partNumber", bp."productId", p."name", bp."soQty", bp."adminQty", bp."rateWithoutGST", bp."rateWithGST"
    FROM "DealerSchemeBillProduct" bp JOIN "DealerSchemeBill" b ON b."id" = bp."billId"
    JOIN "Product" p ON p."id" = bp."productId" WHERE b."planId" = ANY(${planIds})`;
  for (const p of pq) {
    const isOpt = p.structure === "MULTIPLE_OPTIONS";
    const quantityTarget = isProductQuantityScheme(p.structure, p.requirementType, p.optionAchievementType);
    const proceedingUnits = effectiveProceedingSchemeUnits(p.numberOfSchemes || 1);
    const savedRows = bpRows.filter((r) => r.planId === p.id);
    let products: CommittedProduct[];
    if (savedRows.length > 0) {
      const grouped = new Map<string, CommittedProduct>();
      for (const row of savedRows) {
        const current = grouped.get(row.productId);
        grouped.set(row.productId, {
          productId: row.productId,
          name: row.name,
          committedQty: !quantityTarget ? null : (current?.committedQty ?? 0) + asNum(row.soQty),
          rateWithoutGST: asNum(row.rateWithoutGST),
          rateWithGST: asNum(row.rateWithGST),
          historicalSnapshot: true,
        });
      }
      products = [...grouped.values()];
    } else {
      products = isOpt
        ? eligRows.filter((r) => r.schemeId === p.schemeId).map((r) => { const perScheme = p.optionTargetQty ?? 0; return { productId: r.productId, name: r.name, committedQty: quantityTarget ? effectiveProductQuantityTarget(perScheme, proceedingUnits) : null, perSchemeCommittedQty: quantityTarget ? perScheme : null, rateWithoutGST: asNum(r.rateWithoutGST), rateWithGST: asNum(r.rateWithGST) }; })
        : reqRows.filter((r) => r.schemeId === p.schemeId).map((r) => { const perScheme = asNum(r.requiredQty); return { productId: r.productId, name: r.name, committedQty: quantityTarget ? effectiveProductQuantityTarget(perScheme, proceedingUnits) : null, perSchemeCommittedQty: quantityTarget ? perScheme : null, rateWithoutGST: asNum(r.rateWithoutGST), rateWithGST: asNum(r.rateWithGST) }; });
    }
    // Historical Value Based conversions created before product-rate billing have manual plan-level amounts
    // and no bill-product snapshot. Preserve that path even if Scheme Master rates are configured later.
    if (!quantityTarget && p.billMode && savedRows.length === 0) continue;
    const bills = savedRows.map((r) => ({ partNumber: r.partNumber, productId: r.productId, soQty: r.soQty == null ? null : asNum(r.soQty), adminQty: r.adminQty == null ? null : asNum(r.adminQty) }));
    map.set(p.id, { active: true, mode: quantityTarget ? "QUANTITY_TARGET" : "VALUE_TARGET", products, bills });
  }
  return map;
}

/** Read all bill-product rows for one plan (joined through its bills). */
export async function billProductsByPlan(planId: string): Promise<BillProductRow[]> {
  const rows = await prisma.$queryRaw<{ billId: string; productId: string; soQty: unknown; adminQty: unknown; rateWithoutGST: unknown; rateWithGST: unknown }[]>`
    SELECT bp."billId", bp."productId", bp."soQty", bp."adminQty", bp."rateWithoutGST", bp."rateWithGST"
    FROM "DealerSchemeBillProduct" bp
    JOIN "DealerSchemeBill" b ON b."id" = bp."billId"
    WHERE b."planId" = ${planId}`;
  return rows.map((r) => ({
    billId: r.billId, productId: r.productId,
    soQty: r.soQty == null ? null : asNum(r.soQty),
    adminQty: r.adminQty == null ? null : asNum(r.adminQty),
    rateWithoutGST: asNum(r.rateWithoutGST), rateWithGST: asNum(r.rateWithGST),
  }));
}
