import "server-only";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { BUSINESS_WEEK_COUNT, businessWeekOfMonth } from "@/features/recovery/service.server";
import { bucketOfStatus, type StatusBucket, type OfficerRef, type GroupOfficerBreakdown } from "@/features/planning/group-plan.server";
import type { RecoveryCalcDealer } from "@/features/recovery/recovery-calc";

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

/**
 * Territory (Group) Recovery — READ-ONLY analytics. It aggregates the EXISTING Recovery Plans of every
 * Sales Officer in a group for ONE season-month, summing each officer's dealers into an officer row. The
 * per-dealer numbers are the SAME stored recovery figures the per-officer Recovery table uses; the
 * roll-up (Month/Week totals, Recovery %) is computed by the SHARED `recovery-calc` module — no
 * recovery calculation is duplicated. It never writes.
 *
 * Recovery differs from Seasonal planning in two ways (verified in code, not assumed):
 *   1. Recovery has NO versions — RecoveryPlan is unique per (seasonMonth, officer). So the bucket filter
 *      is a straight status filter on each officer's single plan (no version selection).
 *   2. Recovery is month-scoped — there is no season-wide total; the caller picks a month.
 * The status→bucket mapping is the SAME as Territory Product Plan (shared `bucketOfStatus`).
 */

export interface TerritoryRecoveryDealer extends RecoveryCalcDealer {
  dealerName: string;
}
export interface RecoveryOfficerRow {
  officerId: string;
  officerName: string;
  bucket: StatusBucket;
  status: string;
  recoveryPlanId: string;
  dealers: TerritoryRecoveryDealer[];
}
export interface GroupRecovery {
  groupName: string;
  seasonName: string;
  monthName: string;
  seasonMonthId: string;
  weekCount: number;
  months: { id: string; name: string; order: number }[];
  filter: { buckets: StatusBucket[]; seasonMonthId: string };
  officers: GroupOfficerBreakdown;
  rows: RecoveryOfficerRow[];
}

type PlanDealerRow = {
  dealerId: string;
  dealer: { name: string };
  outstanding: unknown;
  overdue: unknown;
  due: unknown;
  running: unknown;
  outstandingTillDate: unknown;
  runningTillDate: unknown;
  srCr: unknown;
  liveRecovery: unknown;
  monthRecoveryPlan: unknown;
  monthRunningRecovery: unknown;
  weekPlans: { weekNo: number; weekRecoveryPlan: unknown; weekRunningRecovery: unknown }[];
};

