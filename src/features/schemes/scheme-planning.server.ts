import "server-only";
import { Role, SchemeStatus, SchemePlanStatus, SchemeEnrollmentStatus, SchemePlanState, SchemeConversionStatus, SchemeBookingStatus, SchemeSoDocStatus, SchemeAdminDocStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope, assertOfficerInScope } from "@/lib/scope";
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
  // Multi-scheme billing (per-instance) — lets the SO/Admin dialogs restore their same/different choice + dates.
  soBillingSameForAll: boolean;
  adminBillingSameForAll: boolean;
  instances: { instanceNumber: number; soBillingDate: string | null; adminBillingDate: string | null }[];
}

type RawInstance = { instanceNumber: number; soBillingDate: Date | null; adminBillingDate: Date | null };
type RawPlan = {
  id: string; schemeId: string; dealerId: string; salesOfficerId: string; planningStatus: string; enrollmentStatus: string;
  expectedBillingDate: Date | null; submittedAt: Date | null; rmActedAt: Date | null; rmRemarks: string | null; documentCompleted: boolean; documentType: string | null;
  verificationRemarks: string | null; enrolledAt: Date | null; createdAt: Date;
  planStatus: string; schemeStatus: string; numberOfSchemes: number; totalSchemeAmount: unknown;
  conversionDate: Date | null; soBookingStatus: string | null; soBookingAmount: unknown; soDocumentStatus: string | null; billingDate: Date | null;
  adminConversionDate: Date | null; adminBookingStatus: string | null; adminBookingAmount: unknown; adminDocumentStatus: string | null; adminBillingDate: Date | null; adminVerifiedAt: Date | null;
  soBillingSameForAll: boolean; adminBillingSameForAll: boolean; instances: RawInstance[];
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
  instances: { select: { instanceNumber: true, soBillingDate: true, adminBillingDate: true }, orderBy: { instanceNumber: "asc" } },
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
    soBillingSameForAll: r.soBillingSameForAll,
    adminBillingSameForAll: r.adminBillingSameForAll,
    instances: (r.instances ?? []).map((i) => ({ instanceNumber: i.instanceNumber, soBillingDate: i.soBillingDate?.toISOString() ?? null, adminBillingDate: i.adminBillingDate?.toISOString() ?? null })),
  };
}

/* --------------------------------- Listing --------------------------------- */

/**
 * Scoped list: SO → own; RM → their team; Admin → all. Optional `schemeId` filter (for the detail view).
 * Optional `officerId` narrows an RM (or Admin) to a SINGLE Sales Officer — validated server-side against
 * the caller's scope, so it can only ever restrict, never widen, what `getOfficerScope` already allows.
 */
export async function listSchemePlans(ctx: AuthContext, schemeId?: string, officerId?: string): Promise<SchemePlanRow[]> {
  const scope = await getOfficerScope(ctx);
  if (officerId) await assertOfficerInScope(ctx, officerId);
  const officerFilter = officerId ? { salesOfficerId: officerId } : scope.all ? {} : { salesOfficerId: { in: scope.ids } };
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { ...(schemeId ? { schemeId } : {}), ...officerFilter },
    include: PLAN_INCLUDE,
    orderBy: { createdAt: "desc" },
  })) as unknown as RawPlan[];
  return rows.map(toPlanRow);
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
export interface SchemeWiseSummaryRow {
  schemeId: string;
  schemeName: string;
  /** Dealer count. One plan exists per (scheme, dealer), so this is the plan count — NOT a unit count. */
  dealersPlanned: number;
  /** Σ numberOfSchemes over every plan in scope for this scheme. */
  totalSchemes: number;
  /** Σ numberOfSchemes where planStatus = APPROVED. */
  approvedSchemes: number;
  /** Converted units the Admin has NOT yet verified. */
  unverifiedConversions: number;
  /** Converted units the Admin HAS verified. */
  verifiedConversions: number;
  /**
   * Billed units among the verified-converted ones: actual DealerSchemeInstance rows carrying an
   * Admin-verified adminBillingDate, clamped to the plan's numberOfSchemes. Deliberately NOT
   * Σ numberOfSchemes — see the note above.
   */
  billedSchemes: number;
}

type SummaryRaw = {
  schemeId: string;
  numberOfSchemes: number;
  planStatus: string;
  schemeStatus: string;
  adminVerifiedAt: Date | null;
  scheme: { schemeName: string };
  instances: { adminBillingDate: Date | null }[];
};

