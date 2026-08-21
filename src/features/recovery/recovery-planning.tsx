"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Upload } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/features/planning/status-badge";
import { Badge } from "@/components/ui/badge";
import type { PlanStatus } from "@/features/planning/types";
import { RecoveryImportWizard } from "@/features/recovery/recovery-import-wizard";
import {
  CREATE_STATUSES, SUBMITTED_STATUSES, roleSections, byDateDesc, AddFilterBar, PillNav, optionsFrom, type FilterDef,
} from "@/features/planning/plan-list-ui";

export type RecoveryMode = "create" | "view";
type ViewSub = "SUBMITTED" | "APPROVED" | "HISTORY";

interface RecoveryPlanRow {
  id: string;
  seasonName: string;
  monthName: string;
  officerId: string;
  officerName: string;
  groupName: string | null;
  territory: string | null;
  status: PlanStatus;
  lifecycleState: string;
  cutoffDate: string;
  updatedAt: string;
}

const ALL_STATUSES = "DRAFT,RETURNED,REJECTED,PENDING_RM,PENDING_ADMIN,APPROVED";
const VIEW_SUBS: { value: ViewSub; label: string }[] = [
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Approved" },
  { value: "HISTORY", label: "Older Plans" },
];

/**
 * Recovery Planning — mirrors Sales Planning's structure. A [Create New Plan | View Plans] toggle;
 * Create lists editable recovery plans (Draft / Returned / Rejected); View has Submitted / Approved /
 * History sub-tabs. Rows are split into role sections (SO own; RM My + Team; Admin all) and shown
 * newest-first. History uses a dynamic "+ Add Filter" (Officer / Season / Region).
 */
