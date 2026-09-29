import { type NextRequest } from "next/server";
import { getCnPaymentDetail, updateCnPayment } from "@/features/cn-requests/service.server";
import { handle, ok, requireAuth } from "@/lib/http";

export async function GET(_: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return ok(await getCnPaymentDetail(await requireAuth(), id));
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return ok(await updateCnPayment(await requireAuth(), id, await req.json()));
  });
}
