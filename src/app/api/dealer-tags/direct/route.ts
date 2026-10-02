import { handle, ok, requireAuth } from "@/lib/http";
import { directTag } from "@/features/dealer-tags/service.server";
export async function POST(req: Request) {
  return handle(async () => ok(await directTag(await requireAuth(), await req.json())));
}
