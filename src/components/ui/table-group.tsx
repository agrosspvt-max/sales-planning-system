import { cn } from "@/lib/utils";
import { TableHead, TableRow } from "./table";

/**
 * Excel-style column SECTIONS for planning tables — a shared, presentation-only layer used by
 * Seasonal, Monthly, Recovery and any future grid so they stay visually consistent.
 *
 * Two pieces, both purely visual (no data, order or calculation changes):
 *   - <SectionColgroup> paints each section's subtle, theme-aware tint BEHIND its columns via a
 *     single <colgroup> (zero per-cell markup — the row/cell logic is untouched). The leading
 *     (frozen) columns stay neutral so the sticky first column keeps its solid background.
 *   - <SectionHeaderRow> renders the merged "group header" band ABOVE the normal column-header row,
 *     like Excel's grouped headers, with a stronger separator between sections.
 *
 * Tints are defined ONCE here (light pastel / low-opacity dark) and adapt automatically to the
 * active theme through Tailwind's `dark:` variant — no hardcoded, theme-blind colors.
 */

export type SectionTone = "blue" | "slate" | "green" | "amber" | "purple";

const TONE_BG: Record<SectionTone, string> = {
  blue: "bg-blue-50/70 dark:bg-blue-950/30",
  slate: "bg-slate-100/70 dark:bg-slate-800/40",
  green: "bg-green-50/70 dark:bg-green-950/30",
  amber: "bg-amber-50/70 dark:bg-amber-950/30",
  purple: "bg-purple-50/70 dark:bg-purple-950/30",
};

export interface TableSection {
  label: string;
  /** Number of columns this section spans. */
  span: number;
  tone: SectionTone;
}

/** <colgroup> that tints each section's columns (header + body) in one place. */
export function SectionColgroup({ leading = 0, sections }: { leading?: number; sections: TableSection[] }) {
  return (
    <colgroup>
      {leading > 0 && <col span={leading} />}
      {sections.map((s, i) => (
        <col key={i} span={s.span} className={TONE_BG[s.tone]} />
      ))}
    </colgroup>
  );
}

/** Merged group-header row rendered as the FIRST row inside <TableHeader>, above the column labels. */
export function SectionHeaderRow({ leading = 0, sections }: { leading?: number; sections: TableSection[] }) {
  return (
    <TableRow>
      {leading > 0 && <TableHead colSpan={leading} className="h-8 border-b border-border/60" />}
      {sections.map((s, i) => (
        <TableHead
          key={i}
          colSpan={s.span}
          className={cn(
            // Stronger left separator marks where each section begins (Excel-style).
            "h-8 border-b border-l-2 border-border/70 text-center align-middle text-[11px] font-semibold uppercase tracking-wider text-foreground/70",
            TONE_BG[s.tone],
          )}
        >
          {s.label}
        </TableHead>
      ))}
    </TableRow>
  );
}
