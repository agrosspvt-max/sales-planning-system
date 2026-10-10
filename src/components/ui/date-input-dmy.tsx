"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayToIso, isoToDisplay, maskDisplayInput } from "@/lib/date-input";

/**
 * A date field that ALWAYS shows and accepts DD/MM/YYYY, whatever the browser or operating-system locale (a native `<input type="date">` renders
 * MM/DD/YYYY for some users and DD/MM/YYYY for others). `value` / `onChange` stay the ISO `YYYY-MM-DD` string, so callers and APIs are unchanged.
 *  - Typing: digits are masked into DD/MM/YYYY; a complete REAL date is committed at once, an incomplete or impossible one is never emitted and
 *    reverts to the last good value on blur. Clearing the box and leaving it emits "" (the caller's own empty-value fallback applies).
 *  - Picking: the calendar button opens the browser's date picker (an invisible native date input over the icon); its ISO value is used as is.
 */
export function DateInputDMY({ value, onChange, className, "aria-label": ariaLabel, id, disabled }: {
  value: string; onChange: (iso: string) => void; className?: string; "aria-label"?: string; id?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = show the committed value
  const shown = draft ?? isoToDisplay(value);
  return (
    <div className={cn("relative", className)}>
      <input
        id={id} type="text" inputMode="numeric" autoComplete="off" placeholder="DD/MM/YYYY" maxLength={10} aria-label={ariaLabel} disabled={disabled} value={shown}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pr-9 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        onChange={(e) => {
          const next = maskDisplayInput(e.target.value);
          const iso = displayToIso(next);
          if (iso) { setDraft(null); onChange(iso); } else setDraft(next);
        }}
        onBlur={() => { if (draft === "") onChange(""); setDraft(null); }}
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"><CalendarDays className="h-4 w-4" aria-hidden /></span>
      <input
        type="date" tabIndex={-1} aria-hidden="true" disabled={disabled} value={value}
        className="absolute right-0 top-0 h-full w-9 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        onChange={(e) => { if (e.target.value) { setDraft(null); onChange(e.target.value); } }}
      />
    </div>
  );
}
