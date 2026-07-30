import { type NextRequest } from "next/server";
import { z } from "zod";
import { SeasonStatus } from "@prisma/client";
import { handle, ok, requirePermission } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { setSeasonStatus } from "@/features/seasons/service.server";

const bodySchema = z.object({ status: z.nativeEnum(SeasonStatus) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const auth = await requirePermission("seasons", "update");
    const { status } = bodySchema.parse(await req.json());
    await setSeasonStatus(id, status);
    await writeAudit({ userId: auth.userId, action: "UPDATE", entity: "seasons", entityId: id });
    return ok({ id, status });
  });
}
