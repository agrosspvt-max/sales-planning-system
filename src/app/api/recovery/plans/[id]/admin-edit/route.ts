import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { adminEditRecoveryMonth, adminEditRecoveryWeek } from "@/features/planning/admin-edit.server";

const monthBody = z.object({
  view: z.literal("month"),
  reason: z.string(),
  entries: z.array(z.object({ dealerId: z.string().min(1), monthRecoveryPlan: z.coerce.number().optional(), monthRunningRecovery: z.coerce.number().optional() })),
});
const weekBody = z.object({
  view: z.literal("week"),
  weekNo: z.coerce.number().int(),
  reason: z.string(),
  entries: z.array(z.object({ dealerId: z.string().min(1), weekRecoveryPlan: z.coerce.number().optional(), weekRunningRecovery: z.coerce.number().optional() })),
});
const bodySchema = z.discriminatedUnion("view", [monthBody, weekBody]);

/** Admin Override — correct INPUT fields of an APPROVED recovery plan (Month or Week). Super Admin only. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const body = bodySchema.parse(await req.json());
    if (body.view === "month") return ok(await adminEditRecoveryMonth(auth, id, body.entries, body.reason));
    return ok(await adminEditRecoveryWeek(auth, id, body.weekNo, body.entries, body.reason));
  });
}
