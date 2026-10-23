"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CrumbTrail, type Crumb } from "@/components/layout/crumb-trail";

/**
 * The compact top of an OPENED Seasonal / Monthly plan (Recovery Planning's workspace style): a Back link to the plan's own list section, the breadcrumbs, and — only when they
 * apply — the notes that used to ride in the subtitle (another officer's plan, closed season). No title, subtitle, mode switch or Seasonal | Monthly tabs: those belong to the lists.
 * Back is a plain link to the list URL (with its ?stage=), so it is deterministic on a direct URL load and does not depend on in-app history.
 */
export function PlanDetailBar({ crumbs, backHref, backLabel, notes = [] }: { crumbs: Crumb[]; backHref: string; backLabel: string; notes?: string[] }) {
  return (
    <div className="space-y-1" data-testid="plan-detail-bar">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 h-8 gap-1 px-2 text-muted-foreground">
          <Link href={backHref} aria-label={backLabel}><ArrowLeft className="h-4 w-4" />{backLabel}</Link>
        </Button>
        <CrumbTrail crumbs={crumbs} />
      </div>
      {notes.filter(Boolean).map((note) => <p key={note} className="text-xs text-muted-foreground" role="note">{note.trim()}</p>)}
    </div>
  );
}
