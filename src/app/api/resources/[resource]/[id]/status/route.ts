import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requirePermission, ApiError } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { setResourceActive } from "@/features/resources/service.server";
import { RESOURCE_CONFIG } from "@/features/resources/config";
import type { Resource } from "@/lib/rbac";

const bodySchema = z.object({ isActive: z.boolean() });

function assertResource(key: string): Resource {
  if (!(key in RESOURCE_CONFIG)) throw new ApiError(404, "Unknown resource");
  return key as Resource;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ resource: string; id: string }> }) {
  return handle(async () => {
    const { resource, id } = await ctx.params;
    const key = assertResource(resource);
    const auth = await requirePermission(key, "delete");
    const { isActive } = bodySchema.parse(await req.json());
    await setResourceActive(key, id, isActive);
    await writeAudit({
      userId: auth.userId,
      action: isActive ? "REACTIVATE" : "DEACTIVATE",
      entity: key,
      entityId: id,
    });
    return ok({ id, isActive });
  });
}
