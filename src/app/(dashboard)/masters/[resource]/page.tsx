import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { requireAuth } from "@/lib/http";
import { can, type Resource } from "@/lib/rbac";
import { getResourceConfig } from "@/features/resources/config";
import { ResourcePage } from "@/features/resources/resource-page";
import { UsersManagement } from "@/features/users/users-management";
import { Forbidden } from "@/components/layout/forbidden";

export default async function MasterResourcePage({
  params,
}: {
  params: Promise<{ resource: string }>;
}) {
  const { resource } = await params;
  const config = getResourceConfig(resource);
  if (!config) notFound();

  const session = await auth();
  const role = session!.user.role;
  const key = resource as Resource;
  if (!can(role, key, "read")) return <Forbidden />;

  // The flat Users page is replaced by the Group View | All Users management screen.
  // A Regional Manager sees a scoped, read-only variant (their group's officers only).
  if (resource === "users") {
    const ctx = await requireAuth();
    return <UsersManagement role={role} groupId={ctx.groupId} />;
  }

  return <ResourcePage config={config} canWrite={can(role, key, "create")} />;
}
