import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { calendarMonth } from "@/features/calendar/calendar.server";

/** One month of the operational calendar for the caller's scope. `officerId` (Admin/RM) narrows to one SO. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const now = new Date();
  const year = Number(p.get("year")) || now.getUTCFullYear();
  const monthRaw = Number(p.get("month"));
  const month = monthRaw >= 1 && monthRaw <= 12 ? monthRaw : now.getUTCMonth() + 1;
  const officerId = p.get("officerId") || undefined;
  return handle(async () => ok(await calendarMonth(await requireAuth(), { year, month, officerId })));
}
