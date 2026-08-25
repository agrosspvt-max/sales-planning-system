import "server-only";
import { Role, SchemeStatus, SchemePlanStatus, SchemeEnrollmentStatus, SchemePlanState, SchemeConversionStatus, SchemeBookingStatus, SchemeSoDocStatus, SchemeAdminDocStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { refreshSchemeStatuses } from "./scheme-master.server";

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
  numberOfSchemes: number;
  totalSchemeAmount: number;
  planningDate: string | null; // when the SO submitted the plan (= submittedAt)
  conversionDate: string | null;
  soBookingStatus: string | null;
  soBookingAmount: number | null;
  soDocumentStatus: string | null;
  billingDate: string | null;
  adminConversionDate: string | null;
  adminBookingStatus: string | null;
  adminBookingAmount: number | null;
  adminDocumentStatus: string | null;
  adminBillingDate: string | null;
  adminVerifiedAt: string | null;
}

type RawPlan = {
  id: string; schemeId: string; dealerId: string; salesOfficerId: string; planningStatus: string; enrollmentStatus: string;
  expectedBillingDate: Date | null; submittedAt: Date | null; rmActedAt: Date | null; rmRemarks: string | null; documentCompleted: boolean; documentType: string | null;
  verificationRemarks: string | null; enrolledAt: Date | null; createdAt: Date;
  planStatus: string; schemeStatus: string; numberOfSchemes: number; totalSchemeAmount: unknown;
  conversionDate: Date | null; soBookingStatus: string | null; soBookingAmount: unknown; soDocumentStatus: string | null; billingDate: Date | null;
  adminConversionDate: Date | null; adminBookingStatus: string | null; adminBookingAmount: unknown; adminDocumentStatus: string | null; adminBillingDate: Date | null; adminVerifiedAt: Date | null;
  scheme: { schemeName: string; schemeValueWithGST: unknown };
  dealer: { name: string };
  salesOfficer: { name: string; territory: string | null; group: { name: string } | null };
  rmActedBy: { name: string } | null;
  enrolledBy: { name: string } | null;
};
const PLAN_INCLUDE = {
  scheme: { select: { schemeName: true, schemeValueWithGST: true } },
  dealer: { select: { name: true } },
  salesOfficer: { select: { name: true, territory: true, group: { select: { name: true } } } },
  rmActedBy: { select: { name: true } },
  enrolledBy: { select: { name: true } },
} as const;

const asNum = (v: unknown): number => (v == null ? 0 : Number(v.toString()));

function toPlanRow(r: RawPlan): SchemePlanRow {
  const total = r.totalSchemeAmount != null ? asNum(r.totalSchemeAmount) : asNum(r.scheme.schemeValueWithGST) * (r.numberOfSchemes || 1);
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
    numberOfSchemes: r.numberOfSchemes || 1,
    totalSchemeAmount: total,
    planningDate: r.submittedAt?.toISOString() ?? null,
    conversionDate: r.conversionDate?.toISOString() ?? null,
    soBookingStatus: r.soBookingStatus,
    soBookingAmount: r.soBookingAmount == null ? null : asNum(r.soBookingAmount),
    soDocumentStatus: r.soDocumentStatus,
    billingDate: r.billingDate?.toISOString() ?? null,
    adminConversionDate: r.adminConversionDate?.toISOString() ?? null,
    adminBookingStatus: r.adminBookingStatus,
    adminBookingAmount: r.adminBookingAmount == null ? null : asNum(r.adminBookingAmount),
    adminDocumentStatus: r.adminDocumentStatus,
    adminBillingDate: r.adminBillingDate?.toISOString() ?? null,
    adminVerifiedAt: r.adminVerifiedAt?.toISOString() ?? null,
  };
}

/* --------------------------------- Listing --------------------------------- */

