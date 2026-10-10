import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { DistrictMasterPage } from "@/features/users/district-master-page";

export default async function Page({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const session = await auth();
  // The District master is managed by an Admin, like the State Catalogue it belongs to (the API re-checks the grant).
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <DistrictMasterPage groupId={groupId} />;
}
