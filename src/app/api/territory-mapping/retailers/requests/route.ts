import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { createRetailerRequest, listMyRetailerRequests, listRetailerRequestsForReview } from "@/features/party-planning/retailer.server";

// GET ?scope=mine (SO / RM: own submissions + status) · GET ?view=pending|resolved (Admin review) · POST { retailerName, firmName, phone, dealerIds, submissionKey } (SO / RM)
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAuth();
    const q = req.nextUrl.searchParams;
    if (q.get("scope") === "mine") return ok(await listMyRetailerRequests(ctx));
    return ok(await listRetailerRequestsForReview(ctx, q.get("view") === "resolved" ? "resolved" : "pending"));
  });
}
export async function POST(req: NextRequest) {
  return handle(async () => ok(await createRetailerRequest(await requireAuth(), await req.json().catch(() => ({})))));
}
