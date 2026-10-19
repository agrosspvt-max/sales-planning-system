"use client";

import { useMemo } from "react";
import { useDealerMarkers, useDealerNameResolver } from "@/features/dealers/dealer-name-ui";

const names = new Intl.Collator("en-IN", { sensitivity: "base", numeric: true });

/** The picker and summary share the displayed-name order; Legal dealers follow all others. */
export function useSeasonalDealerOrder<T extends { dealerId: string; dealerName: string }>(dealers: readonly T[]): T[] {
  const tags = useDealerMarkers();
  const resolveName = useDealerNameResolver();
  return useMemo(() => {
    const legal = (id: string) => tags[id]?.some((tag) => tag.name.trim().toLowerCase() === "legal") ?? false;
    return [...dealers].sort((a, b) =>
      Number(legal(a.dealerId)) - Number(legal(b.dealerId)) ||
      names.compare(resolveName(a.dealerId, a.dealerName).trim(), resolveName(b.dealerId, b.dealerName).trim()) ||
      a.dealerId.localeCompare(b.dealerId),
    );
  }, [dealers, tags, resolveName]);
}
