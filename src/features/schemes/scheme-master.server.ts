import "server-only";
import { SchemeBenefit, SchemeStatus, SchemeCalcType, SchemeRequirementType, SchemeValueMode, SchemeStructure, SchemeOptionAchievementType, Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { validateSchemeRequirement, normalizeSchemeRequirement } from "@/lib/scheme-requirement";
import { validateMultipleOptions, normalizeOption, type OptionAchievementType } from "@/lib/scheme-options";
import { bookingExceedsFinalInstallment } from "@/lib/scheme-installments";

// One installment of the payout schedule for Scheme Value (With GST).
const installmentInput = z.object({
  installmentNumber: z.coerce.number().int().min(1).max(10),
  calculationType: z.nativeEnum(SchemeCalcType),
  value: z.coerce.number().min(0, "Installment value cannot be negative"),
  daysAfterBillingDate: z.coerce.number().int().min(0, "Days after billing cannot be negative"),
});

/** Percentage installments total 100%. Fixed rules total the value unless their final rule is a per-option balance. */
const CENTS = (n: number) => Math.round(n * 100);
function validateInstallments(rules: z.infer<typeof installmentInput>[], schemeValueWithGST: number, ctx: z.RefinementCtx, balanceFixedAmounts = false) {
  if (rules.length === 0) return; // installments are optional
  const types = new Set(rules.map((r) => r.calculationType));
  if (types.size > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: "All installments must use the same calculation type" });
    return;
  }
  const total = rules.reduce((sum, r) => sum + r.value, 0);
  if (rules[0].calculationType === SchemeCalcType.PERCENTAGE) {
    if (CENTS(total) !== CENTS(100)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: `Percentages must total 100% (currently ${total}%)` });
  } else if (!balanceFixedAmounts) {
    if (CENTS(total) !== CENTS(schemeValueWithGST)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: `Fixed amounts must total the Scheme Value (With GST) ₹${schemeValueWithGST}` });
  }
}

// One row of a Scheme Requirement. requiredQty (Product Based) / requiredValue (Value Based Individual)
// are optional here; the exact combination is enforced by validateSchemeRequirement in the superRefine.
const requirementProductInput = z.object({
  productId: z.string().min(1),
  requiredQty: z.coerce.number().nullable().optional(),
  requiredValue: z.coerce.number().nullable().optional(),
});

// One Multiple Options row (Phase 10). id present ⇒ an existing option (update path); absent ⇒ new option.
const schemeOptionInput = z.object({
  id: z.string().optional(),
  label: z.string().trim().max(100).nullable().optional(),
  target: z.coerce.number().nullable().optional(),
  valueWithoutGST: z.coerce.number().nullable().optional(),
  valueWithGST: z.coerce.number().nullable().optional(),
  bookingAmount: z.coerce.number().min(0).nullable().optional(),
  isActive: z.boolean(),
});

