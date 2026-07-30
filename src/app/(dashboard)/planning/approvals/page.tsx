import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { ApprovalsInbox } from "@/features/planning/approvals-inbox";

export default async function Page() {
  const session = await auth();
  const role = session!.user.role;
  if (role === Role.SALES_OFFICER) return <Forbidden />;
  return <ApprovalsInbox role={role} />;
}
