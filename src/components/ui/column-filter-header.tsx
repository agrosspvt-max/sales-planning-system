"use client";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TableHead } from "@/components/ui/table";

export interface ColumnFilterOption {
  value: string;
  label: string;
  /** Optional compact display text; searching and accessible names still use the full label. */
  displayLabel?: string;
  /** Optional second, muted line under the label (searched too). Selection identity stays `value`. */
  secondary?: string;
}

/** Search inside the popup: case-insensitive partial match on the label OR the second line (e.g. territory or requester name). Never creates a value. */
export function filterColumnOptions(options: readonly ColumnFilterOption[], query: string): ColumnFilterOption[] {
  const needle = query.trim().toLowerCase();
  return needle ? options.filter((o) => o.label.toLowerCase().includes(needle) || (o.secondary ?? "").toLowerCase().includes(needle)) : [...options];
}

/** Add the value if absent, remove it if present. Multiple selections within one column are OR-ed by the caller. */
export function toggleFilterValue(selected: readonly string[], value: string): string[] {
  return selected.includes(value) ? selected.filter((x) => x !== value) : [...selected, value];
}

/** The header label, with the active-filter count: "Month" / "Month (2)". */
export function filterHeaderLabel(label: string, count: number): string {
  return count > 0 ? `${label} (${count})` : label;
}

/**
 * A table column header that doubles as a multi-select filter (shared by Dealer Tags and Recovery Planning):
 * the header text opens a checkbox list with "All" (clears) and one entry per option; an active filter shows its
 * count and is highlighted. The caller owns the selection state and applies it (OR within a column).
 */
export function ColumnFilterHeader({
  label,
  ariaLabel,
  options,
  selected,
  onChange,
  emptyText = "No options",
  allLabel = "All",
  className,
  searchable = false,
  searchPlaceholder = "Search…",
  noMatchText = "No matches",
}: {
  label: string;
  ariaLabel: string;
  options: ColumnFilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyText?: string;
  /** Text of the "All" choice (a host passes its editable label). */
  allLabel?: string;
  className?: string;
  /** Adds a search box inside the popup that narrows the CHOICES (it never creates a value; the selection is unaffected). */
  searchable?: boolean;
  searchPlaceholder?: string;
  noMatchText?: string;
}) {
  const active = selected.length > 0;

  return (
    <TableHead className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className={`inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted ${active ? "text-primary" : ""}`}
          >
            {filterHeaderLabel(label, selected.length)}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 min-w-[14rem] overflow-y-auto normal-case">
          <FilterChoices
            options={options} selected={selected} onChange={onChange} emptyText={emptyText} allLabel={allLabel} searchable={searchable} searchPlaceholder={searchPlaceholder} noMatchText={noMatchText}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TableHead>
  );
}

/** The popup's content. Its search text lives here, so it starts empty every time the popup opens and never touches the selection. */
function FilterChoices({ options, selected, onChange, emptyText, allLabel, searchable, searchPlaceholder, noMatchText }: {
  options: ColumnFilterOption[]; selected: string[]; onChange: (next: string[]) => void; emptyText: string; allLabel: string; searchable: boolean; searchPlaceholder: string; noMatchText: string;
}) {
  const active = selected.length > 0;
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = filterColumnOptions(options, query);
  return (
    <>
          {searchable && (
            <div className="sticky top-0 z-10 bg-popover p-1.5">
              <input
                type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} data-testid="filter-search" autoFocus
                onKeyDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}
          <DropdownMenuItem
            data-testid="filter-all"
            onSelect={(event) => {
              event.preventDefault();
              onChange([]);
            }}
          >
            <input type="checkbox" readOnly checked={!active} aria-label={allLabel} /> {allLabel}
          </DropdownMenuItem>
          {shown.map((o) => (
            <DropdownMenuItem
              key={o.value}
              data-filter-value={o.value}
              onSelect={(event) => {
                event.preventDefault();
                onChange(toggleFilterValue(selected, o.value));
              }}
            >
              <input type="checkbox" readOnly checked={selected.includes(o.value)} aria-label={o.secondary ? `${o.label} — ${o.secondary}` : o.label} />{" "}
              {o.secondary ? <span className="min-w-0 flex flex-col leading-tight"><span className="max-w-72 truncate" title={o.label}>{o.displayLabel ?? o.label}</span><span className="text-xs text-muted-foreground" data-testid="filter-secondary">{o.secondary}</span></span> : o.label}
            </DropdownMenuItem>
          ))}
          {options.length === 0 ? <div className="px-2 py-1.5 text-muted-foreground">{emptyText}</div> : shown.length === 0 && <div className="px-2 py-1.5 text-muted-foreground" data-testid="filter-no-match">{noMatchText}</div>}
    </>
  );
}
