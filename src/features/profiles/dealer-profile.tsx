"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { PerformanceTable } from "@/components/dashboard/performance-table";
import { MonthlyTrend } from "@/components/dashboard/monthly-trend";
import { ProfileHeaderFields } from "@/components/dashboard/profile-header";
import { QuickActions } from "@/components/dashboard/quick-actions";
import type { DealerProfile } from "./types";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function DealerProfileView({ dealerId }: { dealerId: string }) {
  const { data, isLoading, error } = useQuery<DealerProfile>({
    queryKey: ["dealer-profile", dealerId],
    queryFn: () => api.get<DealerProfile>(`/api/profiles/dealer/${dealerId}`),
  });

  if (isLoading) return <Skeleton className="h-72 w-full" />;
  if (error || !data)
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {(error as Error)?.message ?? "Could not load this dealer."}
      </div>
    );

  const h = data.header;
  const c = data.contribution;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Dealers", href: "/masters/dealers" }, { label: h.name }]}
        title={h.name}
        subtitle={
          <span className="flex items-center gap-2">
            {h.salesOfficer} · {h.seasonName}
            <Badge variant="secondary">{`Rank ${c.rank} of ${c.totalDealers}`}</Badge>
          </span>
        }
      />

      <ProfileHeaderFields
        fields={[
          { label: "Sales Officer", value: h.salesOfficer },
          { label: "Regional Manager", value: h.regionalManager },
          { label: "Territory", value: h.territory },
          { label: "Status", value: h.status },
          { label: "Season", value: h.seasonName },
        ]}
      />

      <Section title="Quick Actions">
        <QuickActions actions={data.quickActions} />
      </Section>

      <KpiCards items={data.kpis} />

      <Section title="Contribution">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Contribution to Officer" value={formatPercent(c.sharePct)} hint={`${formatCurrency(c.dealerPlanAmount)} of ${formatCurrency(c.officerPlanAmount)}`} />
          <Stat label="Dealer Rank" value={`${c.rank} of ${c.totalDealers}`} hint={`Among ${c.officerName}'s dealers`} />
          <Stat label="Sales Officer" value={c.officerName} />
        </div>
      </Section>

      <Section title="Product Performance">
        <PerformanceTable rows={data.products} labelHeader="Product" emptyText="No products planned for this dealer." />
      </Section>

      <Section title="Monthly Breakdown">
        <MonthlyTrend rows={data.monthly} />
      </Section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-lg font-semibold">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
