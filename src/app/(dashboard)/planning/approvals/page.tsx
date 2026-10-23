import { CnReviewInbox } from "@/features/cn-requests/cn-review-ui";
import { hasAdminPermission } from "@/features/accounts/permissions";
import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { ApprovalsInbox } from "@/features/planning/approvals-inbox";
import { MyApprovals } from "@/features/planning/my-approvals";

export default async function Page() {
  const session = await auth();
  const role = session!.user.role;
  // Sales Officers see a READ-ONLY list of their own submitted plans + statuses; RM/Admin get the
  // approval queue for their scope.
  if (role === Role.SALES_OFFICER) return <div className="space-y-6"><CnReviewInbox /><MyApprovals /></div>;
  if (role === Role.CUSTOM_ADMIN && !hasAdminPermission(session!.user, "approvals")) return <CnReviewInbox />;
  return <div className="space-y-6"><CnReviewInbox /><ApprovalsInbox role={role} userId={session!.user.id} /></div>;
}
