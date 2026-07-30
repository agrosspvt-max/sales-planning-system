import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { can, type Resource } from "@/lib/rbac";
import { Forbidden } from "@/components/layout/forbidden";
import { SalesOfficerProfile } from "@/features/profiles/officer-profile";
import { DealerProfileView } from "@/features/profiles/dealer-profile";

/**
 * Analytical profile pages under the existing Masters IA:
 *   /masters/users/:id   → Sales Officer Profile
 *   /masters/dealers/:id → Dealer Profile
 * Data-level scope is enforced inside the profile service; this only gates route access.
 */
export default async function MasterProfilePage({
  params,
}: {
  params: Promise<{ resource: string; id: string }>;
}) {
  const { resource, id } = await params;
  if (resource !== "users" && resource !== "dealers") notFound();

  const session = await auth();
  const role = session!.user.role;
  if (!can(role, resource as Resource, "read")) return <Forbidden />;

  if (resource === "users") return <SalesOfficerProfile officerId={id} />;
  return <DealerProfileView dealerId={id} />;
}
