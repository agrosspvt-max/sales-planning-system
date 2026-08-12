import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { adminEditSeasonal } from "@/features/planning/admin-edit.server";

const bodySchema = z.object({
  reason: z.string(),
  lines: z.array(
    z.object({
      dealerId: z.string().min(1),
      productId: z.string().min(1),
      mode: z.string().optional(),
      packs: z.array(z.object({ packSizeId: z.string().min(1), quantity: z.coerce.number() })).optional(),
      value: z.coerce.number().optional(),
    }),
  ),
});

/** Admin Override — correct INPUT fields of an APPROVED seasonal plan (Super Admin only). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { lines, reason } = bodySchema.parse(await req.json());
    return ok(await adminEditSeasonal(auth, id, lines, reason));
  });
}
