"use client";

import { createContext, useContext, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DealerMarkerMap } from "@/lib/dealer-tags";
import { pollingInterval } from "@/lib/polling";

type DealerNameFeed = { overrides: Record<string, string>; tags: DealerMarkerMap };

/** Dealers whose alias name or tag markers were added, changed or removed between two feeds. Pure, for tests. */
export function changedDealerIds(before: DealerNameFeed, after: DealerNameFeed): Set<string> {
  const out = new Set<string>();
  const diff = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) out.add(id);
  };
  diff(before.overrides, after.overrides);
  diff(before.tags as Record<string, unknown>, after.tags as Record<string, unknown>);
  return out;
}

/** Whether a cached query result shows one of these dealers (by id). A query without data yet is refreshed (it may show them once loaded). */
export function queryMentionsDealer(data: unknown, dealerIds: ReadonlySet<string>): boolean {
  if (data === undefined) return true;
  const text = JSON.stringify(data);
  for (const id of dealerIds) if (text.includes(`"${id}"`)) return true;
  return false;
}

/**
 * DEALER DISPLAY-NAME provider — the ONE client-side source for what a dealer is CALLED on screen.
 *
 * It loads batched alias-preferred name OVERRIDES and approved marker metadata (dealers that have an alias) and exposes a hook that maps a
 * Dealer.id to its display name, falling back to the dealer's own name when there is no alias. This is a pure
 * display layer: the dealer id remains the identity for every value/option/selection; nothing here changes a
 * dealer record, ownership, or the alias matching/import behaviour.
 */

interface DealerNameCtx {
  overrides: Record<string, string>;
  tags: DealerMarkerMap;
}
const Ctx = createContext<DealerNameCtx | null>(null);
const MarkerScope = createContext<DealerMarkerMap | null>(null);
const EMPTY_NAMES: Record<string, string> = {};
const EMPTY_TAGS: DealerMarkerMap = {};

export function DealerNameProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data } = useQuery<DealerNameFeed>({
    queryKey: ["dealer-display-names"],
    queryFn: () => api.get("/api/dealer-display-names"),
    // Polled while the tab is visible only. It loads every alias and the caller's tag markers, so it must not hammer a slow database: 30 s (was 15 s). A change the
    // user makes themselves refreshes immediately (refreshDealerTags), so only OTHER people's alias / tag changes arrive on the poll. While the server is failing the
    // poll backs off (capped) and keeps probing, so it resumes by itself.
    staleTime: 30_000,
    refetchInterval: pollingInterval(30_000),
  });
  // Lists / plans / reports whose server-side names or tag ORDER depend on this data refetch only when it actually CHANGED — never on its first arrival (those
  // screens already loaded their own alias-resolved names from the server, so refetching them then only doubled the page's heaviest request). React Query's structural sharing keeps an unchanged poll result the same object, so `data` changes only on real changes.
  const previous = useRef<DealerNameFeed | undefined>(undefined);
  useEffect(() => {
    if (!data) return;
    const before = previous.current;
    previous.current = data;
    if (!before || before === data) return;
    const changed = changedDealerIds(before, data);
    if (changed.size === 0) return;
    // Paginated dealer lists and reports order by tags across ALL pages, so a change anywhere can move rows onto the current page: they always refresh.
    void queryClient.invalidateQueries({ queryKey: ["resource", "dealers"] });
    void queryClient.invalidateQueries({ queryKey: ["report"] });
    // A plan holds all of its dealers, so only a plan that shows an affected dealer needs its server-resolved names again.
    void queryClient.invalidateQueries({ queryKey: ["plan"], predicate: (query) => queryMentionsDealer(query.state.data, changed) });
  }, [data, queryClient]);
  const overrides = data?.overrides ?? EMPTY_NAMES;
  const tags = data?.tags ?? EMPTY_TAGS;
  const value = useMemo<DealerNameCtx>(() => ({ overrides, tags }), [overrides, tags]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Resolve one dealer's display name: the alias override when the dealer has one, else the given fallback
 * (the real Dealer.name). Safe outside the provider (returns the fallback). Never returns an id.
 */
export function useDealerDisplayName(
  dealerId: string | null | undefined,
  fallbackName: string,
): string {
  const ctx = useContext(Ctx);
  if (!dealerId) return fallbackName;
  return ctx?.overrides[dealerId] ?? fallbackName;
}

/**
 * Returns a resolver `(dealerId, fallbackName) => displayName` for use inside `.map`/render loops where a hook
 * per row is not possible. The identity stays the id; only the shown string changes.
 */
export function useDealerNameResolver(): (
  dealerId: string | null | undefined,
  fallbackName: string,
) => string {
  const ctx = useContext(Ctx);
  return useMemo(() => {
    const overrides = ctx?.overrides ?? {};
    return (dealerId: string | null | undefined, fallbackName: string) =>
      dealerId ? (overrides[dealerId] ?? fallbackName) : fallbackName;
  }, [ctx?.overrides]);
}

/** Inline display-name text component. `<DealerName id={dealerId} name={dealer.name} />` */
export function DealerName({
  id,
  name,
}: {
  id: string | null | undefined;
  name: string;
}): ReactNode {
  const displayName = useDealerDisplayName(id, name);
  const tags = useDealerMarkers();
  return (
    <>
      {displayName}
      {id &&
        tags[id]?.map((tag) => (
          <span
            key={tag.id}
            title={tag.name}
            aria-label={tag.name}
            className={
              tag.markerType === "TEXT"
                ? "ml-1 inline-flex rounded-full border px-1.5 py-0.5 align-middle text-[10px] font-medium leading-none"
                : "ml-1 inline-block align-middle"
            }
          >
            {tag.marker}
          </span>
        ))}
    </>
  );
}

export function useDealerMarkers(): DealerMarkerMap {
  const scoped = useContext(MarkerScope);
  const global = useContext(Ctx);
  return scoped ?? global?.tags ?? EMPTY_TAGS;
}

/** An authorized plan carries its own approved tags, so late/failed global metadata cannot hide them. */
export function DealerMarkerScope({ tags, children }: { tags?: DealerMarkerMap; children: ReactNode }) {
  return <MarkerScope.Provider value={tags ?? null}>{children}</MarkerScope.Provider>;
}

/** Native option elements accept text only; the same markers follow the same resolved name. */
export function DealerOptionName({ id, name }: { id: string; name: string }): string {
  const displayName = useDealerDisplayName(id, name);
  const tags = useDealerMarkers();
  return (
    displayName +
    (tags[id]?.map((t) => (t.markerType === "TEXT" ? ` [${t.marker}]` : ` ${t.marker}`)).join("") ??
      "")
  );
}
