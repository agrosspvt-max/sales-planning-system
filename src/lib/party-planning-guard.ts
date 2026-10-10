import { NextResponse } from "next/server";
import { PARTY_PLANNING_UNAVAILABLE_MESSAGE, isPartyPlanningEnabled, isPartyPlanningPath } from "@/lib/feature-flags";

/**
 * Server-side enforcement of PARTY_PLANNING_ENABLED, run by the middleware for EVERY request (so no Party Planning page or API can be
 * reached by typing a URL or calling an endpoint, whatever the UI shows). Returns null when the request may proceed.
 *   - APIs → 503 JSON, uncacheable, so toggling the flag and redeploying takes effect immediately;
 *   - pages → the friendly "temporarily unavailable" page, rendered in place (503, uncacheable).
 * Other modules — including Territory Mapping — never match, so they are unaffected.
 */
export function partyPlanningGuard(pathname: string, requestUrl: string, env: Record<string, string | undefined> = process.env): NextResponse | null {
  if (!isPartyPlanningPath(pathname) || isPartyPlanningEnabled(env)) return null;
  const headers = { "Cache-Control": "no-store, max-age=0" };
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: PARTY_PLANNING_UNAVAILABLE_MESSAGE, code: "FEATURE_DISABLED" }, { status: 503, headers });
  return NextResponse.rewrite(new URL("/planning/party-unavailable", requestUrl), { status: 503, headers });
}
