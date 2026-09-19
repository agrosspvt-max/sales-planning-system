import "server-only";
import { saveBillConversion, verifyBills, rejectLegacyBillWrite } from "./scheme-bills.server";
import { billDate } from "@/lib/scheme-bills";
import type { BillInstanceInfo, PlanBillInfo } from "@/lib/scheme-bills";
import { Role, SchemeStatus, SchemePlanStatus, SchemeEnrollmentStatus, SchemePlanState, SchemeConversionStatus, SchemeBookingStatus, SchemeSoDocStatus, SchemeAdminDocStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope, assertOfficerInScope, getCurrentManagerId } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { refreshSchemeStatuses } from "./scheme-master.server";
import { extensionAttemptsEnabled, hasExtensionAttemptsRemaining, isConversionExtensionStatusEligible, isWithinConversionExtensionDayLimit } from "@/lib/scheme-conversion-extension";
import { planLifecycle, type SchemePlanLifecycle } from "@/lib/scheme-lifecycle";
import { combinedDealerUniverse } from "@/lib/scheme-dealer-universe";
import { bookingCoverage } from "@/lib/scheme-booking-coverage";
import { productBillingForPlans, type ProductBilling } from "./scheme-bill-product.server";
import { applyConversionQuantity } from "./scheme-plan-quantity.server";

/**
 * Scheme Planning (Phase 1): a Sales Officer plans their assigned dealers into an OPEN scheme applicable
 * to their State; the Regional Manager approves/rejects/returns the PLANNING; the Super Admin then
 * verifies enrollment documents and ENROLLs each dealer. Planning approval is independent of enrollment.
 */

/* --------------------------------- Eligible schemes --------------------------------- */

/** OPEN schemes applicable to the caller's State (group). SO/RM see their own group's schemes; Admin sees all OPEN. */
export async function eligibleSchemes(ctx: AuthContext): Promise<{ id: string; schemeName: string }[]> {
  await refreshSchemeStatuses();
  const stateFilter = ctx.role === Role.SUPER_ADMIN || !ctx.groupId ? {} : { states: { some: { groupId: ctx.groupId } } };
  const rows = (await prisma.scheme.findMany({
    where: { status: SchemeStatus.OPEN, ...stateFilter },
    orderBy: { schemeName: "asc" },
    select: { id: true, schemeName: true },
  })) as { id: string; schemeName: string }[];
  return rows;
}

/** Assigned dealers of the caller (SO/RM self) NOT already planned into the given scheme. */
export async function dealersForScheme(ctx: AuthContext, schemeId: string): Promise<{ id: string; name: string }[]> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) return [];
  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId: ctx.userId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const assignedIds = assignments.map((a) => a.dealerId);
  if (assignedIds.length === 0) return [];
  const existing = (await prisma.dealerSchemePlan.findMany({ where: { schemeId, dealerId: { in: assignedIds } }, select: { dealerId: true } })) as { dealerId: string }[];
  const taken = new Set(existing.map((e) => e.dealerId));
  const free = assignedIds.filter((id) => !taken.has(id));
  if (free.length === 0) return [];
  const dealers = (await prisma.dealer.findMany({ where: { id: { in: free }, isActive: true, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } })) as { id: string; name: string }[];
  return dealers;
}

/* --------------------------------- Row shape --------------------------------- */

export interface SchemePlanRow {
  id: string;
  schemeId: string;
  schemeName: string;
  dealerId: string;
  dealerName: string;
  salesOfficerId: string;
  salesOfficerName: string;
  state: string | null;
  territory: string | null;
  planningStatus: string;
  enrollmentStatus: string;
  expectedBillingDate: string | null;
  submittedAt: string | null;
  rmActedByName: string | null;
  rmActedAt: string | null;
  rmRemarks: string | null;
  documentCompleted: boolean;
  documentType: string | null;
  verificationRemarks: string | null;
  enrolledByName: string | null;
  enrolledAt: string | null;
  createdAt: string;
  // Part E
  planStatus: string;
  schemeStatus: string;
  /** The parent scheme's lifecycle: true when the Scheme is CLOSED (auto-closed past end date or manually
   *  closed). Distinct from `schemeStatus`, which is the dealer's CONVERSION status. Used by View Plan →
   *  Older Plans, which archives every plan of a closed scheme. */
  schemeClosed: boolean;
  segmentNumber: number;
  numberOfSchemes: number;
  totalSchemeAmount: number;
  /** Planned amount EXCLUDING GST (per-unit scheme/option value without GST × numberOfSchemes). Derived, not
   *  stored — the without-GST counterpart of the planned totalSchemeAmount. Used by Conversion Follow-up. */
  plannedAmountWithoutGST: number;
  /** Actual/converted amount EXCLUDING GST — 0 until the dealer is CONVERTED, then the Admin-confirmed
   *  without-GST amount (mirrors the with-GST `totalSchemeAmount` computation). Used by Conversion Follow-up. */
  actualAmountWithoutGST: number;
  soNote: string | null; // optional per-dealer Sales Officer note
  // Conversion Date Extension. expectedBillingDate is the CURRENT planned conversion date; original is the
  // baseline ceiling anchor; the scheme's max* are the configured limits; history lists each extension.
  originalConversionDate: string | null;
  conversionExtensionCount: number;
  maxExtensionDays: number;
  maxExtensionAttempts: number;
  maxBillCount: number;
  conversionExtensions: { extensionNumber: number; previousConversionDate: string; newConversionDate: string; daysAdded: number; extendedByName: string | null; createdAt: string }[];
  planningDate: string | null; // when the SO submitted the plan (= submittedAt)
  conversionDate: string | null;
  soBookingStatus: string | null;
  soBookingAmount: number | null;
  soDocumentStatus: string | null;
  billingDate: string | null;
  adminConversionDate: string | null;
  adminBookingStatus: string | null;
  adminBookingAmount: number | null;
  /** Per-scheme booking amount (scheme.bookingAmount for FIXED, option booking for MULTIPLE_OPTIONS). Feeds
   *  the Verify modal's Required Amount = No. of Schemes × this. */
  bookingAmountPerScheme: number;
  /** How many of this plan's proceeding schemes the Admin's Paid booking is verified to cover (null until set;
   *  Conversion Follow-up treats a Paid-but-null plan as covering all its schemes). */
  adminBookingSchemeCount: number | null;
  adminDocumentStatus: string | null;
  adminBillingDate: string | null;
  adminVerifiedAt: string | null;
  // Multi-scheme billing (per-instance) — lets the SO/Admin dialogs restore their same/different choice + dates.
  soBillingSameForAll: boolean;
  adminBillingSameForAll: boolean;
  billing: PlanBillInfo;
  billInstances: BillInstanceInfo[];
  defaultAmountWithoutGST: number;
  defaultAmountWithGST: number;
  instances: { instanceNumber: number; soBillingDate: string | null; adminBillingDate: string | null }[];
  // Multiple Options (Phase 10). structure carried from the scheme; selectedOptionId + snapshot from the plan.
  structure: string;
  selectedOptionId: string | null;
  optionLabel: string | null;
  optionTargetQty: number | null;
  optionTargetValue: number | null;
  optionValueWithoutGST: number | null;
  optionValueWithGST: number | null;
  // Pre-placement (Phase 11): SO/dealer requested + Admin confirmed days (null ⇒ 0).
  prePlacementDays: number | null;
  adminPrePlacementDays: number | null;
  prePlacementMaxDays: number; // scheme ceiling, carried for the UI
  quantitySplit: { originalQuantity: number; proceedingQuantity: number; remainingQuantity: number; disposition: string; futurePlanId: string | null; createdAt: string } | null;
  splitRemainder: { sourcePlanId: string; allocatedQuantity: number } | null;
  /** Product-Quantity-Based billing snapshot (committed products + rates + saved per-bill quantities) — null
   *  for Value Based / non-quantity schemes. Drives the SO/Admin product-quantity billing UI. */
  productBilling: ProductBilling | null;
}

type RawInstance = { id: string; billMode: boolean; soBillCount: number | null; adminBillCount: number | null; adminAmountWithoutGST: unknown; adminAmountWithGST: unknown; bookingAmount: unknown; billsLockedAt: Date | null;
  installments: { billId: string | null }[];
  bills: { id: string; partNumber: number; soBillDate: Date | null; adminBillDate: Date | null; amountWithoutGST: unknown; amountWithGST: unknown; verifiedAt: Date | null }[];
  instanceNumber: number; soBillingDate: Date | null; adminBillingDate: Date | null };
type RawPlan = {
  billMode: boolean; soBillCount: number | null; adminBillCount: number | null; soAmountWithoutGST: unknown; soAmountWithGST: unknown;
  adminAmountWithoutGST: unknown; adminAmountWithGST: unknown; bookingAmount: unknown; bookingBillNumber: number | null; billsLockedAt: Date | null;
  bills: (RawInstance["bills"][number] & { soAmountWithoutGST: unknown; soAmountWithGST: unknown })[];
  id: string; schemeId: string; dealerId: string; salesOfficerId: string; planningStatus: string; enrollmentStatus: string;
  expectedBillingDate: Date | null; submittedAt: Date | null; rmActedAt: Date | null; rmRemarks: string | null; documentCompleted: boolean; documentType: string | null;
  verificationRemarks: string | null; enrolledAt: Date | null; createdAt: Date;
  planStatus: string; schemeStatus: string; segmentNumber: number; numberOfSchemes: number; totalSchemeAmount: unknown; soNote: string | null;
  originalConversionDate: Date | null; conversionExtensionCount: number;
  conversionExtensions: { extensionNumber: number; previousConversionDate: Date; newConversionDate: Date; daysAdded: number; createdAt: Date; extendedBy: { name: string } | null }[];
  conversionDate: Date | null; soBookingStatus: string | null; soBookingAmount: unknown; soDocumentStatus: string | null; billingDate: Date | null;
  adminConversionDate: Date | null; adminBookingStatus: string | null; adminBookingAmount: unknown; adminDocumentStatus: string | null; adminBillingDate: Date | null; adminVerifiedAt: Date | null;
  soBillingSameForAll: boolean; adminBillingSameForAll: boolean; instances: RawInstance[];
  selectedOptionId: string | null; optionLabel: string | null; optionTargetQty: unknown; optionTargetValue: unknown; optionValueWithoutGST: unknown; optionValueWithGST: unknown; optionBookingAmount: unknown;
  prePlacementDays: number | null; adminPrePlacementDays: number | null;
  quantitySplitAsSource: { originalQuantity: number; proceedingQuantity: number; remainingQuantity: number; disposition: string; futurePlanId: string | null; createdAt: Date } | null;
  quantitySplitAsFuture: { sourcePlanId: string; remainingQuantity: number } | null;
  scheme: { schemeName: string; status: string; schemeValueWithoutGST: unknown; schemeValueWithGST: unknown; bookingAmount: unknown; structure: string; requirementType: string | null; optionAchievementType: string | null; maxExtensionDays: number; maxExtensionAttempts: number; numberOfBills: number; prePlacementMaxDays: number };
  dealer: { name: string };
  salesOfficer: { name: string; territory: string | null; group: { name: string } | null };
  rmActedBy: { name: string } | null;
  enrolledBy: { name: string } | null;
};
const PLAN_INCLUDE = {
  bills: { orderBy: { partNumber: "asc" } },
  scheme: { select: { schemeName: true, status: true, schemeValueWithoutGST: true, schemeValueWithGST: true, bookingAmount: true, structure: true, requirementType: true, optionAchievementType: true, maxExtensionDays: true, maxExtensionAttempts: true, numberOfBills: true, prePlacementMaxDays: true } },
  dealer: { select: { name: true } },
  salesOfficer: { select: { name: true, territory: true, group: { select: { name: true } } } },
  rmActedBy: { select: { name: true } },
  enrolledBy: { select: { name: true } },
  instances: { include: { bills: { orderBy: { partNumber: "asc" } }, installments: { select: { billId: true } } }, orderBy: { instanceNumber: "asc" } },
  conversionExtensions: { select: { extensionNumber: true, previousConversionDate: true, newConversionDate: true, daysAdded: true, createdAt: true, extendedBy: { select: { name: true } } }, orderBy: { extensionNumber: "asc" } },
  quantitySplitAsSource: { select: { originalQuantity: true, proceedingQuantity: true, remainingQuantity: true, disposition: true, futurePlanId: true, createdAt: true } },
  quantitySplitAsFuture: { select: { sourcePlanId: true, remainingQuantity: true } },
} as const;

const asNum = (v: unknown): number => (v == null ? 0 : Number(v.toString()));

