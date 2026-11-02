"use client";

import type { QueryClient } from "@tanstack/react-query";

const CHANNEL = "planning-period-changed";
const PERIOD_QUERIES = new Set([
  "seasons",
  "season-months",
  "open-seasons",
  "plans",
  "plan",
  "plan-history",
  "monthly",
  "monthly-plan",
  "monthly-plans",
  "monthly-plan-history",
  "approved-monthly",
  "season-plan-months",
  "approvals",
  "group-product-plan",
  "group-recovery",
  "recovery-plan",
  "recovery-plans",
  "recovery-timeline",
  "recovery-history",
  "recovery-compare",
  "recovery-transfer-options",
  "seasonal-sheet",
  "seasonal-sheets",
  "seasonal-sheet-options",
  "seasonal-eligible-markets",
  "party-monthly-sheet",
  "party-monthly-sheets",
  "party-monthly-sheet-options",
  "sales-upload-months",
  "import-options",
  "report",
  "dashboard",
  "officer-plans",
  "officer-profile",
  "dealer-profile",
  "daily-work",
  "dealer-choices",
]);

/** A close/reopen refreshes only mounted period-dependent queries. Inactive pages become stale
 * and fetch on next open. Labels, notifications and other lookups are untouched; no new polling.
 */
export function refreshPlanningPeriods(client: QueryClient) {
  return client.invalidateQueries({
    predicate: (query) => PERIOD_QUERIES.has(String(query.queryKey[0])),
    refetchType: "active",
  });
}

export function announcePlanningPeriodChange(client: QueryClient) {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage("changed");
    channel.close();
  }
  return refreshPlanningPeriods(client);
}

/** Other logged-in tabs on this browser receive the change without an HTTP polling loop. */
export function listenForPlanningPeriodChanges(client: QueryClient): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    if (event.data === "changed") void refreshPlanningPeriods(client);
  };
  return () => channel.close();
}
