import { auth } from "@/auth";
import { RecoveryWorkspace } from "@/features/recovery/recovery-workspace";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  return <RecoveryWorkspace id={id} role={session!.user.role} userId={session!.user.id} />;
}
