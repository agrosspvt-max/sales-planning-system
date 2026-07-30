import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { setMonthStatus } from "@/features/planning/planning-state.server";

const schema = z.object({ status: z.enum(["LOCKED", "OPEN", "CLOSED"]) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth(); // setMonthStatus enforces Super-Admin
    const { id } = await ctx.params;
    const { status } = schema.parse(await req.json());
    return ok(await setMonthStatus(auth, id, status));
  });
}
