import { handle, ok, requireAuth } from "@/lib/http";
import { assertEnabled, assertSuper, status } from "@/features/tally/service.server";
export async function GET() {
  return handle(async () => {
    assertEnabled();
    assertSuper(await requireAuth());
    return ok(await status());
  });
}
