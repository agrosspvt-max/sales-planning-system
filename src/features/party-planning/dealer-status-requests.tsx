"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { dealerStatusLabel } from "@/lib/dealer-status";
import { DEALER_STATUS_REASONS, STATUS_REQUEST_DESCRIPTION_MAX, validateStatusRequest, type DealerStatusReason } from "@/lib/dealer-status-request";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DealerDialog } from "@/features/sales-upload/create-dealer-dialog";
import { fill, useLabels } from "./party-labels";
import type { DealerStatusRequestDto } from "./territory.server";

const STATUS_VARIANT: Record<string, "success" | "muted" | "secondary" | "destructive"> = { ACTIVE: "success", INACTIVE: "muted", PENDING: "secondary", DEFAULTER: "destructive" };
const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");

/** The reason labels, resolved through the label system (editable under Edit Labels). */
function useReasonLabels(): Record<DealerStatusReason, string> {
  return useLabels({
    DOES_NOT_EXIST: "party_planning.territory.sr.reason.does_not_exist", PARTY_CLOSED: "party_planning.territory.sr.reason.party_closed", OTHER: "party_planning.territory.sr.reason.other",
  });
}

/* ================================== SO / RM: the Status cell in Existing Dealers ================================== */

/**
 * The dealer's Status badge. For a Sales Officer / Regional Manager it opens a request dialog (reason → confirmation → submit). It only ever
 * POSTs a request for Admin — it cannot change the dealer. A dealer with an open request shows that state instead of offering another.
 */
