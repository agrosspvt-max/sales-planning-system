"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLabel } from "@/features/labels/label-ui";
import type { UpcomingItem } from "@/features/calendar/calendar.server";

const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (dk: string) => { const [, m, d] = dk.split("-").map(Number); return `${d} ${MON3[m - 1]}`; };

/**
 * Dashboard "Upcoming — Next 5 Days" card. Reuses /api/calendar/upcoming (scoped server-side), showing only
 * future conversions + notes. Conversions link to Scheme Planning; notes link to the calendar.
 */
export function UpcomingCard() {
  const { data, isLoading } = useQuery<UpcomingItem[]>({ queryKey: ["calendar-upcoming"], queryFn: () => api.get("/api/calendar/upcoming") });
  const L = {
    title: useLabel("calendar.upcoming_days"),
    none: useLabel("calendar.no_upcoming"),
    conversion: useLabel("calendar.conversion"),
    note: useLabel("calendar.note"),
    scheme: useLabel("calendar.scheme"),
    schemes: useLabel("calendar.schemes"),
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{L.title}</h2>
          <Link href="/planning/calendar" className="text-xs text-primary hover:underline">{useLabel("calendar.title")}</Link>
        </div>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">{L.none}</p>
        ) : (
          <ul className="space-y-2">
            {data!.map((it, i) => (
              <li key={i} className="flex items-start gap-3 border-b pb-2 text-sm last:border-0 last:pb-0">
                <span className="w-12 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground tabular-nums">{shortDate(it.dateKey)}</span>
                {it.kind === "CONVERSION" && it.event ? (
                  <Link href="/planning/scheme/plans" className="min-w-0 flex-1 hover:underline">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{L.conversion}</div>
                    <div className="truncate font-medium">{it.event.dealerName}</div>
                    <div className="text-xs text-muted-foreground">{it.event.numberOfSchemes} {it.event.numberOfSchemes === 1 ? L.scheme : L.schemes} · {formatCurrency(it.event.totalSchemeAmount)}</div>
                  </Link>
                ) : it.note ? (
                  <Link href="/planning/calendar" className="min-w-0 flex-1 hover:underline">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{L.note}</div>
                    <div className="truncate">{it.note.text}</div>
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
