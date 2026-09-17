import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { updateCalendarNote, deleteCalendarNote } from "@/features/calendar/calendar.server";

/** Edit a personal calendar note (owner only). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await updateCalendarNote(await requireAuth(), (await ctx.params).id, await req.json())));
}

/** Delete a personal calendar note (owner only). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await deleteCalendarNote(await requireAuth(), (await ctx.params).id)));
}