export function StatusRequestCell({ dealerId, partyName, status, pending, canRequest }: {
  dealerId: string; partyName: string; status: string; pending: { reason: DealerStatusReason } | null | undefined; canRequest: boolean;
}) {
  const qc = useQueryClient();
  const reasons = useReasonLabels();
  const T = useLabels({
    title: "party_planning.territory.sr.dialog.title", intro: "party_planning.territory.sr.dialog.intro", describe: "party_planning.territory.sr.dialog.describe", cont: "party_planning.territory.sr.dialog.continue",
    confirmTitle: "party_planning.territory.sr.confirm.title", confirmBody: "party_planning.territory.sr.confirm.body", submit: "party_planning.territory.sr.confirm.submit", back: "party_planning.territory.sr.back",
    sent: "party_planning.territory.sr.sent", badge: "party_planning.territory.sr.pending_badge", hint: "party_planning.territory.sr.pending_hint", aria: "party_planning.territory.sr.aria.request",
    cancel: "party_planning.common.cancel", saving: "party_planning.common.saving", select: "party_planning.territory.placeholder.select",
  });
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const close = () => { setOpen(false); setStep("form"); setReason(""); setDescription(""); setError(null); };
  const submit = useMutation({
    mutationFn: () => api.post("/api/territory-mapping/status-requests", { dealerId, reason, description: description.trim() || undefined }),
    onSuccess: () => { close(); setNotice(T.sent); qc.invalidateQueries({ queryKey: ["territory-dealers"] }); qc.invalidateQueries({ queryKey: ["dealer-status-requests"] }); },
    onError: (e) => { setError((e as Error).message); setStep("form"); qc.invalidateQueries({ queryKey: ["territory-dealers"] }); },
  });

  const badge = <Badge variant={STATUS_VARIANT[status] ?? "muted"}>{dealerStatusLabel(status)}</Badge>;
  if (pending) {
    return (
      <div className="space-y-1" title={fill(T.hint, { reason: reasons[pending.reason] })}>
        {badge}
        <div><Badge variant="warning" className="text-[10px]">{T.badge}</Badge></div>
      </div>
    );
  }
  if (!canRequest) return badge;

  const next = () => { const problem = validateStatusRequest({ reason, description }); if (problem) setError(problem); else { setError(null); setStep("confirm"); } };
  return (
    <>
      <button type="button" className="rounded hover:opacity-80" aria-label={fill(T.aria, { dealer: partyName })} onClick={() => { setNotice(null); setOpen(true); }}>{badge}</button>
      {notice && <p role="status" className="mt-1 text-xs text-success">{notice}</p>}
      <Dialog open={open} onOpenChange={(o) => { if (!o && !submit.isPending) close(); }}>
        <DialogContent>
          {step === "form" ? (
            <>
              <DialogHeader><DialogTitle>{T.title}</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">{fill(T.intro, { dealer: partyName })}</p>
              <div className="space-y-3">
                <NativeSelect value={reason} placeholder={T.select} onChange={(e) => { setReason(e.target.value); setError(null); }}
                  options={DEALER_STATUS_REASONS.map((r) => ({ value: r, label: reasons[r] }))} aria-label={T.title} />
                {reason === "OTHER" && (
                  <div className="space-y-1.5"><Label>{T.describe} *</Label>
                    <Textarea value={description} maxLength={STATUS_REQUEST_DESCRIPTION_MAX} onChange={(e) => { setDescription(e.target.value); setError(null); }} />
                  </div>
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
              <DialogFooter><Button variant="outline" onClick={close}>{T.cancel}</Button><Button disabled={!reason} onClick={next}>{T.cont}</Button></DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader><DialogTitle>{T.confirmTitle}</DialogTitle></DialogHeader>
              <p className="text-sm">{fill(T.confirmBody, { dealer: partyName, reason: reasons[reason as DealerStatusReason] ?? reason })}</p>
              {reason === "OTHER" && <p className="rounded border bg-muted/40 p-2 text-sm">{description.trim()}</p>}
              <DialogFooter>
                <Button variant="outline" disabled={submit.isPending} onClick={() => setStep("form")}>{T.back}</Button>
                <Button disabled={submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? T.saving : T.submit}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ================================================ Admin: the Request tab ================================================ */

export function StatusRequestsTab() {
  const qc = useQueryClient();
  const reasons = useReasonLabels();
  const L = useLabels({
    party: "party_planning.territory.col.party_name", current: "party_planning.territory.sr.col.current_status", reason: "party_planning.territory.sr.col.reason", description: "party_planning.territory.sr.col.description",
    by: "party_planning.territory.sr.col.requested_by", date: "party_planning.territory.sr.col.request_date", status: "party_planning.territory.sr.col.request_status", action: "party_planning.territory.col.action",
    pending: "party_planning.territory.sr.view.pending", resolved: "party_planning.territory.sr.view.resolved", PENDING: "party_planning.territory.sr.status.pending", RESOLVED: "party_planning.territory.sr.status.resolved",
    edit: "party_planning.territory.sr.action.edit", resolve: "party_planning.territory.sr.action.resolve", atRequest: "party_planning.territory.sr.at_request", resolvedBy: "party_planning.territory.sr.resolved_by",
    unavailable: "party_planning.territory.sr.edit_unavailable", empty: "party_planning.territory.sr.empty",
    rTitle: "party_planning.territory.sr.resolve.title", rBody: "party_planning.territory.sr.resolve.body", rNotes: "party_planning.territory.sr.resolve.notes", rConfirm: "party_planning.territory.sr.resolve.confirm", rDone: "party_planning.territory.sr.resolve.done",
    cancel: "party_planning.common.cancel", saving: "party_planning.common.saving",
  });
  const [view, setView] = useState<"pending" | "resolved">("pending");
  const [editId, setEditId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<DealerStatusRequestDto | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, isLoading } = useQuery<DealerStatusRequestDto[]>({ queryKey: ["dealer-status-requests", view], queryFn: () => api.get(`/api/territory-mapping/status-requests?view=${view}`) });
  // The dialog is fed from LIVE list data, so it reflects the dealer as Admin last saved it.
  const editDealer = data?.find((r) => r.dealerId === editId)?.editDealer ?? null;
  const resolve = useMutation({
    mutationFn: (v: { id: string; notes: string }) => api.post(`/api/territory-mapping/status-requests/${v.id}/resolve`, { notes: v.notes || undefined }),
    onSuccess: () => { setResolving(null); setNotes(""); setError(null); setNotice(L.rDone); qc.invalidateQueries({ queryKey: ["dealer-status-requests"] }); qc.invalidateQueries({ queryKey: ["territory-dealers"] }); },
    onError: (e) => setError((e as Error).message),
  });
  const views = [{ key: "pending" as const, label: L.pending }, { key: "resolved" as const, label: L.resolved }];
  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {views.map((v) => (
          <button key={v.key} onClick={() => { setView(v.key); setNotice(null); }} className={`rounded px-3 py-1.5 font-medium ${view === v.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {v.label}{view === v.key && data ? ` (${rows.length})` : ""}
          </button>
        ))}
      </div>
      {error && !resolving && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{L.party}</TableHead><TableHead>{L.current}</TableHead><TableHead>{L.reason}</TableHead><TableHead>{L.description}</TableHead>
            <TableHead>{L.by}</TableHead><TableHead>{L.date}</TableHead><TableHead>{L.status}</TableHead><TableHead className="text-right">{L.action}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              : rows.length === 0 ? <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">{L.empty}</TableCell></TableRow>
                : rows.map((r) => (
                  <TableRow key={r.id} data-request-id={r.id}>
                    <TableCell className="font-medium">{r.partyName}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.currentStatus] ?? "muted"}>{dealerStatusLabel(r.currentStatus)}</Badge>
                      {r.statusAtRequest !== r.currentStatus && <div className="mt-1 text-xs text-muted-foreground">{fill(L.atRequest, { status: dealerStatusLabel(r.statusAtRequest) })}</div>}
                    </TableCell>
                    <TableCell>{reasons[r.reason]}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal">{r.description ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>{r.requestedByName}</TableCell>
                    <TableCell>{dateText(r.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "PENDING" ? "secondary" : "success"}>{L[r.status]}</Badge>
                      {r.status === "RESOLVED" && <div className="mt-1 text-xs text-muted-foreground">{fill(L.resolvedBy, { name: r.resolvedByName ?? "—" })} · {dateText(r.resolvedAt)}{r.resolutionNotes ? ` · ${r.resolutionNotes}` : ""}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === "PENDING" && (
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" disabled={!r.editDealer} title={r.editDealer ? undefined : L.unavailable} onClick={() => setEditId(r.dealerId)}>{L.edit}</Button>
                          <Button size="sm" onClick={() => { setError(null); setNotice(null); setResolving(r); }}>{L.resolve}</Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      {/* The ONE dealer dialog (Dealer Alias → Edit). Opening, cancelling or failing it never touches the request. */}
      <DealerDialog open={!!editId} onOpenChange={(o) => { if (!o) { setEditId(null); qc.invalidateQueries({ queryKey: ["dealer-status-requests"] }); qc.invalidateQueries({ queryKey: ["territory-dealers"] }); } }} edit={editDealer} />

      <Dialog open={!!resolving} onOpenChange={(o) => { if (!o && !resolve.isPending) { setResolving(null); setNotes(""); setError(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{L.rTitle}</DialogTitle></DialogHeader>
          {resolving && <p className="text-sm font-medium">{resolving.partyName} · {reasons[resolving.reason]}</p>}
          <p className="text-sm text-muted-foreground">{L.rBody}</p>
          <div className="space-y-1.5"><Label>{L.rNotes}</Label><Textarea value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={resolve.isPending} onClick={() => { setResolving(null); setNotes(""); setError(null); }}>{L.cancel}</Button>
            <Button disabled={resolve.isPending} onClick={() => resolving && resolve.mutate({ id: resolving.id, notes })}>{resolve.isPending ? L.saving : L.rConfirm}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
