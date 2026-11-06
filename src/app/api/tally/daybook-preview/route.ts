import { ApiError, handle, ok, requireAuth } from "@/lib/http";
import { assertSuper, readBody, sameOrigin } from "@/features/tally/service.server";
import { approvedTestPreview } from "@/features/tally/sales-rollout";
import { DAYBOOK_PREVIEW_BYTES } from "@/features/tally/daybook-preview";
import { previewDaybook } from "@/features/tally/daybook-preview.server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  return handle(async () => {
    sameOrigin(req);
    assertSuper(await requireAuth());
    if (!approvedTestPreview())
      throw new ApiError(404, "Daybook review is available on the approved test Preview.");
    return ok(await previewDaybook(await readBody(req, DAYBOOK_PREVIEW_BYTES)));
  });
}
