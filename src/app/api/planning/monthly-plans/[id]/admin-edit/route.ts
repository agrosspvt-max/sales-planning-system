import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { adminEditMonthly } from "@/features/planning/admin-edit.server";

const bodySchema = z.object({
  reason: z.string(),
  entries: z.array(
    z.object({
      planLineId: z.string().min(1),
      seasonMonthId: z.string().min(1),
      planQty: z.coerce.number().optional(),
      mode: z.string().optional(),
      planValue: z.coerce.number().optional(),
    }),
  ),
});

/** Admin Override — correct INPUT fields of an APPROVED monthly plan (Super Admin only). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { entries, reason } = bodySchema.parse(await req.json());
    return ok(await adminEditMonthly(auth, id, entries, reason));
  });
}
