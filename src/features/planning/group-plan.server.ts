import "server-only";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { figuresForMode, nbv as calcNbv, isQuantityMode, type PlanningMode } from "@/lib/calc";

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

/**
 * Territory (Group) Product Plan — READ-ONLY analytics. It aggregates the EXISTING plans of every Sales
 * Officer in a group, using the SAME mode-aware calc engine (`figuresForMode` / `nbv`) as the per-officer
 * Product Plan. It never writes.
 *
 * State model (discovered from the app's own constants, NOT assumed):
 *   - Approved  = SeasonPlan/MonthlyPlan.status ∈ {APPROVED}
 *   - Submitted = status ∈ {PENDING_RM, PENDING_ADMIN}          (the app's PENDING set)
 *   - Draft     = status ∈ {DRAFT, RETURNED, REJECTED}          (the app's EDITABLE set)
 *
 * Filtering (per the requirement, the two are never mixed):
 *   - Seasonal Total  → filters SEASONAL plans by bucket; one representative plan per officer per bucket
 *                       (Approved→active approved version, Submitted→latest pending, Draft→latest editable).
 *   - Specific Month / Month Range → filters MONTHLY plans by bucket (MonthlyPlan.status per season-month).
 *
 * Single source of truth: every value is emitted as an atomic `Contribution` (officer→dealer→plan[→month]).
 * A product's `total` and `byBucket` totals are the SUM of its contributions, so the drawer breakdown and
 * the grid total are the same numbers by construction (no second aggregation path).
 */

export type StatusBucket = "approved" | "submitted" | "draft";
export const ALL_BUCKETS: StatusBucket[] = ["approved", "submitted", "draft"];
// The single source of the status→bucket mapping, discovered from the app's EDITABLE/PENDING constants.
// Shared by Territory Product Plan AND Territory Recovery (both use the same PlanStatus workflow).
export const BUCKET_STATUSES: Record<StatusBucket, PlanStatus[]> = {
  approved: [PlanStatus.APPROVED],
  submitted: [PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN],
  draft: [PlanStatus.DRAFT, PlanStatus.RETURNED, PlanStatus.REJECTED],
};
export function bucketOfStatus(status: string): StatusBucket | null {
  for (const b of ALL_BUCKETS) if ((BUCKET_STATUSES[b] as string[]).includes(status)) return b;
  return null;
}

export interface GroupPlanFilter {
  buckets: StatusBucket[];
  view: "total" | "month" | "range";
  monthIds: string[];
  officerId?: string; // optional: restrict the whole aggregation to ONE Sales Officer in the group
}

export interface Contribution {
  bucket: StatusBucket;
  officerId: string;
  officerName: string;
  dealerId: string;
  dealerName: string;
  planId: string;
  planType: "SEASONAL" | "MONTHLY";
  version: number;
  status: string;
  monthId: string | null;
  monthName: string | null;
  qty: number;
  amount: number;
  nbv: number;
}
export interface BucketTotal {
  qty: number;
  amount: number;
  nbv: number;
  officerCount: number;
}
export interface GroupProductRow {
  productId: string;
  productName: string;
  technicalName: string | null;
  rate: number;
  nbvPercent: number;
  packSums: Record<string, number>; // seasonal view only
  total: { qty: number; amount: number; nbv: number }; // = Σ contributions (PLAN figures)
  actual: { qty: number; amount: number; nbv: number }; // seasonal: all-months sold; month: sold over selected months
  byBucket: Record<StatusBucket, BucketTotal>;
  contributions: Contribution[];
}
export interface OfficerRef {
  id: string;
  name: string;
}
export interface GroupOfficerBreakdown {
  total: number;
  includedCount: number;
  byBucket: Record<StatusBucket, OfficerRef[]>;
  excluded: { name: string; reason: string }[];
}
export interface GroupProductPlan {
  groupName: string;
  seasonName: string;
  monthlyMode: PlanningMode;
  seasonalMode: PlanningMode;
  filter: GroupPlanFilter;
  officers: GroupOfficerBreakdown;
  months: { id: string; name: string; order: number }[];
  packSizes: { id: string; name: string }[];
  products: GroupProductRow[];
}

const emptyBucketTotals = (): Record<StatusBucket, BucketTotal> => ({
  approved: { qty: 0, amount: 0, nbv: 0, officerCount: 0 },
  submitted: { qty: 0, amount: 0, nbv: 0, officerCount: 0 },
  draft: { qty: 0, amount: 0, nbv: 0, officerCount: 0 },
});

