import { handle, ok, requireAuth } from "@/lib/http";
import { dealerAuditStatus, requestDealerAudit } from "@/features/tally/dealer-audit.server";
import { sameOrigin } from "@/features/tally/service.server";

export async function GET() {
  return handle(async () => ok(await dealerAuditStatus(await requireAuth())));
}

export async function POST(req: Request) {
  return handle(async () => {
    sameOrigin(req);
    return ok(await requestDealerAudit(await requireAuth()));
  });
}
