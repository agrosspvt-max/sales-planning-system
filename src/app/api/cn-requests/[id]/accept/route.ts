import { type NextRequest } from "next/server";
import { acceptCnRequest } from "@/features/cn-requests/service.server";
import { handle, ok, requireAuth } from "@/lib/http";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const form = await req.formData();
    const file = form.get("file");
    return ok(await acceptCnRequest(
      auth,
      id,
      {
        status: String(form.get("status") ?? ""),
        reason: String(form.get("reason") ?? "") || undefined,
        acceptanceReasonDetails: String(form.get("acceptanceReasonDetails") ?? "") || undefined,
        cnExpiryDays: String(form.get("cnExpiryDays") ?? "") || undefined,
        postedAmount: String(form.get("postedAmount") ?? "") || undefined,
        outstandingAmount: String(form.get("outstandingAmount") ?? "") || undefined,
      },
      file instanceof File ? {
        name: file.name,
        type: file.type,
        buffer: Buffer.from(await file.arrayBuffer()),
      } : null,
    ));
  });
}
