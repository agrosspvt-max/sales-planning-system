import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { authorizeRevision } from "@/features/planning/service.server";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const newId = await authorizeRevision(auth, id);
    return ok({ id: newId }, 201);
  });
}
