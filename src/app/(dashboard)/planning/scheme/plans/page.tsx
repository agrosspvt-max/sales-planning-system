import { auth } from "@/auth";
import { SchemeViewPlansPage } from "@/features/schemes/scheme-planning-page";
import { SCHEME_PLANNING_ENABLED } from "@/lib/feature-flags";
import { SchemePlanningComingSoon } from "@/features/schemes/scheme-coming-soon";

export default async function Page() {
  // View Plans half of Scheme Planning, gated by the same SCHEME_PLANNING_ENABLED flag as the create route.
  if (!SCHEME_PLANNING_ENABLED) return <SchemePlanningComingSoon />;
  const session = await auth();
  return <SchemeViewPlansPage role={session!.user.role} userId={session!.user.id} />;
}
