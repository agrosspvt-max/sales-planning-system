/**
 * Shared Dealer Planning status — the single source of truth for the three states a dealer
 * can be in within a plan. Used by UI (progress bar, dropdown colours) and server
 * (submit gate) so the vocabulary never drifts. Not a Prisma enum: only `NO_PLAN` is stored
 * (`PlanDealer.noPlan`); `COMPLETED` and `REMAINING` are derived from saved quantities.
 */
export const DealerPlanningStatus = {
  REMAINING: "REMAINING",
  COMPLETED: "COMPLETED",
  NO_PLAN: "NO_PLAN",
} as const;

export type DealerPlanningStatus =
  (typeof DealerPlanningStatus)[keyof typeof DealerPlanningStatus];
