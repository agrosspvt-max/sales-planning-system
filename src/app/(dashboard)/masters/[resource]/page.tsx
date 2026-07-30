import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { can, type Resource } from "@/lib/rbac";
import { getResourceConfig } from "@/features/resources/config";
import { ResourcePage } from "@/features/resources/resource-page";
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

  return <ResourcePage config={config} canWrite={can(role, key, "create")} />;
}
