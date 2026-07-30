"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { PlanHistory } from "./plan-history";
import { MonthlyEditProvider, useMonthlyData } from "./monthly-edit-context";
import { MonthlyPlanner } from "./monthly-planner";
import { MonthlyProductPlan } from "./monthly-product-plan";
import { MonthlyDealerSummary } from "./monthly-dealer-summary";

type Tab = "dealer" | "product" | "dealer-summary" | "history";

/**
 * Monthly Planning workspace — the post-approval lifecycle, separate from the Seasonal
 * draft. Dealer Monthly Plan is editable; Monthly Product Plan and Monthly Dealer Summary
 * are read-only and update live from the shared monthly-edit context.
 */
export function MonthlyWorkspace({ planId }: { planId: string }) {
  const { data, isLoading } = useMonthlyData(planId);
  const [tab, setTab] = useState<Tab>("dealer");

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
        backTo={`/planning/${planId}`}
        crumbs={[{ label: "Planning" }, { label: "View Approved Plans", href: "/planning/sales/plans" }, { label: data.seasonName }, { label: "Monthly Planning" }]}
        title={`${data.seasonName} — Monthly Planning`}
        subtitle="Fill monthly plans and record actual sales. Product Plan and Dealer Summary update live."
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

      <MonthlyEditProvider planId={planId} data={data}>
        <div className={tab === "dealer" ? "" : "hidden"}>
          <MonthlyPlanner />
        </div>
        {tab === "product" && <MonthlyProductPlan />}
        {tab === "dealer-summary" && <MonthlyDealerSummary />}
      </MonthlyEditProvider>
      {tab === "history" && <PlanHistory planId={planId} />}
    </div>
  );
}
