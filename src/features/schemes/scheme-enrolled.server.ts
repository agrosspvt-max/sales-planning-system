import "server-only";
import { Role, SchemeStatus, SchemeEnrollmentStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";

/**
 * Enrolled Scheme — the operational layer AFTER a dealer is enrolled (Admin document verification).
 * Tracks each enrolled dealer's installment schedule (seeded from the scheme's installment rules and the
 * dealer's billing date), received payments, and a computed payment status. Planning/enrollment workflow
 * is untouched here; this only reads enrolled plans and manages their installment rows.
 */

const money = (n: unknown): number => (n == null ? 0 : Number(n.toString()));
const day = 24 * 60 * 60 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * day);
}

/* --------------------------- Installment generation --------------------------- */

type RuleRow = { installmentNumber: number; calculationType: string; value: unknown; daysAfterBillingDate: number };

/** Planned amount for a rule row against the scheme's With-GST value. */
function plannedAmountFor(rule: RuleRow, schemeValueWithGST: number): number {
  return rule.calculationType === "PERCENTAGE" ? round2((schemeValueWithGST * Number(rule.value)) / 100) : round2(Number(rule.value));
}

/**
 * Ensure a plan has its installment rows. Creates them once from the scheme rules + billing date. Safe to
 * call on every read — it only inserts when none exist yet (so manual edits are never overwritten here).
 */
async function ensureInstallments(planId: string): Promise<void> {
  const existing = (await prisma.dealerSchemeInstallment.count({ where: { dealerSchemePlanId: planId } })) as number;
  if (existing > 0) return;
  const plan = (await prisma.dealerSchemePlan.findUnique({
    where: { id: planId },
    select: { expectedBillingDate: true, scheme: { select: { schemeValueWithGST: true, installmentRules: true } } },
  })) as { expectedBillingDate: Date | null; scheme: { schemeValueWithGST: unknown; installmentRules: RuleRow[] } } | null;
  if (!plan) return;
  const rules = plan.scheme.installmentRules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber);
  if (rules.length === 0) return;
  const gst = money(plan.scheme.schemeValueWithGST);
  const billing = plan.expectedBillingDate;
  await prisma.dealerSchemeInstallment.createMany({
    data: rules.map((r) => ({
      dealerSchemePlanId: planId,
      installmentNumber: r.installmentNumber,
      plannedAmount: plannedAmountFor(r, gst),
      plannedDate: billing ? addDays(billing, r.daysAfterBillingDate) : null,
      status: "PENDING",
    })),
  });
}

/* --------------------------- Status helpers --------------------------- */

export interface InstallmentRow {
  id: string; installmentNumber: number; plannedAmount: number; plannedDate: string | null;
  receivedAmount: number | null; receivedDate: string | null; status: string;
}
type RawInst = { id: string; installmentNumber: number; plannedAmount: unknown; plannedDate: Date | null; receivedAmount: unknown; receivedDate: Date | null; status: string };

/** Derive an installment's display status: RECEIVED if paid; OVERDUE if pending & past planned date; else PENDING. */
function installmentStatus(i: RawInst, now: Date): string {
  if (i.receivedAmount != null) return "RECEIVED";
  if (i.plannedDate && i.plannedDate < now) return "OVERDUE";
  return "PENDING";
}

/** Dealer-level payment status rolled up from its installments. */
function dealerStatus(insts: { status: string }[]): string {
  if (insts.length === 0) return "Enrolled";
  const received = insts.filter((i) => i.status === "RECEIVED").length;
  if (received === insts.length) return "Completed";
  if (insts.some((i) => i.status === "OVERDUE")) return "Overdue";
  if (received > 0) return "Installment Received";
  return "Installment Pending";
}

/* --------------------------- List --------------------------- */

export interface EnrolledSchemeListRow {
  id: string; schemeName: string; enrolledDealers: number; startDate: string | null; endDate: string | null; isPerpetual: boolean; status: string;
}

