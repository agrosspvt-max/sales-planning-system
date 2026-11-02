import type { Prisma } from "@prisma/client";

/** Master Seasons visibility, independent of a plan's approval/lifecycle state and the caller's role.
 * Keep Seasons management unfiltered so administrators can reopen periods. Operational reads use
 * these predicates in SQL (including ID lookups); closing never deletes or rewrites plan data.
 */
const season = { status: "OPEN" } satisfies Prisma.SeasonWhereInput;
const seasonMonth = { status: "OPEN", season } satisfies Prisma.SeasonMonthWhereInput;
const seasonPlan = { season } satisfies Prisma.SeasonPlanWhereInput;
const monthlyPlan = { seasonPlan, seasonMonth } satisfies Prisma.MonthlyPlanWhereInput;
const recoveryPlan = { season, seasonMonth } satisfies Prisma.RecoveryPlanWhereInput;
const seasonalPlanSheet = { season } satisfies Prisma.SeasonalPlanSheetWhereInput;
const seasonalPlan = { season } satisfies Prisma.SeasonalPlanWhereInput;
const partyMonthlySheet = { season, seasonMonth } satisfies Prisma.PartyMonthlySheetWhereInput;
const partyMonthlyPlan = { season, seasonMonth } satisfies Prisma.PartyMonthlyPlanWhereInput;

export const OPEN_PLANNING_PERIOD = {
  season,
  seasonMonth,
  seasonPlan,
  monthlyPlan,
  recoveryPlan,
  seasonalPlanSheet,
  seasonalPlan,
  partyMonthlySheet,
  partyMonthlyPlan,
};

/** Intersect, never replace, the original owner/scope/status/OR filters. Unique keys remain at
 * the top level for Prisma findUnique. This adds no query or polling and also works in transactions.
 */
export function inOpenPlanningPeriod<T extends object>(
  model: keyof typeof OPEN_PLANNING_PERIOD,
  where: T,
): T {
  return { ...where, AND: [where, OPEN_PLANNING_PERIOD[model]] };
}
