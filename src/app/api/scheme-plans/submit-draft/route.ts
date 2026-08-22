import { type NextRequest } from "next/server";
import { handle, ok, requireAuth } from "@/lib/http";
import { submitSchemeDraft } from "@/features/schemes/scheme-planning.server";

/** Submit the scheme draft for RM approval (DRAFT → SUBMITTED after validation). */
export async function POST(req: NextRequest) {
  return handle(async () => ok(await submitSchemeDraft(await requireAuth(), await req.json())));
}
