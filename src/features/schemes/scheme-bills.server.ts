import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { effectiveBookingAmount } from "@/lib/scheme-installments";
import { soPlanBills, adminPlanBills, assertBillParts, assertBillTotals, combinedPresetValueErrors, billSchedule } from "@/lib/scheme-bills";

/** Financial reads include active bill schedules without pretending partial verification is enrollment. */
export const billFinancialScope = { OR: [
  { enrollmentStatus: "ENROLLED" as const },
  { bills: { some: { verifiedAt: { not: null } } } },
  { instances: { some: { bills: { some: { verifiedAt: { not: null } } } } } }, // historical instance-owned bills
] };
export const planInstallmentWhere = (planId: string) => ({ OR: [{ instance: { dealerSchemePlanId: planId } }, { bill: { planId } }] });
const select = {
  id: true, salesOfficerId: true, planStatus: true, schemeStatus: true, enrollmentStatus: true,
  billMode: true, soBillCount: true, adminBillCount: true, soAmountWithoutGST: true, soAmountWithGST: true,
  adminAmountWithoutGST: true, adminAmountWithGST: true, bookingAmount: true, bookingBillNumber: true, billsLockedAt: true,
  installmentBalance: true,
  conversionDate: true, soBookingStatus: true, soBookingAmount: true, soDocumentStatus: true,
  adminConversionDate: true, adminBookingStatus: true, adminBookingAmount: true, adminDocumentStatus: true,
  adminVerifiedAt: true, enrolledAt: true, prePlacementDays: true, adminPrePlacementDays: true,
} as const;
// Scope and the rule template load before BEGIN, avoiding network work while holding the plan lock.
async function prepare(ctx: AuthContext, id: string) {
  const scope = await getOfficerScope(ctx);
  const source = await prisma.dealerSchemePlan.findUnique({ where: { id }, select: {
    salesOfficerId: true, numberOfSchemes: true, totalSchemeAmount: true,
    optionValueWithoutGST: true, optionValueWithGST: true, optionBookingAmount: true,
    scheme: { select: { structure: true, schemeValueWithoutGST: true, schemeValueWithGST: true, bookingAmount: true, installmentRules: true } },
  } });
  if (!source) throw new ApiError(404, "Scheme plan not found");
  if (!scope.all && !scope.ids.includes(source.salesOfficerId)) throw new ApiError(403, "You cannot manage this scheme plan");
  return { source, scope };
}
async function lockedPlan(tx: Prisma.TransactionClient, id: string, scope: Awaited<ReturnType<typeof getOfficerScope>>) {
  await tx.$queryRaw`SELECT "id" FROM "DealerSchemePlan" WHERE "id" = ${id} FOR UPDATE`;
  const plan = await tx.dealerSchemePlan.findUnique({ where: { id }, select });
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  if (!scope.all && !scope.ids.includes(plan.salesOfficerId)) throw new ApiError(403, "You cannot manage this scheme plan");
  if (plan.planStatus !== "APPROVED") throw new ApiError(409, "Only approved plans support conversion/verification");
  return plan;
}
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ApiError(422, result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}
function check(fn: () => void) { try { fn(); } catch(e) { throw new ApiError(422, (e as Error).message); } }
const billSelect = { id: true, partNumber: true, soBillDate: true, adminBillDate: true, soAmountWithoutGST: true, soAmountWithGST: true, amountWithoutGST: true, amountWithGST: true, verifiedAt: true, _count: { select: { installments: true } } } as const;
export async function rejectLegacyBillWrite(planId: string, db: Pick<Prisma.TransactionClient, "dealerSchemePlan"> = prisma) {
  if (await db.dealerSchemePlan.count({ where: { id: planId, OR: [{ billMode: true }, { instances: { some: { billMode: true } } }] } })) throw new ApiError(409, "Use combined plan billing; legacy billing cannot overwrite bill records");
}
interface SoCommon { schemeStatus: string; conversionDate?: Date | null; soBookingStatus?: "RECEIVED" | "PARTIAL" | "NOT_RECEIVED" | null; soBookingAmount?: number | null; soDocumentStatus?: "SIGNED_BUT_NOT_SENT" | "SIGNED_AND_SENT" | "HARD_COPY_SENT" | "DOC_RECEIVED" | null }
export async function saveBillConversion(ctx: AuthContext, planId: string, common: SoCommon, raw: unknown) {
  if (common.schemeStatus !== "CONVERTED") throw new ApiError(422, "Combined bills require Converted status");
  const data = parse(soPlanBills, raw);
  check(() => { assertBillParts(data.billCount, data.bills); assertBillTotals(data, data.bills); });
  const { source, scope } = await prepare(ctx, planId);
  const units = source.numberOfSchemes || 1;
  const presetWithoutGST = new Prisma.Decimal(source.scheme.structure === "MULTIPLE_OPTIONS" ? source.optionValueWithoutGST ?? 0 : source.scheme.schemeValueWithoutGST ?? 0).times(units);
  const presetWithGST = source.totalSchemeAmount == null
    ? new Prisma.Decimal(source.scheme.structure === "MULTIPLE_OPTIONS" ? source.optionValueWithGST ?? 0 : source.scheme.schemeValueWithGST ?? 0).times(units)
    : new Prisma.Decimal(source.totalSchemeAmount);
  const minimumErrors = combinedPresetValueErrors(data, { amountWithoutGST: presetWithoutGST.toString(), amountWithGST: presetWithGST.toString() });
  if (minimumErrors.length) throw new ApiError(422, minimumErrors.join(" "));
  return prisma.$transaction(async tx => {
    const plan = await lockedPlan(tx, planId, scope);
    if (!plan.billMode) {
      if (await tx.dealerSchemeInstallment.count({ where: { instance: { dealerSchemePlanId: planId } } })) throw new ApiError(409, "Existing instance-linked schedules require a separate correction workflow; they cannot be converted or regenerated");
      // Old verified/enrolled records are not reinterpreted. Unscheduled instance-bill references are retained.
      if ((plan.adminVerifiedAt || plan.enrollmentStatus === "ENROLLED") && !(await tx.dealerSchemeInstance.count({ where: { dealerSchemePlanId: planId, billMode: true } }))) throw new ApiError(409, "Historical verified billing cannot be converted into new combined bills");
    }
    const before = await tx.dealerSchemeBill.findMany({ where: { planId }, select: billSelect });
    if (plan.billsLockedAt && (data.billCount !== plan.soBillCount || !plan.soAmountWithoutGST?.equals(data.amountWithoutGST) || !plan.soAmountWithGST?.equals(data.amountWithGST) || data.bills.some(b => {
      const old = before.find(x => x.partNumber === b.partNumber);
      return old?.soBillDate?.getTime() !== b.soBillDate.getTime() || !old?.soAmountWithoutGST?.equals(b.amountWithoutGST) || !old?.soAmountWithGST?.equals(b.amountWithGST);
    }))) throw new ApiError(409, "Bill count, amounts and SO references are locked after the first schedule");
    if (!plan.billsLockedAt) {
      // One bounded batch (1–5 rows), not one update/upsert per scheme instance.
      await tx.$executeRaw`INSERT INTO "DealerSchemeBill" ("id","planId","partNumber","soBillDate","soAmountWithoutGST","soAmountWithGST","createdAt","updatedAt") VALUES ${Prisma.join(data.bills.map(b => Prisma.sql`(${randomUUID()},${planId},${b.partNumber},(${b.soBillDate}::timestamptz AT TIME ZONE 'UTC'),${new Prisma.Decimal(b.amountWithoutGST)},${new Prisma.Decimal(b.amountWithGST)},(NOW() AT TIME ZONE 'UTC'),(NOW() AT TIME ZONE 'UTC'))`))}
        ON CONFLICT ("planId","partNumber") DO UPDATE SET "soBillDate"=EXCLUDED."soBillDate", "soAmountWithoutGST"=EXCLUDED."soAmountWithoutGST", "soAmountWithGST"=EXCLUDED."soAmountWithGST", "updatedAt"=(NOW() AT TIME ZONE 'UTC')`;
    }
    await tx.dealerSchemePlan.update({ where: { id: planId }, data: { billMode: true, soBillCount: data.billCount, soAmountWithoutGST: data.amountWithoutGST, soAmountWithGST: data.amountWithGST,
      schemeStatus: "CONVERTED", conversionDate: common.conversionDate, soBookingStatus: common.soBookingStatus, soBookingAmount: common.soBookingAmount, soDocumentStatus: common.soDocumentStatus } });
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: planId, summary: JSON.stringify({ event: "SO combined bills submitted", before: { ...plan, bills: before }, after: { ...common, billing: data } }) }, tx);
    return { ok: true as const };
  });
}
interface AdminCommon { adminConversionDate: Date; adminBookingStatus: "RECEIVED" | "PARTIAL" | "NOT_RECEIVED"; adminBookingAmount?: number | null; adminDocumentStatus: string; adminPrePlacementDays?: number | null; remarks?: string }
export async function verifyBills(ctx: AuthContext, planId: string, common: AdminCommon, raw: unknown) {
  if (ctx.role !== "SUPER_ADMIN") throw new ApiError(403, "Only Admin can verify bills");
  const data = parse(adminPlanBills, raw);
  check(() => { assertBillParts(data.billCount, data.bills); assertBillTotals(data, data.bills); });
  if (data.bills.some(b => b.adminBillDate) && common.adminBookingStatus !== "RECEIVED") throw new ApiError(422, "Booking must be Paid before verifying a bill");
  const { source, scope } = await prepare(ctx, planId);
  const rules = source.scheme.installmentRules.map(r => ({ ...r, value: Number(r.value) }));
  return prisma.$transaction(async tx => {
    const plan = await lockedPlan(tx, planId, scope);
    if (!plan.billMode || plan.schemeStatus !== "CONVERTED" || !plan.soBillCount) throw new ApiError(409, "SO must submit combined plan billing before Admin verification");
    const before = await tx.dealerSchemeBill.findMany({ where: { planId }, select: billSelect });
    const adminPre = common.adminPrePlacementDays === undefined ? plan.adminPrePlacementDays : (common.adminPrePlacementDays ?? 0) > 0 ? common.adminPrePlacementDays! : null;
    const pre = adminPre ?? plan.prePlacementDays ?? 0;
    const requestedBooking = common.adminBookingAmount ?? (plan.bookingAmount == null ? effectiveBookingAmount(source.scheme.structure, Number(source.scheme.bookingAmount ?? 0), source.optionBookingAmount == null ? null : Number(source.optionBookingAmount)) : Number(plan.bookingAmount));
    if (plan.billsLockedAt && (data.billCount !== plan.adminBillCount || !plan.adminAmountWithoutGST?.equals(data.amountWithoutGST) || !plan.adminAmountWithGST?.equals(data.amountWithGST) || !plan.bookingAmount?.equals(requestedBooking) || pre !== (plan.adminPrePlacementDays ?? plan.prePlacementDays ?? 0))) throw new ApiError(409, "Combined totals, bill count, booking and pre-placement are locked after the first schedule");
    const booking = plan.bookingAmount == null ? requestedBooking : Number(plan.bookingAmount);
    const schedule = new Map<number, ReturnType<typeof billSchedule>>();
    const writable = data.bills.filter(b => {
      const old = before.find(x => x.partNumber === b.partNumber);
      if (old?._count.installments) {
        if (old.adminBillDate?.getTime() !== b.adminBillDate?.getTime() || !old.amountWithoutGST?.equals(b.amountWithoutGST) || !old.amountWithGST?.equals(b.amountWithGST)) throw new ApiError(409, `Part Bill ${b.partNumber} is locked because its schedule exists`);
        return false;
      }
      if (b.adminBillDate) {
        try { schedule.set(b.partNumber, billSchedule(
          rules,
          Number(b.amountWithGST),
          b.adminBillDate,
          booking,
          b.partNumber,
          plan.bookingBillNumber ?? data.billCount,
          pre,
          source.scheme.structure === "MULTIPLE_OPTIONS" && plan.installmentBalance,
        )); }
        catch(e) { throw new ApiError(422, `Part Bill ${b.partNumber}: ${(e as Error).message}`); }
      }
      return true;
    });
    // Validation completes before the first financial write. Existing scheduled rows are excluded entirely.
    const saved = writable.length ? await tx.$queryRaw<{ id: string; partNumber: number }[]>`INSERT INTO "DealerSchemeBill" ("id","planId","partNumber","adminBillDate","amountWithoutGST","amountWithGST","verifiedAt","verifiedById","createdAt","updatedAt") VALUES ${Prisma.join(writable.map(b => Prisma.sql`(${randomUUID()},${planId},${b.partNumber},(${b.adminBillDate}::timestamptz AT TIME ZONE 'UTC'),${new Prisma.Decimal(b.amountWithoutGST)},${new Prisma.Decimal(b.amountWithGST)},(${b.adminBillDate ? new Date() : null}::timestamptz AT TIME ZONE 'UTC'),${b.adminBillDate ? ctx.userId : null},(NOW() AT TIME ZONE 'UTC'),(NOW() AT TIME ZONE 'UTC'))`))}
      ON CONFLICT ("planId","partNumber") DO UPDATE SET "adminBillDate"=EXCLUDED."adminBillDate", "amountWithoutGST"=EXCLUDED."amountWithoutGST", "amountWithGST"=EXCLUDED."amountWithGST", "verifiedAt"=EXCLUDED."verifiedAt", "verifiedById"=EXCLUDED."verifiedById", "updatedAt"=(NOW() AT TIME ZONE 'UTC') RETURNING "id","partNumber"` : [];
    const installments = saved.flatMap(b => (schedule.get(b.partNumber) ?? []).map(r => ({ ...r, billId: b.id, createdById: ctx.userId })));
    if (installments.length) await tx.dealerSchemeInstallment.createMany({ data: installments });
    const complete = data.bills.every(b => b.adminBillDate) && common.adminBookingStatus === "RECEIVED" && ["RECEIVED_SOFT", "RECEIVED_HARD"].includes(common.adminDocumentStatus);
    await tx.dealerSchemePlan.update({ where: { id: planId }, data: { adminBillCount: data.billCount, adminAmountWithoutGST: data.amountWithoutGST, adminAmountWithGST: data.amountWithGST,
      ...(installments.length && !plan.billsLockedAt ? { bookingAmount: booking, bookingBillNumber: data.billCount, billsLockedAt: new Date() } : {}),
      adminConversionDate: common.adminConversionDate, adminBookingStatus: common.adminBookingStatus, adminBookingAmount: common.adminBookingStatus === "NOT_RECEIVED" ? null : common.adminBookingAmount,
      adminDocumentStatus: common.adminDocumentStatus as "RECEIVED_SOFT" | "RECEIVED_HARD" | "NOT_RECEIVED", adminPrePlacementDays: adminPre, verificationRemarks: common.remarks?.trim() || null, adminVerifiedAt: new Date(), adminVerifiedById: ctx.userId,
      enrollmentStatus: complete ? "ENROLLED" : "PENDING_DOCUMENT", ...(complete ? { enrolledAt: plan.enrolledAt ?? new Date(), enrolledById: ctx.userId } : {}) } });
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: planId, summary: JSON.stringify({ event: "Admin combined bill verification", before: { ...plan, bills: before }, after: { ...common, billing: data, bookingReserved: booking, enrolled: complete } }) }, tx);
    return { enrolled: complete, eligible: complete };
  });
}
