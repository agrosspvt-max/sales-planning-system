export const EDITABLE_SCHEME_PLAN_STATUSES = new Set(["DRAFT", "RETURNED"]);

export interface DealerPlanPayloadRow {
  dealerId: string;
  expectedBillingDate: string | null;
  numberOfSchemes: number;
  note: string | null;
  optionId: string | null;
  prePlacementDays: number | null;
}

interface ExistingDealerPlanInput {
  schemeId: string;
  dealerId: string;
  planStatus: string;
  expectedBillingDate: string | null;
  numberOfSchemes: number;
  soNote?: string | null;
  selectedOptionId?: string | null;
  prePlacementDays?: number | null;
}

/** Scheme groups which contain a dealer plan that can still be worked on in the Draft workspace. */
export function editableDraftSchemeIds(plans: { schemeId: string; planStatus: string }[]): Set<string> {
  return new Set(plans.filter((plan) => EDITABLE_SCHEME_PLAN_STATUSES.has(plan.planStatus)).map((plan) => plan.schemeId));
}

/**
 * The draft endpoints accept the complete editable working set for a scheme. Merge a modal row into that set
 * so creating or submitting one dealer never removes another dealer's existing Draft/Returned plan.
 */
export function mergeDealerIntoEditableWorkingSet(
  plans: ExistingDealerPlanInput[],
  schemeId: string,
  dealer: DealerPlanPayloadRow,
): DealerPlanPayloadRow[] {
  const rows = plans
    .filter((plan) => plan.schemeId === schemeId && EDITABLE_SCHEME_PLAN_STATUSES.has(plan.planStatus) && plan.dealerId !== dealer.dealerId)
    .map((plan) => ({
      dealerId: plan.dealerId,
      expectedBillingDate: plan.expectedBillingDate,
      numberOfSchemes: plan.numberOfSchemes || 1,
      note: plan.soNote ?? null,
      optionId: plan.selectedOptionId ?? null,
      prePlacementDays: plan.prePlacementDays ?? null,
    }));
  rows.push(dealer);
  return rows;
}
