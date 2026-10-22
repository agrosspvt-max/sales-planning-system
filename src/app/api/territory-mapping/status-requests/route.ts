import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createDealerStatusRequest, listDealerStatusRequestsFiltered } from "@/features/party-planning/territory.server";

// GET ?view=pending|resolved[&requesterId=…] (Admin) · POST { dealerId, reason, description? } (SO / RM, within their dealers)
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const q = req.nextUrl.searchParams;
    return ok(await listDealerStatusRequestsFiltered(ctx, q.get("view") === "resolved" ? "resolved" : "pending", { requesterIds: q.getAll("requesterId") }));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createDealerStatusRequest(await requireAuth(), await req.json())));
}
