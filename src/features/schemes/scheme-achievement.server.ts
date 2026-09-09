import "server-only";
import { SchemeEnrollmentStatus, SchemeUploadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { derivedInstallmentSchedule, installmentBaseDate, type InstallmentRuleRow } from "./scheme-enrolled.server";
import { loadProductMergeMap, terminalSurvivor } from "@/features/products/merge.server";
import {
  installmentPaidTotal,
  schemeProductAchievement,
  schemeValueAchievement,
  uploadImpact,
  type SchemeRequirement,
  type SchemeSaleFact,
  type SchemeProductAchievement,
  type SchemeValueAchievement,
  type UploadImpactRow,
} from "@/lib/scheme-achievement";
import {
  effectiveValueWithGST,
  effectiveOptionTarget,
  schemeOptionAchievement,
  optionUploadImpact,
  type OptionAchievementType,
  type SchemeOptionAchievement,
  type OptionUploadImpactRow,
} from "@/lib/scheme-options";

/**
 * DB adapter for the shared scheme calculation engine (`@/lib/scheme-achievement`).
 *
 * Every function here loads with BATCHED Prisma queries (one query per relation level — never N+1) and
 * then delegates ALL arithmetic to the pure engine, so Scheme Follow-up, Dealer Follow-up, Scheme View
 * Plan and Scheme Upload Analysis share one authoritative calculation. It reads ONLY the scheme-tracking
 * tables (Scheme, SchemeRequirementProduct, DealerSchemePlan, SchemeUploadBatchScheme, SchemeSale) plus
 * installment/instance rows — it NEVER reads or writes MonthlyEntry or any normal Sales Planning actual.
 */

const num = (d: unknown): number => (d == null ? 0 : Number(d.toString()));

/* --------------------------------- requirements --------------------------------- */

/** Load each scheme's achievement requirement (type + value mode + required products), batched. */
export async function loadSchemeRequirements(schemeIds: string[]): Promise<Map<string, SchemeRequirement>> {
  const out = new Map<string, SchemeRequirement>();
  if (schemeIds.length === 0) return out;
  const rows = (await prisma.scheme.findMany({
    where: { id: { in: schemeIds } },
    select: {
      id: true,
      requirementType: true,
      valueMode: true,
      combinedRequiredValue: true,
      requirementProducts: { select: { productId: true, requiredQty: true, requiredValue: true } },
    },
  })) as unknown as {
    id: string;
    requirementType: SchemeRequirement["type"];
    valueMode: SchemeRequirement["valueMode"];
    combinedRequiredValue: unknown;
    requirementProducts: { productId: string; requiredQty: unknown; requiredValue: unknown }[];
  }[];
  for (const s of rows) {
    out.set(s.id, {
      type: s.requirementType,
      valueMode: s.valueMode ?? null,
      combinedRequiredValue: s.combinedRequiredValue == null ? null : num(s.combinedRequiredValue),
      products: s.requirementProducts.map((p) => ({
        productId: p.productId,
        requiredQty: p.requiredQty == null ? null : num(p.requiredQty),
        requiredValue: p.requiredValue == null ? null : num(p.requiredValue),
      })),
    });
  }
  return out;
}

/* --------------------------------- enrolled dealers --------------------------------- */

/**
 * Enrolled dealer ids per scheme, restricted to the caller's officer scope (Admin = all, RM = own +
 * group SOs, SO = self). Only ENROLLED plans contribute to achievement (approved Phase 2 decision).
 */
export async function loadEnrolledDealerIds(ctx: AuthContext, schemeIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (schemeIds.length === 0) return out;
  const scope = await getOfficerScope(ctx);
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: {
      schemeId: { in: schemeIds },
      enrollmentStatus: SchemeEnrollmentStatus.ENROLLED,
      ...(scope.all ? {} : { salesOfficerId: { in: scope.ids } }),
    },
    select: { schemeId: true, dealerId: true },
  })) as { schemeId: string; dealerId: string }[];
  for (const r of rows) {
    const list = out.get(r.schemeId);
    if (list) list.push(r.dealerId);
    else out.set(r.schemeId, [r.dealerId]);
  }
  return out;
}

