/**
 * Simple env-based feature flags (server-side). Pattern mirrors the existing env switches
 * (e.g. TEMP_ADMIN_BYPASS): a flag is ON only when its env var is exactly "true".
 *
 * SCHEME_PLANNING_ENABLED — Scheme Planning is temporarily hidden in production while it is finished.
 *   Default (unset / anything but "true") = OFF → the Create/View Plans card shows "Coming Soon" and the
 *   /planning/scheme route renders a placeholder instead of the workspace. Set SCHEME_PLANNING_ENABLED=true
 *   locally to restore the full Scheme Planning UI. No backend, route, API or schema is affected by this.
 */
export const SCHEME_PLANNING_ENABLED = process.env.SCHEME_PLANNING_ENABLED === "true";

/**
 * PARTY_PLANNING_ENABLED — Party Planning (Seasonal / Monthly Planning and the legacy appointment plans) is switched by this
 * server-side variable. It FAILS CLOSED: only the exact value "true" (surrounding spaces / letter case ignored) enables it; unset,
 * empty or any other value ("1", "yes", a typo…) disables it. Production must set PARTY_PLANNING_ENABLED=false (or leave it unset)
 * explicitly; local development sets it to "true". Territory Mapping is NOT part of this flag. Nothing here touches data or permissions.
 *
 * The value is read on every call (never captured in a module constant), so it always reflects the running environment.
 * ONE helper, ONE runtime: the Create/View Plans card, the Party Planning pages (partyPlanningGate) and the Party Planning APIs
 * (requirePartyAuth) all call it in the Node server runtime. It is deliberately NOT checked in the edge middleware: the edge keeps a stale
 * snapshot of the environment after a `.env` reload, which made the routes say "unavailable" while the card said "enabled".
 */
export function isPartyPlanningEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["PARTY_PLANNING_ENABLED"]?.trim().toLowerCase() === "true";
}

export const PARTY_PLANNING_UNAVAILABLE_MESSAGE = "Party Planning is temporarily unavailable.";
