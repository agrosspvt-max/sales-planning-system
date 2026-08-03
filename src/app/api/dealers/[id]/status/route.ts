import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { activateDealer, deactivateDealer } from "@/features/dealers/manage.server";

const schema = z.object({ active: z.boolean() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { active } = schema.parse(await req.json());
    return ok(active ? await activateDealer(auth, id) : await deactivateDealer(auth, id));
  });
}
