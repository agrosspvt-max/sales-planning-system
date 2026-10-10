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
 */
export function isPartyPlanningEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["PARTY_PLANNING_ENABLED"]?.trim().toLowerCase() === "true";
}

export const PARTY_PLANNING_UNAVAILABLE_MESSAGE = "Party Planning is temporarily unavailable.";

/**
 * Whether a request path belongs to the Party Planning module: its pages (/planning/party and below) and its APIs (party plans, seasonal
 * plans / sheets, party monthly plans / sheets). Territory Mapping is deliberately outside it — its APIs live under /api/territory-mapping, its
 * standalone page is /planning/territory-mapping, and the old /planning/party/territory URL is only a redirect to it.
 */
export function isPartyPlanningPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === "/planning/party/territory") return false; // legacy bookmark → redirects to the standalone Territory Mapping page
  if (p === "/planning/party" || p.startsWith("/planning/party/")) return true;
  return /^\/api\/(party-plans|party-monthly-plans|party-monthly-sheets|seasonal-plans|seasonal-sheets)(\/|$)/.test(p);
}
