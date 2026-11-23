"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Clock3, Info, MoreVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLabel } from "@/features/labels/label-ui";
import { api } from "@/lib/api-client";
import { cnTimelineDaysFromSubmission } from "@/lib/cn-timeline";
import { formatDateTimeDMY } from "@/lib/date-format";
import { PlanStateBadge } from "./status-badge";
import { STATUS_LABELS, type PlanStatus, type TimelineItem } from "./types";

export type PlanFileKind = "SEASONAL" | "YEARLY" | "MONTHLY" | "RECOVERY";
export function planHistoryUrl(kind: PlanFileKind, id: string) {
  const base = kind === "RECOVERY" ? "/api/recovery/plans" : kind === "MONTHLY" ? "/api/planning/monthly-plans" : "/api/planning/season-plans";
  return `${base}/${encodeURIComponent(id)}/history`;
}

/** Same rail, event circles, timestamps and submission-day badges as the CN Request timeline. */
export function PlanTimeline({ entries }: { entries: TimelineItem[] }) {
  const title = useLabel("planning.details.timeline");
  const timeZone = useLabel("planning.details.time_zone");
  const day = useLabel("planning.details.day");
  const by = useLabel("planning.details.by");
  const unknown = useLabel("planning.details.unknown");
  const empty = useLabel("planning.details.empty");
  const actions: Record<string, string> = {
    SUBMIT: useLabel("planning.details.action.SUBMIT"), RECALL: useLabel("planning.details.action.RECALL"),
    APPROVE: useLabel("planning.details.action.APPROVE"), RETURN: useLabel("planning.details.action.RETURN"),
    REJECT: useLabel("planning.details.action.REJECT"), REQUEST_REVISION: useLabel("planning.details.action.REQUEST_REVISION"),
    AUTHORIZE_REVISION: useLabel("planning.details.action.AUTHORIZE_REVISION"),
  };
  const rmApproved = useLabel("planning.details.action.APPROVE_RM");
  const ordered = [...entries].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  const firstSubmission = ordered.find(entry => entry.action === "SUBMIT")?.createdAt;
  return <section className="min-w-0" aria-label={title}>
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-1"><h3 className="font-semibold">{title}</h3><span className="text-xs text-muted-foreground">{timeZone}</span></div>
    {!ordered.length ? <p className="text-sm text-muted-foreground">{empty}</p> : <ol className="ml-3 space-y-0 border-l-2 border-border">
      {ordered.map(entry => {
        const rejected = entry.action === "REJECT";
        const approved = entry.action === "APPROVE";
        const tone = rejected ? "border-destructive bg-destructive/10 text-destructive" : approved ? "border-success bg-success/10 text-success" : "border-primary bg-background text-primary";
        const days = firstSubmission ? cnTimelineDaysFromSubmission(firstSubmission, entry.createdAt) : null;
        return <li key={entry.id} className="relative pb-6 pl-6 last:pb-0" data-plan-event={entry.action}>
          <span className={`absolute -left-[13px] top-0 flex h-6 w-6 items-center justify-center rounded-full border-2 ${tone}`} aria-hidden="true">
            {rejected ? <X className="h-3 w-3" /> : approved ? <Check className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
          </span>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className={`text-sm font-semibold ${rejected ? "text-destructive" : approved ? "text-success" : ""}`}>{approved && entry.toStatus === "PENDING_ADMIN" ? rmApproved : actions[entry.action] ?? entry.action}</p>
            <div className="flex flex-col items-end gap-1">
              {days != null && <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{day.replace("{days}", String(days))}</span>}
              {entry.createdAt && Number.isFinite(Date.parse(entry.createdAt)) ? <time dateTime={entry.createdAt} className="text-xs text-muted-foreground">{formatDateTimeDMY(entry.createdAt)}</time> : <span className="text-xs text-muted-foreground">{unknown}</span>}
            </div>
          </div>
          <p className="mt-1 break-words text-xs text-muted-foreground">{by}: {entry.actorName || unknown}</p>
          {(entry.fromStatus || entry.toStatus) && <p className="mt-1 text-xs text-muted-foreground">{entry.fromStatus ? STATUS_LABELS[entry.fromStatus] : "—"} → {entry.toStatus ? STATUS_LABELS[entry.toStatus] : "—"}</p>}
          {entry.remarks && <p className="mt-1 whitespace-pre-wrap break-words text-xs italic text-muted-foreground">{entry.remarks}</p>}
        </li>;
      })}
    </ol>}
  </section>;
}

interface PlanFile {
  id: string;
  kind: PlanFileKind;
  seasonName: string;
  monthName?: string;
  officerName: string;
  status: PlanStatus;
  lifecycleState?: string;
  version?: number;
}

export function PlanDetailsMenu({ plan }: { plan: PlanFile }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingDetails = useRef(false);
  const viewDetails = useLabel("planning.details.view");
  const actionsLabel = useLabel("planning.details.actions");
  const loading = useLabel("planning.details.loading");
  const errorLabel = useLabel("planning.details.error");
  const retryLabel = useLabel("planning.details.retry");
  const kindLabels = {
    SEASONAL: useLabel("planning.details.kind.SEASONAL"), YEARLY: useLabel("planning.details.kind.YEARLY"),
    MONTHLY: useLabel("planning.details.kind.MONTHLY"), RECOVERY: useLabel("planning.details.kind.RECOVERY"),
  };
  const description = [kindLabels[plan.kind], plan.seasonName, plan.monthName, plan.officerName, plan.version != null ? `v${plan.version}` : null].filter(Boolean).join(" · ");
  const history = useQuery<{ timeline: TimelineItem[] }>({
    queryKey: ["plan-file-history", plan.kind, plan.id],
    queryFn: () => api.get(planHistoryUrl(plan.kind, plan.id)),
    enabled: open,
    staleTime: 0,
  });
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button ref={trigger} size="icon" variant="ghost" aria-label={`${actionsLabel}: ${description}`}><MoreVertical className="h-4 w-4" aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent onCloseAutoFocus={event => { if (openingDetails.current) { event.preventDefault(); openingDetails.current = false; } }}>
        <DropdownMenuItem onSelect={() => { openingDetails.current = true; setOpen(true); }}><Info className="h-4 w-4" aria-hidden="true" />{viewDetails}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader><DialogTitle>{viewDetails}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <div><PlanStateBadge status={plan.status} lifecycleState={plan.lifecycleState} /></div>
        {history.isLoading ? <p role="status" className="text-sm text-muted-foreground">{loading}</p> : history.isError ? <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{errorLabel}</p><Button variant="outline" size="sm" onClick={() => void history.refetch()}>{retryLabel}</Button></div> : <PlanTimeline entries={history.data?.timeline ?? []} />}
      </DialogContent>
    </Dialog>
  </>;
}