/** Schemes that have at least one ENROLLED dealer within the caller's scope — one row per scheme. */
export async function enrolledSchemes(ctx: AuthContext): Promise<EnrolledSchemeListRow[]> {
  const scope = await getOfficerScope(ctx);
  const plans = (await prisma.dealerSchemePlan.findMany({
    where: { enrollmentStatus: SchemeEnrollmentStatus.ENROLLED, ...(scope.all ? {} : { salesOfficerId: { in: scope.ids } }) },
    select: { schemeId: true, scheme: { select: { schemeName: true, startDate: true, endDate: true, isPerpetual: true, status: true } } },
  })) as { schemeId: string; scheme: { schemeName: string; startDate: Date | null; endDate: Date | null; isPerpetual: boolean; status: string } }[];

  const map = new Map<string, EnrolledSchemeListRow>();
  for (const p of plans) {
    const cur = map.get(p.schemeId);
    if (cur) { cur.enrolledDealers++; continue; }
    map.set(p.schemeId, {
      id: p.schemeId,
      schemeName: p.scheme.schemeName,
      enrolledDealers: 1,
      startDate: p.scheme.startDate?.toISOString() ?? null,
      endDate: p.scheme.endDate?.toISOString() ?? null,
      isPerpetual: p.scheme.isPerpetual,
      status: p.scheme.status === SchemeStatus.OPEN ? "Running" : "Closed",
    });
  }
  return [...map.values()].sort((a, b) => a.schemeName.localeCompare(b.schemeName));
}

/* --------------------------- Detail --------------------------- */

export interface EnrolledDealerRow {
  planId: string; dealerId: string; dealerName: string; salesOfficerId: string; salesOfficerName: string; state: string | null;
  billingDate: string | null; schemeValueWithoutGST: number; schemeValueWithGST: number; status: string; installments: InstallmentRow[];
}
export interface EnrolledSchemeDetail {
  scheme: {
    id: string; schemeName: string; startDate: string | null; endDate: string | null; bookingLastDate: string | null; isPerpetual: boolean;
    bookingAmount: number | null; schemeValueWithoutGST: number; schemeValueWithGST: number; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    states: string[]; documentUrl: string | null; installments: { installmentNumber: number; calculationType: string; value: number; daysAfterBillingDate: number }[];
  };
  dealers: EnrolledDealerRow[];
  canEditPlanned: boolean; // SO/RM/Admin (scoped)
  canEditReceived: boolean; // Admin only
}

