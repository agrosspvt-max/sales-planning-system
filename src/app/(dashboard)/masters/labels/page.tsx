import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { LabelsPage } from "@/features/labels/labels-page";

export default async function Page() {
  const session = await auth();
  // Only the Super Admin manages labels (writes are also enforced server-side in setLabelOverride).
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <LabelsPage />;
}
