import { auth } from "@/auth";
import { PlanWorkspace } from "@/features/planning/plan-workspace";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  return <PlanWorkspace planId={id} role={session!.user.role} userId={session!.user.id} />;
}
