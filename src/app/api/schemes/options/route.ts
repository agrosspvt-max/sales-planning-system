import { handle, ok, requireAuth } from "@/lib/http";
import { schemeStateOptions } from "@/features/schemes/scheme-master.server";

export async function GET() {
  return handle(async () => { await requireAuth(); return ok(await schemeStateOptions()); });
}
