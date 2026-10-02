"use client";

import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerOrder } from "@/features/dealers/dealer-table-ui";
import Link from "next/link";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface RankItem {
  id: string;
  label: string;
  planAmount: number;
  actualAmount: number;
  achievementAmount: number;
  href?: string;
}

/** Reusable ranked list (Top / Lowest dealers or products). */
export function TopBottomRanking({
  title,
  rows,
  metric = "actual",
  dealerRows = false,
}: {
  title: string;
  rows: RankItem[];
  dealerRows?: boolean;
  /** Which figure to show on the right. */
  metric?: "actual" | "plan" | "achievement";
}) {
  const show = (r: RankItem) =>
    metric === "achievement"
      ? formatPercent(r.achievementAmount)
      : formatCurrency(metric === "plan" ? r.planAmount : r.actualAmount);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">No data.</p>
        ) : (
          <ul className="divide-y">
            <DealerOrder>{rows.map((r, i) => (
              <li key={r.id} data-dealer-id={dealerRows ? r.id : undefined} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 text-muted-foreground">{i + 1}</span>
                  {r.href ? (
                    <Link href={r.href} className="truncate text-primary hover:underline">
                      {dealerRows ? <DealerName id={r.id} name={r.label} /> : r.label}
                    </Link>
                  ) : (
                    <span className="truncate">{dealerRows ? <DealerName id={r.id} name={r.label} /> : r.label}</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{show(r)}</span>
              </li>
            ))}</DealerOrder>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
