import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { getOfficerScope, assertOfficerInScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { parseAgingReport, aggregateDealer, type ParsedAgingReport } from "./parser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const EDITABLE: PlanStatus[] = [PlanStatus.DRAFT, PlanStatus.RETURNED, PlanStatus.REJECTED];

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can upload the Aging Report");
}
function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

/** Weeks in the cutoff's calendar month (4 or 5). */
export function weekCountForCutoff(cutoff: Date): number {
  const days = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
  return Math.ceil(days / 7);
}

interface ResolvedDealer {
  dealerId: string;
  dealerName: string;
  officerId: string;
  aging: ReturnType<typeof aggregateDealer>;
}
interface Resolution {
  resolved: ResolvedDealer[];
  unknownDealers: string[];
  unassignedDealers: string[]; // matched but no current officer assignment
  byOfficer: Map<string, ResolvedDealer[]>;
}

/**
 * Resolve parsed aging dealers → master dealer → current officer. Dealer matching uses the ONE
 * shared resolver (Alias → exact → loose → fuzzy) — the SAME system as Sales Upload.
 */
async function resolveAging(parsed: ParsedAgingReport, cutoff: Date): Promise<Resolution> {
  const [resolver, assignmentRows] = await Promise.all([
    loadDealerResolver(),
    prisma.dealerAssignment.findMany({ where: { effectiveTo: null }, select: { dealerId: true, officerId: true } }),
  ]);
  const officerByDealer = new Map<string, string>((assignmentRows as { dealerId: string; officerId: string }[]).map((a) => [a.dealerId, a.officerId]));

  // Key by SYSTEM dealerId so the same master dealer is represented ONCE, even when it appears
  // under several Tally names/blocks or when distinct names loose/fuzzy-resolve to it. Without
  // this, an officer's group could hold the same dealerId twice and the create loop would insert
  // two AgingSnapshotDealer / RecoveryPlanDealer rows that collide on their (…, dealerId) unique
  // key — a P2002 inside the transaction even with no existing plans. Receivables are merged.
  const byDealer = new Map<string, ResolvedDealer>();
  const unknownDealers: string[] = [];
  const unassignedSet = new Set<string>();
  for (const d of parsed.dealers) {
    const dealer = resolver.resolve(d.rawName);
    if (!dealer) {
      unknownDealers.push(d.rawName);
      continue;
    }
    const officerId = officerByDealer.get(dealer.id);
    if (!officerId) {
      unassignedSet.add(dealer.name);
      continue;
    }
    const ag = aggregateDealer(d.bills, cutoff);
    const existing = byDealer.get(dealer.id);
    if (existing) {
      existing.aging = {
        outstanding: existing.aging.outstanding + ag.outstanding,
        overdue: existing.aging.overdue + ag.overdue,
        due: existing.aging.due + ag.due,
        running: existing.aging.running + ag.running,
        bills: existing.aging.bills.concat(ag.bills),
      };
    } else {
      byDealer.set(dealer.id, { dealerId: dealer.id, dealerName: dealer.name, officerId, aging: ag });
    }
  }

  const resolved = [...byDealer.values()];
  const byOfficer = new Map<string, ResolvedDealer[]>();
  for (const r of resolved) {
    const arr = byOfficer.get(r.officerId) ?? [];
    arr.push(r);
    byOfficer.set(r.officerId, arr);
  }
  return { resolved, unknownDealers, unassignedDealers: [...unassignedSet], byOfficer };
}

/* --------------------------------- Analyze -------------------------------- */

const createSchema = z.object({
  seasonMonthId: z.string().min(1, "Select a Month"),
  cutoffDate: z.string().min(1, "Select a Cutoff Date"),
});

export interface RecoveryAnalysis {
  workbookName: string;
  seasonName: string;
  monthName: string;
  dealersFound: number;
  billsParsed: number;
  officersAffected: number;
  unknownDealers: string[];
  unassignedDealers: string[];
  totals: { outstanding: number; overdue: number; due: number; running: number };
}

