import { auth } from "@/auth";
import { ApprovalsInbox } from "@/features/planning/approvals-inbox";

export default async function Page() {
  const session = await auth();
  return <ApprovalsInbox role={session!.user.role} userId={session!.user.id} />;
}