/* --------------------------------- active scheme sales --------------------------------- */

/** Active (non-superseded) SchemeSale facts per scheme, batched. Superseded scopes are excluded.
 *  Product Merge (Phase 12): each fact's productId is folded to its TERMINAL survivor at read time, so a
 *  merged source's historical scheme sales roll up under the surviving product (which is what the eligible
 *  pool / requirement now reference). No SchemeSale rows are rewritten; a fact is counted exactly once. */
export async function loadActiveSchemeSales(schemeIds: string[]): Promise<Map<string, SchemeSaleFact[]>> {
  const out = new Map<string, SchemeSaleFact[]>();
  if (schemeIds.length === 0) return out;
  const [scopes, mergeMap] = await Promise.all([
    prisma.schemeUploadBatchScheme.findMany({
      where: { schemeId: { in: schemeIds }, status: SchemeUploadStatus.ACTIVE },
      select: { schemeId: true, sales: { select: { dealerId: true, productId: true, qty: true, value: true } } },
    }) as Promise<{ schemeId: string; sales: { dealerId: string; productId: string; qty: unknown; value: unknown }[] }[]>,
    loadProductMergeMap(),
  ]);
  const eff = (id: string) => terminalSurvivor(id, mergeMap);
  for (const sc of scopes) {
    const list = out.get(sc.schemeId) ?? [];
    for (const s of sc.sales) list.push({ dealerId: s.dealerId, productId: eff(s.productId), qty: num(s.qty), value: num(s.value) });
    out.set(sc.schemeId, list);
  }
  return out;
}

/* --------------------------------- option config + snapshot targets (Phase 10) --------------------------------- */

export interface SchemeOptionConfig {
  structure: "FIXED" | "MULTIPLE_OPTIONS";
  optionAchievementType: OptionAchievementType | null;
  eligibleProductIds: string[];
}

/** Load each scheme's structure + option achievement type + eligible product pool, batched. */
export async function loadSchemeOptionConfig(schemeIds: string[]): Promise<Map<string, SchemeOptionConfig>> {
  const out = new Map<string, SchemeOptionConfig>();
  if (schemeIds.length === 0) return out;
  const rows = (await prisma.scheme.findMany({
    where: { id: { in: schemeIds } },
    select: { id: true, structure: true, optionAchievementType: true, eligibleProducts: { select: { productId: true } } },
  })) as unknown as { id: string; structure: string; optionAchievementType: string | null; eligibleProducts: { productId: string }[] }[];
  for (const s of rows) {
    out.set(s.id, {
      structure: s.structure as SchemeOptionConfig["structure"],
      optionAchievementType: (s.optionAchievementType ?? null) as OptionAchievementType | null,
      eligibleProductIds: s.eligibleProducts.map((e) => e.productId),
    });
  }
  return out;
}

/**
 * Per-dealer FROZEN option target per scheme (schemeId → dealerId → target), restricted to the caller's
 * officer scope and ENROLLED plans only. The target read is the plan's snapshot (never the live master
 * option), so committed dealers are unaffected by later master edits. `pickTarget` chooses qty vs value
 * from the scheme's achievement type; dealers without the relevant snapshot are omitted.
 */
export async function loadOptionSnapshotTargets(
  ctx: AuthContext,
  configByScheme: Map<string, SchemeOptionConfig>,
  schemeIds: string[],
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const optionSchemeIds = schemeIds.filter((id) => configByScheme.get(id)?.structure === "MULTIPLE_OPTIONS");
  if (optionSchemeIds.length === 0) return out;
  const scope = await getOfficerScope(ctx);
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: {
      schemeId: { in: optionSchemeIds },
      enrollmentStatus: SchemeEnrollmentStatus.ENROLLED,
      ...(scope.all ? {} : { salesOfficerId: { in: scope.ids } }),
    },
    select: { schemeId: true, dealerId: true, optionTargetQty: true, optionTargetValue: true },
  })) as { schemeId: string; dealerId: string; optionTargetQty: unknown; optionTargetValue: unknown }[];
  for (const r of rows) {
    const cfg = configByScheme.get(r.schemeId);
    if (!cfg) continue;
    const target = effectiveOptionTarget({
      achievementType: cfg.optionAchievementType,
      optionTargetQty: r.optionTargetQty == null ? null : num(r.optionTargetQty),
      optionTargetValue: r.optionTargetValue == null ? null : num(r.optionTargetValue),
    });
    if (target == null) continue; // dealer has no frozen snapshot for this achievement type
    let m = out.get(r.schemeId);
    if (!m) { m = new Map(); out.set(r.schemeId, m); }
    m.set(r.dealerId, target);
  }
  return out;
}

