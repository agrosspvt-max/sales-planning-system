import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { SchemeMasterPage } from "@/features/schemes/scheme-master-page";

export default async function SchemeMaster() {
  const session = await auth();
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <SchemeMasterPage />;
}
