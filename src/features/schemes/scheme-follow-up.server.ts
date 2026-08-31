import "server-only";
import { SchemeEnrollmentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope, assertOfficerInScope } from "@/lib/scope";
import { BUSINESS_WEEK_COUNT, businessWeekDayRange } from "@/features/recovery/service.server";
import { derivedInstallmentSchedule, resolveInstanceBillingDate, type InstallmentRuleRow } from "./scheme-enrolled.server";

/**
 * FOLLOW-UP PLANS — the recovery layer over enrolled schemes (Scheme Follow-up + Dealer Follow-up).
 *
 * STRICTLY READ-ONLY. This module never writes: it does not call `ensureInstances`,
 * `ensureInstanceInstallments` or any create/update/delete. Opening, filtering, expanding, downloading or
 * sharing a follow-up report can therefore never create instances or installment rows, touch billing
 * dates, or change conversion/approval/enrollment state. Where an instance has no persisted installment
 * rows yet, the schedule is DERIVED IN MEMORY from the scheme's installment rules with
 * `derivedInstallmentSchedule` — the very function `ensureInstanceInstallments` persists — so the numbers
 * shown here and the rows the Enrolled Scheme view later generates cannot disagree.
 *
 * BUSINESS RULES (all decided by rahmani for Requirement 3; nothing here is inferred):
 *  1. Row scope — ENROLLED plans only (`enrollmentStatus = ENROLLED`), inside the caller's officer scope.
 *  2. Month/Week is a FINANCIAL SNAPSHOT (a cutoff), not an "activity in this period" filter. A dealer
 *     with an unpaid March installment still appears when August is selected.
 *  3. Total Due  = Σ plannedAmount where plannedDate ≤ period end AND ≤ today ("due till date").
 *  4. Total Paid = Σ receivedAmount where receivedDate ≤ period end, PLUS the Admin-confirmed booking
 *     amount, which is treated as DATELESS (counted in every cumulative snapshot, never in the
 *     Month/Week Actual columns). Received amounts recorded without a date are treated the same way.
 *  5. Only the Admin-confirmed booking amount (`adminBookingAmount`) counts as money received; the
 *     SO-entered `soBookingAmount` never contributes. Booking does NOT increase Total Due, because the
 *     installment schedule already represents the full scheme value.
 *  6. Pending = max(Total Due − Total Paid, 0). Pending % = Pending ÷ Total Due (null when Due = 0).
 *  7. Month Due/Actual = the selected calendar month's own range; Week Due/Actual = the selected business
 *     week's range. Both are null (rendered as an em dash) when All months / All weeks is selected.
 *  8. Scheme Amount is INSTANCE-BASED: Σ schemeValueWithGST × (instances that exist). Legacy plans keep
 *     only Instance 1 even when `numberOfSchemes` > 1, so a unit-based amount would exceed every rupee any
 *     schedule can ever account for. Identical to unit-based on fully expanded new-flow plans.
 *  9. Every ENROLLED dealer in scope is listed (including fully settled ones), sorted pending-first.
 * 10. Weeks reuse the app's ONE business-week definition (`businessWeekDayRange`): W1 1–7, W2 8–14,
 *     W3 15–22, W4 23–end of month. There is never a Week 5.
 *
 * Role scope is enforced SERVER-SIDE by `getOfficerScope` (Admin = all, SO = own plans, RM = own + the
 * SOs in the RM's group); the browser never filters for security.
 */

/* --------------------------------- Query / period --------------------------------- */

export type FollowUpMonth = "all" | string; // "all" | "YYYY-MM"
export type FollowUpWeek = "all" | 1 | 2 | 3 | 4;

export interface FollowUpQuery {
  month: FollowUpMonth;
  week: FollowUpWeek;
  /** RM "Team Schemes → one Sales Officer" narrowing. Server-validated against the caller's scope. */
  officerId?: string;
}

