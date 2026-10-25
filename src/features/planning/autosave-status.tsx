"use client";
import { useLabel } from "@/features/labels/label-ui";

/**
 * The planning editors' save indicator. "Saved" is shown only when nothing is pending; edits the server has not confirmed yet are shown as unsaved, and a
 * failed save says so (the edits stay on screen and are sent again on the next change, retry or Save).
 */
export function AutosaveStatus({ saving, failed, error, pending, savedText, className }: { saving: boolean; failed: boolean; error: string | null; pending: number; savedText?: string; className?: string }) {
  const L = {
    saving: useLabel("sales_planning.autosave.saving"), saved: useLabel("sales_planning.autosave.saved"),
    pending: useLabel("sales_planning.autosave.pending"), failed: useLabel("sales_planning.autosave.failed"),
  };
  if (saving) return <span className={className} data-autosave="saving">{L.saving}</span>;
  if (failed) return <span role="alert" title={error ?? undefined} className={`${className ?? ""} text-destructive`} data-autosave="failed">{L.failed}</span>;
  if (pending > 0) return <span className={className} data-autosave="pending">{L.pending}</span>;
  return <span className={className} data-autosave="saved">{savedText ?? L.saved}</span>;
}
