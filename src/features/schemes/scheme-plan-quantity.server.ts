import "server-only";
import { Prisma, SchemeConversionStatus, SchemeEnrollmentStatus, SchemePlanState, SchemePlanStatus, SchemePlanRemainderDisposition } from "@prisma/client";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { quantitySplitDecision, type SchemeRemainderDecision } from "@/lib/scheme-plan-quantity";

export interface ConversionQuantityInput {
  proceedingSchemes?: number;
  remainingDisposition?: SchemeRemainderDecision | null;
}

export interface AppliedConversionQuantity {
  originalQuantity: number;
  proceedingQuantity: number;
  remainingQuantity: number;
  disposition: SchemeRemainderDecision | null;
  currentTotal: Prisma.Decimal;
  futurePlanId: string | null;
  split: boolean;
}

const money = (value: unknown) => new Prisma.Decimal(value == null ? 0 : String(value));

export const conversionQuantityPlanSelect = {
  id: true, schemeId: true, dealerId: true, salesOfficerId: true, segmentNumber: true,
  planningStatus: true, planStatus: true, schemeStatus: true, enrollmentStatus: true,
  numberOfSchemes: true, totalSchemeAmount: true, expectedBillingDate: true, originalConversionDate: true,
  submittedAt: true, soNote: true, selectedOptionId: true, optionBookingAmount: true, installmentBalance: true,
  optionLabel: true, optionTargetQty: true, optionTargetValue: true, optionValueWithoutGST: true, optionValueWithGST: true,
  prePlacementDays: true, adminPrePlacementDays: true,
  conversionDate: true, soBookingStatus: true, soBookingAmount: true, soDocumentStatus: true,
  adminConversionDate: true, adminBookingStatus: true, adminBookingAmount: true, adminDocumentStatus: true,
  adminBillingDate: true, adminVerifiedAt: true, enrolledAt: true, billMode: true, billsLockedAt: true,
  soBillCount: true, adminBillCount: true, soAmountWithoutGST: true, soAmountWithGST: true,
  adminAmountWithoutGST: true, adminAmountWithGST: true, bookingAmount: true, bookingBillNumber: true,
  quantitySplitAsSource: { select: { id: true } },
  scheme: { select: { structure: true, schemeValueWithoutGST: true, schemeValueWithGST: true } },
  instances: {
    select: {
      id: true, instanceNumber: true, soBillingDate: true, adminBillingDate: true, billMode: true, billsLockedAt: true,
      _count: { select: { bills: true, installments: true } },
    },
    orderBy: { instanceNumber: "asc" },
  },
  _count: { select: { bills: true, payments: true } },
} as const;

export type ConversionQuantityPlan = Prisma.DealerSchemePlanGetPayload<{ select: typeof conversionQuantityPlanSelect }>;

/**
 * Atomically turn one approved plan into the quantity proceeding now plus an optional ordinary Draft
 * remainder. This is the only code path allowed to create a second segment for a dealer/scheme pair.
 */
