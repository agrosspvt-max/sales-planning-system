import "server-only";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { figuresForMode, nbv as calcNbv, isQuantityMode, type PlanningMode } from "@/lib/calc";
import { clearanceMapForGroup } from "@/features/users/catalogue.server";

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
  // Season Baseline mode. "approved" (default) → the 5 Season columns always use APPROVED seasonal +
  // APPROVED monthly plans regardless of the selected buckets. "filters" → they follow the selected buckets.
  // Either way the period columns (This Period / Financials) always follow the selected buckets + view.
  seasonMetrics?: "approved" | "filters";
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
  isClearance: boolean; // group-specific clearance flag (this group's catalogue)
  clearanceQty: number | null;
  // SEASON BASELINE (complete season; respects season+officer+scope; uses APPROVED plans by default, or
  // the selected buckets when seasonMetrics="filters"). NEVER changes with the period selector.
  seasonQty: number; // total seasonal plan qty
  plannedAllMonths: number; // qty distributed into monthly plans across ALL months (gated per month)
  remaining: number; // seasonQty − plannedAllMonths
  seasonSales: number; // all-months sold qty for the season
  pendingSales: number; // seasonQty − seasonSales
  // Season Baseline amounts (for the "Show Amounts" toggle) — same source, amount instead of qty.
  seasonAmount: number;
  plannedAllMonthsAmount: number;
  remainingAmount: number;
  seasonSalesAmount: number;
  pendingAmount: number;
  // PERIOD-LEVEL (respond to Seasonal Total / Specific Month / Month Range). `total` = This Period Plan
  // (qty/amount/nbv → Planned Amount/NBV); `actual` = This Period Sold (qty/amount/nbv → Actual Amount/NBV).
  total: { qty: number; amount: number; nbv: number };
  actual: { qty: number; amount: number; nbv: number };
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

  // Contributors to a state's Territory Plan = every Sales Officer in the group PLUS the group's own
  // Regional Manager (the RM also plans their own dealers). The groupId constraint stays, so an officerId
  // outside this group (or an RM probing another group's officer) simply matches nothing — no leakage.
  const officers = (await prisma.user.findMany({
    where: { groupId, role: { in: [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] }, isActive: true, ...(filter.officerId ? { id: filter.officerId } : {}) },
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
  // Season Baseline buckets: APPROVED by default (management baseline), or the selected buckets when the
  // caller chose "Follow Selected Filters". These drive ONLY the 5 Season Baseline columns (+ amounts).
  const baselineBuckets: Set<StatusBucket> = filter.seasonMetrics === "filters" ? selected : new Set<StatusBucket>(["approved"]);
  const baselineRepIds = new Set<string>(); // representative seasonal plan ids for the baseline buckets
  for (const [key, p] of repByOfficerBucket) {
    const b = key.split(":")[1] as StatusBucket;
    if (baselineBuckets.has(b)) baselineRepIds.add(p.id);
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
        isClearance: false,
        clearanceQty: null,
        seasonQty: 0,
        plannedAllMonths: 0,
        remaining: 0,
        seasonSales: 0,
        pendingSales: 0,
        seasonAmount: 0,
        plannedAllMonthsAmount: 0,
        remainingAmount: 0,
        seasonSalesAmount: 0,
        pendingAmount: 0,
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

  const valueMonthly = !isQuantityMode(monthlyMode);
  const selectedMonthSet = new Set(filter.monthIds.filter((id) => monthNameById.has(id)));
  const isTotal = filter.view === "total";

  // ===== SEASONAL pass (ALWAYS runs). Loads BOTH the Season-Baseline representative plans and the
  // period (Seasonal-Total) representative plans in ONE query. Baseline plans feed Season Qty / Season
  // Sales (+ amounts); period plans feed the period columns via addContribution. Reuses figuresForMode.
  const repIds = [...new Set([...baselineRepIds, ...repPlanBucket.keys()])];
  if (repIds.length > 0) {
    const planDealers = (await prisma.planDealer.findMany({
      where: { seasonPlanId: { in: repIds }, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
      select: {
        seasonPlanId: true,
        dealer: { select: { id: true, name: true } },
        lines: {
          select: {
            productId: true,
            inputMode: true,
            inputValue: true,
            rateSnapshot: true,
            nbvPercentSnapshot: true,
            product: { select: { name: true, technicalName: true, rate: true, nbvPercent: true } },
            packs: { select: { quantity: true } },
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
        rateSnapshot: unknown;
        nbvPercentSnapshot: unknown;
        product: { name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown };
        packs: { quantity: number }[];
        monthlyEntries: { saleQty: number; saleValue: unknown }[];
      }[];
    }[];

    for (const pd of planDealers) {
      const plan = planById.get(pd.seasonPlanId);
      if (!plan) continue;
      const isBaseline = baselineRepIds.has(pd.seasonPlanId);
      const periodBucket = repPlanBucket.get(pd.seasonPlanId); // set only for period (selected) reps
      for (const l of pd.lines) {
        const row = ensureRow(l);
        // Snapshot-first pricing (frozen on the line) with live-Master fallback.
        const rate = num(l.rateSnapshot ?? l.product.rate);
        const nbvPct = num(l.nbvPercentSnapshot ?? l.product.nbvPercent);
        const lineMode = (l.inputMode as PlanningMode | null) ?? "PACK_SIZE";
        const input = lineMode === "PACK_SIZE" ? l.packs.reduce((s, pk) => s + pk.quantity, 0) : l.inputValue !== null ? num(l.inputValue) : 0;
        const fig = figuresForMode(lineMode, input, rate, nbvPct);
        let soldQty = 0, soldAmt = 0;
        for (const e of l.monthlyEntries) { soldQty += e.saleQty; soldAmt += num(e.saleValue ?? 0); }
        // Season Baseline (qty + amount) — from the baseline representative plans.
        if (isBaseline) {
          row.seasonQty += fig.totalQty ?? 0;
          row.seasonAmount += fig.amount ?? 0;
          row.seasonSales += soldQty;
          row.seasonSalesAmount += soldAmt;
        }
        // Period columns (Seasonal-Total view) — from the selected-bucket representative plans.
        if (isTotal && periodBucket) {
          row.actual.qty += soldQty;
          row.actual.amount += soldAmt;
          row.actual.nbv += calcNbv(soldAmt, nbvPct);
          addContribution(row, {
            bucket: periodBucket, officerId: plan.officerId, officerName: officerName.get(plan.officerId) ?? plan.officerId,
            dealerId: pd.dealer.id, dealerName: pd.dealer.name, planId: plan.id, planType: "SEASONAL",
            version: plan.version, status: plan.status, monthId: null, monthName: null,
            qty: fig.totalQty ?? 0, amount: fig.amount ?? 0, nbv: fig.nbv ?? 0,
          });
        }
      }
    }
  }

  // ===== SEASON-LEVEL · MONTHLY pass (ALWAYS runs). Every month's MonthlyPlan gated by its OWN status
  // bucket → Planned (All Months) for every product (sum across ALL months). In Month/Range view this
  // SAME pass also emits the period columns from the SELECTED months. Reuses figuresForMode / calcNbv.
  const allPlanIds = seasonPlans.map((p) => p.id);
  if (allPlanIds.length > 0) {
    const monthlyPlans = (await prisma.monthlyPlan.findMany({
      where: { seasonPlanId: { in: allPlanIds } },
      select: { seasonPlanId: true, seasonMonthId: true, status: true },
    })) as { seasonPlanId: string; seasonMonthId: string; status: string }[];
    // Two month gates: `mpBucket` = months in a SELECTED bucket (period columns); `mpBaseline` = months in
    // a BASELINE bucket (Planned All Months). Both keyed by (seasonPlanId:monthId).
    const mpBucket = new Map<string, { bucket: StatusBucket; status: string }>();
    const mpBaseline = new Set<string>();
    for (const mp of monthlyPlans) {
      const b = bucketOfStatus(mp.status);
      if (!b) continue;
      const key = `${mp.seasonPlanId}:${mp.seasonMonthId}`;
      if (selected.has(b)) mpBucket.set(key, { bucket: b, status: mp.status });
      if (baselineBuckets.has(b)) mpBaseline.add(key);
    }

    if (mpBucket.size > 0 || mpBaseline.size > 0) {
      const planDealers = (await prisma.planDealer.findMany({
        where: { seasonPlanId: { in: allPlanIds }, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
        select: {
          seasonPlanId: true,
          dealer: { select: { id: true, name: true } },
          lines: {
            select: {
              productId: true,
              rateSnapshot: true,
              nbvPercentSnapshot: true,
              product: { select: { name: true, technicalName: true, rate: true, nbvPercent: true } },
              monthlyEntries: { select: { seasonMonthId: true, planQty: true, saleQty: true, planValue: true, saleValue: true } },
            },
          },
        },
      })) as {
        seasonPlanId: string;
        dealer: { id: string; name: string };
        lines: {
          productId: string;
          rateSnapshot: unknown;
          nbvPercentSnapshot: unknown;
          product: { name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown };
          monthlyEntries: { seasonMonthId: string; planQty: number; saleQty: number; planValue: unknown; saleValue: unknown }[];
        }[];
      }[];

      for (const pd of planDealers) {
        const plan = planById.get(pd.seasonPlanId);
        if (!plan) continue;
        for (const l of pd.lines) {
          const row = ensureRow(l);
          // Snapshot-first pricing (frozen on the line) with live-Master fallback.
          const rate = num(l.rateSnapshot ?? l.product.rate);
          const nbvPct = num(l.nbvPercentSnapshot ?? l.product.nbvPercent);
          for (const e of l.monthlyEntries) {
            const key = `${pd.seasonPlanId}:${e.seasonMonthId}`;
            const inBaseline = mpBaseline.has(key);
            const mp = mpBucket.get(key);
            if (!inBaseline && !mp) continue; // this month is in neither the baseline nor a selected bucket
            const planInput = valueMonthly ? num(e.planValue ?? 0) : e.planQty;
            const fig = figuresForMode(monthlyMode, planInput, rate, nbvPct);
            // Planned (All Months) baseline — qty + amount — every baseline-gated month, always.
            if (inBaseline) {
              row.plannedAllMonths += fig.totalQty ?? 0;
              row.plannedAllMonthsAmount += fig.amount ?? 0;
            }
            // Period columns (Month/Range view) — only the SELECTED months in a selected bucket.
            if (mp && !isTotal && selectedMonthSet.has(e.seasonMonthId)) {
              const sold = num(e.saleValue ?? 0);
              row.actual.qty += e.saleQty;
              row.actual.amount += sold;
              row.actual.nbv += calcNbv(sold, nbvPct);
              addContribution(row, {
                bucket: mp.bucket, officerId: plan.officerId, officerName: officerName.get(plan.officerId) ?? plan.officerId,
                dealerId: pd.dealer.id, dealerName: pd.dealer.name, planId: plan.id, planType: "MONTHLY",
                version: plan.version, status: mp.status, monthId: e.seasonMonthId, monthName: monthNameById.get(e.seasonMonthId) ?? null,
                qty: fig.totalQty ?? 0, amount: fig.amount ?? 0, nbv: fig.nbv ?? 0,
              });
            }
          }
        }
      }
    }
  }

  // Derived Season Baseline columns (qty + amount) — reuse the app's conceptual definitions.
  for (const row of productRows.values()) {
    row.remaining = row.seasonQty - row.plannedAllMonths;
    row.pendingSales = row.seasonQty - row.seasonSales;
    row.remainingAmount = row.seasonAmount - row.plannedAllMonthsAmount;
    row.pendingAmount = row.seasonAmount - row.seasonSalesAmount;
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

  // Annotate clearance (group-specific, by groupId + productId) — display-only.
  const clearance = await clearanceMapForGroup(groupId);
  for (const row of productRows.values()) {
    const c = clearance.get(row.productId);
    if (c) { row.isClearance = true; row.clearanceQty = c.clearanceQty; }
  }

  // Season-stable ordering so products don't disappear/reorder when only the period selection changes.
  const products = [...productRows.values()].sort((a, b) => b.seasonQty - a.seasonQty || b.total.amount - a.total.amount);
  return { ...base, officers: officerBreakdown, products };
}
