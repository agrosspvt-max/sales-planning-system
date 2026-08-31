"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Check, X, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import { TableHead, TableRow } from "@/components/ui/table";
import { TONE_BG, type SectionTone } from "@/components/ui/table-group";
import { DEFAULT_LABELS, resolveLabels, type LabelKey } from "./labels";

/* ------------------------------- Context -------------------------------- */

interface LabelCtx {
  labels: Record<string, string>;
  canEdit: boolean;
  editMode: boolean;
  setEditMode: (on: boolean) => void;
  save: (key: LabelKey, value: string) => Promise<void>;
}
const Ctx = createContext<LabelCtx | null>(null);

/**
 * The ONE label source for every planning screen. Loads admin overrides (merged over DEFAULT_LABELS)
 * and exposes an admin-only edit mode. A saved override updates every place its key is used at once.
 */
export function LabelProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [editMode, setEditMode] = useState(false);
  const { data } = useQuery<{ overrides: Record<string, string>; canEdit: boolean }>({
    queryKey: ["labels"],
    queryFn: () => api.get("/api/labels"),
    staleTime: 5 * 60_000,
  });
  const labels = useMemo(() => resolveLabels(data?.overrides), [data?.overrides]);
  const canEdit = data?.canEdit ?? false;

  const saveMut = useMutation({
    mutationFn: (v: { key: LabelKey; value: string }) => api.patch<{ overrides: Record<string, string> }>("/api/labels", v),
    onSuccess: (res: { overrides: Record<string, string> }) => {
      qc.setQueryData<{ overrides: Record<string, string>; canEdit: boolean }>(["labels"], (prev) => ({
        overrides: res.overrides,
        canEdit: prev?.canEdit ?? canEdit,
      }));
    },
  });
  const save = async (key: LabelKey, value: string) => {
    await saveMut.mutateAsync({ key, value });
  };

  const value: LabelCtx = { labels, canEdit, editMode, setEditMode, save };
  return (
    <Ctx.Provider value={value}>
      {children}
      {canEdit && <LabelEditToggle editMode={editMode} setEditMode={setEditMode} />}
    </Ctx.Provider>
  );
}

function useLabelCtx(): LabelCtx {
  // Safe default so any table can render even outside a provider (labels = defaults, no edit).
  return (
    useContext(Ctx) ?? {
      labels: { ...DEFAULT_LABELS },
      canEdit: false,
      editMode: false,
      setEditMode: () => {},
      save: async () => {},
    }
  );
}

/** Resolve one label (override → default). */
export function useLabel(key: LabelKey): string {
  return useLabelCtx().labels[key] ?? DEFAULT_LABELS[key];
}

/**
 * Inline label text for structural controls that are NOT table headers — flip/tab buttons, view pills,
 * and any header cell not rendered through <Th>. Renders the current (override → default) text globally;
 * editing happens on the Admin Labels page. As a component it may be used anywhere in JSX, including maps.
 */
export function L({ k }: { k: LabelKey }): ReactNode {
  return useLabel(k);
}

/* ------------------------- Admin edit-mode toggle ------------------------ */

function LabelEditToggle({ editMode, setEditMode }: { editMode: boolean; setEditMode: (on: boolean) => void }) {
  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2">
      {editMode && (
        <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning shadow-sm">
          Label edit mode — hover a header and click the pencil to rename.
        </span>
      )}
      <button
        onClick={() => setEditMode(!editMode)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-2 text-sm font-medium shadow-md",
          editMode ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-foreground hover:bg-muted",
        )}
      >
        <Tag className="h-4 w-4" /> {editMode ? "Done" : "Edit Labels"}
      </button>
    </div>
  );
}

/* ---------------------------- Header rendering --------------------------- */

/**
 * Header text. `stack` (column headers): every word on its own line to keep columns narrow.
 * Natural (grouped SECTION bands): wrap only as needed across the wide merged cell, so long section
 * titles stay compact and every planning table's group-header band has one consistent height.
 */
