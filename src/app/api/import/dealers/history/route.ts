import { handle, ok, requireAuth } from "@/lib/http";
import { listImportHistory } from "@/features/import/dealers/service.server";

export async function GET() {
  return handle(async () => {
    const ctx = await requireAuth();
    return ok(await listImportHistory(ctx));
  });
}
