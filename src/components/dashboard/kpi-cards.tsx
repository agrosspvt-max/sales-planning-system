"use client";

import { Card, CardContent } from "@/components/ui/card";

export interface KpiItem {
  label: string;
  value: string;
  hint?: string;
}

/** Reusable KPI grid — used by Company, RM, Sales Officer and Dealer dashboards. */
export function KpiCards({ items }: { items: KpiItem[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((k) => (
        <Card key={k.label}>
          <CardContent className="pt-5">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{k.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{k.value}</p>
            {k.hint && <p className="mt-0.5 text-xs text-muted-foreground">{k.hint}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