function toPlanRow(r: RawPlan): SchemePlanRow {
  const plannedTotal = r.totalSchemeAmount != null ? asNum(r.totalSchemeAmount) : asNum(r.scheme.schemeValueWithGST) * (r.numberOfSchemes || 1);
  const total = r.billMode && r.adminAmountWithGST != null ? asNum(r.adminAmountWithGST) : r.instances.some(i => i.billMode && i.adminAmountWithGST != null)
    ? r.instances.reduce((sum, i) => sum + asNum(i.adminAmountWithGST ?? (r.scheme.structure === "MULTIPLE_OPTIONS" ? r.optionValueWithGST : r.scheme.schemeValueWithGST)), 0)
    : plannedTotal;
  // Without-GST counterparts (Conversion Follow-up). Planned mirrors plannedTotal but uses the without-GST
  // per-unit value; actual mirrors `total` (Admin-confirmed when billed, else planned) but is 0 until the
  // dealer is CONVERTED, so the "Actual Amt. w/o GST" column reflects genuinely converted value only.
  const perUnitWithoutGST = asNum(r.scheme.structure === "MULTIPLE_OPTIONS" ? r.optionValueWithoutGST : r.scheme.schemeValueWithoutGST);
  const plannedAmountWithoutGST = perUnitWithoutGST * (r.numberOfSchemes || 1);
  const actualAmountWithoutGST = r.schemeStatus !== "CONVERTED" ? 0
    : r.billMode && r.adminAmountWithoutGST != null ? asNum(r.adminAmountWithoutGST)
    : r.instances.some(i => i.billMode && i.adminAmountWithoutGST != null)
      ? r.instances.reduce((sum, i) => sum + asNum(i.adminAmountWithoutGST ?? perUnitWithoutGST), 0)
      : plannedAmountWithoutGST;
  return {
    id: r.id,
    schemeId: r.schemeId,
    schemeName: r.scheme.schemeName,
    dealerId: r.dealerId,
    dealerName: r.dealer.name,
    salesOfficerId: r.salesOfficerId,
    salesOfficerName: r.salesOfficer.name,
    state: r.salesOfficer.group?.name ?? null,
    territory: r.salesOfficer.territory ?? null,
    planningStatus: r.planningStatus,
    enrollmentStatus: r.enrollmentStatus,
    expectedBillingDate: r.expectedBillingDate?.toISOString() ?? null,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    rmActedByName: r.rmActedBy?.name ?? null,
    rmActedAt: r.rmActedAt?.toISOString() ?? null,
    rmRemarks: r.rmRemarks,
    documentCompleted: r.documentCompleted,
    documentType: r.documentType,
    verificationRemarks: r.verificationRemarks,
    enrolledByName: r.enrolledBy?.name ?? null,
    enrolledAt: r.enrolledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    planStatus: r.planStatus,
    schemeStatus: r.schemeStatus,
    schemeClosed: r.scheme.status === SchemeStatus.CLOSED,
    segmentNumber: r.segmentNumber ?? 1,
    numberOfSchemes: r.numberOfSchemes || 1,
    totalSchemeAmount: total,
    plannedAmountWithoutGST,
    actualAmountWithoutGST,
    soNote: r.soNote ?? null,
    originalConversionDate: r.originalConversionDate?.toISOString() ?? null,
    conversionExtensionCount: r.conversionExtensionCount ?? 0,
    maxExtensionDays: r.scheme.maxExtensionDays ?? 0,
    maxExtensionAttempts: r.scheme.maxExtensionAttempts ?? 0,
    maxBillCount: r.scheme.numberOfBills ?? 5,
    conversionExtensions: (r.conversionExtensions ?? []).map((e) => ({
      extensionNumber: e.extensionNumber,
      previousConversionDate: e.previousConversionDate.toISOString(),
      newConversionDate: e.newConversionDate.toISOString(),
      daysAdded: e.daysAdded,
      extendedByName: e.extendedBy?.name ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    planningDate: r.submittedAt?.toISOString() ?? null,
    conversionDate: r.conversionDate?.toISOString() ?? null,
    soBookingStatus: r.soBookingStatus,
    soBookingAmount: r.soBookingAmount == null ? null : asNum(r.soBookingAmount),
    soDocumentStatus: r.soDocumentStatus,
    billingDate: r.billingDate?.toISOString() ?? null,
    adminConversionDate: r.adminConversionDate?.toISOString() ?? null,
    adminBookingStatus: r.adminBookingStatus,
    adminBookingAmount: r.adminBookingAmount == null ? null : asNum(r.adminBookingAmount),
    bookingAmountPerScheme: asNum(r.scheme.structure === "MULTIPLE_OPTIONS" ? r.optionBookingAmount : r.scheme.bookingAmount),
    // Enriched from the raw column after the main query (the generated client cannot see the new column here).
    adminBookingSchemeCount: null,
  productBilling: null, // enriched (raw SQL) after the main query for product-rate billing plans
    adminDocumentStatus: r.adminDocumentStatus,
    adminBillingDate: r.adminBillingDate?.toISOString() ?? null,
    adminVerifiedAt: r.adminVerifiedAt?.toISOString() ?? null,
    soBillingSameForAll: r.soBillingSameForAll,
    adminBillingSameForAll: r.adminBillingSameForAll,
    defaultAmountWithoutGST: asNum(r.scheme.structure === "MULTIPLE_OPTIONS" ? r.optionValueWithoutGST : r.scheme.schemeValueWithoutGST),
    defaultAmountWithGST: asNum(r.scheme.structure === "MULTIPLE_OPTIONS" ? r.optionValueWithGST : r.scheme.schemeValueWithGST),
    billing: {
      billMode: r.billMode, locked: !!r.billsLockedAt,
      legacySchedules: r.instances.some(i => i.installments.length > 0) || (!r.billMode && !r.instances.some(i => i.billMode) && (!!r.adminVerifiedAt || r.enrollmentStatus === "ENROLLED")),
      soBillCount: r.soBillCount, adminBillCount: r.adminBillCount,
      soAmountWithoutGST: r.soAmountWithoutGST == null ? null : String(r.soAmountWithoutGST), soAmountWithGST: r.soAmountWithGST == null ? null : String(r.soAmountWithGST),
      amountWithoutGST: r.adminAmountWithoutGST == null ? null : String(r.adminAmountWithoutGST), amountWithGST: r.adminAmountWithGST == null ? null : String(r.adminAmountWithGST),
      defaultAmountWithoutGST: String(asNum(r.scheme.structure === "MULTIPLE_OPTIONS" ? r.optionValueWithoutGST : r.scheme.schemeValueWithoutGST) * (r.numberOfSchemes || 1)),
      defaultAmountWithGST: String(plannedTotal), bookingAmount: r.bookingAmount == null ? null : String(r.bookingAmount), bookingBillNumber: r.bookingBillNumber,
      bills: (r.bills ?? []).map(b => ({ partNumber: b.partNumber, soBillDate: b.soBillDate?.toISOString() ?? null, adminBillDate: b.adminBillDate?.toISOString() ?? null,
        soAmountWithoutGST: b.soAmountWithoutGST == null ? null : String(b.soAmountWithoutGST), soAmountWithGST: b.soAmountWithGST == null ? null : String(b.soAmountWithGST),
        amountWithoutGST: b.amountWithoutGST == null ? null : String(b.amountWithoutGST), amountWithGST: b.amountWithGST == null ? null : String(b.amountWithGST), verified: !!b.verifiedAt })),
    },
    billInstances: (r.instances ?? []).map(i => ({ instanceNumber: i.instanceNumber, billMode: i.billMode, soBillCount: i.soBillCount, adminBillCount: i.adminBillCount,
      amountWithoutGST: i.adminAmountWithoutGST == null ? null : asNum(i.adminAmountWithoutGST), amountWithGST: i.adminAmountWithGST == null ? null : asNum(i.adminAmountWithGST),
      locked: !!i.billsLockedAt, legacySchedule: i.installments.some(x => !x.billId),
      bills: i.bills.map(b => ({ partNumber: b.partNumber, soBillDate: b.soBillDate?.toISOString() ?? null, adminBillDate: b.adminBillDate?.toISOString() ?? null,
        amountWithoutGST: b.amountWithoutGST == null ? null : asNum(b.amountWithoutGST), amountWithGST: b.amountWithGST == null ? null : asNum(b.amountWithGST), verified: !!b.verifiedAt })) })),
    instances: (r.instances ?? []).map((i) => ({ instanceNumber: i.instanceNumber, soBillingDate: i.soBillingDate?.toISOString() ?? null, adminBillingDate: i.adminBillingDate?.toISOString() ?? null })),
    structure: r.scheme.structure,
    selectedOptionId: r.selectedOptionId ?? null,
    optionLabel: r.optionLabel ?? null,
    optionTargetQty: r.optionTargetQty == null ? null : asNum(r.optionTargetQty),
    optionTargetValue: r.optionTargetValue == null ? null : asNum(r.optionTargetValue),
    optionValueWithoutGST: r.optionValueWithoutGST == null ? null : asNum(r.optionValueWithoutGST),
    optionValueWithGST: r.optionValueWithGST == null ? null : asNum(r.optionValueWithGST),
    prePlacementDays: r.prePlacementDays ?? null,
    adminPrePlacementDays: r.adminPrePlacementDays ?? null,
    prePlacementMaxDays: r.scheme.prePlacementMaxDays ?? 0,
    quantitySplit: r.quantitySplitAsSource ? { ...r.quantitySplitAsSource, createdAt: r.quantitySplitAsSource.createdAt.toISOString() } : null,
    splitRemainder: r.quantitySplitAsFuture ? { sourcePlanId: r.quantitySplitAsFuture.sourcePlanId, allocatedQuantity: r.quantitySplitAsFuture.remainingQuantity } : null,
  };
}

/* --------------------------------- Listing --------------------------------- */

// The editable planning stage lives in Create Plan; everything past it lives in View Plan. This is the ONE
// server-side source of that split, applied by `bucket` to both the plan list and the Scheme-wise summary.
const EDITABLE_PLAN_STATES = [SchemePlanState.DRAFT, SchemePlanState.RETURNED, SchemePlanState.REJECTED];
const planBucketWhere = (bucket?: "view" | "create") =>
  bucket === "view" ? { planStatus: { notIn: EDITABLE_PLAN_STATES } }
  : bucket === "create" ? { planStatus: { in: EDITABLE_PLAN_STATES } }
  : {};

/**
 * View Plan → lifecycle buckets. Submitted vs Approved is decided at the DEALER-PLAN level by the admin-final
 * Scheme Status (the green "✓ Converted"), NOT by planStatus — so a scheme can appear in both tabs when its
 * dealers differ, and each tab's metrics aggregate only its own dealer plans. Older stays keyed on the Scheme
 * Master OPEN/CLOSED status (archive). No new DB field — this mirrors the pure `planLifecycle` rule.
 *   APPROVED  — green "✓ Converted": schemeStatus CONVERTED + Admin booking Paid + Admin document Received.
 *   SUBMITTED — any other in-workflow (view-bucket) plan of an OPEN scheme not yet in that green state.
 *   OLDER     — every plan of a CLOSED scheme.
 */
// SQL gate = ONLY the null-safe scheme OPEN/CLOSED constraint. The Submitted-vs-Approved (admin-final-green)
// split is intentionally NOT expressed in SQL: a compound `NOT (... adminBookingStatus = RECEIVED AND
// adminDocumentStatus IN (...))` is NOT null-safe (a NULL admin field makes the predicate UNKNOWN, so an
// SO-converted-but-unverified plan is wrongly dropped). That split is applied in memory below via the SAME
// pure `isAdminFinalConverted` the client uses, so server aggregation and client rows classify identically.
const planLifecycleWhere = (lifecycle?: SchemePlanLifecycle) =>
  lifecycle === "OLDER" ? { scheme: { status: SchemeStatus.CLOSED } }
  : lifecycle === "SUBMITTED" || lifecycle === "APPROVED" ? { scheme: { status: SchemeStatus.OPEN } }
  : {};

/**
 * Scoped list: SO → own; RM → their team; Admin → all. Optional `schemeId` filter (for the detail view).
 * Optional `officerId` narrows an RM (or Admin) to a SINGLE Sales Officer — validated server-side against
 * the caller's scope, so it can only ever restrict, never widen, what `getOfficerScope` already allows.
 * `bucket` enforces the Create Plan / View Plan separation: "create" = Draft/Returned/Rejected only;
 * "view" = everything past the editable stage; omitted = all (e.g. the by-scheme detail dialog).
 */
/**
 * Fill each row's `adminBookingSchemeCount` from the raw column. The generated Prisma client is not
 * regenerated in this environment, so the new column is read via raw SQL and merged in. Null-safe and cheap
 * (one query for the whole page). Mutates and returns the same array.
 */
async function enrichBookingSchemeCount<T extends { id: string; adminBookingSchemeCount: number | null }>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const counts = await prisma.$queryRaw<{ id: string; adminBookingSchemeCount: number | null }[]>`
    SELECT "id", "adminBookingSchemeCount" FROM "DealerSchemePlan" WHERE "id" = ANY(${rows.map((r) => r.id)})`;
  const map = new Map(counts.map((c) => [c.id, c.adminBookingSchemeCount == null ? null : Number(c.adminBookingSchemeCount)] as const));
  for (const r of rows) r.adminBookingSchemeCount = map.get(r.id) ?? null;
  return rows;
}

/** Attach product-rate billing data (products + frozen/current rates + saved per-bill quantities). Batched;
 * only Product Quantity Based and Options Value Based plans hit the extra queries. */
async function enrichProductBilling(rows: SchemePlanRow[], raws: RawPlan[]): Promise<void> {
  const pbMap = await productBillingForPlans(raws.map((r) => ({
    id: r.id, schemeId: r.schemeId, structure: r.scheme.structure,
    requirementType: r.scheme.requirementType, optionAchievementType: r.scheme.optionAchievementType,
    optionTargetQty: r.optionTargetQty == null ? null : Number(r.optionTargetQty), numberOfSchemes: r.numberOfSchemes || 1, billMode: r.billMode,
  })));
  for (const row of rows) row.productBilling = pbMap.get(row.id) ?? null;
}

export async function listSchemePlans(ctx: AuthContext, schemeId?: string, officerId?: string, bucket?: "view" | "create"): Promise<SchemePlanRow[]> {
  const scope = await getOfficerScope(ctx);
  if (officerId) await assertOfficerInScope(ctx, officerId);
  const officerFilter = officerId ? { salesOfficerId: officerId } : scope.all ? {} : { salesOfficerId: { in: scope.ids } };
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { ...(schemeId ? { schemeId } : {}), ...officerFilter, ...planBucketWhere(bucket) },
    include: PLAN_INCLUDE,
    orderBy: { createdAt: "desc" },
  })) as unknown as RawPlan[];
  const out = await enrichBookingSchemeCount(rows.map(toPlanRow));
  await enrichProductBilling(out, rows);
  return out;
}

