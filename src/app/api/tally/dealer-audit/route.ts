import { handle, ok, requireAuth } from "@/lib/http";
import { dealerAuditStatus } from "@/features/tally/dealer-audit.server";

export async function GET() {
  return handle(async () => ok(await dealerAuditStatus(await requireAuth())));
}
