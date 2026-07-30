import { type NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/http";
import { parsePageParams } from "@/lib/pagination";
import { writeAudit } from "@/lib/audit";
import { createResource, listResource } from "@/features/resources/service.server";
import { RESOURCE_CONFIG } from "@/features/resources/config";
import type { Resource } from "@/lib/rbac";

function assertResource(key: string): Resource {
  if (!(key in RESOURCE_CONFIG)) throw new ApiError(404, "Unknown resource");
  return key as Resource;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ resource: string }> }) {
  return handle(async () => {
    const resource = assertResource((await ctx.params).resource);
    await requirePermission(resource, "read");
    const params = parsePageParams(req.nextUrl.searchParams);
    return ok(await listResource(resource, params));
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ resource: string }> }) {
  return handle(async () => {
    const resource = assertResource((await ctx.params).resource);
    const auth = await requirePermission(resource, "create");
    const body = await req.json();
    const { id } = await createResource(resource, body);
    await writeAudit({ userId: auth.userId, action: "CREATE", entity: resource, entityId: id });
    return ok({ id }, 201);
  });
}
