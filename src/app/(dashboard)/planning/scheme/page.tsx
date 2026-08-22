import { auth } from "@/auth";
import { SchemePlanningPage } from "@/features/schemes/scheme-planning-page";
import { SCHEME_PLANNING_ENABLED } from "@/lib/feature-flags";
import { SchemePlanningComingSoon } from "@/features/schemes/scheme-coming-soon";

export default async function Page() {
  // Temporarily gated behind SCHEME_PLANNING_ENABLED. The route + workspace code are intact; when the flag
  // is off we render a Coming Soon placeholder so direct navigation is blocked without a 404.
  if (!SCHEME_PLANNING_ENABLED) return <SchemePlanningComingSoon />;
  const session = await auth();
  return <SchemePlanningPage role={session!.user.role} userId={session!.user.id} />;
}
