"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Plus, Check, X, Eye } from "lucide-react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface CnRequest {
  id: string; dealerId: string; partyName: string; cnType: string; amount: number | null; paymentStatus: string;
  officerId: string; employeeName: string; state: string | null; territory: string | null; status: string; details: string | null; remarks: string | null; createdAt: string;
}
interface DealerOpt { id: string; name: string }
interface OfficerOpt { id: string; name: string }

const CN_TYPES = ["DD-Price difference", "Freight", "Scheme","Demo","Damage"];
const PAYMENT_STATUSES = ["Bill unpaid", "Bill Paid"];
const STATUS_VARIANT: Record<string, "secondary" | "default" | "success" | "destructive" | "muted"> = {
  SUBMITTED: "secondary", ACCEPTED: "default", APPROVED: "success", REJECTED: "destructive",
};
const money = (n: number | null) => (n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n))}`);
const dateTime = (s: string) => new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/**
 * CN Requests — one role-aware screen. Sales Officer creates + views own; Regional Manager accepts/rejects
 * team requests (never approves); Super Admin approves/rejects with final authority. Data is filtered by
 * role server-side; the columns and layout are identical for every role.
 */
export function CnRequestsPage({ role, userId }: { role: Role; userId: string }) {
  const qc = useQueryClient();
  const isOfficer = role === Role.SALES_OFFICER;
  const isManager = role === Role.REGIONAL_MANAGER;
  const isAdmin = role === Role.SUPER_ADMIN;
  const canCreate = isOfficer || isManager; // RM can also raise requests for their own dealers

  const { data: rows, isLoading } = useQuery<CnRequest[]>({ queryKey: ["cn-requests"], queryFn: () => api.get<CnRequest[]>("/api/cn-requests") });

  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<CnRequest | null>(null);

  const actMut = useMutation({
    mutationFn: (v: { id: string; action: "accept" | "reject" | "approve" }) => api.post(`/api/cn-requests/${v.id}/act`, { action: v.action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cn-requests"] }),
    onError: (e) => alert((e as Error).message),
  });

  // RM acts on team members' SUBMITTED requests only (never their own); Admin approves/rejects any pending.
  const canAct = (r: CnRequest) =>
    (isManager && r.status === "SUBMITTED" && r.officerId !== userId) || (isAdmin && (r.status === "SUBMITTED" || r.status === "ACCEPTED"));

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Requests" }, { label: "CN Requests" }]}
        title="CN Requests"
        subtitle={isOfficer ? "Raise and track your Credit Note requests." : isManager ? "Raise your own, and accept or reject your team's Credit Note requests." : "Approve or reject Credit Note requests."}
        actions={canCreate ? <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Create New Request</Button> : undefined}
      />

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Party</TableHead>
              <TableHead>CN Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Payment Status</TableHead>
              <TableHead>Employee Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Territory</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead className="text-right">Open</TableHead>
              {!isOfficer && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={isOfficer ? 10 : 11}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (rows?.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={isOfficer ? 10 : 11} className="py-10 text-center text-muted-foreground">No CN requests yet.</TableCell></TableRow>
            ) : (
              rows!.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.partyName}</TableCell>
                  <TableCell>{r.cnType}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.amount)}</TableCell>
                  <TableCell>{r.paymentStatus}</TableCell>
                  <TableCell>{r.employeeName}</TableCell>
                  <TableCell>{r.state ? <Badge variant="secondary">{r.state}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{r.territory ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[r.status] ?? "muted"}>{r.status}</Badge></TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(r.createdAt)}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => setDetail(r)}><Eye className="h-4 w-4" /> Open</Button></TableCell>
                  {!isOfficer && (
                    <TableCell className="text-right">
                      {canAct(r) ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: isAdmin ? "approve" : "accept" })}>
                            <Check className="h-4 w-4" /> {isAdmin ? "Approve" : "Accept"}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={actMut.isPending} onClick={() => actMut.mutate({ id: r.id, action: "reject" })}>
                            <X className="h-4 w-4" /> Reject
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {createOpen && <CreateRequestDialog role={role} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); qc.invalidateQueries({ queryKey: ["cn-requests"] }); }} />}
      {detail && <DetailDialog request={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function CreateRequestDialog({ role, onClose, onCreated }: { role: Role; onClose: () => void; onCreated: () => void }) {
  const isManager = role === Role.REGIONAL_MANAGER;
  // RM only: "My Dealer" (raise for self) vs "Team" (raise on behalf of a team Sales Officer).
  const [requestFor, setRequestFor] = useState<"self" | "team">("self");
  const [officerId, setOfficerId] = useState("");
  const teamMode = isManager && requestFor === "team";

  // Team Sales Officers (RM only), and the assigned dealers for the effective officer (self, or the picked SO).
  const { data: officers } = useQuery<OfficerOpt[]>({ queryKey: ["cn-officers"], queryFn: () => api.get<OfficerOpt[]>("/api/cn-requests/officers"), enabled: isManager });
  const dealersQuery = teamMode ? `/api/cn-requests/dealers?officerId=${encodeURIComponent(officerId)}` : "/api/cn-requests/dealers";
  const { data: dealers } = useQuery<DealerOpt[]>({
    queryKey: ["cn-dealers", teamMode ? officerId : "self"],
    queryFn: () => api.get<DealerOpt[]>(dealersQuery),
    enabled: !teamMode || !!officerId, // wait for an officer before loading team dealers
  });

  const [dealerId, setDealerId] = useState("");
  const [cnType, setCnType] = useState(CN_TYPES[0]);
  const [amount, setAmount] = useState("");
  const [paymentStatus, setPaymentStatus] = useState(PAYMENT_STATUSES[0]);
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () => api.post("/api/cn-requests", {
      dealerId, cnType, amount: amount.trim() ? Number(amount) : undefined, paymentStatus,
      officerId: teamMode ? officerId : undefined,
      details: details.trim() || undefined,
    }),
    onSuccess: onCreated,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create CN Request</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {isManager && (
            <div className="space-y-1.5">
              <Label>Request For *</Label>
              <NativeSelect
                options={[{ value: "self", label: "My Dealer" }, { value: "team", label: "Team" }]}
                value={requestFor}
                onChange={(e) => { setRequestFor(e.target.value as "self" | "team"); setOfficerId(""); setDealerId(""); }}
              />
            </div>
          )}
          {teamMode && (
            <div className="space-y-1.5">
              <Label>Select Sales Officer *</Label>
              <NativeSelect
                placeholder="Select a Sales Officer…"
                options={(officers ?? []).map((o) => ({ value: o.id, label: o.name }))}
                value={officerId}
                onChange={(e) => { setOfficerId(e.target.value); setDealerId(""); }}
              />
              {(officers?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">No Sales Officers on your team yet.</p>}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Party *</Label>
            <NativeSelect placeholder="Select a party…" disabled={teamMode && !officerId} options={(dealers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={dealerId} onChange={(e) => setDealerId(e.target.value)} />
            {teamMode && !officerId ? (
              <p className="text-xs text-muted-foreground">Select a Sales Officer to see their parties.</p>
            ) : (dealers?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">{teamMode ? "No dealers are assigned to that Sales Officer." : "No dealers are assigned to you yet."}</p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>CN Type *</Label>
              <NativeSelect options={CN_TYPES.map((t) => ({ value: t, label: t }))} value={cnType} onChange={(e) => setCnType(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Approx Amount</Label>
              <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Payment Status *</Label>
            <NativeSelect options={PAYMENT_STATUSES.map((p) => ({ value: p, label: p }))} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Details</Label>
            <Textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Enter additional details (optional)" rows={3} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setError(null); createMut.mutate(); }} disabled={!dealerId || (teamMode && !officerId) || createMut.isPending}>{createMut.isPending ? "Submitting…" : "Submit Request"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailDialog({ request, onClose }: { request: CnRequest; onClose: () => void }) {
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>CN Request — {request.partyName}</DialogTitle></DialogHeader>
        <div className="space-y-0.5">
          <Row label="Party" value={request.partyName} />
          <Row label="CN Type" value={request.cnType} />
          <Row label="Approx Amount" value={request.amount == null ? "—" : money(request.amount)} />
          <Row label="Payment Status" value={request.paymentStatus} />
          <Row label="Employee Name" value={request.employeeName} />
          <Row label="State" value={request.state ?? "—"} />
          <Row label="Territory" value={request.territory ?? "—"} />
          <Row label="Status" value={<Badge variant={STATUS_VARIANT[request.status] ?? "muted"}>{request.status}</Badge>} />
          <Row label="Submitted" value={dateTime(request.createdAt)} />
          {request.details && <Row label="Details" value={request.details} />}
          {request.remarks && <Row label="Remarks" value={request.remarks} />}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