/**
 * Billed unit count for ONE Admin-verified plan = how many instance rows the plan ACTUALLY HAS that carry
 * an adminBillingDate, clamped to its planned unit count. `verifyScheme` writes adminBillingDate onto every
 * instance that exists (via `ensureInstances`, which never expands), so those rows are the only per-unit
 * billing evidence in the database. The plan-level `adminBillingDate` column cannot substitute: verifyScheme
 * deliberately leaves it null whenever billing is entered per instance.
 *
 * The clamp is defensive only. Instances outnumbering numberOfSchemes should be unreachable — expandInstances
 * prunes surplus instances only while a plan is still editable and refuses ENROLLED plans — but a numerator
 * larger than its own denominator would be a nonsense figure to render.
 */
const billedInstanceUnits = (instances: { adminBillingDate: Date | null }[], units: number): number =>
  Math.min(instances.filter((i) => i.adminBillingDate != null).length, units);

/**
 * Scoped scheme-wise summary: SO → own plans; RM → their team; Admin → all (same `getOfficerScope`
 * filter as `listSchemePlans`, so scoping is enforced in the database, not the browser).
 *
 * READ-ONLY by construction — a single findMany reduced in memory. It must never call `ensureInstances`
 * or `expandInstances`: displaying a summary must not create or expand instances.
 */
export async function schemeWiseSummary(ctx: AuthContext, officerId?: string): Promise<SchemeWiseSummaryRow[]> {
  const scope = await getOfficerScope(ctx);
  if (officerId) await assertOfficerInScope(ctx, officerId);
  const officerFilter = officerId ? { salesOfficerId: officerId } : scope.all ? {} : { salesOfficerId: { in: scope.ids } };
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { ...officerFilter },
    select: {
      schemeId: true,
      numberOfSchemes: true,
      planStatus: true,
      schemeStatus: true,
      adminVerifiedAt: true,
      scheme: { select: { schemeName: true } },
      instances: { select: { adminBillingDate: true } },
    },
  })) as unknown as SummaryRaw[];

  const byScheme = new Map<string, SchemeWiseSummaryRow>();
  for (const r of rows) {
    const row =
      byScheme.get(r.schemeId) ??
      { schemeId: r.schemeId, schemeName: r.scheme.schemeName, dealersPlanned: 0, totalSchemes: 0, approvedSchemes: 0, unverifiedConversions: 0, verifiedConversions: 0, billedSchemes: 0 };
    const units = r.numberOfSchemes || 1;
    row.dealersPlanned += 1;
    row.totalSchemes += units;
    if (r.planStatus === SchemePlanState.APPROVED) row.approvedSchemes += units;
    // Conversion is only settable on an APPROVED plan (see setConversion), so converted ⊆ approved.
    if (r.schemeStatus === SchemeConversionStatus.CONVERTED) {
      if (r.adminVerifiedAt == null) {
        row.unverifiedConversions += units;
      } else {
        row.verifiedConversions += units;
        // Instance-level, NOT `units`: one billed legacy Instance 1 is one billed unit, never N.
        row.billedSchemes += billedInstanceUnits(r.instances, units);
      }
    }
    byScheme.set(r.schemeId, row);
  }
  return [...byScheme.values()].sort((a, b) => a.schemeName.localeCompare(b.schemeName));
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

/* --------------------------------- Scheme instances --------------------------------- */

/** Read a plan's instances (ordered). */
async function listInstances(planId: string): Promise<{ id: string; instanceNumber: number }[]> {
  return (await prisma.dealerSchemeInstance.findMany({ where: { dealerSchemePlanId: planId }, select: { id: true, instanceNumber: true }, orderBy: { instanceNumber: "asc" } })) as { id: string; instanceNumber: number }[];
}

/**
 * Guarantee Instance 1 exists and return the plan's instances — WITHOUT expanding to numberOfSchemes. Used
 * by verify + enrolled reads. This is what protects LEGACY records: a plan whose numberOfSchemes was only an
 * amount multiplier (and was never re-planned under the new flow) stays at Instance 1 forever, so no empty
 * instances are fabricated over its existing payment history. Expansion happens ONLY in expandInstances
 * (the explicit planning entry point).
 */
export async function ensureInstances(planId: string): Promise<{ id: string; instanceNumber: number }[]> {
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id: planId }, select: { id: true } })) as { id: string } | null;
  if (!plan) return [];
  const existing = await listInstances(planId);
  if (!existing.some((i) => i.instanceNumber === 1)) {
    await prisma.dealerSchemeInstance.create({ data: { dealerSchemePlanId: planId, instanceNumber: 1 } });
    return listInstances(planId);
  }
  return existing;
}

