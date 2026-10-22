import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { listMarketFilterChoices } from "@/features/party-planning/territory.server";

// GET ?state=&officer= — the Market filter choices for the chosen State / Sales Officer (inside the caller's scope; a parent filter only narrows).
export async function GET(req: NextRequest) {
  return handle(async () => {
    const q = req.nextUrl.searchParams;
    return ok(await listMarketFilterChoices(await requireAuth(), { officer: q.get("officer") ?? undefined, state: q.get("state") ?? undefined }));
  });
}
