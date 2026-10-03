import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { DealerImportWizard } from "@/features/import/dealers/wizard";

export default async function Page() {
  const session = await auth();
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <DealerImportWizard />;
}
