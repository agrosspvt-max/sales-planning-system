import { handle, ok, requireAuth } from "@/lib/http";
import { runningSchemes } from "@/features/schemes/scheme-planning.server";

/** OPEN schemes applicable to the caller's State (the Running Schemes tab). */
export async function GET() {
  return handle(async () => ok(await runningSchemes(await requireAuth())));
}
