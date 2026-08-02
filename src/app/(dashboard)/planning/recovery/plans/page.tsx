import { auth } from "@/auth";
import { RecoveryPlanning } from "@/features/recovery/recovery-planning";

export default async function Page() {
  const session = await auth();
  return <RecoveryPlanning role={session!.user.role} mode="view" />;
}