function LabelText({ text, stack }: { text: string; stack: boolean }) {
  if (stack) return <span className="whitespace-pre-line">{text.replace(/\s+/g, "\n")}</span>;
  return <span className="whitespace-normal">{text}</span>;
}

/** Public word-stacking wrapper for DYNAMIC header text (report columns, pack sizes) — no label lookup. */
export function WrapHeader({ text }: { text: string }) {
  return <LabelText text={text} stack />;
}

/** Inline rename box shown in edit mode. */
function InlineEditor({ labelKey, current, onDone }: { labelKey: LabelKey; current: string; onDone: () => void }) {
  const { save } = useLabelCtx();
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    setBusy(true);
    try { await save(labelKey, value); } finally { setBusy(false); onDone(); }
  };
  return (
    <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") onDone(); }}
        className="h-6 w-28 rounded border border-input bg-background px-1 text-xs font-normal normal-case"
      />
      <button onClick={() => void commit()} disabled={busy} className="text-success"><Check className="h-3.5 w-3.5" /></button>
      <button onClick={onDone} disabled={busy} className="text-muted-foreground"><X className="h-3.5 w-3.5" /></button>
    </span>
  );
}

/**
 * A header cell that pulls its text (and, in edit mode, its editor) from a label key. `stack` controls
 * word-per-line (column headers) vs natural wrap (grouped section bands).
 */
function LabelHeaderContent({ labelKey, stack = true }: { labelKey: LabelKey; stack?: boolean }) {
  const { labels, canEdit, editMode } = useLabelCtx();
  const [editing, setEditing] = useState(false);
  const text = labels[labelKey] ?? DEFAULT_LABELS[labelKey];
  if (editing) return <InlineEditor labelKey={labelKey} current={text} onDone={() => setEditing(false)} />;
  if (canEdit && editMode) {
    return (
      <span className="group/lbl inline-flex items-start gap-1">
        <LabelText text={text} stack={stack} />
        <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} className="opacity-0 transition-opacity group-hover/lbl:opacity-100" title="Rename label">
          <Pencil className="h-3 w-3" />
        </button>
      </span>
    );
  }
  return <LabelText text={text} stack={stack} />;
}

/**
 * Shared planning column header — the ONE header renderer. Reads its text from the label dictionary,
 * stacks words (keeping the passed alignment), and is admin-editable in label edit mode.
 */
export function Th({ labelKey, className, colSpan, suffix }: { labelKey: LabelKey; className?: string; colSpan?: number; suffix?: React.ReactNode }) {
  return (
    <TableHead className={className} colSpan={colSpan}>
      <LabelHeaderContent labelKey={labelKey} />
      {suffix}
    </TableHead>
  );
}

/** A plain (non-label) header — for dynamic titles like pack sizes / dealer names that are DATA. */
export function ThPlain({ children, className, colSpan }: { children: React.ReactNode; className?: string; colSpan?: number }) {
  return <TableHead className={className} colSpan={colSpan}>{children}</TableHead>;
}

export interface LabelSection {
  labelKey: LabelKey;
  span: number;
  tone: SectionTone;
  /** Optional exact header-band background (hex). Overrides the tone class; text is forced white. */
  color?: string;
}

/** Label-aware Excel-style section band (the ONE grouped-header renderer). Titles are editable. */
export function LabelSectionHeaderRow({ leading = 0, sections }: { leading?: number; sections: LabelSection[] }) {
  return (
    <TableRow>
      {leading > 0 && <TableHead colSpan={leading} className="h-8 border-b border-border/60" />}
      {sections.map((s, i) => (
        <TableHead
          key={i}
          colSpan={s.span}
          style={s.color ? { backgroundColor: s.color, color: "#fff" } : undefined}
          className={cn(
            "h-8 border-b border-l-2 border-border/70 text-center align-middle text-[11px] font-semibold uppercase tracking-wider",
            s.color ? "text-white" : "text-foreground/70",
            !s.color && TONE_BG[s.tone],
          )}
        >
          <LabelHeaderContent labelKey={s.labelKey} stack={false} />
        </TableHead>
      ))}
    </TableRow>
  );
}
