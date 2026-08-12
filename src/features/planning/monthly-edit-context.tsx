"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { isQuantityMode, type PlanningMode } from "@/lib/calc";
import { useAutosaveMap } from "./use-autosave-map";
import type { AdminChange } from "./admin-edit-ui";
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
  /** The first-class Monthly Plan id (present only in the Monthly Plan workspace, not legacy). */
  monthlyPlanId?: string;
  data: MonthlyData;
  monthlyMode: PlanningMode;
  qtyMode: boolean;
  values: ValueMap;
  saving: boolean;
  cellFor: (planLineId: string, monthId: string) => Cell;
  monthEditable: (monthId: string) => boolean;
  setCell: (planLineId: string, monthId: string, field: "plan" | "sale", n: number) => void;
  flush: () => Promise<void>;
  // --- Admin Edit Mode ---
  canAdminEdit: boolean;
  adminMode: boolean;
  adminSaving: boolean;
  adminError: string | null;
  enterAdminMode: () => void;
  cancelAdminMode: () => void;
  adminChanges: () => AdminChange[];
  adminSave: (reason: string) => Promise<void>;
  /** Shared open-state for the "Additional Products" section, so a mobile FAB / action bar can
   *  open it and auto-scroll to it without the user hunting at the bottom of the page. */
  additionalOpen: boolean;
  setAdditionalOpen: (open: boolean) => void;
}

const Ctx = createContext<MonthlyEditContextValue | null>(null);

