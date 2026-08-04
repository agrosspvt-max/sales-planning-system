import "server-only";
import { PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { type AuthContext } from "@/lib/http";
import { assertOfficerInScope } from "@/lib/scope";
import { PLANNING_TYPE_LABELS, type PlanningType } from "@/features/planning/types";

/**
 * Officer Plan Management — the data behind the profile "Plans" table. Aggregates ALL of an
 * officer's plans across the three modules and every status/lifecycle: Seasonal (SeasonPlan),
 * Monthly (first-class MonthlyPlan) and Recovery (RecoveryPlan). Read-only aggregation only —
 * every mutating action goes through the existing lifecycle / approval services.
 */

export type PlanKind = "SEASONAL" | "MONTHLY" | "RECOVERY";

export interface OfficerPlanRow {
  kind: PlanKind;
  id: string;
  planType: string;
  seasonName: string;
  monthName: string | null;
  version: number | null;
  status: PlanStatus;
  lifecycleState: string;
  source: "IMPORT" | "MANUAL";
  openHref: string;
  createdAt: string;
  updatedAt: string;
  lastSavedAt: string;
}

export interface OfficerPlansResult {
  officerId: string;
  officerName: string;
  hasActiveSeasonal: boolean;
  currentSeasonId: string | null;
  rows: OfficerPlanRow[];
}

export async function getOfficerPlans(ctx: AuthContext, officerId: string): Promise<OfficerPlansResult> {
  await assertOfficerInScope(ctx, officerId);

  const [officer, seasonPlans, monthlyPlans, recoveryPlans] = await Promise.all([
    prisma.user.findUnique({ where: { id: officerId }, select: { name: true } }),
    prisma.seasonPlan.findMany({
      where: { officerId },
      include: { season: { select: { id: true, name: true, year: true } } },
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.monthlyPlan.findMany({
      where: { officerId },
      include: {
        seasonPlan: { select: { season: { select: { name: true, year: true } } } },
        seasonMonth: { select: { name: true, order: true } },
      },
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.recoveryPlan.findMany({
      where: { officerId },
      include: { season: { select: { name: true, year: true } }, seasonMonth: { select: { name: true, order: true } } },
      orderBy: [{ updatedAt: "desc" }],
    }),
  ]);

  const iso = (d: Date) => d.toISOString();

  const seasonalRows: OfficerPlanRow[] = (seasonPlans as unknown as SeasonPlanRow[]).map((p) => ({
    kind: "SEASONAL",
    id: p.id,
    planType: PLANNING_TYPE_LABELS[(p.planningType as PlanningType) ?? "SEASONAL"] ?? p.planningType,
    seasonName: `${p.season.name} ${p.season.year}`,
    monthName: null,
    version: p.version,
    status: p.status,
    lifecycleState: p.lifecycleState ?? "ACTIVE",
    source: p.source === "IMPORT" ? "IMPORT" : "MANUAL",
    openHref: `/planning/${p.id}`,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    lastSavedAt: iso(p.lastSavedAt),
  }));

  const monthlyRows: OfficerPlanRow[] = (monthlyPlans as unknown as MonthlyPlanRow[]).map((p) => ({
    kind: "MONTHLY",
    id: p.id,
    planType: "Monthly",
    seasonName: `${p.seasonPlan.season.name} ${p.seasonPlan.season.year}`,
    monthName: p.seasonMonth.name,
    version: null,
    status: p.status,
    lifecycleState: p.lifecycleState ?? "ACTIVE",
    source: "MANUAL",
    openHref: `/planning/monthly/${p.id}`,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    lastSavedAt: iso(p.lastSavedAt),
  }));

  const recoveryRows: OfficerPlanRow[] = (recoveryPlans as unknown as RecoveryPlanRow[]).map((p) => ({
    kind: "RECOVERY",
    id: p.id,
    planType: "Recovery",
    seasonName: `${p.season.name} ${p.season.year}`,
    monthName: p.seasonMonth.name,
    version: null,
    status: p.status,
    lifecycleState: p.lifecycleState ?? "ACTIVE",
    source: "IMPORT",
    openHref: `/planning/recovery/${p.id}`,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    lastSavedAt: iso(p.lastSavedAt),
  }));

  // Active SEASONAL plan drives the "import a replacement" empty state (requirement 3).
  const activeSeasonal = (seasonPlans as unknown as SeasonPlanRow[]).find(
    (p) => p.planningType === "SEASONAL" && (p.lifecycleState ?? "ACTIVE") === "ACTIVE",
  );
  // Most recent season the officer has any seasonal plan for — used to seed a fresh import/plan.
  const currentSeasonId = (seasonPlans as unknown as SeasonPlanRow[]).find((p) => p.planningType === "SEASONAL")?.season.id ?? null;

  return {
    officerId,
    officerName: officer?.name ?? "Officer",
    hasActiveSeasonal: !!activeSeasonal,
    currentSeasonId,
    rows: [...seasonalRows, ...monthlyRows, ...recoveryRows],
  };
}

interface SeasonPlanRow {
  id: string;
  planningType: string;
  version: number;
  status: PlanStatus;
  lifecycleState: string | null;
  source: string;
  season: { id: string; name: string; year: number };
  createdAt: Date;
  updatedAt: Date;
  lastSavedAt: Date;
}
interface MonthlyPlanRow {
  id: string;
  status: PlanStatus;
  lifecycleState: string | null;
  seasonPlan: { season: { name: string; year: number } };
  seasonMonth: { name: string; order: number };
  createdAt: Date;
  updatedAt: Date;
  lastSavedAt: Date;
}
interface RecoveryPlanRow {
  id: string;
  status: PlanStatus;
  lifecycleState: string | null;
  season: { name: string; year: number };
  seasonMonth: { name: string; order: number };
  createdAt: Date;
  updatedAt: Date;
  lastSavedAt: Date;
}
