"use client";
import * as React from "react";
import { ChevronDown, Search } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { filterSearchableOptions, moveActive, type SearchableOption } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";

/**
 * A select-style dropdown with a search box INSIDE its list, for fields that live in tables / scrolling containers.
 * The list is rendered through the shared Radix popper PORTAL (the same one the column-filter dropdowns use), so no table `overflow` can clip it:
 * it is positioned from the trigger, flips / shifts to stay inside the viewport, scrolls on its own and sits above the page.
 *
 *  • The trigger shows the selected option's label (or the placeholder) with a chevron; click / tap / Enter / Space / ↓ opens the full list at once.
 *  • Typing in the list's search box only FILTERS (case-insensitive, partial). Search text is a separate piece of state: it never becomes a value, and
 *    cancelling (Escape, clicking outside, closing) leaves the current selection untouched and calls `onChange` for nothing.
 *  • ↑ / ↓ move, Enter picks the highlighted option, Escape closes; options are also plain click / touch targets.
 *  • The value is always one of `options` — there is no free-text path.
 * Every instance gets its own ids (useId), so many rows can coexist on one page.
 */
export function SearchableDropdown({ options, value, onChange, placeholder, searchPlaceholder, emptyText, noMatchText, ariaLabel, searchLabel, disabled, className }: {
  options: readonly SearchableOption[]; value: string; onChange: (value: string) => void;
  placeholder: string; searchPlaceholder: string; /** shown when there are no options at all */ emptyText: string; /** shown when the search matches nothing */ noMatchText: string;
  ariaLabel: string; searchLabel: string; disabled?: boolean; className?: string;
}) {
  const uid = React.useId();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value);
  const shown = filterSearchableOptions(options, query);
  const listId = `${uid}-list`;

  // The search box takes focus once the portalled list is mounted (after Radix has placed its own focus on the content).
  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    const t2 = window.setTimeout(() => { if (document.activeElement !== searchRef.current) searchRef.current?.focus(); }, 60);
    return () => { window.clearTimeout(t); window.clearTimeout(t2); };
  }, [open]);
  const close = () => { setOpen(false); setQuery(""); setActive(0); };
  const pick = (o: SearchableOption) => { onChange(o.value); close(); };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { if (next) { setOpen(true); setQuery(""); setActive(Math.max(0, options.findIndex((o) => o.value === value))); } else close(); }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button" id={`${uid}-trigger`} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={ariaLabel} disabled={disabled}
          className={cn("flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className)}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start" collisionPadding={8} data-testid="searchable-dropdown-content"
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-[max(var(--radix-dropdown-menu-trigger-width),16rem)] max-w-[calc(100vw-1rem)] p-0"
      >
        <div className="flex items-center gap-2 border-b px-2">
          <Search className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
          <input
            ref={searchRef} id={`${uid}-search`} type="text" role="searchbox" aria-label={searchLabel} aria-controls={listId} autoComplete="off" placeholder={searchPlaceholder}
            aria-activedescendant={shown[active] ? `${uid}-opt-${active}` : undefined}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") return; // Radix closes the list (and returns focus to the trigger)
              e.stopPropagation(); // typing must not trigger the menu's own type-ahead / roving focus
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(moveActive(active, e.key === "ArrowDown" ? 1 : -1, shown.length)); }
              else if (e.key === "Enter") { e.preventDefault(); const hit = shown[active]; if (hit) pick(hit); }
            }}
          />
        </div>
        <div id={listId} role="listbox" aria-label={ariaLabel} className="max-h-56 overflow-y-auto py-1 text-sm">
          {shown.length === 0
            ? <div className="px-3 py-2 text-muted-foreground" role="presentation">{options.length === 0 ? emptyText : noMatchText}</div>
            : shown.map((o, i) => (
              <div
                key={o.value} id={`${uid}-opt-${i}`} role="option" aria-selected={o.value === value}
                className={cn("cursor-pointer px-3 py-1.5", i === active ? "bg-muted" : "hover:bg-muted", o.value === value && "font-medium")}
                onPointerMove={() => setActive(i)}
                onPointerDown={(e) => e.preventDefault()} // keep focus in the search box; the selection happens on click / tap
                onClick={() => pick(o)}
              >{o.label}</div>
            ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