/** Scoped list: SO → own; RM → their team; Admin → all. Optional `schemeId` filter (for the detail view). */
export async function listSchemePlans(ctx: AuthContext, schemeId?: string): Promise<SchemePlanRow[]> {
  const scope = await getOfficerScope(ctx);
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { ...(schemeId ? { schemeId } : {}), ...(scope.all ? {} : { salesOfficerId: { in: scope.ids } }) },
    include: PLAN_INCLUDE,
    orderBy: { createdAt: "desc" },
  })) as unknown as RawPlan[];
  return rows.map(toPlanRow);
}

export async function getSchemePlan(ctx: AuthContext, id: string): Promise<SchemePlanRow> {
  const r = (await prisma.dealerSchemePlan.findUnique({ where: { id }, include: PLAN_INCLUDE })) as unknown as RawPlan | null;
  if (!r) throw new ApiError(404, "Scheme plan not found");
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(r.salesOfficerId)) throw new ApiError(403, "You cannot view this scheme plan");
  return toPlanRow(r);
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

  const dup = await prisma.dealerSchemePlan.findUnique({ where: { schemeId_dealerId: { schemeId, dealerId } }, select: { id: true } });
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
  const nextPlan = isRm ? SchemePlanState.PENDING_APPROVAL : SchemePlanState.PENDING_RM;
  const legacy = isRm ? SchemePlanStatus.RM_APPROVED : SchemePlanStatus.SUBMITTED;
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

/* --------------------------------- Admin verification + enrollment --------------------------------- */

const verifySchema = z.object({
  adminConversionDate: z.coerce.date().nullable().optional(),
  adminBookingStatus: z.nativeEnum(SchemeBookingStatus).nullable().optional(),
  adminBookingAmount: z.coerce.number().min(0).nullable().optional(),
  adminDocumentStatus: z.nativeEnum(SchemeAdminDocStatus).nullable().optional(),
  adminBillingDate: z.coerce.date().nullable().optional(),
  remarks: z.string().max(500).optional(),
  enroll: z.boolean().optional(), // request enrollment (only allowed when payment + document are complete)
});

/** Enrollment is allowed only when payment is RECEIVED and the document is RECEIVED (soft or hard). */
export function enrollmentEligible(adminBookingStatus: string | null, adminDocumentStatus: string | null): boolean {
  const paymentOk = adminBookingStatus === SchemeBookingStatus.RECEIVED;
  const docOk = adminDocumentStatus === SchemeAdminDocStatus.RECEIVED_SOFT || adminDocumentStatus === SchemeAdminDocStatus.RECEIVED_HARD;
  return paymentOk && docOk;
}

/**
 * Super Admin verification (final source of truth). Records the admin's verified values (which override
 * the SO's). Verification does NOT enroll on its own — Save just persists the admin values and stamps
 * adminVerifiedAt. Enrollment happens ONLY when `enroll` is requested AND payment + document are complete;
 * it then activates the (untouched) Enrolled installment module via enrollmentStatus = ENROLLED.
 */
export async function verifyScheme(ctx: AuthContext, id: string, raw: unknown): Promise<{ enrolled: boolean; eligible: boolean }> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can verify a scheme plan");
  const data = verifySchema.parse(raw);
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { planStatus: true } })) as { planStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.planStatus !== SchemePlanState.APPROVED) throw new ApiError(409, "Only an approved plan can be verified");

  if (data.adminBookingStatus === SchemeBookingStatus.PARTIAL && (data.adminBookingAmount == null || data.adminBookingAmount <= 0)) {
    throw new ApiError(422, "Enter the partial booking amount");
  }
  const eligible = enrollmentEligible(data.adminBookingStatus ?? null, data.adminDocumentStatus ?? null);
  const enroll = !!data.enroll;
  if (enroll && !eligible) throw new ApiError(422, "Enrollment requires payment Received and document Received");

  await prisma.dealerSchemePlan.update({
    where: { id },
    data: {
      adminConversionDate: data.adminConversionDate ?? null,
      adminBookingStatus: data.adminBookingStatus ?? null,
      adminBookingAmount: data.adminBookingAmount ?? null,
      adminDocumentStatus: data.adminDocumentStatus ?? null,
      adminBillingDate: data.adminBillingDate ?? null,
      verificationRemarks: data.remarks?.trim() || null,
      adminVerifiedById: ctx.userId,
      adminVerifiedAt: new Date(),
      // Enroll only on explicit request + eligibility → activates the Enrolled installment module.
      ...(enroll
        ? { enrollmentStatus: SchemeEnrollmentStatus.ENROLLED, enrolledById: ctx.userId, enrolledAt: new Date() }
        : {}),
    },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: enroll ? "Dealer enrolled after verification" : "Scheme verification saved" });
  return { enrolled: enroll, eligible };
}

