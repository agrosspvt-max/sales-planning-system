import { type NextRequest } from "next/server";
import { requirePartyAuth } from "@/lib/party-planning-access";
import { handle, ok } from "@/lib/http";
import { listPartyPlans } from "@/features/party-planning/service.server";

// GET /api/party-plans?view=editable|submitted|approved
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requirePartyAuth();
    const raw = req.nextUrl.searchParams.get("view");
    const view = raw === "submitted" || raw === "approved" ? raw : "editable";
    return ok(await listPartyPlans(auth, view));
  });
}
