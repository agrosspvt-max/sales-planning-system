"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { Category } from "@/lib/product-category";

/** Active categories (id, name, nbvPercent, notation, color) — cached; drives badges + filters. */
export function useCategories() {
  const { data } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/api/categories"),
    staleTime: 5 * 60 * 1000,
  });
  return data ?? [];
}
