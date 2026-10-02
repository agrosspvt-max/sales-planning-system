"use client";

import { DealerTableBody as TableBody } from "@/features/dealers/dealer-table-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, Check, Eye, FileText, Download, MoreVertical } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PillNav, UnderlineTabs } from "@/features/planning/plan-list-ui";
import { useLabel } from "@/features/labels/label-ui";
import {
  buildCreateCnRequestPayload,
  CN_ACCEPTANCE_REASON_VALUES,
  CN_ACCEPTANCE_STATUS_VALUES,
  CN_REJECTION_REASON_VALUES,
  CN_REQUEST_STATUSES,
  CN_TYPE_VALUES,
  CN_WORKING_MAX_BYTES,
  CN_WORKING_PDF_MIME,
  CN_WORKING_XLSX_MIME,
  cnActionMenuItems,
  cnRequestCurrentDisplayStatus,
  cnTypeLabel,
  formatCnRequestDays,
  validateCnAcceptance,
  validateCnRejection,
  validateCnRequestDetails,
  paymentStatusLabel,
  type CnAcceptanceReason,
  type CnAcceptanceStatus,
  type CnRejectionReason,
  type CnRequestView,
  type CnType,
} from "@/lib/cn-request";
import { CnPaymentDialog } from "./cn-payment-dialog";
import { CnRequestDetailDialog } from "./cn-request-detail-dialog";

interface CnRequest {
  id: string; dealerId: string; partyName: string; cnType: string; amount: number | null; postedAmount: number | null; paymentStatus: string | null; paymentVerified: boolean; paymentOriginalAmount: number | null; paymentOutstandingAmount: number | null; paymentTrackingMode: string | null;
  officerId: string; employeeName: string; state: string | null; territory: string | null; status: string; details: string | null; rejectionReason: string | null; rejectionReasonDetails: string | null; acceptanceReason: string | null; acceptanceReasonDetails: string | null; cnExpiryDays: number | null; expiryDate: string | null; cnWorking: { fileName: string; mimeType: string; fileSize: number; uploadedAt: string | null } | null; remarks: string | null; createdAt: string; days: number | null;
}
interface DealerOpt { id: string; name: string }
interface OfficerOpt { id: string; name: string }

