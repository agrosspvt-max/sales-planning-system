"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayToIso, isoToDisplay, maskDisplayInput } from "@/lib/date-input";
import { useLabel } from "@/features/labels/label-ui";

/**
 * A date field that ALWAYS shows and accepts DD/MM/YYYY, whatever the browser or operating-system locale (a native `<input type="date">` renders
 * MM/DD/YYYY for some users and DD/MM/YYYY for others). `value` / `onChange` stay the ISO `YYYY-MM-DD` string, so callers and APIs are unchanged.
 *  - Typing: digits are masked into DD/MM/YYYY; a complete REAL date is committed at once, an incomplete or impossible one is never emitted and
 *    reverts to the last good value on blur. Clearing the box and leaving it emits "" (the caller's own empty-value fallback applies).
 *  - Rules: a typed date must be a REAL calendar date (leap years honoured) inside the optional `min` / `max` (ISO); anything else is not applied and a clear message (Edit Labels:
 *    `date.error.*`) explains why. The visible field, the typed value and the calendar-picked value are always the same DD/MM/YYYY text.
 *  - Picking: the calendar button opens the browser's date picker (an invisible native date input over the icon); its ISO value is used as is.
 */
export function DateInputDMY({ value, onChange, className, "aria-label": ariaLabel, id, disabled, min, max, required }: {
  value: string; onChange: (iso: string) => void; className?: string; "aria-label"?: string; id?: string; disabled?: boolean;
  /** Inclusive limits as ISO "YYYY-MM-DD" (what the native date attributes took before). */
  min?: string; max?: string; required?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = show the committed value
  const [problem, setProblem] = useState<string | null>(null);
  const placeholder = useLabel("date.placeholder");
  const text = { invalid: useLabel("date.error.invalid"), incomplete: useLabel("date.error.incomplete"), before: useLabel("date.error.before"), after: useLabel("date.error.after") };
  const shown = draft ?? isoToDisplay(value);
  const errorId = id ? `${id}-error` : undefined;
  const range = (iso: string): string | null => {
    if (min && iso < min) return text.before.replace("{date}", isoToDisplay(min));
    if (max && iso > max) return text.after.replace("{date}", isoToDisplay(max));
    return null;
  };
  return (
    <div className={cn("relative", className)}>
      <input
        id={id} type="text" inputMode="numeric" autoComplete="off" placeholder={placeholder} maxLength={10} aria-label={ariaLabel} disabled={disabled} value={shown}
        required={required} aria-invalid={problem ? true : undefined} aria-describedby={problem ? errorId : undefined}
        className={cn("flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pr-9 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", problem && "border-destructive")}
        onChange={(e) => {
          const next = maskDisplayInput(e.target.value);
          const iso = displayToIso(next);
          if (iso) {
            const outside = range(iso);
            if (outside) { setDraft(next); setProblem(outside); return; } // typed, real, but outside the allowed range → not applied
            setDraft(null); setProblem(null); onChange(iso);
          } else {
            setDraft(next);
            setProblem(next.length === 10 ? text.invalid : null); // ten characters that are not a real date (31/02/2026, 29/02/2027…)
          }
        }}
        onBlur={() => {
          if (draft === "") { setProblem(null); onChange(""); }
          else if (draft !== null && draft.length < 10 && !problem) setProblem(text.incomplete); // part of a date only: say so (the last good value is restored)
          setDraft(null);
        }}
        onFocus={() => setProblem(null)}
      />
      <span className="pointer-events-none absolute right-2 top-[1.125rem] -translate-y-1/2 text-muted-foreground"><CalendarDays className="h-4 w-4" aria-hidden /></span>
      <input
        type="date" tabIndex={-1} aria-hidden="true" disabled={disabled} value={value} min={min} max={max}
        className="absolute right-0 top-0 h-9 w-9 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        onChange={(e) => { if (e.target.value) { setDraft(null); setProblem(null); onChange(e.target.value); } }}
      />
      {problem && <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">{problem}</p>}
    </div>
  );
}
