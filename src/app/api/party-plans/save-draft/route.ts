import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { saveDraft } from "@/features/party-planning/service.server";

// POST /api/party-plans/save-draft — persist the owner's editable set as DRAFT (atomic, multi-row).
export async function POST(req: NextRequest) {
  return handle(async () => {
    const auth = await requireAuth();
    return ok(await saveDraft(auth, await req.json()));
  });
}
