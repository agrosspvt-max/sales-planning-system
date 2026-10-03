import { isAdministrativeRole } from "@/features/accounts/permissions";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { ProductCataloguePage } from "@/features/users/product-catalogue-page";

export default async function Page({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const session = await auth();
  // Group product catalogue is managed by the Super Admin (same as Users / Groups management).
  if (!isAdministrativeRole(session!.user.role)) return <Forbidden />;
  return <ProductCataloguePage groupId={groupId} />;
}