export async function enrolledSchemeDetail(ctx: AuthContext, schemeId: string): Promise<EnrolledSchemeDetail> {
  const scope = await getOfficerScope(ctx);
  const scheme = (await prisma.scheme.findUnique({
    where: { id: schemeId },
    include: { states: { include: { group: { select: { name: true } } } }, installmentRules: true },
  })) as unknown as {
    id: string; schemeName: string; startDate: Date | null; endDate: Date | null; bookingLastDate: Date | null; isPerpetual: boolean;
    bookingAmount: unknown; schemeValueWithoutGST: unknown; schemeValueWithGST: unknown; schemeBenefit: string; benefitDetails: string | null; otherBenefitDetails: string | null;
    documentUrl: string | null; states: { group: { name: string } }[]; installmentRules: RuleRow[];
  } | null;
  if (!scheme) throw new ApiError(404, "Scheme not found");

  const plans = (await prisma.dealerSchemePlan.findMany({
    where: { schemeId, enrollmentStatus: SchemeEnrollmentStatus.ENROLLED, ...(scope.all ? {} : { salesOfficerId: { in: scope.ids } }) },
    select: { id: true },
  })) as { id: string }[];
  for (const p of plans) await ensureInstallments(p.id);

  const full = (await prisma.dealerSchemePlan.findMany({
    where: { id: { in: plans.map((p) => p.id) } },
    include: {
      dealer: { select: { name: true } },
      salesOfficer: { select: { name: true, group: { select: { name: true } } } },
      installments: true,
    },
    orderBy: { createdAt: "asc" },
  })) as unknown as {
    id: string; dealerId: string; expectedBillingDate: Date | null; salesOfficerId: string;
    dealer: { name: string }; salesOfficer: { name: string; group: { name: string } | null };
    installments: RawInst[];
  }[];

  const now = new Date();
  const gstWithout = money(scheme.schemeValueWithoutGST);
  const gstWith = money(scheme.schemeValueWithGST);

  const dealers: EnrolledDealerRow[] = full.map((p) => {
    const insts = p.installments
      .slice()
      .sort((a, b) => a.installmentNumber - b.installmentNumber)
      .map<InstallmentRow>((i) => ({
        id: i.id,
        installmentNumber: i.installmentNumber,
        plannedAmount: money(i.plannedAmount),
        plannedDate: i.plannedDate?.toISOString() ?? null,
        receivedAmount: i.receivedAmount == null ? null : money(i.receivedAmount),
        receivedDate: i.receivedDate?.toISOString() ?? null,
        status: installmentStatus(i, now),
      }));
    return {
      planId: p.id,
      dealerId: p.dealerId,
      dealerName: p.dealer.name,
      salesOfficerId: p.salesOfficerId,
      salesOfficerName: p.salesOfficer.name,
      state: p.salesOfficer.group?.name ?? null,
      billingDate: p.expectedBillingDate?.toISOString() ?? null,
      schemeValueWithoutGST: gstWithout,
      schemeValueWithGST: gstWith,
      status: dealerStatus(insts),
      installments: insts,
    };
  });

  return {
    scheme: {
      id: scheme.id,
      schemeName: scheme.schemeName,
      startDate: scheme.startDate?.toISOString() ?? null,
      endDate: scheme.endDate?.toISOString() ?? null,
      bookingLastDate: scheme.bookingLastDate?.toISOString() ?? null,
      isPerpetual: scheme.isPerpetual,
      bookingAmount: scheme.bookingAmount == null ? null : money(scheme.bookingAmount),
      schemeValueWithoutGST: gstWithout,
      schemeValueWithGST: gstWith,
      schemeBenefit: scheme.schemeBenefit,
      benefitDetails: scheme.benefitDetails,
      otherBenefitDetails: scheme.otherBenefitDetails,
      states: scheme.states.map((x) => x.group.name),
      documentUrl: scheme.documentUrl,
      installments: scheme.installmentRules.slice().sort((a, b) => a.installmentNumber - b.installmentNumber).map((r) => ({ installmentNumber: r.installmentNumber, calculationType: r.calculationType, value: Number(r.value), daysAfterBillingDate: r.daysAfterBillingDate })),
    },
    dealers,
    canEditPlanned: ctx.role === Role.SALES_OFFICER || ctx.role === Role.REGIONAL_MANAGER || ctx.role === Role.SUPER_ADMIN,
    canEditReceived: ctx.role === Role.SUPER_ADMIN,
  };
}

/* --------------------------- Edits --------------------------- */

async function assertPlanInScope(ctx: AuthContext, planId: string): Promise<{ salesOfficerId: string; enrollmentStatus: string }> {
  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id: planId }, select: { salesOfficerId: true, enrollmentStatus: true } })) as { salesOfficerId: string; enrollmentStatus: string } | null;
  if (!plan) throw new ApiError(404, "Scheme plan not found");
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(plan.salesOfficerId)) throw new ApiError(403, "You cannot manage this scheme plan");
  return plan;
}

const billingSchema = z.object({ billingDate: z.coerce.date() });

