/**
 * Logical parent routes for the reusable BackButton.
 *
 * A page's "parent" is where Back should go — the business hierarchy, which does not
 * always match the URL. Defining it centrally (rather than hardcoding navigation in each
 * page) keeps Back behaviour consistent and lets pages stay declarative: they either rely
 * on this map or pass an explicit `backTo`. Anything without a mapped parent falls back to
 * `router.back()`.
 */
const PARENTS: Record<string, string> = {
  // Two-workspace planning lifecycle: Create Plan (drafts) and View Plans (approved).
  "/planning/sales": "/planning/create", // Sales Planning is opened from Create Plan
  "/planning/sales/plans": "/planning/view", // …and browsed from View Plans
  "/planning/sales/import": "/planning/create",
  "/planning/sales/workbook": "/planning/view",
  "/planning/sales/product-summary": "/planning/view",
  "/planning/sales/dealer-summary": "/planning/view",
  // Coming-soon modules live inside the Create Plan workspace.
  "/planning/recovery": "/planning/create",
  "/planning/scheme": "/planning/create",
  "/planning/party": "/planning/create",
  // Onboarding.
  "/onboarding/history": "/onboarding",
};

/**
 * Resolve the logical parent of a path, or `null` when there is none (Back should then
 * use browser history). Handles the dynamic Sales Plan detail route explicitly.
 */
export function routeParent(pathname: string): string | null {
  if (PARENTS[pathname]) return PARENTS[pathname];
  // A specific Sales Plan (/planning/<id>) logically returns to the plans list.
  if (pathname !== "/planning" && /^\/planning\/[^/]+$/.test(pathname)) {
    return "/planning/sales/plans";
  }
  return null;
}
