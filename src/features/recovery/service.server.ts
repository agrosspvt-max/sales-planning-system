import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { getOfficerScope, assertOfficerInScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { assertLifecycleEditable, officerVisibilityWhere, isHiddenFromOfficer } from "@/features/planning/lifecycle.server";
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

/**
 * Recovery ALWAYS uses four fixed BUSINESS weeks — never calendar/ISO weeks, never a Week 5 —
 * regardless of whether the month has 28, 29, 30 or 31 days:
 *   Week 1 = days 1–7 · Week 2 = 8–14 · Week 3 = 15–22 · Week 4 = 23–end of month.
 */
export const BUSINESS_WEEK_COUNT = 4;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function weekCountForCutoff(_cutoff?: Date): number {
  return BUSINESS_WEEK_COUNT;
}

/** The business week (1–4) a due date falls in, by day-of-month. Days 23+ all belong to Week 4. */
export function businessWeekOfMonth(d: Date): 1 | 2 | 3 | 4 {
  const day = d.getDate();
  if (day <= 7) return 1;
  if (day <= 14) return 2;
  if (day <= 22) return 3;
  return 4;
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
  // Recovery MUST belong to a Seasonal plan. Link each officer's recovery plan to their SEASONAL
  // plan for this season (active version preferred). Officers WITHOUT a seasonal plan are skipped
  // so no orphan (null-parent) recovery plan is ever created.
  const seasonalPlans = await prisma.seasonPlan.findMany({
    where: { seasonId: month.seasonId, planningType: "SEASONAL", officerId: { in: [...res.byOfficer.keys()] } },
    select: { id: true, officerId: true, isActiveVersion: true, version: true },
    orderBy: [{ isActiveVersion: "desc" }, { version: "desc" }],
  });
  const seasonPlanByOfficer = new Map<string, string>();
  for (const sp of seasonalPlans as { id: string; officerId: string }[]) {
    if (!seasonPlanByOfficer.has(sp.officerId)) seasonPlanByOfficer.set(sp.officerId, sp.id);
  }
  const officersWithoutSeasonal = [...res.byOfficer.keys()].filter((o) => !seasonPlanByOfficer.has(o));
  for (const o of officersWithoutSeasonal) res.byOfficer.delete(o);
  if (res.byOfficer.size === 0) {
    throw new ApiError(
      422,
      "No matched officer has a Seasonal plan for this season. Create the Seasonal plan(s) first — recovery must belong to a seasonal plan.",
    );
  }

  const recoveryPlanRows: { id: string; seasonId: string; seasonMonthId: string; officerId: string; seasonPlanId: string | null; cutoffDate: Date; status: PlanStatus }[] = [];
  const agingSnapshotRows: { id: string; recoveryPlanId: string; weekNo: number; cutoffDate: Date; workbookName: string; uploadedById: string }[] = [];
  const agingSnapshotDealerRows: { id: string; snapshotId: string; dealerId: string; outstanding: number; overdue: number; due: number; running: number }[] = [];
  const agingSnapshotBillRows: { snapshotId: string; snapshotDealerId: string; dealerId: string; billDate: Date | null; refNo: string | null; amount: number; dueDate: Date | null; bucket: string }[] = [];
  const recoveryPlanDealerRows: { recoveryPlanId: string; dealerId: string; outstanding: number; overdue: number; due: number; running: number }[] = [];

  const planIds: string[] = [];
  let dealerCount = 0;
  let billCount = 0;

  for (const [officerId, dealersFor] of res.byOfficer) {
    const seasonPlanId = seasonPlanByOfficer.get(officerId);
    if (!seasonPlanId) continue; // guaranteed present (officers without a seasonal plan were removed)
    const planId = randomUUID();
    const snapshotId = randomUUID();
    planIds.push(planId);
    recoveryPlanRows.push({ id: planId, seasonId: month.seasonId, seasonMonthId: month.id, officerId, seasonPlanId, cutoffDate: cutoff, status: PlanStatus.DRAFT });
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
    where: {
      officerId: scope.all ? undefined : { in: scope.ids },
      status: statuses ? { in: statuses } : undefined,
      // Deactivated recovery plans — and any under a deactivated SEASONAL plan — are hidden from the
      // Sales Officer; Admin/RM still see them. (seasonPlanId null tolerated for legacy rows.)
      ...officerVisibilityWhere(ctx),
      ...(ctx.role === Role.SALES_OFFICER
        ? { OR: [{ seasonPlanId: null }, { seasonPlan: { lifecycleState: { not: "DEACTIVATED" } } }] }
        : {}),
    },
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
    lifecycleState: (r as { lifecycleState?: string }).lifecycleState ?? "ACTIVE",
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
      seasonPlan: { select: { lifecycleState: true } },
      dealers: {
        // Only ACTIVE dealers appear in Recovery (deactivated/deleted are hidden; history kept).
        where: { dealer: { isActive: true } },
        include: { dealer: { select: { name: true } }, weekPlans: true },
        orderBy: { dealer: { name: "asc" } },
      },
    },
  });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  // A deactivated recovery plan (or one under a deactivated seasonal plan) is hidden from the SO.
  const parentLifecycle = (plan as { seasonPlan?: { lifecycleState: string } | null }).seasonPlan?.lifecycleState;
  if (isHiddenFromOfficer(ctx, (plan as { lifecycleState?: string }).lifecycleState) || isHiddenFromOfficer(ctx, parentLifecycle)) {
    throw new ApiError(404, "Recovery plan not found");
  }
  await assertOfficerInScope(ctx, plan.officerId);

  const isOwner = ctx.role === Role.SALES_OFFICER && plan.officerId === ctx.userId;
  const canManage = isOwner || ctx.role === Role.SUPER_ADMIN;
  // A closed/deactivated recovery (or parent seasonal) plan is frozen — no month/week editing.
  const isLive = ((plan as { lifecycleState?: string }).lifecycleState ?? "ACTIVE") === "ACTIVE" && (parentLifecycle ?? "ACTIVE") === "ACTIVE";
  const monthEditable = canManage && EDITABLE.includes(plan.status as PlanStatus) && isLive;
  // Week View may be re-opened by a weekly upload toggle, even after approval; never while pending.
  const pending = plan.status === PlanStatus.PENDING_RM || plan.status === PlanStatus.PENDING_ADMIN;
  const weekEditable = canManage && plan.weeklyEditEnabled && !pending && isLive;
  const weekCount = weekCountForCutoff();

  // Per-week "This Week's Due": distribute the month's Due across the four business weeks by each
  // DUE invoice's Due Date (reusing the Due Date already parsed from the Aging Report and stored on
  // the bill). The sum of the four weeks equals the dealer's month Due. Sourced from the LATEST
  // snapshot's bills — a read-only, aging-derived figure; no planning value is touched.
  // The two most recent snapshots drive per-week Due (latest) AND change tracking (latest vs prev).
  const recentSnaps = (await prisma.agingSnapshot.findMany({
    where: { recoveryPlanId: plan.id },
    orderBy: [{ weekNo: "desc" }],
    take: 2,
    select: { id: true, weekNo: true, cutoffDate: true, summary: true, createdAt: true },
  })) as { id: string; weekNo: number; cutoffDate: Date; summary: string | null; createdAt: Date }[];
  const latestSnapshot = recentSnaps[0] ?? null;
  const prevSnapshot = recentSnaps[1] ?? null;

  const dueBills = latestSnapshot
    ? ((await prisma.agingSnapshotBill.findMany({
        where: { snapshotId: latestSnapshot.id, bucket: "DUE" },
        select: { dealerId: true, dueDate: true, amount: true },
      })) as { dealerId: string; dueDate: Date | null; amount: unknown }[])
    : [];
  const dueByWeekByDealer = new Map<string, Record<1 | 2 | 3 | 4, number>>();
  for (const b of dueBills) {
    if (!b.dueDate) continue; // a DUE bill always has a due date (null → Overdue), defensive only
    const wk = businessWeekOfMonth(b.dueDate);
    const rec = dueByWeekByDealer.get(b.dealerId) ?? { 1: 0, 2: 0, 3: 0, 4: 0 };
    rec[wk] += num(b.amount);
    dueByWeekByDealer.set(b.dealerId, rec);
  }

  // Change tracking: the PREVIOUS snapshot's per-dealer aging → deltas + "changed" row flags.
  const prevDealers = prevSnapshot
    ? ((await prisma.agingSnapshotDealer.findMany({ where: { snapshotId: prevSnapshot.id }, select: { dealerId: true, outstanding: true, overdue: true, due: true, running: true } })) as {
        dealerId: string; outstanding: unknown; overdue: unknown; due: unknown; running: unknown;
      }[])
    : [];
  const prevByDealer = new Map(prevDealers.map((d) => [d.dealerId, { outstanding: num(d.outstanding), overdue: num(d.overdue), due: num(d.due), running: num(d.running) }]));

  // Week locking follows the REFRESH SEQUENCE, matching the business rule: the initial upload =
  // Week 1 (nothing locked), and each Update Recovery advances the current week by one, locking the
  // earlier weeks. currentWeek = latest snapshot sequence + 1, capped at 4. Values are always
  // preserved — locking only disables editing of the past weeks.
  const currentWeek = Math.min(((latestSnapshot?.weekNo as number | undefined) ?? 0) + 1, BUSINESS_WEEK_COUNT);
  const lastRefresh =
    latestSnapshot && latestSnapshot.weekNo > 0 && latestSnapshot.summary
      ? { at: latestSnapshot.createdAt, businessWeek: currentWeek, ...(JSON.parse(latestSnapshot.summary) as AgingChangeSummary) }
      : null;

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
    currentWeek,
    lastRefresh,
    dealers: plan.dealers.map((d) => {
      const weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }> = {};
      for (const w of d.weekPlans) weeks[w.weekNo] = { weekRecoveryPlan: num(w.weekRecoveryPlan ?? 0), weekRunningRecovery: num(w.weekRunningRecovery ?? 0) };
      const monthRecoveryPlan = num(d.monthRecoveryPlan ?? 0);
      const monthRunningRecovery = num(d.monthRunningRecovery ?? 0);
      const prev = prevByDealer.get(d.dealerId) ?? null;
      const cur = { outstanding: num(d.outstanding), overdue: num(d.overdue), due: num(d.due), running: num(d.running) };
      const changed = prev ? prev.outstanding !== cur.outstanding || prev.overdue !== cur.overdue || prev.due !== cur.due || prev.running !== cur.running : false;
      return {
        dealerId: d.dealerId,
        dealerName: d.dealer.name,
        outstanding: cur.outstanding,
        overdue: cur.overdue,
        due: cur.due,
        running: cur.running,
        monthRecoveryPlan,
        monthRunningRecovery,
        noPlan: d.noPlan,
        noPlanReason: d.noPlanReason,
        completed: monthRecoveryPlan > 0 || monthRunningRecovery > 0,
        weeks,
        // Month's Due split across the four business weeks by due date (Week View uses the selected
        // week; Month View keeps the aggregate `due`).
        dueByWeek: dueByWeekByDealer.get(d.dealerId) ?? { 1: 0, 2: 0, 3: 0, 4: 0 },
        // Change tracking (vs previous snapshot): previous aging values + a changed flag.
        prevAging: prev,
        changed,
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
  const plan = await prisma.recoveryPlan.findUnique({
    where: { id },
    select: { id: true, officerId: true, status: true, weeklyEditEnabled: true, lifecycleState: true, seasonPlan: { select: { lifecycleState: true } } },
  });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  const isOwner = ctx.role === Role.SALES_OFFICER && plan.officerId === ctx.userId;
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) throw new ApiError(403, "You cannot edit this recovery plan");
  return plan as typeof plan & { lifecycleState: string; seasonPlan: { lifecycleState: string } | null };
}