export async function getGroupRecovery(ctx: AuthContext, groupId: string, seasonId: string, seasonMonthId: string, bucketsIn: StatusBucket[]): Promise<GroupRecovery> {
  if (ctx.role !== Role.SUPER_ADMIN && ctx.role !== Role.REGIONAL_MANAGER) {
    throw new ApiError(403, "Only an admin or manager can view group recovery");
  }
  // A Regional Manager may only view their OWN group's recovery.
  if (ctx.role === Role.REGIONAL_MANAGER && ctx.groupId !== groupId) {
    throw new ApiError(403, "You can only view your own group's recovery");
  }
  const buckets = bucketsIn.length ? bucketsIn : (["approved"] as StatusBucket[]);
  const selected = new Set(buckets);

  const [group, season] = (await Promise.all([
    prisma.userGroup.findUnique({ where: { id: groupId }, select: { name: true } }),
    prisma.season.findUnique({ where: { id: seasonId }, select: { name: true, year: true, months: { orderBy: { order: "asc" }, select: { id: true, name: true, order: true } } } }),
  ])) as [{ name: string } | null, { name: string; year: number; months: { id: string; name: string; order: number }[] } | null];
  if (!group) throw new ApiError(404, "Group not found");
  if (!season) throw new ApiError(404, "Season not found");
  const month = season.months.find((m) => m.id === seasonMonthId) ?? season.months[0];
  const monthId = month?.id ?? "";
  const base = { groupName: group.name, seasonName: `${season.name} ${season.year}`, monthName: month?.name ?? "", seasonMonthId: monthId, weekCount: BUSINESS_WEEK_COUNT, months: season.months, filter: { buckets, seasonMonthId: monthId } };

  const officers = (await prisma.user.findMany({
    where: { groupId, role: Role.SALES_OFFICER, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })) as OfficerRef[];
  const officerName = new Map(officers.map((o) => [o.id, o.name] as const));

  const emptyOfficers = (): GroupOfficerBreakdown => ({
    total: officers.length,
    includedCount: 0,
    byBucket: { approved: [], submitted: [], draft: [] },
    excluded: officers.map((o) => ({ name: o.name, reason: "No recovery plan in the selected states" })),
  });
  if (officers.length === 0 || !monthId) return { ...base, officers: emptyOfficers(), rows: [] };

  // ONE batched query: every officer's recovery plan for this month (all statuses), with dealers + weeks.
  const plans = (await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: monthId, officerId: { in: officers.map((o) => o.id) }, lifecycleState: "ACTIVE" },
    select: {
      id: true,
      officerId: true,
      status: true,
      dealers: {
        // Territory Recovery planning excludes Defaulters (blocked from planning). Per-officer recovery
        // history/detail (getRecoveryPlan) keeps them, so operational recovery is unaffected.
        where: { dealer: { isActive: true, status: { not: "DEFAULTER" } } },
        orderBy: { dealer: { name: "asc" } },
        select: {
          dealerId: true,
          dealer: { select: { name: true } },
          outstanding: true, overdue: true, due: true, running: true,
          outstandingTillDate: true, runningTillDate: true, srCr: true, liveRecovery: true,
          monthRecoveryPlan: true, monthRunningRecovery: true,
          weekPlans: { select: { weekNo: true, weekRecoveryPlan: true, weekRunningRecovery: true } },
        },
      },
    },
  })) as { id: string; officerId: string; status: string; dealers: PlanDealerRow[] }[];

  // Keep only plans whose status bucket is selected.
  const included = plans.filter((p) => {
    const b = bucketOfStatus(p.status);
    return b !== null && selected.has(b);
  });

  // dueByWeek per (planId, dealerId): from each included plan's LATEST aging snapshot's DUE bills.
  const dueByWeek = new Map<string, Record<number, number>>(); // key `${planId}:${dealerId}`
  if (included.length > 0) {
    const snaps = (await prisma.agingSnapshot.findMany({
      where: { recoveryPlanId: { in: included.map((p) => p.id) } },
      orderBy: [{ weekNo: "desc" }],
      select: { id: true, recoveryPlanId: true },
    })) as { id: string; recoveryPlanId: string }[];
    const latestSnapByPlan = new Map<string, string>(); // planId -> latest snapshot id (first seen = highest weekNo)
    const planBySnap = new Map<string, string>();
    for (const s of snaps) if (!latestSnapByPlan.has(s.recoveryPlanId)) { latestSnapByPlan.set(s.recoveryPlanId, s.id); planBySnap.set(s.id, s.recoveryPlanId); }
    const latestSnapIds = [...latestSnapByPlan.values()];
    if (latestSnapIds.length > 0) {
      const bills = (await prisma.agingSnapshotBill.findMany({
        where: { snapshotId: { in: latestSnapIds }, bucket: "DUE" },
        select: { snapshotId: true, dealerId: true, dueDate: true, amount: true },
      })) as { snapshotId: string; dealerId: string; dueDate: Date | null; amount: unknown }[];
      for (const b of bills) {
        if (!b.dueDate) continue;
        const planId = planBySnap.get(b.snapshotId);
        if (!planId) continue;
        const wk = businessWeekOfMonth(b.dueDate);
        const key = `${planId}:${b.dealerId}`;
        const rec = dueByWeek.get(key) ?? { 1: 0, 2: 0, 3: 0, 4: 0 };
        rec[wk] += num(b.amount);
        dueByWeek.set(key, rec);
      }
    }
  }

  const rows: RecoveryOfficerRow[] = included.map((p) => {
    const dealers: TerritoryRecoveryDealer[] = p.dealers.map((d) => {
      const overdue = num(d.overdue);
      const due = num(d.due);
      const srCr = num(d.srCr ?? 0);
      const liveRecovery = num(d.liveRecovery ?? 0);
      const weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }> = {};
      for (const w of d.weekPlans) weeks[w.weekNo] = { weekRecoveryPlan: num(w.weekRecoveryPlan ?? 0), weekRunningRecovery: num(w.weekRunningRecovery ?? 0) };
      return {
        dealerId: d.dealerId,
        dealerName: d.dealer.name,
        outstanding: num(d.outstanding),
        overdue,
        due,
        running: num(d.running),
        outstandingTillDate: num(d.outstandingTillDate ?? d.outstanding),
        runningTillDate: num(d.runningTillDate ?? d.running),
        srCr,
        liveRecovery,
        // Same derived formula as the per-officer Recovery table (service.server.ts): Live + SR/CR − (Due + Overdue).
        actualRunningRecovery: liveRecovery + srCr - (due + overdue),
        monthRecoveryPlan: num(d.monthRecoveryPlan ?? 0),
        monthRunningRecovery: num(d.monthRunningRecovery ?? 0),
        weeks,
        dueByWeek: dueByWeek.get(`${p.id}:${d.dealerId}`) ?? { 1: 0, 2: 0, 3: 0, 4: 0 },
      };
    });
    return {
      officerId: p.officerId,
      officerName: officerName.get(p.officerId) ?? p.officerId,
      bucket: bucketOfStatus(p.status)!,
      status: p.status,
      recoveryPlanId: p.id,
      dealers,
    };
  }).sort((a, b) => a.officerName.localeCompare(b.officerName));

  // Officer breakdown — same shape/logic as Territory Product Plan (buckets from the included rows).
  const byBucketSets: Record<StatusBucket, Set<string>> = { approved: new Set(), submitted: new Set(), draft: new Set() };
  for (const r of rows) byBucketSets[r.bucket].add(r.officerId);
  const includedIds = new Set(rows.map((r) => r.officerId));
  const refs = (ids: Set<string>): OfficerRef[] => [...ids].map((id) => ({ id, name: officerName.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name));
  const officerBreakdown: GroupOfficerBreakdown = {
    total: officers.length,
    includedCount: includedIds.size,
    byBucket: { approved: refs(byBucketSets.approved), submitted: refs(byBucketSets.submitted), draft: refs(byBucketSets.draft) },
    excluded: officers.filter((o) => !includedIds.has(o.id)).map((o) => ({ name: o.name, reason: "No recovery plan in the selected states" })),
  };

  return { ...base, officers: officerBreakdown, rows };
}
