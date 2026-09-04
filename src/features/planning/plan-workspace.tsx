"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { CalendarClock } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PLANNING_TYPE_LABELS } from "./types";
import { StatusBadge } from "./status-badge";
import { PlanActions } from "./plan-actions";
import { PlanGrid } from "./plan-grid";
import { ProductPlan } from "./product-plan";
import { DealerSummaryView } from "./dealer-summary-view";
import { PlanHistory } from "./plan-history";
import { PlanEditProvider } from "./plan-edit-context";
import { SelectMonthlyPlanDialog } from "./select-monthly-plan";
import { PageHeader } from "@/components/layout/page-header";
import { MobileContextBar } from "@/components/layout/mobile-context-bar";
import type { PlanDetail } from "./types";

// Seasonal Draft workspace tabs (Section: no Monthly / Workbook here — Monthly Planning is a
// separate post-approval workflow). Dealer Plan is the only editable page; Product Plan and
// Dealer Summary are read-only and update live from the shared edit context.
type Tab = "dealer" | "product" | "dealer-summary" | "history";

function mapParamTab(raw: string | null): Tab {
  switch (raw) {
    case "product":
    case "summary":
      return "product";
    case "dealer-summary":
      return "dealer-summary";
    case "history":
      return "history";
    default:
      return "dealer"; // grid / monthly / workbook / unknown → Dealer Plan
  }
}

export function PlanWorkspace({
  planId,
  role,
  userId,
}: {
  planId: string;
  role: Role;
  userId: string;
}) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(mapParamTab(searchParams.get("tab")));
  const [monthlyOpen, setMonthlyOpen] = useState(false);
  const { data: detail, isLoading } = useQuery<PlanDetail>({
    queryKey: ["plan", planId],
    queryFn: () => api.get(`/api/planning/season-plans/${planId}`),
  });

  if (isLoading || !detail) return <Skeleton className="h-64 w-full" />;

  const isYearly = detail.planningType === "YEARLY";
  const dealerLabel = isYearly ? "Yearly Target" : "Dealer Plan";
  const tabs: { key: Tab; label: string }[] = [
    { key: "dealer", label: dealerLabel },
    { key: "product", label: "Product Plan" },
    { key: "dealer-summary", label: "Dealer Summary" },
    { key: "history", label: "History" },
  ];

  // Actions shared by the desktop header and the mobile-only actions row (one source of truth).
  const workspaceActions = (
    <>
      {/* Monthly Planning is a separate, post-approval lifecycle. Opens a "Select
          Monthly Plan" dialog (Draft / Approved) → first-class Monthly Plan. */}
      {detail.status === "APPROVED" && detail.isActiveVersion && detail.planningType !== "YEARLY" && (
        <Button variant="outline" onClick={() => setMonthlyOpen(true)}>
          <CalendarClock className="h-4 w-4" /> Monthly Planning
        </Button>
      )}
      <PlanActions detail={detail} role={role} userId={userId} />
    </>
  );

  return (
    // Dealer grid tab: root takes a definite viewport height so the flex chain bounds the grid into the
    // single vertical scroll region (sticky header). Other tabs flow normally.
    <div className={cn(tab === "dealer" ? "flex h-[calc(100dvh-5.5rem)] flex-col gap-4 md:h-[calc(100dvh-6.5rem)]" : "space-y-4")}>
      {/* Mobile: slim context bar only (Back · Season · Officer). Desktop/tablet: full header. */}
      <MobileContextBar
        backTo={detail.status === "APPROVED" ? "/planning/sales/plans" : "/planning/sales"}
        items={[detail.seasonName, detail.officerName]}
      />
      <div className="hidden sm:block">
        <PageHeader
          backTo={detail.status === "APPROVED" ? "/planning/sales/plans" : "/planning/sales"}
          title={`${detail.seasonName} — ${detail.officerName}`}
          subtitle={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{PLANNING_TYPE_LABELS[detail.planningType]}</Badge>
              <Badge variant="secondary">v{detail.version}{detail.versionName ? ` · ${detail.versionName}` : ""}</Badge>
              <StatusBadge status={detail.status} />
              {detail.isActiveVersion && <Badge variant="success">Active</Badge>}
              {detail.source === "IMPORT" && <Badge variant="muted">Imported</Badge>}
              {!detail.seasonOpen && <Badge variant="muted">Season closed</Badge>}
            </div>
          }
          actions={workspaceActions}
        />
      </div>
      {/* Mobile-only actions row (kept out of the slim context bar): Save / Submit / Monthly Planning. */}
      <div className="flex flex-wrap items-center gap-2 sm:hidden">{workspaceActions}</div>

      {(detail.status === "RETURNED" || detail.status === "REJECTED") && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          This plan was {detail.status === "RETURNED" ? "returned" : "rejected"}. See the History
          tab for remarks, make changes, and submit again.
        </div>
      )}
      {detail.revisionRequested && (
        <div className="rounded-md border border-info/40 bg-info/10 p-3 text-sm">
          A revision has been requested{detail.revisionReason ? `: “${detail.revisionReason}”` : "."}
          {role === Role.SUPER_ADMIN && " Authorize it to open a new editable version."}
        </div>
      )}

      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* One provider wraps all views so Dealer Plan edits recompute Product Plan / Dealer
          Summary instantly, and switching tabs never loses in-progress edits. */}
      <PlanEditProvider detail={detail}>
        <div className={tab === "dealer" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <PlanGrid />
        </div>
        {tab === "product" && <ProductPlan />}
        {tab === "dealer-summary" && <DealerSummaryView />}
      </PlanEditProvider>
      {tab === "history" && <PlanHistory planId={planId} />}

      <SelectMonthlyPlanDialog seasonPlanId={planId} open={monthlyOpen} onOpenChange={setMonthlyOpen} />
    </div>
  );
}
