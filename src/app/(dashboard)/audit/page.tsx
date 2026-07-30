import { auth } from "@/auth";
import { can } from "@/lib/rbac";
import { Forbidden } from "@/components/layout/forbidden";
import { AuditPage } from "@/features/audit/audit-page";

export default async function Page() {
  const session = await auth();
  if (!can(session!.user.role, "audit", "read")) return <Forbidden />;
  return <AuditPage />;
}