const schemeInput = z.object({
  schemeName: z.string().trim().min(1, "Scheme Name is required").max(200),
  stateIds: z.array(z.string().min(1)).min(1, "Select at least one State"),
  isPerpetual: z.boolean().default(false),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  bookingLastDate: z.coerce.date().nullable().optional(),
  // FIXED: required (enforced in superRefine). MULTIPLE_OPTIONS: null (values live on each option).
  schemeValueWithoutGST: z.coerce.number().min(0, "Scheme Value (Without GST) cannot be negative").nullable().optional(),
  schemeValueWithGST: z.coerce.number().min(0, "Scheme Value (With GST) cannot be negative").nullable().optional(),
  bookingAmount: z.coerce.number().min(0, "Booking Amount cannot be negative").nullable().optional(),
  schemeBenefit: z.nativeEnum(SchemeBenefit),
  benefitDetails: z.string().trim().max(500).nullable().optional(),
  otherBenefitDetails: z.string().trim().min(1, "Other Benefit Details are required").max(500),
  allowMultipleSchemes: z.boolean(),
  maxExtensionDays: z.coerce.number().int().min(1, "Select SO Conversion Extension").max(365),
  maxExtensionAttempts: z.coerce.number().int().min(-1).max(20),
  // Pre-placement MASTER ceiling (Phase 11). 0 ⇒ not available. Actual per-dealer days are chosen in planning.
  prePlacementMaxDays: z.coerce.number().int().min(0, "Select Allowed Pre-placement Days").max(365),
  documentUrl: z.string().max(5_000_000).nullable().optional(),
  installmentBalance: z.boolean().optional(),
  installments: z.array(installmentInput).min(1, "Select at least one installment").max(10),
  // Scheme Requirement (Phase 5). Belongs to the Scheme, not to individual dealers. Fixed schemes must
  // explicitly choose a real basis; Multiple Options uses NONE internally because its basis is separate.
  requirementType: z.nativeEnum(SchemeRequirementType),
  valueMode: z.nativeEnum(SchemeValueMode).nullable().optional(),
  combinedRequiredValue: z.coerce.number().nullable().optional(),
  requirementProducts: z.array(requirementProductInput).max(200).optional().default([]),
  // Scheme Structure (Phase 10). FIXED keeps the requirement* fields above; MULTIPLE_OPTIONS uses
  // optionAchievementType + eligibleProductIds + options.
  structure: z.nativeEnum(SchemeStructure),
  optionAchievementType: z.nativeEnum(SchemeOptionAchievementType).nullable().optional(),
  eligibleProductIds: z.array(z.string().min(1)).max(500).optional().default([]),
  options: z.array(schemeOptionInput).max(50).optional().default([]),
}).superRefine((value, ctx) => {
  if (!value.isPerpetual && (!value.startDate || !value.endDate || !value.bookingLastDate)) {
    for (const field of ["startDate", "endDate", "bookingLastDate"] as const) if (!value[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "This date is required unless the scheme is perpetual" });
  }
  if (!value.isPerpetual && value.startDate && value.endDate && value.endDate < value.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "End Date must be on or after Start Date" });
  if (value.schemeBenefit === SchemeBenefit.OTHER && !value.benefitDetails) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["benefitDetails"], message: "Benefit Details are required when Benefit is Other" });

  if (value.structure !== SchemeStructure.MULTIPLE_OPTIONS && value.installmentBalance && value.installments.some(r => r.calculationType !== SchemeCalcType.PERCENTAGE)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: "Balance schedules use percentage rules" });
  }
  if (value.structure === SchemeStructure.MULTIPLE_OPTIONS) {
    // MULTIPLE_OPTIONS: scheme-level values must be null (they live on each option); no Fixed requirement.
    if (value.schemeValueWithGST != null || value.schemeValueWithoutGST != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schemeValueWithGST"], message: "A Multiple Options scheme has no scheme-level value — values belong to each option" });
    }
    for (const message of validateMultipleOptions({
      achievementType: (value.optionAchievementType ?? "QUANTITY_BASED") as OptionAchievementType,
      eligibleProductIds: value.eligibleProductIds ?? [],
      options: value.options ?? [],
    })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message });
    }
    if (value.optionAchievementType == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["optionAchievementType"], message: "Select an achievement type" });
    for (let index = 0; index < value.options.length; index++) {
      if (value.options[index].bookingAmount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options", index, "bookingAmount"], message: "Booking Amount is required for every option" });
    }
    const optionAmountMode = value.installments[0]?.calculationType === SchemeCalcType.FIXED_AMOUNT;
    if (optionAmountMode && !value.installmentBalance) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installmentBalance"], message: "Options Amount mode requires the final installment to be Balance" });
    }
    if (optionAmountMode) {
      const finalRule = value.installments.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).at(-1);
      if (finalRule && CENTS(finalRule.value) !== 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: "The final installment in Options Amount mode must be Balance" });
      }
    }
    // Amount rows are shared across options. Their final rule is a persisted balance marker, so each option's
    // GST-inclusive value is validated independently below rather than against a nonexistent scheme-level total.
    validateInstallments(value.installments ?? [], 0, ctx, optionAmountMode && (value.installmentBalance ?? false));
    // Booking Amount is deducted from the final installment (canonical calc): it must not exceed the final
    // installment's normal amount for ANY active option (else that option's final installment goes negative).
    const moRules = (value.installments ?? []).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: r.value }));
    for (const o of value.options ?? []) {
      if (o.isActive === false) continue;
      const optVal = o.valueWithGST ?? 0;
      if (optVal > 0 && bookingExceedsFinalInstallment(moRules, optVal, o.bookingAmount ?? value.bookingAmount ?? 0, value.installmentBalance ?? false)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingAmount"], message: "Booking Amount is larger than an option's final installment. Reduce the Booking Amount or the earlier installments." });
        break;
      }
    }
  } else {
    // FIXED: scheme-level values required (unchanged behaviour), plus installment + requirement validation.
    if (value.bookingAmount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingAmount"], message: "Booking Amount is required" });
    if (value.schemeValueWithoutGST == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schemeValueWithoutGST"], message: "Scheme Value (Without GST) is required" });
    if (value.schemeValueWithGST == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schemeValueWithGST"], message: "Scheme Value (With GST) is required" });
    if (value.schemeValueWithoutGST != null && value.schemeValueWithGST != null && CENTS(value.schemeValueWithGST) < CENTS(value.schemeValueWithoutGST)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schemeValueWithGST"], message: "Scheme Value (With GST) must be greater than or equal to Scheme Value (Without GST)" });
    }
    if (value.requirementType === SchemeRequirementType.NONE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirementType"], message: "Select a Scheme Basis" });
    }
    validateInstallments(value.installments ?? [], value.schemeValueWithGST ?? 0, ctx);
    // Booking Amount is deducted from the final installment (canonical calc): it must not exceed the final
    // installment's normal amount, otherwise the final installment would be negative.
    if (bookingExceedsFinalInstallment(
      (value.installments ?? []).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: r.value })),
      value.schemeValueWithGST ?? 0,
      value.bookingAmount ?? 0,
      value.installmentBalance ?? false,
    )) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingAmount"], message: "Booking Amount is larger than the final installment. Reduce the Booking Amount or the earlier installments." });
    }
    // Server-side requirement validation — rejects every ambiguous/invalid combination even if the client
    // allowed it. Single source of truth shared with the client (src/lib/scheme-requirement.ts).
    for (const message of validateSchemeRequirement({
      requirementType: value.requirementType,
      valueMode: value.valueMode ?? null,
      combinedRequiredValue: value.combinedRequiredValue ?? null,
      products: value.requirementProducts ?? [],
    })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirementProducts"], message });
    }
  }
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

