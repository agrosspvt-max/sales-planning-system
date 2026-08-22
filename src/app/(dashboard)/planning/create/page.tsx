import { PlanningModules } from "@/features/planning/planning-modules";
import { SCHEME_PLANNING_ENABLED } from "@/lib/feature-flags";

export default function Page() {
  return <PlanningModules mode="create" schemePlanningEnabled={SCHEME_PLANNING_ENABLED} />;
}
