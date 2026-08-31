import { auth } from "@/auth";
import { SchemeFollowUpPage } from "@/features/schemes/scheme-follow-up-view";
import { SCHEME_PLANNING_ENABLED } from "@/lib/feature-flags";
import { SchemePlanningComingSoon } from "@/features/schemes/scheme-coming-soon";

export default async function Page() {
  // Follow-up Plans — the third Scheme Planning section, gated by the same SCHEME_PLANNING_ENABLED flag as
  // the create and view routes. Read-only recovery reporting; role scope is enforced by the API it reads.
  if (!SCHEME_PLANNING_ENABLED) return <SchemePlanningComingSoon />;
  const session = await auth();
  return <SchemeFollowUpPage role={session!.user.role} />;
}
