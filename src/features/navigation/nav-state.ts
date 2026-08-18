import type { NavItem } from "./nav";

/**
 * Centralized sidebar navigation state (single source of truth).
 *
 * The previous sidebar used a broad `pathname.startsWith(href + "/")` test per item.
 * In a flat item list that lights up EVERY ancestor prefix at once — e.g. on
 * `/planning/sales/workbook` the items `/planning`, `/planning/sales` and
 * `/planning/sales/workbook` all matched, so three rows appeared "selected".
 *
 * This module computes the active state in ONE place and returns it for the sidebar to
 * reuse. The rule: the active leaf is the item whose href is the *longest* match for the
 * current path (exact match, else the deepest prefix). That guarantees exactly one leaf
 * is ever selected. The group that contains it is the "expanded section" — a distinct
 * concept from the selected page, and styled differently.
 */
export interface NavState {
  /** The single selected leaf. `null` when no nav item owns the current path. */
  activeHref: string | null;
  /** The group that contains the active leaf — the section to expand. `null` if none. */
  activeGroup: string | null;
}

/** True when `href` equals `pathname` or is a path-segment prefix of it. */
function matchesPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * Resolve the active leaf + its group from the current pathname.
 * Longest matching href wins, so only one leaf is ever active.
 */
export function resolveNavState(pathname: string, items: NavItem[]): NavState {
  // Flatten to leaves: an item with children is an expandable parent (a toggle, never a selectable
  // leaf), so its children participate in matching instead of the parent.
  const leaves: NavItem[] = [];
  for (const item of items) {
    if (item.children && item.children.length) leaves.push(...item.children);
    else leaves.push(item);
  }
  let best: NavItem | null = null;
  for (const item of leaves) {
    if (!matchesPath(pathname, item.href)) continue;
    if (!best || item.href.length > best.href.length) best = item;
  }
  return {
    activeHref: best?.href ?? null,
    activeGroup: best?.group ?? null,
  };
}
