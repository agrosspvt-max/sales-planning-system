import "server-only";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { figuresForMode, amount as calcAmount, nbv as calcNbv, isQuantityMode, type PlanningMode } from "@/lib/calc";

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

/**
 * Territory (Group) Product Plan — READ-ONLY analytics. It aggregates the EXISTING approved seasonal
 * plans (and their monthly entries / actual sales) of every Sales Officer in a group, using the SAME
 * mode-aware calc engine (`figuresForMode` / `amount` / `nbv`) as the per-officer Product Plan. It
 * introduces no new formulas and never writes. Each value is SUM(over every officer in the group).
 */
export interface GroupProductRow {
  productId: string;
  productName: string;
  technicalName: string | null;
  rate: number;
  nbvPercent: number;
  packSums: Record<string, number>;
  // Seasonal-total planned figures (per line's own seasonal mode), summed across the group.
  seasonalQty: number;
  seasonalAmount: number;
  seasonalNbv: number;
  // Actual sales (all months), summed across the group.
  actualQty: number;
  actualAmount: number;
  actualNbv: number;
  // Per-month plan/sale INPUTS (in the season's monthly unit) for the Specific-Month / Month-Range views.
  monthly: Record<string, { planInput: number; saleInput: number; saleAmount: number }>;
}
export interface GroupProductPlan {
  groupName: string;
  seasonName: string;
  monthlyMode: PlanningMode;
  seasonalMode: PlanningMode;
  officerCount: number;
  planCount: number;
  months: { id: string; name: string; order: number }[];
  packSizes: { id: string; name: string }[];
  products: GroupProductRow[];
}

type PlanDealerLineRow = {
  lines: {
    productId: string;
    inputMode: string | null;
    inputValue: unknown;
    product: { name: string; technicalName: string | null; rate: unknown; nbvPercent: unknown };
    packs: { packSizeId: string; quantity: number }[];
    monthlyEntries: { seasonMonthId: string; planQty: number; saleQty: number; planValue: unknown; saleValue: unknown }[];
  }[];
};

export async function getGroupProductPlan(ctx: AuthContext, groupId: string, seasonId: string): Promise<GroupProductPlan> {
  if (ctx.role !== Role.SUPER_ADMIN && ctx.role !== Role.REGIONAL_MANAGER) {
    throw new ApiError(403, "Only an admin or manager can view group planning");
  }

  const [group, season, packSizes] = await Promise.all([
    prisma.userGroup.findUnique({ where: { id: groupId }, select: { name: true } }),
    prisma.season.findUnique({
      where: { id: seasonId },
      select: { name: true, year: true, seasonalMode: true, monthlyMode: true, months: { orderBy: { order: "asc" }, select: { id: true, name: true, order: true } } },
    }),
    prisma.packSize.findMany({ where: { isActive: true, isPlanning: true }, orderBy: { displayOrder: "asc" }, select: { id: true, name: true } }),
  ]) as [
    { name: string } | null,
    { name: string; year: number; seasonalMode: string | null; monthlyMode: string | null; months: { id: string; name: string; order: number }[] } | null,
    { id: string; name: string }[],
  ];
  if (!group) throw new ApiError(404, "Group not found");
  if (!season) throw new ApiError(404, "Season not found");

  const monthlyMode = (season.monthlyMode ?? "PACK_SIZE") as PlanningMode;
  const seasonalMode = (season.seasonalMode ?? "PACK_SIZE") as PlanningMode;
  const base = { groupName: group.name, seasonName: `${season.name} ${season.year}`, monthlyMode, seasonalMode, months: season.months, packSizes };

  const officers = (await prisma.user.findMany({ where: { groupId, role: Role.SALES_OFFICER, isActive: true }, select: { id: true } })) as { id: string }[];
  const officerIds = officers.map((o) => o.id);
  if (officerIds.length === 0) return { ...base, officerCount: 0, planCount: 0, products: [] };

  // The active, approved SEASONAL plan of each officer in this season (the same plans Product Plan uses).
  const plans = (await prisma.seasonPlan.findMany({
    where: { seasonId, officerId: { in: officerIds }, planningType: "SEASONAL", status: PlanStatus.APPROVED, isActiveVersion: true, lifecycleState: "ACTIVE" },
    select: { id: true },
  })) as { id: string }[];
  const planIds = plans.map((p) => p.id);
  if (planIds.length === 0) return { ...base, officerCount: officerIds.length, planCount: 0, products: [] };

  const planDealers = (await prisma.planDealer.findMany({
    where: { seasonPlanId: { in: planIds }, dealer: { isActive: true } },
    select: {
      lines: {
        select: {
          productId: true,
          inputMode: true,
          inputValue: true,
          product: { select: { name: true, technicalName: true, rate: true, nbvPercent: true } },
          packs: { select: { packSizeId: true, quantity: true } },
          monthlyEntries: { select: { seasonMonthId: true, planQty: true, saleQty: true, planValue: true, saleValue: true } },
        },
      },
    },
  })) as PlanDealerLineRow[];

  const valueMonthly = !isQuantityMode(monthlyMode);
  const byProduct = new Map<string, GroupProductRow>();
  for (const pd of planDealers) {
    for (const l of pd.lines) {
      let row = byProduct.get(l.productId);
      if (!row) {
        row = {
          productId: l.productId,
          productName: l.product.name,
          technicalName: l.product.technicalName,
          rate: num(l.product.rate),
          nbvPercent: num(l.product.nbvPercent),
          packSums: {},
          seasonalQty: 0, seasonalAmount: 0, seasonalNbv: 0,
          actualQty: 0, actualAmount: 0, actualNbv: 0,
          monthly: {},
        };
        byProduct.set(l.productId, row);
      }
      const { rate, nbvPercent } = row;
      // Seasonal planned figures — each line re-expressed in its own stored seasonal mode.
      const lineSeasonalMode = (l.inputMode as PlanningMode | null) ?? "PACK_SIZE";
      const seasonalInput = lineSeasonalMode === "PACK_SIZE" ? l.packs.reduce((s, pk) => s + pk.quantity, 0) : l.inputValue !== null ? num(l.inputValue) : 0;
      const fig = figuresForMode(lineSeasonalMode, seasonalInput, rate, nbvPercent);
      row.seasonalQty += fig.totalQty ?? 0;
      row.seasonalAmount += fig.amount ?? 0;
      row.seasonalNbv += fig.nbv ?? 0;
      for (const pk of l.packs) row.packSums[pk.packSizeId] = (row.packSums[pk.packSizeId] ?? 0) + pk.quantity;
      // Actuals (seasonal total across all months) + per-month plan/sale inputs.
      for (const e of l.monthlyEntries) {
        const saleAmt = num(e.saleValue ?? 0) || calcAmount(e.saleQty, rate);
        row.actualQty += e.saleQty;
        row.actualAmount += saleAmt;
        row.actualNbv += calcNbv(saleAmt, nbvPercent);
        const planInput = valueMonthly ? num(e.planValue ?? 0) : e.planQty;
        const saleInput = valueMonthly ? num(e.saleValue ?? 0) : e.saleQty;
        const m = row.monthly[e.seasonMonthId] ?? { planInput: 0, saleInput: 0, saleAmount: 0 };
        m.planInput += planInput;
        m.saleInput += saleInput;
        m.saleAmount += saleAmt;
        row.monthly[e.seasonMonthId] = m;
      }
    }
  }

  const products = [...byProduct.values()].sort((a, b) => b.seasonalAmount - a.seasonalAmount);
  return { ...base, officerCount: officerIds.length, planCount: planIds.length, products };
}
