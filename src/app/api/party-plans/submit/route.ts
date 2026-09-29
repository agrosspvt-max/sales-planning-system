import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitDraft } from "@/features/party-planning/service.server";

// POST /api/party-plans/submit — validate + move the owner's editable set to PENDING_APPROVAL (atomic).
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await submitDraft(auth, await req.json()));
  });
}
