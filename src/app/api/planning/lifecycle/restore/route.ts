import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { restoreChildPlan } from "@/features/planning/lifecycle.server";

const bodySchema = z.object({
  kind: z.enum(["MONTHLY", "RECOVERY"]),
  id: z.string().min(1),
  mode: z.enum(["WITH_PARENT", "HISTORICAL", "RESTORE_PARENT_ARCHIVE_NEWER"]),
});

/** Restore a Monthly/Recovery plan under an archived parent, using an admin-chosen mode. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const { kind, id, mode } = bodySchema.parse(await req.json());
    return ok(await restoreChildPlan(auth, kind, id, mode));
  });
}