type RequirementProductRow = { productId: string; requiredQty: unknown; requiredValue: unknown };
const mapRequirementProducts = (rows: RequirementProductRow[]) => rows.map((r) => ({ productId: r.productId, requiredQty: r.requiredQty == null ? null : Number(r.requiredQty), requiredValue: r.requiredValue == null ? null : Number(r.requiredValue) }));

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v.toString()));
type OptionRow = { id: string; label: string | null; targetQty: unknown; targetValue: unknown; valueWithoutGST: unknown; valueWithGST: unknown; bookingAmount: unknown; sortOrder: number; isActive: boolean };
const mapOptions = (rows: OptionRow[]) => rows.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((o) => ({
  id: o.id, label: o.label, target: numOrNull(o.targetQty) ?? numOrNull(o.targetValue), targetQty: numOrNull(o.targetQty), targetValue: numOrNull(o.targetValue),
  valueWithoutGST: Number(o.valueWithoutGST), valueWithGST: Number(o.valueWithGST), bookingAmount: numOrNull(o.bookingAmount), sortOrder: o.sortOrder, isActive: o.isActive,
}));
const OPTION_INCLUDE = { options: { orderBy: { sortOrder: "asc" } as const }, eligibleProducts: { select: { productId: true } } };

export async function listSchemes(ctx: AuthContext, filters: { status?: string | null; stateId?: string | null }) {
  await refreshSchemeStatuses();
  const status = filters.status === SchemeStatus.OPEN || filters.status === SchemeStatus.CLOSED ? filters.status : undefined;
  const rows = await prisma.scheme.findMany({
    where: { status, ...(filters.stateId ? { states: { some: { groupId: filters.stateId } } } : {}) },
    include: { states: { include: { group: { select: { id: true, name: true } } } }, createdBy: { select: { name: true } }, installmentRules: true, requirementProducts: true, ...OPTION_INCLUDE },
    orderBy: [{ isPerpetual: "desc" }, { endDate: "desc" }, { updatedAt: "desc" }],
  });
  return rows.map((s) => ({ ...s, schemeValueWithoutGST: numOrNull(s.schemeValueWithoutGST), schemeValueWithGST: numOrNull(s.schemeValueWithGST), bookingAmount: s.bookingAmount == null ? null : Number(s.bookingAmount), combinedRequiredValue: s.combinedRequiredValue == null ? null : Number(s.combinedRequiredValue), states: s.states.map((x) => x.group), installments: mapInstallments(s.installmentRules), requirementProducts: mapRequirementProducts(s.requirementProducts), options: mapOptions(s.options as OptionRow[]), eligibleProductIds: (s.eligibleProducts as { productId: string }[]).map((e) => e.productId) }));
}

