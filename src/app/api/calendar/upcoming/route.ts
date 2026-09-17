import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { calendarUpcoming } from "@/features/calendar/calendar.server";

/** Upcoming conversions + notes for the caller's scope (default next 5 days, future-only). */
export async function GET(req: NextRequest) {
  const d = Number(req.nextUrl.searchParams.get("days"));
  const days = d >= 1 && d <= 31 ? d : 5;
  return handle(async () => ok(await calendarUpcoming(await requireAuth(), days)));
}