export interface FollowUpPeriod {
  month: FollowUpMonth;
  week: FollowUpWeek;
  monthLabel: string;
  weekLabel: string | null;
  weekFrom: string | null;
  weekTo: string | null;
  /** Period end that drives the cumulative snapshot. */
  snapshotDate: string;
  /** Effective due cutoff — min(period end, today). */
  dueCutoff: string;
}

export interface FollowUpMonthOption {
  value: string; // YYYY-MM
  label: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Parse + validate the month/week query. Anything malformed is a 422, never a silent default. */
export function parseFollowUpQuery(params: URLSearchParams): FollowUpQuery {
  const rawMonth = (params.get("month") ?? "all").trim();
  if (rawMonth !== "all" && !MONTH_RE.test(rawMonth)) throw new ApiError(422, "Invalid month — expected YYYY-MM or 'all'");
  const rawWeek = (params.get("week") ?? "all").trim();
  let week: FollowUpWeek = "all";
  if (rawWeek !== "all") {
    const n = Number(rawWeek);
    if (!Number.isInteger(n) || n < 1 || n > BUSINESS_WEEK_COUNT) throw new ApiError(422, `Invalid week — expected 1–${BUSINESS_WEEK_COUNT} or 'all'`);
    week = n as FollowUpWeek;
  }
  // A week only means something inside a month; All months implies All weeks.
  const officerId = (params.get("officerId") ?? "").trim() || undefined;
  return { month: rawMonth === "all" ? "all" : rawMonth, week: rawMonth === "all" ? "all" : week, officerId };
}

const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabelOf = (key: string) =>
  new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

interface Range {
  from: Date;
  to: Date;
}

interface Windows {
  period: FollowUpPeriod;
  dueCutoff: Date; // cumulative Total Due: plannedDate ≤ this (= min(period end, today))
  paidCutoff: Date; // cumulative Total Paid: receivedDate ≤ this (= period end)
  month: Range | null; // Month Due / Month Actual window
  week: Range | null; // Week Due / Week Actual window
}

/** Resolve the selected month/week into the four windows every figure is computed from. */
function resolveWindows(q: FollowUpQuery, now: Date): Windows {
  const today = endOfDay(now);
  if (q.month === "all") {
    return {
      period: {
        month: "all", week: "all", monthLabel: "All months", weekLabel: null, weekFrom: null, weekTo: null,
        snapshotDate: today.toISOString(), dueCutoff: today.toISOString(),
      },
      dueCutoff: today, paidCutoff: today, month: null, week: null,
    };
  }
  const year = Number(q.month.slice(0, 4));
  const month0 = Number(q.month.slice(5, 7)) - 1;
  const monthRange: Range = { from: new Date(year, month0, 1, 0, 0, 0, 0), to: new Date(year, month0 + 1, 0, 23, 59, 59, 999) };

  let weekRange: Range | null = null;
  if (q.week !== "all") {
    const { startDay, endDay } = businessWeekDayRange(q.week, year, month0);
    weekRange = { from: new Date(year, month0, startDay, 0, 0, 0, 0), to: new Date(year, month0, endDay, 23, 59, 59, 999) };
  }
  const periodEnd = weekRange ? weekRange.to : monthRange.to;
  const dueCutoff = periodEnd.getTime() < today.getTime() ? periodEnd : today;
  return {
    period: {
      month: q.month,
      week: q.week,
      monthLabel: monthLabelOf(q.month),
      weekLabel: q.week === "all" ? null : `Week ${q.week}`,
      weekFrom: weekRange?.from.toISOString() ?? null,
      weekTo: weekRange?.to.toISOString() ?? null,
      snapshotDate: periodEnd.toISOString(),
      dueCutoff: dueCutoff.toISOString(),
    },
    dueCutoff,
    paidCutoff: periodEnd,
    month: monthRange,
    week: weekRange,
  };
}

/* --------------------------------- Loading --------------------------------- */

const money = (n: unknown): number => (n == null ? 0 : Number(n.toString()));
const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const inRange = (d: Date | null, r: Range | null): boolean => !!d && !!r && d.getTime() >= r.from.getTime() && d.getTime() <= r.to.getTime();

/** One installment, whether persisted or derived in memory for display. */
interface ScheduleRow {
  instanceId: string;
  instanceNumber: number;
  installmentNumber: number;
  plannedAmount: number;
  plannedDate: Date | null;
  receivedAmount: number | null;
  receivedDate: Date | null;
  derived: boolean; // true = not persisted; shown read-only, never written
}

interface PlanModel {
  planId: string;
  dealerId: string;
  dealerName: string;
  town: string | null;
  village: string | null;
  tehsil: string | null;
  district: string | null;
  mobile: string | null;
  salesOfficerName: string;
  state: string | null;
  schemeId: string;
  schemeName: string;
  schemeValueWithGST: number;
  instanceCount: number;
  numberOfSchemes: number;
  bookingAmount: number; // Admin-confirmed only
  rows: ScheduleRow[];
  derivedSchedule: boolean; // any instance shown from a derived (not persisted) schedule
}

/**
 * Load every ENROLLED plan in the caller's scope with its dealer, scheme rules and instance schedules.
 * ONE query per relation level (Prisma nested include) — never a query per dealer/plan/instance.
 */
async function loadPlans(ctx: AuthContext, opts: { dealerId?: string; schemeId?: string; officerId?: string } = {}): Promise<PlanModel[]> {
  const scope = await getOfficerScope(ctx);
  // RM narrowing to a single Sales Officer: validate membership server-side, then filter to that officer.
  // This is stricter than (a subset of) the scope, so it never widens access.
  if (opts.officerId) await assertOfficerInScope(ctx, opts.officerId);
  const officerFilter = opts.officerId ? { salesOfficerId: opts.officerId } : scope.all ? {} : { salesOfficerId: { in: scope.ids } };
  const plans = (await prisma.dealerSchemePlan.findMany({
    where: {
      enrollmentStatus: SchemeEnrollmentStatus.ENROLLED,
      ...(opts.dealerId ? { dealerId: opts.dealerId } : {}),
      ...(opts.schemeId ? { schemeId: opts.schemeId } : {}),
      ...officerFilter,
    },
    select: {
      id: true, dealerId: true, schemeId: true, numberOfSchemes: true,
      adminBookingAmount: true, adminVerifiedAt: true, adminBillingDate: true, billingDate: true, expectedBillingDate: true,
      dealer: { select: { name: true, town: true, village: true, tehsil: true, district: true, mobile: true } },
      salesOfficer: { select: { name: true, group: { select: { name: true } } } },
      scheme: { select: { schemeName: true, schemeValueWithGST: true, installmentRules: { select: { installmentNumber: true, calculationType: true, value: true, daysAfterBillingDate: true } } } },
      instances: {
        select: { id: true, instanceNumber: true, adminBillingDate: true, installments: { select: { installmentNumber: true, plannedAmount: true, plannedDate: true, receivedAmount: true, receivedDate: true } } },
        orderBy: { instanceNumber: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  })) as unknown as {
    id: string; dealerId: string; schemeId: string; numberOfSchemes: number;
    adminBookingAmount: unknown; adminVerifiedAt: Date | null; adminBillingDate: Date | null; billingDate: Date | null; expectedBillingDate: Date | null;
    dealer: { name: string; town: string | null; village: string | null; tehsil: string | null; district: string | null; mobile: string | null };
    salesOfficer: { name: string; group: { name: string } | null };
    scheme: { schemeName: string; schemeValueWithGST: unknown; installmentRules: InstallmentRuleRow[] };
    instances: { id: string; instanceNumber: number; adminBillingDate: Date | null; installments: { installmentNumber: number; plannedAmount: unknown; plannedDate: Date | null; receivedAmount: unknown; receivedDate: Date | null }[] }[];
  }[];

  return plans.map((p) => {
    const gst = money(p.scheme.schemeValueWithGST);
    const rows: ScheduleRow[] = [];
    let derivedSchedule = false;
    for (const inst of p.instances) {
      if (inst.installments.length > 0) {
        for (const i of inst.installments) {
          rows.push({
            instanceId: inst.id, instanceNumber: inst.instanceNumber, installmentNumber: i.installmentNumber,
            plannedAmount: money(i.plannedAmount), plannedDate: i.plannedDate,
            receivedAmount: i.receivedAmount == null ? null : money(i.receivedAmount), receivedDate: i.receivedDate,
            derived: false,
          });
        }
        continue;
      }
      // No rows persisted yet — DERIVE the schedule for display only (never written).
      const billing = resolveInstanceBillingDate(p, inst);
      const derived = derivedInstallmentSchedule(p.scheme.installmentRules, gst, billing);
      if (derived.length > 0) derivedSchedule = true;
      for (const d of derived) {
        rows.push({
          instanceId: inst.id, instanceNumber: inst.instanceNumber, installmentNumber: d.installmentNumber,
          plannedAmount: d.plannedAmount, plannedDate: d.plannedDate, receivedAmount: null, receivedDate: null, derived: true,
        });
      }
    }
    rows.sort((a, b) => a.instanceNumber - b.instanceNumber || a.installmentNumber - b.installmentNumber);
    return {
      planId: p.id, dealerId: p.dealerId,
      dealerName: p.dealer.name, town: p.dealer.town, village: p.dealer.village, tehsil: p.dealer.tehsil, district: p.dealer.district, mobile: p.dealer.mobile,
      salesOfficerName: p.salesOfficer.name, state: p.salesOfficer.group?.name ?? null,
      schemeId: p.schemeId, schemeName: p.scheme.schemeName, schemeValueWithGST: gst,
      instanceCount: p.instances.length, numberOfSchemes: p.numberOfSchemes || 1,
      bookingAmount: money(p.adminBookingAmount), // Admin-confirmed only; SO-entered amounts never count
      rows, derivedSchedule,
    };
  });
}

/* --------------------------------- Aggregation --------------------------------- */

export interface FollowUpFigures {
  schemeAmount: number;
  bookingAmount: number;
  totalDue: number;
  installmentsPaid: number;
  totalPaid: number;
  pending: number;
  pendingPct: number | null; // null = zero denominator (nothing due yet) → em dash
  monthDue: number | null; // null = All months
  monthActual: number | null;
  weekDue: number | null; // null = All weeks
  weekActual: number | null;
  installmentsTotal: number;
  installmentsReceived: number;
  overdueCount: number;
  nextDueDate: string | null;
  lastPaymentDate: string | null;
  status: string;
}

/** Snapshot status, using the same vocabulary as the Enrolled Scheme view (evaluated at the cutoff). */
function positionStatus(total: number, received: number, overdue: number): string {
  if (total === 0) return "Enrolled";
  if (received === total) return "Completed";
  if (overdue > 0) return "Overdue";
  if (received > 0) return "Installment Received";
  return "Installment Pending";
}

/** Every figure for a set of schedule rows + their Admin-confirmed booking money, at the selected period. */
function aggregate(rows: ScheduleRow[], schemeAmount: number, bookingAmount: number, w: Windows): FollowUpFigures {
  let totalDue = 0, installmentsPaid = 0, monthDue = 0, monthActual = 0, weekDue = 0, weekActual = 0;
  let received = 0, overdue = 0;
  let nextDue: Date | null = null;
  let lastPaid: Date | null = null;

  for (const r of rows) {
    const paid = r.receivedAmount != null;
    // Cumulative due — planned on/before the period end AND on/before today ("due till date").
    if (r.plannedDate && r.plannedDate.getTime() <= w.dueCutoff.getTime()) {
      totalDue += r.plannedAmount;
      if (!paid) overdue++;
    }
    // Cumulative paid — received on/before the period end. A received amount with no date is treated as
    // dateless money (same rule as booking): it counts cumulatively, never in the period Actual columns.
    if (paid && (r.receivedDate == null || r.receivedDate.getTime() <= w.paidCutoff.getTime())) {
      installmentsPaid += r.receivedAmount as number;
    }
    if (paid) {
      received++;
      if (r.receivedDate && (!lastPaid || r.receivedDate.getTime() > lastPaid.getTime())) lastPaid = r.receivedDate;
    } else if (r.plannedDate && (!nextDue || r.plannedDate.getTime() < nextDue.getTime())) {
      nextDue = r.plannedDate;
    }
    // Period columns — the selected month's / week's own range.
    if (inRange(r.plannedDate, w.month)) monthDue += r.plannedAmount;
    if (paid && inRange(r.receivedDate, w.month)) monthActual += r.receivedAmount as number;
    if (inRange(r.plannedDate, w.week)) weekDue += r.plannedAmount;
    if (paid && inRange(r.receivedDate, w.week)) weekActual += r.receivedAmount as number;
  }

  const due = round2(totalDue);
  const paidTotal = round2(installmentsPaid + bookingAmount); // booking is dateless and always counted
  const pending = round2(Math.max(due - paidTotal, 0));
  return {
    schemeAmount: round2(schemeAmount),
    bookingAmount: round2(bookingAmount),
    totalDue: due,
    installmentsPaid: round2(installmentsPaid),
    totalPaid: paidTotal,
    pending,
    pendingPct: due > 0 ? pending / due : null,
    monthDue: w.month ? round2(monthDue) : null,
    monthActual: w.month ? round2(monthActual) : null,
    weekDue: w.week ? round2(weekDue) : null,
    weekActual: w.week ? round2(weekActual) : null,
    installmentsTotal: rows.length,
    installmentsReceived: received,
    overdueCount: overdue,
    nextDueDate: nextDue ? (nextDue as Date).toISOString() : null,
    lastPaymentDate: lastPaid ? (lastPaid as Date).toISOString() : null,
    status: positionStatus(rows.length, received, overdue),
  };
}

/** Months that actually contain installment or payment activity, newest first, plus the current month. */
function monthOptions(plans: PlanModel[], now: Date): FollowUpMonthOption[] {
  const keys = new Set<string>([monthKeyOf(now)]);
  for (const p of plans) for (const r of p.rows) {
    if (r.plannedDate) keys.add(monthKeyOf(r.plannedDate));
    if (r.receivedDate) keys.add(monthKeyOf(r.receivedDate));
  }
  return [...keys].sort((a, b) => b.localeCompare(a)).map((value) => ({ value, label: monthLabelOf(value) }));
}

/* --------------------------------- Dealer Follow-up --------------------------------- */

export interface DealerSchemeFigures extends FollowUpFigures {
  planId: string;
  schemeId: string;
  schemeName: string;
  instanceCount: number;
  numberOfSchemes: number;
  derivedSchedule: boolean;
}

export interface DealerFollowUpRow extends FollowUpFigures {
  dealerId: string;
  dealerName: string;
  town: string | null;
  mobile: string | null;
  salesOfficerName: string;
  state: string | null;
  schemeCount: number;
  instanceCount: number;
  schemeNames: string[];
  schemes: DealerSchemeFigures[]; // nested rows for the Collapsible View (no extra request)
}

export interface DealerFollowUpList {
  period: FollowUpPeriod;
  months: FollowUpMonthOption[];
  rows: DealerFollowUpRow[];
  totals: FollowUpFigures;
}

/** Sum a set of figures for the footer / parent totals (keeps one definition of "total of totals"). */
function sumFigures(parts: FollowUpFigures[], w: Windows): FollowUpFigures {
  const add = (get: (f: FollowUpFigures) => number) => round2(parts.reduce((s, f) => s + get(f), 0));
  const due = add((f) => f.totalDue);
  const paid = add((f) => f.totalPaid);
  const pending = round2(parts.reduce((s, f) => s + f.pending, 0)); // per-row floors preserved
  const total = parts.reduce((s, f) => s + f.installmentsTotal, 0);
  const received = parts.reduce((s, f) => s + f.installmentsReceived, 0);
  const overdue = parts.reduce((s, f) => s + f.overdueCount, 0);
  const nextDue = parts.map((f) => f.nextDueDate).filter(Boolean).sort() as string[];
  const lastPaid = parts.map((f) => f.lastPaymentDate).filter(Boolean).sort() as string[];
  return {
    schemeAmount: add((f) => f.schemeAmount),
    bookingAmount: add((f) => f.bookingAmount),
    totalDue: due,
    installmentsPaid: add((f) => f.installmentsPaid),
    totalPaid: paid,
    pending,
    pendingPct: due > 0 ? pending / due : null,
    monthDue: w.month ? add((f) => f.monthDue ?? 0) : null,
    monthActual: w.month ? add((f) => f.monthActual ?? 0) : null,
    weekDue: w.week ? add((f) => f.weekDue ?? 0) : null,
    weekActual: w.week ? add((f) => f.weekActual ?? 0) : null,
    installmentsTotal: total,
    installmentsReceived: received,
    overdueCount: overdue,
    nextDueDate: nextDue[0] ?? null,
    lastPaymentDate: lastPaid[lastPaid.length - 1] ?? null,
    status: positionStatus(total, received, overdue),
  };
}

const bySchemeFigures = (p: PlanModel, w: Windows): DealerSchemeFigures => ({
  ...aggregate(p.rows, p.schemeValueWithGST * p.instanceCount, p.bookingAmount, w),
  planId: p.planId, schemeId: p.schemeId, schemeName: p.schemeName,
  instanceCount: p.instanceCount, numberOfSchemes: p.numberOfSchemes, derivedSchedule: p.derivedSchedule,
});

/** Pending-first ordering: dealers/schemes needing recovery follow-up surface at the top. */
const recoveryOrder = <T extends FollowUpFigures & { name: string }>(a: T, b: T): number =>
  (b.pending > 0 ? 1 : 0) - (a.pending > 0 ? 1 : 0) || b.pending - a.pending || a.name.localeCompare(b.name);

/** DEALER FOLLOW-UP — one row per dealer, with their schemes nested for the Collapsible View. */
export async function dealerFollowUp(ctx: AuthContext, q: FollowUpQuery): Promise<DealerFollowUpList> {
  const now = new Date();
  const w = resolveWindows(q, now);
  const plans = await loadPlans(ctx, { officerId: q.officerId });

  const byDealer = new Map<string, PlanModel[]>();
  for (const p of plans) {
    const list = byDealer.get(p.dealerId);
    if (list) list.push(p);
    else byDealer.set(p.dealerId, [p]);
  }

  const rows: DealerFollowUpRow[] = [...byDealer.values()].map((group) => {
    const head = group[0];
    const schemes = group.map((p) => bySchemeFigures(p, w));
    const totals = sumFigures(schemes, w);
    return {
      ...totals,
      dealerId: head.dealerId, dealerName: head.dealerName, town: head.town, mobile: head.mobile,
      salesOfficerName: head.salesOfficerName, state: head.state,
      schemeCount: group.length,
      instanceCount: group.reduce((s, p) => s + p.instanceCount, 0),
      schemeNames: schemes.map((s) => s.schemeName),
      schemes: schemes.sort((a, b) => recoveryOrder({ ...a, name: a.schemeName }, { ...b, name: b.schemeName })),
    };
  });
  rows.sort((a, b) => recoveryOrder({ ...a, name: a.dealerName }, { ...b, name: b.dealerName }));

  return { period: w.period, months: monthOptions(plans, now), rows, totals: sumFigures(rows, w) };
}

/* --------------------------------- Scheme Follow-up --------------------------------- */

export interface SchemeDealerFigures extends FollowUpFigures {
  planId: string;
  dealerId: string;
  dealerName: string;
  town: string | null;
  mobile: string | null;
  salesOfficerName: string;
  instanceCount: number;
}

export interface SchemeFollowUpRow extends FollowUpFigures {
  schemeId: string;
  schemeName: string;
  dealerCount: number;
  instanceCount: number;
  dealers: SchemeDealerFigures[]; // nested rows for the Collapsible View
}

export interface SchemeFollowUpList {
  period: FollowUpPeriod;
  months: FollowUpMonthOption[];
  rows: SchemeFollowUpRow[];
  totals: FollowUpFigures;
}

/** SCHEME FOLLOW-UP — the same recovery position aggregated per scheme, dealers nested. */
export async function schemeFollowUp(ctx: AuthContext, q: FollowUpQuery): Promise<SchemeFollowUpList> {
  const now = new Date();
  const w = resolveWindows(q, now);
  const plans = await loadPlans(ctx, { officerId: q.officerId });

  const byScheme = new Map<string, PlanModel[]>();
  for (const p of plans) {
    const list = byScheme.get(p.schemeId);
    if (list) list.push(p);
    else byScheme.set(p.schemeId, [p]);
  }

  const rows: SchemeFollowUpRow[] = [...byScheme.values()].map((group) => {
    const head = group[0];
    const dealers: SchemeDealerFigures[] = group.map((p) => ({
      ...aggregate(p.rows, p.schemeValueWithGST * p.instanceCount, p.bookingAmount, w),
      planId: p.planId, dealerId: p.dealerId, dealerName: p.dealerName, town: p.town, mobile: p.mobile,
      salesOfficerName: p.salesOfficerName, instanceCount: p.instanceCount,
    }));
    return {
      ...sumFigures(dealers, w),
      schemeId: head.schemeId, schemeName: head.schemeName,
      dealerCount: group.length,
      instanceCount: group.reduce((s, p) => s + p.instanceCount, 0),
      dealers: dealers.sort((a, b) => recoveryOrder({ ...a, name: a.dealerName }, { ...b, name: b.dealerName })),
    };
  });
  rows.sort((a, b) => recoveryOrder({ ...a, name: a.schemeName }, { ...b, name: b.schemeName }));

  return { period: w.period, months: monthOptions(plans, now), rows, totals: sumFigures(rows, w) };
}

/* --------------------------------- Dealer drill-down --------------------------------- */

export interface FollowUpInstallmentRow {
  key: string;
  instanceNumber: number;
  installmentNumber: number;
  plannedAmount: number;
  plannedDate: string | null;
  receivedAmount: number | null;
  receivedDate: string | null;
  status: string; // RECEIVED | OVERDUE | PENDING (derived at the snapshot cutoff)
  daysLate: number | null; // received later than planned, in whole days
  derived: boolean; // schedule shown from the rules; not yet persisted
}

export interface FollowUpPaymentRow {
  key: string;
  schemeName: string;
  instanceNumber: number | null;
  kind: "BOOKING" | "INSTALLMENT";
  installmentNumber: number | null;
  amount: number;
  paymentDate: string | null;
  dueDate: string | null;
  status: string;
  daysLate: number | null;
}

export interface DealerFollowUpDetail {
  period: FollowUpPeriod;
  dealer: {
    id: string; name: string; town: string | null; village: string | null; tehsil: string | null; district: string | null;
    mobile: string | null; salesOfficerName: string; state: string | null;
  };
  summary: FollowUpFigures & { schemeCount: number; instanceCount: number };
  schemes: (DealerSchemeFigures & { installments: FollowUpInstallmentRow[] })[];
  payments: FollowUpPaymentRow[];
}

const daysLateOf = (planned: Date | null, receivedAt: Date | null): number | null => {
  if (!planned || !receivedAt) return null;
  const diff = Math.floor((receivedAt.getTime() - planned.getTime()) / DAY_MS);
  return diff > 0 ? diff : 0;
};

/** DEALER DRILL-DOWN — dealer info, summary, scheme-wise breakdown and the payment report. Read-only. */
export async function dealerFollowUpDetail(ctx: AuthContext, dealerId: string, q: FollowUpQuery): Promise<DealerFollowUpDetail> {
  const now = new Date();
  const w = resolveWindows(q, now);
  const plans = await loadPlans(ctx, { dealerId, officerId: q.officerId });
  // Out-of-scope or non-enrolled dealers are indistinguishable from unknown ids — never leak either.
  if (plans.length === 0) throw new ApiError(404, "No enrolled schemes found for this dealer");
  const head = plans[0];

  const schemes = plans
    .map((p) => ({
      ...bySchemeFigures(p, w),
      installments: p.rows.map((r) => ({
        key: `${r.instanceId}-${r.installmentNumber}`,
        instanceNumber: r.instanceNumber,
        installmentNumber: r.installmentNumber,
        plannedAmount: r.plannedAmount,
        plannedDate: r.plannedDate?.toISOString() ?? null,
        receivedAmount: r.receivedAmount,
        receivedDate: r.receivedDate?.toISOString() ?? null,
        status: r.receivedAmount != null ? "RECEIVED" : r.plannedDate && r.plannedDate.getTime() <= w.dueCutoff.getTime() ? "OVERDUE" : "PENDING",
        daysLate: daysLateOf(r.plannedDate, r.receivedDate),
        derived: r.derived,
      })),
    }))
    .sort((a, b) => recoveryOrder({ ...a, name: a.schemeName }, { ...b, name: b.schemeName }));

  // Payment report — Admin-confirmed booking money (dateless) plus every received installment.
  const payments: FollowUpPaymentRow[] = [];
  for (const p of plans) {
    if (p.bookingAmount > 0) {
      payments.push({
        key: `booking-${p.planId}`, schemeName: p.schemeName, instanceNumber: null, kind: "BOOKING", installmentNumber: null,
        amount: p.bookingAmount, paymentDate: null, dueDate: null, status: "Booking received (Admin confirmed)", daysLate: null,
      });
    }
    for (const r of p.rows) {
      if (r.receivedAmount == null) continue;
      if (r.receivedDate && r.receivedDate.getTime() > w.paidCutoff.getTime()) continue; // after the snapshot
      payments.push({
        key: `inst-${r.instanceId}-${r.installmentNumber}`,
        schemeName: p.schemeName, instanceNumber: r.instanceNumber, kind: "INSTALLMENT", installmentNumber: r.installmentNumber,
        amount: r.receivedAmount,
        paymentDate: r.receivedDate?.toISOString() ?? null,
        dueDate: r.plannedDate?.toISOString() ?? null,
        status: (() => {
          const late = daysLateOf(r.plannedDate, r.receivedDate);
          if (late == null) return "Received";
          return late > 0 ? `Received late (${late} day${late === 1 ? "" : "s"})` : "Received on time";
        })(),
        daysLate: daysLateOf(r.plannedDate, r.receivedDate),
      });
    }
  }
  payments.sort((a, b) => (b.paymentDate ?? "").localeCompare(a.paymentDate ?? "") || a.schemeName.localeCompare(b.schemeName));

  const totals = sumFigures(schemes, w);
  return {
    period: w.period,
    dealer: {
      id: head.dealerId, name: head.dealerName, town: head.town, village: head.village, tehsil: head.tehsil, district: head.district,
      mobile: head.mobile, salesOfficerName: head.salesOfficerName, state: head.state,
    },
    summary: { ...totals, schemeCount: plans.length, instanceCount: plans.reduce((s, p) => s + p.instanceCount, 0) },
    schemes,
    payments,
  };
}

/* --------------------------------- Export --------------------------------- */

export type FollowUpExportView = "dealer" | "scheme";

/** Human-readable filter line for the export header (matches the on-screen selection). */
export function followUpFilterLabels(period: FollowUpPeriod): string[] {
  const out = [`Month: ${period.monthLabel}`];
  if (period.weekLabel) out.push(`${period.weekLabel} (${new Date(period.weekFrom as string).toLocaleDateString("en-IN")} – ${new Date(period.weekTo as string).toLocaleDateString("en-IN")})`);
  else out.push("Week: All weeks");
  out.push(`Position as at: ${new Date(period.snapshotDate).toLocaleDateString("en-IN")}`);
  return out;
}
