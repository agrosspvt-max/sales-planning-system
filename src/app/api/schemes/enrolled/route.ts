import { handle, ok, requireAuth } from "@/lib/http";
import { enrolledSchemes } from "@/features/schemes/scheme-enrolled.server";

/** Schemes with at least one enrolled dealer in the caller's scope (Enrolled Scheme list). */
export async function GET() {
  return handle(async () => ok(await enrolledSchemes(await requireAuth())));
}
