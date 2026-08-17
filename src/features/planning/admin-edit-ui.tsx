"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** One field-level change shown in the review dialog (and mapped to an AdminEditAudit row server-side). */
export interface AdminChange {
  dealerName: string;
  productName?: string | null;
  fieldName: string;
  oldValue: number;
  newValue: number;
}

const numFmt = (n: number) => String(Math.round(n));
const diffFmt = (d: number) => `${d > 0 ? "+" : ""}${numFmt(d)}`;

/** The persistent "ADMIN EDIT MODE" banner with Done / Cancel. */
export function AdminEditBar({ onDone, onCancel, disabled }: { onDone: () => void; onCancel: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <span className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
        <ShieldAlert className="h-4 w-4" />
        ADMIN EDIT MODE — changes made here directly modify the approved plan and will be permanently recorded.
      </span>
      <span className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} disabled={disabled}>Cancel</Button>
        <Button size="sm" onClick={onDone} disabled={disabled}>Done</Button>
      </span>
    </div>
  );
}

/** The "Edit Plan" entry point (shown only when the plan is admin-editable). */
export function EditPlanButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      <ShieldAlert className="h-4 w-4" /> Edit Plan
    </Button>
  );
}

/**
 * Final review before an admin save: shows EVERY changed field (dealer, product, field, old, new, diff)
 * and requires a non-empty reason. Confirm stays disabled until a real reason is entered.
 */
export function ChangeReviewDialog({
  open, title, subtitle, changes, saving, error, onConfirm, onClose,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  changes: AdminChange[];
  saving: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const canConfirm = reason.trim().length > 0 && changes.length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Admin Change Review</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>

          {changes.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/20 p-3 text-muted-foreground">No changes to save.</p>
          ) : (
            <div className="max-h-72 space-y-1.5 overflow-auto rounded-md border p-2">
              {changes.map((c, i) => {
                const d = c.newValue - c.oldValue;
                return (
                  <div key={i} className="flex items-center justify-between gap-2 border-b pb-1.5 last:border-b-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="font-medium">{c.dealerName}</span>
                      {c.productName ? <span className="text-muted-foreground"> · {c.productName}</span> : null}
                      <span className="text-muted-foreground"> · {c.fieldName}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <span className="text-muted-foreground">{numFmt(c.oldValue)}</span>
                      <span className="mx-1">→</span>
                      <span className="font-medium">{numFmt(c.newValue)}</span>
                      <span className={d > 0 ? "ml-1 text-emerald-600" : d < 0 ? "ml-1 text-destructive" : "ml-1 text-muted-foreground"}>({diffFmt(d)})</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="admin-reason">Reason for Modification *</Label>
            <Textarea id="admin-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Excel import correction, management approved correction…" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => onConfirm(reason.trim())} disabled={!canConfirm}>Confirm Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
