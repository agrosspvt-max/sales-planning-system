import { type NextRequest } from "next/server";
import { handle, ok, requireAuth, ApiError } from "@/lib/http";
import { deleteDealerAlias, updateSingleAlias } from "@/features/sales-upload/alias.server";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await deleteDealerAlias(auth, id));
  });
}

/** Edit an existing alias's Tally name in place. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const body = await req.json();
    const tallyName = typeof body?.tallyName === "string" ? body.tallyName : "";
    if (!tallyName.trim()) throw new ApiError(422, "Tally name is required");
    return ok(await updateSingleAlias(auth, id, tallyName));
  });
}