export async function getScheme(ctx: AuthContext, id: string) {
  await refreshSchemeStatuses();
  const row = await prisma.scheme.findUnique({ where: { id }, include: { states: { include: { group: { select: { id: true, name: true } } } }, installmentRules: true, requirementProducts: true, ...OPTION_INCLUDE } });
  if (!row) throw new ApiError(404, "Scheme not found");
  return { ...row, schemeValueWithoutGST: numOrNull(row.schemeValueWithoutGST), schemeValueWithGST: numOrNull(row.schemeValueWithGST), bookingAmount: row.bookingAmount == null ? null : Number(row.bookingAmount), combinedRequiredValue: row.combinedRequiredValue == null ? null : Number(row.combinedRequiredValue), stateIds: row.states.map((x) => x.groupId), states: row.states.map((x) => x.group), installments: mapInstallments(row.installmentRules), requirementProducts: mapRequirementProducts(row.requirementProducts), options: mapOptions(row.options as OptionRow[]), eligibleProductIds: (row.eligibleProducts as { productId: string }[]).map((e) => e.productId) };
}

export async function schemeStateOptions() {
  return prisma.userGroup.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
}

type SchemeData = z.infer<typeof schemeInput>;

/** Structure-aware scalar fields shared by create/update. FIXED keeps its value pair + Fixed requirement;
 *  MULTIPLE_OPTIONS nulls the scheme-level value pair + requirement fields (values live on each option). */
function schemeScalarData(data: SchemeData) {
  const { stateIds, installments, requirementType, valueMode, combinedRequiredValue, requirementProducts,
    structure, optionAchievementType, eligibleProductIds, options, schemeValueWithoutGST, schemeValueWithGST, ...rest } = data;
  void stateIds; void installments; void eligibleProductIds; void options;
  const normalized = rest.isPerpetual ? { ...rest, startDate: null, endDate: null, bookingLastDate: null } : rest;
  const isOptions = structure === SchemeStructure.MULTIPLE_OPTIONS;
  const req = isOptions ? null : normalizeSchemeRequirement({ requirementType, valueMode: valueMode ?? null, combinedRequiredValue: combinedRequiredValue ?? null, products: requirementProducts });
  return {
    scalar: {
      ...normalized,
      bookingAmount: normalized.bookingAmount ?? null,
      benefitDetails: normalized.schemeBenefit === SchemeBenefit.OTHER ? normalized.benefitDetails : null,
      otherBenefitDetails: normalized.otherBenefitDetails || null,
      documentUrl: normalized.documentUrl || null,
      structure,
      optionAchievementType: isOptions ? (optionAchievementType ?? null) : null,
      schemeValueWithoutGST: isOptions ? null : (schemeValueWithoutGST ?? null),
      schemeValueWithGST: isOptions ? null : (schemeValueWithGST ?? null),
      requirementType: isOptions ? SchemeRequirementType.NONE : req!.requirementType,
      valueMode: isOptions ? null : req!.valueMode,
      combinedRequiredValue: isOptions ? null : req!.combinedRequiredValue,
    },
    isOptions,
    reqProducts: isOptions ? [] : req!.products,
    achievementType: (optionAchievementType ?? "QUANTITY_BASED") as OptionAchievementType,
  };
}

