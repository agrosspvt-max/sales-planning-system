"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { PerformanceTable } from "@/components/dashboard/performance-table";
import { TopBottomRanking } from "@/components/dashboard/top-bottom-ranking";
import { MonthlyTrend } from "@/components/dashboard/monthly-trend";
import { ApprovalSummary } from "@/components/dashboard/approval-summary";
import { ProfileHeaderFields } from "@/components/dashboard/profile-header";
import { QuickActions } from "@/components/dashboard/quick-actions";
import type { OfficerProfile } from "./types";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function SalesOfficerProfile({ officerId }: { officerId: string }) {
  const { data, isLoading, error } = useQuery<OfficerProfile>({
    queryKey: ["officer-profile", officerId],
    queryFn: () => api.get<OfficerProfile>(`/api/profiles/officer/${officerId}`),
  });

  if (isLoading) return <Skeleton className="h-72 w-full" />;
  if (error || !data)
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {(error as Error)?.message ?? "Could not load this Sales Officer."}
      </div>
    );

  const h = data.header;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Users", href: "/masters/users" }, { label: h.name }]}
        title={h.name}
        subtitle={
          <span className="flex items-center gap-2">
            {h.role} · {h.seasonName}
            <Badge variant="secondary">{h.planningStatus}</Badge>
          </span>
        }
      />

      <ProfileHeaderFields
        fields={[
          { label: "Role", value: h.role },
          { label: "Territory", value: h.territory },
          { label: "Regional Manager", value: h.regionalManager },
          { label: "Status", value: h.status },
          { label: "Season", value: h.seasonName },
          { label: "Assigned Dealers", value: String(h.assignedDealers) },
          { label: "Planning Status", value: h.planningStatus },
        ]}
      />

      <Section title="Quick Actions">
        <QuickActions actions={data.quickActions} />
      </Section>

      <KpiCards items={data.kpis} />

      <Section title="Dealer Performance">
        <PerformanceTable rows={data.dealers} labelHeader="Dealer" showStatus emptyText="No dealers planned this season." />
      </Section>

      <Section title="Top Performers">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <TopBottomRanking title="Top Dealers" rows={data.topDealers} metric="actual" />
          <TopBottomRanking title="Lowest Dealers" rows={data.lowestDealers} metric="achievement" />
          <TopBottomRanking title="Top Products" rows={data.topProducts} metric="actual" />
          <TopBottomRanking title="Lowest Products" rows={data.lowestProducts} metric="achievement" />
        </div>
      </Section>

      <Section title="Product Performance">
        <PerformanceTable rows={data.products} labelHeader="Product" emptyText="No products planned this season." />
        <div className="grid gap-3 md:grid-cols-3">
          <TopBottomRanking title="Highest Sales" rows={data.highestSalesProducts} metric="actual" />
          <TopBottomRanking title="Lowest Achievement" rows={data.lowestAchievementProducts} metric="achievement" />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Products Not Planned ({data.productsNotPlanned.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {data.productsNotPlanned.length === 0 ? (
                <p className="text-sm text-success">Every active product is planned.</p>
              ) : (
                <p className="text-sm text-muted-foreground">{data.productsNotPlanned.join(", ")}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Monthly Trend">
        <MonthlyTrend rows={data.monthly} />
      </Section>

      <Section title="Approvals">
        <ApprovalSummary data={data.approvals} />
      </Section>

      <Section title="History">
        <div className="grid gap-3 lg:grid-cols-3">
          <HistoryCard title="Import History">
            {data.history.imports.length === 0 ? (
              <Empty />
            ) : (
              data.history.imports.map((i) => (
                <Row key={i.id} left={i.workbookName} right={<Badge variant="muted">{i.status}</Badge>} sub={`${formatDate(i.createdAt)} · ${i.dealerCount} dealers · ${i.productRows} rows`} />
              ))
            )}
          </HistoryCard>
          <HistoryCard title="Plan Revisions">
            {data.history.revisions.length === 0 ? (
              <Empty />
            ) : (
              data.history.revisions.map((r) => (
                <Row key={r.id} left={`v${r.version}${r.versionName ? ` · ${r.versionName}` : ""}`} right={<Badge variant="secondary">{r.status}</Badge>} sub={`${r.source} · ${formatDate(r.createdAt)}`} />
              ))
            )}
          </HistoryCard>
          <HistoryCard title="Approval History">
            {data.history.approvals.length === 0 ? (
              <Empty />
            ) : (
              data.history.approvals.map((a) => (
                <Row key={a.id} left={`${a.action} — ${a.actorName}`} right={a.toStatus ? <Badge variant="secondary">{a.toStatus}</Badge> : null} sub={`${formatDate(a.createdAt)}${a.remarks ? ` · ${a.remarks}` : ""}`} />
              ))
            )}
          </HistoryCard>
        </div>
      </Section>
    </div>
  );
}

function HistoryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}
function Empty() {
  return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
}
function Row({ left, right, sub }: { left: string; right: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{left}</p>
        {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
      {right}
    </div>
  );
}
