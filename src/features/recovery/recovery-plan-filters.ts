/**
 * Recovery Planning's column filters. The logic is shared with Sales Planning (see planning/plan-column-filters);
 * this module keeps Recovery's original export names.
 */
import {
  applyPlanFilters, planFilterKeys, planFilterOptions,
  type PlanFilterKey, type PlanFilters, type PlanFilterable,
} from "@/features/planning/plan-column-filters";

export type RecoveryPlanFilterKey = PlanFilterKey;
export type RecoveryPlanFilters = PlanFilters;
export interface RecoveryFilterablePlan extends PlanFilterable { monthName: string }

export const recoveryFilterKeys = planFilterKeys;
export const applyRecoveryPlanFilters = applyPlanFilters;
export const recoveryFilterOptions = planFilterOptions;
