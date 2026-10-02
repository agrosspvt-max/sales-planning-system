import { requireAuth } from "@/lib/http";
import { DealerTagsPage } from "@/features/dealer-tags/dealer-tags-page";
export default async function Page() {
  const ctx = await requireAuth();
  return <DealerTagsPage role={ctx.role} />;
}
