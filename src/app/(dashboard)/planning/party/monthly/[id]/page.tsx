import { auth } from "@/auth";
import { partyPlanningGate } from "@/features/party-planning/party-planning-unavailable";
import { parseStage } from "@/lib/monthly-plan";
import { MonthlyPlanDetailPage } from "@/features/party-planning/monthly-planning-page";

// ONE Monthly Plan, by id (refresh-safe: season, month and rows are all loaded from the id).
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stage?: string }> }) {
  const unavailable = partyPlanningGate(); // PARTY_PLANNING_ENABLED off → friendly page
  if (unavailable) return unavailable;
  const { id } = await params;
  const { stage } = await searchParams; // which lifecycle section this plan was opened from (Create | Submitted | Approved | Older Plans)
  const session = await auth();
  return <MonthlyPlanDetailPage role={session!.user.role} sheetId={id} stage={parseStage(stage)} />;
}
