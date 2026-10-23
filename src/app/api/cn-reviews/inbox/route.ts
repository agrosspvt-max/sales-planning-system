import { cnReviewInbox } from "@/features/cn-requests/cn-review.server";
import { handle, ok, requireAuth } from "@/lib/http";
export async function GET() {
  return handle(async () => ok(await cnReviewInbox(await requireAuth())));
}
