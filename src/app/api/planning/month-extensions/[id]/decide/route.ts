import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { decideMonthExtension } from "@/features/planning/month-extension.server";

const schema = z.object({ approve: z.boolean(), note: z.string().max(500).optional() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { approve, note } = schema.parse(await req.json());
    return ok(await decideMonthExtension(auth, id, approve, note));
  });
}
