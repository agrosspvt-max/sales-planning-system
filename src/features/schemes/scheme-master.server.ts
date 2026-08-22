import "server-only";
import { SchemeBenefit, SchemeStatus, SchemeCalcType, Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";

// One installment of the payout schedule for Scheme Value (With GST).
const installmentInput = z.object({
  installmentNumber: z.coerce.number().int().min(1).max(10),
  calculationType: z.nativeEnum(SchemeCalcType),
  value: z.coerce.number().min(0, "Installment value cannot be negative"),
  daysAfterBillingDate: z.coerce.number().int().min(0, "Days after billing cannot be negative"),
});

/** Percentage installments must sum to 100%; fixed-amount installments must sum to Scheme Value (With GST). */
const CENTS = (n: number) => Math.round(n * 100);
function validateInstallments(rules: z.infer<typeof installmentInput>[], schemeValueWithGST: number, ctx: z.RefinementCtx) {
  if (rules.length === 0) return; // installments are optional
  const types = new Set(rules.map((r) => r.calculationType));
  if (types.size > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: "All installments must use the same calculation type" });
    return;
  }
  const total = rules.reduce((sum, r) => sum + r.value, 0);
  if (rules[0].calculationType === SchemeCalcType.PERCENTAGE) {
    if (CENTS(total) !== CENTS(100)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: `Percentages must total 100% (currently ${total}%)` });
  } else {
    if (CENTS(total) !== CENTS(schemeValueWithGST)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: `Fixed amounts must total the Scheme Value (With GST) ₹${schemeValueWithGST}` });
  }
}

const schemeInput = z.object({
  schemeName: z.string().trim().min(1, "Scheme Name is required").max(200),
  stateIds: z.array(z.string().min(1)).min(1, "Select at least one State"),
  isPerpetual: z.boolean().default(false),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  bookingLastDate: z.coerce.date().nullable().optional(),
  schemeValueWithoutGST: z.coerce.number().min(0, "Scheme Value (Without GST) cannot be negative"),
  schemeValueWithGST: z.coerce.number().min(0, "Scheme Value (With GST) cannot be negative"),
  bookingAmount: z.coerce.number().min(0, "Booking Amount cannot be negative").nullable().optional(),
  schemeBenefit: z.nativeEnum(SchemeBenefit),
  benefitDetails: z.string().trim().max(500).nullable().optional(),
  otherBenefitDetails: z.string().trim().max(500).nullable().optional(),
  allowMultipleSchemes: z.boolean(),
  documentUrl: z.string().max(5_000_000).nullable().optional(),
  installments: z.array(installmentInput).max(10).optional().default([]),
}).superRefine((value, ctx) => {
  if (!value.isPerpetual && (!value.startDate || !value.endDate || !value.bookingLastDate)) {
    for (const field of ["startDate", "endDate", "bookingLastDate"] as const) if (!value[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "This date is required unless the scheme is perpetual" });
  }
  if (!value.isPerpetual && value.startDate && value.endDate && value.endDate < value.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "End Date must be on or after Start Date" });
  if (value.schemeBenefit === SchemeBenefit.OTHER && !value.benefitDetails) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["benefitDetails"], message: "Benefit Details are required when Benefit is Other" });
  validateInstallments(value.installments ?? [], value.schemeValueWithGST, ctx);
});

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can manage schemes");
}

/** Reusable end-date rule for a future scheduler. Booking date never closes a scheme; neither does a perpetual scheme. */
export async function refreshSchemeStatuses(now = new Date()) {
  return prisma.scheme.updateMany({
    where: { status: SchemeStatus.OPEN, isPerpetual: false, endDate: { lt: now } },
    data: { status: SchemeStatus.CLOSED },
  });
}

type InstallmentRow = { installmentNumber: number; calculationType: SchemeCalcType; value: unknown; daysAfterBillingDate: number };
const mapInstallments = (rules: InstallmentRow[]) => rules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value), daysAfterBillingDate: r.daysAfterBillingDate }));

