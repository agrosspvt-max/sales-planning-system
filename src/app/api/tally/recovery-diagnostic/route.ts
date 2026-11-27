import { handle, ok, requireAuth } from "@/lib/http";
import { getRecoveryDiagnostic } from "@/features/tally/recovery-diagnostic.server";

export async function GET(req: Request) {
  return handle(async () =>
    ok(
      await getRecoveryDiagnostic(
        await requireAuth(),
        Object.fromEntries(new URL(req.url).searchParams),
      ),
    ),
  );
}