/* --------------------------------- Running Schemes (Sales Officer) --------------------------------- */

export interface RunningScheme {
  id: string; schemeName: string; states: string[]; isPerpetual: boolean;
  startDate: string | null; endDate: string | null; bookingLastDate: string | null;
  schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number;
  documentUrl: string | null;
}

/** OPEN schemes applicable to the caller's State — the "Running Schemes" tab for a Sales Officer. */
export async function runningSchemes(ctx: AuthContext): Promise<RunningScheme[]> {
  await refreshSchemeStatuses();
  const stateFilter = ctx.role === Role.SUPER_ADMIN || !ctx.groupId ? {} : { states: { some: { groupId: ctx.groupId } } };
  const rows = (await prisma.scheme.findMany({
    where: { status: SchemeStatus.OPEN, ...stateFilter },
    orderBy: [{ isPerpetual: "desc" }, { endDate: "desc" }, { schemeName: "asc" }],
    include: { states: { include: { group: { select: { name: true } } } } },
  })) as unknown as {
    id: string; schemeName: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; bookingLastDate: Date | null;
    schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: unknown; schemeValueWithGST: unknown; documentUrl: string | null;
    states: { group: { name: string } }[];
  }[];
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
    schemeValueWithoutGST: Number(s.schemeValueWithoutGST),
    schemeValueWithGST: Number(s.schemeValueWithGST),
    documentUrl: s.documentUrl,
  }));
}

/* --------------------------------- Planning context + draft (Sales Officer) --------------------------------- */

export interface PlanningDealer { id: string; name: string; territory: string | null }
export interface PlanningExisting { dealerId: string; expectedBillingDate: string | null; planningStatus: string; enrollmentStatus: string; planStatus: string; numberOfSchemes: number }
export interface PlanningContext {
  scheme: {
    id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
    bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    allowMultipleSchemes: boolean; documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
  };
  dealers: PlanningDealer[];
  existing: PlanningExisting[];
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

  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId: targetOfficerId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const ids = assignments.map((a) => a.dealerId);
  const dealerRows = ids.length
    ? ((await prisma.dealer.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, town: true, district: true } })) as { id: string; name: string; town: string | null; district: string | null }[])
    : [];
  const existingRows = (await prisma.dealerSchemePlan.findMany({
    where: { schemeId, salesOfficerId: targetOfficerId },
    select: { dealerId: true, expectedBillingDate: true, planningStatus: true, enrollmentStatus: true, planStatus: true, numberOfSchemes: true },
  })) as { dealerId: string; expectedBillingDate: Date | null; planningStatus: string; enrollmentStatus: string; planStatus: string; numberOfSchemes: number }[];

  return {
    scheme: {
      id: scheme.id,
      schemeName: scheme.schemeName,
      isPerpetual: scheme.isPerpetual,
      startDate: scheme.startDate?.toISOString() ?? null,
      endDate: scheme.endDate?.toISOString() ?? null,
      bookingLastDate: scheme.bookingLastDate?.toISOString() ?? null,
      bookingAmount: scheme.bookingAmount == null ? null : Number(scheme.bookingAmount),
      schemeValueWithoutGST: Number(scheme.schemeValueWithoutGST),
      schemeValueWithGST: Number(scheme.schemeValueWithGST),
      schemeBenefit: scheme.schemeBenefit,
      benefitDetails: scheme.benefitDetails,
      otherBenefitDetails: scheme.otherBenefitDetails,
      allowMultipleSchemes: scheme.allowMultipleSchemes,
      documentUrl: scheme.documentUrl,
      installments: scheme.installmentRules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value), daysAfterBillingDate: r.daysAfterBillingDate })),
    },
    dealers: dealerRows.map((d) => ({ id: d.id, name: d.name, territory: d.town ?? d.district ?? null })),
    existing: existingRows.map((e) => ({ dealerId: e.dealerId, expectedBillingDate: e.expectedBillingDate?.toISOString() ?? null, planningStatus: e.planningStatus, enrollmentStatus: e.enrollmentStatus, planStatus: e.planStatus, numberOfSchemes: e.numberOfSchemes || 1 })),
  };
}