/* --------------------------------- Scheme-wise summary --------------------------------- */

/**
 * One row per scheme for the Sales Officer's View Plan → Scheme-wise → List View.
 *
 * Everything except `dealersPlanned` is counted in SCHEME UNITS, never dealers: a plan represents
 * `numberOfSchemes` units, and approval / conversion / Admin-verification all live on the PLAN
 * (DealerSchemePlan has those columns; DealerSchemeInstance has none of them), so a plan's state applies
 * to all N of its units. Counting DealerSchemeInstance rows instead would undercount LEGACY plans, which
 * intentionally carry only Instance 1 even when numberOfSchemes > 1 — see `ensureInstances`.
 *
 * `billedSchemes` is the ONE deliberate exception, because billing is the one thing stored per INSTANCE
 * rather than on the plan. A legacy plan whose single Instance 1 is billed is evidence of exactly ONE
 * billed unit, not N, so that column's numerator counts actual billed DealerSchemeInstance rows while its
 * denominator stays in units for consistency with the columns above. For a fully expanded new-flow plan
 * both rules give the same answer; they diverge only on legacy plans — precisely where the plan-level rule
 * would be claiming billing the data cannot evidence.
 */
/**
 * Rich per-scheme summary row for View Plan → Scheme-wise. One row per scheme; split plan segments may share
 * a (scheme, dealer), so dealer metrics use distinct dealer-id sets while scheme metrics sum segment units. Every metric
 * respects the caller's scope (getOfficerScope) + optional officer filter. Lifecycle buckets are mutually
 * exclusive: "Admin-confirmed converted" (schemeStatus CONVERTED && adminVerifiedAt set) is a SUBSET of
 * "SO converted" (schemeStatus CONVERTED), so ratios like adminConverted/soConverted never double-count.
 *
 * Dealer-based vs unit-based: *Dealers metrics count plans (one dealer each); *Schemes metrics count units
 * (Σ numberOfSchemes) so multi-scheme dealers are represented. They coincide when every dealer takes the
 * scheme once.
 */
export interface SchemeWiseSummaryRow {
  schemeId: string;
  schemeName: string;
  salesOfficerNames: string[]; // distinct officers with a plan in this scheme (for the SO/State columns)
  states: string[]; // distinct states (officer groups) represented
  // Populated ONLY in groupByOfficer (All Plan View) mode — one row per (officer, scheme).
  salesOfficerId: string | null;
  salesOfficerName: string | null;
  /** Active-dealer denominator for THIS row: scope-wide (per-scheme mode) or the officer's own (grouped). */
  activeDealers: number;

  plannedDealers: number; // distinct dealers planned into this scheme in scope
  plannedSchemes: number; // Σ numberOfSchemes (units)

  soConvertedDealers: number; // dealers with schemeStatus CONVERTED
  adminConvertedDealers: number; // of those, Admin-confirmed (adminVerifiedAt set) — subset
  soConvertedUnits: number; // Σ numberOfSchemes among SO-converted
  adminConvertedUnits: number; // Σ numberOfSchemes among Admin-confirmed converted — subset

  totalAmount: number; // Σ totalSchemeAmount over Admin-confirmed converted ONLY (authoritative with-GST total)

  bookingReceived: number; // among SO-converted, adminBookingStatus RECEIVED (Received only)
  documentReceived: number; // among SO-converted, adminDocumentStatus soft/hard received

  soBillingFilled: number; // plans with an SO billing date filled
  adminBillingFilled: number; // of those, Admin billing date also filled — subset
}

/** The summary payload: per-scheme rows + the scope-level active-dealer denominator (constant across rows). */
export interface SchemeWiseSummary {
  rows: SchemeWiseSummaryRow[];
  /** Distinct ACTIVE dealers in scope (SO's own / RM's team / Admin org / a filtered officer). Denominator
   *  of "Planned Dealers = planned/active". Active = Dealer.isActive && !deletedAt, currently assigned. */
  activeDealers: number;
  /** In-scope option lists for the column filters (unfiltered by the current selection, so the user can
   *  always re-widen). Booking/Document values are fixed enums and supplied by the UI. */
  filterOptions: { states: string[]; officers: { id: string; name: string }[] };
}

/** Server-side Scheme-wise filters. Applied BEFORE aggregation so displayed metrics reflect the filtered
 *  population (§20). states/officers also narrow the active-dealer denominator; booking/documents narrow
 *  only the dealer-scheme records (they are not dealer attributes). */
export interface SchemeSummaryFilters {
  states?: string[];
  officerIds?: string[]; // validated ⊂ caller scope (RM Sales-Officer filter can't reach another team)
  booking?: string[]; // SchemeBookingStatus values
  documents?: string[]; // SchemeAdminDocStatus values
}

type SummaryRaw = {
  billMode: boolean; adminAmountWithGST: unknown; soBillCount: number | null; adminBillCount: number | null; bills: { partNumber: number; soBillDate: Date | null; verifiedAt: Date | null }[];
  schemeId: string;
  dealerId: string;
  salesOfficerId: string;
  numberOfSchemes: number;
  planStatus: string;
  schemeStatus: string;
  adminVerifiedAt: Date | null;
  adminBookingStatus: string | null;
  adminDocumentStatus: string | null;
  billingDate: Date | null;
  adminBillingDate: Date | null;
  totalSchemeAmount: unknown;
  scheme: { schemeName: string; schemeValueWithGST: unknown; status: string };
  salesOfficer: { name: string; group: { name: string } | null };
  instances: { billMode: boolean; adminAmountWithGST: unknown; soBillCount: number | null; adminBillCount: number | null; bills: { partNumber: number; soBillDate: Date | null; verifiedAt: Date | null }[]; soBillingDate: Date | null; adminBillingDate: Date | null }[];
};

/**
 * Scoped scheme-wise summary: SO → own plans; RM → their team; Admin → all (same `getOfficerScope`
 * filter as `listSchemePlans`, so scoping is enforced in the database, not the browser).
 *
 * READ-ONLY by construction — a single findMany reduced in memory. It must never call `ensureInstances`
 * or `expandInstances`: displaying a summary must not create or expand instances.
 */
const adminBookingReceived = (s: string | null) => s === SchemeBookingStatus.RECEIVED;
const adminDocReceivedStatus = (s: string | null) => s === SchemeAdminDocStatus.RECEIVED_SOFT || s === SchemeAdminDocStatus.RECEIVED_HARD;