const optionCreateRows = (options: SchemeData["options"], achievementType: OptionAchievementType) =>
  (options ?? []).map((o, i) => {
    const nrm = normalizeOption(o, achievementType);
    return { label: nrm.label, targetQty: nrm.targetQty, targetValue: nrm.targetValue, valueWithoutGST: nrm.valueWithoutGST, valueWithGST: nrm.valueWithGST, bookingAmount: o.bookingAmount, sortOrder: i, isActive: o.isActive ?? true };
  });

export async function createScheme(ctx: AuthContext, raw: unknown) {
  assertAdmin(ctx);
  const data = schemeInput.parse(raw);
  const { scalar, isOptions, reqProducts, achievementType } = schemeScalarData(data);
  const eligible = [...new Set(data.eligibleProductIds ?? [])];
  const scheme = await prisma.scheme.create({
    data: {
      ...scalar,
      createdById: ctx.userId,
      states: { create: data.stateIds.map((groupId) => ({ groupId })) },
      installmentRules: { create: data.installments.map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: r.value, daysAfterBillingDate: r.daysAfterBillingDate })) },
      requirementProducts: { create: reqProducts.map((p) => ({ productId: p.productId, requiredQty: p.requiredQty, requiredValue: p.requiredValue })) },
      eligibleProducts: { create: isOptions ? eligible.map((productId) => ({ productId })) : [] },
      options: { create: isOptions ? optionCreateRows(data.options, achievementType) : [] },
    },
  });
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "scheme", entityId: scheme.id, summary: `Created scheme ${scheme.schemeName} (${data.structure})` });
  return { id: scheme.id };
}

export async function updateScheme(ctx: AuthContext, id: string, raw: unknown) {
  assertAdmin(ctx);
  const data = schemeInput.parse(raw);
  const { scalar, isOptions, reqProducts, achievementType } = schemeScalarData(data);
  const eligible = [...new Set(data.eligibleProductIds ?? [])];

  // Structure can only change while NO dealer has been planned into the scheme (protects committed snapshots).
  const existing = (await prisma.scheme.findUnique({ where: { id }, select: { structure: true, _count: { select: { dealerPlans: true } } } })) as { structure: string; _count: { dealerPlans: number } } | null;
  if (!existing) throw new ApiError(404, "Scheme not found");
  if (existing.structure !== data.structure && existing._count.dealerPlans > 0) {
    throw new ApiError(409, "The scheme structure cannot be changed after dealers have been planned into this scheme.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.scheme.update({
      where: { id },
      data: {
        ...scalar,
        states: { deleteMany: {}, create: data.stateIds.map((groupId) => ({ groupId })) },
        installmentRules: { deleteMany: {}, create: data.installments.map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: r.value, daysAfterBillingDate: r.daysAfterBillingDate })) },
        // Requirement/eligible rows carry no plan FK, so replace is safe and never touches SchemeSale history.
        requirementProducts: { deleteMany: {}, create: reqProducts.map((p) => ({ productId: p.productId, requiredQty: p.requiredQty, requiredValue: p.requiredValue })) },
        eligibleProducts: { deleteMany: {}, create: isOptions ? eligible.map((productId) => ({ productId })) : [] },
      },
    });

    // Options need a RECONCILE (not deleteMany+create): an option selected by a dealer is FK-Restricted and
    // must be DISCONTINUED (isActive=false), never deleted — preserving the dealer's committed snapshot.
    const current = (await tx.schemeOption.findMany({ where: { schemeId: id }, select: { id: true, _count: { select: { dealerPlans: true } } } })) as { id: string; _count: { dealerPlans: number } }[];
    const incoming = isOptions ? (data.options ?? []) : [];
    const incomingIds = new Set(incoming.filter((o) => o.id).map((o) => o.id as string));
    // Remove/discontinue options no longer present.
    for (const cur of current) {
      if (incomingIds.has(cur.id)) continue;
      if (cur._count.dealerPlans > 0) await tx.schemeOption.update({ where: { id: cur.id }, data: { isActive: false, discontinuedAt: new Date() } });
      else await tx.schemeOption.delete({ where: { id: cur.id } });
    }
    // Update existing + create new (sortOrder = payload order).
    for (let i = 0; i < incoming.length; i++) {
      const o = incoming[i];
      const nrm = normalizeOption(o, achievementType);
      const row = { label: nrm.label, targetQty: nrm.targetQty, targetValue: nrm.targetValue, valueWithoutGST: nrm.valueWithoutGST, valueWithGST: nrm.valueWithGST, bookingAmount: o.bookingAmount, sortOrder: i, isActive: o.isActive ?? true };
      if (o.id) await tx.schemeOption.update({ where: { id: o.id }, data: row });
      else await tx.schemeOption.create({ data: { ...row, schemeId: id } });
    }
  });

  await refreshSchemeStatuses();
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "scheme", entityId: id, summary: `Updated scheme ${data.schemeName} (${data.structure})` });
  return { id };
}

