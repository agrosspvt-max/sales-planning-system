import { handle, ok, requireAuth } from "@/lib/http";
import { listTags, saveTag } from "@/features/dealer-tags/service.server";
export async function GET() {
  return handle(async () => {
    await requireAuth();
    return ok(await listTags());
  });
}
export async function POST(req: Request) {
  return handle(async () => ok(await saveTag(await requireAuth(), await req.json()), 201));
}