/* --------------------------------- high-level achievement --------------------------------- */

export interface SchemeAchievementResult {
  schemeId: string;
  requirement: SchemeRequirement;
  product: SchemeProductAchievement | null; // set when Fixed PRODUCT_BASED
  value: SchemeValueAchievement | null; // set when Fixed VALUE_BASED
  option: SchemeOptionAchievement | null; // set when MULTIPLE_OPTIONS
}

/**
 * Product/Value achievement for one or more schemes, using ACTIVE scopes + ENROLLED dealers only. Schemes
 * with requirementType = NONE return { product: null, value: null } (installment-only). Batched: three
 * grouped queries total regardless of scheme/dealer count.
 */
export async function computeSchemeAchievement(ctx: AuthContext, schemeIds: string[]): Promise<Map<string, SchemeAchievementResult>> {
  const out = new Map<string, SchemeAchievementResult>();
  if (schemeIds.length === 0) return out;
  const [requirements, enrolled, sales, optionConfig] = await Promise.all([
    loadSchemeRequirements(schemeIds),
    loadEnrolledDealerIds(ctx, schemeIds),
    loadActiveSchemeSales(schemeIds),
    loadSchemeOptionConfig(schemeIds),
  ]);
  // Per-dealer frozen targets are only needed for MULTIPLE_OPTIONS schemes (loader no-ops otherwise).
  const optionTargets = await loadOptionSnapshotTargets(ctx, optionConfig, schemeIds);
  for (const schemeId of schemeIds) {
    const req = requirements.get(schemeId);
    if (!req) continue;
    const schemeSales = sales.get(schemeId) ?? [];
    const cfg = optionConfig.get(schemeId);
    // MULTIPLE_OPTIONS: combined achievement over the eligible pool vs each dealer's snapshot target.
    if (cfg && cfg.structure === "MULTIPLE_OPTIONS" && cfg.optionAchievementType) {
      const targetByDealer = optionTargets.get(schemeId) ?? new Map<string, number>();
      out.set(schemeId, {
        schemeId,
        requirement: req,
        product: null,
        value: null,
        option: schemeOptionAchievement(cfg.optionAchievementType, cfg.eligibleProductIds, schemeSales, targetByDealer),
      });
      continue;
    }
    const enrolledIds = enrolled.get(schemeId) ?? [];
    out.set(schemeId, {
      schemeId,
      requirement: req,
      product: req.type === "PRODUCT_BASED" ? schemeProductAchievement(req, schemeSales, enrolledIds) : null,
      value: req.type === "VALUE_BASED" ? schemeValueAchievement(req, schemeSales, enrolledIds) : null,
      option: null,
    });
  }
  return out;
}

/* --------------------------------- installment progress --------------------------------- */

export interface PlanInstallmentProgress {
  planId: string;
  schemeId: string;
  dealerId: string;
  paid: number;
  total: number;
}

/**
 * Paid/Total installment progress per ENROLLED plan (Paid counts an installment ONLY when its received
 * amount >= its planned amount — the shared `installmentPaidTotal` rule). Reuses the SAME persisted-or-
 * derived schedule the Enrolled Scheme / Follow-up views use (`derivedInstallmentSchedule`), so numbers
 * never diverge, and it never writes. Scope-restricted like the rest of the scheme module.
 */
