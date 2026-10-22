"use client";

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { filterSearchableOptions, type SearchableOption } from "./searchable-select";

/** Search filters choices only. Checkbox selection stays open and uses ids; selected items can also be removed below the picker. */
export function SearchableMultiSelect({ options, value, onChange, label, placeholder, searchPlaceholder, emptyText, noMatchText, removeLabel, unavailableLabel, disabled }: {
  options: readonly SearchableOption[]; value: readonly string[]; onChange: (next: string[]) => void;
  label: string; placeholder: string; searchPlaceholder: string; emptyText: string; noMatchText: string; removeLabel: string; unavailableLabel: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = filterSearchableOptions(options, query);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...new Set([...value, id])]);
  return <div className="space-y-2">
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); setQuery(""); }}>
      <DropdownMenuTrigger asChild><button type="button" aria-label={label} disabled={disabled} className="flex min-h-10 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm disabled:opacity-50">
        <span>{value.length ? `${label} (${value.length})` : placeholder}</span><ChevronDown className="h-4 w-4 shrink-0" />
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] min-w-64 overflow-y-auto">
        <div className="sticky top-0 bg-background p-1"><input type="search" autoFocus aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }} onClick={(e) => e.stopPropagation()} className="h-9 w-full rounded border bg-background px-2 text-sm" /></div>
        {shown.map((option) => <DropdownMenuItem key={option.value} role="menuitemcheckbox" aria-checked={value.includes(option.value)} onSelect={(e) => { e.preventDefault(); toggle(option.value); }}>
          <input type="checkbox" readOnly tabIndex={-1} checked={value.includes(option.value)} aria-hidden /><span className="whitespace-normal">{option.label}</span>
        </DropdownMenuItem>)}
        {shown.length === 0 && <p className="p-2 text-sm text-muted-foreground">{options.length ? noMatchText : emptyText}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
    {value.length > 0 && <ul className="max-h-36 space-y-1 overflow-y-auto" aria-label={label}>{value.map((id) => {
      const name = options.find((option) => option.value === id)?.label ?? unavailableLabel;
      return <li key={id} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm"><span>{name}</span><button type="button" disabled={disabled} onClick={() => onChange(value.filter((v) => v !== id))} aria-label={removeLabel.replace("{name}", name)} className="rounded p-1 hover:bg-muted"><X className="h-4 w-4" /></button></li>;
    })}</ul>}
  </div>;
}
