import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { calendarMonth } from "@/features/calendar/calendar.server";

/** One month of the operational calendar for the caller's scope. `view` (RM: mine | team), `groupId` (State) and `officerId` only narrow the caller's own scope. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const now = new Date();
  const year = Number(p.get("year")) || now.getUTCFullYear();
  const monthRaw = Number(p.get("month"));
  const month = monthRaw >= 1 && monthRaw <= 12 ? monthRaw : now.getUTCMonth() + 1;
  const officerId = p.get("officerId") || undefined;
  const groupId = p.get("groupId") || undefined; // State filter — only ever narrows the caller's scope (enforced in the service)
  const view = p.get("view") === "mine" ? "mine" : p.get("view") === "team" ? "team" : undefined;
  return handle(async () => ok(await calendarMonth(await requireAuth(), { year, month, officerId, view, groupId })));
}
