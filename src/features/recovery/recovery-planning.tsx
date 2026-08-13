"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Upload } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/features/planning/status-badge";
import type { PlanStatus } from "@/features/planning/types";
import { RecoveryImportWizard } from "@/features/recovery/recovery-import-wizard";

export type RecoveryMode = "create" | "view";

interface RecoveryPlanRow {
  id: string;
  seasonName: string;
  monthName: string;
  officerId: string;
  officerName: string;
  status: PlanStatus;
  cutoffDate: string;
  updatedAt: string;
}

const CREATE_STATUSES = "DRAFT,RETURNED";
const VIEW_STATUSES = "APPROVED";

/**
 * Recovery Planning — the third planning module, mirroring Sales Planning's Create/View split.
 * Create lists Draft/Returned recovery plans and opens the ONE unified Recovery Import wizard (All /
 * Selected officers, Create / Update / Replace). View lists Approved recovery plans (read-only).
 */
export function RecoveryPlanning({ role, mode }: { role: Role; mode: RecoveryMode }) {
  const isAdmin = role === Role.SUPER_ADMIN;
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  const isCreate = mode === "create";
  const statuses = isCreate ? CREATE_STATUSES : VIEW_STATUSES;
  const [myPlansOnly, setMyPlansOnly] = useState(false); // RM: "My Plans" vs the whole group

  const { data: plans, isLoading } = useQuery<RecoveryPlanRow[]>({
    queryKey: ["recovery-plans", statuses, isManager && myPlansOnly ? "mine" : "scope"],
    queryFn: () => api.get<RecoveryPlanRow[]>(`/api/recovery/plans?status=${statuses}${isManager && myPlansOnly ? "&mine=true" : ""}`),
  });

  const [open, setOpen] = useState(false);
  const { data: options } = useQuery<{ officers: { value: string; label: string }[] }>({
    queryKey: ["assignment-options"],
    queryFn: () => api.get("/api/assignments/options"),
    enabled: open && isAdmin,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Planning" }, { label: isCreate ? "Create New Plan" : "View Approved Plans" }, { label: "Recovery Planning" }]}
        title="Recovery Planning"
        subtitle={isCreate ? "Draft & returned recovery plans. Import an Aging Report to create, update or replace recovery." : "Approved recovery plans (read-only)."}
        actions={
          isAdmin && isCreate ? (
            <Button onClick={() => setOpen(true)}><Upload className="h-4 w-4" /> Import Aging Report</Button>
          ) : undefined
        }
      />

      {/* My Plans vs the whole group — Regional Manager only. */}
      {isManager && (
        <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
          {[{ v: false, l: "Group Plans" }, { v: true, l: "My Plans" }].map((o) => (
            <button
              key={o.l}
              onClick={() => setMyPlansOnly(o.v)}
              className={cn("rounded px-2.5 py-1 font-medium", myPlansOnly === o.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {o.l}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Month</TableHead>
              {!isOfficer && <TableHead>Sales Officer</TableHead>}
              <TableHead>Cutoff</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (plans?.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">{isCreate ? "No draft or returned recovery plans." : "No approved recovery plans."}</TableCell></TableRow>
            ) : (
              plans!.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.seasonName}</TableCell>
                  <TableCell>{p.monthName}</TableCell>
                  {!isOfficer && <TableCell>{p.officerName}</TableCell>}
                  <TableCell className="text-muted-foreground">{formatDate(p.cutoffDate)}</TableCell>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm"><Link href={`/planning/recovery/${p.id}`}>Open</Link></Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
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