const draftSchema = z.object({
  schemeId: z.string().min(1),
  officerId: z.string().optional(), // RM "My Team" flow: the Sales Officer the plan is for
  dealers: z.array(z.object({
    dealerId: z.string().min(1),
    expectedBillingDate: z.coerce.date().nullable().optional(),
    numberOfSchemes: z.coerce.number().int().min(1).max(10).optional(), // "Allow Multi Schemes" dealer count
  })).default([]),
});

// Statuses the owner may still edit (create/update/remove) as part of their working draft.
// Editable states use planStatus (source of truth): only a Draft or Returned plan may be saved/removed.
const EDITABLE = new Set<string>([SchemePlanState.DRAFT, SchemePlanState.RETURNED]);

/**
 * Persist a working set for one scheme + officer, then optionally submit it. Selected dealers are upserted
 * as DRAFT (or submitted); de-selected DRAFT/RETURNED rows are removed. Rows already in the RM queue or
 * beyond are never touched here. Enforces one working draft per (officer, scheme) via (scheme, dealer)
 * uniqueness. A Regional Manager may plan for themselves ("My Dealers") or a team Sales Officer ("My Team").
 *
 * Submission routing: a Sales Officer's plan goes to SUBMITTED (awaiting RM approval); a Regional
 * Manager IS the approver, so an RM-created plan skips RM approval and lands at RM_APPROVED (straight to
 * Admin document verification).
 */
