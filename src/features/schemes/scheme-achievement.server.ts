import "server-only";
import { SchemeEnrollmentStatus, SchemeUploadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { derivedInstallmentSchedule, resolveInstanceBillingDate, type InstallmentRuleRow } from "./scheme-enrolled.server";
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

/** Active (non-superseded) SchemeSale facts per scheme, batched. Superseded scopes are excluded. */
export async function loadActiveSchemeSales(schemeIds: string[]): Promise<Map<string, SchemeSaleFact[]>> {
  const out = new Map<string, SchemeSaleFact[]>();
  if (schemeIds.length === 0) return out;
  const scopes = (await prisma.schemeUploadBatchScheme.findMany({
    where: { schemeId: { in: schemeIds }, status: SchemeUploadStatus.ACTIVE },
    select: { schemeId: true, sales: { select: { dealerId: true, productId: true, qty: true, value: true } } },
  })) as { schemeId: string; sales: { dealerId: string; productId: string; qty: unknown; value: unknown }[] }[];
  for (const sc of scopes) {
    const list = out.get(sc.schemeId) ?? [];
    for (const s of sc.sales) list.push({ dealerId: s.dealerId, productId: s.productId, qty: num(s.qty), value: num(s.value) });
    out.set(sc.schemeId, list);
  }
  return out;
}

/* --------------------------------- high-level achievement --------------------------------- */

export interface SchemeAchievementResult {
  schemeId: string;
  requirement: SchemeRequirement;
  product: SchemeProductAchievement | null; // set when PRODUCT_BASED
  value: SchemeValueAchievement | null; // set when VALUE_BASED
}

/**
 * Product/Value achievement for one or more schemes, using ACTIVE scopes + ENROLLED dealers only. Schemes
 * with requirementType = NONE return { product: null, value: null } (installment-only). Batched: three
 * grouped queries total regardless of scheme/dealer count.
 */
export async function computeSchemeAchievement(ctx: AuthContext, schemeIds: string[]): Promise<Map<string, SchemeAchievementResult>> {
  const out = new Map<string, SchemeAchievementResult>();
  if (schemeIds.length === 0) return out;
  const [requirements, enrolled, sales] = await Promise.all([
    loadSchemeRequirements(schemeIds),
    loadEnrolledDealerIds(ctx, schemeIds),
    loadActiveSchemeSales(schemeIds),
  ]);
  for (const schemeId of schemeIds) {
    const req = requirements.get(schemeId);
    if (!req) continue;
    const enrolledIds = enrolled.get(schemeId) ?? [];
    const schemeSales = sales.get(schemeId) ?? [];
    out.set(schemeId, {
      schemeId,
      requirement: req,
      product: req.type === "PRODUCT_BASED" ? schemeProductAchievement(req, schemeSales, enrolledIds) : null,
      value: req.type === "VALUE_BASED" ? schemeValueAchievement(req, schemeSales, enrolledIds) : null,
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
      scheme: { select: { schemeValueWithGST: true, installmentRules: { select: { installmentNumber: true, calculationType: true, value: true, daysAfterBillingDate: true } } } },
      instances: {
        select: { id: true, instanceNumber: true, adminBillingDate: true, installments: { select: { installmentNumber: true, plannedAmount: true, receivedAmount: true } } },
        orderBy: { instanceNumber: "asc" },
      },
    },
  })) as unknown as {
    id: string; schemeId: string; dealerId: string; adminVerifiedAt: Date | null; billingDate: Date | null; expectedBillingDate: Date | null; adminBillingDate: Date | null;
    scheme: { schemeValueWithGST: unknown; installmentRules: InstallmentRuleRow[] };
    instances: { id: string; instanceNumber: number; adminBillingDate: Date | null; installments: { installmentNumber: number; plannedAmount: unknown; receivedAmount: unknown }[] }[];
  }[];

  return plans.map((p) => {
    const gst = num(p.scheme.schemeValueWithGST);
    const items: { plannedAmount: number; receivedAmount: number | null }[] = [];
    for (const inst of p.instances) {
      if (inst.installments.length > 0) {
        for (const i of inst.installments) items.push({ plannedAmount: num(i.plannedAmount), receivedAmount: i.receivedAmount == null ? null : num(i.receivedAmount) });
        continue;
      }
      // No persisted rows yet — derive the schedule (read-only, same helper the views use). Unpaid by nature.
      const billing = resolveInstanceBillingDate(p, inst);
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
