import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { scheduleCnTask } from "@/features/cn-requests/service.server";

// POST /api/cn-requests/:id/task-date — the owning SO schedules/reschedules/un-schedules the CN follow-up
// task's Daily Work date. Only taskDate changes; the CN status/amount/reason are never touched.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    return ok(await scheduleCnTask(auth, id, await req.json()));
  });
}
