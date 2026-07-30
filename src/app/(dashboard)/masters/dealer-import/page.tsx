import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { DealerImportWizard } from "@/features/import/dealers/wizard";

export default async function Page() {
  const session = await auth();
  if (session!.user.role !== Role.SUPER_ADMIN) return <Forbidden />;
  return <DealerImportWizard />;
}
