import { auth } from "@/auth";
import { parseStage } from "@/lib/monthly-plan";
import { MonthlyPlanListPage } from "@/features/party-planning/monthly-plan-list-page";

// Party Planning → Planning → Monthly: the list of Monthly Plans. Scope and ownership are enforced by the APIs.
// ?stage=create|submitted|approved|older selects the lifecycle section (route state: refresh and Back / Forward keep it).
export default async function Page({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  const session = await auth();
  const { stage } = await searchParams;
  return <MonthlyPlanListPage role={session!.user.role} stage={parseStage(stage)} />;
}