/** Update a dealer's billing date. Recomputes planned dates for not-yet-received installments. */
export async function updateBillingDate(ctx: AuthContext, planId: string, raw: unknown): Promise<{ ok: true }> {
  if (![Role.SALES_OFFICER, Role.REGIONAL_MANAGER, Role.SUPER_ADMIN].includes(ctx.role)) throw new ApiError(403, "Not allowed");
  const plan = await assertPlanInScope(ctx, planId);
  if (plan.enrollmentStatus !== SchemeEnrollmentStatus.ENROLLED) throw new ApiError(409, "Only enrolled dealers can be managed here");
  const { billingDate } = billingSchema.parse(raw);

  await ensureInstallments(planId);
  await prisma.dealerSchemePlan.update({ where: { id: planId }, data: { expectedBillingDate: billingDate } });

  // Recompute planned dates for installments not yet received, using the scheme's day offsets.
  const rules = (await prisma.dealerSchemePlan.findUnique({ where: { id: planId }, select: { scheme: { select: { installmentRules: { select: { installmentNumber: true, daysAfterBillingDate: true } } } } } })) as
    { scheme: { installmentRules: { installmentNumber: number; daysAfterBillingDate: number }[] } } | null;
  const dayByNum = new Map((rules?.scheme.installmentRules ?? []).map((r) => [r.installmentNumber, r.daysAfterBillingDate]));
  const insts = (await prisma.dealerSchemeInstallment.findMany({ where: { dealerSchemePlanId: planId, receivedAmount: null }, select: { id: true, installmentNumber: true } })) as { id: string; installmentNumber: number }[];
  for (const i of insts) {
    const offset = dayByNum.get(i.installmentNumber);
    if (offset == null) continue;
    await prisma.dealerSchemeInstallment.update({ where: { id: i.id }, data: { plannedDate: addDays(billingDate, offset), updatedById: ctx.userId } });
  }
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemePlan", entityId: planId, summary: "Enrolled billing date updated" });
  return { ok: true };
}

const installmentPatchSchema = z.object({
  plannedAmount: z.coerce.number().min(0).optional(),
  plannedDate: z.coerce.date().nullable().optional(),
  receivedAmount: z.coerce.number().min(0).nullable().optional(),
  receivedDate: z.coerce.date().nullable().optional(),
});

/**
 * Update one installment. SO/RM (scoped) may edit planned amount/date only. Super Admin may also edit the
 * received amount/date (payment truth). Received-amount presence drives the stored status.
 */
export async function updateInstallment(ctx: AuthContext, installmentId: string, raw: unknown): Promise<{ ok: true }> {
  const inst = (await prisma.dealerSchemeInstallment.findUnique({ where: { id: installmentId }, select: { id: true, dealerSchemePlanId: true, receivedAmount: true, receivedDate: true } })) as
    { id: string; dealerSchemePlanId: string; receivedAmount: unknown; receivedDate: Date | null } | null;
  if (!inst) throw new ApiError(404, "Installment not found");
  await assertPlanInScope(ctx, inst.dealerSchemePlanId);
  const patch = installmentPatchSchema.parse(raw);
  const isAdmin = ctx.role === Role.SUPER_ADMIN;

  // Guard: only the Super Admin may touch received fields.
  if (!isAdmin && (patch.receivedAmount !== undefined || patch.receivedDate !== undefined)) {
    throw new ApiError(403, "Only the Super Admin can record received payments");
  }
  if (![Role.SALES_OFFICER, Role.REGIONAL_MANAGER, Role.SUPER_ADMIN].includes(ctx.role)) throw new ApiError(403, "Not allowed");

  const data: Record<string, unknown> = { updatedById: ctx.userId };
  if (patch.plannedAmount !== undefined) data.plannedAmount = patch.plannedAmount;
  if (patch.plannedDate !== undefined) data.plannedDate = patch.plannedDate;
  if (isAdmin && patch.receivedAmount !== undefined) data.receivedAmount = patch.receivedAmount;
  if (isAdmin && patch.receivedDate !== undefined) data.receivedDate = patch.receivedDate;

  // Keep stored status consistent with received amount (final vs pending). Overdue is derived on read.
  if (isAdmin && patch.receivedAmount !== undefined) {
    data.status = patch.receivedAmount != null ? "RECEIVED" : "PENDING";
    if (patch.receivedAmount != null && patch.receivedDate === undefined && !inst.receivedDate) data.receivedDate = new Date();
    if (patch.receivedAmount == null) data.receivedDate = null;
  }

  await prisma.dealerSchemeInstallment.update({ where: { id: installmentId }, data });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealerSchemeInstallment", entityId: installmentId, summary: "Enrolled installment updated" });
  return { ok: true };
}
