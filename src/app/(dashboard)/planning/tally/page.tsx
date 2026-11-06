import { requireAuth, ApiError } from "@/lib/http";
import { Role } from "@prisma/client";
import { TallySettings } from "@/features/tally/settings";
import { indiaDay } from "@/features/tally/billwise";
import { approvedTestPreview } from "@/features/tally/sales-rollout";
export default async function Page() {
  const ctx = await requireAuth();
  if (ctx.role !== Role.SUPER_ADMIN)
    throw new ApiError(403, "Only the Super Admin can configure Tally");
  return (
    <TallySettings daybookMonth={approvedTestPreview() ? indiaDay().slice(0, 7) : undefined} />
  );
}
