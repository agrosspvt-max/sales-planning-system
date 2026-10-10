import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createDealerStatusRequest, listDealerStatusRequests } from "@/features/party-planning/territory.server";

// GET ?view=pending|resolved (Admin) · POST { dealerId, reason, description? } (SO / RM, within their dealers)
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await listDealerStatusRequests(ctx, req.nextUrl.searchParams.get("view") === "resolved" ? "resolved" : "pending"));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createDealerStatusRequest(await requireAuth(), await req.json())));
}
