import { type NextRequest } from "next/server";
import { z } from "zod";
import { Role } from "@prisma/client";
import { handle, ok, requireAuth } from "@/lib/http";
import { promoteToRegionalManager, demoteToSalesOfficer } from "@/features/users/service.server";

const schema = z.object({ role: z.enum([Role.SALES_OFFICER, Role.REGIONAL_MANAGER]) });

/** Promote a Sales Officer to Regional Manager, or demote an RM back to Sales Officer. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const { role } = schema.parse(await req.json());
    return ok(
      role === Role.REGIONAL_MANAGER
        ? await promoteToRegionalManager(auth, id)
        : await demoteToSalesOfficer(auth, id),
    );
  });
}
