import { handle, ok, requireAuth } from "@/lib/http";
import { listOpenSeasonOptions } from "@/features/planning/service.server";

/** OPEN seasons (id, name, exact configured period, ordered months) offered by Create Seasonal Plan. Read-only. */
export async function GET() {
  return handle(async () => {
    await requireAuth();
    return ok(await listOpenSeasonOptions());
  });
}
