import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { saveSchemeDraft } from "@/features/schemes/scheme-planning.server";

/** Save the Sales Officer's working scheme draft (selected dealers + expected billing dates). */
export async function POST(req: NextRequest) {
  return handle(async () => ok(await saveSchemeDraft(await requireAuth(), await req.json())));
}
