import { auth } from "@/auth";
import { MonthlyPlanWorkspace } from "@/features/planning/monthly-plan-workspace";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  return <MonthlyPlanWorkspace monthlyPlanId={id} role={session!.user.role} userId={session!.user.id} />;
}