export function MonthlyEditProvider({
  planId,
  monthlyPlanId,
  data,
  saveUrl,
  invalidateKey,
  children,
}: {
  planId: string;
  monthlyPlanId?: string;
  data: MonthlyData;
  /**
   * Where to persist monthly entries. Defaults to the seasonal-plan monthly endpoint (legacy
   * all-months view); the first-class Monthly Plan passes its own PATCH endpoint so the same
   * provider drives both without duplication.
   */
  saveUrl?: string;
  /** Query key refetched after each save so derived completion (progress bar / ticks) updates. */
  invalidateKey?: readonly unknown[];
  children: React.ReactNode;
}) {
  const qtyMode = isQuantityMode(data.monthlyMode);
  const persistUrl = saveUrl ?? `/api/planning/season-plans/${planId}/monthly`;
  const qc = useQueryClient();

  // Admin Edit Mode (Super Admin correcting an APPROVED monthly plan) — only for the first-class
  // Monthly Plan workspace (which has a monthlyPlanId + a dedicated admin endpoint). Staged in an overlay.
  const canAdminEdit = !!data.canAdminEdit && !!monthlyPlanId;
  const [adminMode, setAdminMode] = useState(false);
  const [adminEdits, setAdminEdits] = useState<ValueMap>({});
  const [adminSaving, setAdminSaving] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

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

  // Seed the editable grid ONCE per plan identity so a refetch (triggered after a save to
  // refresh completion) never wipes in-progress edits — the same pattern as PlanEditProvider.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seed = useMemo(() => initial, [planId]);

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
      // Refresh derived completion (progress bar / dropdown ticks / submit gate). Safe: the
      // editable grid is seeded per plan identity, so a refetch never wipes edits.
      if (invalidateKey) qc.invalidateQueries({ queryKey: invalidateKey });
    },
    [qtyMode, data.monthlyMode, persistUrl, invalidateKey, qc],
  );

  const { values, saving, update, flush } = useAutosaveMap<Cell>(seed, persist);

  const setCell = useCallback(
    (planLineId: string, monthId: string, field: "plan" | "sale", n: number) => {
      const k = cellKey(planLineId, monthId);
      if (adminMode) {
        // Admin Edit only touches the PLAN input (never actual "sale", which is imported).
        if (field !== "plan") return;
        setAdminEdits((prev) => {
          const cur = prev[k] ?? initial[k] ?? { plan: 0, sale: 0 };
          return { ...prev, [k]: { ...cur, plan: n } };
        });
        return;
      }
      if (!monthEditable(monthId)) return;
      const cur = values[k] ?? { plan: 0, sale: 0 };
      update(k, { ...cur, [field]: n });
    },
    [adminMode, monthEditable, values, update, initial],
  );

  const cellFor = useCallback(
    (planLineId: string, monthId: string): Cell => {
      const k = cellKey(planLineId, monthId);
      if (adminMode) return adminEdits[k] ?? initial[k] ?? { plan: 0, sale: 0 };
      return values[k] ?? { plan: 0, sale: 0 };
    },
    [adminMode, adminEdits, values, initial],
  );

  const [additionalOpen, setAdditionalOpen] = useState(false);

  // planLineId -> { dealerName, productName } for the review dialog.
  const lineMeta = useMemo(() => {
    const m = new Map<string, { dealerName: string; productName: string }>();
    for (const d of data.dealers) for (const p of d.products) m.set(p.planLineId, { dealerName: d.dealerName, productName: p.productName });
    return m;
  }, [data.dealers]);

  const enterAdminMode = useCallback(() => { setAdminEdits(initial); setAdminError(null); setAdminMode(true); }, [initial]);
  const cancelAdminMode = useCallback(() => { setAdminMode(false); setAdminEdits({}); setAdminError(null); }, []);

  const adminChanges = useCallback((): AdminChange[] => {
    const out: AdminChange[] = [];
    for (const k of Object.keys(initial)) {
      const base = initial[k];
      const cur = adminEdits[k] ?? base;
      if (base.plan === cur.plan) continue;
      const [lineId, mId] = k.split("|");
      const meta = lineMeta.get(lineId);
      const monthName = data.months.find((m) => m.id === mId)?.name ?? "";
      out.push({ dealerName: meta?.dealerName ?? "", productName: meta?.productName ?? "", fieldName: `Monthly Plan${monthName ? ` (${monthName})` : ""}`, oldValue: base.plan, newValue: cur.plan });
    }
    return out;
  }, [initial, adminEdits, lineMeta, data.months]);

  const adminSave = useCallback(async (reason: string) => {
    const entries: { planLineId: string; seasonMonthId: string; planQty?: number; mode?: string; planValue?: number }[] = [];
    for (const k of Object.keys(initial)) {
      const base = initial[k];
      const cur = adminEdits[k] ?? base;
      if (base.plan === cur.plan) continue;
      const [lineId, mId] = k.split("|");
      entries.push(qtyMode ? { planLineId: lineId, seasonMonthId: mId, planQty: cur.plan } : { planLineId: lineId, seasonMonthId: mId, mode: data.monthlyMode, planValue: cur.plan });
    }
    setAdminSaving(true);
    setAdminError(null);
    try {
      await api.post(`/api/planning/monthly-plans/${monthlyPlanId}/admin-edit`, { entries, reason });
      if (invalidateKey) qc.invalidateQueries({ queryKey: invalidateKey });
      qc.invalidateQueries({ queryKey: ["group-product-plan"] });
      setAdminMode(false);
      setAdminEdits({});
    } catch (e) {
      setAdminError((e as Error).message);
      throw e;
    } finally {
      setAdminSaving(false);
    }
  }, [initial, adminEdits, qtyMode, data.monthlyMode, monthlyPlanId, invalidateKey, qc]);

  const value = useMemo<MonthlyEditContextValue>(
    () => ({ planId, monthlyPlanId, data, monthlyMode: data.monthlyMode, qtyMode, values, saving, cellFor, monthEditable, setCell, flush, additionalOpen, setAdditionalOpen, canAdminEdit, adminMode, adminSaving, adminError, enterAdminMode, cancelAdminMode, adminChanges, adminSave }),
    [planId, monthlyPlanId, data, qtyMode, values, saving, cellFor, monthEditable, setCell, flush, additionalOpen, canAdminEdit, adminMode, adminSaving, adminError, enterAdminMode, cancelAdminMode, adminChanges, adminSave],
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
