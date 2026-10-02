import type { QueryClient } from "@tanstack/react-query";
/** Refresh only tag metadata and dealer lists whose server-side order depends on it. */
export async function refreshDealerTags(client: QueryClient) {
  await Promise.all(
    [["dealer-tags"], ["dealer-display-names"], ["resource", "dealers"], ["report"]].map(
      (queryKey) => client.invalidateQueries({ queryKey }),
    ),
  );
}
