import "server-only";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertOfficerInScope, getCurrentDealerIds } from "@/lib/scope";
import {
  computeFacts,
  sumFacts,
  groupFacts,
  monthlyRowsFromFacts,
  type Fact,
  type GroupedFact,
} from "@/features/reports/service.server";
import { getCurrentSeason } from "@/features/dashboard/service.server";
import { getSeasonMonthStates } from "@/features/planning/planning-state.server";
import { achievement, remaining, type PlanningMode } from "@/lib/calc";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { withProfileContext } from "@/features/navigation/profile-context";
import type { OfficerProfile, PerfRow, QuickAction, RankRowDTO } from "./types";

/** The season fields the profile needs (structural — works with the Prisma Season row). */
type SeasonRow = { id: string; name: string; year: number; monthlyMode: string };

const qty = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

function dealerHref(id: string) {
  return `/masters/dealers/${id}`;
}

function toPerfRow(g: GroupedFact, opts: { href?: string; status?: string } = {}): PerfRow {
  return {
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
    ...opts,
  };
}

function toRank(g: GroupedFact, href?: string): RankRowDTO {
  return { id: g.id, label: g.label, planAmount: g.planAmount, actualAmount: g.actualAmount, achievementAmount: g.achievementAmount, href };
}

const byActualDesc = (a: GroupedFact, b: GroupedFact) => b.actualAmount - a.actualAmount;
const byAchievementAsc = (a: GroupedFact, b: GroupedFact) => a.achievementAmount - b.achievementAmount;

/**
 * Assemble the Sales Officer Dashboard from the SAME business source the summaries use:
 * one computeFacts() call, reshaped via the shared aggregations. Permission is enforced
 * with the existing scope helper. No calculation is duplicated.
 */
