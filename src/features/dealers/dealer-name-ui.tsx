"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * DEALER DISPLAY-NAME provider — the ONE client-side source for what a dealer is CALLED on screen.
 *
 * It loads the alias-preferred name OVERRIDES once (dealers that have an alias) and exposes a hook that maps a
 * Dealer.id to its display name, falling back to the dealer's own name when there is no alias. This is a pure
 * display layer: the dealer id remains the identity for every value/option/selection; nothing here changes a
 * dealer record, ownership, or the alias matching/import behaviour.
 */

interface DealerNameCtx {
  overrides: Record<string, string>;
}
const Ctx = createContext<DealerNameCtx | null>(null);

export function DealerNameProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery<{ overrides: Record<string, string> }>({
    queryKey: ["dealer-display-names"],
    queryFn: () => api.get("/api/dealer-display-names"),
    staleTime: 5 * 60_000,
  });
  const overrides = data?.overrides ?? {};
  const value = useMemo<DealerNameCtx>(() => ({ overrides }), [overrides]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Resolve one dealer's display name: the alias override when the dealer has one, else the given fallback
 * (the real Dealer.name). Safe outside the provider (returns the fallback). Never returns an id.
 */
export function useDealerDisplayName(dealerId: string | null | undefined, fallbackName: string): string {
  const ctx = useContext(Ctx);
  if (!dealerId) return fallbackName;
  return ctx?.overrides[dealerId] ?? fallbackName;
}

/**
 * Returns a resolver `(dealerId, fallbackName) => displayName` for use inside `.map`/render loops where a hook
 * per row is not possible. The identity stays the id; only the shown string changes.
 */
export function useDealerNameResolver(): (dealerId: string | null | undefined, fallbackName: string) => string {
  const ctx = useContext(Ctx);
  return useMemo(() => {
    const overrides = ctx?.overrides ?? {};
    return (dealerId: string | null | undefined, fallbackName: string) =>
      dealerId ? overrides[dealerId] ?? fallbackName : fallbackName;
  }, [ctx?.overrides]);
}

/** Inline display-name text component. `<DealerName id={dealerId} name={dealer.name} />` */
export function DealerName({ id, name }: { id: string | null | undefined; name: string }): ReactNode {
  return useDealerDisplayName(id, name);
}