/**
 * Expand/prune a plan's instances to match numberOfSchemes — the EXPLICIT new-flow action, called only from
 * the SO/RM planning save (persistDraft). Creates instances 1..N and prunes surplus EMPTY instances (no
 * installments, no billing dates). Never runs for enrolled plans; only prunes while editable. Because it is
 * reached solely through active planning, legacy records that are merely read/verified are never expanded.
 */
export async function expandInstances(planId: string): Promise<void> {
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id: planId }, select: { numberOfSchemes: true, planStatus: true, enrollmentStatus: true } })) as { numberOfSchemes: number; planStatus: string; enrollmentStatus: string } | null;
  if (!plan || plan.enrollmentStatus === SchemeEnrollmentStatus.ENROLLED) return;
  const count = Math.min(Math.max(plan.numberOfSchemes || 1, 1), 10);
  const editable = plan.planStatus === SchemePlanState.DRAFT || plan.planStatus === SchemePlanState.RETURNED;
  const existing = (await prisma.dealerSchemeInstance.findMany({
    where: { dealerSchemePlanId: planId },
    select: { id: true, instanceNumber: true, soBillingDate: true, adminBillingDate: true, _count: { select: { installments: true } } },
    orderBy: { instanceNumber: "asc" },
  })) as { id: string; instanceNumber: number; soBillingDate: Date | null; adminBillingDate: Date | null; _count: { installments: number } }[];
  const have = new Set(existing.map((i) => i.instanceNumber));
  for (let n = 1; n <= count; n++) {
    if (!have.has(n)) await prisma.dealerSchemeInstance.create({ data: { dealerSchemePlanId: planId, instanceNumber: n } });
  }
  if (editable) {
    const surplus = existing.filter((i) => i.instanceNumber > count && i._count.installments === 0 && !i.soBillingDate && !i.adminBillingDate).map((i) => i.id);
    if (surplus.length) await prisma.dealerSchemeInstance.deleteMany({ where: { id: { in: surplus } } });
  }
}

/* --------------------------------- Admin verification + enrollment --------------------------------- */

// Single "Update" action: the three core Admin fields (conversion date, booking, document) are ALWAYS
// required; billing dates are optional (needed only for enrollment) and are PER INSTANCE.
const verifySchema = z.object({
  adminConversionDate: z.coerce.date(),
  adminBookingStatus: z.nativeEnum(SchemeBookingStatus),
  adminBookingAmount: z.coerce.number().min(0).nullable().optional(),
  adminDocumentStatus: z.nativeEnum(SchemeAdminDocStatus),
  adminBillingSameForAll: z.boolean().optional(),
  adminBillingDate: z.coerce.date().nullable().optional(), // single (same-for-all) — legacy/compat
  adminBillingDates: z.array(z.object({ instanceNumber: z.coerce.number().int().min(1).max(10), date: z.coerce.date().nullable() })).optional(),
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
  const data = verifySchema.parse(raw);
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id }, select: { planStatus: true } })) as { planStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.planStatus !== SchemePlanState.APPROVED) throw new ApiError(409, "Only an approved plan can be verified");

  if (data.adminBookingStatus === SchemeBookingStatus.PARTIAL && (data.adminBookingAmount == null || data.adminBookingAmount <= 0)) {
    throw new ApiError(422, "Enter the partial booking amount");
  }
  const readyForBilling = data.adminBookingStatus === SchemeBookingStatus.RECEIVED && adminDocReceived(data.adminDocumentStatus);

  const instances = await ensureInstances(id);
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
    throw new ApiError(422, "A billing date can only be set once booking and document are both Received");
  }

  // Persist per-instance admin billing dates.
  for (const inst of instances) {
    await prisma.dealerSchemeInstance.update({ where: { id: inst.id }, data: { adminBillingDate: dateFor(inst.instanceNumber) } });
  }
  const everyInstanceBilled = instances.length > 0 && instances.every((inst) => dateFor(inst.instanceNumber) != null);
  const eligible = enrollmentEligible(data) && everyInstanceBilled;

  await prisma.dealerSchemePlan.update({
    where: { id },
    data: {
      adminConversionDate: data.adminConversionDate,
      adminBookingStatus: data.adminBookingStatus,
      adminBookingAmount: data.adminBookingStatus === SchemeBookingStatus.NOT_RECEIVED ? null : (data.adminBookingAmount ?? null),
      adminDocumentStatus: data.adminDocumentStatus,
      adminBillingSameForAll: sameForAll,
      // Parent adminBillingDate kept for compat: the single same-for-all date, else null.
      adminBillingDate: sameForAll && readyForBilling ? (data.adminBillingDate ?? null) : null,
      verificationRemarks: data.remarks?.trim() || null,
      adminVerifiedById: ctx.userId,
      adminVerifiedAt: new Date(),
      ...(eligible
        ? { enrollmentStatus: SchemeEnrollmentStatus.ENROLLED, enrolledById: ctx.userId, enrolledAt: new Date() }
        : {}),
    },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: eligible ? "Dealer enrolled after verification" : "Scheme verification saved" });
  return { enrolled: eligible, eligible };
}

