import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { getDealerChoices } from "@/features/daily-work/service.server";

// GET /api/daily-work/dealer-choices?section=SALES|RECOVERY[&ownerId=] — the Add Dealer list for ONE owner (the caller by default; a Regional Manager may pick an authorized Sales Officer).
export async function GET(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    const p = req.nextUrl.searchParams;
    return ok(await getDealerChoices(auth, p.get("section") ?? "SALES", p.get("ownerId")));
  });
}