/** A recovery plan is editable only when it AND its parent seasonal plan (if linked) are ACTIVE. */
function assertRecoveryLive(plan: { lifecycleState: string; seasonPlan?: { lifecycleState: string } | null }) {
  if (plan.seasonPlan) assertLifecycleEditable(plan.seasonPlan.lifecycleState, "The parent seasonal plan");
  assertLifecycleEditable(plan.lifecycleState, "This recovery plan");
}

export async function saveRecoveryMonth(ctx: AuthContext, id: string, raw: unknown) {
  const { entries } = monthSchema.parse(raw);
  const plan = await loadEditablePlan(ctx, id);
  if (!EDITABLE.includes(plan.status as PlanStatus)) throw new ApiError(409, "Month View is locked in this state");
  assertRecoveryLive(plan);
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
  assertRecoveryLive(plan);
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
  assertRecoveryLive(plan);
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
  const plan = await prisma.recoveryPlan.findUnique({
    where: { id: input.recoveryPlanId },
    select: { id: true, officerId: true, lifecycleState: true, seasonPlan: { select: { lifecycleState: true } } },
  });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  // Weekly re-upload obeys the SAME lifecycle guard as manual editing: a closed/deactivated recovery
  // plan (or one under a frozen seasonal plan) accepts no updates.
  assertRecoveryLive(plan as { lifecycleState: string; seasonPlan?: { lifecycleState: string } | null });

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
      await writeRefreshSnapshot(tx, plan.id, forOfficer, cutoff, filename, input.weekNo, ctx.userId, summary);
      await tx.recoveryPlan.update({ where: { id: plan.id }, data: { cutoffDate: cutoff, weeklyEditEnabled: input.allowWeeklyEdit } });
    },
    { timeout: 60000, maxWait: 10000 },
  );

  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "recoveryPlan", entityId: plan.id, summary: `Weekly Aging (week ${input.weekNo}) for ${filename}: +${outstandingIncreased}/-${outstandingDecreased} outstanding, ${newDealers} new, ${removedDealers} removed` });
  return summary;
}