const STATUS_VARIANT: Record<string, "secondary" | "default" | "success" | "destructive" | "muted"> = {
  SUBMITTED: "secondary", ACCEPTED_NOT_POSTED: "default", POSTED_IN_LEDGER: "success", RETURNED_FROM_LEDGER: "destructive", REJECTED: "destructive",
};
const money = (n: number | null) => (n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n))}`);
const businessDate = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" });

/**
 * CN Requests — one role-aware screen. Sales Officer creates + views own; Regional Manager rejects
 * team requests; Super Admin accepts with CN working, rejects, and posts accepted requests. Data is filtered by
 * role server-side; the columns and layout are identical for every role.
 */
export function CnRequestsPage({ role, userId }: { role: Role; userId: string }) {
  const qc = useQueryClient();
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  const isAdmin = role === Role.SUPER_ADMIN;
  const canCreate = isOfficer || isManager; // RM can also raise requests for their own dealers

  const labels = {
    pageBreadcrumb: useLabel("cn_requests.page.breadcrumb"),
    pageTitle: useLabel("cn_requests.page.title"),
    pageSubtitleOfficer: useLabel("cn_requests.page.subtitle_officer"),
    pageSubtitleManager: useLabel("cn_requests.page.subtitle_manager"),
    pageSubtitleAdmin: useLabel("cn_requests.page.subtitle_admin"),
    submittedRejected: useLabel("cn_requests.nav.submitted_rejected"),
    accepted: useLabel("cn_requests.nav.accepted"),
    submitted: useLabel("cn_requests.view.submitted"),
    rejected: useLabel("cn_requests.view.rejected"),
    acceptedNotPosted: useLabel("cn_requests.view.accepted_not_posted"),
    postedInLedger: useLabel("cn_requests.view.posted_in_ledger"),
    returnedFromLedger: useLabel("cn_requests.status.returned_from_ledger"),
    reject: useLabel("cn_requests.action.reject"),
    postInLedger: useLabel("cn_requests.action.post_in_ledger"),
    rejectionTitle: useLabel("cn_requests.rejection.title"),
    reason: useLabel("cn_requests.rejection.reason"),
    selectReason: useLabel("cn_requests.rejection.select_reason"),
    billingConditionNotMet: useLabel("cn_requests.rejection.billing_condition_not_met"),
    paymentConditionNotMet: useLabel("cn_requests.rejection.payment_condition_not_met"),
    other: useLabel("cn_requests.rejection.other"),
    otherReason: useLabel("cn_requests.rejection.other_reason"),
    rejectRequest: useLabel("cn_requests.rejection.reject_request"),
    rejecting: useLabel("cn_requests.rejection.rejecting"),
    acceptanceTitle: useLabel("cn_requests.acceptance.title"),
    acceptanceStatus: useLabel("cn_requests.acceptance.status"),
    selectAcceptanceStatus: useLabel("cn_requests.acceptance.select_status"),
    acceptanceNotPosted: useLabel("cn_requests.acceptance.not_posted"),
    acceptancePosted: useLabel("cn_requests.acceptance.posted"),
    acceptanceReason: useLabel("cn_requests.acceptance.reason"),
    selectAcceptanceReason: useLabel("cn_requests.acceptance.select_reason"),
    paymentPending: useLabel("cn_requests.acceptance.payment_pending"),
    cnWorking: useLabel("cn_requests.acceptance.cn_working"),
    chooseFile: useLabel("cn_requests.acceptance.choose_file"),
    selected: useLabel("cn_requests.acceptance.selected"),
    view: useLabel("cn_requests.acceptance.view"),
    download: useLabel("cn_requests.acceptance.download"),
    confirm: useLabel("cn_requests.acceptance.confirm"),
    cnExpiryDays: useLabel("cn_requests.acceptance.expiry_days"),
    expires: useLabel("cn_requests.col.expires"),
    postedAmount: useLabel("cn_requests.acceptance.posted_amount"),
    outstandingAmount: useLabel("cn_requests.payment.outstanding_amount"),
    colDays: useLabel("cn_requests.col.days"),
    colAction: useLabel("cn_requests.col.action"),
    viewDetails: useLabel("cn_requests.action.view_details"),
    downloadCnWorkaround: useLabel("cn_requests.action.download_cn_workaround"),
    downloadCn: useLabel("cn_requests.action.download_cn"),
    createNewRequest: useLabel("cn_requests.action.create_new_request"),
    cancel: useLabel("cn_requests.action.cancel"),
    close: useLabel("cn_requests.action.close"),
    party: useLabel("cn_requests.task.party"),
    cnType: useLabel("cn_requests.field.cn_type"),
    amount: useLabel("cn_requests.task.amount"),
    approxAmount: useLabel("cn_requests.field.approx_amount"),
    paymentStatus: useLabel("cn_requests.field.payment_status"),
    employeeName: useLabel("cn_requests.field.employee_name"),
    state: useLabel("cn_requests.field.state"),
    territory: useLabel("cn_requests.field.territory"),
    status: useLabel("cn_requests.field.status"),
    approval: useLabel("cn_requests.field.approval"),
    details: useLabel("cn_requests.field.details"),
    remarks: useLabel("cn_requests.field.remarks"),
    submittedAt: useLabel("cn_requests.view.submitted"),
    detailTitle: useLabel("cn_requests.detail.title"),
    noRequests: useLabel("cn_requests.state.no_requests"),
    cnTypeLabels: {
      priceDifference: useLabel("cn_requests.cn_type.price_difference"),
      freight: useLabel("cn_requests.cn_type.freight"),
      scheme: useLabel("cn_requests.cn_type.scheme"),
      demo: useLabel("cn_requests.cn_type.demo"),
      damage: useLabel("cn_requests.cn_type.damage"),
    },
    paymentStatusLabels: {
      pending: useLabel("cn_requests.payment.pending"),
      notPaid: useLabel("cn_requests.payment.not_paid"),
      partialPaid: useLabel("cn_requests.payment.partial_paid"),
      paid: useLabel("cn_requests.payment.paid"),
    },
    acceptanceFileHelp: useLabel("cn_requests.acceptance.file_help"),
    confirming: useLabel("cn_requests.acceptance.confirming"),
    validation: {
      statusRequired: useLabel("cn_requests.validation.acceptance_status_required"),
      reasonRequired: useLabel("cn_requests.validation.acceptance_reason_required"),
      detailsRequired: useLabel("cn_requests.validation.other_reason_required"),
      expiryRequired: useLabel("cn_requests.validation.expiry_required"),
      expiryInvalid: useLabel("cn_requests.validation.expiry_invalid"),
      postedAmountRequired: useLabel("cn_requests.validation.posted_amount_required"),
      postedAmountInvalid: useLabel("cn_requests.validation.posted_amount_invalid"),
      outstandingRequired: useLabel("cn_requests.validation.outstanding_required"),
      outstandingInvalid: useLabel("cn_requests.validation.outstanding_invalid"),
      workingRequired: useLabel("cn_requests.validation.working_required"),
      workingTooLarge: useLabel("cn_requests.validation.working_too_large"),
      workingFileType: useLabel("cn_requests.validation.working_file_type"),
      rejectionReasonRequired: useLabel("cn_requests.validation.rejection_reason_required"),
      rejectionDetailsRequired: useLabel("cn_requests.validation.other_reason_required"),
      acceptanceFailed: useLabel("cn_requests.validation.acceptance_failed"),
    },
    day: useLabel("cn_requests.duration.day"),
    days: useLabel("cn_requests.duration.days"),
  };

  const [section, setSection] = useState<"submitted-rejected" | "accepted">("submitted-rejected");
  const [decisionView, setDecisionView] = useState<"submitted" | "rejected">("submitted");
  const [acceptedView, setAcceptedView] = useState<"accepted-not-posted" | "posted-in-ledger">("accepted-not-posted");
  const view: CnRequestView = section === "submitted-rejected" ? decisionView : acceptedView;

  const { data: rows, isLoading } = useQuery<CnRequest[]>({
    queryKey: ["cn-requests", view],
    queryFn: () => api.get<CnRequest[]>(`/api/cn-requests?view=${encodeURIComponent(view)}`),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<CnRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<CnRequest | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<{ request: CnRequest; status: CnAcceptanceStatus } | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<CnRequest | null>(null);

  const actMut = useMutation({
    mutationFn: (v: { id: string; action: "reject"; reason?: CnRejectionReason; rejectionReasonDetails?: string }) =>
      api.post(`/api/cn-requests/${v.id}/act`, {
        action: v.action,
        reason: v.reason,
        rejectionReasonDetails: v.rejectionReasonDetails,
      }),
    onSuccess: (_data, variables) => {
      if (variables.action === "reject") {
        setRejectTarget(null);
        setRejectError(null);
      }
      qc.invalidateQueries({ queryKey: ["cn-requests"] });
    },
    onError: (e, variables) => {
      if (variables.action === "reject") setRejectError((e as Error).message);
    },
  });

  const acceptMut = useMutation({
    mutationFn: async (value: { id: string; status: CnAcceptanceStatus; reason?: CnAcceptanceReason; acceptanceReasonDetails?: string; cnExpiryDays?: number; postedAmount?: number; outstandingAmount?: number; file?: File }) => {
      const form = new FormData();
      form.append("status", value.status);
      if (value.reason) form.append("reason", value.reason);
      if (value.acceptanceReasonDetails) form.append("acceptanceReasonDetails", value.acceptanceReasonDetails);
      if (value.cnExpiryDays != null) form.append("cnExpiryDays", String(value.cnExpiryDays));
      if (value.postedAmount != null) form.append("postedAmount", String(value.postedAmount));
      if (value.outstandingAmount != null) form.append("outstandingAmount", String(value.outstandingAmount));
      if (value.file) form.append("file", value.file);
      const response = await fetch(`/api/cn-requests/${value.id}/accept`, { method: "POST", body: form });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? labels.validation.acceptanceFailed);
      return body;
    },
    onSuccess: () => {
      setAcceptTarget(null);
      setAcceptError(null);
      qc.invalidateQueries({ queryKey: ["cn-requests"] });
    },
    onError: (error) => setAcceptError((error as Error).message),
  });

  // RM retains team rejection. Super Admin alone accepts and performs explicit posting.
  const canReject = (r: CnRequest) =>
    (isManager && r.status === CN_REQUEST_STATUSES.SUBMITTED && r.officerId !== userId) ||
    (isAdmin && r.status === CN_REQUEST_STATUSES.SUBMITTED);
  const canAccept = (r: CnRequest) => isAdmin && r.status === CN_REQUEST_STATUSES.SUBMITTED;
  const canPost = (r: CnRequest) => isAdmin && r.status === CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED;
  const showExpires = view === "accepted-not-posted";
  // Amount and Payment Status are intentionally shown only in the Accepted section.
  const showAmountPayment = section === "accepted";
  // Employee Name / State / Territory are redundant in the SO's own view (fixed by their profile).
  const showProfileColumns = !isOfficer;
  // Approval remains a Submitted / Rejected workflow column; Accepted keeps posting in the Action menu.
  const showApproval = !isOfficer && section === "submitted-rejected";
  const columnCount = 5 + (showAmountPayment ? 2 : 0) + (showProfileColumns ? 3 : 0) + (showExpires ? 1 : 0) + (showApproval ? 1 : 0);

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: labels.pageBreadcrumb }, { label: labels.pageTitle }]}
        title={labels.pageTitle}
        subtitle={isOfficer ? labels.pageSubtitleOfficer : isManager ? labels.pageSubtitleManager : labels.pageSubtitleAdmin}
        actions={canCreate ? <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> {labels.createNewRequest}</Button> : undefined}
      />

      <PillNav
        value={section}
        onChange={setSection}
        items={[
          { value: "submitted-rejected", label: labels.submittedRejected },
          { value: "accepted", label: labels.accepted },
        ]}
      />

      {section === "submitted-rejected" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <UnderlineTabs
            value={decisionView}
            onChange={setDecisionView}
            items={[
              { value: "submitted", label: labels.submitted },
              { value: "rejected", label: labels.rejected },
            ]}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <UnderlineTabs
            value={acceptedView}
            onChange={setAcceptedView}
            items={[
              { value: "accepted-not-posted", label: labels.acceptedNotPosted },
              { value: "posted-in-ledger", label: labels.postedInLedger },
            ]}
          />
        </div>
      )}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.party}</TableHead>
              <TableHead>{labels.cnType}</TableHead>
              {showAmountPayment && <TableHead className="text-right">{labels.amount}</TableHead>}
              {showAmountPayment && <TableHead>{labels.paymentStatus}</TableHead>}
              {showProfileColumns && <TableHead>{labels.employeeName}</TableHead>}
              {showProfileColumns && <TableHead>{labels.state}</TableHead>}
              {showProfileColumns && <TableHead>{labels.territory}</TableHead>}
              <TableHead>{labels.status}</TableHead>
              <TableHead>{labels.colDays}</TableHead>
              {showExpires && <TableHead>{labels.expires}</TableHead>}
              {showApproval && <TableHead className="text-right">{labels.approval}</TableHead>}
              <TableHead className="text-right">{labels.colAction}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={columnCount}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (rows?.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={columnCount} className="py-10 text-center text-muted-foreground">{labels.noRequests}</TableCell></TableRow>
            ) : (
              rows!.map((r) => (
                <TableRow data-dealer-id={r.dealerId} key={r.id}>
                  <TableCell className="font-medium"><DealerName id={r.dealerId} name={r.partyName} /></TableCell>
                  <TableCell>{cnTypeLabel(r.cnType, labels.cnTypeLabels)}</TableCell>
                  {showAmountPayment && <TableCell className="text-right tabular-nums">{money(r.amount)}</TableCell>}
                  {showAmountPayment && <TableCell>{r.paymentTrackingMode === "PAYMENT_V1" ? (
                    <PaymentStatusPill status={r.paymentStatus} verified={r.paymentVerified} labels={labels.paymentStatusLabels} onClick={() => setPaymentTarget(r)} />
                  ) : (r.paymentStatus ?? <span className="text-muted-foreground">—</span>)}</TableCell>}
                  {showProfileColumns && <TableCell>{r.employeeName}</TableCell>}
                  {showProfileColumns && <TableCell>{r.state ? <Badge variant="secondary">{r.state}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>}
                  {showProfileColumns && <TableCell>{r.territory ?? <span className="text-muted-foreground">—</span>}</TableCell>}
                  <TableCell><RequestStatusBadge status={r.status} paymentStatus={r.paymentStatus} labels={labels} /></TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatCnRequestDays(r.days, labels)}</TableCell>
                  {showExpires && <TableCell className="whitespace-nowrap">{r.expiryDate ? businessDate(r.expiryDate) : "—"}</TableCell>}
                  {showApproval && (
                    <TableCell className="text-right">
                      {(canAccept(r) || canReject(r)) ? (
                        <div className="flex justify-end">
                          <AcceptanceStatusAction
                            labels={labels}
                            disabled={actMut.isPending || acceptMut.isPending}
                            onSelect={canAccept(r) ? (status) => { setAcceptError(null); setAcceptTarget({ request: r, status }); } : undefined}
                            onReject={canReject(r) ? () => { setRejectError(null); setRejectTarget(r); } : undefined}
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <CnActionMenu
                      request={r}
                      section={section}
                      view={view}
                      labels={labels}
                      onViewDetails={() => setDetail(r)}
                      onPostInLedger={canPost(r) ? () => { setAcceptError(null); setAcceptTarget({ request: r, status: "POSTED_IN_LEDGER" }); } : undefined}
                      posting={acceptMut.isPending}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {createOpen && <CreateRequestDialog role={role} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); qc.invalidateQueries({ queryKey: ["cn-requests"] }); }} />}
      {detail && <CnRequestDetailDialog requestId={detail.id} initialRequest={detail} onClose={() => setDetail(null)} />}
      {paymentTarget && <CnPaymentDialog requestId={paymentTarget.id} onClose={() => setPaymentTarget(null)} onChanged={() => qc.invalidateQueries({ queryKey: ["cn-requests"] })} />}
      {rejectTarget && (
        <RejectRequestDialog
          labels={labels}
          pending={actMut.isPending}
          serverError={rejectError}
          onClose={() => { setRejectTarget(null); setRejectError(null); }}
          onReject={(reason, rejectionReasonDetails) => actMut.mutate({ id: rejectTarget.id, action: "reject", reason, rejectionReasonDetails })}
        />
      )}
      {acceptTarget && (
        <AcceptRequestDialog
          labels={labels}
          initialStatus={acceptTarget.status}
          pending={acceptMut.isPending}
          serverError={acceptError}
          lockStatus={acceptTarget.request.status === CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED}
          requestId={acceptTarget.request.id}
          existingDocument={acceptTarget.request.cnWorking}
          onClose={() => { setAcceptTarget(null); setAcceptError(null); }}
          onConfirm={(status, reason, acceptanceReasonDetails, cnExpiryDays, postedAmount, outstandingAmount, file) => acceptMut.mutate({
            id: acceptTarget.request.id,
            status,
            reason,
            acceptanceReasonDetails,
            cnExpiryDays,
            postedAmount,
            outstandingAmount,
            file,
          })}
        />
      )}
    </div>
  );
}

export function CreateRequestDialog({
  role,
  onClose,
  onCreated,
  initialDealerId,
  initialOfficerId,
}: {
  role: Role;
  onClose: () => void;
  onCreated: () => void;
  initialDealerId?: string;
  initialOfficerId?: string;
}) {
  const isManager = role === Role.REGIONAL_MANAGER;
  const L = {
    title: useLabel("cn_requests.create.title"), requestFor: useLabel("cn_requests.create.request_for"),
    myDealer: useLabel("cn_requests.create.my_dealer"), team: useLabel("cn_requests.create.team"),
    selectOfficer: useLabel("cn_requests.create.select_officer"), selectOfficerPlaceholder: useLabel("cn_requests.create.select_officer_placeholder"),
    selectPartyPlaceholder: useLabel("cn_requests.create.select_party_placeholder"), selectTypePlaceholder: useLabel("cn_requests.create.select_type_placeholder"), selectOfficerHelp: useLabel("cn_requests.create.select_officer_help"),
    noTeamOfficers: useLabel("cn_requests.create.no_team_officers"), noDealersTeam: useLabel("cn_requests.create.no_dealers_team"),
    noDealersSelf: useLabel("cn_requests.create.no_dealers_self"), detailsPlaceholder: useLabel("cn_requests.create.details_placeholder"),
    submitting: useLabel("cn_requests.create.submitting"), submit: useLabel("cn_requests.action.submit_request"), cancel: useLabel("cn_requests.action.cancel"),
    party: useLabel("cn_requests.task.party"), cnType: useLabel("cn_requests.field.cn_type"), details: useLabel("cn_requests.field.details"),
    detailsRequired: useLabel("cn_requests.validation.details_required"),
    selectParty: useLabel("cn_requests.validation.select_party"), validType: useLabel("cn_requests.validation.valid_type"),
    cnTypes: {
      priceDifference: useLabel("cn_requests.cn_type.price_difference"), freight: useLabel("cn_requests.cn_type.freight"),
      scheme: useLabel("cn_requests.cn_type.scheme"), demo: useLabel("cn_requests.cn_type.demo"), damage: useLabel("cn_requests.cn_type.damage"),
    },
  };
  // RM only: "My Dealer" (raise for self) vs "Team" (raise on behalf of a team Sales Officer).
  const [requestFor, setRequestFor] = useState<"self" | "team">(isManager && initialOfficerId ? "team" : "self");
  const [officerId, setOfficerId] = useState(initialOfficerId ?? "");
  const teamMode = isManager && requestFor === "team";

  // Team Sales Officers (RM only), and the assigned dealers for the effective officer (self, or the picked SO).
  const { data: officers } = useQuery<OfficerOpt[]>({ queryKey: ["cn-officers"], queryFn: () => api.get<OfficerOpt[]>("/api/cn-requests/officers"), enabled: isManager });
  const dealersQuery = teamMode ? `/api/cn-requests/dealers?officerId=${encodeURIComponent(officerId)}` : "/api/cn-requests/dealers";
  const { data: dealers } = useQuery<DealerOpt[]>({
    queryKey: ["cn-dealers", teamMode ? officerId : "self"],
    queryFn: () => api.get<DealerOpt[]>(dealersQuery),
    enabled: !teamMode || !!officerId, // wait for an officer before loading team dealers
  });

  const [dealerId, setDealerId] = useState(initialDealerId ?? "");
  // No business option is auto-selected: CN Type starts neutral and the user must explicitly choose one.
  const [cnType, setCnType] = useState<CnType | "">("");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () => api.post("/api/cn-requests", buildCreateCnRequestPayload({
      dealerId,
      cnType: cnType as CnType,
      officerId: teamMode ? officerId : undefined,
      details,
    })),
    onSuccess: onCreated,
    onError: (e) => setError((e as Error).message),
  });

  const submitRequest = () => {
    // Required dropdowns must carry a real, explicitly chosen value (the server enforces this too).
    if (!dealerId) { setError(L.selectParty); return; }
    if (!cnType) { setError(L.validType); return; }
    const validationError = validateCnRequestDetails(details, L.detailsRequired);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    createMut.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {isManager && (
            <div className="space-y-1.5">
              <Label>{L.requestFor} *</Label>
              <NativeSelect
                options={[{ value: "self", label: L.myDealer }, { value: "team", label: L.team }]}
                value={requestFor}
                onChange={(e) => { setRequestFor(e.target.value as "self" | "team"); setOfficerId(""); setDealerId(""); }}
              />
            </div>
          )}
          {teamMode && (
            <div className="space-y-1.5">
              <Label>{L.selectOfficer} *</Label>
              <NativeSelect
                placeholder={L.selectOfficerPlaceholder}
                options={(officers ?? []).map((o) => ({ value: o.id, label: o.name }))}
                value={officerId}
                onChange={(e) => { setOfficerId(e.target.value); setDealerId(""); }}
              />
              {(officers?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">{L.noTeamOfficers}</p>}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{L.party} *</Label>
            <NativeSelect dealerOptions placeholder={L.selectPartyPlaceholder} disabled={teamMode && !officerId} options={(dealers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={dealerId} onChange={(e) => setDealerId(e.target.value)} />
            {teamMode && !officerId ? (
              <p className="text-xs text-muted-foreground">{L.selectOfficerHelp}</p>
            ) : (dealers?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">{teamMode ? L.noDealersTeam : L.noDealersSelf}</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>{L.cnType} *</Label>
            <NativeSelect placeholder={L.selectTypePlaceholder} options={CN_TYPE_VALUES.map((value) => ({ value, label: cnTypeLabel(value, L.cnTypes) }))} value={cnType} onChange={(e) => { setCnType(e.target.value as CnType | ""); if (error === L.validType && e.target.value) setError(null); }} />
          </div>
          <div className="space-y-1.5">
            <Label>{L.details} *</Label>
            <Textarea
              required
              aria-invalid={error === L.detailsRequired}
              value={details}
              onChange={(e) => {
                setDetails(e.target.value);
                if (error === L.detailsRequired && e.target.value.trim()) setError(null);
              }}
              placeholder={L.detailsPlaceholder}
              rows={3}
            />
            {error === L.detailsRequired && <p className="text-sm text-destructive">{error}</p>}
          </div>
          {error && error !== L.detailsRequired && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{L.cancel}</Button>
          <Button onClick={submitRequest} disabled={!dealerId || (teamMode && !officerId) || createMut.isPending}>{createMut.isPending ? L.submitting : L.submit}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CnWorkflowLabels = {
  submitted: string; rejected: string; reject: string; acceptedNotPosted: string; postedInLedger: string; returnedFromLedger: string;
  rejectionTitle: string; reason: string; selectReason: string; billingConditionNotMet: string;
  paymentConditionNotMet: string; other: string; otherReason: string; rejectRequest: string; rejecting: string;
  acceptanceTitle: string; acceptanceStatus: string; selectAcceptanceStatus: string;
  acceptanceNotPosted: string; acceptancePosted: string; acceptanceReason: string;
  selectAcceptanceReason: string; paymentPending: string; cnWorking: string; chooseFile: string;
  selected: string; view: string; download: string; confirm: string; cnExpiryDays: string; expires: string; postedAmount: string; outstandingAmount: string;
  cancel: string; close: string; party: string; cnType: string; approxAmount: string; paymentStatus: string;
  employeeName: string; state: string; territory: string; status: string; details: string; remarks: string; submittedAt: string; detailTitle: string;
  cnTypeLabels: { priceDifference: string; freight: string; scheme: string; demo: string; damage: string };
  paymentStatusLabels: { pending: string; notPaid: string; partialPaid: string; paid: string };
  acceptanceFileHelp: string; confirming: string;
  validation: {
    statusRequired: string; reasonRequired: string; detailsRequired: string; expiryRequired: string; expiryInvalid: string;
    postedAmountRequired: string; postedAmountInvalid: string; outstandingRequired: string; outstandingInvalid: string;
    workingRequired: string; workingTooLarge: string; workingFileType: string;
    rejectionReasonRequired: string; rejectionDetailsRequired: string; acceptanceFailed: string;
  };
};

function acceptanceStatusText(status: CnAcceptanceStatus, labels: CnWorkflowLabels): string {
  return status === "ACCEPTED_NOT_POSTED" ? labels.acceptanceNotPosted : labels.acceptancePosted;
}

function acceptanceReasonText(reason: string, labels: CnWorkflowLabels): string {
  if (reason === "PAYMENT_PENDING") return labels.paymentPending;
  if (reason === "OTHER") return labels.other;
  return reason;
}

// Sentinel option value for Reject inside the acceptance-status dropdown (not a real acceptance status).
const REJECT_OPTION_VALUE = "__REJECT__";

function AcceptanceStatusAction({
  labels,
  disabled,
  onSelect,
  onReject,
}: {
  labels: CnWorkflowLabels;
  disabled: boolean;
  onSelect?: (status: CnAcceptanceStatus) => void;
  onReject?: () => void;
}) {
  return (
    <NativeSelect
      className="h-8 min-w-52"
      aria-label={labels.acceptanceStatus}
      disabled={disabled}
      placeholder={labels.selectAcceptanceStatus}
      options={[
        ...(onSelect ? CN_ACCEPTANCE_STATUS_VALUES.map((status) => ({ value: status, label: acceptanceStatusText(status, labels) })) : []),
        // Reject is the LAST option and reuses the existing rejection flow.
        ...(onReject ? [{ value: REJECT_OPTION_VALUE, label: labels.reject }] : []),
      ]}
      value=""
      onChange={(event) => {
        const value = event.target.value;
        if (!value) return;
        if (value === REJECT_OPTION_VALUE) onReject?.();
        else onSelect?.(value as CnAcceptanceStatus);
      }}
    />
  );
}

function AcceptRequestDialog({
  labels,
  initialStatus,
  pending,
  serverError,
  lockStatus,
  requestId,
  existingDocument,
  onClose,
  onConfirm,
}: {
  labels: CnWorkflowLabels;
  initialStatus: CnAcceptanceStatus;
  pending: boolean;
  serverError: string | null;
  lockStatus: boolean;
  requestId: string;
  existingDocument: CnRequest["cnWorking"];
  onClose: () => void;
  onConfirm: (status: CnAcceptanceStatus, reason: CnAcceptanceReason | undefined, acceptanceReasonDetails: string | undefined, cnExpiryDays: number | undefined, postedAmount: number | undefined, outstandingAmount: number | undefined, file: File | undefined) => void;
}) {
  const [status, setStatus] = useState<CnAcceptanceStatus | "">(initialStatus);
  const [reason, setReason] = useState<CnAcceptanceReason | "">("");
  const [otherReason, setOtherReason] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  const [postedAmount, setPostedAmount] = useState("");
  const [outstandingAmount, setOutstandingAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = () => {
    const error = validateCnAcceptance(
      { status, reason, acceptanceReasonDetails: otherReason, expiryDays, postedAmount, outstandingAmount, hasFile: !!file || !!existingDocument },
      labels.validation,
    );
    if (error) {
      setValidationError(error);
      return;
    }
    if (file && file.size > CN_WORKING_MAX_BYTES) {
      setValidationError(labels.validation.workingTooLarge);
      return;
    }
    if (file) {
      const extension = file.name.toLowerCase().match(/(\.[^.]+)$/)?.[1] ?? "";
      const validPdf = extension === ".pdf" && file.type === CN_WORKING_PDF_MIME;
      const validXlsx = extension === ".xlsx" && file.type === CN_WORKING_XLSX_MIME;
      if (!validPdf && !validXlsx) {
        setValidationError(labels.validation.workingFileType);
        return;
      }
    }
    setValidationError(null);
    onConfirm(
      status as CnAcceptanceStatus,
      status === "ACCEPTED_NOT_POSTED" ? reason as CnAcceptanceReason : undefined,
      status === "ACCEPTED_NOT_POSTED" && reason === "OTHER" ? otherReason.trim() : undefined,
      status === "ACCEPTED_NOT_POSTED" ? Number(expiryDays) : undefined,
      status === "POSTED_IN_LEDGER" ? Number(postedAmount) : undefined,
      status === "ACCEPTED_NOT_POSTED" && reason === "PAYMENT_PENDING" ? Number(outstandingAmount) : undefined,
      file ?? undefined,
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{labels.acceptanceTitle}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{labels.acceptanceStatus} *</Label>
            <NativeSelect
              required
              disabled={lockStatus}
              placeholder={labels.selectAcceptanceStatus}
              options={CN_ACCEPTANCE_STATUS_VALUES.map((value) => ({ value, label: acceptanceStatusText(value, labels) }))}
              value={status}
              onChange={(event) => {
                const next = event.target.value as CnAcceptanceStatus | "";
                setStatus(next);
                if (next === "POSTED_IN_LEDGER") { setReason(""); setOtherReason(""); setExpiryDays(""); setOutstandingAmount(""); }
                else setPostedAmount("");
                setValidationError(null);
              }}
            />
          </div>
          {status === "ACCEPTED_NOT_POSTED" && (
            <div className="space-y-1.5">
              <Label>{labels.acceptanceReason} *</Label>
              <NativeSelect
                required
                placeholder={labels.selectAcceptanceReason}
                options={CN_ACCEPTANCE_REASON_VALUES.map((value) => ({ value, label: acceptanceReasonText(value, labels) }))}
                value={reason}
                onChange={(event) => { const next = event.target.value as CnAcceptanceReason | ""; setReason(next); if (next !== "PAYMENT_PENDING") setOutstandingAmount(""); setValidationError(null); }}
              />
            </div>
          )}
          {status === "ACCEPTED_NOT_POSTED" && reason === "OTHER" && (
            <div className="space-y-1.5">
              <Label>{labels.otherReason} *</Label>
              <Textarea value={otherReason} onChange={(event) => { setOtherReason(event.target.value); setValidationError(null); }} rows={3} required />
            </div>
          )}
          {status === "ACCEPTED_NOT_POSTED" && reason === "PAYMENT_PENDING" && (
            <div className="space-y-1.5">
              <Label>{labels.outstandingAmount} *</Label>
              <Input type="number" min="0.01" step="0.01" value={outstandingAmount} onChange={(event) => { setOutstandingAmount(event.target.value); setValidationError(null); }} required />
            </div>
          )}
          {status === "ACCEPTED_NOT_POSTED" && (
            <div className="space-y-1.5">
              <Label>{labels.cnExpiryDays} *</Label>
              <Input
                type="number"
                min={1}
                step={1}
                value={expiryDays}
                onChange={(event) => { setExpiryDays(event.target.value); setValidationError(null); }}
                required
              />
            </div>
          )}
          {status === "POSTED_IN_LEDGER" && (
            <div className="space-y-1.5">
              <Label>{labels.postedAmount} *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={postedAmount}
                onChange={(event) => { setPostedAmount(event.target.value); setValidationError(null); }}
                required
              />
            </div>
          )}
          {status && (
            <div className="space-y-1.5">
              <Label>{labels.cnWorking} *</Label>
              {existingDocument && !file ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{labels.selected}: {existingDocument.fileName}</span>
                  {existingDocument.mimeType === CN_WORKING_PDF_MIME && <a className="text-primary underline" href={`/api/cn-requests/${requestId}/working`} target="_blank" rel="noreferrer">{labels.view}</a>}
                  <a className="text-primary underline" href={`/api/cn-requests/${requestId}/working?download=1`}>{labels.download}</a>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" asChild>
                    <label className={pending ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                      <FileText className="h-4 w-4" /> {labels.chooseFile}
                      <input
                        className="sr-only"
                        type="file"
                        disabled={pending}
                        accept=".pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        onChange={(event) => { setFile(event.target.files?.[0] ?? null); setValidationError(null); }}
                      />
                    </label>
                  </Button>
                  {file && <span className="text-sm text-muted-foreground">{labels.selected}: {file.name}</span>}
                </div>
              )}
              <p className="text-xs text-muted-foreground">{labels.acceptanceFileHelp}</p>
            </div>
          )}
          {(validationError || serverError) && <p className="text-sm text-destructive">{validationError ?? serverError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>{labels.cancel}</Button>
          <Button onClick={submit} disabled={pending}>{pending ? labels.confirming : labels.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function rejectionReasonText(reason: string, labels: CnWorkflowLabels): string {
  if (reason === "BILLING_CONDITION_NOT_MET") return labels.billingConditionNotMet;
  if (reason === "PAYMENT_CONDITION_NOT_MET") return labels.paymentConditionNotMet;
  if (reason === "OTHER") return labels.other;
  return reason;
}

function RejectRequestDialog({
  labels,
  pending,
  serverError,
  onClose,
  onReject,
}: {
  labels: CnWorkflowLabels;
  pending: boolean;
  serverError: string | null;
  onClose: () => void;
  onReject: (reason: CnRejectionReason, rejectionReasonDetails?: string) => void;
}) {
  const [reason, setReason] = useState<CnRejectionReason | "">("");
  const [otherReason, setOtherReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const options = CN_REJECTION_REASON_VALUES.map((value) => ({
    value,
    label: rejectionReasonText(value, labels),
  }));

  const submit = () => {
    const error = validateCnRejection(reason, otherReason, {
      reasonRequired: labels.validation.rejectionReasonRequired,
      detailsRequired: labels.validation.rejectionDetailsRequired,
    });
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    onReject(reason as CnRejectionReason, reason === "OTHER" ? otherReason.trim() : undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{labels.rejectionTitle}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{labels.reason} *</Label>
            <NativeSelect
              required
              placeholder={labels.selectReason}
              options={options}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value as CnRejectionReason | "");
                setValidationError(null);
              }}
            />
          </div>
          {reason === "OTHER" && (
            <div className="space-y-1.5">
              <Label>{labels.otherReason} *</Label>
              <Textarea
                required
                value={otherReason}
                onChange={(event) => {
                  setOtherReason(event.target.value);
                  if (event.target.value.trim()) setValidationError(null);
                }}
                rows={3}
              />
            </div>
          )}
          {(validationError || serverError) && <p className="text-sm text-destructive">{validationError ?? serverError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>{labels.cancel}</Button>
          <Button variant="destructive" onClick={submit} disabled={pending}>{pending ? labels.rejecting : labels.rejectRequest}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestStatusBadge({ status, paymentStatus, labels }: { status: string; paymentStatus: string | null; labels: CnWorkflowLabels }) {
  const displayStatus = cnRequestCurrentDisplayStatus(status, paymentStatus);
  const text = displayStatus === "SUBMITTED" ? labels.submitted
    : displayStatus === "REJECTED" ? labels.rejected
      : displayStatus === "ACCEPTED_NOT_POSTED" ? labels.acceptedNotPosted
        : displayStatus === "RETURNED_FROM_LEDGER" ? labels.returnedFromLedger
          : labels.postedInLedger;
  return <Badge variant={STATUS_VARIANT[displayStatus] ?? "muted"}>{text}</Badge>;
}

/**
 * Payment Status pill (never a hyperlink). GREEN = Admin-verified (authoritative); GRAY = SO-reported but
 * not yet verified (provisional); neutral = Pending / no report yet. Clickable to open the payment detail.
 */
function PaymentStatusPill({ status, verified, labels, onClick }: { status: string | null; verified: boolean; labels: { pending: string; notPaid: string; partialPaid: string; paid: string }; onClick: () => void }) {
  const label = paymentStatusLabel(status, labels);
  const variant: "secondary" | "success" | "muted" =
    status == null || status === "Pending" ? "secondary" : verified ? "success" : "muted";
  return (
    <button type="button" onClick={onClick} className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Badge variant={variant} className="cursor-pointer">{label}</Badge>
    </button>
  );
}

/**
 * Row action menu ("⋮"). Replaces the former "Open" button. Always offers View Details (the existing details
 * modal). In the Accepted section it also offers a download of the Admin-uploaded CN Working attachment via the
 * existing server-side download route (/api/cn-requests/:id/working?download=1) — labelled "Download CN Workaround"
 * for Accepted / Not Posted and "Download CN" for Posted in Ledger. The item is disabled when no attachment exists.
 * Admin also retains the existing manual Post in Ledger action here because Accepted tables have no Approval column.
 */
function CnActionMenu({ request, section, view, labels, onViewDetails, onPostInLedger, posting }: {
  request: CnRequest;
  section: "submitted-rejected" | "accepted";
  view: CnRequestView;
  labels: { viewDetails: string; downloadCnWorkaround: string; downloadCn: string; postInLedger: string; colAction: string };
  onViewDetails: () => void;
  onPostInLedger?: () => void;
  posting: boolean;
}) {
  const items = cnActionMenuItems({ section, view, hasWorking: request.cnWorking != null });
  const labelFor: Record<string, string> = {
    "cn_requests.action.view_details": labels.viewDetails,
    "cn_requests.action.download_cn_workaround": labels.downloadCnWorkaround,
    "cn_requests.action.download_cn": labels.downloadCn,
  };
  const downloadWorking = () => {
    const a = document.createElement("a");
    a.href = `/api/cn-requests/${request.id}/working?download=1`;
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" title={labels.colAction}><MoreVertical className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {items.map((item) =>
          item.id === "VIEW_DETAILS" ? (
            <DropdownMenuItem key={item.id} onSelect={onViewDetails}><Eye className="h-4 w-4" /> {labelFor[item.labelKey]}</DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={item.id} disabled={!item.enabled} onSelect={downloadWorking}><Download className="h-4 w-4" /> {labelFor[item.labelKey]}</DropdownMenuItem>
          ),
        )}
        {onPostInLedger && (
          <DropdownMenuItem disabled={posting} onSelect={onPostInLedger}>
            <Check className="h-4 w-4" /> {labels.postInLedger}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
