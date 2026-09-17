import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createCalendarNote } from "@/features/calendar/calendar.server";

/** Create a personal calendar note (owner = caller). */
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createCalendarNote(await requireAuth(), await req.json()), 201));
}
