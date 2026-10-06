import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateCalendarEntry, deleteCalendarEntry } from "@/features/calendar/calendar.server";

/** Edit a Meeting / Reminder / Other (owner only). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await updateCalendarEntry(await requireAuth(), (await ctx.params).id, await req.json())));
}

/** Delete your own entry (a Daily Task already in Daily Work cannot be deleted here). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await deleteCalendarEntry(await requireAuth(), (await ctx.params).id)));
}