async function persistDraft(ctx: AuthContext, raw: unknown, submit: boolean): Promise<{ drafted: number; submitted: number }> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can plan dealers");
  const data = draftSchema.parse(raw);
  await refreshSchemeStatuses();
  const targetOfficerId = await resolveTargetOfficer(ctx, data.officerId);
  const isRm = ctx.role === Role.REGIONAL_MANAGER;

  const scheme = (await prisma.scheme.findUnique({ where: { id: data.schemeId }, select: { status: true, isPerpetual: true, startDate: true, endDate: true, allowMultipleSchemes: true, schemeValueWithGST: true, states: { select: { groupId: true } } } })) as
    { status: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; allowMultipleSchemes: boolean; schemeValueWithGST: unknown; states: { groupId: string }[] } | null;
  if (!scheme) throw new ApiError(404, "Scheme not found");
  if (scheme.status !== SchemeStatus.OPEN) throw new ApiError(422, "This scheme is closed");
  if (ctx.groupId && !scheme.states.some((s) => s.groupId === ctx.groupId)) throw new ApiError(422, "This scheme is not applicable to your State");
  const gstValue = Number((scheme.schemeValueWithGST as { toString(): string }).toString());
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
  if (submit) {
    if (data.dealers.length === 0) throw new ApiError(422, "Select at least one dealer to submit");
    for (const d of data.dealers) if (!d.expectedBillingDate) throw new ApiError(422, "Every dealer needs a Conversion Date before submitting");
  }

  const existing = (await prisma.dealerSchemePlan.findMany({ where: { schemeId: data.schemeId, salesOfficerId: targetOfficerId }, select: { id: true, dealerId: true, planStatus: true } })) as { id: string; dealerId: string; planStatus: string }[];
  const byDealer = new Map(existing.map((e) => [e.dealerId, e]));
  const selected = new Set(data.dealers.map((d) => d.dealerId));

  let drafted = 0;
  let submitted = 0;
  // Old status (kept in sync during migration) + new Part E planStatus.
  // RM-created plans skip RM approval (RM is the approver) → Pending Approval (Admin). SO → Pending for RM.
  const legacyNext = submit ? (isRm ? SchemePlanStatus.RM_APPROVED : SchemePlanStatus.SUBMITTED) : SchemePlanStatus.DRAFT;
  const planNext = submit ? (isRm ? SchemePlanState.PENDING_APPROVAL : SchemePlanState.PENDING_RM) : SchemePlanState.DRAFT;
  const submitStamp = submit ? { submittedAt: new Date(), ...(isRm ? { rmActedById: ctx.userId, rmActedAt: new Date(), rmRemarks: null } : { rmActedById: null, rmActedAt: null, rmRemarks: null }) } : {};

  for (const d of data.dealers) {
    const date = validateDate(d.expectedBillingDate ?? null);
    const count = countFor(d.numberOfSchemes);
    const total = gstValue * count;
    const cur = byDealer.get(d.dealerId);
    if (!cur) {
      await prisma.dealerSchemePlan.create({ data: { schemeId: data.schemeId, dealerId: d.dealerId, salesOfficerId: targetOfficerId, planningStatus: legacyNext, planStatus: planNext, numberOfSchemes: count, totalSchemeAmount: total, expectedBillingDate: date, ...(submit ? submitStamp : {}) } });
      if (submit) submitted++; else drafted++;
    } else if (EDITABLE.has(cur.planStatus)) {
      await prisma.dealerSchemePlan.update({ where: { id: cur.id }, data: { expectedBillingDate: date, planningStatus: legacyNext, planStatus: planNext, numberOfSchemes: count, totalSchemeAmount: total, ...(submit ? submitStamp : {}) } });
      if (submit) submitted++; else drafted++;
    }
    // else: locked (already in RM queue or beyond) — leave untouched.
  }

  // Remove editable rows de-selected from this officer's working draft.
  const toRemove = existing.filter((e) => EDITABLE.has(e.planStatus) && !selected.has(e.dealerId)).map((e) => e.id);
  if (toRemove.length) await prisma.dealerSchemePlan.deleteMany({ where: { id: { in: toRemove } } });

  await writeAudit({ userId: ctx.userId, action: submit ? "UPDATE" : "CREATE", entity: "dealerSchemePlan", entityId: data.schemeId, summary: submit ? `Scheme plan submitted (${submitted} dealers)` : `Scheme draft saved (${drafted} dealers)` });
  return { drafted, submitted };
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
  conversionDate: z.coerce.date().nullable().optional(),
  soBookingStatus: z.nativeEnum(SchemeBookingStatus).nullable().optional(),
  soBookingAmount: z.coerce.number().min(0).nullable().optional(),
  soDocumentStatus: z.nativeEnum(SchemeSoDocStatus).nullable().optional(),
  billingDate: z.coerce.date().nullable().optional(),
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

  const data = conversionSchema.parse(raw);
  const converting = data.schemeStatus === SchemeConversionStatus.CONVERTED;
  if (converting && data.soBookingStatus === SchemeBookingStatus.PARTIAL && (data.soBookingAmount == null || data.soBookingAmount <= 0)) {
    throw new ApiError(422, "Enter the partial booking amount");
  }
  await prisma.dealerSchemePlan.update({
    where: { id: planId },
    data: {
      schemeStatus: data.schemeStatus,
      conversionDate: converting ? data.conversionDate ?? null : null,
      soBookingStatus: converting ? data.soBookingStatus ?? null : null,
      soBookingAmount: converting && data.soBookingStatus === SchemeBookingStatus.PARTIAL ? data.soBookingAmount ?? null : (converting ? (data.soBookingAmount ?? null) : null),
      soDocumentStatus: converting ? data.soDocumentStatus ?? null : null,
      billingDate: converting ? data.billingDate ?? null : null,
    },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: planId, summary: `Scheme status set to ${data.schemeStatus}` });
  return { ok: true };
}
