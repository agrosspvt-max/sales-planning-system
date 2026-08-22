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
