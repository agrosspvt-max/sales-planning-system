import { type NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { reconcileDueCnRequests } from "@/features/cn-requests/cn-expiry.server";

/**
 * Scheduled sweep (cron): records every CN Grace / Expired transition that is due even when nobody has opened the CN page. Authorized by the bearer secret in
 * CRON_SECRET (the header a platform cron sends); with no secret configured the endpoint stays closed. Idempotent — safe to call as often as needed.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = !!secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ reconciled: await reconcileDueCnRequests(null, new Date(), 500) });
}