/* --------------------------------- Running Schemes (Sales Officer) --------------------------------- */

export interface RunningScheme {
  id: string; schemeName: string; states: string[]; isPerpetual: boolean;
  startDate: string | null; endDate: string | null; bookingLastDate: string | null;
  schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number;
  documentUrl: string | null;
  // Scheme Information shown by Create Plan's "Info" panel + the fields its dealer rows calculate from.
  // Carried on this one list read so opening Info or expanding a scheme needs no further request (and so
  // cannot trigger `refreshSchemeStatuses`, which writes).
  bookingAmount: number | null; otherBenefitDetails: string | null; allowMultipleSchemes: boolean;
  installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
}

/** OPEN schemes applicable to the caller's State — the "Running Schemes" tab for a Sales Officer. */
export async function runningSchemes(ctx: AuthContext): Promise<RunningScheme[]> {
  await refreshSchemeStatuses();
  const stateFilter = ctx.role === Role.SUPER_ADMIN || !ctx.groupId ? {} : { states: { some: { groupId: ctx.groupId } } };
  const rows = (await prisma.scheme.findMany({
    where: { status: SchemeStatus.OPEN, ...stateFilter },
    orderBy: [{ isPerpetual: "desc" }, { endDate: "desc" }, { schemeName: "asc" }],
    include: { states: { include: { group: { select: { name: true } } } }, installmentRules: true },
  })) as unknown as {
    id: string; schemeName: string; isPerpetual: boolean; startDate: Date | null; endDate: Date | null; bookingLastDate: Date | null;
    schemeBenefit: string; benefitDetails: string | null; schemeValueWithoutGST: unknown; schemeValueWithGST: unknown; documentUrl: string | null;
    bookingAmount: unknown; otherBenefitDetails: string | null; allowMultipleSchemes: boolean;
    installmentRules: { installmentNumber: number; calculationType: string; value: unknown; daysAfterBillingDate: number }[];
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
    bookingAmount: s.bookingAmount == null ? null : Number(s.bookingAmount),
    otherBenefitDetails: s.otherBenefitDetails,
    allowMultipleSchemes: s.allowMultipleSchemes,
    installments: s.installmentRules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value), daysAfterBillingDate: r.daysAfterBillingDate })),
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
  // PARTIAL SUBMISSION (submit only). Which of `dealers` actually go forward for approval; everyone else in
  // the working set is still persisted, but stays a Draft. Omitted → every dealer is submitted, i.e. exactly
  // the previous all-or-nothing behaviour, so existing callers are unaffected.
  submitDealerIds: z.array(z.string().min(1)).optional(),
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

  // Which dealers of the working set are going forward. Draft saves submit nobody; a submit without an
  // explicit subset submits everybody (unchanged behaviour).
  const inPayload = new Set(data.dealers.map((d) => d.dealerId));
  const submitSet = new Set<string>(submit ? (data.submitDealerIds ?? [...inPayload]) : []);
  const goesForward = (dealerId: string) => submitSet.has(dealerId);
  if (submit) {
    for (const id of submitSet) if (!inPayload.has(id)) throw new ApiError(422, "A dealer marked for submission is not part of this plan");
    if (submitSet.size === 0) throw new ApiError(422, "Select at least one dealer to submit");
    // Only the dealers actually going forward must be complete; the others stay in Draft on purpose.
    for (const d of data.dealers) if (goesForward(d.dealerId) && !d.expectedBillingDate) throw new ApiError(422, "Every dealer needs a Conversion Date before submitting");
  }

  const existing = (await prisma.dealerSchemePlan.findMany({ where: { schemeId: data.schemeId, salesOfficerId: targetOfficerId }, select: { id: true, dealerId: true, planStatus: true } })) as { id: string; dealerId: string; planStatus: string }[];
  const byDealer = new Map(existing.map((e) => [e.dealerId, e]));
  const selected = new Set(data.dealers.map((d) => d.dealerId));

  let drafted = 0;
  let submitted = 0;
  // Old status (kept in sync during migration) + new Part E planStatus, resolved PER DEALER so a partial
  // submission can promote some rows while the rest are written as Draft in the same call.
  // RM-created plans skip RM approval (RM is the approver) → Pending Approval (Admin). SO → Pending for RM.
  const legacyNextFor = (forward: boolean) => (forward ? (isRm ? SchemePlanStatus.RM_APPROVED : SchemePlanStatus.SUBMITTED) : SchemePlanStatus.DRAFT);
  const planNextFor = (forward: boolean) => (forward ? (isRm ? SchemePlanState.PENDING_APPROVAL : SchemePlanState.PENDING_RM) : SchemePlanState.DRAFT);
  const submitStampFor = (forward: boolean) => (forward ? { submittedAt: new Date(), ...(isRm ? { rmActedById: ctx.userId, rmActedAt: new Date(), rmRemarks: null } : { rmActedById: null, rmActedAt: null, rmRemarks: null }) } : {});

  for (const d of data.dealers) {
    const date = validateDate(d.expectedBillingDate ?? null);
    const count = countFor(d.numberOfSchemes);
    const total = gstValue * count;
    const forward = goesForward(d.dealerId);
    const legacyNext = legacyNextFor(forward);
    const planNext = planNextFor(forward);
    const submitStamp = submitStampFor(forward);
    const cur = byDealer.get(d.dealerId);
    if (!cur) {
      await prisma.dealerSchemePlan.create({ data: { schemeId: data.schemeId, dealerId: d.dealerId, salesOfficerId: targetOfficerId, planningStatus: legacyNext, planStatus: planNext, numberOfSchemes: count, totalSchemeAmount: total, expectedBillingDate: date, ...submitStamp } });
      if (forward) submitted++; else drafted++;
    } else if (EDITABLE.has(cur.planStatus)) {
      await prisma.dealerSchemePlan.update({ where: { id: cur.id }, data: { expectedBillingDate: date, planningStatus: legacyNext, planStatus: planNext, numberOfSchemes: count, totalSchemeAmount: total, ...submitStamp } });
      if (forward) submitted++; else drafted++;
    }
    // else: locked (already in RM queue or beyond) — leave untouched.
  }

  // Remove editable rows de-selected from this officer's working draft.
  const toRemove = existing.filter((e) => EDITABLE.has(e.planStatus) && !selected.has(e.dealerId)).map((e) => e.id);
  if (toRemove.length) await prisma.dealerSchemePlan.deleteMany({ where: { id: { in: toRemove } } });

  // Explicit new-flow expansion: match each affected plan's instances to its numberOfSchemes.
  const affected = (await prisma.dealerSchemePlan.findMany({ where: { schemeId: data.schemeId, salesOfficerId: targetOfficerId, dealerId: { in: [...selected] } }, select: { id: true } })) as { id: string }[];
  for (const p of affected) await expandInstances(p.id);

  await writeAudit({ userId: ctx.userId, action: submit ? "UPDATE" : "CREATE", entity: "dealerSchemePlan", entityId: data.schemeId, summary: submit ? `Scheme plan submitted (${submitted} dealers${drafted ? `, ${drafted} kept in draft` : ""})` : `Scheme draft saved (${drafted} dealers)` });
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

  const data = conversionSchema.parse(raw);
  const converting = data.schemeStatus === SchemeConversionStatus.CONVERTED;
  if (converting && data.soBookingStatus === SchemeBookingStatus.PARTIAL && (data.soBookingAmount == null || data.soBookingAmount <= 0)) {
    throw new ApiError(422, "Enter the partial booking amount");
  }

  // Per-instance SO billing dates. Same-for-all (default) applies one date to every instance; otherwise
  // the per-instance array. Cleared when not Converted. SO dates are informational; Admin dates are truth.
  const instances = await ensureInstances(planId);
  const sameForAll = data.billingSameForAll ?? true;
  const byNum = new Map((data.billingDates ?? []).map((d) => [d.instanceNumber, d.date] as const));
  const soDateFor = (instanceNumber: number): Date | null => {
    if (!converting) return null;
    return sameForAll ? (data.billingDate ?? null) : (byNum.get(instanceNumber) ?? null);
  };
  for (const inst of instances) {
    await prisma.dealerSchemeInstance.update({ where: { id: inst.id }, data: { soBillingDate: soDateFor(inst.instanceNumber) } });
  }

  await prisma.dealerSchemePlan.update({
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
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: planId, summary: `Scheme status set to ${data.schemeStatus}` });
  return { ok: true };
}