export async function closeScheme(ctx: AuthContext, id: string) {
  assertAdmin(ctx);
  const scheme = await prisma.scheme.update({ where: { id }, data: { status: SchemeStatus.CLOSED }, select: { schemeName: true } });
  await writeAudit({ userId: ctx.userId, action: "CLOSE", entity: "scheme", entityId: id, summary: `Closed scheme ${scheme.schemeName}` });
  return { closed: true };
}

/**
 * Reopen a manually-closed scheme (CLOSED → OPEN). A non-perpetual scheme whose end date has already
 * passed is EXPIRED and cannot be reopened directly — the admin must extend the Scheme Period first (Edit).
 * Perpetual schemes have no end date and may always be reopened. All other scheme details are unchanged.
 */
/** Minimum meaningful length for a deletion reason (see requirement #9). */
const MIN_DELETE_REASON = 10;

/**
 * Real, database-computed counts of the records a permanent deletion would remove. Used to populate the
 * pre-deletion confirmation summary — every number is queried, never inferred (e.g. never assume
 * numberOfSchemes = instance count; count the actual DealerSchemeInstance rows).
 */
export async function getSchemeDeletionImpact(ctx: AuthContext, id: string) {
  assertAdmin(ctx);
  const scheme = await prisma.scheme.findUnique({ where: { id }, select: { id: true, schemeName: true } });
  if (!scheme) throw new ApiError(404, "Scheme not found");
  const [dealerPlans, installmentRules, states] = await Promise.all([
    prisma.dealerSchemePlan.count({ where: { schemeId: id } }),
    prisma.schemeInstallmentRule.count({ where: { schemeId: id } }),
    prisma.schemeState.count({ where: { schemeId: id } }),
  ]);
  const [instances, installments] = await Promise.all([
    prisma.dealerSchemeInstance.count({ where: { dealerSchemePlan: { schemeId: id } } }),
    prisma.dealerSchemeInstallment.count({ where: { OR: [{ instance: { dealerSchemePlan: { schemeId: id } } }, { bill: { plan: { schemeId: id } } }] } }),
  ]);
  return { schemeId: scheme.id, schemeName: scheme.schemeName, dealerPlans, instances, installments, installmentRules, states };
}

/**
 * PERMANENTLY delete a Scheme and every record exclusively owned by it. High-risk, irreversible, atomic.
 *
 * Boundary (see the reviewed dependency analysis): DELETE the Scheme + its SchemeInstallmentRules,
 * SchemeState join rows, and the full DealerSchemePlan → DealerSchemeInstance → DealerSchemeInstallment
 * subtree (which carries all SO-conversion, admin-verification, billing and installment data as columns).
 * PRESERVE every shared master (User, Dealer, UserGroup, Product, …) — none are children of Scheme.
 *
 * Deletes are explicit and bottom-up inside one interactive transaction so the boundary is auditable and
 * the counts are real, rather than relying blindly on DB cascade. The audit row is written on the SAME
 * transaction client and, because AuditLog has no FK to Scheme, survives the deletion as a snapshot.
 * All-or-nothing: any failure rolls the whole thing back — the scheme is never left partially deleted.
 */
