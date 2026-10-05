import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { verifyCnPayment } from "@/features/cn-requests/service.server";

// POST /api/cn-requests/:id/verify — Admin verifies/overrides the SO-reported payment status (authoritative).
// Admin selects only the status (+ Amount Paid for Partial); dates are never chosen by the Admin.
// JSON for Not Paid / Partial Paid. Paid on a CN Working Shared request is multipart so the required Final CN file
// travels in the same request as the verification.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      return ok(await verifyCnPayment(
        auth,
        id,
        {
          status: String(form.get("status") ?? ""),
          amountPaid: String(form.get("amountPaid") ?? "") || undefined,
          requestKey: String(form.get("requestKey") ?? ""),
        },
        file instanceof File ? { name: file.name, type: file.type, buffer: Buffer.from(await file.arrayBuffer()) } : null,
      ));
    }
    return ok(await verifyCnPayment(auth, id, await req.json()));
  });
}
