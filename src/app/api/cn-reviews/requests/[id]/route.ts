import { type NextRequest } from "next/server";
import { cnReviewHistory, sendCnReview } from "@/features/cn-requests/cn-review.server";
import { handle, ok, requireAuth } from "@/lib/http";
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await cnReviewHistory(auth, id));
  });
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const form = await req.formData();
    const file = form.get("file");
    return ok(
      await sendCnReview(
        auth,
        id,
        {
          kind: form.get("kind"),
          assignedToId: form.get("assignedToId"),
          productIds: form.getAll("productId"),
          requestKey: form.get("requestKey"),
          expectedReviewId: form.get("expectedReviewId"),
        },
        file instanceof File
          ? { name: file.name, type: file.type, buffer: Buffer.from(await file.arrayBuffer()) }
          : null,
      ),
    );
  });
}
