import { auth } from "@/auth";
import { PlanningModules } from "@/features/planning/planning-modules";
import { SCHEME_PLANNING_ENABLED, isPartyPlanningEnabled } from "@/lib/feature-flags";

export default async function Page() {
  await auth();
  return <PlanningModules mode="create" schemePlanningEnabled={SCHEME_PLANNING_ENABLED} partyPlanningEnabled={isPartyPlanningEnabled()} />;
}