export async function listSchemes(ctx: AuthContext, filters: { status?: string | null; stateId?: string | null }) {
  await refreshSchemeStatuses();
  const status = filters.status === SchemeStatus.OPEN || filters.status === SchemeStatus.CLOSED ? filters.status : undefined;
  const rows = await prisma.scheme.findMany({
    where: { status, ...(filters.stateId ? { states: { some: { groupId: filters.stateId } } } : {}) },
    include: { states: { include: { group: { select: { id: true, name: true } } } }, createdBy: { select: { name: true } }, installmentRules: true },
    orderBy: [{ isPerpetual: "desc" }, { endDate: "desc" }, { updatedAt: "desc" }],
  });
  return rows.map((s) => ({ ...s, schemeValueWithoutGST: Number(s.schemeValueWithoutGST), schemeValueWithGST: Number(s.schemeValueWithGST), bookingAmount: s.bookingAmount == null ? null : Number(s.bookingAmount), states: s.states.map((x) => x.group), installments: mapInstallments(s.installmentRules) }));
}

export async function getScheme(ctx: AuthContext, id: string) {
  await refreshSchemeStatuses();
  const row = await prisma.scheme.findUnique({ where: { id }, include: { states: { include: { group: { select: { id: true, name: true } } } }, installmentRules: true } });
  if (!row) throw new ApiError(404, "Scheme not found");
  return { ...row, schemeValueWithoutGST: Number(row.schemeValueWithoutGST), schemeValueWithGST: Number(row.schemeValueWithGST), bookingAmount: row.bookingAmount == null ? null : Number(row.bookingAmount), stateIds: row.states.map((x) => x.groupId), states: row.states.map((x) => x.group), installments: mapInstallments(row.installmentRules) };
}

export async function schemeStateOptions() {
  return prisma.userGroup.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
}

export async function createScheme(ctx: AuthContext, raw: unknown) {
  assertAdmin(ctx);
  const data = schemeInput.parse(raw);
  const { stateIds, installments, ...schemeData } = data;
  const normalized = schemeData.isPerpetual ? { ...schemeData, startDate: null, endDate: null, bookingLastDate: null } : schemeData;
  const scheme = await prisma.scheme.create({
    data: {
      ...normalized,
      bookingAmount: normalized.bookingAmount ?? null,
      benefitDetails: normalized.schemeBenefit === SchemeBenefit.OTHER ? normalized.benefitDetails : null,
      otherBenefitDetails: normalized.otherBenefitDetails || null,
      documentUrl: normalized.documentUrl || null,
      createdById: ctx.userId,
      states: { create: stateIds.map((groupId) => ({ groupId })) },
      installmentRules: { create: installments.map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: r.value, daysAfterBillingDate: r.daysAfterBillingDate })) },
    },
  });
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "scheme", entityId: scheme.id, summary: `Created scheme ${scheme.schemeName}` });
  return { id: scheme.id };
}

export async function updateScheme(ctx: AuthContext, id: string, raw: unknown) {
  assertAdmin(ctx);
  const data = schemeInput.parse(raw);
  const { stateIds, installments, ...schemeData } = data;
  const normalized = schemeData.isPerpetual ? { ...schemeData, startDate: null, endDate: null, bookingLastDate: null } : schemeData;
  const scheme = await prisma.scheme.update({
    where: { id },
    data: {
      ...normalized,
      bookingAmount: normalized.bookingAmount ?? null,
      benefitDetails: normalized.schemeBenefit === SchemeBenefit.OTHER ? normalized.benefitDetails : null,
      otherBenefitDetails: normalized.otherBenefitDetails || null,
      documentUrl: normalized.documentUrl || null,
      states: { deleteMany: {}, create: stateIds.map((groupId) => ({ groupId })) },
      installmentRules: { deleteMany: {}, create: installments.map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: r.value, daysAfterBillingDate: r.daysAfterBillingDate })) },
    },
  });
  await refreshSchemeStatuses();
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "scheme", entityId: id, summary: `Updated scheme ${scheme.schemeName}` });
  return { id };
}

export async function closeScheme(ctx: AuthContext, id: string) {
  assertAdmin(ctx);
  const scheme = await prisma.scheme.update({ where: { id }, data: { status: SchemeStatus.CLOSED }, select: { schemeName: true } });
  await writeAudit({ userId: ctx.userId, action: "CLOSE", entity: "scheme", entityId: id, summary: `Closed scheme ${scheme.schemeName}` });
  return { closed: true };
}
