"use client";
import { useAdminPermission } from "@/features/accounts/permission-ui";
import { isAdministrativeRole } from "@/features/accounts/permissions";


import { DealerTableBody as TableBody } from "@/features/dealers/dealer-table-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "./status-badge";
import type { InboxItem, PlanStatus } from "./types";
import { useLabel, useLabelResolver } from "@/features/labels/label-ui";
import { DealerTagRequests } from "@/features/dealer-tags/dealer-tag-requests";
import { CnReviewInbox } from "@/features/cn-requests/cn-review-ui";
import { MyApprovals } from "./my-approvals";
import { APPROVAL_LABELS } from "./approval-labels";

/** A cached label provider from an earlier page must not leave newly added controls empty. */
function useApprovalLabels() {
  const resolve = useLabelResolver();
  return (key: keyof typeof APPROVAL_LABELS) => resolve(key) || APPROVAL_LABELS[key];
}

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
  const t = useApprovalLabels();
  const useApprovals = useAdminPermission("approvals");
  const useSales = useAdminPermission("salesPlanning");
  const useRecovery = useAdminPermission("recoveryPlanning");
  const useCn = useAdminPermission("cnRequests");
  const useTags = useAdminPermission("dealerTags");
  const isOfficer = role === Role.SALES_OFFICER;
  const canReview = !isOfficer && useApprovals;
  const canSales = isOfficer || (canReview && useSales);
  const canRecovery = isOfficer || (canReview && useRecovery);
  const canCn = canReview && useCn;
  const canTags = isOfficer || (canReview && useTags);
  const canExtensions = canReview && isAdministrativeRole(role) && useSales;
  const categories = [
    ...(canSales ? [{ value: "sales", label: t("approvals.category.sales") }] : []),
    ...(canRecovery ? [{ value: "recovery", label: t("approvals.category.recovery") }] : []),
    { value: "cn", label: t("approvals.category.cn") },
    ...(canTags || canExtensions ? [{ value: "other", label: t("approvals.category.other") }] : []),
  ];
  const [requestedCategory, setCategory] = useState("sales");
  const category = categories.some((c) => c.value === requestedCategory) ? requestedCategory : categories[0].value;
  const [requestedCnView, setCnView] = useState("requests");
  const cnView = canCn ? requestedCnView : "dependency";
  const { data, isLoading } = useQuery<InboxItem[]>({
    queryKey: ["approvals"],
    queryFn: () => api.get<InboxItem[]>("/api/planning/approvals"),
    enabled: category === "sales" && canReview && useSales,
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("approvals.title")} subtitle={t(isOfficer ? "approvals.subtitle.own" : "approvals.subtitle.review")} />

      <div role="group" aria-label={t("approvals.category.label")} className="inline-flex max-w-full flex-wrap rounded-md border bg-background p-0.5 text-sm">
        {categories.map((c) => (
          <button key={c.value} type="button" aria-pressed={category === c.value} onClick={() => setCategory(c.value)} className={cn("rounded px-3 py-1.5 font-medium", category === c.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
            {c.label}
          </button>
        ))}
      </div>

      {category === "sales" && (isOfficer ? <MyApprovals category="sales" /> : <div className="space-y-5">
      <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t("approvals.sales.seasonal")}</h3>

      <div className="rounded-lg border bg-background">
        <Table numbered>
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
      </div>
      <MonthlyApprovals role={role} />
      </div>)}
      {category === "recovery" && (isOfficer ? <MyApprovals category="recovery" /> : <RecoveryApprovals role={role} />)}
      {category === "cn" && (
        <div className="space-y-4">
          <div role="group" aria-label={t("approvals.cn.label")} className="flex w-fit max-w-full flex-wrap gap-1 border-b">
            {canCn && <button type="button" aria-pressed={cnView === "requests"} onClick={() => setCnView("requests")} className={cn("border-b-2 px-3 py-2 text-sm font-medium transition-colors", cnView === "requests" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{t("approvals.cn.requests")}</button>}
            <button type="button" aria-pressed={cnView === "dependency"} onClick={() => setCnView("dependency")} className={cn("border-b-2 px-3 py-2 text-sm font-medium transition-colors", cnView === "dependency" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{t("approvals.cn.dependency")}</button>
          </div>
          {cnView === "requests" ? <CnRequestApprovals role={role} userId={userId} /> : <CnReviewInbox />}
        </div>
      )}
      {category === "other" && (isOfficer ? <MyApprovals category="other" /> : <>
        {canTags && <DealerTagRequests pendingOnly />}
        {canExtensions && <MonthExtensionReview />}
      </>)}
    </div>
  );
}

/**
 * Recovery plans awaiting the current approver. RM sees only PENDING_RM (unchanged). Super Admin has
 * FINAL authority and sees EVERY submitted plan — both PENDING_RM and PENDING_ADMIN — so a plan is never
 * hidden from Admin just because RM has not yet acted on it.
 */
function RecoveryApprovals({ role }: { role: Role }) {
  const empty = useApprovalLabels()("approvals.empty.recovery");
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
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Recovery plans awaiting review</h3>
      <div className="rounded-lg border bg-background">
        <Table numbered>
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
        <Table numbered>
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

/** Legacy requests remain visible and declinable; canonical Add Months replaces free-text approval. */
function MonthExtensionReview() {
  const empty = useApprovalLabels()("approvals.empty.extensions");
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
  if ((data?.length ?? 0) === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Legacy month extension requests</h3>
      <p className="text-xs text-muted-foreground">Use Seasons → Add Months for calendar additions. These requests lack a reliable year and remain available for review/decline.</p>
      <div className="rounded-lg border bg-background">
        <Table numbered>
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
                    <Button size="sm" title="Use Seasons → Add Months" disabled>
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
  dealerId: string;
  id: string; officerId: string; partyName: string; cnType: string; amount: number | null; employeeName: string; state: string | null; territory: string | null; status: string; createdAt: string;
}
/** CN Requests awaiting a decision. Posting accepted requests remains on the dedicated CN Requests page. */
function CnRequestApprovals({ role, userId }: { role: Role; userId: string }) {
  const qc = useQueryClient();
  const acceptLabel = useLabel("cn_requests.action.accept");
  const rejectLabel = useLabel("cn_requests.action.reject");
  const submittedLabel = useLabel("cn_requests.view.submitted");
  const empty = useApprovalLabels()("approvals.empty.cn");
  const { data, isLoading } = useQuery<CnInboxItem[]>({ queryKey: ["cn-requests", "submitted"], queryFn: () => api.get<CnInboxItem[]>("/api/cn-requests?view=submitted") });
  const actMut = useMutation({
    mutationFn: (v: { id: string; action: "accept" | "reject" }) => api.post(`/api/cn-requests/${v.id}/act`, { action: v.action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cn-requests"] }),
    onError: (e) => alert((e as Error).message),
  });
  const isAdmin = isAdministrativeRole(role);
  const isManager = role === Role.REGIONAL_MANAGER;
  // Server returns SUBMITTED only; RM still cannot act on a request they raised themselves.
  const rows = useMemo(
    () => (data ?? []).filter((r) => (isAdmin ? true : isManager ? r.officerId !== userId : false)),
    [data, isAdmin, isManager, userId],
  );
  if (!isAdmin && !isManager) return null;
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">CN Requests awaiting {isAdmin ? "approval" : "your review"}</h3>
      <div className="rounded-lg border bg-background">
        <Table numbered>
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
              <TableRow data-dealer-id={r.dealerId} key={r.id}>
                <TableCell className="font-medium"><DealerName id={r.dealerId} name={r.partyName} /></TableCell>
                <TableCell>{r.cnType}</TableCell>
                <TableCell>{r.employeeName}</TableCell>
                <TableCell>{r.state ? <Badge variant="secondary">{r.state}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell><Badge variant="secondary">{submittedLabel}</Badge></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: "accept" })}>{acceptLabel}</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: "reject" })}>{rejectLabel}</Button>
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