/* ============================================================================
 * REUSABLE RECOVERY REFRESH SYSTEM
 * Business Data (aging-derived) is refreshed here; Planning Data (officer-entered
 * month/week values) is NEVER touched. Both the single weekly re-upload above and the batch
 * "Update Recovery" below share the ONE snapshot-writing core, so there is no duplicated logic.
 * ==========================================================================*/

/**
 * The ONE aging-refresh primitive for a single recovery plan: writes a NEW snapshot (+ per-dealer
 * aggregates + per-bill rows) and refreshes ONLY the read-only aging fields on RecoveryPlanDealer.
 * Planning values (month/week Recovery + Running) are never written here.
 */
async function writeRefreshSnapshot(
  tx: Tx,
  planId: string,
  forOfficer: ResolvedDealer[],
  cutoff: Date,
  filename: string,
  weekNo: number,
  uploadedById: string,
  summary: unknown,
): Promise<string> {
  const snapshot = await tx.agingSnapshot.create({
    data: { recoveryPlanId: planId, weekNo, cutoffDate: cutoff, workbookName: filename, uploadedById, summary: JSON.stringify(summary) },
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
    await tx.recoveryPlanDealer.updateMany({
      where: { recoveryPlanId: planId, dealerId: r.dealerId },
      data: { outstanding: r.aging.outstanding, overdue: r.aging.overdue, due: r.aging.due, running: r.aging.running },
    });
  }
  return snapshot.id;
}

/** The next snapshot sequence for a plan (0 = initial create, then +1 per refresh). Preserves the
 *  (recoveryPlanId, weekNo) uniqueness and keeps EVERY refresh in history. */
async function nextSnapshotWeekNo(planId: string): Promise<number> {
  const agg = await prisma.agingSnapshot.aggregate({ where: { recoveryPlanId: planId }, _max: { weekNo: true } });
  return ((agg._max.weekNo as number | null) ?? -1) + 1;
}

interface AgingChangeSummary {
  outstandingIncreased: number;
  outstandingDecreased: number;
  newDealers: number;
  removedDealers: number;
  outstandingDelta: number; // total outstanding after − before (negative = reduced = good)
}

/** Change tracking: compare the incoming aging with the plan's CURRENT aging (previous snapshot). */
function buildChangeSummary(
  prevByDealer: Map<string, number>,
  newByDealer: Map<string, ResolvedDealer["aging"]>,
): AgingChangeSummary {
  let outstandingIncreased = 0, outstandingDecreased = 0, newDealers = 0;
  let before = 0, after = 0;
  for (const [, prev] of prevByDealer) before += prev;
  const allIds = new Set<string>([...prevByDealer.keys(), ...newByDealer.keys()]);
  for (const id of allIds) {
    const prev = prevByDealer.get(id);
    const next = newByDealer.get(id)?.outstanding;
    after += next ?? prev ?? 0; // dealers absent from the new report keep their current value
    if (next === undefined) continue; // not in this report — unchanged
    if (prev === undefined) newDealers += 1;
    else if (next > prev) outstandingIncreased += 1;
    else if (next < prev) outstandingDecreased += 1;
  }
  const removedDealers = [...prevByDealer.keys()].filter((id) => !newByDealer.has(id)).length;
  return { outstandingIncreased, outstandingDecreased, newDealers, removedDealers, outstandingDelta: after - before };
}

/* ------------------------- Update Recovery (batch) ------------------------ */

const updateSchema = z.object({
  seasonMonthId: z.string().min(1, "Select a Month"),
  cutoffDate: z.string().min(1, "Select a Cutoff Date"),
  allowWeeklyEdit: z.coerce.boolean().default(true),
});

export interface RecoveryUpdateAnalysis {
  workbookName: string;
  seasonName: string;
  monthName: string;
  cutoffDate: string;
  plansMatched: number;
  officersAffected: number;
  dealersInReport: number;
  unknownDealers: string[];
  unassignedDealers: string[];
  reportTotals: { outstanding: number; overdue: number; due: number; running: number };
  currentTotals: { outstanding: number; overdue: number; due: number; running: number };
}

/** Preview an Update Recovery: which active plans for the month refresh, and the aggregate change. */
export async function analyzeRecoveryUpdate(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryUpdateAnalysis> {
  assertAdmin(ctx);
  const input = updateSchema.parse(raw);
  const cutoff = new Date(input.cutoffDate);
  const month = await prisma.seasonMonth.findUnique({ where: { id: input.seasonMonthId }, include: { season: { select: { name: true, year: true } } } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const parsed = parseAgingReport(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealers found — is this a Bills Receivable Aging Report?");
  const res = await resolveAging(parsed, cutoff);

  const plans = (await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: month.id, lifecycleState: "ACTIVE" },
    select: { id: true, officerId: true, seasonPlan: { select: { lifecycleState: true } } },
  })) as { id: string; officerId: string; seasonPlan: { lifecycleState: string } | null }[];
  const refreshable = plans.filter((p) => (p.seasonPlan?.lifecycleState ?? "ACTIVE") === "ACTIVE");
  const officersWithPlan = new Set(refreshable.map((p) => p.officerId));

  const affectedDealers = res.resolved.filter((r) => officersWithPlan.has(r.officerId));
  const reportTotals = affectedDealers.reduce(
    (t, r) => ({ outstanding: t.outstanding + r.aging.outstanding, overdue: t.overdue + r.aging.overdue, due: t.due + r.aging.due, running: t.running + r.aging.running }),
    { outstanding: 0, overdue: 0, due: 0, running: 0 },
  );
  const planIds = refreshable.filter((p) => res.byOfficer.has(p.officerId)).map((p) => p.id);
  const current = (await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: { in: planIds } }, select: { outstanding: true, overdue: true, due: true, running: true } })) as {
    outstanding: unknown; overdue: unknown; due: unknown; running: unknown;
  }[];
  const currentTotals = current.reduce<{ outstanding: number; overdue: number; due: number; running: number }>(
    (t, d) => ({ outstanding: t.outstanding + num(d.outstanding), overdue: t.overdue + num(d.overdue), due: t.due + num(d.due), running: t.running + num(d.running) }),
    { outstanding: 0, overdue: 0, due: 0, running: 0 },
  );

  return {
    workbookName: filename,
    seasonName: `${month.season.name} ${month.season.year}`,
    monthName: month.name,
    cutoffDate: input.cutoffDate,
    plansMatched: planIds.length,
    officersAffected: [...officersWithPlan].filter((o) => res.byOfficer.has(o)).length,
    dealersInReport: affectedDealers.length,
    unknownDealers: res.unknownDealers,
    unassignedDealers: res.unassignedDealers,
    reportTotals,
    currentTotals,
  };
}