export async function schemeWiseSummary(
  ctx: AuthContext,
  opts: { officerId?: string; groupByOfficer?: boolean; filters?: SchemeSummaryFilters; lifecycle?: SchemePlanLifecycle } = {},
): Promise<SchemeWiseSummary> {
  const { officerId, groupByOfficer = false, filters = {}, lifecycle } = opts;
  const scope = await getOfficerScope(ctx);
  if (officerId) await assertOfficerInScope(ctx, officerId);
  // RM Sales-Officer filter is restricted to the RM's own team — reject any officer outside scope.
  if (filters.officerIds?.length && !scope.all) {
    for (const id of filters.officerIds) if (!scope.ids.includes(id)) throw new ApiError(403, "That Sales Officer is not in your scope");
  }

  // Base scope + the officer/state filters (narrow BOTH plans and the active-dealer denominator). Booking/
  // document filters narrow only the plan records.
  const scopeOfficer = officerId ? { salesOfficerId: officerId } : scope.all ? {} : { salesOfficerId: { in: scope.ids } };
  const officerIdFilter = filters.officerIds?.length ? { salesOfficerId: { in: filters.officerIds } } : {};
  const stateFilter = filters.states?.length ? { salesOfficer: { group: { name: { in: filters.states } } } } : {};
  const bookingFilter = filters.booking?.length ? { adminBookingStatus: { in: filters.booking as SchemeBookingStatus[] } } : {};
  const documentFilter = filters.documents?.length ? { adminDocumentStatus: { in: filters.documents as SchemeAdminDocStatus[] } } : {};
  const lifecycleWhere = planLifecycleWhere(lifecycle);

  const allRows = (await prisma.dealerSchemePlan.findMany({
    // View Plan only: Draft/Returned/Rejected belong to Create Plan and are excluded from the summary.
    // `lifecycle` further narrows to one View Plan tab (Submitted / Approved / Older) so the metrics match
    // exactly the dealer rows that tab shows. It's combined via AND so its admin booking/document conditions
    // intersect with (never overwrite) any active Booking/Document column filters.
    where: { ...scopeOfficer, ...officerIdFilter, ...stateFilter, ...bookingFilter, ...documentFilter, ...planBucketWhere("view"), ...(Object.keys(lifecycleWhere).length ? { AND: [lifecycleWhere] } : {}) },
    select: {
      schemeId: true,
      dealerId: true,
      salesOfficerId: true,
      numberOfSchemes: true,
      planStatus: true,
      schemeStatus: true,
      adminVerifiedAt: true,
      adminBookingStatus: true,
      adminDocumentStatus: true,
      billingDate: true,
      adminBillingDate: true,
      billMode: true, adminAmountWithGST: true, soBillCount: true, adminBillCount: true, bills: { select: { partNumber: true, soBillDate: true, verifiedAt: true } },
      totalSchemeAmount: true,
      scheme: { select: { schemeName: true, schemeValueWithGST: true, status: true } },
      salesOfficer: { select: { name: true, group: { select: { name: true } } } },
      instances: { select: { billMode: true, adminAmountWithGST: true, soBillCount: true, adminBillCount: true, bills: { select: { partNumber: true, soBillDate: true, verifiedAt: true } }, soBillingDate: true, adminBillingDate: true } },
    },
  })) as unknown as SummaryRaw[];

  // Submitted-vs-Approved split, applied in memory with the SAME classifier the client uses (null-safe):
  //   APPROVED  = admin-final green "✓ Converted"; SUBMITTED = every other view-bucket, open-scheme plan.
  // OLDER already has its full population from the SQL scheme=CLOSED gate. This guarantees the summary
  // aggregates over EXACTLY the rows the expanded dealer table shows (no NULL-driven divergence).
  const rows = lifecycle
    ? allRows.filter((r) => planLifecycle({
        planStatus: r.planStatus, schemeStatus: r.schemeStatus,
        adminBookingStatus: r.adminBookingStatus, adminDocumentStatus: r.adminDocumentStatus,
        schemeClosed: r.scheme.status === SchemeStatus.CLOSED,
      }) === lifecycle)
    : allRows;

  // Active dealer denominator — distinct currently-assigned active dealers in scope, and per officer (for
  // the grouped All Plan View, where each row's denominator is that Sales Officer's own active dealers).
  // Officer relation filter shared by the active-dealer query: scope ∩ officer filter ∩ state filter.
  const activeOfficerWhere = {
    ...(officerId ? { id: officerId } : scope.all ? {} : { id: { in: scope.ids } }),
    ...(filters.officerIds?.length ? { id: { in: filters.officerIds } } : {}),
    ...(filters.states?.length ? { group: { name: { in: filters.states } } } : {}),
  };
  const activeAssignmentWhere = {
    effectiveTo: null,
    dealer: { isActive: true, deletedAt: null },
    ...(Object.keys(activeOfficerWhere).length ? { officer: activeOfficerWhere } : {}),
  };
  const activeAssigns = (await prisma.dealerAssignment.findMany({ where: activeAssignmentWhere, select: { officerId: true, dealerId: true } })) as { officerId: string; dealerId: string }[];
  // Scope-wide distinct active dealers — the payload-level denominator (kept for back-compat; per-row
  // denominators below are the authoritative "Planned Dealers" divisor).
  const activeDealers = new Set(activeAssigns.map((a) => a.dealerId)).size;

  // Group key: per scheme (default) or per (officer, scheme) for the All Plan View.
  const keyOf = (r: SummaryRaw) => (groupByOfficer ? `${r.salesOfficerId}::${r.schemeId}` : r.schemeId);
  const blank = (r: SummaryRaw): SchemeWiseSummaryRow => ({
    schemeId: r.schemeId, schemeName: r.scheme.schemeName, salesOfficerNames: [], states: [],
    salesOfficerId: groupByOfficer ? r.salesOfficerId : null,
    salesOfficerName: groupByOfficer ? r.salesOfficer.name : null,
    activeDealers: 0, // computed per-scheme after grouping (union of the row's officers' dealer universes)
    plannedDealers: 0, plannedSchemes: 0,
    soConvertedDealers: 0, adminConvertedDealers: 0, soConvertedUnits: 0, adminConvertedUnits: 0,
    totalAmount: 0, bookingReceived: 0, documentReceived: 0, soBillingFilled: 0, adminBillingFilled: 0,
  });
  const byScheme = new Map<string, SchemeWiseSummaryRow>();
  const officerSets = new Map<string, Set<string>>();
  const officerIdSets = new Map<string, Set<string>>(); // officer IDs per row → drives the dealer-universe denominator
  const stateSets = new Map<string, Set<string>>();
  const dealerMetricSets = new Map<string, { planned: Set<string>; soConverted: Set<string>; adminConverted: Set<string>; booking: Set<string>; document: Set<string>; soBilling: Set<string>; adminBilling: Set<string> }>();

  for (const r of rows) {
    const key = keyOf(r);
    const row = byScheme.get(key) ?? blank(r);
    if (!officerSets.has(key)) {
      officerSets.set(key, new Set()); officerIdSets.set(key, new Set()); stateSets.set(key, new Set());
      dealerMetricSets.set(key, { planned: new Set(), soConverted: new Set(), adminConverted: new Set(), booking: new Set(), document: new Set(), soBilling: new Set(), adminBilling: new Set() });
    }
    officerSets.get(key)!.add(r.salesOfficer.name);
    officerIdSets.get(key)!.add(r.salesOfficerId);
    if (r.salesOfficer.group?.name) stateSets.get(key)!.add(r.salesOfficer.group.name);

    const units = r.numberOfSchemes || 1;
    const dealerMetrics = dealerMetricSets.get(key)!;
    dealerMetrics.planned.add(r.dealerId);
    row.plannedSchemes += units;

    const converted = r.schemeStatus === SchemeConversionStatus.CONVERTED;
    const adminConfirmed = converted && r.adminVerifiedAt != null;
    if (converted) {
      dealerMetrics.soConverted.add(r.dealerId);
      row.soConvertedUnits += units;
      if (adminBookingReceived(r.adminBookingStatus)) dealerMetrics.booking.add(r.dealerId);
      if (adminDocReceivedStatus(r.adminDocumentStatus)) dealerMetrics.document.add(r.dealerId);
    }
    if (adminConfirmed) {
      dealerMetrics.adminConverted.add(r.dealerId);
      // Qualifying (counted) conversion = admin-ticked (✓: booking Paid + document Received) + question-mark
      // (?: booking Paid + document Not Received). Both require booking Paid; every other admin state (❌
      // crossed/failed) is excluded. The two are mutually exclusive (document is either received or not).
      const bookingPaid = adminBookingReceived(r.adminBookingStatus);
      const docReceived = adminDocReceivedStatus(r.adminDocumentStatus);
      const docNotReceived = r.adminDocumentStatus === SchemeAdminDocStatus.NOT_RECEIVED;
      const qualifies = bookingPaid && (docReceived || docNotReceived);
      if (qualifies) {
        row.adminConvertedUnits += units;
        // Approved/Older Total Amount = admin-FINAL confirmed amount over qualifying (✅ or ❓) records only —
        // never crossed/failed ones. (Submitted uses the planned amount instead — see below.)
        if (lifecycle !== "SUBMITTED") {
          row.totalAmount += r.billMode ? asNum(r.adminAmountWithGST) : r.instances.some(i => i.billMode && i.adminAmountWithGST != null)
            ? r.instances.reduce((sum, i) => sum + asNum(i.adminAmountWithGST), 0)
            : r.totalSchemeAmount != null ? asNum(r.totalSchemeAmount) : asNum(r.scheme.schemeValueWithGST) * units;
        }
      }
    }
    // Submitted Total Amount = the PLANNED amount of every plan in the Submitted dataset (its frozen effective
    // With-GST value = totalSchemeAmount), regardless of Admin verification. This is segment-safe: a split's
    // proceeding segment carries the proportioned amount, the FUTURE_DRAFT remainder is a Draft (excluded from
    // the view bucket), and a CANCELLED remainder is never stored — so no double-count and no cancelled amount.
    if (lifecycle === "SUBMITTED") {
      row.totalAmount += r.totalSchemeAmount != null ? asNum(r.totalSchemeAmount) : asNum(r.scheme.schemeValueWithGST) * units;
    }

    // Billing (per dealer record): SO filled = plan or any instance SO date; Admin filled = plan or any
    // instance Admin date. Admin-filled is only counted when SO is also filled (numerator ⊂ denominator).
    const soFilled = r.billMode ? r.bills.some(b => b.partNumber <= (r.soBillCount ?? 0) && b.soBillDate) : r.billingDate != null || r.instances.some((i) => i.billMode ? i.bills.some(b => b.partNumber <= (i.soBillCount ?? 0) && b.soBillDate) : i.soBillingDate != null);
    const adminFilled = r.billMode ? r.bills.some(b => b.partNumber <= (r.adminBillCount ?? 0) && b.verifiedAt) : r.adminBillingDate != null || r.instances.some((i) => i.billMode ? i.bills.some(b => b.partNumber <= (i.adminBillCount ?? 0) && b.verifiedAt) : i.adminBillingDate != null);
    if (soFilled) {
      dealerMetrics.soBilling.add(r.dealerId);
      if (adminFilled) dealerMetrics.adminBilling.add(r.dealerId);
    }

    byScheme.set(key, row);
  }

  const out = [...byScheme.entries()].map(([key, row]) => ({
    ...row,
    plannedDealers: dealerMetricSets.get(key)?.planned.size ?? 0,
    soConvertedDealers: dealerMetricSets.get(key)?.soConverted.size ?? 0,
    adminConvertedDealers: dealerMetricSets.get(key)?.adminConverted.size ?? 0,
    bookingReceived: dealerMetricSets.get(key)?.booking.size ?? 0,
    documentReceived: dealerMetricSets.get(key)?.document.size ?? 0,
    soBillingFilled: dealerMetricSets.get(key)?.soBilling.size ?? 0,
    adminBillingFilled: dealerMetricSets.get(key)?.adminBilling.size ?? 0,
    // Planned Dealers denominator = the COMBINED dealer universe of the officers who planned this scheme in the
    // current tab (deduped), NOT the scope-wide/global dealer count.
    activeDealers: combinedDealerUniverse(officerIdSets.get(key) ?? new Set(), activeAssigns),
    salesOfficerNames: [...(officerSets.get(key) ?? [])].sort(),
    states: [...(stateSets.get(key) ?? [])].sort(),
  }));
  // Grouped: own rows first (unknown here — the client orders by ownUserId), then officer, then scheme.
  out.sort((a, b) => (a.salesOfficerName ?? "").localeCompare(b.salesOfficerName ?? "") || a.schemeName.localeCompare(b.schemeName));

  // Filter options — Sales Officers in the caller's SCOPE (RM → own team only; Admin → all) and the
  // distinct States among them. Deliberately NOT narrowed by the current selection, so the user can widen.
  const scopeOfficers = (await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, isActive: true, deletedAt: null, ...(scope.all ? {} : { id: { in: scope.ids } }) },
    select: { id: true, name: true, group: { select: { name: true } } },
    orderBy: { name: "asc" },
  })) as { id: string; name: string; group: { name: string } | null }[];
  const filterOptions = {
    states: [...new Set(scopeOfficers.map((o) => o.group?.name).filter(Boolean) as string[])].sort(),
    officers: scopeOfficers.map((o) => ({ id: o.id, name: o.name })),
  };

  return { rows: out, activeDealers, filterOptions };
}

export async function getSchemePlan(ctx: AuthContext, id: string): Promise<SchemePlanRow> {
  const r = (await prisma.dealerSchemePlan.findUnique({ where: { id }, include: PLAN_INCLUDE })) as unknown as RawPlan | null;
  if (!r) throw new ApiError(404, "Scheme plan not found");
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(r.salesOfficerId)) throw new ApiError(403, "You cannot view this scheme plan");
  const [row] = await enrichBookingSchemeCount([toPlanRow(r)]);
  await enrichProductBilling([row], [r]);
  return row;
}

/* --------------------------------- Create / Submit (SO/RM) --------------------------------- */

const createSchema = z.object({ schemeId: z.string().min(1, "Select a scheme"), dealerId: z.string().min(1, "Select a dealer") });

/** A Sales Officer (or RM for their own dealer) plans a dealer into a scheme → DRAFT. */
export async function createSchemePlan(ctx: AuthContext, raw: unknown): Promise<{ id: string }> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can plan dealers");
  const { schemeId, dealerId } = createSchema.parse(raw);
  await refreshSchemeStatuses();

  const scheme = (await prisma.scheme.findUnique({ where: { id: schemeId }, select: { status: true, states: { select: { groupId: true } } } })) as { status: string; states: { groupId: string }[] } | null;
  if (!scheme) throw new ApiError(404, "Scheme not found");
  if (scheme.status !== SchemeStatus.OPEN) throw new ApiError(422, "This scheme is closed");
  if (ctx.groupId && !scheme.states.some((s) => s.groupId === ctx.groupId)) throw new ApiError(422, "This scheme is not applicable to your State");

  const assigned = await prisma.dealerAssignment.findFirst({ where: { officerId: ctx.userId, dealerId, effectiveTo: null }, select: { id: true } });
  if (!assigned) throw new ApiError(422, "That dealer is not assigned to you");

  const dup = await prisma.dealerSchemePlan.findFirst({ where: { schemeId, dealerId }, select: { id: true } });
  if (dup) throw new ApiError(409, "This dealer is already planned into this scheme");

  const created = (await prisma.dealerSchemePlan.create({ data: { schemeId, dealerId, salesOfficerId: ctx.userId, planningStatus: SchemePlanStatus.DRAFT }, select: { id: true } })) as { id: string };
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "dealerSchemePlan", entityId: created.id, summary: "Scheme plan drafted" });
  return { id: created.id };
}

/**
 * Owner submits a Draft/Returned plan. planStatus is the source of truth: an SO's plan → Pending for RM;
 * an RM's own plan → Pending Approval (RM is the approver, skips RM review). Legacy planningStatus is
 * dual-written for compatibility only.
 */
export async function submitSchemePlan(ctx: AuthContext, id: string): Promise<{ planStatus: string }> {
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { salesOfficerId: true, planStatus: true } })) as { salesOfficerId: string; planStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.salesOfficerId !== ctx.userId) throw new ApiError(403, "You can only submit your own scheme plans");
  if (plan.planStatus !== SchemePlanState.DRAFT && plan.planStatus !== SchemePlanState.RETURNED) throw new ApiError(409, "Only a draft or returned plan can be submitted");
  const isRm = ctx.role === Role.REGIONAL_MANAGER;
  // RM approval is required ONLY when the plan owner actually has an applicable RM (getCurrentManagerId,
  // the same group-based authority used by Seasonal/Monthly/Recovery). An RM's OWN submission has no manager
  // above them → skip RM (isRm short-circuit, unchanged). An SO with no RM in their group → straight to
  // Admin (PENDING_APPROVAL) instead of getting stuck at a Pending-for-RM stage no one can action.
  const managerId = isRm ? null : await getCurrentManagerId(plan.salesOfficerId);
  const toRm = managerId != null;
  const nextPlan = toRm ? SchemePlanState.PENDING_RM : SchemePlanState.PENDING_APPROVAL;
  const legacy = toRm ? SchemePlanStatus.SUBMITTED : SchemePlanStatus.RM_APPROVED;
  await prisma.dealerSchemePlan.update({ where: { id }, data: { planStatus: nextPlan, planningStatus: legacy, submittedAt: new Date(), ...(isRm ? { rmActedById: ctx.userId, rmActedAt: new Date(), rmRemarks: null } : { rmActedById: null, rmActedAt: null, rmRemarks: null }) } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: "Scheme plan submitted" });
  return { planStatus: nextPlan };
}

/* --------------------------------- RM action --------------------------------- */

const actSchema = z.object({ action: z.enum(["approve", "reject", "return"]), remarks: z.string().max(500).optional() });

/**
 * RM acts on a team member's plan that is PENDING for RM. planStatus is the SOURCE OF TRUTH:
 *   Accept  → PENDING_APPROVAL (moves to Admin)
 *   Return  → RETURNED (back to SO; remarks required)
 *   Reject  → REJECTED (back to SO; remarks required)
 * The legacy planningStatus is dual-written for backward compatibility only (no logic branches on it).
 * RM approval is planning approval only — it does NOT enroll the dealer.
 */
export async function actOnSchemePlan(ctx: AuthContext, id: string, raw: unknown): Promise<{ planStatus: string }> {
  if (ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Regional Manager can act on scheme plans");
  const { action, remarks } = actSchema.parse(raw);
  if ((action === "return" || action === "reject") && !remarks?.trim()) throw new ApiError(422, "A reason is required to return or reject a plan");

  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { salesOfficerId: true, planStatus: true } })) as { salesOfficerId: string; planStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.salesOfficerId === ctx.userId) throw new ApiError(403, "You cannot act on your own scheme plan");
  const scope = await getOfficerScope(ctx);
  if (!scope.ids.includes(plan.salesOfficerId)) throw new ApiError(403, "This scheme plan is not from your team");
  if (plan.planStatus !== SchemePlanState.PENDING_RM) throw new ApiError(409, "Only a plan pending for RM can be actioned");

  const nextPlan = action === "approve" ? SchemePlanState.PENDING_APPROVAL : action === "reject" ? SchemePlanState.REJECTED : SchemePlanState.RETURNED;
  const legacy = action === "approve" ? SchemePlanStatus.RM_APPROVED : action === "reject" ? SchemePlanStatus.RM_REJECTED : SchemePlanStatus.RETURNED;
  await prisma.dealerSchemePlan.update({ where: { id }, data: { planStatus: nextPlan, planningStatus: legacy, rmActedById: ctx.userId, rmActedAt: new Date(), rmRemarks: remarks?.trim() || null } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: `Scheme plan ${action === "approve" ? "accepted" : action}ed by RM` });
  return { planStatus: nextPlan };
}

/* --------------------------------- Admin approval (final authority) --------------------------------- */

