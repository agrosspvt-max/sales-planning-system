import { Role } from "@prisma/client";
import { requireAuth } from "@/lib/http";
import { Forbidden } from "@/components/layout/forbidden";
import { TagMasterPage } from "@/features/dealer-tags/tag-master-page";
export default async function Page() {
  const ctx = await requireAuth();
  return ctx.role === Role.SUPER_ADMIN ? <TagMasterPage /> : <Forbidden />;
}
