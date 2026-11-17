import { handle, ok } from "@/lib/http";
import { dealerAuditAgent, DEALER_AUDIT_BYTES } from "@/features/tally/dealer-audit.server";
import { readBody } from "@/features/tally/service.server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  return handle(async () =>
    ok(await dealerAuditAgent(req, await readBody(req, DEALER_AUDIT_BYTES))),
  );
}
