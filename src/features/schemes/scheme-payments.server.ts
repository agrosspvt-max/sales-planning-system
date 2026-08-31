import "server-only";
import { Role, SchemeEnrollmentStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { ensureAllInstallments } from "./scheme-enrolled.server";

/**
 * Payment Management — actual money received on enrolled scheme plans.
 *
 * A payment (SchemePayment) is the SOURCE OF TRUTH for money received; its amount is allocated
 * SEQUENTIALLY from the earliest outstanding installment into SchemePaymentAllocation rows, all inside one
 * transaction. The installment's own receivedAmount/receivedDate are maintained as a denormalised rollup so
 * the Enrolled Scheme view and Follow-up recovery figures keep reading them unchanged. Payments are never
 * overwritten, so the transaction-level history stays permanently traceable.
 *
 * A "dealer" on the Payments page is one enrolled DealerSchemePlan (dealer + scheme), matching where
 * payments and installments live; the UI labels it by dealer and shows the scheme.
 */

const money = (n: unknown): number => (n == null ? 0 : Number(n.toString()));
const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.005;

/* --------------------------- Pure allocation (shared by preview + persist) --------------------------- */

export interface AllocInstallment { id: string; instanceNumber: number; installmentNumber: number; plannedAmount: number; receivedAmount: number }
export interface AllocLine {
  installmentId: string; instanceNumber: number; installmentNumber: number;
  plannedAmount: number; priorReceived: number; allocated: number; newReceived: number; settled: boolean;
}
export interface AllocResult { lines: AllocLine[]; leftover: number; totalOutstanding: number }

/**
 * PURE — allocate `amount` across installments (already ordered earliest-first) from the first with an
 * outstanding balance. No DB access; the persist path and the modal preview both use it so they agree.
 */
export function allocatePayment(installments: AllocInstallment[], amount: number): AllocResult {
  const ordered = installments.slice().sort((a, b) => a.instanceNumber - b.instanceNumber || a.installmentNumber - b.installmentNumber);
  const totalOutstanding = round2(ordered.reduce((s, i) => s + Math.max(0, round2(i.plannedAmount - i.receivedAmount)), 0));
  let left = round2(amount);
  const lines: AllocLine[] = [];
  for (const i of ordered) {
    if (left <= EPS) break;
    const remaining = round2(i.plannedAmount - i.receivedAmount);
    if (remaining <= EPS) continue;
    const allocated = round2(Math.min(left, remaining));
    const newReceived = round2(i.receivedAmount + allocated);
    lines.push({
      installmentId: i.id, instanceNumber: i.instanceNumber, installmentNumber: i.installmentNumber,
      plannedAmount: i.plannedAmount, priorReceived: i.receivedAmount, allocated, newReceived, settled: newReceived + EPS >= i.plannedAmount,
    });
    left = round2(left - allocated);
  }
  return { lines, leftover: round2(left), totalOutstanding };
}

/* --------------------------- Add payment (Super Admin, atomic) --------------------------- */

const addSchema = z.object({
  amount: z.coerce.number().positive("Enter a payment amount greater than zero"),
  receivedDate: z.coerce.date(),
  note: z.string().max(500).optional(),
});

async function assertPlanInScope(ctx: AuthContext, salesOfficerId: string): Promise<void> {
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(salesOfficerId)) throw new ApiError(403, "You cannot manage this dealer's payments");
}

/**
 * Record a payment against an enrolled plan and allocate it sequentially. Super Admin only. Atomic: the
 * payment, its allocations and the installment rollups all commit together or not at all. Overpayment beyond
 * the outstanding balance is rejected (no advance/credit concept). A short-window guard rejects an identical
 * immediate re-submit (double-click), complementing the button-disable on the client.
 */
