import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { recipientDealers } from "@/features/calendar/calendar.server";

/** Admin only: the dealers of the Sales Officer a task is being assigned to (the officer's own scope — never the Admin's). */
export async function GET(req: NextRequest) {
  return handle(async () => ok(await recipientDealers(await requireAuth(), req.nextUrl.searchParams.get("ownerId") ?? "")));
}
