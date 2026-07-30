import { auth } from "@/auth";
import { can } from "@/lib/rbac";
import { Forbidden } from "@/components/layout/forbidden";
import { SeasonsPage } from "@/features/seasons/seasons-page";

export default async function Page() {
  const session = await auth();
  const role = session!.user.role;
  if (!can(role, "seasons", "read")) return <Forbidden />;
  return <SeasonsPage canManage={can(role, "seasons", "create")} />;
}
