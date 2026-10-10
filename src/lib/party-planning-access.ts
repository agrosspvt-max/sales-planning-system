import { ApiError, requireAuth } from "@/lib/http";
import { PARTY_PLANNING_UNAVAILABLE_MESSAGE, isPartyPlanningEnabled } from "@/lib/feature-flags";

/**
 * Server-side enforcement of PARTY_PLANNING_ENABLED for Party Planning APIs. It runs in the SAME Node runtime — and so reads the SAME live
 * environment — as the Create/View Plans card and the Party Planning pages (`partyPlanningGate`). It deliberately does NOT live in the edge
 * middleware: the edge runtime keeps its own snapshot of the environment, which stayed stale after a `.env` reload and kept answering
 * "unavailable" while the card (Node) already said "enabled".
 * Disabled → 503 (via the normal `handle()` error path), before authentication or any data access. Enabled → exactly `requireAuth()`.
 */
export function assertPartyPlanningEnabled(env: Record<string, string | undefined> = process.env): void {
  if (!isPartyPlanningEnabled(env)) throw new ApiError(503, PARTY_PLANNING_UNAVAILABLE_MESSAGE);
}
/** `requireAuth()` for a Party Planning API route: the flag first, then the unchanged authentication / authorization. */
export async function requirePartyAuth() {
  assertPartyPlanningEnabled();
  return requireAuth();
}
