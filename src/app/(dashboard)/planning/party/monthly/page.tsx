import { auth } from "@/auth";
import { MonthlyPlanListPage } from "@/features/party-planning/monthly-plan-list-page";

// Party Planning → Planning → Monthly: the list of Monthly Plans. Scope and ownership are enforced by the APIs.
export default async function Page() {
  const session = await auth();
  return <MonthlyPlanListPage role={session!.user.role} />;
}
