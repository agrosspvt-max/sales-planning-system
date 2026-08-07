import "server-only";
import { PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { achievement, nbv, figuresForMode, isQuantityMode, pendingQty, type PlanningMode } from "@/lib/calc";
import type {
  ReportColumn,
  ReportFilters,
  ReportPayload,
  ReportRow,
  ReportSort,
  ReportType,
  RankRow,
} from "./types";

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

interface Fact {
  officerId: string;
  officerName: string;
  managerKey: string;
  managerName: string;
  dealerId: string;
  dealerName: string;
  productId: string;
  productName: string;
  brandName: string;
  categoryName: string;
  planQty: number;
  planAmount: number;
  planNbv: number;
  actualQty: number;
  actualAmount: number;
  actualNbv: number;
  monthly: {
    seasonMonthId: string;
    planQty: number;
    saleQty: number;
    planValue: number;
    saleValue: number;
    inputMode: PlanningMode | null;
  }[];
}

export type { Fact };

export async function computeFacts(ctx: AuthContext, seasonId: string): Promise<Fact[]> {
  const scope = await getOfficerScope(ctx);
  const plans = await prisma.seasonPlan.findMany({
    where: {
      seasonId,
      status: PlanStatus.APPROVED,
      isActiveVersion: true,
      // Reports include ACTIVE and CLOSED (frozen) plans; DEACTIVATED (archived) plans are excluded.
      lifecycleState: { not: "DEACTIVATED" },
      officerId: scope.all ? undefined : { in: scope.ids },
    },
    include: {
      officer: { select: { id: true, name: true } },
      dealers: {
        include: {
          dealer: { select: { name: true } },
          lines: {
            include: {
              product: {
                select: { name: true, rate: true, nbvPercent: true, brand: { select: { name: true } }, category: { select: { name: true } } },
              },
              packs: { select: { quantity: true } },
              monthlyEntries: {
                select: {
                  seasonMonthId: true,
                  planQty: true,
                  saleQty: true,
                  planValue: true,
                  saleValue: true,
                  inputMode: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const officerIds = plans.map((p) => p.officerId);
  const rmRows = await prisma.rmAssignment.findMany({
    where: { officerId: { in: officerIds }, effectiveTo: null },
    include: { manager: { select: { id: true, name: true } } },
  });
  const rmByOfficer = new Map(rmRows.map((r) => [r.officerId, r.manager]));

  const facts: Fact[] = [];
  for (const plan of plans) {
    const rm = rmByOfficer.get(plan.officerId) as { id: string; name: string } | undefined;
    for (const pd of plan.dealers) {
      for (const l of pd.lines) {
        // All planning calculations use the current Product Master values.
        const rate = num(l.product.rate);
        const nbvPct = num(l.product.nbvPercent);

        // Planned figures come from the line's OWN seasonal mode (null => PACK_SIZE),
        // via the centralized calc — so amount/NBV are correct in every mode.
        const seasonalMode: PlanningMode = (l.inputMode as PlanningMode | null) ?? "PACK_SIZE";
        const seasonalInput =
          seasonalMode === "PACK_SIZE"
            ? l.packs.reduce((s, pk) => s + pk.quantity, 0)
            : l.inputValue !== null
              ? num(l.inputValue)
              : 0;
        const pf = figuresForMode(seasonalMode, seasonalInput, rate, nbvPct);
        const planQty = pf.totalQty ?? 0;
        const planAmount = pf.amount ?? 0;
        const planNbv = pf.nbv ?? 0;

        // Actuals from monthly sales, honouring each entry's own mode.
        let actualQty = 0;
        let actualAmount = 0;
        let actualNbv = 0;
        const monthly = l.monthlyEntries.map((e) => {
          const eMode: PlanningMode = (e.inputMode as PlanningMode | null) ?? "PACK_SIZE";
          const planValue = num(e.planValue ?? 0);
          const saleValue = num(e.saleValue ?? 0);
          if (isQuantityMode(eMode)) {
            actualQty += e.saleQty;
            actualAmount += saleValue;
            actualNbv += nbv(saleValue, nbvPct);
          } else if (eMode === "AMOUNT") {
            actualAmount += saleValue;
            actualNbv += nbv(saleValue, nbvPct);
          } else {
            actualNbv += saleValue;
            actualAmount += nbvPct > 0 ? saleValue / nbvPct : 0;
          }
          return {
            seasonMonthId: e.seasonMonthId,
            planQty: e.planQty,
            saleQty: e.saleQty,
            planValue,
            saleValue,
            inputMode: e.inputMode as PlanningMode | null,
          };
        });

        facts.push({
          officerId: plan.officerId,
          officerName: plan.officer.name,
          managerKey: rm?.id ?? "__direct__",
          managerName: rm?.name ?? "Direct to Super Admin",
          dealerId: pd.dealerId,
          dealerName: pd.dealer.name,
          productId: l.productId,
          productName: l.product.name,
          brandName: l.product.brand?.name ?? "—",
          categoryName: l.product.category?.name ?? "—",
          planQty,
          planAmount,
          planNbv,
          actualQty,
          actualAmount,
          actualNbv,
          monthly,
        });
      }
    }
  }
  return facts;
}

/* ----------------- reusable aggregations over Fact[] (shared) --------------- *
 * These are pure roll-ups over the figures already computed by computeFacts — no
 * business calculation is repeated here. The profile dashboards (Sales Officer, Dealer)
 * reuse them so every screen aggregates from the one fact engine.
 */

export interface FactTotals {
  planQty: number;
  actualQty: number;
  planAmount: number;
  actualAmount: number;
  planNbv: number;
  actualNbv: number;
}

const ZERO_TOTALS = (): FactTotals => ({
  planQty: 0,
  actualQty: 0,
  planAmount: 0,
  actualAmount: 0,
  planNbv: 0,
  actualNbv: 0,
});

/** Sum a set of facts into a single totals object. */
export function sumFacts(facts: Fact[]): FactTotals {
  const t = ZERO_TOTALS();
  for (const f of facts) {
    t.planQty += f.planQty;
    t.actualQty += f.actualQty;
    t.planAmount += f.planAmount;
    t.actualAmount += f.actualAmount;
    t.planNbv += f.planNbv;
    t.actualNbv += f.actualNbv;
  }
  return t;
}

export interface GroupedFact extends FactTotals {
  id: string;
  label: string;
  achievementAmount: number;
  achievementNbv: number;
  pendingQty: number;
}

/** Group facts by an arbitrary key (dealer, product, month, officer…) with derived ratios. */
export function groupFacts(
  facts: Fact[],
  keyFn: (f: Fact) => string,
  labelFn: (f: Fact) => string,
): GroupedFact[] {
  const map = new Map<string, GroupedFact>();
  for (const f of facts) {
    const k = keyFn(f);
    const g =
      map.get(k) ??
      ({ id: k, label: labelFn(f), ...ZERO_TOTALS(), achievementAmount: 0, achievementNbv: 0, pendingQty: 0 } as GroupedFact);
    g.planQty += f.planQty;
    g.actualQty += f.actualQty;
    g.planAmount += f.planAmount;
    g.actualAmount += f.actualAmount;
    g.planNbv += f.planNbv;
    g.actualNbv += f.actualNbv;
    map.set(k, g);
  }
  const rows = Array.from(map.values());
  for (const r of rows) {
    r.achievementAmount = achievement(r.actualAmount, r.planAmount);
    r.achievementNbv = achievement(r.actualNbv, r.planNbv);
    r.pendingQty = pendingQty(r.planQty, r.actualQty);
  }
  return rows;
}

/** Month-wise plan/actual rows honouring the season's monthly mode (qty vs value). */
export function monthlyRowsFromFacts(
  facts: Fact[],
  months: { id: string; name: string }[],
  monthlyMode: PlanningMode,
): ReportRow[] {
  const qtyMode = isQuantityMode(monthlyMode);
  return months.map((m) => {
    let planQty = 0;
    let saleQty = 0;
    for (const f of facts)
      for (const e of f.monthly)
        if (e.seasonMonthId === m.id) {
          planQty += qtyMode ? e.planQty : e.planValue;
          saleQty += qtyMode ? e.saleQty : e.saleValue;
        }
    return { id: m.id, label: m.name, planQty, saleQty, progress: achievement(saleQty, planQty) };
  });
}

function applyFilters(facts: Fact[], f: ReportFilters): Fact[] {
  return facts.filter(
    (x) =>
      (!f.manager || x.managerKey === f.manager) &&
      (!f.officer || x.officerId === f.officer) &&
      (!f.dealer || x.dealerId === f.dealer) &&
      (!f.brand || x.brandName === f.brand) &&
      (!f.category || x.categoryName === f.category),
  );
}

function groupRows(facts: Fact[], keyFn: (f: Fact) => string, labelFn: (f: Fact) => string): ReportRow[] {
  const map = new Map<string, ReportRow>();
  for (const f of facts) {
    const k = keyFn(f);
    const row =
      map.get(k) ??
      ({
        id: k,
        label: labelFn(f),
        planQty: 0,
        planAmount: 0,
        actualAmount: 0,
        planNbv: 0,
        actualNbv: 0,
        achievementAmount: 0,
        achievementNbv: 0,
      } as ReportRow);
    row.planQty = (row.planQty as number) + f.planQty;
    row.planAmount = (row.planAmount as number) + f.planAmount;
    row.actualAmount = (row.actualAmount as number) + f.actualAmount;
    row.planNbv = (row.planNbv as number) + f.planNbv;
    row.actualNbv = (row.actualNbv as number) + f.actualNbv;
    map.set(k, row);
  }
  const rows = Array.from(map.values());
  for (const r of rows) {
    r.achievementAmount = achievement(r.actualAmount as number, r.planAmount as number);
    r.achievementNbv = achievement(r.actualNbv as number, r.planNbv as number);
  }
  return rows;
}

/** Compact grouping used by the dashboard (top/lowest lists). */
export function groupSummary(
  facts: Fact[],
  keyFn: (f: Fact) => string,
  labelFn: (f: Fact) => string,
): RankRow[] {
  return groupRows(facts, keyFn, labelFn).map((r) => ({
    id: r.id,
    label: r.label as string,
    planAmount: r.planAmount as number,
    actualAmount: r.actualAmount as number,
    achievementAmount: r.achievementAmount as number,
  }));
}

const TITLES: Record<ReportType, string> = {
  product: "Product Summary",
  brand: "Brand Summary",
  category: "Category Summary",
  dealer: "Dealer Summary",
  officer: "Sales Officer Summary",
  regional: "Regional Manager Summary",
  company: "Company Summary",
  season: "Seasonal Summary",
  monthly: "Monthly Summary",
};

const NAME_LABEL: Record<ReportType, string> = {
  product: "Product",
  brand: "Brand",
  category: "Category",
  dealer: "Dealer",
  officer: "Sales Officer",
  regional: "Regional Manager",
  company: "Total",
  season: "Total",
  monthly: "Month",
};

const DRILL_CHILD: Record<ReportType, ReportType | null> = {
  company: "regional",
  regional: "officer",
  officer: "dealer",
  dealer: "product",
  brand: "product",
  category: "product",
  product: null,
  season: null,
  monthly: null,
};

function summaryColumns(nameLabel: string): ReportColumn[] {
  return [
    { key: "label", label: nameLabel, format: "text" },
    { key: "planQty", label: "Plan Qty", format: "number" },
    { key: "planAmount", label: "Plan Amount", format: "currency" },
    { key: "actualAmount", label: "Actual Amount", format: "currency" },
    { key: "achievementAmount", label: "Achv % (Amt)", format: "percent" },
    { key: "planNbv", label: "Plan NBV", format: "currency" },
    { key: "actualNbv", label: "Actual NBV", format: "currency" },
    { key: "achievementNbv", label: "Achv % (NBV)", format: "percent" },
  ];
}

/** Monthly report columns adapt to the configured monthly unit. */
function monthlyColumns(mode: PlanningMode): ReportColumn[] {
  const qty = isQuantityMode(mode);
  const fmt = qty ? "number" : "currency";
  return [
    { key: "label", label: "Month", format: "text" },
    { key: "planQty", label: qty ? "Planned Qty" : "Planned", format: fmt },
    { key: "saleQty", label: qty ? "Sold Qty" : "Actual", format: fmt },
    { key: "progress", label: "Progress", format: "percent" },
  ];
}

function sortRows(rows: ReportRow[], sort: ReportSort): ReportRow[] {
  const { key, dir } = sort;
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}

function filterLabels(all: Fact[], f: ReportFilters): string[] {
  const labels: string[] = [];
  if (f.officer) labels.push(`Sales Officer: ${all.find((x) => x.officerId === f.officer)?.officerName ?? f.officer}`);
  if (f.manager) labels.push(`Regional Manager: ${all.find((x) => x.managerKey === f.manager)?.managerName ?? f.manager}`);
  if (f.dealer) labels.push(`Dealer: ${all.find((x) => x.dealerId === f.dealer)?.dealerName ?? f.dealer}`);
  if (f.brand) labels.push(`Brand: ${f.brand}`);
  if (f.category) labels.push(`Category: ${f.category}`);
  return labels;
}

export async function getReport(
  ctx: AuthContext,
  seasonId: string,
  type: ReportType,
  opts: { filters?: ReportFilters; sort?: ReportSort } = {},
): Promise<ReportPayload> {
  if (!seasonId) throw new ApiError(422, "A season is required");
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { name: true, year: true, monthlyMode: true },
  });
  const seasonName = season ? `${season.name} ${season.year}` : "";

  const allFacts = await computeFacts(ctx, seasonId);
  const filters = opts.filters ?? {};
  const facts = applyFilters(allFacts, filters);

  if (type === "monthly") {
    // Use the mode saved on THIS season, never the current global default.
    const monthlyMode = (season?.monthlyMode ?? "PACK_SIZE") as PlanningMode;
    const months = await prisma.seasonMonth.findMany({ where: { seasonId }, orderBy: { order: "asc" } });
    let rows: ReportRow[] = monthlyRowsFromFacts(facts, months, monthlyMode);
    const sort = opts.sort ?? { key: "label", dir: "asc" };
    if (opts.sort) rows = sortRows(rows, sort);
    const totals = {
      planQty: rows.reduce((a, r) => a + (r.planQty as number), 0),
      saleQty: rows.reduce((a, r) => a + (r.saleQty as number), 0),
      progress: 0,
    };
    totals.progress = achievement(totals.saleQty, totals.planQty);
    return {
      type,
      kind: "monthly",
      title: TITLES[type],
      columns: monthlyColumns(monthlyMode),
      rows,
      totals,
      drillChild: null,
      meta: { seasonName, filters: filterLabels(allFacts, filters) },
      sort,
    };
  }

  const keyFor: Record<string, (f: Fact) => string> = {
    product: (f) => f.productId,
    brand: (f) => f.brandName,
    category: (f) => f.categoryName,
    dealer: (f) => f.dealerId,
    officer: (f) => f.officerId,
    regional: (f) => f.managerKey,
    company: () => "all",
    season: () => "all",
  };
  const labelFor: Record<string, (f: Fact) => string> = {
    product: (f) => f.productName,
    brand: (f) => f.brandName,
    category: (f) => f.categoryName,
    dealer: (f) => f.dealerName,
    officer: (f) => f.officerName,
    regional: (f) => f.managerName,
    company: () => "Total",
    season: () => "Total",
  };

  let rows = groupRows(facts, keyFor[type], labelFor[type]);
  const sort = opts.sort ?? { key: "planAmount", dir: "desc" };
  rows = sortRows(rows, sort);

  const totals = {
    planQty: rows.reduce((a, r) => a + (r.planQty as number), 0),
    planAmount: rows.reduce((a, r) => a + (r.planAmount as number), 0),
    actualAmount: rows.reduce((a, r) => a + (r.actualAmount as number), 0),
    planNbv: rows.reduce((a, r) => a + (r.planNbv as number), 0),
    actualNbv: rows.reduce((a, r) => a + (r.actualNbv as number), 0),
    achievementAmount: 0,
    achievementNbv: 0,
  };
  totals.achievementAmount = achievement(totals.actualAmount, totals.planAmount);
  totals.achievementNbv = achievement(totals.actualNbv, totals.planNbv);

  return {
    type,
    kind: "summary",
    title: TITLES[type],
    columns: summaryColumns(NAME_LABEL[type]),
    rows,
    totals,
    drillChild: DRILL_CHILD[type],
    meta: { seasonName, filters: filterLabels(allFacts, filters) },
    sort,
  };
}
