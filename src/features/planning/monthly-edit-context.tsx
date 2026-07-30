"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { isQuantityMode, type PlanningMode } from "@/lib/calc";
import { useAutosaveMap } from "./use-autosave-map";
import type { MonthlyData } from "./types";

/**
 * Shared live state for a plan's Monthly Planning workspace — the monthly analogue of
 * PlanEditProvider. Dealer Monthly Plan edits here; Monthly Product Plan and Monthly Dealer
 * Summary read the same live cells and recompute instantly. Autosave reuses the existing
 * /monthly endpoint (no business-logic change).
 */

interface Cell {
  plan: number;
  sale: number;
}
type ValueMap = Record<string, Cell>; // key: planLineId|monthId
const cellKey = (planLineId: string, monthId: string) => `${planLineId}|${monthId}`;

export interface MonthlyEditContextValue {
  planId: string;
  data: MonthlyData;
  monthlyMode: PlanningMode;
  qtyMode: boolean;
  values: ValueMap;
  saving: boolean;
  cellFor: (planLineId: string, monthId: string) => Cell;
  monthEditable: (monthId: string) => boolean;
  setCell: (planLineId: string, monthId: string, field: "plan" | "sale", n: number) => void;
  flush: () => Promise<void>;
}

const Ctx = createContext<MonthlyEditContextValue | null>(null);

export function MonthlyEditProvider({
  planId,
  data,
  saveUrl,
  children,
}: {
  planId: string;
  data: MonthlyData;
  /**
   * Where to persist monthly entries. Defaults to the seasonal-plan monthly endpoint (legacy
   * all-months view); the first-class Monthly Plan passes its own PATCH endpoint so the same
   * provider drives both without duplication.
   */
  saveUrl?: string;
  children: React.ReactNode;
}) {
  const qtyMode = isQuantityMode(data.monthlyMode);
  const persistUrl = saveUrl ?? `/api/planning/season-plans/${planId}/monthly`;

  const initial = useMemo<ValueMap>(() => {
    const map: ValueMap = {};
    for (const d of data.dealers) {
      for (const p of d.products) {
        for (const m of data.months) {
          const e = p.monthly[m.id] ?? { plan: 0, sale: 0 };
          map[cellKey(p.planLineId, m.id)] = { plan: e.plan, sale: e.sale };
        }
      }
    }
    return map;
  }, [data]);

  const editableByMonth = useMemo(() => new Map(data.months.map((m) => [m.id, m.editable])), [data.months]);
  const monthEditable = useCallback((monthId: string) => data.canEdit && (editableByMonth.get(monthId) ?? false), [data.canEdit, editableByMonth]);

  // Persist dirty entries through the existing /monthly endpoint (mode-aware payload).
  const persist = useCallback(
    async (keys: string[], snapshot: ValueMap) => {
      const entries = keys.map((k) => {
        const [lineId, mId] = k.split("|");
        const v = snapshot[k] ?? { plan: 0, sale: 0 };
        return qtyMode
          ? { planLineId: lineId, seasonMonthId: mId, planQty: v.plan, saleQty: v.sale }
          : { planLineId: lineId, seasonMonthId: mId, mode: data.monthlyMode, planValue: v.plan, saleValue: v.sale };
      });
      await api.patch(persistUrl, { entries });
    },
    [qtyMode, data.monthlyMode, persistUrl],
  );

  const { values, saving, update, flush } = useAutosaveMap<Cell>(initial, persist);

  const setCell = useCallback(
    (planLineId: string, monthId: string, field: "plan" | "sale", n: number) => {
      if (!monthEditable(monthId)) return;
      const k = cellKey(planLineId, monthId);
      const cur = values[k] ?? { plan: 0, sale: 0 };
      update(k, { ...cur, [field]: n });
    },
    [monthEditable, values, update],
  );

  const cellFor = useCallback((planLineId: string, monthId: string) => values[cellKey(planLineId, monthId)] ?? { plan: 0, sale: 0 }, [values]);

  const value = useMemo<MonthlyEditContextValue>(
    () => ({ planId, data, monthlyMode: data.monthlyMode, qtyMode, values, saving, cellFor, monthEditable, setCell, flush }),
    [planId, data, qtyMode, values, saving, cellFor, monthEditable, setCell, flush],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMonthlyEdit(): MonthlyEditContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMonthlyEdit must be used within a MonthlyEditProvider");
  return ctx;
}

/** Convenience hook to fetch MonthlyData (shared query key) for the workspace shell. */
export function useMonthlyData(planId: string) {
  return useQuery<MonthlyData>({
    queryKey: ["monthly", planId],
    queryFn: () => api.get(`/api/planning/season-plans/${planId}/monthly`),
  });
}