export async function analyzeAgingReport(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryAnalysis> {
  assertAdmin(ctx);
  const input = createSchema.parse(raw);
  const cutoff = new Date(input.cutoffDate);
  const month = await prisma.seasonMonth.findUnique({ where: { id: input.seasonMonthId }, include: { season: { select: { name: true, year: true } } } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const parsed = parseAgingReport(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealers found — is this a Bills Receivable Aging Report?");
  const res = await resolveAging(parsed, cutoff);

  const totals = res.resolved.reduce(
    (t, r) => ({ outstanding: t.outstanding + r.aging.outstanding, overdue: t.overdue + r.aging.overdue, due: t.due + r.aging.due, running: t.running + r.aging.running }),
    { outstanding: 0, overdue: 0, due: 0, running: 0 },
  );
  return {
    workbookName: filename,
    seasonName: `${month.season.name} ${month.season.year}`,
    monthName: month.name,
    dealersFound: res.resolved.length,
    billsParsed: parsed.totalBills,
    officersAffected: res.byOfficer.size,
    unknownDealers: res.unknownDealers,
    unassignedDealers: res.unassignedDealers,
    totals,
  };
}

/* ---------------------------- Create (week 0) ----------------------------- */

export interface RecoveryCreateResult {
  plansCreated: number;
  dealers: number;
  bills: number;
  unknownDealers: number;
  planIds: string[];
}

/**
 * Commit — creates a Draft RecoveryPlan per officer (split by dealer assignment) from the
 * initial (week 0) Aging Report, storing the normalised snapshot (dealer aggregates + bills)
 * and seeding each RecoveryPlanDealer's read-only aging figures. One transaction, bulk writes.
 */
export async function createRecoveryFromAging(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryCreateResult> {
  assertAdmin(ctx);
  const input = createSchema.parse(raw);
  const cutoff = new Date(input.cutoffDate);
  const month = await prisma.seasonMonth.findUnique({ where: { id: input.seasonMonthId }, select: { id: true, seasonId: true } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const parsed = parseAgingReport(buffer);
  const res = await resolveAging(parsed, cutoff);
  if (res.byOfficer.size === 0) throw new ApiError(422, "No matched, assigned dealers to plan recovery for");

  // Guard: a recovery plan for this month must not already exist for any affected officer.
  const existing = await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: month.id, officerId: { in: [...res.byOfficer.keys()] } },
    select: { officerId: true },
  });
  if (existing.length > 0) {
    throw new ApiError(409, "A Recovery Plan for this month already exists. Upload a weekly Aging Report to refresh it instead.");
  }

  // --- Build the ENTIRE write set OUTSIDE the transaction (pure construction, no DB). --------
  // Client-generated ids let us wire every FK (snapshot → plan, dealer → snapshot, bill →
  // snapshot+dealer) in memory, so each level is one bulk createMany instead of thousands of
  // sequential per-dealer creates. IDs are opaque; the rows/values are byte-for-byte identical.
  const recoveryPlanRows: { id: string; seasonId: string; seasonMonthId: string; officerId: string; cutoffDate: Date; status: PlanStatus }[] = [];
  const agingSnapshotRows: { id: string; recoveryPlanId: string; weekNo: number; cutoffDate: Date; workbookName: string; uploadedById: string }[] = [];
  const agingSnapshotDealerRows: { id: string; snapshotId: string; dealerId: string; outstanding: number; overdue: number; due: number; running: number }[] = [];
  const agingSnapshotBillRows: { snapshotId: string; snapshotDealerId: string; dealerId: string; billDate: Date | null; refNo: string | null; amount: number; dueDate: Date | null; bucket: string }[] = [];
  const recoveryPlanDealerRows: { recoveryPlanId: string; dealerId: string; outstanding: number; overdue: number; due: number; running: number }[] = [];

  const planIds: string[] = [];
  let dealerCount = 0;
  let billCount = 0;

  for (const [officerId, dealersFor] of res.byOfficer) {
    const planId = randomUUID();
    const snapshotId = randomUUID();
    planIds.push(planId);
    recoveryPlanRows.push({ id: planId, seasonId: month.seasonId, seasonMonthId: month.id, officerId, cutoffDate: cutoff, status: PlanStatus.DRAFT });
    agingSnapshotRows.push({ id: snapshotId, recoveryPlanId: planId, weekNo: 0, cutoffDate: cutoff, workbookName: filename, uploadedById: ctx.userId });
    for (const d of dealersFor) {
      const snapDealerId = randomUUID();
      agingSnapshotDealerRows.push({ id: snapDealerId, snapshotId, dealerId: d.dealerId, outstanding: d.aging.outstanding, overdue: d.aging.overdue, due: d.aging.due, running: d.aging.running });
      recoveryPlanDealerRows.push({ recoveryPlanId: planId, dealerId: d.dealerId, outstanding: d.aging.outstanding, overdue: d.aging.overdue, due: d.aging.due, running: d.aging.running });
      for (const b of d.aging.bills) {
        agingSnapshotBillRows.push({ snapshotId, snapshotDealerId: snapDealerId, dealerId: d.dealerId, billDate: b.billDate, refNo: b.refNo, amount: b.amount, dueDate: b.dueDate, bucket: b.bucket });
      }
      billCount += d.aging.bills.length;
      dealerCount += 1;
    }
  }

  // --- Writes ONLY: 5 bulk statements, parent-first for FK integrity. ------------------------
  await prisma.$transaction(
    async (tx: Tx) => {
      await tx.recoveryPlan.createMany({ data: recoveryPlanRows });
      await tx.agingSnapshot.createMany({ data: agingSnapshotRows });
      if (agingSnapshotDealerRows.length > 0) await tx.agingSnapshotDealer.createMany({ data: agingSnapshotDealerRows });
      if (agingSnapshotBillRows.length > 0) await tx.agingSnapshotBill.createMany({ data: agingSnapshotBillRows });
      if (recoveryPlanDealerRows.length > 0) await tx.recoveryPlanDealer.createMany({ data: recoveryPlanDealerRows });
    },
    { timeout: 60000, maxWait: 10000 },
  );

  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "recoveryPlan",
    summary: `Recovery created from ${filename} — ${planIds.length} officer plan(s), ${dealerCount} dealers, ${billCount} bills`,
  });
  return { plansCreated: planIds.length, dealers: dealerCount, bills: billCount, unknownDealers: res.unknownDealers.length, planIds };
}

/* -------------------------------- Lists ----------------------------------- */

export async function listRecoveryPlans(ctx: AuthContext, statuses?: PlanStatus[]) {
  const scope = await getOfficerScope(ctx);
  const rows = await prisma.recoveryPlan.findMany({
    where: { officerId: scope.all ? undefined : { in: scope.ids }, status: statuses ? { in: statuses } : undefined },
    include: { season: { select: { name: true, year: true } }, seasonMonth: { select: { name: true } }, officer: { select: { name: true } } },
    orderBy: [{ updatedAt: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    seasonName: `${r.season.name} ${r.season.year}`,
    monthName: r.seasonMonth.name,
    officerId: r.officerId,
    officerName: r.officer.name,
    status: r.status as PlanStatus,
    cutoffDate: r.cutoffDate,
    lastSavedAt: r.lastSavedAt,
    updatedAt: r.updatedAt,
  }));
}

/* ------------------------------- Detail ----------------------------------- */

export async function getRecoveryPlan(ctx: AuthContext, id: string) {
  const plan = await prisma.recoveryPlan.findUnique({
    where: { id },
    include: {
      season: { select: { name: true, year: true } },
      seasonMonth: { select: { name: true } },
      officer: { select: { name: true } },
      dealers: {
        include: { dealer: { select: { name: true } }, weekPlans: true },
        orderBy: { dealer: { name: "asc" } },
      },
    },
  });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  await assertOfficerInScope(ctx, plan.officerId);

  const isOwner = ctx.role === Role.SALES_OFFICER && plan.officerId === ctx.userId;
  const canManage = isOwner || ctx.role === Role.SUPER_ADMIN;
  const monthEditable = canManage && EDITABLE.includes(plan.status as PlanStatus);
  // Week View may be re-opened by a weekly upload toggle, even after approval; never while pending.
  const pending = plan.status === PlanStatus.PENDING_RM || plan.status === PlanStatus.PENDING_ADMIN;
  const weekEditable = canManage && plan.weeklyEditEnabled && !pending;
  const weekCount = weekCountForCutoff(new Date(plan.cutoffDate));

  return {
    id: plan.id,
    status: plan.status as PlanStatus,
    officerId: plan.officerId,
    officerName: plan.officer.name,
    seasonName: `${plan.season.name} ${plan.season.year}`,
    monthName: plan.seasonMonth.name,
    cutoffDate: plan.cutoffDate,
    weeklyEditEnabled: plan.weeklyEditEnabled,
    monthEditable,
    weekEditable,
    weekCount,
    dealers: plan.dealers.map((d) => {
      const weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }> = {};
      for (const w of d.weekPlans) weeks[w.weekNo] = { weekRecoveryPlan: num(w.weekRecoveryPlan ?? 0), weekRunningRecovery: num(w.weekRunningRecovery ?? 0) };
      const monthRecoveryPlan = num(d.monthRecoveryPlan ?? 0);
      const monthRunningRecovery = num(d.monthRunningRecovery ?? 0);
      return {
        dealerId: d.dealerId,
        dealerName: d.dealer.name,
        outstanding: num(d.outstanding),
        overdue: num(d.overdue),
        due: num(d.due),
        running: num(d.running),
        monthRecoveryPlan,
        monthRunningRecovery,
        noPlan: d.noPlan,
        noPlanReason: d.noPlanReason,
        completed: monthRecoveryPlan > 0 || monthRunningRecovery > 0,
        weeks,
      };
    }),
  };
}

/* -------------------------------- Saving ---------------------------------- */

const monthSchema = z.object({
  entries: z.array(z.object({ dealerId: z.string().min(1), monthRecoveryPlan: z.coerce.number().min(0).optional(), monthRunningRecovery: z.coerce.number().min(0).optional() })),
});
const weekSchema = z.object({
  weekNo: z.coerce.number().int().min(1).max(6),
  entries: z.array(z.object({ dealerId: z.string().min(1), weekRecoveryPlan: z.coerce.number().min(0).optional(), weekRunningRecovery: z.coerce.number().min(0).optional() })),
});

async function loadEditablePlan(ctx: AuthContext, id: string) {
  const plan = await prisma.recoveryPlan.findUnique({ where: { id }, select: { id: true, officerId: true, status: true, weeklyEditEnabled: true } });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  const isOwner = ctx.role === Role.SALES_OFFICER && plan.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) throw new ApiError(403, "You cannot edit this recovery plan");
  return plan;
}

export async function saveRecoveryMonth(ctx: AuthContext, id: string, raw: unknown) {
  const { entries } = monthSchema.parse(raw);
  const plan = await loadEditablePlan(ctx, id);
  if (!EDITABLE.includes(plan.status as PlanStatus)) throw new ApiError(409, "Month View is locked in this state");
  const dealerIds = new Set((await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: id }, select: { dealerId: true } })).map((d) => d.dealerId));
  await prisma.$transaction(
    async (tx: Tx) => {
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        await Promise.all(
          entries.slice(i, i + CHUNK).map((e) => {
            if (!dealerIds.has(e.dealerId)) return Promise.resolve();
            return tx.recoveryPlanDealer.update({
              where: { recoveryPlanId_dealerId: { recoveryPlanId: id, dealerId: e.dealerId } },
              data: { monthRecoveryPlan: e.monthRecoveryPlan, monthRunningRecovery: e.monthRunningRecovery },
            });
          }),
        );
      }
    },
    { timeout: 60000, maxWait: 10000 },
  );
  const saved = await prisma.recoveryPlan.update({ where: { id }, data: { lastSavedAt: new Date() }, select: { lastSavedAt: true } });
  return { saved: true, lastSavedAt: saved.lastSavedAt };
}

