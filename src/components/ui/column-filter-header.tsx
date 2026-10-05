"use client";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TableHead } from "@/components/ui/table";

export interface ColumnFilterOption {
  value: string;
  label: string;
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
  className,
}: {
  label: string;
  ariaLabel: string;
  options: ColumnFilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyText?: string;
  className?: string;
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
          <DropdownMenuItem
            data-testid="filter-all"
            onSelect={(event) => {
              event.preventDefault();
              onChange([]);
            }}
          >
            <input type="checkbox" readOnly checked={!active} aria-label="All" /> All
          </DropdownMenuItem>
          {options.map((o) => (
            <DropdownMenuItem
              key={o.value}
              data-filter-value={o.value}
              onSelect={(event) => {
                event.preventDefault();
                onChange(toggleFilterValue(selected, o.value));
              }}
            >
              <input type="checkbox" readOnly checked={selected.includes(o.value)} aria-label={o.label} /> {o.label}
            </DropdownMenuItem>
          ))}
          {options.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">{emptyText}</div>}
        </DropdownMenuContent>
      </DropdownMenu>
    </TableHead>
  );
}
