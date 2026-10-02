import { handle, ok, requireAuth } from "@/lib/http";
import { decideTagRequest } from "@/features/dealer-tags/service.server";
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  return handle(async () =>
    ok(await decideTagRequest(await requireAuth(), (await route.params).id, await req.json())),
  );
}