export async function computeInstallmentProgress(
  ctx: AuthContext,
  opts: { schemeId?: string; dealerId?: string; officerId?: string } = {},
): Promise<PlanInstallmentProgress[]> {
  const scope = await getOfficerScope(ctx);
  const officerFilter = opts.officerId
    ? { salesOfficerId: opts.officerId }
    : scope.all
      ? {}
      : { salesOfficerId: { in: scope.ids } };
  const plans = (await prisma.dealerSchemePlan.findMany({
    where: {
      enrollmentStatus: SchemeEnrollmentStatus.ENROLLED,
      ...(opts.schemeId ? { schemeId: opts.schemeId } : {}),
      ...(opts.dealerId ? { dealerId: opts.dealerId } : {}),
      ...officerFilter,
    },
    select: {
      id: true, schemeId: true, dealerId: true, adminVerifiedAt: true, billingDate: true, expectedBillingDate: true, adminBillingDate: true,
      prePlacementDays: true, adminPrePlacementDays: true,
      optionValueWithGST: true,
      scheme: { select: { schemeValueWithGST: true, structure: true, installmentRules: { select: { installmentNumber: true, calculationType: true, value: true, daysAfterBillingDate: true } } } },
      instances: {
        select: { id: true, instanceNumber: true, adminBillingDate: true, installments: { select: { installmentNumber: true, plannedAmount: true, receivedAmount: true } } },
        orderBy: { instanceNumber: "asc" },
      },
    },
  })) as unknown as {
    id: string; schemeId: string; dealerId: string; adminVerifiedAt: Date | null; billingDate: Date | null; expectedBillingDate: Date | null; adminBillingDate: Date | null;
    prePlacementDays: number | null; adminPrePlacementDays: number | null;
    optionValueWithGST: unknown;
    scheme: { schemeValueWithGST: unknown; structure: string; installmentRules: InstallmentRuleRow[] };
    instances: { id: string; instanceNumber: number; adminBillingDate: Date | null; installments: { installmentNumber: number; plannedAmount: unknown; receivedAmount: unknown }[] }[];
  }[];

  return plans.map((p) => {
    // Effective With-GST base for derived schedules: option snapshot for MULTIPLE_OPTIONS, scheme value for FIXED.
    const gst = effectiveValueWithGST({ structure: p.scheme.structure, schemeValueWithGST: p.scheme.schemeValueWithGST == null ? null : num(p.scheme.schemeValueWithGST), optionValueWithGST: p.optionValueWithGST == null ? null : num(p.optionValueWithGST) });
    const items: { plannedAmount: number; receivedAmount: number | null }[] = [];
    for (const inst of p.instances) {
      if (inst.installments.length > 0) {
        for (const i of inst.installments) items.push({ plannedAmount: num(i.plannedAmount), receivedAmount: i.receivedAmount == null ? null : num(i.receivedAmount) });
        continue;
      }
      // No persisted rows yet — derive the schedule (read-only, same helper the views use). Unpaid by nature.
      const billing = installmentBaseDate(p, inst);
      for (const d of derivedInstallmentSchedule(p.scheme.installmentRules, gst, billing)) items.push({ plannedAmount: d.plannedAmount, receivedAmount: null });
    }
    const { paid, total } = installmentPaidTotal(items);
    return { planId: p.id, schemeId: p.schemeId, dealerId: p.dealerId, paid, total };
  });
}

/* --------------------------------- upload impact --------------------------------- */

export interface SchemeUploadImpact {
  schemeId: string;
  requirement: SchemeRequirement;
  enrolledChecked: number;
  rows: UploadImpactRow[];
}

/**
 * Compute the Scheme Upload impact for ONE scheme + date range against already-resolved incoming facts
 * (`incoming` keyed `${dealerId}|${productId}` → {qty,value}, only enrolled+required rows). "Previously
 * achieved" = this scheme's OTHER active scopes whose (startDate,endDate) differ from the incoming range
 * (so re-uploading the SAME range does not double-count itself). Pure arithmetic is delegated to the engine.
 */
