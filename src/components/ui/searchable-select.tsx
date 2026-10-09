"use client";
import * as React from "react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SearchableOption { value: string; label: string }

/** Options whose label contains the query (case-insensitive, whitespace-trimmed). An empty query shows everything. */
export function filterSearchableOptions(options: readonly SearchableOption[], query: string): SearchableOption[] {
  const needle = query.trim().toLowerCase();
  return needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : [...options];
}
/** Next highlighted row for ArrowDown / ArrowUp (wraps; -1 = nothing highlighted yet). */
export function moveActive(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/**
 * ONE field that is both the search box and the dropdown (an ARIA combobox). Click/focus opens the list, typing filters it, ↑/↓ move, Enter picks the
 * highlighted result, Escape closes. The value is ALWAYS one of `options`: editing the text clears the selection until a result is picked, so free text
 * can never be submitted.
 */
export function SearchableSelect({ options, value, onChange, placeholder = "Select…", emptyText = "No results found", ariaLabel, disabled, className, onOpenChange }: {
  options: readonly SearchableOption[]; value: string; onChange: (value: string) => void; placeholder?: string; emptyText?: string; ariaLabel: string; disabled?: boolean; className?: string; onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = not editing → show the selected label
  const [active, setActive] = useState(-1);
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  const selected = options.find((o) => o.value === value);
  const shown = filterSearchableOptions(options, query ?? "");
  const listId = `${ariaLabel.replace(/\W+/g, "-").toLowerCase()}-listbox`;
  const pick = (o: SearchableOption) => { onChange(o.value); setQuery(null); setActive(-1); setOpen(false); };
  const close = () => { setOpen(false); setQuery(null); setActive(-1); };
  return (
    <div className={cn("relative", className)}>
      <Input
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={ariaLabel} autoComplete="off" disabled={disabled}
        aria-activedescendant={open && active >= 0 && shown[active] ? `${listId}-${active}` : undefined}
        placeholder={placeholder} value={query ?? selected?.label ?? ""}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onBlur={close}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); if (value) onChange(""); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!open) setOpen(true); else setActive(moveActive(active, e.key === "ArrowDown" ? 1 : -1, shown.length)); }
          else if (e.key === "Enter") { if (open) { e.preventDefault(); const hit = shown[active >= 0 ? active : shown.length === 1 ? 0 : -1]; if (hit) pick(hit); } }
          else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); close(); }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-background py-1 text-sm shadow-md">
          {shown.length === 0
            ? <li className="px-3 py-2 text-muted-foreground" role="presentation">{emptyText}</li>
            : shown.map((o, i) => (
              <li key={o.value} id={`${listId}-${i}`} role="option" aria-selected={o.value === value}
                className={cn("cursor-pointer px-3 py-1.5", i === active ? "bg-muted" : "hover:bg-muted", o.value === value && "font-medium")}
                onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(i)}>{o.label}</li>
            ))}
        </ul>
      )}
    </div>
  );
}