export async function saveRecoveryWeek(ctx: AuthContext, id: string, raw: unknown) {
  const { weekNo, entries } = weekSchema.parse(raw);
  const plan = await loadEditablePlan(ctx, id);
  const pending = plan.status === PlanStatus.PENDING_RM || plan.status === PlanStatus.PENDING_ADMIN;
  if (pending || !plan.weeklyEditEnabled) throw new ApiError(409, "Week View is locked");
  const dealerRows = await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: id }, select: { id: true, dealerId: true } });
  const byDealer = new Map(dealerRows.map((d) => [d.dealerId, d.id]));
  await prisma.$transaction(
    async (tx: Tx) => {
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        await Promise.all(
          entries.slice(i, i + CHUNK).map((e) => {
            const rpdId = byDealer.get(e.dealerId);
            if (!rpdId) return Promise.resolve();
            return tx.recoveryWeekPlan.upsert({
              where: { recoveryPlanDealerId_weekNo: { recoveryPlanDealerId: rpdId, weekNo } },
              create: { recoveryPlanDealerId: rpdId, weekNo, weekRecoveryPlan: e.weekRecoveryPlan, weekRunningRecovery: e.weekRunningRecovery },
              update: { weekRecoveryPlan: e.weekRecoveryPlan, weekRunningRecovery: e.weekRunningRecovery },
            });
          }),
        );
      }
    },
    { timeout: 60000, maxWait: 10000 },
  );
  const saved = await prisma.recoveryPlan.update({ where: { id }, data: { lastSavedAt: new Date() }, select: { lastSavedAt: true } });
  return { saved: true, lastSavedAt: saved.lastSavedAt };
}

