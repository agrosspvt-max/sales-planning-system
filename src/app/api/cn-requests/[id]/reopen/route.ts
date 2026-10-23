import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { reopenCnRequest } from "@/features/cn-requests/cn-expiry.server";

// POST { expiryDate: "YYYY-MM-DD", reason, authorizedBy, fromCycle? } — Admin reopens an Expired CN into a new expiry/grace cycle (atomic, retry-safe).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await reopenCnRequest(auth, id, await req.json().catch(() => ({}))));
  });
}
