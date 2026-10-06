import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createCalendarEntry } from "@/features/calendar/calendar.server";

/** Add a Daily Task / Meeting / Reminder / Other (owner = caller; a Daily Task later becomes a Daily Work row). */
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createCalendarEntry(await requireAuth(), await req.json()), 201));
}
