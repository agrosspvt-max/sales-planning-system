"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, CalendarPlus } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PlanStateBadge } from "./status-badge";
import type { PlanListItem, PlanStatus } from "./types";
import type { SalesMode, LifecycleFilter } from "./sales-planning";

interface MonthlyPlanRow {
  id: string;
  seasonPlanId: string;
  seasonMonthId: string;
  seasonName: string;
  monthName: string;
  monthOrder: number;
  officerId: string;
  officerName: string;
  status: PlanStatus;
  lifecycleState: string;
  lastSavedAt: string;
  updatedAt: string;
}
interface MonthInfo {
  id: string;
  name: string;
  order: number;
  status: string;
  monthlyPlan: { id: string; status: PlanStatus } | null;
}
interface SeasonMonthsResp {
  seasonPlanId: string;
  seasonName: string;
  seasonId: string;
  approved: boolean;
  months: MonthInfo[];
}

const CREATE_STATUSES = "DRAFT,RETURNED";
const VIEW_STATUSES = "APPROVED";
// A month already submitted or approved can't be re-created (only reopened if editable).
const OCCUPYING: PlanStatus[] = ["PENDING_RM", "PENDING_ADMIN", "APPROVED"];

/**
 * Monthly tab — first-class Monthly Plans. Create mode lists Draft/Returned monthly plans and
 * offers "Create New Monthly Plan"; View mode lists Approved monthly plans (read-only). Reuses
 * the seasonal approval lifecycle and notification system via the monthly-plan service.
 */
