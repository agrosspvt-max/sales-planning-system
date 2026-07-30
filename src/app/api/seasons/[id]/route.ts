import { type NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { updateSeason } from "@/features/seasons/service.server";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const auth = await requirePermission("seasons", "update");
    await updateSeason(id, await req.json());
    await writeAudit({ userId: auth.userId, action: "UPDATE", entity: "seasons", entityId: id });
    return ok({ id });
  });
}
