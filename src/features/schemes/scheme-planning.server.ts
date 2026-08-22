import "server-only";
import { Role, SchemeStatus, SchemePlanStatus, SchemeEnrollmentStatus, SchemeDocType } from "@prisma/client";
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
}

type RawPlan = {
  id: string; schemeId: string; dealerId: string; salesOfficerId: string; planningStatus: string; enrollmentStatus: string;
  expectedBillingDate: Date | null; submittedAt: Date | null; rmActedAt: Date | null; rmRemarks: string | null; documentCompleted: boolean; documentType: string | null;
  verificationRemarks: string | null; enrolledAt: Date | null; createdAt: Date;
  scheme: { schemeName: string };
  dealer: { name: string };
  salesOfficer: { name: string; territory: string | null; group: { name: string } | null };
  rmActedBy: { name: string } | null;
  enrolledBy: { name: string } | null;
};
const PLAN_INCLUDE = {
  scheme: { select: { schemeName: true } },
  dealer: { select: { name: true } },
  salesOfficer: { select: { name: true, territory: true, group: { select: { name: true } } } },
  rmActedBy: { select: { name: true } },
  enrolledBy: { select: { name: true } },
} as const;

function toPlanRow(r: RawPlan): SchemePlanRow {
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

/** Owner submits a DRAFT/RETURNED plan → SUBMITTED (awaiting RM). */
export async function submitSchemePlan(ctx: AuthContext, id: string): Promise<{ status: string }> {
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { salesOfficerId: true, planningStatus: true } })) as { salesOfficerId: string; planningStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.salesOfficerId !== ctx.userId) throw new ApiError(403, "You can only submit your own scheme plans");
  if (plan.planningStatus !== SchemePlanStatus.DRAFT && plan.planningStatus !== SchemePlanStatus.RETURNED) throw new ApiError(409, "Only a draft or returned plan can be submitted");
  await prisma.dealerSchemePlan.update({ where: { id }, data: { planningStatus: SchemePlanStatus.SUBMITTED, submittedAt: new Date(), rmActedById: null, rmActedAt: null, rmRemarks: null } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: "Scheme plan submitted" });
  return { status: SchemePlanStatus.SUBMITTED };
}

/* --------------------------------- RM action --------------------------------- */

const actSchema = z.object({ action: z.enum(["approve", "reject", "return"]), remarks: z.string().max(500).optional() });

/** RM approves/rejects/returns a team member's SUBMITTED plan. Planning approval only — not enrollment. */
export async function actOnSchemePlan(ctx: AuthContext, id: string, raw: unknown): Promise<{ status: string }> {
  if (ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Regional Manager can act on scheme plans");
  const { action, remarks } = actSchema.parse(raw);
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { salesOfficerId: true, planningStatus: true } })) as { salesOfficerId: string; planningStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.salesOfficerId === ctx.userId) throw new ApiError(403, "You cannot act on your own scheme plan");
  const scope = await getOfficerScope(ctx);
  if (!scope.ids.includes(plan.salesOfficerId)) throw new ApiError(403, "This scheme plan is not from your team");
  if (plan.planningStatus !== SchemePlanStatus.SUBMITTED) throw new ApiError(409, "Only a submitted scheme plan can be actioned");

  const next = action === "approve" ? SchemePlanStatus.RM_APPROVED : action === "reject" ? SchemePlanStatus.RM_REJECTED : SchemePlanStatus.RETURNED;
  await prisma.dealerSchemePlan.update({ where: { id }, data: { planningStatus: next, rmActedById: ctx.userId, rmActedAt: new Date(), rmRemarks: remarks?.trim() || null } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: `Scheme plan ${action}ed by RM` });
  return { status: next };
}

/* --------------------------------- Admin enrollment verification --------------------------------- */

const verifySchema = z.object({
  documentCompleted: z.boolean(),
  documentType: z.nativeEnum(SchemeDocType).nullable().optional(),
  remarks: z.string().max(500).optional(),
});

/**
 * Super Admin verifies enrollment documents for an RM-approved plan. When documentCompleted is true a
 * documentType is required and the dealer becomes ENROLLED; otherwise the plan stays PENDING_DOCUMENT.
 */