export function MonthlyPlansPanel({
  role,
  mode,
  officerFilter,
  lifecycleFilter = "ACTIVE",
}: {
  role: Role;
  mode: SalesMode;
  officerFilter: string;
  lifecycleFilter?: LifecycleFilter;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const isAdmin = role === Role.SUPER_ADMIN;
  const isOfficer = role === Role.SALES_OFFICER;
  const isCreate = mode === "create";
  const statuses = isCreate ? CREATE_STATUSES : VIEW_STATUSES;

  const { data: plans, isLoading } = useQuery<MonthlyPlanRow[]>({
    queryKey: ["monthly-plans", statuses],
    queryFn: () => api.get<MonthlyPlanRow[]>(`/api/planning/monthly-plans?status=${statuses}`),
  });

  const rows = useMemo(
    () =>
      (plans ?? []).filter(
        (p) =>
          (!(isAdmin && officerFilter) || p.officerId === officerFilter) &&
          (lifecycleFilter === "ALL" || (p.lifecycleState ?? "ACTIVE") === lifecycleFilter),
      ),
    [plans, isAdmin, officerFilter, lifecycleFilter],
  );

  // ---- Create New Monthly Plan dialog ----
  const [open, setOpen] = useState(false);
  const [seasonPlanId, setSeasonPlanId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [addMonthOpen, setAddMonthOpen] = useState(false);
  const [newMonth, setNewMonth] = useState("");

  // Approved seasonal plans are the only valid parents (Step 1).
  const { data: seasonPlans } = useQuery<PlanListItem[]>({
    queryKey: ["plans"],
    queryFn: () => api.get<PlanListItem[]>("/api/planning/season-plans"),
    enabled: open,
  });
  const approvedSeasonal = useMemo(
    () =>
      (seasonPlans ?? []).filter(
        (p) =>
          p.planningType === "SEASONAL" &&
          p.status === "APPROVED" &&
          p.isActiveVersion &&
          (!(isAdmin && officerFilter) || p.officerId === officerFilter),
      ),
    [seasonPlans, isAdmin, officerFilter],
  );

  // Step 2: months of the chosen seasonal plan.
  const { data: monthsData, isFetching: monthsLoading } = useQuery<SeasonMonthsResp>({
    queryKey: ["season-plan-months", seasonPlanId],
    queryFn: () => api.get<SeasonMonthsResp>(`/api/planning/season-plans/${seasonPlanId}/months`),
    enabled: open && !!seasonPlanId,
  });

  const createMut = useMutation({
    mutationFn: (seasonMonthId: string) =>
      api.post<{ id: string; reopened: boolean }>("/api/planning/monthly-plans", { seasonPlanId, seasonMonthId }),
    onSuccess: (res) => {
      setOpen(false);
      router.push(`/planning/monthly/${res.id}`);
    },
    onError: (e) => setError((e as Error).message),
  });

  const addMonthMut = useMutation({
    mutationFn: () =>
      api.post("/api/planning/month-extensions", { seasonId: monthsData?.seasonId, monthName: newMonth.trim() }),
    onSuccess: () => {
      setAddMonthOpen(false);
      setNewMonth("");
      setError("Extension requested. An admin must approve it before the month becomes available.");
    },
    onError: (e) => setError((e as Error).message),
  });

  function openCreate() {
    setSeasonPlanId("");
    setError(null);
    setOpen(true);
  }

  const canCreate = isCreate && (isAdmin || isOfficer);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        {canCreate && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> Create New Monthly Plan
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Month</TableHead>
              {!isOfficer && <TableHead>Sales Officer</TableHead>}
              <TableHead>Status</TableHead>
              <TableHead>Last saved</TableHead>
              <TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {isCreate ? "No draft or returned monthly plans." : "No approved monthly plans."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.seasonName}</TableCell>
                  <TableCell>{p.monthName}</TableCell>
                  {!isOfficer && <TableCell>{p.officerName}</TableCell>}
                  <TableCell><PlanStateBadge status={p.status} lifecycleState={p.lifecycleState} /></TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(p.lastSavedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/planning/monthly/${p.id}`}>Open</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create New Monthly Plan — Step 1 season, Step 2 month, + Add Month. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create New Monthly Plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Approved Seasonal Plan</Label>
              <NativeSelect
                placeholder="Choose an approved seasonal plan…"
                options={approvedSeasonal.map((p) => ({
                  value: p.id,
                  label: isOfficer ? p.seasonName : `${p.seasonName} — ${p.officerName}`,
                }))}
                value={seasonPlanId}
                onChange={(e) => {
                  setSeasonPlanId(e.target.value);
                  setError(null);
                }}
              />
              {approvedSeasonal.length === 0 && (
                <p className="text-xs text-muted-foreground">No approved seasonal plans available yet.</p>
              )}
            </div>

            {seasonPlanId && (
              <div className="space-y-2 border-t pt-3">
                <Label>Month</Label>
                {monthsLoading ? (
                  <Skeleton className="h-9 w-full" />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {(monthsData?.months ?? []).map((m) => {
                      const occupied = m.monthlyPlan && OCCUPYING.includes(m.monthlyPlan.status);
                      return (
                        <Button
                          key={m.id}
                          variant="outline"
                          size="sm"
                          disabled={!!occupied || createMut.isPending}
                          title={occupied ? "A submitted/approved monthly plan already exists for this month." : undefined}
                          onClick={() => createMut.mutate(m.id)}
                        >
                          {m.name}
                          {m.monthlyPlan ? ` · ${m.monthlyPlan.status}` : ""}
                        </Button>
                      );
                    })}
                    <Button variant="ghost" size="sm" onClick={() => { setAddMonthOpen(true); setError(null); }}>
                      <CalendarPlus className="h-4 w-4" /> Add Month
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Each Monthly Plan covers exactly one month. Choosing a month opens it directly.
                </p>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* + Add Month → Month Extension Request (admin must approve). */}
      <Dialog open={addMonthOpen} onOpenChange={setAddMonthOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a new month</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This sends a request to an administrator. The season is not changed until it is approved.
            </p>
            <div className="space-y-1.5">
              <Label>Month name</Label>
              <Input placeholder="e.g. December" value={newMonth} onChange={(e) => setNewMonth(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddMonthOpen(false)}>Cancel</Button>
            <Button onClick={() => addMonthMut.mutate()} disabled={!newMonth.trim() || addMonthMut.isPending}>
              {addMonthMut.isPending ? "Requesting…" : "Request month"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