/**
 * Super Admin acts on a plan. planStatus is the SOURCE OF TRUTH:
 *   Approve → APPROVED, Return → RETURNED, Reject → REJECTED (Return/Reject require a reason).
 * OVERRIDE: the Admin may act from PENDING_APPROVAL (normal) OR directly from PENDING_RM (before the RM).
 * A plan the RM already sent back (RETURNED/REJECTED) stays with the SO — the Admin does not re-act on it;
 * neither DRAFT nor already-APPROVED are actionable. Legacy planningStatus is dual-written for compat only.
 */
export async function adminActOnSchemePlan(ctx: AuthContext, id: string, raw: unknown): Promise<{ planStatus: string }> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can act on this plan");
  const { action, remarks } = actSchema.parse(raw);
  if ((action === "return" || action === "reject") && !remarks?.trim()) throw new ApiError(422, "A reason is required to return or reject a plan");

  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { planStatus: true } })) as { planStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.planStatus !== SchemePlanState.PENDING_APPROVAL && plan.planStatus !== SchemePlanState.PENDING_RM) {
    throw new ApiError(409, "Only a plan pending approval (or pending RM, via override) can be actioned by the Admin");
  }

  const nextPlan = action === "approve" ? SchemePlanState.APPROVED : action === "reject" ? SchemePlanState.REJECTED : SchemePlanState.RETURNED;
  const legacy = action === "approve" ? SchemePlanStatus.RM_APPROVED : action === "reject" ? SchemePlanStatus.RM_REJECTED : SchemePlanStatus.RETURNED;
  await prisma.dealerSchemePlan.update({ where: { id }, data: { planStatus: nextPlan, planningStatus: legacy, ...(action !== "approve" ? { rmActedById: ctx.userId, rmActedAt: new Date(), rmRemarks: remarks?.trim() || null } : {}) } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: `Scheme plan ${action === "approve" ? "approved" : action + "ed"} by Super Admin` });
  return { planStatus: nextPlan };
}

/* --------------------------------- Scheme instances --------------------------------- */

/** Read a plan's instances (ordered). */
type InstanceDb = Pick<Prisma.TransactionClient, "dealerSchemePlan" | "dealerSchemeInstance">;
async function listInstances(planId: string, db: InstanceDb = prisma): Promise<{ id: string; instanceNumber: number }[]> {
  return (await db.dealerSchemeInstance.findMany({ where: { dealerSchemePlanId: planId }, select: { id: true, instanceNumber: true }, orderBy: { instanceNumber: "asc" } })) as { id: string; instanceNumber: number }[];
}

/**
 * Guarantee Instance 1 exists and return the plan's instances — WITHOUT expanding to numberOfSchemes. Used
 * by verify + enrolled reads. This is what protects LEGACY records: a plan whose numberOfSchemes was only an
 * amount multiplier (and was never re-planned under the new flow) stays at Instance 1 forever, so no empty
 * instances are fabricated over its existing payment history. Expansion happens ONLY in expandInstances
 * (the explicit planning entry point).
 */
export async function ensureInstances(planId: string, db: InstanceDb = prisma): Promise<{ id: string; instanceNumber: number }[]> {
  const plan = (await db.dealerSchemePlan.findUnique({ where: { id: planId }, select: { id: true } })) as { id: string } | null;
  if (!plan) return [];
  const existing = await listInstances(planId, db);
  if (!existing.some((i) => i.instanceNumber === 1)) {
    await db.dealerSchemeInstance.create({ data: { dealerSchemePlanId: planId, instanceNumber: 1 } });
    return listInstances(planId, db);
  }
  return existing;
}

/**
 * Expand/prune a plan's instances to match numberOfSchemes — the EXPLICIT new-flow action, called only from
 * the SO/RM planning save (persistDraft). Creates instances 1..N and prunes surplus EMPTY instances (no
 * installments, no billing dates). Never runs for enrolled plans; only prunes while editable. Because it is
 * reached solely through active planning, legacy records that are merely read/verified are never expanded.
 */
export async function expandInstances(planId: string, db: InstanceDb = prisma): Promise<void> {
  await expandInstancesForPlans([planId], db);
}

/** Batch the explicit planning expansion for an entire bulk save. The desired instance rows are calculated
 * from two transactional reads, then applied with at most one createMany and one deleteMany. */
async function expandInstancesForPlans(planIds: string[], db: InstanceDb): Promise<void> {
  if (planIds.length === 0) return;
  const plans = (await db.dealerSchemePlan.findMany({
    where: { id: { in: planIds }, enrollmentStatus: { not: SchemeEnrollmentStatus.ENROLLED } },
    select: { id: true, numberOfSchemes: true, planStatus: true },
  })) as { id: string; numberOfSchemes: number; planStatus: string }[];
  if (plans.length === 0) return;
  const activePlanIds = plans.map((plan) => plan.id);
  const existing = (await db.dealerSchemeInstance.findMany({
    where: { dealerSchemePlanId: { in: activePlanIds } },
    select: { id: true, dealerSchemePlanId: true, instanceNumber: true, soBillingDate: true, adminBillingDate: true, _count: { select: { installments: true } } },
  })) as { id: string; dealerSchemePlanId: string; instanceNumber: number; soBillingDate: Date | null; adminBillingDate: Date | null; _count: { installments: number } }[];
  const existingByPlan = new Map<string, typeof existing>();
  for (const instance of existing) existingByPlan.set(instance.dealerSchemePlanId, [...(existingByPlan.get(instance.dealerSchemePlanId) ?? []), instance]);

  const toCreate: Prisma.DealerSchemeInstanceCreateManyInput[] = [];
  const toDelete: string[] = [];
  for (const plan of plans) {
    const count = Math.min(Math.max(plan.numberOfSchemes || 1, 1), 10);
    const planInstances = existingByPlan.get(plan.id) ?? [];
    const have = new Set(planInstances.map((instance) => instance.instanceNumber));
    for (let instanceNumber = 1; instanceNumber <= count; instanceNumber++) {
      if (!have.has(instanceNumber)) toCreate.push({ dealerSchemePlanId: plan.id, instanceNumber });
    }
    const editable = plan.planStatus === SchemePlanState.DRAFT || plan.planStatus === SchemePlanState.RETURNED;
    if (editable) {
      toDelete.push(...planInstances
        .filter((instance) => instance.instanceNumber > count && instance._count.installments === 0 && !instance.soBillingDate && !instance.adminBillingDate)
        .map((instance) => instance.id));
    }
  }
  if (toCreate.length > 0) await db.dealerSchemeInstance.createMany({ data: toCreate });
  if (toDelete.length > 0) await db.dealerSchemeInstance.deleteMany({ where: { id: { in: toDelete } } });
}

/* --------------------------------- Admin verification + enrollment --------------------------------- */

// Single "Update" action: the three core Admin fields (conversion date, booking, document) are ALWAYS
// required; billing dates are optional (needed only for enrollment) and are PER INSTANCE.
const verifySchema = z.object({
  adminConversionDate: z.coerce.date(),
  adminBookingStatus: z.nativeEnum(SchemeBookingStatus),
  adminBookingAmount: z.coerce.number().min(0).nullable().optional(),
  // Booking coverage: how many of the plan's proceeding schemes the Paid booking covers (1..numberOfSchemes).
  // Optional for backward compatibility — omitted ⇒ no coverage recorded and the received-amount check is skipped.
  adminBookingSchemeCount: z.coerce.number().int().min(1).max(10).nullable().optional(),
  adminDocumentStatus: z.nativeEnum(SchemeAdminDocStatus),
  adminBillingSameForAll: z.boolean().optional(),
  adminBillingDate: z.coerce.date().nullable().optional(), // single (same-for-all) — legacy/compat
  adminBillingDates: z.array(z.object({ instanceNumber: z.coerce.number().int().min(1).max(10), date: z.coerce.date().nullable() })).optional(),
  // Pre-placement (Phase 11): Admin confirmed/override days. Omitted ⇒ leave unchanged; null ⇒ fall back to
  // the dealer's requested days. Drives the installment schedule start (billing + confirmed days).
  adminPrePlacementDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  remarks: z.string().max(500).optional(),
});

/** True when the Admin document status counts as "received" (soft or hard copy). */
function adminDocReceived(s: string | null): boolean {
  return s === SchemeAdminDocStatus.RECEIVED_SOFT || s === SchemeAdminDocStatus.RECEIVED_HARD;
}

/**
 * Core (non-billing) enrollment prerequisites: Admin conversion date present, booking = RECEIVED, document
 * = RECEIVED (soft/hard). Full eligibility additionally requires a billing date for EVERY instance.
 */
export function enrollmentEligible(p: { adminConversionDate: Date | string | null; adminBookingStatus: string | null; adminDocumentStatus: string | null }): boolean {
  return !!p.adminConversionDate && p.adminBookingStatus === SchemeBookingStatus.RECEIVED && adminDocReceived(p.adminDocumentStatus);
}

/**
 * Super Admin verification ("Update"). Persists the Admin's explicit values (source of truth) and enrolls
 * automatically iff the core three hold AND every scheme instance has an Admin billing date. Billing dates
 * are per instance and only accepted once booking + document are both Received (mirrors the UI). Without a
 * date on every instance it saves verification but does NOT enroll.
 */
