import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listLateReportRequests, requestLateReport } from "@/features/daily-work/service.server";

// GET ?view=pending|history — reviewers (an RM for their team's Sales Officers; an authorized admin). POST { workDate, reason } — a Sales Officer asks to submit THEIR OWN overdue report.
export async function GET(req: NextRequest) {
  return handle(async () => ok(await listLateReportRequests(await requireAuth(), req.nextUrl.searchParams.get("view"))));
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await requestLateReport(await requireAuth(), await req.json())));
}