type SeasonPlanRow = { id: string; officerId: string; version: number; status: string; isActiveVersion: boolean };

export async function getGroupProductPlan(ctx: AuthContext, groupId: string, seasonId: string, filter: GroupPlanFilter): Promise<GroupProductPlan> {
  if (ctx.role !== Role.SUPER_ADMIN && ctx.role !== Role.REGIONAL_MANAGER) {
    throw new ApiError(403, "Only an admin or manager can view group planning");
  }
  // A Regional Manager may only view their OWN group's planning.
  if (ctx.role === Role.REGIONAL_MANAGER && ctx.groupId !== groupId) {
    throw new ApiError(403, "You can only view your own group's planning");
  }
  const buckets = filter.buckets.length ? filter.buckets : (["approved"] as StatusBucket[]);
  const selected = new Set(buckets);

  const [group, season, packSizes] = (await Promise.all([
    prisma.userGroup.findUnique({ where: { id: groupId }, select: { name: true } }),
    prisma.season.findUnique({
      where: { id: seasonId },
      select: { name: true, year: true, seasonalMode: true, monthlyMode: true, months: { orderBy: { order: "asc" }, select: { id: true, name: true, order: true } } },
    }),
    prisma.packSize.findMany({ where: { isActive: true, isPlanning: true }, orderBy: { displayOrder: "asc" }, select: { id: true, name: true } }),
  ])) as [
    { name: string } | null,
    { name: string; year: number; seasonalMode: string | null; monthlyMode: string | null; months: { id: string; name: string; order: number }[] } | null,
    { id: string; name: string }[],
  ];
  if (!group) throw new ApiError(404, "Group not found");
  if (!season) throw new ApiError(404, "Season not found");

  const monthlyMode = (season.monthlyMode ?? "PACK_SIZE") as PlanningMode;
  const seasonalMode = (season.seasonalMode ?? "PACK_SIZE") as PlanningMode;
  const monthNameById = new Map(season.months.map((m) => [m.id, m.name] as const));
  const base = { groupName: group.name, seasonName: `${season.name} ${season.year}`, monthlyMode, seasonalMode, months: season.months, packSizes, filter: { ...filter, buckets } };

  // Optional single-officer filter. The groupId constraint stays, so an officerId outside this group
  // (or an RM probing another group's officer) simply matches nothing — no cross-group leakage.
  const officers = (await prisma.user.findMany({
    where: { groupId, role: Role.SALES_OFFICER, isActive: true, ...(filter.officerId ? { id: filter.officerId } : {}) },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })) as OfficerRef[];
  const officerName = new Map(officers.map((o) => [o.id, o.name] as const));

  const emptyOfficers = (): GroupOfficerBreakdown => ({
    total: officers.length,
    includedCount: 0,
    byBucket: { approved: [], submitted: [], draft: [] },
    excluded: officers.map((o) => ({ name: o.name, reason: "No plan in the selected states" })),
  });
  if (officers.length === 0) return { ...base, officers: emptyOfficers(), products: [] };

  // Every ACTIVE-lifecycle seasonal plan (all versions/statuses) for these officers this season.
  const seasonPlans = (await prisma.seasonPlan.findMany({
    where: { seasonId, officerId: { in: officers.map((o) => o.id) }, planningType: "SEASONAL", lifecycleState: "ACTIVE" },
    select: { id: true, officerId: true, version: true, status: true, isActiveVersion: true },
    orderBy: { version: "desc" },
  })) as SeasonPlanRow[];
  const planById = new Map(seasonPlans.map((p) => [p.id, p] as const));

  // One representative plan per (officer, bucket). Plans are pre-sorted version DESC, so the first match
  // per officer per bucket is the "latest" (and the approved one prefers the active version).
  const repByOfficerBucket = new Map<string, SeasonPlanRow>();
  for (const p of seasonPlans) {
    const b = bucketOfStatus(p.status);
    if (!b) continue;
    const key = `${p.officerId}:${b}`;
    const existing = repByOfficerBucket.get(key);
    if (!existing) repByOfficerBucket.set(key, p);
    else if (b === "approved" && p.isActiveVersion && !existing.isActiveVersion) repByOfficerBucket.set(key, p); // prefer active approved
  }
  const repPlanBucket = new Map<string, StatusBucket>(); // representative planId -> its bucket (selected only)
  for (const [key, p] of repByOfficerBucket) {
    const b = key.split(":")[1] as StatusBucket;
    if (selected.has(b)) repPlanBucket.set(p.id, b);
  }

  const productRows = new Map<string, GroupProductRow>();
  const contributions: Contribution[] = [];
  const ensureRow = (l: { productId: string; product: { name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown } }): GroupProductRow => {
    let row = productRows.get(l.productId);
    if (!row) {
      row = {
        productId: l.productId,
        productName: l.product.name,
        technicalName: l.product.technicalName,
        rate: num(l.product.rate),
        nbvPercent: num(l.product.nbvPercent),
        packSums: {},
        total: { qty: 0, amount: 0, nbv: 0 },
        actual: { qty: 0, amount: 0, nbv: 0 },
        byBucket: emptyBucketTotals(),
        contributions: [],
      };
      productRows.set(l.productId, row);
    }
    return row;
  };
  const addContribution = (row: GroupProductRow, c: Contribution) => {
    row.contributions.push(c);
    contributions.push(c);
    row.total.qty += c.qty;
    row.total.amount += c.amount;
    row.total.nbv += c.nbv;
    const bt = row.byBucket[c.bucket];
    bt.qty += c.qty;
    bt.amount += c.amount;
    bt.nbv += c.nbv;
  };

  if (filter.view === "total") {
    // ----- SEASONAL TOTAL: representative seasonal plans of the selected buckets. -----
    const planIds = [...repPlanBucket.keys()];
    if (planIds.length > 0) {
      const planDealers = (await prisma.planDealer.findMany({
        where: { seasonPlanId: { in: planIds }, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
        select: {
          seasonPlanId: true,
          dealer: { select: { id: true, name: true } },
          lines: {
            select: {
              productId: true,
              inputMode: true,
              inputValue: true,
              product: { select: { name: true, technicalName: true, rate: true, nbvPercent: true } },
              packs: { select: { packSizeId: true, quantity: true } },
              monthlyEntries: { select: { saleQty: true, saleValue: true } },
            },
          },
        },
      })) as {
        seasonPlanId: string;
        dealer: { id: string; name: string };
        lines: {
          productId: string;
          inputMode: string | null;
          inputValue: unknown;
          product: { name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown };
          packs: { packSizeId: string; quantity: number }[];
          monthlyEntries: { saleQty: number; saleValue: unknown }[];
        }[];
      }[];

      for (const pd of planDealers) {
        const plan = planById.get(pd.seasonPlanId);
        const bucket = repPlanBucket.get(pd.seasonPlanId);
        if (!plan || !bucket) continue;
        for (const l of pd.lines) {
          const row = ensureRow(l);
          const rate = row.rate;
          const nbvPct = row.nbvPercent;
          const lineMode = (l.inputMode as PlanningMode | null) ?? "PACK_SIZE";
          const input = lineMode === "PACK_SIZE" ? l.packs.reduce((s, pk) => s + pk.quantity, 0) : l.inputValue !== null ? num(l.inputValue) : 0;
          const fig = figuresForMode(lineMode, input, rate, nbvPct);
          for (const pk of l.packs) row.packSums[pk.packSizeId] = (row.packSums[pk.packSizeId] ?? 0) + pk.quantity;
          // Seasonal actuals = all-months sold for this line.
          for (const e of l.monthlyEntries) {
            const sold = num(e.saleValue ?? 0);
            row.actual.qty += e.saleQty;
            row.actual.amount += sold;
            row.actual.nbv += calcNbv(sold, nbvPct);
          }
          addContribution(row, {
            bucket,
            officerId: plan.officerId,
            officerName: officerName.get(plan.officerId) ?? plan.officerId,
            dealerId: pd.dealer.id,
            dealerName: pd.dealer.name,
            planId: plan.id,
            planType: "SEASONAL",
            version: plan.version,
            status: plan.status,
            monthId: null,
            monthName: null,
            qty: fig.totalQty ?? 0,
            amount: fig.amount ?? 0,
            nbv: fig.nbv ?? 0,
          });
        }
      }
    }
  } else {
    // ----- SPECIFIC MONTH / MONTH RANGE: filter by MonthlyPlan.status per (seasonPlan, month). -----
    const allPlanIds = seasonPlans.map((p) => p.id);
    const monthIds = filter.monthIds.filter((id) => monthNameById.has(id));
    if (allPlanIds.length > 0 && monthIds.length > 0) {
      const monthlyPlans = (await prisma.monthlyPlan.findMany({
        where: { seasonPlanId: { in: allPlanIds }, seasonMonthId: { in: monthIds } },
        select: { seasonPlanId: true, seasonMonthId: true, status: true },
      })) as { seasonPlanId: string; seasonMonthId: string; status: string }[];
      // (seasonPlanId:monthId) -> bucket, but only for months whose MonthlyPlan is in a SELECTED bucket.
      const mpBucket = new Map<string, { bucket: StatusBucket; status: string }>();
      for (const mp of monthlyPlans) {
        const b = bucketOfStatus(mp.status);
        if (b && selected.has(b)) mpBucket.set(`${mp.seasonPlanId}:${mp.seasonMonthId}`, { bucket: b, status: mp.status });
      }
      const valueMonthly = !isQuantityMode(monthlyMode);

      if (mpBucket.size > 0) {
        const planDealers = (await prisma.planDealer.findMany({
          where: { seasonPlanId: { in: allPlanIds }, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
          select: {
            seasonPlanId: true,
            dealer: { select: { id: true, name: true } },
            lines: {
              select: {
                productId: true,
                product: { select: { name: true, technicalName: true, rate: true, nbvPercent: true } },
                monthlyEntries: { where: { seasonMonthId: { in: monthIds } }, select: { seasonMonthId: true, planQty: true, saleQty: true, planValue: true, saleValue: true } },
              },
            },
          },
        })) as {
          seasonPlanId: string;
          dealer: { id: string; name: string };
          lines: {
            productId: string;
            product: { name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown };
            monthlyEntries: { seasonMonthId: string; planQty: number; saleQty: number; planValue: unknown; saleValue: unknown }[];
          }[];
        }[];

        for (const pd of planDealers) {
          const plan = planById.get(pd.seasonPlanId);
          if (!plan) continue;
          for (const l of pd.lines) {
            const row = ensureRow(l);
            const rate = row.rate;
            const nbvPct = row.nbvPercent;
            for (const e of l.monthlyEntries) {
              const mp = mpBucket.get(`${pd.seasonPlanId}:${e.seasonMonthId}`);
              if (!mp) continue; // month's MonthlyPlan not in a selected bucket
              const planInput = valueMonthly ? num(e.planValue ?? 0) : e.planQty;
              const fig = figuresForMode(monthlyMode, planInput, rate, nbvPct);
              const sold = num(e.saleValue ?? 0);
              row.actual.qty += e.saleQty;
              row.actual.amount += sold;
              row.actual.nbv += calcNbv(sold, nbvPct);
              addContribution(row, {
                bucket: mp.bucket,
                officerId: plan.officerId,
                officerName: officerName.get(plan.officerId) ?? plan.officerId,
                dealerId: pd.dealer.id,
                dealerName: pd.dealer.name,
                planId: plan.id,
                planType: "MONTHLY",
                version: plan.version,
                status: mp.status,
                monthId: e.seasonMonthId,
                monthName: monthNameById.get(e.seasonMonthId) ?? null,
                qty: fig.totalQty ?? 0,
                amount: fig.amount ?? 0,
                nbv: fig.nbv ?? 0,
              });
            }
          }
        }
      }
    }
  }

  // Officer breakdown — derived from the SAME contributions (no separate logic).
  const officersByBucket: Record<StatusBucket, Set<string>> = { approved: new Set(), submitted: new Set(), draft: new Set() };
  for (const c of contributions) officersByBucket[c.bucket].add(c.officerId);
  const includedOfficerIds = new Set<string>([...officersByBucket.approved, ...officersByBucket.submitted, ...officersByBucket.draft]);
  const refs = (ids: Set<string>): OfficerRef[] => [...ids].map((id) => ({ id, name: officerName.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name));
  // Per-product officer counts per bucket.
  for (const row of productRows.values()) {
    const per: Record<StatusBucket, Set<string>> = { approved: new Set(), submitted: new Set(), draft: new Set() };
    for (const c of row.contributions) per[c.bucket].add(c.officerId);
    for (const b of ALL_BUCKETS) row.byBucket[b].officerCount = per[b].size;
  }

  const officerBreakdown: GroupOfficerBreakdown = {
    total: officers.length,
    includedCount: includedOfficerIds.size,
    byBucket: { approved: refs(officersByBucket.approved), submitted: refs(officersByBucket.submitted), draft: refs(officersByBucket.draft) },
    excluded: officers.filter((o) => !includedOfficerIds.has(o.id)).map((o) => ({ name: o.name, reason: "No plan in the selected states" })),
  };

  const products = [...productRows.values()].sort((a, b) => b.total.amount - a.total.amount);
  return { ...base, officers: officerBreakdown, products };
}