export async function addSchemePayment(ctx: AuthContext, planId: string, raw: unknown): Promise<{ paymentId: string; allocations: AllocLine[] }> {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can record payments");
  const { amount, receivedDate, note } = addSchema.parse(raw);

  const plan = (await prisma.dealerSchemePlan.findUnique({ where: { id: planId }, select: { id: true, salesOfficerId: true, enrollmentStatus: true } })) as
    { id: string; salesOfficerId: string; enrollmentStatus: string } | null;
  if (!plan) throw new ApiError(404, "Enrolled dealer plan not found");
  await assertPlanInScope(ctx, plan.salesOfficerId);
  if (plan.enrollmentStatus !== SchemeEnrollmentStatus.ENROLLED) throw new ApiError(409, "Only enrolled dealers can receive payments");

  // Make sure concrete installment rows exist before we allocate (idempotent; runs outside the tx).
  await ensureAllInstallments(planId);

  return prisma.$transaction(async (tx) => {
    // Double-submit guard: an identical payment recorded in the last 15s is treated as a duplicate.
    const recent = (await tx.schemePayment.findFirst({
      where: { planId, amount, receivedDate, createdById: ctx.userId, recordedAt: { gte: new Date(Date.now() - 15_000) } },
      select: { id: true },
    })) as { id: string } | null;
    if (recent) throw new ApiError(409, "This payment was just recorded — refresh to see it.");

    const rows = (await tx.dealerSchemeInstallment.findMany({
      where: { instance: { dealerSchemePlanId: planId } },
      select: { id: true, installmentNumber: true, plannedAmount: true, receivedAmount: true, instance: { select: { instanceNumber: true } } },
    })) as { id: string; installmentNumber: number; plannedAmount: unknown; receivedAmount: unknown; instance: { instanceNumber: number } }[];
    if (rows.length === 0) throw new ApiError(409, "This dealer has no installment schedule to allocate against");

    const installments: AllocInstallment[] = rows.map((r) => ({
      id: r.id, instanceNumber: r.instance.instanceNumber, installmentNumber: r.installmentNumber,
      plannedAmount: money(r.plannedAmount), receivedAmount: money(r.receivedAmount),
    }));

    const result = allocatePayment(installments, amount);
    if (result.leftover > EPS) {
      throw new ApiError(422, `Payment exceeds the outstanding balance (₹${result.totalOutstanding.toLocaleString("en-IN")}). No advance/credit payment is supported — enter ₹${result.totalOutstanding.toLocaleString("en-IN")} or less.`);
    }

    const payment = (await tx.schemePayment.create({
      data: { planId, amount, receivedDate, note: note?.trim() || null, createdById: ctx.userId },
      select: { id: true },
    })) as { id: string };

    for (const line of result.lines) {
      await tx.schemePaymentAllocation.create({ data: { paymentId: payment.id, installmentId: line.installmentId, amount: line.allocated } });
      await tx.dealerSchemeInstallment.update({
        where: { id: line.installmentId },
        data: { receivedAmount: line.newReceived, receivedDate, status: line.settled ? "RECEIVED" : "PARTIAL", updatedById: ctx.userId },
      });
    }

    await writeAudit(
      { userId: ctx.userId, action: "CREATE", entity: "schemePayment", entityId: payment.id, summary: `Payment ₹${round2(amount)} recorded (${result.lines.length} installment${result.lines.length === 1 ? "" : "s"} allocated)` },
      tx,
    );
    return { paymentId: payment.id, allocations: result.lines };
  });
}

/* --------------------------- Payments page reads (scoped) --------------------------- */

export interface PaymentDealerRow {
  planId: string; dealerId: string; dealerName: string; schemeId: string; schemeName: string;
  salesOfficerId: string; salesOfficerName: string; state: string | null;
  paymentCount: number; totalPaid: number; lastReceivedDate: string | null; lastRecordedAt: string | null;
}
export interface PaymentFilterOptions { states: string[]; officers: { id: string; name: string }[] }
export interface PaymentDealerList { rows: PaymentDealerRow[]; filters: PaymentFilterOptions }

