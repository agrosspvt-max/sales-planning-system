"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { figuresForMode, isQuantityMode, type FlexFigures, type PlanningMode } from "@/lib/calc";
import { useAutosaveMap } from "./use-autosave-map";
import type { PlanDetail, PlanLineDetail, PackSizeColumn } from "./types";

/**
 * Shared live state for a Seasonal plan's workspace.
 *
 * Dealer Plan edits here; Product Plan and Dealer Summary READ the same live cells and
 * recompute instantly (no refetch / page refresh). Autosave (debounced) persists edits and
 * reuses the existing /lines endpoint — no business logic changes.
 */

interface Cell {
  packs: Record<string, number>;
  value: number;
}
type ValueMap = Record<string, Cell>; // key: dealerId|productId

const key = (dealerId: string, productId: string) => `${dealerId}|${productId}`;

function storedFigures(l: PlanLineDetail): FlexFigures {
  const mode: PlanningMode = l.inputMode ?? "PACK_SIZE";
  const value = mode === "PACK_SIZE" ? Object.values(l.packs).reduce((a, b) => a + b, 0) : l.inputValue ?? 0;
  return figuresForMode(mode, value, l.rate, l.nbvPercent);
}
function seedValue(l: PlanLineDetail, mode: PlanningMode): number {
  const fig = storedFigures(l);
  if (mode === "TOTAL_QUANTITY") return fig.totalQty ?? 0;
  if (mode === "AMOUNT") return fig.amount ?? 0;
  if (mode === "NBV") return fig.nbv ?? 0;
  return 0;
}

export interface PlanEditContextValue {
  detail: PlanDetail;
  mode: PlanningMode;
  packMode: boolean;
  packColumns: PackSizeColumn[];
  packIds: string[];
  editable: boolean;
  saving: boolean;
  lastSaved: string;
  cells: ValueMap;
  setPack: (dealerId: string, productId: string, packSizeId: string, n: number) => void;
  setValue: (dealerId: string, productId: string, n: number) => void;
  flush: () => Promise<void>;
  /** Live input (pack sum or single value) for one cell. */
  cellInput: (dealerId: string, productId: string) => number;
  /** Live figures for one line, in the current mode. */
  lineFig: (dealerId: string, l: PlanLineDetail) => FlexFigures;
  /** True when the dealer has ≥1 SAVED quantity (completion is based on save, not typing). */
  dealerCompleted: (dealerId: string) => boolean;
}

const Ctx = createContext<PlanEditContextValue | null>(null);

export function PlanEditProvider({ detail, children }: { detail: PlanDetail; children: React.ReactNode }) {
  const mode = detail.seasonalMode;
  const packMode = mode === "PACK_SIZE";
  const packColumns = detail.packSizes;
  const packIds = useMemo(() => packColumns.map((p) => p.id), [packColumns]);
  const editable = detail.canEdit;
  const qc = useQueryClient();

  const initial = useMemo<ValueMap>(() => {
    const map: ValueMap = {};
    for (const d of detail.dealers) {
      for (const l of d.lines) {
        const packs: Record<string, number> = {};
        for (const id of packIds) packs[id] = l.packs[id] ?? 0;
        map[key(d.dealerId, l.productId)] = { packs, value: seedValue(l, mode) };
      }
    }
    return map;
  }, [detail, packIds, mode]);

  // The editable grid is seeded ONCE per plan identity. `detail` may refresh (e.g. after a
  // No Plan change) without wiping in-progress edits — only a different plan reseeds cells.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seed = useMemo(() => initial, [detail.id]);

  const [lastSaved, setLastSaved] = useState<string>(detail.lastSavedAt);
  // Snapshot of what has been PERSISTED (seeded from the loaded plan). Completion is derived
  // from this, so typing alone never marks a dealer complete — only a successful save does.
  const savedRef = useRef<ValueMap>(initial);
  useEffect(() => {
    savedRef.current = initial;
  }, [initial]);

  // Persist dirty lines through the existing /lines endpoint (mode-aware payload).
  const persist = useCallback(
    async (keys: string[], snapshot: ValueMap) => {
      const lines = keys.map((k) => {
        const [dId, pId] = k.split("|");
        const cell = snapshot[k] ?? { packs: {}, value: 0 };
        if (packMode) {
          return {
            dealerId: dId,
            productId: pId,
            mode: "PACK_SIZE" as const,
            packs: packIds.map((id) => ({ packSizeId: id, quantity: cell.packs[id] ?? 0 })),
          };
        }
        return { dealerId: dId, productId: pId, mode, value: cell.value };
      });
      const res = await api.patch<{ lastSavedAt: string }>(`/api/planning/season-plans/${detail.id}/lines`, { lines });
      // Only after the save succeeds do these keys count as "saved".
      for (const k of keys) savedRef.current = { ...savedRef.current, [k]: snapshot[k] };
      setLastSaved(res.lastSavedAt);
      // Refresh the plan so completion-based gating (submit) sees live saved state. Safe:
      // the editable cells are seeded per plan identity, so a refetch never wipes edits.
      qc.invalidateQueries({ queryKey: ["plan", detail.id] });
    },
    [packMode, packIds, mode, detail.id, qc],
  );

  const { values: cells, saving, update, flush } = useAutosaveMap<Cell>(seed, persist);

  const setPack = useCallback(
    (dealerId: string, productId: string, packSizeId: string, n: number) => {
      if (!editable) return;
      const k = key(dealerId, productId);
      const cell = cells[k] ?? { packs: {}, value: 0 };
      update(k, { ...cell, packs: { ...cell.packs, [packSizeId]: n } });
    },
    [editable, cells, update],
  );

  const setValue = useCallback(
    (dealerId: string, productId: string, n: number) => {
      if (!editable) return;
      const k = key(dealerId, productId);
      const cell = cells[k] ?? { packs: {}, value: 0 };
      update(k, { ...cell, value: n });
    },
    [editable, cells, update],
  );

  const cellInput = useCallback(
    (dealerId: string, productId: string) => {
      const cell = cells[key(dealerId, productId)] ?? { packs: {}, value: 0 };
      return packMode ? packIds.reduce((s, id) => s + (cell.packs[id] ?? 0), 0) : cell.value;
    },
    [cells, packMode, packIds],
  );

  const lineFig = useCallback(
    (dealerId: string, l: PlanLineDetail): FlexFigures =>
      figuresForMode(mode, cellInput(dealerId, l.productId), l.rate, l.nbvPercent),
    [mode, cellInput],
  );

  // Depends on `saving` so the value (and progress bar) recompute right after each save.
  const dealerCompleted = useCallback(
    (dealerId: string): boolean => {
      const dealer = detail.dealers.find((d) => d.dealerId === dealerId);
      if (!dealer) return false;
      return dealer.lines.some((l) => {
        const cell = savedRef.current[key(dealerId, l.productId)];
        if (!cell) return false;
        const input = packMode ? Object.values(cell.packs).reduce((s, v) => s + (v || 0), 0) : cell.value;
        return input > 0;
      });
    },
    [detail, packMode, saving], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Memoized so consumers only re-render when a dependency actually changes.
  const value = useMemo<PlanEditContextValue>(
    () => ({ detail, mode, packMode, packColumns, packIds, editable, saving, lastSaved, cells, setPack, setValue, flush, cellInput, lineFig, dealerCompleted }),
    [detail, mode, packMode, packColumns, packIds, editable, saving, lastSaved, cells, setPack, setValue, flush, cellInput, lineFig, dealerCompleted],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlanEdit(): PlanEditContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlanEdit must be used within a PlanEditProvider");
  return ctx;
}

export { isQuantityMode };
