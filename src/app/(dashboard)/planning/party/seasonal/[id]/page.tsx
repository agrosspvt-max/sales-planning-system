import { auth } from "@/auth";
import { SeasonalPlanDetailPage } from "@/features/party-planning/seasonal-planning-page";

// ONE Seasonal Plan, by id (refresh-safe: everything is loaded from the id, never from client state or the current season).
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  return <SeasonalPlanDetailPage role={session!.user.role} sheetId={id} />;
}