export async function applyConversionQuantity(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  planId: string,
  input: ConversionQuantityInput,
  lockedPlan?: ConversionQuantityPlan,
): Promise<AppliedConversionQuantity> {
  if (lockedPlan && lockedPlan.id !== planId) throw new ApiError(409, "The locked Scheme plan does not match the requested plan");
  if (!lockedPlan) await tx.$queryRaw`SELECT "id" FROM "DealerSchemePlan" WHERE "id" = ${planId} FOR UPDATE`;
  const plan = lockedPlan ?? await tx.dealerSchemePlan.findUnique({ where: { id: planId }, select: conversionQuantityPlanSelect });
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (plan.planStatus !== SchemePlanState.APPROVED) throw new ApiError(409, "Scheme quantity can only be selected after the plan is Approved");

  let decision;
  try {
    decision = quantitySplitDecision(plan.numberOfSchemes || 1, input.proceedingSchemes, input.remainingDisposition);
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
  const storedTotal = plan.totalSchemeAmount == null
    ? money(plan.scheme.structure === "MULTIPLE_OPTIONS" ? plan.optionValueWithGST : plan.scheme.schemeValueWithGST).times(decision.originalQuantity)
    : money(plan.totalSchemeAmount);
  if (!decision.split) {
    return { ...decision, currentTotal: storedTotal, futurePlanId: null };
  }

  const prohibited =
    plan.quantitySplitAsSource ||
    plan.schemeStatus === SchemeConversionStatus.CONVERTED ||
    plan.enrollmentStatus === SchemeEnrollmentStatus.ENROLLED ||
    plan.conversionDate || plan.soBookingStatus || plan.soBookingAmount || plan.soDocumentStatus ||
    plan.adminConversionDate || plan.adminBookingStatus || plan.adminBookingAmount || plan.adminDocumentStatus ||
    plan.adminBillingDate || plan.adminVerifiedAt || plan.enrolledAt || plan.billMode || plan.billsLockedAt ||
    plan._count.bills > 0 || plan._count.payments > 0 ||
    plan.instances.some((instance) => instance.soBillingDate || instance.adminBillingDate || instance.billMode || instance.billsLockedAt || instance._count.bills > 0 || instance._count.installments > 0);
  if (prohibited) {
    throw new ApiError(409, "Scheme quantity cannot be split after conversion, billing, installment, payment, or Admin verification activity exists");
  }

  const currentTotal = storedTotal.div(decision.originalQuantity).times(decision.proceedingQuantity).toDecimalPlaces(2);
  const futureTotal = storedTotal.minus(currentTotal);
  let futurePlanId: string | null = null;
  if (decision.disposition === "FUTURE_DRAFT") {
    const maxSegment = await tx.dealerSchemePlan.aggregate({
      where: { schemeId: plan.schemeId, dealerId: plan.dealerId },
      _max: { segmentNumber: true },
    });
    const nextSegment = (maxSegment._max.segmentNumber ?? 1) + 1;
    const future = await tx.dealerSchemePlan.create({
      data: {
        schemeId: plan.schemeId,
        dealerId: plan.dealerId,
        salesOfficerId: plan.salesOfficerId,
        segmentNumber: nextSegment,
        planningStatus: SchemePlanStatus.DRAFT,
        planStatus: SchemePlanState.DRAFT,
        schemeStatus: SchemeConversionStatus.PENDING,
        enrollmentStatus: SchemeEnrollmentStatus.PENDING_DOCUMENT,
        numberOfSchemes: decision.remainingQuantity,
        totalSchemeAmount: futureTotal,
        expectedBillingDate: plan.expectedBillingDate,
        originalConversionDate: plan.originalConversionDate ?? plan.expectedBillingDate,
        soNote: plan.soNote,
        selectedOptionId: plan.selectedOptionId,
        optionBookingAmount: plan.optionBookingAmount,
        installmentBalance: plan.installmentBalance,
        optionLabel: plan.optionLabel,
        optionTargetQty: plan.optionTargetQty,
        optionTargetValue: plan.optionTargetValue,
        optionValueWithoutGST: plan.optionValueWithoutGST,
        optionValueWithGST: plan.optionValueWithGST,
        prePlacementDays: plan.prePlacementDays,
      },
      select: { id: true },
    });
    futurePlanId = future.id;
  }

  const surplus = plan.instances.filter((instance) => instance.instanceNumber > decision.proceedingQuantity);
  const missingInstances: { dealerSchemePlanId: string; instanceNumber: number }[] = [];
  if (futurePlanId) {
    if (surplus.length) {
      const movedRows = await tx.dealerSchemeInstance.updateMany({
        where: { id: { in: surplus.map((instance) => instance.id) }, dealerSchemePlanId: plan.id },
        data: { dealerSchemePlanId: futurePlanId, instanceNumber: { decrement: decision.proceedingQuantity } },
      });
      if (movedRows.count !== surplus.length) {
        throw new ApiError(409, "Scheme instances changed during quantity split; nothing was modified. Please retry.");
      }
    }
    const moved = new Set(surplus.map((instance) => instance.instanceNumber - decision.proceedingQuantity));
    for (let instanceNumber = 1; instanceNumber <= decision.remainingQuantity; instanceNumber++) {
      if (!moved.has(instanceNumber)) missingInstances.push({ dealerSchemePlanId: futurePlanId, instanceNumber });
    }
  } else if (surplus.length) {
    await tx.dealerSchemeInstance.deleteMany({ where: { id: { in: surplus.map((instance) => instance.id) } } });
  }
  const retained = new Set(plan.instances.filter((instance) => instance.instanceNumber <= decision.proceedingQuantity).map((instance) => instance.instanceNumber));
  for (let instanceNumber = 1; instanceNumber <= decision.proceedingQuantity; instanceNumber++) {
    if (!retained.has(instanceNumber)) missingInstances.push({ dealerSchemePlanId: plan.id, instanceNumber });
  }
  if (missingInstances.length) await tx.dealerSchemeInstance.createMany({ data: missingInstances });

  await tx.dealerSchemePlan.update({
    where: { id: plan.id },
    data: { numberOfSchemes: decision.proceedingQuantity, totalSchemeAmount: currentTotal },
  });
  await tx.schemePlanQuantitySplit.create({
    data: {
      sourcePlanId: plan.id,
      futurePlanId,
      originalQuantity: decision.originalQuantity,
      proceedingQuantity: decision.proceedingQuantity,
      remainingQuantity: decision.remainingQuantity,
      disposition: decision.disposition === "FUTURE_DRAFT" ? SchemePlanRemainderDisposition.FUTURE_DRAFT : SchemePlanRemainderDisposition.CANCELLED,
      createdById: ctx.userId,
    },
  });
  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "dealerSchemePlan",
    entityId: plan.id,
    summary: JSON.stringify({ event: "Scheme quantity split", originalQuantity: decision.originalQuantity, proceedingQuantity: decision.proceedingQuantity, remainingQuantity: decision.remainingQuantity, disposition: decision.disposition, futurePlanId }),
  }, tx);
  return { ...decision, currentTotal, futurePlanId };
}