export interface RecoverySkip {
  officerName: string;
  reason: string;
}
export interface RecoveryUpdateResult {
  updatedPlans: number;
  skippedPlans: number;
  skipped: RecoverySkip[];
  officers: number;
  dealersRefreshed: number;
  totalOutstandingDelta: number;
}

// Fail-safe skip reasons — a plan is only refreshed when it matches CONFIDENTLY on
// Season + Month (query) + Sales Officer (present in report) + Dealer (≥1 overlapping dealer).
const SKIP_SEASONAL_INACTIVE = "Seasonal plan not active";
const SKIP_NO_AGING = "No aging data for that officer";
const SKIP_DEALER_MISMATCH = "Dealer mismatch — report dealers don't match this plan";

/**
 * Update Recovery — refresh the aging/business data of active recovery plans for a month from a newly
 * uploaded Aging Report. FAIL-SAFE: a plan is refreshed only when it can be matched confidently on
 * Season + Month + Sales Officer + Dealer; any plan that cannot be matched is SKIPPED (never
 * modified) and reported with a reason. Reuses the exact import pipeline; each refreshed plan gets a
 * NEW snapshot (sequence weekNo) so history is preserved and planning values are untouched.
 */
export async function updateRecoveryFromAging(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryUpdateResult> {
  assertAdmin(ctx);
  const input = updateSchema.parse(raw);
  const cutoff = new Date(input.cutoffDate);
  const month = await prisma.seasonMonth.findUnique({ where: { id: input.seasonMonthId }, select: { id: true } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const parsed = parseAgingReport(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealers found — is this a Bills Receivable Aging Report?");
  const res = await resolveAging(parsed, cutoff);

  const plans = (await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: month.id, lifecycleState: "ACTIVE" },
    select: { id: true, officerId: true, officer: { select: { name: true } }, seasonPlan: { select: { lifecycleState: true } } },
  })) as { id: string; officerId: string; officer: { name: string }; seasonPlan: { lifecycleState: string } | null }[];
  if (plans.length === 0) throw new ApiError(422, "No active recovery plans exist for the selected month.");

  let updatedPlans = 0, dealersRefreshed = 0, totalOutstandingDelta = 0;
  const officers = new Set<string>();
  const skipped: RecoverySkip[] = [];

  for (const plan of plans) {
    const officerName = plan.officer.name;

    // Match check 1 — parent seasonal must be active.
    if ((plan.seasonPlan?.lifecycleState ?? "ACTIVE") !== "ACTIVE") {
      skipped.push({ officerName, reason: SKIP_SEASONAL_INACTIVE });
      continue;
    }
    // Match check 2 — the report must contain aging for THIS officer (Sales Officer match).
    const forOfficer = res.resolved.filter((r) => r.officerId === plan.officerId);
    if (forOfficer.length === 0) {
      skipped.push({ officerName, reason: SKIP_NO_AGING });
      continue;
    }
    // Match check 3 — at least one of the report's dealers must belong to this plan (Dealer match).
    const existing = (await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: plan.id }, select: { dealerId: true, outstanding: true } })) as { dealerId: string; outstanding: unknown }[];
    const planDealerIds = new Set(existing.map((d) => d.dealerId));
    if (!forOfficer.some((r) => planDealerIds.has(r.dealerId))) {
      skipped.push({ officerName, reason: SKIP_DEALER_MISMATCH });
      continue;
    }

    // Confidently matched → refresh.
    const newByDealer = new Map<string, ResolvedDealer["aging"]>(forOfficer.map((r) => [r.dealerId, r.aging]));
    const prevByDealer = new Map<string, number>(existing.map((d) => [d.dealerId, num(d.outstanding)]));
    const summary = buildChangeSummary(prevByDealer, newByDealer);
    const weekNo = await nextSnapshotWeekNo(plan.id);

    await prisma.$transaction(
      async (tx: Tx) => {
        await writeRefreshSnapshot(tx, plan.id, forOfficer, cutoff, filename, weekNo, ctx.userId, { ...summary, weekNo });
        await tx.recoveryPlan.update({ where: { id: plan.id }, data: { cutoffDate: cutoff, weeklyEditEnabled: input.allowWeeklyEdit } });
      },
      { timeout: 60000, maxWait: 10000 },
    );

    updatedPlans += 1;
    dealersRefreshed += forOfficer.length;
    totalOutstandingDelta += summary.outstandingDelta;
    officers.add(plan.officerId);
  }

  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "recoveryPlan",
    summary: `Update Recovery from ${filename}: ${updatedPlans} updated, ${skipped.length} skipped, ${dealersRefreshed} dealer(s), ₹${Math.round(totalOutstandingDelta)} outstanding change`,
  });
  return { updatedPlans, skippedPlans: skipped.length, skipped, officers: officers.size, dealersRefreshed, totalOutstandingDelta };
}

