import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { ApprovalsInbox } from "@/features/planning/approvals-inbox";
import { MyApprovals } from "@/features/planning/my-approvals";

export default async function Page() {
  const session = await auth();
  const role = session!.user.role;
  // Sales Officers see a READ-ONLY list of their own submitted plans + statuses; RM/Admin get the
  // approval queue for their scope.
  if (role === Role.SALES_OFFICER) return <MyApprovals />;
  return <ApprovalsInbox role={role} />;
}
