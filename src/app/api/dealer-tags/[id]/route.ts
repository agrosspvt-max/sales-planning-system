import { handle, ok, requireAuth } from "@/lib/http";
import { saveTag } from "@/features/dealer-tags/service.server";
export async function PATCH(req: Request, route: { params: Promise<{ id: string }> }) {
  return handle(async () =>
    ok(await saveTag(await requireAuth(), await req.json(), (await route.params).id)),
  );
}
