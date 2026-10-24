"use client";
import { useId, useState } from "react";
import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Button } from "@/components/ui/button";
import { TableHead } from "@/components/ui/table";
import { isoToDisplay } from "@/lib/date-input";
import { matchPreset, presetRange, rangeProblem, RANGE_PRESET_DAYS } from "@/lib/date-range";

export interface DateRangeFilterText {
  last7: string; last15: string; last30: string; custom: string; start: string; end: string; apply: string; cancel: string;
  /** "{from} – {to}" shown for the applied range. */
  applied: string;
  /** "{from} – {to}" — the indicator under the heading for a Custom Range. */
  span: string;
  problems: { required: string; order: string; too_large: string };
}

/**
 * A table column header that filters by date range: Last 7 / 15 / 30 Days (include today; applied at once) or a Custom Range that only takes effect on Apply.
 * The caller owns the applied range and today's date (Asia/Kolkata business date) and runs the actual query; this only chooses the range.
 */
export function DateRangeFilterHeader({ label, ariaLabel, from, to, today, onApply, text, className }: {
  label: string; ariaLabel: string; from: string; to: string; today: string; onApply: (from: string, to: string) => void; text: DateRangeFilterText; className?: string;
}) {
  const preset = matchPreset(from, to, today);
  const describedBy = useId();
  // The indicator is derived only from the APPLIED range (props), never from the unsaved drafts.
  const appliedDates = text.applied.replace("{from}", isoToDisplay(from)).replace("{to}", isoToDisplay(to));
  const indicator = preset ? { 7: text.last7, 15: text.last15, 30: text.last30 }[preset] : text.span.replace("{from}", isoToDisplay(from)).replace("{to}", isoToDisplay(to));
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [problem, setProblem] = useState<string | null>(null);
  const presetText = { 7: text.last7, 15: text.last15, 30: text.last30 } as const;
  /** Reset the unsaved drafts to the applied range (opening, Cancel or dismissal). */
  const reset = (custom: boolean) => { setDraftFrom(from); setDraftTo(to); setProblem(null); setShowCustom(custom); };
  const apply = () => {
    const found = rangeProblem(draftFrom, draftTo);
    if (found) { setProblem(text.problems[found]); return; }
    onApply(draftFrom, draftTo);
    setOpen(false);
  };
  return (
    <TableHead className={className}>
      <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(preset === null); }}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={ariaLabel} aria-describedby={describedBy} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
            {label}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[16rem] normal-case" onKeyDown={(e) => e.stopPropagation()}>
          <p className="px-2 py-1.5 text-xs text-muted-foreground tabular-nums" data-testid="date-range-applied">{appliedDates}</p>
          {RANGE_PRESET_DAYS.map((days) => (
            <DropdownMenuItem key={days} data-range-option={`last-${days}`} aria-checked={preset === days} onSelect={() => { const r = presetRange(days, today); onApply(r.from, r.to); }}>
              <Check className={`mr-2 h-4 w-4 ${preset === days ? "" : "invisible"}`} />{presetText[days]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem data-range-option="custom" aria-checked={preset === null || showCustom} onSelect={(e) => { e.preventDefault(); setShowCustom(true); }}>
            <Check className={`mr-2 h-4 w-4 ${preset === null || showCustom ? "" : "invisible"}`} />{text.custom}
          </DropdownMenuItem>
          {showCustom && (
            <div className="space-y-2 border-t p-2" data-testid="date-range-custom">
              <label className="block space-y-1 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{text.start}</span>
                <DateInputDMY value={draftFrom} onChange={(v) => { setDraftFrom(v); setProblem(null); }} aria-label={text.start} />
              </label>
              <label className="block space-y-1 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{text.end}</span>
                <DateInputDMY value={draftTo} onChange={(v) => { setDraftTo(v); setProblem(null); }} aria-label={text.end} />
              </label>
              {problem && <p className="text-xs text-destructive" role="alert">{problem}</p>}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => { reset(preset === null); setOpen(false); }}>{text.cancel}</Button>
                <Button size="sm" onClick={apply}>{text.apply}</Button>
              </div>
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span id={describedBy} title={appliedDates} data-testid="date-range-indicator" className="block max-w-[8rem] break-words px-1 text-[11px] font-normal normal-case leading-tight text-primary">
        {indicator}
        <span className="sr-only"> ({appliedDates})</span>
      </span>
    </TableHead>
  );
}