const rangeSchema = z.object({
  state: z.string().trim().optional(),
  officerId: z.string().trim().optional(),
  receivedFrom: z.coerce.date().optional(),
  receivedTo: z.coerce.date().optional(),
  recordedFrom: z.coerce.date().optional(),
  recordedTo: z.coerce.date().optional(),
});
export type PaymentFilters = z.infer<typeof rangeSchema>;
export function parsePaymentFilters(params: URLSearchParams): PaymentFilters {
  const get = (k: string) => { const v = (params.get(k) ?? "").trim(); return v || undefined; };
  return rangeSchema.parse({
    state: get("state"), officerId: get("officerId"),
    receivedFrom: get("receivedFrom"), receivedTo: get("receivedTo"), recordedFrom: get("recordedFrom"), recordedTo: get("recordedTo"),
  });
}

/** Inclusive end-of-day so a date-only "to" filter includes that whole day. */
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

function paymentWhere(f: PaymentFilters) {
  const received = f.receivedFrom || f.receivedTo ? { receivedDate: { ...(f.receivedFrom ? { gte: f.receivedFrom } : {}), ...(f.receivedTo ? { lte: endOfDay(f.receivedTo) } : {}) } } : {};
  const recorded = f.recordedFrom || f.recordedTo ? { recordedAt: { ...(f.recordedFrom ? { gte: f.recordedFrom } : {}), ...(f.recordedTo ? { lte: endOfDay(f.recordedTo) } : {}) } } : {};
  return { ...received, ...recorded };
}

/**
 * Enrolled dealer-plans in scope, with a payment summary, ordered by MOST RECENTLY RECORDED payment first
 * (so the page can default-select the top row). State/officer filters narrow the plans; the date filters
 * (received / recorded) narrow which payments count toward the summary and restrict the list to plans that
 * have a matching payment. Filter options are derived from the scoped plans — no duplicate SO/state store.
 */
