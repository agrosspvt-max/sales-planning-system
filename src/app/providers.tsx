"use client";

import { retryTransientOnce } from "@/lib/polling";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { LabelProvider } from "@/features/labels/label-ui";
import { DealerNameProvider } from "@/features/dealers/dealer-name-ui";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // retry: one extra attempt for a TEMPORARY failure only (refused requests are not repeated). A query that is in an error state refetches when
          // the window regains focus (healthy queries do not — unchanged); reconnecting the network refetches it too (React Query default).
          queries: { retry: retryTransientOnce, refetchOnWindowFocus: (query) => query.state.status === "error", staleTime: 30_000 },
        },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <DealerNameProvider>
          <LabelProvider>{children}</LabelProvider>
        </DealerNameProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
