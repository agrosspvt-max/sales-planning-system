import { handle, ok, requireAuth } from "@/lib/http";
import { listTagRequests, requestTag } from "@/features/dealer-tags/service.server";
export async function GET() {
  return handle(async () => ok(await listTagRequests(await requireAuth())));
}
export async function POST(req: Request) {
  return handle(async () => ok(await requestTag(await requireAuth(), await req.json()), 201));
}
