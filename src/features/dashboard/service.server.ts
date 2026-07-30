import "server-only";
import { Role, SeasonStatus, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { getCurrentDealerIds, getOfficerScope } from "@/lib/scope";
import { computeFacts, groupSummary } from "@/features/reports/service.server";
import { getApprovalsInbox } from "@/features/planning/service.server";
import { getSeasonMonthStates } from "@/features/planning/planning-state.server";
import { achievement } from "@/lib/calc";
import type { RankRow } from "@/features/reports/types";

export interface DashboardCard {
  label: string;
  value: string;
}

export interface DashboardData {
  seasonName: string | null;
  cards: DashboardCard[];
  topProducts?: RankRow[];
  topDealers?: RankRow[];
  lowestDealers?: RankRow[];
}

/**
 * The season the dashboard reports on.
 *
 * The dashboard aggregates the SAME business source as the Season/Product/Dealer summaries
 * (`computeFacts`, which only counts APPROVED + active plans). So it must first pick the
 * season that actually holds such a plan — otherwise it can land on a newer, empty OPEN
 * season and report ₹0 while an approved, active (e.g. imported) plan exists elsewhere.
 * Falls back to the previous heuristic (most recent OPEN, else most recent overall) only
 * when no approved active plan exists yet.
 */
export async function getCurrentSeason() {
  const withActivePlan = await prisma.seasonPlan.findFirst({
    where: { status: PlanStatus.APPROVED, isActiveVersion: true },
    orderBy: [{ approvedAt: "desc" }, { createdAt: "desc" }],
    select: { season: true },
  });
  if (withActivePlan?.season) return withActivePlan.season;

  const open = await prisma.season.findFirst({
    where: { status: SeasonStatus.OPEN },
    orderBy: [{ year: "desc" }, { createdAt: "desc" }],
  });
  if (open) return open;
  return prisma.season.findFirst({ orderBy: [{ year: "desc" }, { createdAt: "desc" }] });
}

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const pct = (f: number) => `${(f * 100).toFixed(0)}%`;

export async function getDashboard(ctx: AuthContext): Promise<DashboardData> {
  const season = await getCurrentSeason();
  if (!season) return { seasonName: null, cards: [] };

  const facts = await computeFacts(ctx, season.id);
  const planAmount = facts.reduce((a, f) => a + f.planAmount, 0);
  const actualAmount = facts.reduce((a, f) => a + f.actualAmount, 0);
  const seasonName = `${season.name} ${season.year}`;

  // Operational: the currently OPEN planning month(s) for this season (Open-Month, §42).
  const monthStates = await getSeasonMonthStates(season.id);
  const openMonths = monthStates.filter((m) => m.status === "OPEN");
  const planningMonthCard: DashboardCard = {
    label: "Current Planning Month",
    value: openMonths.length ? openMonths.map((m) => m.name).join(", ") : "None open",
  };

  if (ctx.role === Role.SALES_OFFICER) {
    const dealerIds = await getCurrentDealerIds(ctx.userId);
    const plan = await prisma.seasonPlan.findFirst({
      where: { seasonId: season.id, officerId: ctx.userId },
      orderBy: { version: "desc" },
    });
    return {
      seasonName,
      cards: [
        { label: "Assigned Dealers", value: String(dealerIds.length) },
        { label: "Plan Status", value: plan ? statusLabel(plan.status) : "Not started" },
        planningMonthCard,
        { label: "Season Plan", value: money(planAmount) },
        { label: "Actual Sales", value: money(actualAmount) },
        { label: "Achievement", value: pct(achievement(actualAmount, planAmount)) },
      ],
    };
  }

  const inbox = await getApprovalsInbox(ctx);

  if (ctx.role === Role.REGIONAL_MANAGER) {
    const scope = await getOfficerScope(ctx);
    const officers = groupSummary(facts, (f) => f.officerId, (f) => f.officerName);
    const behind = officers.filter((o) => o.planAmount > 0 && o.achievementAmount < 0.5).length;
    return {
      seasonName,
      cards: [
        { label: "Assigned Officers", value: String(scope.ids.length) },
        { label: "Pending Approvals", value: String(inbox.length) },
        planningMonthCard,
        { label: "Region Plan", value: money(planAmount) },
        { label: "Region Actual", value: money(actualAmount) },
        { label: "Achievement", value: pct(achievement(actualAmount, planAmount)) },
        { label: "Officers Behind (<50%)", value: String(behind) },
      ],
      topDealers: groupSummary(facts, (f) => f.dealerId, (f) => f.dealerName).slice(0, 5),
    };
  }

  // Super Admin
  const [officerCount, dealerCount] = await Promise.all([
    prisma.user.count({ where: { role: Role.SALES_OFFICER, isActive: true } }),
    prisma.dealer.count({ where: { isActive: true } }),
  ]);
  const dealers = groupSummary(facts, (f) => f.dealerId, (f) => f.dealerName);
  return {
    seasonName,
    cards: [
      { label: "Company Plan", value: money(planAmount) },
      { label: "Company Actual", value: money(actualAmount) },
      { label: "Achievement", value: pct(achievement(actualAmount, planAmount)) },
      { label: "Approvals Pending", value: String(inbox.length) },
      { label: "Active Officers", value: String(officerCount) },
      { label: "Active Dealers", value: String(dealerCount) },
      { label: "Season", value: season.status === SeasonStatus.OPEN ? "Open" : "Closed" },
      planningMonthCard,
    ],
    topProducts: groupSummary(facts, (f) => f.productId, (f) => f.productName)
      .sort((a, b) => b.actualAmount - a.actualAmount)
      .slice(0, 5),
    topDealers: [...dealers].sort((a, b) => b.actualAmount - a.actualAmount).slice(0, 5),
    lowestDealers: dealers
      .filter((d) => d.planAmount > 0)
      .sort((a, b) => a.achievementAmount - b.achievementAmount)
      .slice(0, 5),
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
