"use client";
import { DealerName } from "@/features/dealers/dealer-name-ui";

import { useQuery } from "@tanstack/react-query";
import { Download, Eye } from "lucide-react";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useLabel } from "@/features/labels/label-ui";
import {
  CN_REQUEST_STATUSES,
  CN_WORKING_PDF_MIME,
  cnRequestCurrentDisplayStatus,
  cnTypeLabel,
  paymentStatusLabel,
} from "@/lib/cn-request";

export interface CnRequestDetailData {
  id: string; partyName: string; dealerId?: string; cnType: string; amount: number | null; postedAmount: number | null;
  paymentStatus: string | null; employeeName: string; state: string | null; territory: string | null;
  status: string; details: string | null; rejectionReason: string | null; rejectionReasonDetails: string | null;
  acceptanceReason: string | null; acceptanceReasonDetails: string | null; remarks: string | null; createdAt: string;
  cnWorking: { fileName: string; mimeType: string; fileSize: number; uploadedAt: string | null } | null;
  finalCn?: { fileName: string; mimeType: string; fileSize: number; uploadedAt: string | null } | null;
}

const STATUS_VARIANT: Record<string, "secondary" | "default" | "success" | "destructive" | "muted"> = {
  SUBMITTED: "secondary", ACCEPTED_NOT_POSTED: "default", POSTED_IN_LEDGER: "success", RETURNED_FROM_LEDGER: "destructive", REJECTED: "destructive",
};
const money = (value: number | null) => value == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(value))}`;
const dateTime = (value: string) => new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/** Shared CN Request details dialog used by both CN Requests and Daily Work. */
export function CnRequestDetailDialog({ requestId, initialRequest, onClose }: {
  requestId: string;
  initialRequest?: CnRequestDetailData;
  onClose: () => void;
}) {
  const { data: request, isLoading, error } = useQuery<CnRequestDetailData>({
    queryKey: ["cn-request-detail", requestId],
    queryFn: () => api.get<CnRequestDetailData>(`/api/cn-requests/${requestId}`),
    initialData: initialRequest,
  });
  const L = {
    title: useLabel("cn_requests.detail.title"), close: useLabel("cn_requests.action.close"),
    party: useLabel("cn_requests.task.party"), cnType: useLabel("cn_requests.field.cn_type"),
    postedAmount: useLabel("cn_requests.acceptance.posted_amount"), approxAmount: useLabel("cn_requests.field.approx_amount"),
    paymentStatus: useLabel("cn_requests.field.payment_status"), employeeName: useLabel("cn_requests.field.employee_name"),
    state: useLabel("cn_requests.field.state"), territory: useLabel("cn_requests.field.territory"),
    status: useLabel("cn_requests.field.status"), submittedAt: useLabel("cn_requests.view.submitted"),
    details: useLabel("cn_requests.field.details"), acceptanceReason: useLabel("cn_requests.acceptance.reason"),
    paymentPending: useLabel("cn_requests.acceptance.payment_pending"), other: useLabel("cn_requests.rejection.other"),
    otherReason: useLabel("cn_requests.rejection.other_reason"), cnWorking: useLabel("cn_requests.acceptance.cn_working"),
    finalCn: useLabel("cn_requests.acceptance.final_cn"),
    view: useLabel("cn_requests.acceptance.view"), download: useLabel("cn_requests.acceptance.download"),
    reason: useLabel("cn_requests.rejection.reason"), billingCondition: useLabel("cn_requests.rejection.billing_condition_not_met"),
    paymentCondition: useLabel("cn_requests.rejection.payment_condition_not_met"), remarks: useLabel("cn_requests.field.remarks"),
    submitted: useLabel("cn_requests.view.submitted"), rejected: useLabel("cn_requests.view.rejected"),
    acceptedNotPosted: useLabel("cn_requests.view.accepted_not_posted"), postedInLedger: useLabel("cn_requests.view.posted_in_ledger"),
    returnedFromLedger: useLabel("cn_requests.status.returned_from_ledger"), unavailable: useLabel("cn_requests.error.not_found"),
    cnTypes: {
      priceDifference: useLabel("cn_requests.cn_type.price_difference"), freight: useLabel("cn_requests.cn_type.freight"),
      scheme: useLabel("cn_requests.cn_type.scheme"), demo: useLabel("cn_requests.cn_type.demo"), damageExpiry: useLabel("cn_requests.cn_type.damage_expiry"), other: useLabel("cn_requests.cn_type.other"),
    },
    paymentStatuses: {
      pending: useLabel("cn_requests.payment.pending"), notPaid: useLabel("cn_requests.payment.not_paid"),
      partialPaid: useLabel("cn_requests.payment.partial_paid"), paid: useLabel("cn_requests.payment.paid"),
    },
  };
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span>
    </div>
  );
  const statusBadge = request ? (() => {
    const current = cnRequestCurrentDisplayStatus(request.status, request.paymentStatus);
    const text = current === "SUBMITTED" ? L.submitted : current === "REJECTED" ? L.rejected
      : current === "ACCEPTED_NOT_POSTED" ? L.acceptedNotPosted : current === "RETURNED_FROM_LEDGER" ? L.returnedFromLedger : L.postedInLedger;
    return <Badge variant={STATUS_VARIANT[current] ?? "muted"}>{text}</Badge>;
  })() : null;
  const acceptanceReason = request?.acceptanceReason === "PAYMENT_PENDING" ? L.paymentPending
    : request?.acceptanceReason === "OTHER" ? L.other : request?.acceptanceReason;
  const rejectionReason = request?.rejectionReason === "BILLING_CONDITION_NOT_MET" ? L.billingCondition
    : request?.rejectionReason === "PAYMENT_CONDITION_NOT_MET" ? L.paymentCondition
      : request?.rejectionReason === "OTHER" ? L.other : request?.rejectionReason;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{L.title}{request ? <> — <DealerName id={request.dealerId} name={request.partyName} /></> : ""}</DialogTitle></DialogHeader>
        {isLoading ? <Skeleton className="h-64 w-full" /> : error || !request ? (
          <p className="text-sm text-destructive">{(error as Error | null)?.message ?? L.unavailable}</p>
        ) : (
          <div className="space-y-0.5">
            <Row label={L.party} value={<DealerName id={request.dealerId} name={request.partyName} />} />
            <Row label={L.cnType} value={cnTypeLabel(request.cnType, L.cnTypes)} />
            <Row label={request.postedAmount != null ? L.postedAmount : L.approxAmount} value={money(request.amount)} />
            <Row label={L.paymentStatus} value={paymentStatusLabel(request.paymentStatus, L.paymentStatuses)} />
            <Row label={L.employeeName} value={request.employeeName} />
            <Row label={L.state} value={request.state ?? "—"} />
            <Row label={L.territory} value={request.territory ?? "—"} />
            <Row label={L.status} value={statusBadge} />
            <Row label={L.submittedAt} value={dateTime(request.createdAt)} />
            {request.details && <Row label={L.details} value={request.details} />}
            {request.status === CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED && acceptanceReason && <Row label={L.acceptanceReason} value={acceptanceReason} />}
            {request.status === CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED && request.acceptanceReasonDetails && <Row label={L.otherReason} value={request.acceptanceReasonDetails} />}
            {request.cnWorking && (
              <Row label={L.cnWorking} value={<span className="flex flex-wrap items-center justify-end gap-1">
                <span className="max-w-52 truncate" title={request.cnWorking.fileName}>{request.cnWorking.fileName}</span>
                {request.cnWorking.mimeType === CN_WORKING_PDF_MIME && <Button variant="ghost" size="sm" asChild><a href={`/api/cn-requests/${request.id}/working`} target="_blank" rel="noreferrer"><Eye className="h-4 w-4" /> {L.view}</a></Button>}
                <Button variant="ghost" size="sm" asChild><a href={`/api/cn-requests/${request.id}/working?download=1`}><Download className="h-4 w-4" /> {L.download}</a></Button>
              </span>} />
            )}
            {request.finalCn && (
              <Row label={L.finalCn} value={<span className="flex flex-wrap items-center justify-end gap-1">
                <span className="max-w-52 truncate" title={request.finalCn.fileName}>{request.finalCn.fileName}</span>
                {request.finalCn.mimeType === CN_WORKING_PDF_MIME && <Button variant="ghost" size="sm" asChild><a href={`/api/cn-requests/${request.id}/final-cn`} target="_blank" rel="noreferrer"><Eye className="h-4 w-4" /> {L.view}</a></Button>}
                <Button variant="ghost" size="sm" asChild><a href={`/api/cn-requests/${request.id}/final-cn?download=1`}><Download className="h-4 w-4" /> {L.download}</a></Button>
              </span>} />
            )}
            {rejectionReason && <Row label={L.reason} value={rejectionReason} />}
            {request.rejectionReasonDetails && <Row label={L.otherReason} value={request.rejectionReasonDetails} />}
            {request.remarks && <Row label={L.remarks} value={request.remarks} />}
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>{L.close}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
