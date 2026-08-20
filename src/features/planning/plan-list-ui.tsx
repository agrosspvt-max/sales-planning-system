"use client";

import { useState } from "react";
import { X, ChevronDown } from "lucide-react";
import { NativeSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { PlanStatus } from "./types";

/* --------------------------------- Status groups -------------------------------- */
// Shared across Sales + Recovery so the Create / Submitted / Approved buckets mean the same everywhere.
export const CREATE_STATUSES: PlanStatus[] = ["DRAFT", "RETURNED", "REJECTED"]; // editable / in-progress
export const SUBMITTED_STATUSES: PlanStatus[] = ["PENDING_RM", "PENDING_ADMIN"]; // waiting for approval

/* ------------------------------- Newest-first sort ------------------------------ */
// Latest season first (by year, then Kharif → Rabi → Zaid), then most recently updated.
const SEASON_ORDER: Record<string, number> = { kharif: 1, rabi: 2, zaid: 3 };
export function yearOf(name: string): number {
  const m = name.match(/(\d{4})/g);
  return m ? Number(m[m.length - 1]) : 0;
}
export function seasonIndexOf(name: string): number {
  const lower = name.toLowerCase();
  for (const key of Object.keys(SEASON_ORDER)) if (lower.includes(key)) return SEASON_ORDER[key];
  return 0;
}
/** Newest-first comparator for season-named rows (Seasonal + Yearly). */
export function bySeasonNewestFirst<T extends { seasonName: string; updatedAt?: string }>(a: T, b: T): number {
  const ya = yearOf(a.seasonName), yb = yearOf(b.seasonName);
  if (ya !== yb) return yb - ya;
  const sa = seasonIndexOf(a.seasonName), sb = seasonIndexOf(b.seasonName);
  if (sa !== sb) return sb - sa;
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}
/** Newest-first for a plain date field (fallback for month/cutoff-based lists). */
export function byDateDesc<T>(get: (row: T) => string) {
  return (a: T, b: T) => (get(b) ?? "").localeCompare(get(a) ?? "");
}

/* -------------------------------- Role sections --------------------------------- */
export interface Section<T> {
  key: string;
  title: string;
  rows: T[];
}
/**
 * Split a role's visible rows into the requested sections:
 *  - Sales Officer → one "My …" section (own only).
 *  - Regional Manager → "My Plans" (own) + "Team Plans" (group, others).
 *  - Super Admin → one section titled with `adminTitle` (all users).
 */
export function roleSections<T extends { officerId: string }>(
  rows: T[],
  role: "SALES_OFFICER" | "REGIONAL_MANAGER" | "SUPER_ADMIN",
  userId: string,
  labels: { mine: string; team: string; admin: string },
): Section<T>[] {
  if (role === "SUPER_ADMIN") return [{ key: "all", title: labels.admin, rows }];
  if (role === "REGIONAL_MANAGER") {
    return [
      { key: "mine", title: labels.mine, rows: rows.filter((r) => r.officerId === userId) },
      { key: "team", title: labels.team, rows: rows.filter((r) => r.officerId !== userId) },
    ];
  }
  return [{ key: "mine", title: labels.mine, rows }];
}

/* ------------------------------ Dynamic Add-Filter ------------------------------ */
export interface FilterDef {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}
/**
 * Multi-select dropdown for one filter's values: chips for the current selection, a "Select all" row,
 * and a checkbox per option. Native `<details>` (no external click-outside logic); dark-theme styled.
 */
function MultiSelect({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const allSelected = options.length > 0 && value.length === options.length;
  const selected = options.filter((o) => value.includes(o.value));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const toggleAll = () => onChange(allSelected ? [] : options.map((o) => o.value));
  return (
    <details className="group relative">
      <summary className="flex min-h-8 min-w-[11rem] max-w-xs cursor-pointer list-none items-center gap-1 rounded-md border bg-background px-2 py-1 text-sm">
        {value.length === 0 ? (
          <span className="text-muted-foreground">All {label}</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {selected.map((o) => (
              <span key={o.value} className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-foreground">
                {o.label}
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(o.value); }}
                  aria-label={`Remove ${o.label}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </span>
        )}
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute z-20 mt-1 max-h-64 w-60 overflow-auto rounded-md border bg-background p-1 shadow-md">
        <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
          <input type="checkbox" className="h-4 w-4" checked={allSelected} onChange={toggleAll} />
          <span className="font-medium">All {label}</span>
        </label>
        <div className="my-1 border-t" />
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No options.</div>
        ) : (
          options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
              <input type="checkbox" className="h-4 w-4" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
            </label>
          ))
        )}
      </div>
    </details>
  );
}

/**
 * "+ Add Filter" bar (Older Plans). No filters are shown by default — the user adds only the ones they
 * need. Picking a type from "+ Add Filter" reveals its MULTI-select dropdown (chips + Select all); each
 * active filter can be removed with ✕. Multiple values within a filter combine with OR (see consumers).
 */
export function AddFilterBar({
  defs,
  value,
  onChange,
}: {
  defs: FilterDef[];
  value: Record<string, string[]>;
  onChange: (v: Record<string, string[]>) => void;
}) {
  const [active, setActive] = useState<string[]>([]);
  const unused = defs.filter((d) => !active.includes(d.key));
  const add = (key: string) => { if (key) setActive((a) => [...a, key]); };
  const remove = (key: string) => {
    setActive((a) => a.filter((k) => k !== key));
    const next = { ...value }; delete next[key]; onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {active.map((k) => {
        const def = defs.find((d) => d.key === k);
        if (!def) return null;
        return (
          <div key={k} className="inline-flex items-center gap-1 rounded-md border bg-background py-1 pl-2 pr-1">
            <span className="text-xs font-medium text-muted-foreground">{def.label}:</span>
            <MultiSelect label={def.label} options={def.options} value={value[k] ?? []} onChange={(vals) => onChange({ ...value, [k]: vals })} />
            <button onClick={() => remove(k)} aria-label={`Remove ${def.label} filter`} className="text-muted-foreground hover:text-destructive">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <NativeSelect
          className={cn("h-8 w-36", active.length === 0 && "text-muted-foreground")}
          options={[{ value: "", label: "+ Add Filter" }, ...unused.map((d) => ({ value: d.key, label: d.label }))]}
          value=""
          onChange={(e) => add(e.target.value)}
        />
      )}
    </div>
  );
}

/* ------------------------------ Sub-nav pill bar -------------------------------- */
/** Small segmented control reused for the [Create New Plan | View Plans] toggle and the View sub-tabs. */
export function PillNav<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={cn("rounded px-3 py-1.5 font-medium", value === it.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Convenience: unique options from rows for a field (for the Add-Filter dropdowns). */
export function optionsFrom<T>(rows: T[], get: (r: T) => { id: string; label: string } | null): { value: string; label: string }[] {
  const map = new Map<string, string>();
  for (const r of rows) { const o = get(r); if (o && !map.has(o.id)) map.set(o.id, o.label); }
  return [...map.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}