export async function setRecoveryDealerNoPlan(ctx: AuthContext, id: string, dealerId: string, noPlan: boolean, reason?: string) {
  const plan = await loadEditablePlan(ctx, id);
  if (!EDITABLE.includes(plan.status as PlanStatus)) throw new ApiError(409, "This recovery plan is not editable");
  const noPlanReason = noPlan ? reason?.trim() || null : null;
  await prisma.recoveryPlanDealer.update({ where: { recoveryPlanId_dealerId: { recoveryPlanId: id, dealerId } }, data: { noPlan, noPlanReason } });
  return { noPlan, noPlanReason };
}

/* ---------------------- Weekly re-upload + change tracking ----------------- */

const weeklySchema = z.object({
  recoveryPlanId: z.string().min(1),
  weekNo: z.coerce.number().int().min(1).max(6),
  cutoffDate: z.string().min(1),
  allowWeeklyEdit: z.coerce.boolean().default(true),
});

export interface WeeklyUploadResult {
  weekNo: number;
  outstandingIncreased: number;
  outstandingDecreased: number;
  newDealers: number;
  removedDealers: number;
}

/**
 * Weekly Aging Report re-upload: creates a NEW snapshot (never overwrites), refreshes ONLY the
 * read-only aging figures on RecoveryPlanDealer, sets the Week-edit toggle, and returns a
 * change-tracking summary vs the previous snapshot. Month plan / weekly plans / history are
 * preserved.
 */