export async function getOfficerProfile(
  ctx: AuthContext,
  officerId: string,
  seasonId?: string,
): Promise<OfficerProfile> {
  await assertOfficerInScope(ctx, officerId);

  const officer = await prisma.user.findUnique({
    where: { id: officerId },
    select: { id: true, name: true, role: true, isActive: true },
  });
  if (!officer) throw new ApiError(404, "User not found");

  const season: SeasonRow | null = seasonId
    ? ((await prisma.season.findUnique({ where: { id: seasonId } })) as SeasonRow | null)
    : await getCurrentSeason();
  if (!season) throw new ApiError(404, "No season available");

  // One fact query for this season, then filter to this officer.
  const [allFacts, assignments, rm, plans, months, imports, products] = await Promise.all([
    computeFacts(ctx, season.id),
    prisma.dealerAssignment.findMany({
      where: { officerId, effectiveTo: null },
      include: { dealer: { select: { id: true, name: true, town: true, isActive: true } } },
    }),
    prisma.rmAssignment.findFirst({
      where: { officerId, effectiveTo: null },
      include: { manager: { select: { name: true } } },
    }),
    prisma.seasonPlan.findMany({
      where: { seasonId: season.id, officerId },
      select: { id: true, status: true, version: true, versionName: true, source: true, isActiveVersion: true, lifecycleState: true, createdAt: true },
      orderBy: { version: "desc" },
    }),
    getSeasonMonthStates(season.id),
    prisma.seasonPlanImportRecord.findMany({
      where: { seasonId: season.id, officerId },
      orderBy: { createdAt: "desc" },
      select: { id: true, workbookName: true, status: true, dealerCount: true, productRows: true, createdAt: true },
    }),
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
  ]);

  const facts: Fact[] = allFacts.filter((f) => f.officerId === officerId);
  const totals = sumFacts(facts);

  // Dealer + product roll-ups (reused shared aggregation).
  const activeDealerById = new Map(assignments.map((a) => [a.dealer.id, a.dealer.isActive]));
  const dealerGroups = groupFacts(facts, (f) => f.dealerId, (f) => f.dealerName);
  const productGroups = groupFacts(facts, (f) => f.productId, (f) => f.productName);

  const dealers: PerfRow[] = dealerGroups
    .sort(byActualDesc)
    .map((g) => toPerfRow(g, { href: dealerHref(g.id), status: activeDealerById.get(g.id) === false ? "Inactive" : "Active" }));
  const productRows: PerfRow[] = productGroups.slice().sort(byActualDesc).map((g) => toPerfRow(g));

  const plannedProductIds = new Set(productGroups.map((g) => g.id));
  const productsNotPlanned = products.filter((p) => !plannedProductIds.has(p.id)).map((p) => p.name);

  const withPlan = (g: GroupedFact) => g.planAmount > 0;
  const topDealers = dealerGroups.slice().sort(byActualDesc).slice(0, 5).map((g) => toRank(g, dealerHref(g.id)));
  const lowestDealers = dealerGroups.filter(withPlan).sort(byAchievementAsc).slice(0, 5).map((g) => toRank(g, dealerHref(g.id)));
  const topProducts = productGroups.slice().sort(byActualDesc).slice(0, 5).map((g) => toRank(g));
  const lowestProducts = productGroups.filter(withPlan).sort(byAchievementAsc).slice(0, 5).map((g) => toRank(g));
  const highestSalesProducts = productGroups.slice().sort(byActualDesc).slice(0, 5).map((g) => toRank(g));
  const lowestAchievementProducts = productGroups.filter(withPlan).sort(byAchievementAsc).slice(0, 5).map((g) => toRank(g));

  // Monthly trend (mode-aware, via shared helper).
  const monthly = monthlyRowsFromFacts(facts, months, season.monthlyMode as PlanningMode).map((r) => ({
    id: r.id,
    label: r.label as string,
    plan: r.planQty as number,
    actual: r.saleQty as number,
    achievement: r.progress as number,
  }));

  // Plan / approval status. KPI counts exclude DEACTIVATED (archived) plans — like reports — so the
  // headline numbers reflect live planning, not archived versions. (Full history is kept below.)
  const livePlans = plans.filter((p) => (p.lifecycleState ?? "ACTIVE") !== "DEACTIVATED");
  const approvedPlans = livePlans.filter((p) => p.status === PlanStatus.APPROVED).length;
  const draftPlans = livePlans.filter((p) => p.status === PlanStatus.DRAFT).length;
  const rejectedPlans = livePlans.filter((p) => p.status === PlanStatus.REJECTED).length;
  const pendingPlans = livePlans.filter((p) => p.status === PlanStatus.PENDING_RM || p.status === PlanStatus.PENDING_ADMIN).length;
  const activePlan = livePlans.find((p) => p.isActiveVersion) ?? livePlans[0];
  const seasonalPlanStatus = activePlan ? statusLabel(activePlan.status) : "Not started";
  const openMonths = months.filter((m) => m.status === "OPEN");

  const planningStatus = activePlan
    ? activePlan.status === PlanStatus.APPROVED
      ? "Approved"
      : pendingPlans > 0
        ? "Pending approval"
        : statusLabel(activePlan.status)
    : "Not started";

  const territory = Array.from(new Set(assignments.map((a) => a.dealer.town).filter((t): t is string => !!t)));
  const activeDealers = assignments.filter((a) => a.dealer.isActive).length;

  // Every child page launched from this profile carries the originating context so it can
  // render "Back to Sales Officer Profile" and the correct breadcrumb (Issues 2–7).
  const origin = { href: `/masters/users/${officerId}`, label: officer.name, kind: "officer" as const };
  const quickActions: QuickAction[] = [
    { label: "Create Seasonal Plan", href: withProfileContext("/planning/sales", origin, "Create Seasonal Plan"), variant: "default" },
    // Manage ALL of this officer's plans (Seasonal / Monthly / Recovery, every status + lifecycle).
    { label: "Manage Plans", href: withProfileContext(`/masters/users/${officerId}/plans`, origin, "Manage Plans") },
    { label: "View Assigned Dealers", href: withProfileContext("/masters/dealers", origin, "Assigned Dealers") },
    { label: "Import Workbook", href: withProfileContext("/planning/sales/import", origin, "Import Workbook") },
    { label: "Export Report", href: `/api/reports/export?type=dealer&season=${season.id}&officer=${officerId}`, external: true },
    { label: "Pending Approvals", href: withProfileContext("/planning/approvals", origin, "Approvals") },
  ];

  // Approval history across this officer's plans this season.
  const approvals = plans.length
    ? await prisma.approvalAction.findMany({
        where: { seasonPlanId: { in: plans.map((p) => p.id) } },
        include: { actor: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    : [];

  return {
    header: {
      id: officer.id,
      name: officer.name,
      role: officer.role === Role.SALES_OFFICER ? "Sales Officer" : officer.role,
      territory: territory.length ? territory.join(", ") : "—",
      regionalManager: rm?.manager.name ?? "—",
      status: officer.isActive ? "Active" : "Inactive",
      seasonName: `${season.name} ${season.year}`,
      assignedDealers: assignments.length,
      planningStatus,
    },
    season: { id: season.id, name: `${season.name} ${season.year}` },
    quickActions,
    kpis: [
      { label: "Season Target Qty", value: qty(totals.planQty) },
      { label: "Season Target Amount", value: formatCurrency(totals.planAmount) },
      { label: "Actual Sales Qty", value: qty(totals.actualQty) },
      { label: "Actual Sales Amount", value: formatCurrency(totals.actualAmount) },
      { label: "Achievement %", value: formatPercent(achievement(totals.actualAmount, totals.planAmount)) },
      { label: "NBV", value: formatCurrency(totals.planNbv), hint: `Actual ${formatCurrency(totals.actualNbv)}` },
      { label: "Pending Qty", value: qty(Math.max(0, totals.planQty - totals.actualQty)) },
      { label: "Remaining Target", value: formatCurrency(remaining(totals.planAmount, totals.actualAmount)) },
      { label: "Current Planning Month", value: openMonths.length ? openMonths.map((m) => m.name).join(", ") : "None open" },
      { label: "Approved Plans", value: String(approvedPlans) },
      { label: "Draft Plans", value: String(draftPlans) },
      { label: "Dealer Count", value: String(assignments.length) },
      { label: "Active Dealers", value: String(activeDealers) },
    ],
    dealers,
    products: productRows,
    productsNotPlanned,
    topDealers,
    lowestDealers,
    topProducts,
    lowestProducts,
    highestSalesProducts,
    lowestAchievementProducts,
    monthly,
    approvals: {
      seasonalPlanStatus,
      monthlyPlansOpen: openMonths.length,
      pending: pendingPlans,
      approved: approvedPlans,
      rejected: rejectedPlans,
      draft: draftPlans,
    },
    history: {
      imports: imports.map((i) => ({
        id: i.id,
        workbookName: i.workbookName,
        status: i.status,
        dealerCount: i.dealerCount,
        productRows: i.productRows,
        createdAt: i.createdAt.toISOString(),
      })),
      revisions: plans.map((p) => ({
        id: p.id,
        version: p.version,
        versionName: p.versionName,
        status: p.status,
        source: p.source,
        createdAt: p.createdAt.toISOString(),
      })),
      approvals: approvals.map((a) => ({
        id: a.id,
        action: a.action,
        actorName: a.actor.name,
        fromStatus: a.fromStatus,
        toStatus: a.toStatus,
        remarks: a.remarks,
        createdAt: a.createdAt.toISOString(),
      })),
    },
  };
}

function statusLabel(s: PlanStatus): string {
  return {
    DRAFT: "Draft",
    PENDING_RM: "Pending RM",
    PENDING_ADMIN: "Pending Super Admin",
    APPROVED: "Approved",
    RETURNED: "Returned",
    REJECTED: "Rejected",
  }[s];
}
