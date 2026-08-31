import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { LabelsPage } from "@/features/labels/labels-page";

export default async function Page() {
  const session = await auth();
  // Only the Super Admin manages labels (writes are also enforced server-side in setLabelOverride).
  if (session!.user.role !== Role.SUPER_ADMIN) return <Forbidden />;
  return <LabelsPage />;
}
