"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "./status-badge";
import type { PlanStatus } from "./types";

interface SeasonalPlan { id: string; seasonName: string; planningType: string; versionName: string | null; version: number; status: PlanStatus; submittedAt: string | null; updatedAt: string }
interface MonthlyPlan { id: string; seasonName: string; monthName: string; status: PlanStatus; submittedAt: string | null; updatedAt: string }
interface RecoveryPlan { id: string; seasonName: string; monthName: string; status: PlanStatus; updatedAt: string }

type PlanKind = "Seasonal" | "Monthly" | "Recovery";
interface Row {
  key: string;
  href: string;
  kind: PlanKind;
  seasonName: string;
  monthName: string | null;
  status: PlanStatus;
  date: string | null; // submitted (fallback: last updated)
}

// Draft/Returned/Rejected stay editable by the officer; everything else is read-only (locked while under
// approval or once approved). Display only — the server enforces the real edit permission.
const EDITABLE_STATUSES = new Set<PlanStatus>(["DRAFT", "RETURNED", "REJECTED"]);
const time = (s: string | null) => (s ? new Date(s).getTime() : 0);

/**
 * Sales Officer "Approvals" view: a READ-ONLY list of ALL plans the officer owns — Seasonal, Monthly and
 * Recovery — with their current approval status (Draft / Submitted / Pending RM / Pending Super Admin /
 * Approved / Rejected / Returned). This mirrors what Admin/RM see for the officer; opening a plan that is
 * under approval or approved shows a locked (view-only) plan, enforced server-side by `canEdit`.
 */
export function MyApprovals() {
  // Each list is already scoped server-side to the logged-in officer's ownership and returns every status.
  const seasonalQ = useQuery<SeasonalPlan[]>({ queryKey: ["plans", "mine"], queryFn: () => api.get<SeasonalPlan[]>("/api/planning/season-plans?mine=true") });
  const monthlyQ = useQuery<MonthlyPlan[]>({ queryKey: ["monthly-plans", "mine"], queryFn: () => api.get<MonthlyPlan[]>("/api/planning/monthly-plans") });
  const recoveryQ = useQuery<RecoveryPlan[]>({ queryKey: ["recovery-plans", "mine"], queryFn: () => api.get<RecoveryPlan[]>("/api/recovery/plans?mine=true") });

  const isLoading = seasonalQ.isLoading || monthlyQ.isLoading || recoveryQ.isLoading;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of seasonalQ.data ?? []) out.push({ key: `s-${p.id}`, href: `/planning/${p.id}`, kind: "Seasonal", seasonName: p.seasonName, monthName: null, status: p.status, date: p.submittedAt ?? null });
    for (const p of monthlyQ.data ?? []) out.push({ key: `m-${p.id}`, href: `/planning/monthly/${p.id}`, kind: "Monthly", seasonName: p.seasonName, monthName: p.monthName, status: p.status, date: p.submittedAt ?? null });
    for (const p of recoveryQ.data ?? []) out.push({ key: `r-${p.id}`, href: `/planning/recovery/${p.id}`, kind: "Recovery", seasonName: p.seasonName, monthName: p.monthName, status: p.status, date: null });
    // Newest first: submitted date when known, else fall back to last-updated so undated rows still sort.
    return out.sort((a, b) => (time(b.date) - time(a.date)));
  }, [seasonalQ.data, monthlyQ.data, recoveryQ.data]);

  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" subtitle="Your plans and their approval status. Submitted plans are read-only until reviewed." />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Month</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">View</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">You have no plans yet.</TableCell></TableRow>
            ) : (
              rows.map((r) => {
                const locked = !EDITABLE_STATUSES.has(r.status);
                return (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">{r.seasonName}</TableCell>
                    <TableCell>{r.monthName ?? "—"}</TableCell>
                    <TableCell><Badge variant="secondary">{r.kind}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{r.date ? formatDate(r.date) : "—"}</TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="outline" size="sm">
                        <Link href={r.href}>{locked ? "View" : "Open"}</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