export async function verifyEnrollment(ctx: AuthContext, id: string, raw: unknown): Promise<{ enrollmentStatus: string }> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can verify enrollment");
  const data = verifySchema.parse(raw);
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { planningStatus: true } })) as { planningStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.planningStatus !== SchemePlanStatus.RM_APPROVED) throw new ApiError(409, "Only an RM-approved plan can be enrolled");
  if (data.documentCompleted && !data.documentType) throw new ApiError(422, "Select the document type (Soft Copy / Hard Copy)");

  const enrolled = data.documentCompleted;
  await prisma.dealerSchemePlan.update({
    where: { id },
    data: {
      documentCompleted: data.documentCompleted,
      documentType: data.documentCompleted ? data.documentType : null,
      verificationRemarks: data.remarks?.trim() || null,
      enrollmentStatus: enrolled ? SchemeEnrollmentStatus.ENROLLED : SchemeEnrollmentStatus.PENDING_DOCUMENT,
      enrolledById: enrolled ? ctx.userId : null,
      enrolledAt: enrolled ? new Date() : null,
    },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: enrolled ? "Dealer enrolled" : "Enrollment documents updated" });
  return { enrollmentStatus: enrolled ? SchemeEnrollmentStatus.ENROLLED : SchemeEnrollmentStatus.PENDING_DOCUMENT };
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
export interface PlanningExisting { dealerId: string; expectedBillingDate: string | null; planningStatus: string; enrollmentStatus: string }
export interface PlanningContext {
  scheme: {
    id: string; schemeName: string; isPerpetual: boolean; startDate: string | null; endDate: string | null; bookingLastDate: string | null;
    bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
  };
  dealers: PlanningDealer[];
  existing: PlanningExisting[];
}

/** Everything the Sales Officer's scheme planning page needs: scheme info, assigned dealers, and any
 *  already-saved plans for THIS officer + scheme (so a draft re-opens with its dealers/dates loaded). */
export async function planningContext(ctx: AuthContext, schemeId: string): Promise<PlanningContext> {
  await refreshSchemeStatuses();
  const scheme = (await prisma.scheme.findUnique({
    where: { id: schemeId },
    include: { installmentRules: true },
  })) as unknown as {
    id: string; schemeName: string; status: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; bookingLastDate: Date | null;
    bookingAmount: unknown; schemeValueWithoutGST: unknown; schemeValueWithGST: unknown; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    documentUrl: string | null; installmentRules: { installmentNumber: number; calculationType: string; value: unknown; daysAfterBillingDate: number }[];
  } | null;
  if (!scheme) throw new ApiError(404, "Scheme not found");

  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId: ctx.userId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const ids = assignments.map((a) => a.dealerId);
  const dealerRows = ids.length
    ? ((await prisma.dealer.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, town: true, district: true } })) as { id: string; name: string; town: string | null; district: string | null }[])
    : [];
  const existingRows = (await prisma.dealerSchemePlan.findMany({
    where: { schemeId, salesOfficerId: ctx.userId },
    select: { dealerId: true, expectedBillingDate: true, planningStatus: true, enrollmentStatus: true },
  })) as { dealerId: string; expectedBillingDate: Date | null; planningStatus: string; enrollmentStatus: string }[];

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
      documentUrl: scheme.documentUrl,
      installments: scheme.installmentRules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value), daysAfterBillingDate: r.daysAfterBillingDate })),
    },
    dealers: dealerRows.map((d) => ({ id: d.id, name: d.name, territory: d.town ?? d.district ?? null })),
    existing: existingRows.map((e) => ({ dealerId: e.dealerId, expectedBillingDate: e.expectedBillingDate?.toISOString() ?? null, planningStatus: e.planningStatus, enrollmentStatus: e.enrollmentStatus })),
  };
}

const draftSchema = z.object({
  schemeId: z.string().min(1),
  dealers: z.array(z.object({ dealerId: z.string().min(1), expectedBillingDate: z.coerce.date().nullable().optional() })).default([]),
});

