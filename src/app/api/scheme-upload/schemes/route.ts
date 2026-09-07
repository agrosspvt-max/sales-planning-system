import { handle, ok, requireAuth } from "@/lib/http";
import { listSchemeUploadOptions } from "@/features/schemes/scheme-upload.server";

/** Schemes selectable for Scheme Upload (non-NONE, in scope). Admin-only (enforced in the service). */
export async function GET() {
  return handle(async () => ok(await listSchemeUploadOptions(await requireAuth())));
}