export async function uploadWeeklyAging(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<WeeklyUploadResult> {
  assertAdmin(ctx);
  const input = weeklySchema.parse(raw);
  const cutoff = new Date(input.cutoffDate);
  const plan = await prisma.recoveryPlan.findUnique({ where: { id: input.recoveryPlanId }, select: { id: true, officerId: true } });
  if (!plan) throw new ApiError(404, "Recovery plan not found");

  const parsed = parseAgingReport(buffer);
  const res = await resolveAging(parsed, cutoff);
  // Only this plan's officer's dealers are relevant.
  const forOfficer = res.resolved.filter((r) => r.officerId === plan.officerId);
  const newByDealer = new Map<string, ResolvedDealer["aging"]>(forOfficer.map((r) => [r.dealerId, r.aging]));

  const existingDealers = await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: plan.id }, select: { dealerId: true, outstanding: true } });
  const prevByDealer = new Map<string, number>(
    (existingDealers as { dealerId: string; outstanding: unknown }[]).map((d) => [d.dealerId, num(d.outstanding)]),
  );

  let outstandingIncreased = 0, outstandingDecreased = 0, newDealers = 0;
  for (const [dealerId, aging] of newByDealer) {
    const prev = prevByDealer.get(dealerId);
    if (prev === undefined) newDealers += 1;
    else if (aging.outstanding > prev) outstandingIncreased += 1;
    else if (aging.outstanding < prev) outstandingDecreased += 1;
  }
  const removedDealers = [...prevByDealer.keys()].filter((d) => !newByDealer.has(d)).length;
  const summary: WeeklyUploadResult = { weekNo: input.weekNo, outstandingIncreased, outstandingDecreased, newDealers, removedDealers };

  await prisma.$transaction(
    async (tx: Tx) => {
      const snapshot = await tx.agingSnapshot.create({
        data: { recoveryPlanId: plan.id, weekNo: input.weekNo, cutoffDate: cutoff, workbookName: filename, uploadedById: ctx.userId, summary: JSON.stringify(summary) },
      });
      for (const r of forOfficer) {
        const sd = await tx.agingSnapshotDealer.create({
          data: { snapshotId: snapshot.id, dealerId: r.dealerId, outstanding: r.aging.outstanding, overdue: r.aging.overdue, due: r.aging.due, running: r.aging.running },
        });
        if (r.aging.bills.length > 0) {
          await tx.agingSnapshotBill.createMany({
            data: r.aging.bills.map((b) => ({ snapshotId: snapshot.id, snapshotDealerId: sd.id, dealerId: r.dealerId, billDate: b.billDate, refNo: b.refNo, amount: b.amount, dueDate: b.dueDate, bucket: b.bucket })),
          });
        }
        // Refresh ONLY the read-only aging fields; never touch plan values.
        await tx.recoveryPlanDealer.updateMany({
          where: { recoveryPlanId: plan.id, dealerId: r.dealerId },
          data: { outstanding: r.aging.outstanding, overdue: r.aging.overdue, due: r.aging.due, running: r.aging.running },
        });
      }
      await tx.recoveryPlan.update({ where: { id: plan.id }, data: { cutoffDate: cutoff, weeklyEditEnabled: input.allowWeeklyEdit } });
    },
    { timeout: 60000, maxWait: 10000 },
  );

  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "recoveryPlan", entityId: plan.id, summary: `Weekly Aging (week ${input.weekNo}) for ${filename}: +${outstandingIncreased}/-${outstandingDecreased} outstanding, ${newDealers} new, ${removedDealers} removed` });
  return summary;
}
