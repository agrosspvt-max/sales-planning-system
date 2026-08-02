"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { MonthlyEditProvider } from "./monthly-edit-context";
import { MonthlyPlanner } from "./monthly-planner";
import { MonthlyProductPlan } from "./monthly-product-plan";
import { MonthlyDealerSummary } from "./monthly-dealer-summary";
import { MonthlyPlanActions } from "./monthly-plan-actions";
import { StatusBadge } from "./status-badge";
import type { MonthlyData, PlanStatus, TimelineItem } from "./types";

type Tab = "dealer" | "product" | "dealer-summary" | "history";

type MonthlyPlanDetail = MonthlyData & {
  monthlyPlanId: string;
  status: PlanStatus;
  monthName: string;
  officerId: string;
};

const ACTION_LABELS: Record<string, string> = {
  SUBMIT: "Submitted",
  RECALL: "Recalled",
  APPROVE: "Approved",
  RETURN: "Returned",
  REJECT: "Rejected",
};

/**
 * First-class Monthly Plan workspace — one month of an approved seasonal plan with its own
 * approval lifecycle. Reuses the shared monthly-edit context, planner and read-only views;
 * there is NO in-page month selector (the month is fixed at creation).
 */
export function MonthlyPlanWorkspace({
  monthlyPlanId,
  role,
  userId,
}: {
  monthlyPlanId: string;
  role: Role;
  userId: string;
}) {
  const [tab, setTab] = useState<Tab>("dealer");
  const { data, isLoading } = useQuery<MonthlyPlanDetail>({
    queryKey: ["monthly-plan", monthlyPlanId],
    queryFn: () => api.get(`/api/planning/monthly-plans/${monthlyPlanId}`),
  });

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const tabs: { key: Tab; label: string }[] = [
    { key: "dealer", label: "Dealer Monthly Plan" },
    { key: "product", label: "Monthly Product Plan" },
    { key: "dealer-summary", label: "Monthly Dealer Summary" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        backTo="/planning/sales"
        crumbs={[
          { label: "Planning" },
          { label: "Create New Plan", href: "/planning/sales" },
          { label: data.seasonName },
          { label: `Monthly · ${data.monthName}` },
        ]}
        title={`${data.seasonName} — ${data.monthName}`}
        subtitle="Monthly Plan. Fill monthly plans and record actual sales; Product Plan and Dealer Summary update live."
        actions={<StatusBadge status={data.status} />}
      />

      <MonthlyPlanActions
        monthlyPlanId={monthlyPlanId}
        status={data.status}
        officerId={data.officerId}
        role={role}
        userId={userId}
        remainingCount={data.dealers.filter((d) => !d.noPlan && !d.completed).length}
        totalDealers={data.dealers.length}
        noPlanDealers={data.dealers.filter((d) => d.noPlan).map((d) => ({ dealerId: d.dealerId, dealerName: d.dealerName, noPlanReason: d.noPlanReason ?? null }))}
      />

      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <MonthlyEditProvider
        planId={data.planId}
        monthlyPlanId={monthlyPlanId}
        data={data}
        saveUrl={`/api/planning/monthly-plans/${monthlyPlanId}`}
        invalidateKey={["monthly-plan", monthlyPlanId]}
      >
        <div className={tab === "dealer" ? "" : "hidden"}>
          <MonthlyPlanner />
        </div>
        {tab === "product" && <MonthlyProductPlan />}
        {tab === "dealer-summary" && <MonthlyDealerSummary />}
      </MonthlyEditProvider>
      {tab === "history" && <MonthlyPlanTimeline monthlyPlanId={monthlyPlanId} />}
    </div>
  );
}

function MonthlyPlanTimeline({ monthlyPlanId }: { monthlyPlanId: string }) {
  const { data, isLoading } = useQuery<{ timeline: TimelineItem[] }>({
    queryKey: ["monthly-plan-history", monthlyPlanId],
    queryFn: () => api.get(`/api/planning/monthly-plans/${monthlyPlanId}/history`),
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.timeline.length === 0) return <p className="text-sm text-muted-foreground">No actions yet.</p>;
  return (
    <ol className="space-y-3 border-l pl-4">
      {data.timeline.map((t) => (
        <li key={t.id} className="relative">
          <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-primary" />
          <div className="text-sm">
            <span className="font-medium">{ACTION_LABELS[t.action] ?? t.action}</span> by {t.actorName}
            <span className="ml-2 text-xs text-muted-foreground">{formatDate(t.createdAt)}</span>
          </div>
          {t.remarks && <p className="text-sm text-muted-foreground">“{t.remarks}”</p>}
        </li>
      ))}
    </ol>
  );
}
