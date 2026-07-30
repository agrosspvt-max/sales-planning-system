import "server-only";
import { PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertOfficerInScope } from "@/lib/scope";
import {
  computeFacts,
  sumFacts,
  groupFacts,
  monthlyRowsFromFacts,
  type Fact,
} from "@/features/reports/service.server";
import { getCurrentSeason } from "@/features/dashboard/service.server";
import { getSeasonMonthStates } from "@/features/planning/planning-state.server";
import { achievement, remaining, type PlanningMode } from "@/lib/calc";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { withProfileContext } from "@/features/navigation/profile-context";
import type { DealerProfile, PerfRow, QuickAction } from "./types";

type SeasonRow = { id: string; name: string; year: number; monthlyMode: string };

const qty = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/**
 * Dealer Profile — assembled from the SAME fact engine as every other profile:
 * computeFacts() → groupFacts()/monthlyRowsFromFacts() → reusable widgets. No new
 * calculation. Scope is enforced via the dealer's current Sales Officer.
 */
export async function getDealerProfile(
  ctx: AuthContext,
  dealerId: string,
  seasonId?: string,
): Promise<DealerProfile> {
  const dealer = await prisma.dealer.findUnique({
    where: { id: dealerId },
    select: { id: true, name: true, town: true, isActive: true },
  });
  if (!dealer) throw new ApiError(404, "Dealer not found");

  // Current Sales Officer (open-ended assignment) governs who may view this dealer.
  const assignment = await prisma.dealerAssignment.findFirst({
    where: { dealerId, effectiveTo: null },
    include: { officer: { select: { id: true, name: true } } },
  });
  const officerId = assignment?.officer.id ?? null;
  if (officerId) await assertOfficerInScope(ctx, officerId);
  else if (!(await isSuperAdmin(ctx))) throw new ApiError(403, "This dealer is not in your scope");

  const rm = officerId
    ? await prisma.rmAssignment.findFirst({
        where: { officerId, effectiveTo: null },
        include: { manager: { select: { name: true } } },
      })
    : null;

  const season: SeasonRow | null = seasonId
    ? ((await prisma.season.findUnique({ where: { id: seasonId } })) as SeasonRow | null)
    : await getCurrentSeason();
  if (!season) throw new ApiError(404, "No season available");

  const [allFacts, months, activePlan] = await Promise.all([
    computeFacts(ctx, season.id),
    getSeasonMonthStates(season.id),
    officerId
      ? prisma.seasonPlan.findFirst({
          where: { seasonId: season.id, officerId, isActiveVersion: true },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  const dealerFacts: Fact[] = allFacts.filter((f) => f.dealerId === dealerId);
  const officerFacts: Fact[] = officerId ? allFacts.filter((f) => f.officerId === officerId) : dealerFacts;

  const totals = sumFacts(dealerFacts);
  const products: PerfRow[] = groupFacts(dealerFacts, (f) => f.productId, (f) => f.productName)
    .sort((a, b) => b.actualAmount - a.actualAmount)
    .map((g) => ({
      id: g.id,
      label: g.label,
      planQty: g.planQty,
      actualQty: g.actualQty,
      pendingQty: g.pendingQty,
      planAmount: g.planAmount,
      actualAmount: g.actualAmount,
      achievementAmount: g.achievementAmount,
      planNbv: g.planNbv,
      actualNbv: g.actualNbv,
    }));

  const monthly = monthlyRowsFromFacts(dealerFacts, months, season.monthlyMode as PlanningMode).map((r) => ({
    id: r.id,
    label: r.label as string,
    plan: r.planQty as number,
    actual: r.saleQty as number,
    achievement: r.progress as number,
  }));

  // Contribution + rank within the officer's dealers (reuse the same grouping).
  const officerDealers = groupFacts(officerFacts, (f) => f.dealerId, (f) => f.dealerName).sort(
    (a, b) => b.planAmount - a.planAmount,
  );
  const officerPlanAmount = officerDealers.reduce((s, d) => s + d.planAmount, 0);
  const rankIdx = officerDealers.findIndex((d) => d.id === dealerId);

  const openMonths = months.filter((m) => m.status === "OPEN");

  // Carry the originating dealer profile into every child page (Back + breadcrumb context).
  const origin = { href: `/masters/dealers/${dealerId}`, label: dealer.name, kind: "dealer" as const };
  const quickActions: QuickAction[] = [
    activePlan
      ? { label: "View Planning", href: withProfileContext(`/planning/${activePlan.id}`, origin, "Current Seasonal Plan"), variant: "default" }
      : { label: "View Planning", href: "#", disabled: true },
    activePlan
      ? { label: "Monthly Planning", href: withProfileContext(`/planning/${activePlan.id}?tab=monthly`, origin, "Monthly Planning") }
      : { label: "Monthly Planning", href: "#", disabled: true },
    { label: "Product Summary", href: withProfileContext("/planning/sales/product-summary", origin, "Product Summary") },
    { label: "Export Dealer Report", href: `/api/reports/export?type=product&season=${season.id}&dealer=${dealerId}`, external: true },
    activePlan
      ? { label: "History", href: withProfileContext(`/planning/${activePlan.id}?tab=history`, origin, "History") }
      : { label: "History", href: withProfileContext("/masters/import-history", origin, "History") },
  ];

  return {
    header: {
      id: dealer.id,
      name: dealer.name,
      salesOfficer: assignment?.officer.name ?? "Unassigned",
      regionalManager: rm?.manager.name ?? "—",
      territory: dealer.town ?? "—",
      status: dealer.isActive ? "Active" : "Inactive",
      seasonName: `${season.name} ${season.year}`,
    },
    season: { id: season.id, name: `${season.name} ${season.year}` },
    quickActions,
    kpis: [
      { label: "Season Target", value: formatCurrency(totals.planAmount), hint: `${qty(totals.planQty)} qty` },
      { label: "Actual Sales", value: formatCurrency(totals.actualAmount), hint: `${qty(totals.actualQty)} qty` },
      { label: "Achievement", value: formatPercent(achievement(totals.actualAmount, totals.planAmount)) },
      { label: "NBV", value: formatCurrency(totals.planNbv), hint: `Actual ${formatCurrency(totals.actualNbv)}` },
      { label: "Pending", value: qty(Math.max(0, totals.planQty - totals.actualQty)) },
      { label: "Remaining", value: formatCurrency(remaining(totals.planAmount, totals.actualAmount)) },
      { label: "Current Month", value: openMonths.length ? openMonths.map((m) => m.name).join(", ") : "None open" },
    ],
    products,
    monthly,
    contribution: {
      sharePct: officerPlanAmount > 0 ? totals.planAmount / officerPlanAmount : 0,
      rank: rankIdx >= 0 ? rankIdx + 1 : officerDealers.length,
      totalDealers: officerDealers.length,
      officerName: assignment?.officer.name ?? "—",
      officerId: officerId ?? "",
      dealerPlanAmount: totals.planAmount,
      officerPlanAmount,
    },
  };
}

async function isSuperAdmin(ctx: AuthContext): Promise<boolean> {
  return ctx.role === "SUPER_ADMIN";
}