export async function verifyScheme(ctx: AuthContext, id: string, raw: unknown): Promise<{ enrolled: boolean; eligible: boolean }> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can verify a scheme plan");
  if (raw && typeof raw === "object" && "billing" in raw) billDate.parse((raw as { adminConversionDate?: unknown }).adminConversionDate);
  if (raw && typeof raw === "object" && "billInstances" in raw) throw new ApiError(409, "Instance-owned bill input is no longer supported; reload and use combined plan billing");
  const data = verifySchema.parse(raw);
  if (data.adminBookingStatus === "PARTIAL" && !(data.adminBookingAmount && data.adminBookingAmount > 0)) throw new ApiError(422, "Enter the partial booking amount");
  if (raw && typeof raw === "object" && "billing" in raw) return verifyBills(ctx, id, data, raw.billing);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "DealerSchemePlan" WHERE "id" = ${id} FOR UPDATE`;
  await rejectLegacyBillWrite(id, tx);
  const plan = (await tx.dealerSchemePlan.findUnique({
    where: { id },
    select: { planStatus: true, numberOfSchemes: true, optionBookingAmount: true, scheme: { select: { structure: true, bookingAmount: true } } },
  })) as { planStatus: string; numberOfSchemes: number; optionBookingAmount: unknown; scheme: { structure: string; bookingAmount: unknown } } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.planStatus !== SchemePlanState.APPROVED) throw new ApiError(409, "Only an approved plan can be verified");

  if (data.adminBookingStatus === SchemeBookingStatus.PARTIAL && (data.adminBookingAmount == null || data.adminBookingAmount <= 0)) {
    throw new ApiError(422, "Enter the partial booking amount");
  }

  // Booking coverage (Paid only): validate the selected scheme count and the received amount. Coverage is
  // recorded for reporting/aggregation and does NOT move schemes forward — the SO conversion split is the
  // structural boundary. Skipped when the count is omitted (backward-compatible with pre-feature callers).
  const proceedingSchemes = plan.numberOfSchemes || 1;
  const bookingPerScheme = asNum(plan.scheme.structure === "MULTIPLE_OPTIONS" ? plan.optionBookingAmount : plan.scheme.bookingAmount);
  const recordCoverage = data.adminBookingStatus === SchemeBookingStatus.RECEIVED && data.adminBookingSchemeCount != null;
  if (recordCoverage) {
    const cov = bookingCoverage({
      plannedSchemes: proceedingSchemes,
      selectedCount: data.adminBookingSchemeCount!,
      bookingPerScheme,
      receivedAmount: data.adminBookingAmount ?? 0,
    });
    if (!cov.valid) throw new ApiError(422, cov.error ?? "Invalid booking coverage");
  }
  // The stored coverage count: the selected count for a Paid booking with an explicit selection; otherwise
  // cleared (a non-Paid booking or a legacy call covers nothing explicit).
  const bookingSchemeCount = recordCoverage ? data.adminBookingSchemeCount! : null;
  // A billing date may be saved once booking is Paid — including the special "Question-Mark Converted" case
  // (Paid + document Not Received). Document-received is NOT required to record the date; it remains required
  // for enrollment (see `enrollmentEligible`), so a question-mark plan saves its date but does not enroll.
  const readyForBilling = data.adminBookingStatus === SchemeBookingStatus.RECEIVED;

  const instances = await ensureInstances(id, tx);
  // Resolve the Admin billing date per instance. Same-for-all (default) applies one date to every
  // instance; otherwise use the per-instance array. Billing dates are ignored unless readyForBilling.
  const sameForAll = data.adminBillingSameForAll ?? true;
  const byNum = new Map((data.adminBillingDates ?? []).map((d) => [d.instanceNumber, d.date] as const));
  const dateFor = (instanceNumber: number): Date | null => {
    if (!readyForBilling) return null;
    if (sameForAll) return data.adminBillingDate ?? null;
    return byNum.get(instanceNumber) ?? null;
  };
  if ((data.adminBillingDate || (data.adminBillingDates?.some((d) => d.date))) && !readyForBilling) {
    throw new ApiError(422, "A billing date can only be set once booking is Paid");
  }

  // Same-for-all is the common path and can update every instance in one statement. Distinct dates retain the
  // existing per-instance writes because each row has different data.
  if (sameForAll) await tx.dealerSchemeInstance.updateMany({ where: { id: { in: instances.map((inst) => inst.id) } }, data: { adminBillingDate: dateFor(1) } });
  else for (const inst of instances) await tx.dealerSchemeInstance.update({ where: { id: inst.id }, data: { adminBillingDate: dateFor(inst.instanceNumber) } });
  const everyInstanceBilled = instances.length > 0 && instances.every((inst) => dateFor(inst.instanceNumber) != null);
  const eligible = enrollmentEligible(data) && everyInstanceBilled;

  await tx.dealerSchemePlan.update({
    where: { id },
    data: {
      adminConversionDate: data.adminConversionDate,
      adminBookingStatus: data.adminBookingStatus,
      adminBookingAmount: data.adminBookingStatus === SchemeBookingStatus.NOT_RECEIVED ? null : (data.adminBookingAmount ?? null),
      adminDocumentStatus: data.adminDocumentStatus,
      adminBillingSameForAll: sameForAll,
      // Parent adminBillingDate kept for compat: the single same-for-all date, else null.
      adminBillingDate: sameForAll && readyForBilling ? (data.adminBillingDate ?? null) : null,
      // Pre-placement (Phase 11): only touch when the key is present (undefined ⇒ leave as-is). A non-positive
      // value clears the override so the dealer's requested days apply.
      ...(data.adminPrePlacementDays === undefined ? {} : { adminPrePlacementDays: (data.adminPrePlacementDays ?? 0) > 0 ? data.adminPrePlacementDays : null }),
      verificationRemarks: data.remarks?.trim() || null,
      adminVerifiedById: ctx.userId,
      adminVerifiedAt: new Date(),
      ...(eligible
        ? { enrollmentStatus: SchemeEnrollmentStatus.ENROLLED, enrolledById: ctx.userId, enrolledAt: new Date() }
        : {}),
    },
  });
  // Persist the booking coverage count via raw SQL: the generated Prisma client is not regenerated in this
  // environment, so the new `adminBookingSchemeCount` column is written directly. Additive + null-safe.
  await tx.$executeRaw`UPDATE "DealerSchemePlan" SET "adminBookingSchemeCount" = ${bookingSchemeCount} WHERE "id" = ${id}`;
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: eligible ? "Dealer enrolled after verification" : "Scheme verification saved" }, tx);
  return { enrolled: eligible, eligible };
  });
}

/* --------------------------------- Running Schemes (Sales Officer) --------------------------------- */

export interface RunningSchemeOption {
  id: string; label: string | null; target: number | null; valueWithoutGST: number; valueWithGST: number; isActive: boolean;
}

export interface RunningScheme {
  id: string; schemeName: string; states: string[]; isPerpetual: boolean;
  startDate: string | null; endDate: string | null; bookingLastDate: string | null;
  // MULTIPLE_OPTIONS schemes carry no scheme-level value (null → "Per option"); FIXED schemes always have both.
  schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: number | null; schemeValueWithGST: number | null;
  documentUrl: string | null;
  // Scheme Information shown by Create Plan's "Info" panel + the fields its dealer rows calculate from.
  // Carried on this one list read so opening Info or expanding a scheme needs no further request (and so
  // cannot trigger `refreshSchemeStatuses`, which writes).
  bookingAmount: number | null; otherBenefitDetails: string | null; allowMultipleSchemes: boolean;
  prePlacementMaxDays: number; // Phase 11: master ceiling; 0 ⇒ dealer pre-placement not available
  structure: "FIXED" | "MULTIPLE_OPTIONS"; optionAchievementType: "QUANTITY_BASED" | "VALUE_BASED" | null;
  options: RunningSchemeOption[]; eligibleProductIds: string[];
  installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
}

/** OPEN schemes applicable to the caller's State — the "Running Schemes" tab for a Sales Officer. */
export async function runningSchemes(ctx: AuthContext): Promise<RunningScheme[]> {
  await refreshSchemeStatuses();
  const stateFilter = ctx.role === Role.SUPER_ADMIN || !ctx.groupId ? {} : { states: { some: { groupId: ctx.groupId } } };
  const rows = (await prisma.scheme.findMany({
    where: { status: SchemeStatus.OPEN, ...stateFilter },
    orderBy: [{ isPerpetual: "desc" }, { endDate: "desc" }, { schemeName: "asc" }],
    include: { states: { include: { group: { select: { name: true } } } }, installmentRules: true, options: { orderBy: { sortOrder: "asc" } }, eligibleProducts: { select: { productId: true } } },
  })) as unknown as {
    id: string; schemeName: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; bookingLastDate: Date | null;
    schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: unknown; schemeValueWithGST: unknown; documentUrl: string | null;
    bookingAmount: unknown; otherBenefitDetails: string | null; allowMultipleSchemes: boolean; prePlacementMaxDays: number;
    structure: string; optionAchievementType: string | null;
    installmentRules: { installmentNumber: number; calculationType: string; value: unknown; daysAfterBillingDate: number }[];
    states: { group: { name: string } }[];
    options: { id: string; label: string | null; targetQty: unknown; targetValue: unknown; valueWithoutGST: unknown; valueWithGST: unknown; sortOrder: number; isActive: boolean }[];
    eligibleProducts: { productId: string }[];
  }[];
  const opt = (v: unknown) => (v == null ? null : Number((v as { toString(): string }).toString()));
  return rows.map((s) => ({
    id: s.id,
    schemeName: s.schemeName,
    states: s.states.map((x) => x.group.name),
    isPerpetual: s.isPerpetual,
    startDate: s.startDate?.toISOString() ?? null,
    endDate: s.endDate?.toISOString() ?? null,
    bookingLastDate: s.bookingLastDate?.toISOString() ?? null,
    schemeBenefit: s.schemeBenefit,
    benefitDetails: s.benefitDetails,
    schemeValueWithoutGST: opt(s.schemeValueWithoutGST),
    schemeValueWithGST: opt(s.schemeValueWithGST),
    documentUrl: s.documentUrl,
    bookingAmount: s.bookingAmount == null ? null : Number(s.bookingAmount),
    otherBenefitDetails: s.otherBenefitDetails,
    allowMultipleSchemes: s.allowMultipleSchemes,
    prePlacementMaxDays: s.prePlacementMaxDays ?? 0,
    structure: s.structure as "FIXED" | "MULTIPLE_OPTIONS",
    optionAchievementType: (s.optionAchievementType ?? null) as "QUANTITY_BASED" | "VALUE_BASED" | null,
    options: s.options.map((o) => ({ id: o.id, label: o.label, target: opt(o.targetQty) ?? opt(o.targetValue), valueWithoutGST: Number(o.valueWithoutGST), valueWithGST: Number(o.valueWithGST), isActive: o.isActive })),
    eligibleProductIds: s.eligibleProducts.map((e) => e.productId),
    installments: s.installmentRules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value), daysAfterBillingDate: r.daysAfterBillingDate })),
  }));
}

/* --------------------------------- Planning context + draft (Sales Officer) --------------------------------- */

export interface PlanningDealer { id: string; name: string; territory: string | null }
export interface PlanningExisting { dealerId: string; expectedBillingDate: string | null; planningStatus: string; enrollmentStatus: string; planStatus: string; numberOfSchemes: number; splitRemainder: boolean }
export interface PlanningContext {
  scheme: {
    id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
    bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    allowMultipleSchemes: boolean; documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
  };
  dealers: PlanningDealer[];
  existing: PlanningExisting[];
}

/** Active dealers in an officer's current assignment scope. Shared by the existing scheme-first picker and
 * the Open Schemes dealer-first modal so both entry points expose exactly the same dealer population. */
async function assignedPlanningDealers(officerId: string): Promise<PlanningDealer[]> {
  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const ids = assignments.map((assignment) => assignment.dealerId);
  if (ids.length === 0) return [];
  const dealers = (await prisma.dealer.findMany({
    where: { id: { in: ids }, isActive: true, deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true, town: true, district: true },
  })) as { id: string; name: string; town: string | null; district: string | null }[];
  return dealers.map((dealer) => ({ id: dealer.id, name: dealer.name, territory: dealer.town ?? dealer.district ?? null }));
}

/**
 * Resolve which officer a plan is FOR. Without `officerId` (or when it equals the caller) → the caller.
 * A Regional Manager may target a Sales Officer on their team ("My Team" flow); anyone else is rejected.
 */
async function resolveTargetOfficer(ctx: AuthContext, officerId?: string | null): Promise<string> {
  if (!officerId || officerId === ctx.userId) return ctx.userId;
  if (ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Regional Manager can plan for a team member");
  const scope = await getOfficerScope(ctx);
  if (!scope.ids.includes(officerId)) throw new ApiError(403, "That Sales Officer is not on your team");
  return officerId;
}

/** Sales Officers on the caller RM's team (for the "My Team" dealer-scope dropdown). RM only, excludes self. */
export async function teamOfficers(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  if (ctx.role !== Role.REGIONAL_MANAGER || !ctx.groupId) return [];
  const officers = (await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, groupId: ctx.groupId, isActive: true, deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })) as { id: string; name: string }[];
  return officers;
}

/** Everything the scheme planning page needs: scheme info, assigned dealers of the target officer, and any
 *  already-saved plans for THAT officer + scheme (so a draft re-opens with its dealers/dates loaded).
 *  `officerId` lets an RM plan for a team Sales Officer; omitted → the caller's own dealers. */
export async function planningContext(ctx: AuthContext, schemeId: string, officerId?: string): Promise<PlanningContext> {
  await refreshSchemeStatuses();
  const targetOfficerId = await resolveTargetOfficer(ctx, officerId);
  const scheme = (await prisma.scheme.findUnique({
    where: { id: schemeId },
    include: { installmentRules: true },
  })) as unknown as {
    id: string; schemeName: string; status: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; bookingLastDate: Date | null;
    bookingAmount: unknown; schemeValueWithoutGST: unknown; schemeValueWithGST: unknown; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    allowMultipleSchemes: boolean; documentUrl: string | null; installmentRules: { installmentNumber: number; calculationType: string; value: unknown; daysAfterBillingDate: number }[];
  } | null;
  if (!scheme) throw new ApiError(404, "Scheme not found");

  const dealerRows = await assignedPlanningDealers(targetOfficerId);
  const existingRows = (await prisma.dealerSchemePlan.findMany({
    where: { schemeId, salesOfficerId: targetOfficerId },
    select: { dealerId: true, expectedBillingDate: true, planningStatus: true, enrollmentStatus: true, planStatus: true, numberOfSchemes: true, quantitySplitAsFuture: { select: { id: true } } },
    orderBy: { segmentNumber: "asc" },
  })) as { dealerId: string; expectedBillingDate: Date | null; planningStatus: string; enrollmentStatus: string; planStatus: string; numberOfSchemes: number; quantitySplitAsFuture: { id: string } | null }[];
  // The legacy single-row planning screen cannot render two segments for one dealer. Prefer the editable
  // future remainder when present; otherwise retain the latest historical segment, preserving old behaviour.
  const visibleExisting = new Map<string, (typeof existingRows)[number]>();
  for (const row of existingRows) {
    const current = visibleExisting.get(row.dealerId);
    if (!current || EDITABLE.has(row.planStatus) || !EDITABLE.has(current.planStatus)) visibleExisting.set(row.dealerId, row);
  }

  return {
    scheme: {
      id: scheme.id,
      schemeName: scheme.schemeName,
      isPerpetual: scheme.isPerpetual,
      startDate: scheme.startDate?.toISOString() ?? null,
      endDate: scheme.endDate?.toISOString() ?? null,
      bookingLastDate: scheme.bookingLastDate?.toISOString() ?? null,
      bookingAmount: scheme.bookingAmount == null ? null : Number(scheme.bookingAmount),
      schemeValueWithoutGST: scheme.schemeValueWithoutGST == null ? 0 : Number(scheme.schemeValueWithoutGST),
      schemeValueWithGST: scheme.schemeValueWithGST == null ? 0 : Number(scheme.schemeValueWithGST),
      schemeBenefit: scheme.schemeBenefit,
      benefitDetails: scheme.benefitDetails,
      otherBenefitDetails: scheme.otherBenefitDetails,
      allowMultipleSchemes: scheme.allowMultipleSchemes,
      documentUrl: scheme.documentUrl,
      installments: scheme.installmentRules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value), daysAfterBillingDate: r.daysAfterBillingDate })),
    },
    dealers: dealerRows,
    existing: [...visibleExisting.values()].map((e) => ({ dealerId: e.dealerId, expectedBillingDate: e.expectedBillingDate?.toISOString() ?? null, planningStatus: e.planningStatus, enrollmentStatus: e.enrollmentStatus, planStatus: e.planStatus, numberOfSchemes: e.numberOfSchemes || 1, splitRemainder: !!e.quantitySplitAsFuture })),
  };
}

const draftSchema = z.object({
  schemeId: z.string().min(1),
  officerId: z.string().optional(), // RM "My Team" flow: the Sales Officer the plan is for
  dealers: z.array(z.object({
    dealerId: z.string().min(1),
    expectedBillingDate: z.coerce.date().nullable().optional(),
    numberOfSchemes: z.coerce.number().int().min(1).max(10).optional(), // "Allow Multi Schemes" dealer count
    note: z.string().max(2000).nullable().optional(), // optional per-dealer Sales Officer note
    optionId: z.string().nullable().optional(), // Multiple Options: the dealer's chosen option (null for FIXED)
    prePlacementDays: z.coerce.number().int().min(0).max(365).nullable().optional(), // Phase 11: SO/dealer requested pre-placement days (within the scheme ceiling)
  })).default([]),
  // PARTIAL SUBMISSION (submit only). Which of `dealers` actually go forward for approval; everyone else in
  // the working set is still persisted, but stays a Draft. Omitted → every dealer is submitted, i.e. exactly
  // the previous all-or-nothing behaviour, so existing callers are unaffected.
  submitDealerIds: z.array(z.string().min(1)).optional(),
});

// Statuses the owner may still edit (create/update/remove) as part of their working draft.
// Editable states use planStatus (source of truth): only a Draft or Returned plan may be saved/removed.
const EDITABLE = new Set<string>([SchemePlanState.DRAFT, SchemePlanState.RETURNED]);

export interface PlanningDealerChoices {
  dealers: PlanningDealer[];
  existing: { dealerId: string; schemeId: string; editable: boolean }[];
}

/** Dealer-first data for Sales Officer → Open Schemes → Create Scheme Plan. Existing plan pairs are returned
 * only to keep unavailable dealer/scheme combinations out of the selector; persistence remains authoritative. */
export async function planningDealerChoices(ctx: AuthContext): Promise<PlanningDealerChoices> {
  if (ctx.role !== Role.SALES_OFFICER) throw new ApiError(403, "Only a Sales Officer can create a Scheme Plan from Open Schemes");
  const dealers = await assignedPlanningDealers(ctx.userId);
  if (dealers.length === 0) return { dealers, existing: [] };
  const dealerIds = dealers.map((dealer) => dealer.id);
  const existing = (await prisma.dealerSchemePlan.findMany({
    where: { dealerId: { in: dealerIds } },
    select: { dealerId: true, schemeId: true, salesOfficerId: true, planStatus: true },
  })) as { dealerId: string; schemeId: string; salesOfficerId: string; planStatus: string }[];
  return {
    dealers,
    existing: existing.map((plan) => ({
      dealerId: plan.dealerId,
      schemeId: plan.schemeId,
      editable: plan.salesOfficerId === ctx.userId && EDITABLE.has(plan.planStatus),
    })),
  };
}

/**
 * Persist a working set for one scheme + officer, then optionally submit it. Selected dealers are upserted
 * as DRAFT (or submitted); de-selected DRAFT/RETURNED rows are removed. Rows already in the RM queue or
 * beyond are never touched here. The segment-aware unique key permits split history while this method still
 * accepts at most one editable segment per dealer. A Regional Manager may plan for themselves ("My Dealers")
 * or a team Sales Officer ("My Team").
 *
 * Submission routing: a Sales Officer's plan goes to SUBMITTED (awaiting RM approval); a Regional
 * Manager IS the approver, so an RM-created plan skips RM approval and lands at RM_APPROVED (straight to
 * Admin document verification).
 *
 * Partial submission: on submit, `submitDealerIds` may name a SUBSET of `dealers` to send for approval. The
 * rest of the working set is still written (as Draft), so an incomplete dealer is never discarded and never
 * submitted. Omit `submitDealerIds` for the original all-or-nothing behaviour.
 */
async function persistDraft(ctx: AuthContext, raw: unknown, submit: boolean): Promise<{ drafted: number; submitted: number }> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can plan dealers");
  const data = draftSchema.parse(raw);
  await refreshSchemeStatuses();
  const targetOfficerId = await resolveTargetOfficer(ctx, data.officerId);
  const isRm = ctx.role === Role.REGIONAL_MANAGER;

  const scheme = (await prisma.scheme.findUnique({ where: { id: data.schemeId }, select: { status: true, isPerpetual: true, startDate: true, endDate: true, allowMultipleSchemes: true, schemeValueWithGST: true, bookingAmount: true, installmentBalance: true, structure: true, prePlacementMaxDays: true, states: { select: { groupId: true } }, options: { select: { id: true, label: true, targetQty: true, targetValue: true, valueWithoutGST: true, valueWithGST: true, bookingAmount: true, isActive: true } } } })) as
    { status: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; allowMultipleSchemes: boolean; schemeValueWithGST: unknown; bookingAmount: unknown; installmentBalance: boolean; structure: string; prePlacementMaxDays: number; states: { groupId: string }[]; options: { id: string; label: string | null; targetQty: unknown; targetValue: unknown; valueWithoutGST: unknown; valueWithGST: unknown; bookingAmount: unknown; isActive: boolean }[] } | null;
  if (!scheme) throw new ApiError(404, "Scheme not found");
  if (scheme.status !== SchemeStatus.OPEN) throw new ApiError(422, "This scheme is closed");
  if (ctx.groupId && !scheme.states.some((s) => s.groupId === ctx.groupId)) throw new ApiError(422, "This scheme is not applicable to your State");
  const isOptions = scheme.structure === "MULTIPLE_OPTIONS";
  const optionsById = new Map(scheme.options.map((o) => [o.id, o]));
  const fixedGst = scheme.schemeValueWithGST == null ? 0 : Number((scheme.schemeValueWithGST as { toString(): string }).toString());
  // Effective With-GST value for a dealer row: the chosen option's value for MULTIPLE_OPTIONS, else the
  // scheme-level value. Feeds totalSchemeAmount and (post-enrollment) the installment schedule.
  const effGstFor = (optionId?: string | null) => (isOptions ? (optionId && optionsById.get(optionId) ? Number((optionsById.get(optionId)!.valueWithGST as { toString(): string }).toString()) : 0) : fixedGst);
  // Number of schemes only applies when the scheme allows it; otherwise every dealer is exactly 1.
  const countFor = (n?: number) => (scheme.allowMultipleSchemes ? Math.min(Math.max(n ?? 1, 1), 10) : 1);

  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId: targetOfficerId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const assigned = new Set(assignments.map((a) => a.dealerId));

  const validateDate = (date: Date | null | undefined) => {
    if (!date) return null;
    if (scheme.startDate && date < scheme.startDate) throw new ApiError(422, "Conversion Date is before the scheme start date");
    if (!scheme.isPerpetual && scheme.endDate && date > scheme.endDate) throw new ApiError(422, "Conversion Date is after the scheme end date");
    return date;
  };

  for (const d of data.dealers) if (!assigned.has(d.dealerId)) throw new ApiError(422, "A selected dealer is not assigned to the selected Sales Officer");

  // Which dealers of the working set are going forward. Draft saves submit nobody; a submit without an
  // explicit subset submits everybody (unchanged behaviour).
  const inPayload = new Set(data.dealers.map((d) => d.dealerId));
  const submitSet = new Set<string>(submit ? (data.submitDealerIds ?? [...inPayload]) : []);
  const goesForward = (dealerId: string) => submitSet.has(dealerId);
  const managerId = isRm ? null : await getCurrentManagerId(targetOfficerId);
  const toRm = managerId != null;
  return prisma.$transaction(async (tx) => {
    // Read the editable working set through the same transaction that mutates it, so the status/segment
    // decisions and every resulting write share one rollback boundary.
    const existing = (await tx.dealerSchemePlan.findMany({
      where: { schemeId: data.schemeId, salesOfficerId: targetOfficerId },
      select: {
        id: true, dealerId: true, planStatus: true, segmentNumber: true, numberOfSchemes: true,
        totalSchemeAmount: true, selectedOptionId: true, installmentBalance: true,
        optionLabel: true, optionTargetQty: true, optionTargetValue: true,
        optionValueWithoutGST: true, optionValueWithGST: true, optionBookingAmount: true,
        quantitySplitAsFuture: { select: { sourcePlanId: true, remainingQuantity: true } },
      },
    })) as {
      id: string; dealerId: string; planStatus: string; segmentNumber: number; numberOfSchemes: number;
      totalSchemeAmount: unknown; selectedOptionId: string | null; installmentBalance: boolean;
      optionLabel: string | null; optionTargetQty: unknown; optionTargetValue: unknown;
      optionValueWithoutGST: unknown; optionValueWithGST: unknown; optionBookingAmount: unknown;
      quantitySplitAsFuture: { sourcePlanId: string; remainingQuantity: number } | null;
    }[];
    const allByDealer = new Map<string, typeof existing>();
    for (const row of existing) allByDealer.set(row.dealerId, [...(allByDealer.get(row.dealerId) ?? []), row]);
    const editableByDealer = new Map<string, (typeof existing)[number]>();
    for (const [dealerId, rows] of allByDealer) {
      const editable = rows.filter((row) => EDITABLE.has(row.planStatus));
      if (editable.length > 1) throw new ApiError(409, "Multiple editable segments exist for this dealer and scheme; resolve the historical records before continuing");
      if (editable[0]) editableByDealer.set(dealerId, editable[0]);
    }

    if (submit) {
      for (const id of submitSet) if (!inPayload.has(id)) throw new ApiError(422, "A dealer marked for submission is not part of this plan");
      if (submitSet.size === 0) throw new ApiError(422, "Select at least one dealer to submit");
      // Only the dealers actually going forward must be complete; the others stay in Draft on purpose.
      for (const d of data.dealers) if (goesForward(d.dealerId) && !d.expectedBillingDate) throw new ApiError(422, "Every dealer needs a Conversion Date before submitting");
      // Multiple Options: a dealer being submitted must have selected exactly one ACTIVE option (server-enforced).
      if (isOptions) {
        for (const d of data.dealers) {
          if (!goesForward(d.dealerId)) continue;
          const frozenRemainder = editableByDealer.get(d.dealerId)?.quantitySplitAsFuture;
          const opt = d.optionId ? optionsById.get(d.optionId) : null;
          if (!opt) throw new ApiError(422, "Every dealer must select a scheme option before submitting");
          if (!frozenRemainder && !opt.isActive) throw new ApiError(422, "A selected option has been discontinued — choose an active option");
        }
      }
    }
    // Even on draft save, a provided option must belong to this scheme (never trust the client).
    if (isOptions) for (const d of data.dealers) if (d.optionId && !optionsById.has(d.optionId)) throw new ApiError(422, "Selected option does not belong to this scheme");

    const selected = new Set(data.dealers.map((d) => d.dealerId));

    let drafted = 0;
    let submitted = 0;
    // Old status (kept in sync during migration) + new Part E planStatus, resolved PER DEALER so a partial
    // submission can promote some rows while the rest are written as Draft in the same call.
    // RM approval is required ONLY when the plan owner (targetOfficerId) actually has an applicable RM, using
    // getCurrentManagerId — the SAME group-based authority as Seasonal/Monthly/Recovery. RM-created plans skip
    // RM approval (RM is the approver) → Pending Approval (Admin), unchanged. An SO with no RM in their group
    // ALSO skips → Pending Approval, so the plan is never stuck at a Pending-for-RM stage no one can action.
    const legacyNextFor = (forward: boolean) => (forward ? (toRm ? SchemePlanStatus.SUBMITTED : SchemePlanStatus.RM_APPROVED) : SchemePlanStatus.DRAFT);
    const planNextFor = (forward: boolean) => (forward ? (toRm ? SchemePlanState.PENDING_RM : SchemePlanState.PENDING_APPROVAL) : SchemePlanState.DRAFT);
    const submitStampFor = (forward: boolean) => (forward ? { submittedAt: new Date(), ...(isRm ? { rmActedById: ctx.userId, rmActedAt: new Date(), rmRemarks: null } : { rmActedById: null, rmActedAt: null, rmRemarks: null }) } : {});

    const num = (v: unknown) => (v == null ? null : Number((v as { toString(): string }).toString()));
    const affectedIds: string[] = [];
    const planCreates: Prisma.DealerSchemePlanCreateManyInput[] = [];
    const planUpdates: { id: string; data: Prisma.DealerSchemePlanUncheckedUpdateInput }[] = [];
    for (const d of data.dealers) {
      const date = validateDate(d.expectedBillingDate ?? null);
      const cur = editableByDealer.get(d.dealerId);
      // Locked history may still be present in legacy callers' working-set payloads. It is display-only here:
      // leave it untouched and, critically, do not create another segment outside the split service.
      if (!cur && (allByDealer.get(d.dealerId)?.length ?? 0) > 0) continue;
      const frozenRemainder = cur?.quantitySplitAsFuture ?? null;
      const requestedCount = countFor(d.numberOfSchemes);
      if (frozenRemainder && requestedCount !== cur!.numberOfSchemes) {
        throw new ApiError(422, `The future segment quantity is fixed at ${cur!.numberOfSchemes}; it cannot be changed in Create Plan`);
      }
      if (frozenRemainder && (d.optionId ?? null) !== cur!.selectedOptionId) {
        throw new ApiError(422, "The scheme option is frozen from the original approved plan and cannot be changed for its future segment");
      }
      const count = frozenRemainder ? cur!.numberOfSchemes : requestedCount;
      const forward = goesForward(d.dealerId);
      // Effective per-scheme value: option value (Multiple Options) or scheme value (Fixed).
      const total = frozenRemainder ? num(cur!.totalSchemeAmount) ?? 0 : effGstFor(d.optionId) * count;
      // Option fields. Always store selectedOptionId (draft may be incomplete → null). Freeze the snapshot
      // ONLY when the row goes forward (submit) so master option edits during approval can't move a committed
      // dealer; refresh the snapshot from the live option on each (re)submission (e.g. after RETURNED).
      const opt = isOptions && d.optionId ? optionsById.get(d.optionId) : null;
      const optionData = frozenRemainder
        ? { selectedOptionId: cur!.selectedOptionId }
        : isOptions
        ? {
            selectedOptionId: d.optionId ?? null,
            ...(forward && opt
              ? { optionLabel: opt.label, optionTargetQty: num(opt.targetQty), optionTargetValue: num(opt.targetValue), optionValueWithoutGST: num(opt.valueWithoutGST), optionValueWithGST: num(opt.valueWithGST), optionBookingAmount: num(opt.bookingAmount) ?? num(scheme.bookingAmount) ?? 0 }
              : {}),
          }
        : {};
      // Optional per-dealer note. Only applied when the payload carries the key (undefined = leave unchanged);
      // an empty/whitespace note clears it. Notes never gate save/submit.
      const noteData = d.note === undefined ? {} : { soNote: d.note?.trim() || null };
      // Pre-placement (Phase 11): SO/dealer requested days, clamped to the scheme ceiling. undefined ⇒ leave
      // unchanged; only meaningful when the scheme allows pre-placement (prePlacementMaxDays > 0).
      const preData = d.prePlacementDays === undefined
        ? {}
        : { prePlacementDays: scheme.prePlacementMaxDays > 0 && (d.prePlacementDays ?? 0) > 0 ? Math.min(d.prePlacementDays as number, scheme.prePlacementMaxDays) : null };
      const legacyNext = legacyNextFor(forward);
      const planNext = planNextFor(forward);
      const submitStamp = { ...submitStampFor(forward), ...(forward ? { installmentBalance: frozenRemainder ? cur!.installmentBalance : scheme.installmentBalance } : {}) };
      if (!cur) {
        // While the plan is editable, the original (extension baseline) tracks the planned conversion date.
        planCreates.push({ schemeId: data.schemeId, dealerId: d.dealerId, salesOfficerId: targetOfficerId, segmentNumber: 1, planningStatus: legacyNext, planStatus: planNext, numberOfSchemes: count, totalSchemeAmount: total, expectedBillingDate: date, originalConversionDate: date, ...noteData, ...optionData, ...preData, ...submitStamp });
        if (forward) submitted++; else drafted++;
      } else if (EDITABLE.has(cur.planStatus)) {
        planUpdates.push({ id: cur.id, data: { expectedBillingDate: date, originalConversionDate: date, planningStatus: legacyNext, planStatus: planNext, numberOfSchemes: count, totalSchemeAmount: total, ...noteData, ...optionData, ...preData, ...submitStamp } });
        if (forward) submitted++; else drafted++;
      }
      // else: locked (already in RM queue or beyond) — leave untouched.
    }

    // New dealer plans have independent data but no generated id dependencies until instance expansion, so
    // PostgreSQL can create and return all of them in one round trip. Existing rows retain their exact
    // per-record update semantics because their payloads may differ.
    if (planCreates.length > 0) {
      const created = await tx.dealerSchemePlan.createManyAndReturn({ data: planCreates, select: { id: true } });
      affectedIds.push(...created.map((plan) => plan.id));
    }
    for (const update of planUpdates) {
      await tx.dealerSchemePlan.update({ where: { id: update.id }, data: update.data });
      affectedIds.push(update.id);
    }

    // Remove editable rows de-selected from this officer's working draft.
    const omittedSplitRemainder = existing.find((e) => EDITABLE.has(e.planStatus) && e.quantitySplitAsFuture && !selected.has(e.dealerId));
    if (omittedSplitRemainder) throw new ApiError(422, "A future quantity segment cannot be removed from Create Plan; choose its outcome when converting that segment");
    const toRemove = existing.filter((e) => EDITABLE.has(e.planStatus) && !e.quantitySplitAsFuture && !selected.has(e.dealerId)).map((e) => e.id);
    if (toRemove.length) await tx.dealerSchemePlan.deleteMany({ where: { id: { in: toRemove } } });

    // Explicit new-flow expansion retains the same preservation rules, but batches the whole working set.
    await expandInstancesForPlans(affectedIds, tx);

    await writeAudit({ userId: ctx.userId, action: submit ? "UPDATE" : "CREATE", entity: "dealerSchemePlan", entityId: data.schemeId, summary: submit ? `Scheme plan submitted (${submitted} dealers${drafted ? `, ${drafted} kept in draft` : ""})` : `Scheme draft saved (${drafted} dealers)` }, tx);
    return { drafted, submitted };
  }, { timeout: 15000 });
}

export function saveSchemeDraft(ctx: AuthContext, raw: unknown) {
  return persistDraft(ctx, raw, false);
}
export function submitSchemeDraft(ctx: AuthContext, raw: unknown) {
  return persistDraft(ctx, raw, true);
}

/* --------------------------------- Scheme Status / conversion (Sales Officer) --------------------------------- */

const conversionSchema = z.object({
  schemeStatus: z.nativeEnum(SchemeConversionStatus),
  proceedingSchemes: z.coerce.number().int().min(1).max(10).optional(),
  remainingDisposition: z.enum(["CANCELLED", "FUTURE_DRAFT"]).nullable().optional(),
  conversionDate: z.coerce.date().nullable().optional(),
  soBookingStatus: z.nativeEnum(SchemeBookingStatus).nullable().optional(),
  soBookingAmount: z.coerce.number().min(0).nullable().optional(),
  soDocumentStatus: z.nativeEnum(SchemeSoDocStatus).nullable().optional(),
  billingSameForAll: z.boolean().optional(),
  billingDate: z.coerce.date().nullable().optional(), // single (same-for-all) — legacy/compat
  billingDates: z.array(z.object({ instanceNumber: z.coerce.number().int().min(1).max(10), date: z.coerce.date().nullable() })).optional(),
});

/**
 * Sales Officer sets the Scheme Status (Pending / Converted / Declined) on an APPROVED plan and, when
 * marking Converted, records the conversion entry (conversion date, booking status/amount, document
 * status, billing date). No approval follows this stage — these values are shown to SO/RM/Admin, and the
 * Admin later verifies them (Phase 4). RM/Admin (in scope) may also record on behalf.
 */
export async function saveConversion(ctx: AuthContext, planId: string, raw: unknown): Promise<{ ok: true }> {
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id: planId }, select: { salesOfficerId: true, planStatus: true } })) as { salesOfficerId: string; planStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(plan.salesOfficerId)) throw new ApiError(403, "You cannot manage this scheme plan");
  if (plan.planStatus !== SchemePlanState.APPROVED) throw new ApiError(409, "Scheme Status can only be set after the plan is Approved");

  if (raw && typeof raw === "object" && "billing" in raw && "conversionDate" in raw && raw.conversionDate != null) billDate.parse(raw.conversionDate);
  if (raw && typeof raw === "object" && "billInstances" in raw) throw new ApiError(409, "Instance-owned bill input is no longer supported; reload and use combined plan billing");
  const data = conversionSchema.parse(raw);
  if (data.schemeStatus === "CONVERTED" && data.soBookingStatus === "PARTIAL" && !(data.soBookingAmount && data.soBookingAmount > 0)) throw new ApiError(422, "Enter the partial booking amount");
  if (raw && typeof raw === "object" && "billing" in raw) return saveBillConversion(ctx, planId, data, raw.billing);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "DealerSchemePlan" WHERE "id" = ${planId} FOR UPDATE`;
  const converting = data.schemeStatus === SchemeConversionStatus.CONVERTED;
  if (converting) await applyConversionQuantity(tx, ctx, planId, data);
  await rejectLegacyBillWrite(planId, tx);
  if (converting && data.soBookingStatus === SchemeBookingStatus.PARTIAL && (data.soBookingAmount == null || data.soBookingAmount <= 0)) {
    throw new ApiError(422, "Enter the partial booking amount");
  }

  // Per-instance SO billing dates. Same-for-all (default) applies one date to every instance; otherwise
  // the per-instance array. Cleared when not Converted. SO dates are informational; Admin dates are truth.
  const instances = await ensureInstances(planId, tx);
  const sameForAll = data.billingSameForAll ?? true;
  const byNum = new Map((data.billingDates ?? []).map((d) => [d.instanceNumber, d.date] as const));
  const soDateFor = (instanceNumber: number): Date | null => {
    if (!converting) return null;
    return sameForAll ? (data.billingDate ?? null) : (byNum.get(instanceNumber) ?? null);
  };
  if (sameForAll) await tx.dealerSchemeInstance.updateMany({ where: { id: { in: instances.map((inst) => inst.id) } }, data: { soBillingDate: soDateFor(1) } });
  else for (const inst of instances) await tx.dealerSchemeInstance.update({ where: { id: inst.id }, data: { soBillingDate: soDateFor(inst.instanceNumber) } });

  await tx.dealerSchemePlan.update({
    where: { id: planId },
    data: {
      schemeStatus: data.schemeStatus,
      conversionDate: converting ? data.conversionDate ?? null : null,
      soBookingStatus: converting ? data.soBookingStatus ?? null : null,
      soBookingAmount: converting && data.soBookingStatus === SchemeBookingStatus.PARTIAL ? data.soBookingAmount ?? null : (converting ? (data.soBookingAmount ?? null) : null),
      soDocumentStatus: converting ? data.soDocumentStatus ?? null : null,
      soBillingSameForAll: sameForAll,
      // Parent billingDate kept for compat: the single same-for-all SO date when Converted, else null.
      billingDate: converting && sameForAll ? (data.billingDate ?? null) : null,
    },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: planId, summary: `Scheme status set to ${data.schemeStatus}` }, tx);
  return { ok: true };
  });
}

