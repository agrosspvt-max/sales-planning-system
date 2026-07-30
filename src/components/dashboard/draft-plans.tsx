"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/features/planning/status-badge";
import { PLANNING_TYPE_LABELS, type PlanListItem, type PlanStatus } from "@/features/planning/types";

interface MonthlyPlanRow {
  id: string;
  seasonName: string;
  monthName: string;
  officerId: string;
  officerName: string;
  status: PlanStatus;
  updatedAt: string;
}

interface DraftRow {
  key: string;
  name: string;
  type: string;
  ownerName: string;
  status: PlanStatus;
  updatedAt: string;
  href: string;
}

// Work dashboard: only in-progress plans a user can still act on.
const DRAFT_STATUSES: PlanStatus[] = ["DRAFT", "RETURNED"];

/**
 * Current Draft Plans — the work list on the dashboard. Merges Seasonal/Yearly drafts and
 * first-class Monthly drafts, reusing the existing `season-plans` and `monthly-plans` list
 * endpoints (which already apply role scope). No new backend query.
 */
export function DraftPlans({ role }: { role: Role }) {
  const isAdmin = role === Role.SUPER_ADMIN;

  const seasonal = useQuery<PlanListItem[]>({
    queryKey: ["plans"],
    queryFn: () => api.get<PlanListItem[]>("/api/planning/season-plans"),
  });
  const monthly = useQuery<MonthlyPlanRow[]>({
    queryKey: ["monthly-plans", "DRAFT,RETURNED"],
    queryFn: () => api.get<MonthlyPlanRow[]>("/api/planning/monthly-plans?status=DRAFT,RETURNED"),
  });

  const rows = useMemo<DraftRow[]>(() => {
    const out: DraftRow[] = [];
    for (const p of seasonal.data ?? []) {
      if (!DRAFT_STATUSES.includes(p.status)) continue;
      out.push({
        key: `s-${p.id}`,
        name: `${p.seasonName}${p.versionName ? ` · ${p.versionName}` : ""}`,
        type: PLANNING_TYPE_LABELS[p.planningType],
        ownerName: p.officerName,
        status: p.status,
        updatedAt: p.updatedAt,
        href: `/planning/${p.id}`,
      });
    }
    for (const m of monthly.data ?? []) {
      out.push({
        key: `m-${m.id}`,
        name: `${m.seasonName} · ${m.monthName}`,
        type: "Monthly",
        ownerName: m.officerName,
        status: m.status,
        updatedAt: m.updatedAt,
        href: `/planning/monthly/${m.id}`,
      });
    }
    return out.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  }, [seasonal.data, monthly.data]);

  const isLoading = seasonal.isLoading || monthly.isLoading;
  const colSpan = isAdmin ? 6 : 5;

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Current Draft Plans</h2>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan Name</TableHead>
              <TableHead>Plan Type</TableHead>
              {isAdmin && <TableHead>Plan Owner</TableHead>}
              <TableHead>Status</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead className="text-right">Continue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={colSpan}><Skeleton className="h-6 w-full" /></TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan}>
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <p className="text-sm text-muted-foreground">You have no draft or returned plans in progress.</p>
                    <Button asChild size="sm">
                      <Link href="/planning/sales">Create New Plan</Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.type}</TableCell>
                  {isAdmin && <TableCell>{r.ownerName}</TableCell>}
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(r.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={r.href}>Continue</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
