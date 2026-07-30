import "server-only";
import type { AuthContext } from "@/lib/http";
import { getOfficerProfile } from "./officer.server";
import { getDealerProfile } from "./dealer.server";

/**
 * Reusable profile layer.
 *
 * Every analytical profile is a provider keyed by `type`, exposed under one route:
 *   GET /api/profiles/:type/:id
 * Adding a future profile (Regional Manager, Territory, Brand, Product) means registering
 * one provider here — no new route, no API redesign. Every provider is expected to build
 * from the same fact engine (computeFacts → groupFacts → monthlyRowsFromFacts).
 */
export type ProfileProvider = (ctx: AuthContext, id: string, seasonId?: string) => Promise<unknown>;

const PROVIDERS: Record<string, ProfileProvider> = {
  officer: (ctx, id, seasonId) => getOfficerProfile(ctx, id, seasonId),
  dealer: (ctx, id, seasonId) => getDealerProfile(ctx, id, seasonId),
  // Future: regional, territory, brand, product — register here.
};

export function getProfileProvider(type: string): ProfileProvider | undefined {
  return PROVIDERS[type];
}

export const PROFILE_TYPES = Object.keys(PROVIDERS);
