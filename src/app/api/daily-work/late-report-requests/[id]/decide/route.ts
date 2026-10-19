import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { decideLateReport } from "@/features/daily-work/service.server";

// POST { action: "approve" | "reject", reason? } — the first valid decision resolves the request; a stale second one is refused (409).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => ok(await decideLateReport(await requireAuth(), (await params).id, await req.json())));
}
