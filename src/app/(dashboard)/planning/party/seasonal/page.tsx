import { auth } from "@/auth";
import { SeasonalPlanListPage } from "@/features/party-planning/seasonal-plan-list-page";

// Party Planning → Planning → Seasonal: the list of Seasonal Plans. Scope and ownership are enforced by the APIs.
export default async function Page() {
  const session = await auth();
  return <SeasonalPlanListPage role={session!.user.role} />;
}
