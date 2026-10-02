"use client";

import { createContext, useContext, useMemo, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DealerMarkerMap } from "@/lib/dealer-tags";

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
const EMPTY_NAMES: Record<string, string> = {};
const EMPTY_TAGS: DealerMarkerMap = {};

export function DealerNameProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ overrides: Record<string, string>; tags: DealerMarkerMap }>({
    queryKey: ["dealer-display-names"],
    queryFn: () => api.get("/api/dealer-display-names"),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  // Paginated dealer lists must refetch their complete server ordering when metadata changes;
  // reordering only an already-loaded page would miss tagged dealers on other pages.
  // React Query's structural sharing keeps unchanged responses stable between polling ticks.
  useEffect(() => {
    if (!data) return;
    void queryClient.invalidateQueries({ queryKey: ["resource", "dealers"] });
    void queryClient.invalidateQueries({ queryKey: ["report"] });
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
  return useContext(Ctx)?.tags ?? EMPTY_TAGS;
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