export async function computeSchemeUploadImpact(
  ctx: AuthContext,
  schemeId: string,
  range: { startDate: Date; endDate: Date },
  incoming: Map<string, { qty: number; value: number }>,
): Promise<SchemeUploadImpact> {
  const [requirements, enrolled] = await Promise.all([
    loadSchemeRequirements([schemeId]),
    loadEnrolledDealerIds(ctx, [schemeId]),
  ]);
  const req = requirements.get(schemeId) ?? { type: "NONE", valueMode: null, combinedRequiredValue: null, products: [] };
  const enrolledIds = enrolled.get(schemeId) ?? [];

  // Previously achieved = active scopes of THIS scheme, excluding the exact range being (re)uploaded.
  const scopes = (await prisma.schemeUploadBatchScheme.findMany({
    where: { schemeId, status: SchemeUploadStatus.ACTIVE },
    select: { startDate: true, endDate: true, sales: { select: { dealerId: true, productId: true, qty: true, value: true } } },
  })) as { startDate: Date; endDate: Date; sales: { dealerId: string; productId: string; qty: unknown; value: unknown }[] }[];
  const previous = new Map<string, { qty: number; value: number }>();
  const sameRange = (a: Date, b: Date) => a.getTime() === b.getTime();
  for (const sc of scopes) {
    if (sameRange(sc.startDate, range.startDate) && sameRange(sc.endDate, range.endDate)) continue; // this is the range being replaced
    for (const s of sc.sales) {
      const key = `${s.dealerId}|${s.productId}`;
      const cur = previous.get(key) ?? { qty: 0, value: 0 };
      cur.qty += num(s.qty);
      cur.value += num(s.value);
      previous.set(key, cur);
    }
  }

  return {
    schemeId,
    requirement: req,
    enrolledChecked: enrolledIds.length,
    rows: uploadImpact(req, previous, incoming, enrolledIds),
  };
}

/* --------------------------------- upload impact (option) --------------------------------- */

export interface SchemeOptionUploadImpact {
  schemeId: string;
  achievementType: OptionAchievementType;
  eligibleProductIds: string[];
  enrolledChecked: number;
  rows: OptionUploadImpactRow[];
}

/**
 * Scheme Upload impact for ONE MULTIPLE_OPTIONS scheme + date range. Mirrors `computeSchemeUploadImpact` but
 * uses the eligible pool + each dealer's FROZEN snapshot target (never the live master option). "Previously
 * achieved" = this scheme's OTHER active scopes whose range differs from the incoming range (so re-uploading
 * the SAME range does not double-count). Pure arithmetic delegated to `optionUploadImpact`.
 */
export async function computeSchemeOptionUploadImpact(
  schemeId: string,
  achievementType: OptionAchievementType,
  eligibleProductIds: string[],
  targetByDealer: Map<string, number>,
  range: { startDate: Date; endDate: Date },
  incoming: Map<string, { qty: number; value: number }>,
): Promise<SchemeOptionUploadImpact> {
  const scopes = (await prisma.schemeUploadBatchScheme.findMany({
    where: { schemeId, status: SchemeUploadStatus.ACTIVE },
    select: { startDate: true, endDate: true, sales: { select: { dealerId: true, productId: true, qty: true, value: true } } },
  })) as { startDate: Date; endDate: Date; sales: { dealerId: string; productId: string; qty: unknown; value: unknown }[] }[];
  const previous = new Map<string, { qty: number; value: number }>();
  const sameRange = (a: Date, b: Date) => a.getTime() === b.getTime();
  for (const sc of scopes) {
    if (sameRange(sc.startDate, range.startDate) && sameRange(sc.endDate, range.endDate)) continue;
    for (const s of sc.sales) {
      const key = `${s.dealerId}|${s.productId}`;
      const cur = previous.get(key) ?? { qty: 0, value: 0 };
      cur.qty += num(s.qty);
      cur.value += num(s.value);
      previous.set(key, cur);
    }
  }
  return {
    schemeId,
    achievementType,
    eligibleProductIds,
    enrolledChecked: targetByDealer.size,
    rows: optionUploadImpact(achievementType, eligibleProductIds, targetByDealer, previous, incoming),
  };
}