export async function paymentDealers(ctx: AuthContext, f: PaymentFilters): Promise<PaymentDealerList> {
  const scope = await getOfficerScope(ctx);
  const hasDateFilter = !!(f.receivedFrom || f.receivedTo || f.recordedFrom || f.recordedTo);

  const plans = (await prisma.dealerSchemePlan.findMany({
    where: {
      enrollmentStatus: SchemeEnrollmentStatus.ENROLLED,
      ...(scope.all ? {} : { salesOfficerId: { in: scope.ids } }),
      ...(f.officerId ? { salesOfficerId: f.officerId } : {}),
      ...(f.state ? { salesOfficer: { group: { name: f.state } } } : {}),
    },
    select: {
      id: true, dealerId: true, schemeId: true, salesOfficerId: true,
      dealer: { select: { name: true } },
      scheme: { select: { schemeName: true } },
      salesOfficer: { select: { name: true, group: { select: { name: true } } } },
      payments: { where: paymentWhere(f), select: { amount: true, receivedDate: true, recordedAt: true }, orderBy: { recordedAt: "desc" } },
    },
    orderBy: { createdAt: "desc" },
  })) as unknown as {
    id: string; dealerId: string; schemeId: string; salesOfficerId: string;
    dealer: { name: string }; scheme: { schemeName: string }; salesOfficer: { name: string; group: { name: string } | null };
    payments: { amount: unknown; receivedDate: Date; recordedAt: Date }[];
  }[];

  const statesSet = new Set<string>();
  const officersMap = new Map<string, string>();
  const rows: PaymentDealerRow[] = [];
  for (const p of plans) {
    if (p.salesOfficer.group?.name) statesSet.add(p.salesOfficer.group.name);
    officersMap.set(p.salesOfficerId, p.salesOfficer.name);
    // With a date filter active, only surface plans that actually have a matching payment.
    if (hasDateFilter && p.payments.length === 0) continue;
    rows.push({
      planId: p.id, dealerId: p.dealerId, dealerName: p.dealer.name, schemeId: p.schemeId, schemeName: p.scheme.schemeName,
      salesOfficerId: p.salesOfficerId, salesOfficerName: p.salesOfficer.name, state: p.salesOfficer.group?.name ?? null,
      paymentCount: p.payments.length,
      totalPaid: round2(p.payments.reduce((s, x) => s + money(x.amount), 0)),
      lastReceivedDate: p.payments[0]?.receivedDate?.toISOString() ?? null,
      lastRecordedAt: p.payments[0]?.recordedAt?.toISOString() ?? null,
    });
  }
  // Most-recently-recorded payment first (plans with no payments sink to the bottom, name-ordered).
  rows.sort((a, b) => {
    if (a.lastRecordedAt && b.lastRecordedAt) return b.lastRecordedAt.localeCompare(a.lastRecordedAt);
    if (a.lastRecordedAt) return -1;
    if (b.lastRecordedAt) return 1;
    return a.dealerName.localeCompare(b.dealerName);
  });

  const officers = [...officersMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { rows, filters: { states: [...statesSet].sort(), officers } };
}

export interface TimelineInstallment { installmentId: string; instanceNumber: number; installmentNumber: number; plannedAmount: number; receivedAmount: number; status: string; receivedPct: number }
export interface TimelineAllocation { instanceNumber: number; installmentNumber: number; allocated: number; cumulative: number; plannedAmount: number; resultingStatus: string; receivedPct: number }
export interface TimelinePayment { id: string; amount: number; receivedDate: string; recordedAt: string; createdByName: string | null; note: string | null; allocations: TimelineAllocation[] }
export interface DealerPaymentTimeline {
  plan: { planId: string; dealerId: string; dealerName: string; schemeId: string; schemeName: string; salesOfficerName: string; state: string | null };
  installments: TimelineInstallment[];
  payments: TimelinePayment[];
  totals: { planned: number; received: number; outstanding: number };
}

const pct = (received: number, planned: number) => (planned > 0 ? round2((received / planned) * 100) : 0);
const statusOf = (received: number, planned: number) => (received <= EPS ? "PENDING" : received + EPS >= planned ? "RECEIVED" : "PARTIAL");

/**
 * One enrolled plan's complete, audit-friendly payment timeline: its installments (current rollup) and every
 * payment (filtered by the received/recorded ranges) with the per-installment allocation of that payment and
 * the CUMULATIVE received on that installment as at that payment — reconstructed deterministically from the
 * stored allocations by walking payments in recorded order.
 */
export async function dealerPaymentTimeline(ctx: AuthContext, planId: string, f: PaymentFilters): Promise<DealerPaymentTimeline> {
  const scope = await getOfficerScope(ctx);
  const plan = (await prisma.dealerSchemePlan.findUnique({
    where: { id: planId },
    select: {
      id: true, dealerId: true, schemeId: true, salesOfficerId: true,
      dealer: { select: { name: true } }, scheme: { select: { schemeName: true } }, salesOfficer: { select: { name: true, group: { select: { name: true } } } },
      instances: { select: { instanceNumber: true, installments: { select: { id: true, installmentNumber: true, plannedAmount: true, receivedAmount: true } } } },
    },
  })) as unknown as {
    id: string; dealerId: string; schemeId: string; salesOfficerId: string;
    dealer: { name: string }; scheme: { schemeName: string }; salesOfficer: { name: string; group: { name: string } | null };
    instances: { instanceNumber: number; installments: { id: string; installmentNumber: number; plannedAmount: unknown; receivedAmount: unknown }[] }[];
  } | null;
  if (!plan) throw new ApiError(404, "Dealer plan not found");
  if (!scope.all && !scope.ids.includes(plan.salesOfficerId)) throw new ApiError(403, "You cannot view this dealer's payments");

  // Flat installment index (by id) with its ordering key, for allocation lookups.
  const instById = new Map<string, { instanceNumber: number; installmentNumber: number; plannedAmount: number }>();
  const installments: TimelineInstallment[] = [];
  for (const inst of plan.instances) {
    for (const i of inst.installments.slice().sort((a, b) => a.installmentNumber - b.installmentNumber)) {
      const planned = money(i.plannedAmount);
      const received = money(i.receivedAmount);
      instById.set(i.id, { instanceNumber: inst.instanceNumber, installmentNumber: i.installmentNumber, plannedAmount: planned });
      installments.push({ installmentId: i.id, instanceNumber: inst.instanceNumber, installmentNumber: i.installmentNumber, plannedAmount: planned, receivedAmount: received, status: statusOf(received, planned), receivedPct: pct(received, planned) });
    }
  }
  installments.sort((a, b) => a.instanceNumber - b.instanceNumber || a.installmentNumber - b.installmentNumber);

  // ALL payments in recorded order → reconstruct cumulative; then apply the display filters.
  const allPayments = (await prisma.schemePayment.findMany({
    where: { planId },
    select: { id: true, amount: true, receivedDate: true, recordedAt: true, note: true, createdBy: { select: { name: true } }, allocations: { select: { installmentId: true, amount: true } } },
    orderBy: { recordedAt: "asc" },
  })) as unknown as {
    id: string; amount: unknown; receivedDate: Date; recordedAt: Date; note: string | null; createdBy: { name: string } | null;
    allocations: { installmentId: string; amount: unknown }[];
  }[];

  const cumulativeByInst = new Map<string, number>();
  const built: (TimelinePayment & { _received: Date; _recorded: Date })[] = [];
  for (const pay of allPayments) {
    const allocations: TimelineAllocation[] = pay.allocations.map((a) => {
      const meta = instById.get(a.installmentId);
      const planned = meta?.plannedAmount ?? 0;
      const cumulative = round2((cumulativeByInst.get(a.installmentId) ?? 0) + money(a.amount));
      cumulativeByInst.set(a.installmentId, cumulative);
      return {
        instanceNumber: meta?.instanceNumber ?? 0, installmentNumber: meta?.installmentNumber ?? 0,
        allocated: money(a.amount), cumulative, plannedAmount: planned, resultingStatus: statusOf(cumulative, planned), receivedPct: pct(cumulative, planned),
      };
    }).sort((x, y) => x.instanceNumber - y.instanceNumber || x.installmentNumber - y.installmentNumber);
    built.push({
      id: pay.id, amount: money(pay.amount), receivedDate: pay.receivedDate.toISOString(), recordedAt: pay.recordedAt.toISOString(),
      createdByName: pay.createdBy?.name ?? null, note: pay.note, allocations, _received: pay.receivedDate, _recorded: pay.recordedAt,
    });
  }

  const inReceived = (d: Date) => (!f.receivedFrom || d >= f.receivedFrom) && (!f.receivedTo || d <= endOfDay(f.receivedTo));
  const inRecorded = (d: Date) => (!f.recordedFrom || d >= f.recordedFrom) && (!f.recordedTo || d <= endOfDay(f.recordedTo));
  const payments = built
    .filter((p) => inReceived(p._received) && inRecorded(p._recorded))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)) // newest first for display
    .map(({ _received: _r, _recorded: _rd, ...rest }) => { void _r; void _rd; return rest; });

  const planned = round2(installments.reduce((s, i) => s + i.plannedAmount, 0));
  const received = round2(installments.reduce((s, i) => s + i.receivedAmount, 0));
  return {
    plan: { planId: plan.id, dealerId: plan.dealerId, dealerName: plan.dealer.name, schemeId: plan.schemeId, schemeName: plan.scheme.schemeName, salesOfficerName: plan.salesOfficer.name, state: plan.salesOfficer.group?.name ?? null },
    installments,
    payments,
    totals: { planned, received, outstanding: round2(planned - received) },
  };
}
