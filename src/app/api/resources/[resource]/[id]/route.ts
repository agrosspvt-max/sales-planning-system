import { type NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { getResource, updateResource, setResourceActive } from "@/features/resources/service.server";
import { RESOURCE_CONFIG } from "@/features/resources/config";
import type { Resource } from "@/lib/rbac";

function assertResource(key: string): Resource {
  if (!(key in RESOURCE_CONFIG)) throw new ApiError(404, "Unknown resource");
  return key as Resource;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ resource: string; id: string }> }) {
  return handle(async () => {
    const { resource, id } = await ctx.params;
    const key = assertResource(resource);
    await requirePermission(key, "read");
    const item = await getResource(key, id);
    if (!item) throw new ApiError(404, "Not found");
    return ok(item);
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ resource: string; id: string }> }) {
  return handle(async () => {
    const { resource, id } = await ctx.params;
    const key = assertResource(resource);
    const auth = await requirePermission(key, "update");
    const body = await req.json();
    await updateResource(key, id, body);
    await writeAudit({ userId: auth.userId, action: "UPDATE", entity: key, entityId: id });
    return ok({ id });
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ resource: string; id: string }> }) {
  return handle(async () => {
    const { resource, id } = await ctx.params;
    const key = assertResource(resource);
    const auth = await requirePermission(key, "delete");
    await setResourceActive(key, id, false);
    await writeAudit({ userId: auth.userId, action: "DEACTIVATE", entity: key, entityId: id });
    return ok({ id });
  });
}
