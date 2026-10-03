import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { RecoveryConfigPage } from "@/features/settings/recovery-config-page";

export default async function Page() {
  const session = await auth();
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <RecoveryConfigPage />;
}
