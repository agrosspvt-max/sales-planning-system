"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "./status-badge";
import type { InboxItem, PlanStatus } from "./types";

interface MonthlyInboxItem {
  id: string;
  seasonName: string;
  monthName: string;
  officerName: string;
  status: PlanStatus;
  submittedAt: string | null;
}
interface ExtensionRequest {
  id: string;
  seasonName: string;
  monthName: string;
  requestedByName: string;
  status: string;
  createdAt: string;
}

export function ApprovalsInbox({ role, userId }: { role: Role; userId: string }) {
  const { data, isLoading } = useQuery<InboxItem[]>({
    queryKey: ["approvals"],
    queryFn: () => api.get<InboxItem[]>("/api/planning/approvals"),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" subtitle="Plans awaiting your review, oldest first." />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Sales Officer</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead className="text-right">Review</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : (data?.length ?? 0) === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  Nothing awaiting your review.
                </TableCell>
              </TableRow>
            ) : (
              data!.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.seasonName}</TableCell>
                  <TableCell>{p.officerName}</TableCell>
                  <TableCell>v{p.version}</TableCell>
                  <TableCell>
                    {p.revisionRequested ? (
                      <Badge variant="default">Revision requested</Badge>
                    ) : (
                      <StatusBadge status={p.status} />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(p.submittedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/planning/${p.id}`}>Review</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <MonthlyApprovals role={role} />
      <RecoveryApprovals role={role} />
      <CnRequestApprovals role={role} userId={userId} />
      {role === Role.SUPER_ADMIN && <MonthExtensionReview />}
    </div>
  );
}

/**
 * Recovery plans awaiting the current approver. RM sees only PENDING_RM (unchanged). Super Admin has
 * FINAL authority and sees EVERY submitted plan — both PENDING_RM and PENDING_ADMIN — so a plan is never
 * hidden from Admin just because RM has not yet acted on it.
 */
function RecoveryApprovals({ role }: { role: Role }) {
  const { data, isLoading } = useQuery<{ id: string; seasonName: string; monthName: string; officerName: string; status: PlanStatus }[]>({
    queryKey: ["recovery-plans", "PENDING_RM,PENDING_ADMIN"],
    queryFn: () => api.get("/api/recovery/plans?status=PENDING_RM,PENDING_ADMIN"),
  });
  const rows = useMemo(
    () =>
      (data ?? []).filter((m) =>
        role === Role.REGIONAL_MANAGER
          ? m.status === "PENDING_RM"
          : m.status === "PENDING_RM" || m.status === "PENDING_ADMIN",
      ),
    [data, role],
  );
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Recovery plans awaiting review</h3>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Month</TableHead>
              <TableHead>Sales Officer</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Review</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.seasonName}</TableCell>
                <TableCell>{m.monthName}</TableCell>
                <TableCell>{m.officerName}</TableCell>
                <TableCell><StatusBadge status={m.status} /></TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm"><Link href={`/planning/recovery/${m.id}`}>Review</Link></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Monthly plans awaiting the current approver. RM sees only PENDING_RM (unchanged). Super Admin has FINAL
 * authority and sees EVERY submitted plan — both PENDING_RM and PENDING_ADMIN — so a plan is never hidden
 * from Admin just because the RM has not yet acted on it (matches Recovery).
 */
function MonthlyApprovals({ role }: { role: Role }) {
  const { data, isLoading } = useQuery<MonthlyInboxItem[]>({
    queryKey: ["monthly-plans", "PENDING_RM,PENDING_ADMIN"],
    queryFn: () => api.get<MonthlyInboxItem[]>("/api/planning/monthly-plans?status=PENDING_RM,PENDING_ADMIN"),
  });
  const rows = useMemo(
    () =>
      (data ?? []).filter((m) =>
        role === Role.REGIONAL_MANAGER
          ? m.status === "PENDING_RM"
          : m.status === "PENDING_RM" || m.status === "PENDING_ADMIN",
      ),
    [data, role],
  );
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Monthly plans awaiting review</h3>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Month</TableHead>
              <TableHead>Sales Officer</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Review</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.seasonName}</TableCell>
                <TableCell>{m.monthName}</TableCell>
                <TableCell>{m.officerName}</TableCell>
                <TableCell><StatusBadge status={m.status} /></TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/planning/monthly/${m.id}`}>Review</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Admin review of Month Extension Requests — approving appends the month to the season. */
function MonthExtensionReview() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ExtensionRequest[]>({
    queryKey: ["month-extensions", "PENDING"],
    queryFn: () => api.get<ExtensionRequest[]>("/api/planning/month-extensions?status=PENDING"),
  });
  const decide = useMutation({
    mutationFn: (vars: { id: string; approve: boolean }) =>
      api.post(`/api/planning/month-extensions/${vars.id}/decide`, { approve: vars.approve }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["month-extensions", "PENDING"] }),
  });
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if ((data?.length ?? 0) === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Month extension requests</h3>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>Requested month</TableHead>
              <TableHead>Requested by</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="text-right">Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data!.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.seasonName}</TableCell>
                <TableCell>{r.monthName}</TableCell>
                <TableCell>{r.requestedByName}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(r.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => decide.mutate({ id: r.id, approve: true })} disabled={decide.isPending}>
                      Approve & add
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: r.id, approve: false })} disabled={decide.isPending}>
                      Decline
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface CnInboxItem {
  id: string; officerId: string; partyName: string; cnType: string; amount: number | null; employeeName: string; state: string | null; territory: string | null; status: string; createdAt: string;
}
/** CN Requests awaiting the current reviewer. RM acts on SUBMITTED (Accept/Reject); Super Admin acts on
 *  SUBMITTED or ACCEPTED (Approve/Reject) — no RM acceptance required. Sales Officers see nothing here. */
function CnRequestApprovals({ role, userId }: { role: Role; userId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<CnInboxItem[]>({ queryKey: ["cn-requests"], queryFn: () => api.get<CnInboxItem[]>("/api/cn-requests") });
  const actMut = useMutation({
    mutationFn: (v: { id: string; action: "accept" | "reject" | "approve" }) => api.post(`/api/cn-requests/${v.id}/act`, { action: v.action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cn-requests"] }),
    onError: (e) => alert((e as Error).message),
  });
  const isAdmin = role === Role.SUPER_ADMIN;
  const isManager = role === Role.REGIONAL_MANAGER;
  // RM sees team members' SUBMITTED requests only (never their own); Admin sees any pending.
  const rows = useMemo(
    () => (data ?? []).filter((r) => (isAdmin ? r.status === "SUBMITTED" || r.status === "ACCEPTED" : isManager ? r.status === "SUBMITTED" && r.officerId !== userId : false)),
    [data, isAdmin, isManager, userId],
  );
  if (!isAdmin && !isManager) return null;
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">CN Requests awaiting {isAdmin ? "approval" : "your review"}</h3>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Party</TableHead>
              <TableHead>CN Type</TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.partyName}</TableCell>
                <TableCell>{r.cnType}</TableCell>
                <TableCell>{r.employeeName}</TableCell>
                <TableCell>{r.state ? <Badge variant="secondary">{r.state}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell><Badge variant={r.status === "ACCEPTED" ? "default" : "secondary"}>{r.status}</Badge></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: isAdmin ? "approve" : "accept" })}>{isAdmin ? "Approve" : "Accept"}</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: "reject" })}>Reject</Button>
                    <Button asChild size="sm" variant="ghost"><Link href="/requests/cn">Open</Link></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
