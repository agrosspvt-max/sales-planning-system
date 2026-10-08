import { auth } from "@/auth";
import { MonthlyPlanDetailPage } from "@/features/party-planning/monthly-planning-page";

// ONE Monthly Plan, by id (refresh-safe: season, month and rows are all loaded from the id).
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  return <MonthlyPlanDetailPage role={session!.user.role} sheetId={id} />;
}
