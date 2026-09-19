import { auth } from "@/auth";
import { SchemeFollowUpMonitorPage } from "@/features/schemes/scheme-follow-up-monitor";
import { SCHEME_PLANNING_ENABLED } from "@/lib/feature-flags";
import { SchemePlanningComingSoon } from "@/features/schemes/scheme-coming-soon";

export default async function Page() {
  // "Follow Up" — the fourth Scheme Planning section (a monitoring hub, separate from "Follow-up Plans"),
  // gated by the same SCHEME_PLANNING_ENABLED flag. Read-only; role scope is enforced by the API it reads.
  if (!SCHEME_PLANNING_ENABLED) return <SchemePlanningComingSoon />;
  const session = await auth();
  return <SchemeFollowUpMonitorPage role={session!.user.role} />;
}
