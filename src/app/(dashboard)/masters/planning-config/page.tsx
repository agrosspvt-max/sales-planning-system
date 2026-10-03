import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { PlanningConfigPage } from "@/features/settings/planning-config-page";

export default async function Page() {
  const session = await auth();
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <PlanningConfigPage />;
}