// Statuses the owner may still edit (create/update/remove) as part of their working draft.
const EDITABLE = new Set<string>([SchemePlanStatus.DRAFT, SchemePlanStatus.RETURNED]);

/**
 * Persist the Sales Officer's working set for one scheme, then optionally submit it. Selected dealers are
 * upserted as DRAFT (or submitted); de-selected DRAFT/RETURNED rows are removed. Rows already in the RM
 * queue or beyond (SUBMITTED / RM_APPROVED / RM_REJECTED) are never touched here. Enforces one working
 * draft per (officer, scheme) implicitly via the (scheme, dealer) uniqueness + officer ownership.
 */
async function persistDraft(ctx: AuthContext, raw: unknown, submit: boolean): Promise<{ drafted: number; submitted: number }> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can plan dealers");
  const data = draftSchema.parse(raw);
  await refreshSchemeStatuses();

  const scheme = (await prisma.scheme.findUnique({ where: { id: data.schemeId }, select: { status: true, isPerpetual: true, startDate: true, endDate: true, states: { select: { groupId: true } } } })) as
    { status: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; states: { groupId: string }[] } | null;
  if (!scheme) throw new ApiError(404, "Scheme not found");
  if (scheme.status !== SchemeStatus.OPEN) throw new ApiError(422, "This scheme is closed");
  if (ctx.groupId && !scheme.states.some((s) => s.groupId === ctx.groupId)) throw new ApiError(422, "This scheme is not applicable to your State");

  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId: ctx.userId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const assigned = new Set(assignments.map((a) => a.dealerId));

  const validateDate = (date: Date | null | undefined) => {
    if (!date) return null;
    if (scheme.startDate && date < scheme.startDate) throw new ApiError(422, "Expected Billing Date is before the scheme start date");
    if (!scheme.isPerpetual && scheme.endDate && date > scheme.endDate) throw new ApiError(422, "Expected Billing Date is after the scheme end date");
    return date;
  };

  for (const d of data.dealers) if (!assigned.has(d.dealerId)) throw new ApiError(422, "A selected dealer is not assigned to you");
  if (submit) {
    if (data.dealers.length === 0) throw new ApiError(422, "Select at least one dealer to submit");
    for (const d of data.dealers) if (!d.expectedBillingDate) throw new ApiError(422, "Every dealer needs an Expected Billing Date before submitting");
  }

  const existing = (await prisma.dealerSchemePlan.findMany({ where: { schemeId: data.schemeId, salesOfficerId: ctx.userId }, select: { id: true, dealerId: true, planningStatus: true } })) as { id: string; dealerId: string; planningStatus: string }[];
  const byDealer = new Map(existing.map((e) => [e.dealerId, e]));
  const selected = new Set(data.dealers.map((d) => d.dealerId));

  let drafted = 0;
  let submitted = 0;
  const nextStatus = submit ? SchemePlanStatus.SUBMITTED : SchemePlanStatus.DRAFT;

  for (const d of data.dealers) {
    const date = validateDate(d.expectedBillingDate ?? null);
    const cur = byDealer.get(d.dealerId);
    if (!cur) {
      await prisma.dealerSchemePlan.create({ data: { schemeId: data.schemeId, dealerId: d.dealerId, salesOfficerId: ctx.userId, planningStatus: nextStatus, expectedBillingDate: date, submittedAt: submit ? new Date() : null } });
      if (submit) submitted++; else drafted++;
    } else if (EDITABLE.has(cur.planningStatus)) {
      await prisma.dealerSchemePlan.update({ where: { id: cur.id }, data: { expectedBillingDate: date, planningStatus: nextStatus, submittedAt: submit ? new Date() : null, ...(submit ? { rmActedById: null, rmActedAt: null, rmRemarks: null } : {}) } });
      if (submit) submitted++; else drafted++;
    }
    // else: locked (already in RM queue or beyond) — leave untouched.
  }

  // Remove editable rows the officer de-selected (they were part of the working draft).
  const toRemove = existing.filter((e) => EDITABLE.has(e.planningStatus) && !selected.has(e.dealerId)).map((e) => e.id);
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
