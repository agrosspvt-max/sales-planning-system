import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { can, type Resource } from "@/lib/rbac";
import { Forbidden } from "@/components/layout/forbidden";
import { OfficerPlansManagement } from "@/features/profiles/officer-plans";

/**
 * Officer plan-management page: /masters/users/:id/plans — every Seasonal / Monthly / Recovery plan
 * for the officer with lifecycle actions. Data-level scope + admin-only actions are enforced in the
 * service and lifecycle APIs; this only gates route access.
 */
export default async function OfficerPlansPage({
  params,
}: {
  params: Promise<{ resource: string; id: string }>;
}) {
  const { resource, id } = await params;
  if (resource !== "users") notFound();

  const session = await auth();
  const role = session!.user.role;
  if (!can(role, resource as Resource, "read")) return <Forbidden />;

  return <OfficerPlansManagement officerId={id} role={role} />;
}