export async function deleteScheme(ctx: AuthContext, id: string, rawReason: unknown) {
  assertAdmin(ctx);
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length < MIN_DELETE_REASON) {
    throw new ApiError(422, `A deletion reason of at least ${MIN_DELETE_REASON} characters is required.`);
  }

  return prisma.$transaction(async (tx) => {
    // Re-read inside the transaction — a concurrent/second delete finds it already gone (idempotent 404).
    const scheme = await tx.scheme.findUnique({ where: { id }, select: { id: true, schemeName: true } });
    if (!scheme) throw new ApiError(404, "Scheme not found");

    // Real counts (also serve as the audit snapshot). Instances/installments are reached via relations.
    const [dealerPlans, installmentRules, states, instances, installments] = await Promise.all([
      tx.dealerSchemePlan.count({ where: { schemeId: id } }),
      tx.schemeInstallmentRule.count({ where: { schemeId: id } }),
      tx.schemeState.count({ where: { schemeId: id } }),
      tx.dealerSchemeInstance.count({ where: { dealerSchemePlan: { schemeId: id } } }),
      tx.dealerSchemeInstallment.count({ where: { OR: [{ instance: { dealerSchemePlan: { schemeId: id } } }, { bill: { plan: { schemeId: id } } }] } }),
    ]);

    // Explicit bottom-up deletion (leaf → root). Each layer is scoped to THIS scheme only.
    // Payment transactions + allocations first (they reference installments and the plan).
    await tx.schemePaymentAllocation.deleteMany({ where: { payment: { plan: { schemeId: id } } } });
    await tx.schemePayment.deleteMany({ where: { plan: { schemeId: id } } });
    await tx.dealerSchemeInstallment.deleteMany({ where: { OR: [{ instance: { dealerSchemePlan: { schemeId: id } } }, { bill: { plan: { schemeId: id } } }] } });
    await tx.dealerSchemeInstance.deleteMany({ where: { dealerSchemePlan: { schemeId: id } } });
    await tx.dealerSchemePlan.deleteMany({ where: { schemeId: id } });
    await tx.schemeInstallmentRule.deleteMany({ where: { schemeId: id } });
    await tx.schemeState.deleteMany({ where: { schemeId: id } });
    await tx.scheme.delete({ where: { id } });

    const counts = { dealerPlans, instances, installments, installmentRules, states };
    // Snapshot everything needed to identify the deleted scheme forever (no live FK to Scheme).
    await writeAudit(
      {
        userId: ctx.userId,
        action: "SCHEME_PERMANENTLY_DELETED",
        entity: "scheme",
        entityId: scheme.id,
        summary: JSON.stringify({ schemeName: scheme.schemeName, reason, actor: ctx.username, counts, deletedAt: new Date().toISOString() }),
      },
      tx,
    );

    return { deleted: true, schemeName: scheme.schemeName, ...counts };
  });
}

export async function reopenScheme(ctx: AuthContext, id: string, now = new Date()) {
  assertAdmin(ctx);
  const scheme = await prisma.scheme.findUnique({ where: { id }, select: { schemeName: true, status: true, isPerpetual: true, endDate: true } });
  if (!scheme) throw new ApiError(404, "Scheme not found");
  if (scheme.status !== SchemeStatus.CLOSED) throw new ApiError(409, "Only a closed scheme can be reopened");
  if (!scheme.isPerpetual && scheme.endDate && scheme.endDate < now) {
    throw new ApiError(422, "This scheme's period has expired. Extend the Scheme End Date (Edit) before reopening.");
  }
  await prisma.scheme.update({ where: { id }, data: { status: SchemeStatus.OPEN } });
  await writeAudit({ userId: ctx.userId, action: "REOPEN", entity: "scheme", entityId: id, summary: `Reopened scheme ${scheme.schemeName}` });
  return { reopened: true };
}
