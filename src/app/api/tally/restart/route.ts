import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { sameOrigin, readBody, restartRefresh } from "@/features/tally/service.server";
export async function POST(req: Request) {
  return handle(async () => {
    sameOrigin(req);
    const auth = await requireAuth();
    const { jobId } = z
      .object({ jobId: z.string().uuid() })
      .strict()
      .parse(await readBody(req));
    return ok(await restartRefresh(auth, jobId));
  });
}
