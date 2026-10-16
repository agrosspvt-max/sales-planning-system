"use client";
import { refreshDealerTags } from "./refresh";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { Table, TableHeader, TableRow, TableCell } from "@/components/ui/table";
import { useLabel, Th } from "@/features/labels/label-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/features/planning/status-badge";
import type { PlanStatus } from "@/features/planning/types";
import type { TagRequest } from "./types";
export function DealerTagRequests({ pendingOnly = false }: { pendingOnly?: boolean }) {
  const qc = useQueryClient();
  const L = {
    title: useLabel("dealer_tags.requests.title"), empty: useLabel("dealer_tags.requests.empty"), emptyActionable: useLabel("dealer_tags.requests.empty_actionable"),
    addTag: useLabel("dealer_tags.action.add_tag"), revokeTag: useLabel("dealer_tags.action.revoke_tag"), viewHistory: useLabel("dealer_tags.requests.view_history"),
    approveRm: useLabel("dealer_tags.requests.approve_rm"), approveFinal: useLabel("dealer_tags.requests.approve_final"), reject: useLabel("dealer_tags.requests.reject"),
    rejectTitle: useLabel("dealer_tags.dialog.reject_title"), rejectDescription: useLabel("dealer_tags.dialog.reject_description"), reasonAria: useLabel("dealer_tags.dialog.reason_aria"), cancel: useLabel("dealer_tags.dialog.cancel"),
  };
  const [rejectId, setRejectId] = useState<string | null>(null),
    [remarks, setRemarks] = useState("");
  const { data, error } = useQuery<TagRequest[]>({
    queryKey: ["dealer-tags", "requests"],
    queryFn: () => api.get("/api/dealer-tags/requests"),
  });
  const act = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; remarks?: string }) =>
      api.post(`/api/dealer-tags/requests/${v.id}/decide`, {
        action: v.action,
        remarks: v.remarks,
      }),
    onSuccess: async () => {
      setRejectId(null);
      setRemarks("");
      await refreshDealerTags(qc);
    },
  });
  const rows = (data ?? []).filter((r) => !pendingOnly || r.canAct);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{L.title}</h3>
      {(error || act.error) && (
        <p className="text-sm text-destructive">{(error ?? act.error)?.message}</p>
      )}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <Th labelKey="dealer_tags.col.dealer" />
              <Th labelKey="dealer_tags.requests.col.tag" />
              <Th labelKey="dealer_tags.requests.col.request" />
              <Th labelKey="dealer_tags.requests.col.requested_by" />
              <Th labelKey="dealer_tags.col.status" />
              <Th labelKey="dealer_tags.requests.col.history" />
              <Th labelKey="dealer_tags.requests.col.action" />
            </TableRow>
          </TableHeader>
          <DealerTableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  {pendingOnly ? L.emptyActionable : L.empty}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id} data-dealer-id={r.dealerId}>
                <TableCell>
                  <DealerName id={r.dealerId} name={r.dealerName} />
                </TableCell>
                <TableCell>
                  {r.tagName} ({r.marker})
                </TableCell>
                <TableCell>{r.operation === "ADD" ? L.addTag : L.revokeTag}</TableCell>
                <TableCell>{r.requestedByName}</TableCell>
                <TableCell>
                  <StatusBadge status={r.status as PlanStatus} />
                </TableCell>
                <TableCell>
                  <details>
                    <summary className="cursor-pointer text-xs">{L.viewHistory}</summary>
                    {r.history.map((h, i) => (
                      <p key={i} className="py-1 text-xs">
                        {formatDate(h.createdAt)} · {h.actorName} · {h.action} → {h.toStatus}
                        {h.remarks ? ` · ${h.remarks}` : ""}
                      </p>
                    ))}
                  </details>
                </TableCell>
                <TableCell>
                  {r.canAct && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={act.isPending}
                        onClick={() => act.mutate({ id: r.id, action: "approve" })}
                      >
                        {r.status === "PENDING_RM" ? L.approveRm : L.approveFinal}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={act.isPending}
                        onClick={() => {
                          setRejectId(r.id);
                          setRemarks("");
                        }}
                      >
                        {L.reject}
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </DealerTableBody>
        </Table>
      </div>
      <Dialog open={!!rejectId} onOpenChange={(o) => !o && setRejectId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{L.rejectTitle}</DialogTitle>
            <DialogDescription>
              {L.rejectDescription}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={L.reasonAria}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            maxLength={500}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectId(null)}>
              {L.cancel}
            </Button>
            <Button
              disabled={!remarks.trim() || act.isPending}
              onClick={() => rejectId && act.mutate({ id: rejectId, action: "reject", remarks })}
            >
              {L.reject}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