/* --------------------------------- Conversion Date Extension --------------------------------- */

// Calendar-day difference, date-only (ignores time-of-day / timezone drift). b − a in whole days.
const dayIndexUTC = (d: Date) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
const dayDiff = (a: Date, b: Date) => dayIndexUTC(b) - dayIndexUTC(a);

const extendSchema = z.object({ newConversionDate: z.coerce.date() });

/**
 * Extend a dealer plan's planned Conversion Date. The ORIGINAL date is the permanent baseline: every
 * extension is measured against it, so the allowance never resets. Enforced server-side:
 *   - role SO/RM within scope (Admin cannot extend — view only); owner's plan
 *   - scheme has extension configured (maxDays > 0; maxAttempts is -1 unlimited or a positive limit)
 *   - plan status still allows conversion-date changes (submitted, not converted, not Admin-verified)
 *   - attempts remaining, cumulative days ≤ maxDays, new date ≤ original + maxDays, new date after current
 * The write (history row + plan update + count increment) runs in one transaction; the unique
 * (planId, extensionNumber) guards against a double-submit racing in a second extension.
 */
export async function extendConversionDate(ctx: AuthContext, planId: string, raw: unknown): Promise<{ ok: true; newConversionDate: string; extensionNumber: number }> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only the responsible Sales Officer can extend a conversion date");
  const { newConversionDate } = extendSchema.parse(raw);
  const scope = await getOfficerScope(ctx);
  const plan = (await prisma.dealerSchemePlan.findUnique({
    where: { id: planId },
    select: {
      salesOfficerId: true, planStatus: true, schemeStatus: true, adminVerifiedAt: true,
      expectedBillingDate: true, originalConversionDate: true, conversionExtensionCount: true,
      scheme: { select: { maxExtensionDays: true, maxExtensionAttempts: true } },
    },
  })) as {
    salesOfficerId: string; planStatus: string; schemeStatus: string; adminVerifiedAt: Date | null;
    expectedBillingDate: Date | null; originalConversionDate: Date | null; conversionExtensionCount: number;
    scheme: { maxExtensionDays: number; maxExtensionAttempts: number };
  } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (!scope.all && !scope.ids.includes(plan.salesOfficerId)) throw new ApiError(403, "You cannot extend this scheme plan");

  const maxDays = plan.scheme.maxExtensionDays ?? 0;
  const maxAttempts = plan.scheme.maxExtensionAttempts ?? 0;
  if (maxDays <= 0 || !extensionAttemptsEnabled(maxAttempts)) throw new ApiError(422, "Conversion Date extension is not enabled for this scheme");

  // Only extendable while the plan is live and the conversion has not been recorded/verified yet.
  const statusOk = isConversionExtensionStatusEligible(plan.planStatus, plan.schemeStatus, plan.adminVerifiedAt != null);
  if (!statusOk) throw new ApiError(409, "The conversion date can no longer be extended for this plan");

  const current = plan.expectedBillingDate;
  if (!current) throw new ApiError(422, "This plan has no conversion date to extend");
  const original = plan.originalConversionDate ?? current; // legacy plans: capture baseline now

  const attemptsUsed = plan.conversionExtensionCount ?? 0;
  if (!hasExtensionAttemptsRemaining(attemptsUsed, maxAttempts)) throw new ApiError(422, "No extension attempts remaining");

  const daysUsed = dayDiff(original, current); // ≥ 0
  const ceiling = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth(), original.getUTCDate()) + maxDays * 86_400_000);
  const daysAdded = dayDiff(current, newConversionDate);
  if (daysAdded < 1) throw new ApiError(422, "The new date must be after the current conversion date");
  if (dayDiff(newConversionDate, ceiling) < 0) throw new ApiError(422, "The new date exceeds the maximum allowed extension");
  if (!isWithinConversionExtensionDayLimit(maxDays, daysUsed, daysAdded)) throw new ApiError(422, `Only ${maxDays - daysUsed} extension day(s) remaining`);

  const extensionNumber = attemptsUsed + 1;
  await prisma.$transaction([
    prisma.schemeConversionExtension.create({
      data: { planId, extensionNumber, originalConversionDate: original, previousConversionDate: current, newConversionDate, daysAdded, extendedById: ctx.userId },
    }),
    prisma.dealerSchemePlan.update({
      where: { id: planId },
      data: { expectedBillingDate: newConversionDate, originalConversionDate: original, conversionExtensionCount: { increment: 1 } },
    }),
  ]);
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: planId, summary: `Conversion date extended (+${daysAdded}d, #${extensionNumber})` });
  return { ok: true, newConversionDate: newConversionDate.toISOString(), extensionNumber };
}
