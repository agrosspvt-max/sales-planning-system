import { Role } from "@prisma/client";
import { auth } from "@/auth";
import { Forbidden } from "@/components/layout/forbidden";
import { PlanningConfigPage } from "@/features/settings/planning-config-page";

export default async function Page() {
  const session = await auth();
  if (session!.user.role !== Role.SUPER_ADMIN) return <Forbidden />;
  return <PlanningConfigPage />;
}