export function RecoveryPlanning({ role, userId, mode }: { role: Role; userId: string; mode: RecoveryMode }) {
  const isAdmin = role === Role.SUPER_ADMIN;
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  const isCreate = mode === "create";
  const roleKey = role as "SALES_OFFICER" | "REGIONAL_MANAGER" | "SUPER_ADMIN";

  const [viewSub, setViewSub] = useState<ViewSub>("SUBMITTED");
  const [historyFilters, setHistoryFilters] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState(false);
  const isHistory = !isCreate && viewSub === "HISTORY";

  const { data: scopePlans, isLoading } = useQuery<RecoveryPlanRow[]>({
    queryKey: ["recovery-plans", ALL_STATUSES, "scope"],
    queryFn: () => api.get<RecoveryPlanRow[]>(`/api/recovery/plans?status=${ALL_STATUSES}`),
  });
  const { data: minePlans } = useQuery<RecoveryPlanRow[]>({
    queryKey: ["recovery-plans", ALL_STATUSES, "mine"],
    queryFn: () => api.get<RecoveryPlanRow[]>(`/api/recovery/plans?status=${ALL_STATUSES}&mine=true`),
    enabled: isManager,
  });
  const allPlans = useMemo(() => {
    const byId = new Map<string, RecoveryPlanRow>();
    for (const p of scopePlans ?? []) byId.set(p.id, p);
    for (const p of minePlans ?? []) byId.set(p.id, p);
    return [...byId.values()];
  }, [scopePlans, minePlans]);

  const { data: options } = useQuery<{ officers: { value: string; label: string }[] }>({
    queryKey: ["assignment-options"],
    queryFn: () => api.get("/api/assignments/options"),
    enabled: open && isAdmin,
  });

  const rows = useMemo(() => {
    const out = allPlans.filter((p) => {
      const lifecycle = p.lifecycleState ?? "ACTIVE";
      if (isCreate) { if (!CREATE_STATUSES.includes(p.status)) return false; }
      else if (viewSub === "SUBMITTED") { if (!SUBMITTED_STATUSES.includes(p.status)) return false; }
      else if (viewSub === "APPROVED") { if (!(p.status === "APPROVED" && lifecycle === "ACTIVE")) return false; }
      else { if (lifecycle !== "CLOSED" && lifecycle !== "DEACTIVATED") return false; }
      if (isHistory) {
        // Multi-select: OR within a filter (match any selected value); empty = no constraint.
        if (historyFilters.officer?.length && !historyFilters.officer.includes(p.officerId)) return false;
        if (historyFilters.season?.length && !historyFilters.season.includes(p.seasonName)) return false;
        if (historyFilters.region?.length && !historyFilters.region.includes(p.groupName ?? "")) return false;
      }
      return true;
    });
    return out.sort(byDateDesc((p) => p.cutoffDate));
  }, [allPlans, isCreate, viewSub, isHistory, historyFilters]);

  const sectionLabels = isCreate
    ? { mine: "My Plans", team: "Team Plans", admin: "Draft Plans" }
    : viewSub === "SUBMITTED"
      ? { mine: "My Submitted Plans", team: "Team Submitted Plans", admin: "All Submitted Plans" }
      : viewSub === "APPROVED"
        ? { mine: "My Approved Plans", team: "Team Approved Plans", admin: "All Approved Plans" }
        : { mine: "My Plans", team: "Team Plans", admin: "All Plans" };
  const sections = roleSections(rows, roleKey, userId, sectionLabels);

  const historyDefs: FilterDef[] = useMemo(() => [
    { key: "season", label: "Season", options: optionsFrom(allPlans, (p) => ({ id: p.seasonName, label: p.seasonName })) },
    ...(isOfficer ? [] : [{ key: "officer", label: "Sales Officer", options: optionsFrom(allPlans, (p) => ({ id: p.officerId, label: p.officerName })) }]),
    ...(isOfficer ? [] : [{ key: "region", label: "Region", options: optionsFrom(allPlans, (p) => (p.groupName ? { id: p.groupName, label: p.groupName } : null)) }]),
  ], [allPlans, isOfficer]);

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: "Create/View Plans", href: "/planning/create" }, { label: "Recovery Planning" }]}
        title="Recovery Planning"
        subtitle={isCreate ? "Editable recovery plans (Draft / Returned). Import an Aging Report to create, update or replace recovery." : "Submitted, approved and historical recovery plans."}
        actions={isAdmin && isCreate ? <Button onClick={() => setOpen(true)}><Upload className="h-4 w-4" /> Import Aging Report</Button> : undefined}
      />

      {/* Level 1 — Create New Plan | View Plans */}
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        <Link href="/planning/recovery" className={`rounded px-3 py-1.5 font-medium ${isCreate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>Create New Plan</Link>
        <Link href="/planning/recovery/plans" className={`rounded px-3 py-1.5 font-medium ${!isCreate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>View Plans</Link>
      </div>

      {/* Level 2 — Plan Type (View only): Submitted | Approved | Older Plans */}
      {!isCreate && (
        <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Plan Type</div>
          <div className="flex flex-wrap items-center gap-3">
            <PillNav value={viewSub} onChange={setViewSub} items={VIEW_SUBS} />
            {isHistory && <AddFilterBar defs={historyDefs} value={historyFilters} onChange={setHistoryFilters} />}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {sections.map((sec) => (
          <div key={sec.key} className="space-y-2">
            <h3 className="text-sm font-semibold">{sec.title}</h3>
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Season</TableHead>
                    <TableHead>Month</TableHead>
                    {!isOfficer && <TableHead>Sales Officer</TableHead>}
                    <TableHead>State</TableHead>
                    <TableHead>Territory</TableHead>
                    <TableHead>Cutoff</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={isOfficer ? 7 : 8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : sec.rows.length === 0 ? (
                    <TableRow><TableCell colSpan={isOfficer ? 7 : 8} className="py-8 text-center text-muted-foreground">No plans here.</TableCell></TableRow>
                  ) : (
                    sec.rows.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.seasonName}</TableCell>
                        <TableCell>{p.monthName}</TableCell>
                        {!isOfficer && <TableCell>{p.officerName}</TableCell>}
                        <TableCell>{p.groupName ? <Badge variant="secondary">{p.groupName}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell>{p.territory ?? <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(p.cutoffDate)}</TableCell>
                        <TableCell><StatusBadge status={p.status} /></TableCell>
                        <TableCell className="text-right"><Button asChild variant="outline" size="sm"><Link href={`/planning/recovery/${p.id}`}>Open</Link></Button></TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader><DialogTitle>Import Recovery from Aging Report</DialogTitle></DialogHeader>
          <RecoveryImportWizard officerOptions={options?.officers ?? []} title="Recovery from Aging Report" onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
