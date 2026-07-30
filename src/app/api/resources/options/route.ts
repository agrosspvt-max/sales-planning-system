import { handle, ok, requireAuth } from "@/lib/http";
import { loadOptions } from "@/features/resources/service.server";

export async function GET() {
  return handle(async () => {
    await requireAuth();
    return ok(await loadOptions());
  });
}