/* ----------------------------- Timeline + compare ------------------------- */

/** The aging-refresh timeline for one recovery plan (every snapshot, oldest → newest). */
export async function getRecoveryTimeline(ctx: AuthContext, id: string) {
  const plan = await prisma.recoveryPlan.findUnique({ where: { id }, select: { officerId: true } });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  await assertOfficerInScope(ctx, plan.officerId);
  const snaps = (await prisma.agingSnapshot.findMany({
    where: { recoveryPlanId: id },
    orderBy: [{ weekNo: "asc" }],
    select: { id: true, weekNo: true, cutoffDate: true, workbookName: true, summary: true, createdAt: true, uploadedBy: { select: { name: true } } },
  })) as { id: string; weekNo: number; cutoffDate: Date; workbookName: string; summary: string | null; createdAt: Date; uploadedBy: { name: string } }[];
  return {
    items: snaps.map((s) => ({
      id: s.id,
      weekNo: s.weekNo,
      // Timeline label = refresh SEQUENCE (initial = Week 1, each refresh +1), matching the locking model.
      businessWeek: s.weekNo + 1,
      initial: s.weekNo === 0,
      cutoffDate: s.cutoffDate,
      workbookName: s.workbookName,
      uploadedBy: s.uploadedBy.name,
      createdAt: s.createdAt,
      summary: s.summary ? (JSON.parse(s.summary) as AgingChangeSummary & { weekNo?: number }) : null,
    })),
  };
}

