import { auth } from "@/auth";
import { partyPlanningGate } from "@/features/party-planning/party-planning-unavailable";
import { parseStage } from "@/lib/monthly-plan";
import { SeasonalPlanDetailPage } from "@/features/party-planning/seasonal-planning-page";

// ONE Seasonal Plan, by id (refresh-safe: everything is loaded from the id, never from client state or the current season).
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stage?: string }> }) {
  const unavailable = partyPlanningGate(); // PARTY_PLANNING_ENABLED off → friendly page
  if (unavailable) return unavailable;
  const { id } = await params;
  const { stage } = await searchParams; // which lifecycle section this plan was opened from (Create | Submitted | Approved | Older Plans)
  const session = await auth();
  return <SeasonalPlanDetailPage role={session!.user.role} sheetId={id} stage={parseStage(stage)} />;
}
