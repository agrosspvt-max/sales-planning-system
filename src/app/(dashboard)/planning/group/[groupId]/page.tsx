import { Role } from "@prisma/client";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Forbidden } from "@/components/layout/forbidden";
import { GroupPlanPage } from "@/features/planning/group-plan-page";

/** Territory (Group) Planning dashboard — admin/manager only, read-only analytics. */
export default async function Page({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const session = await auth();
  const role = session!.user.role;
  if (role !== Role.SUPER_ADMIN && role !== Role.REGIONAL_MANAGER) return <Forbidden />;
  const group = (await prisma.userGroup.findUnique({ where: { id: groupId }, select: { name: true } })) as { name: string } | null;
  if (!group) notFound();
  return <GroupPlanPage groupId={groupId} groupName={group.name} />;
}