export async function compareSnapshots(ctx: AuthContext, id: string, fromId: string, toId: string) {
  assertAdmin(ctx); // admin analysis tool only
  const plan = await prisma.recoveryPlan.findUnique({ where: { id }, select: { officerId: true } });
  if (!plan) throw new ApiError(404, "Recovery plan not found");

  const load = async (snapshotId: string) =>
    (await prisma.agingSnapshotDealer.findMany({
      where: { snapshotId, snapshot: { recoveryPlanId: id } },
      select: { dealerId: true, outstanding: true, overdue: true, due: true, running: true, dealer: { select: { name: true } } },
    })) as { dealerId: string; outstanding: unknown; overdue: unknown; due: unknown; running: unknown; dealer: { name: string } }[];
  const [from, to] = await Promise.all([load(fromId), load(toId)]);
  const asMetrics = (d: { outstanding: unknown; overdue: unknown; due: unknown; running: unknown }) => ({
    outstanding: num(d.outstanding), overdue: num(d.overdue), due: num(d.due), running: num(d.running),
  });
  const fromByDealer = new Map(from.map((d) => [d.dealerId, { name: d.dealer.name, ...asMetrics(d) }]));
  const toByDealer = new Map(to.map((d) => [d.dealerId, { name: d.dealer.name, ...asMetrics(d) }]));
  const ids = [...new Set([...fromByDealer.keys(), ...toByDealer.keys()])];
  const zero = { outstanding: 0, overdue: 0, due: 0, running: 0 };
  const sum = (rows: Map<string, { outstanding: number; overdue: number; due: number; running: number }>) =>
    [...rows.values()].reduce((t, r) => ({ outstanding: t.outstanding + r.outstanding, overdue: t.overdue + r.overdue, due: t.due + r.due, running: t.running + r.running }), { ...zero });

  return {
    totals: { from: sum(fromByDealer), to: sum(toByDealer) },
    dealers: ids
      .map((did) => {
        const f = fromByDealer.get(did) ?? { name: toByDealer.get(did)?.name ?? "—", ...zero };
        const t = toByDealer.get(did) ?? { name: f.name, ...zero };
        return { dealerId: did, dealerName: t.name ?? f.name, from: { outstanding: f.outstanding, overdue: f.overdue, due: f.due, running: f.running }, to: { outstanding: t.outstanding, overdue: t.overdue, due: t.due, running: t.running } };
      })
      .filter((d) => d.from.outstanding !== d.to.outstanding || d.from.overdue !== d.to.overdue || d.from.due !== d.to.due || d.from.running !== d.to.running)
      .sort((a, b) => Math.abs(b.to.outstanding - b.from.outstanding) - Math.abs(a.to.outstanding - a.from.outstanding)),
  };
}
