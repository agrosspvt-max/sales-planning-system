import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { SchemeMasterPage } from "@/features/schemes/scheme-master-page";

export default async function SchemeMaster() {
  const session = await auth();
  if (session!.user.role !== Role.SUPER_ADMIN) return <Forbidden />;
  return <SchemeMasterPage />;
}
