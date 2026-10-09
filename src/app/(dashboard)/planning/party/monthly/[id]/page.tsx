import { auth } from "@/auth";
import { parseStage } from "@/lib/monthly-plan";
import { MonthlyPlanDetailPage } from "@/features/party-planning/monthly-planning-page";

// ONE Monthly Plan, by id (refresh-safe: season, month and rows are all loaded from the id).
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stage?: string }> }) {
  const { id } = await params;
  const { stage } = await searchParams; // which lifecycle section this plan was opened from (Create | Submitted | Approved | Older Plans)
  const session = await auth();
  return <MonthlyPlanDetailPage role={session!.user.role} sheetId={id} stage={parseStage(stage)} />;
}
