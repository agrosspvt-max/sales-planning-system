import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { verifyCnPayment } from "@/features/cn-requests/service.server";

// POST /api/cn-requests/:id/verify — Admin verifies/overrides the SO-reported payment status (authoritative).
// Admin selects only the status (+ Amount Paid for Partial); dates are never chosen by the Admin.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await verifyCnPayment(auth, id, await req.json()));
  });
}
