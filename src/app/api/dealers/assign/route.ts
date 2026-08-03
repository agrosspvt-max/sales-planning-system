import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAuth } from "@/lib/http";
import { assignExistingDealer } from "@/features/planning/monthly-plan.server";

const schema = z.object({ dealerId: z.string().min(1), officerId: z.string().min(1) });

/** Admin shortcut from the duplicate dialog: assign an existing dealer to a Sales Officer. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const { dealerId, officerId } = schema.parse(await req.json());
    return ok(await assignExistingDealer(auth, dealerId, officerId));
  });
}
