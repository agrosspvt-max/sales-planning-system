import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { ownLateReportRequestStatus } from "@/features/daily-work/report-policy.server";

export async function GET(req: NextRequest) {
  return handle(async () => ok(await ownLateReportRequestStatus(await requireAuth(), req.nextUrl.searchParams.get("date"))));
}
