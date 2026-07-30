"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared autosave core for the planning edit contexts.
 *
 * Both PlanEditProvider (seasonal) and MonthlyEditProvider (monthly) edit a keyed map of
 * cells with the same mechanics — optimistic local state, a dirty set, a debounced flush,
 * and a "saving" flag. That boilerplate lived in both providers; it now lives here once.
 * The providers keep their own cell shapes, keys, payloads and endpoints (they are genuinely
 * different DTOs) and only supply a `persist` function — so the core is unified without
 * forcing a single monolithic context.
 */
export interface AutosaveMap<T> {
  values: Record<string, T>;
  saving: boolean;
  /** Replace one entry's value and schedule a debounced save. */
  update: (key: string, next: T) => void;
  /** Persist any pending (dirty) changes immediately. */
  flush: () => Promise<void>;
}

export function useAutosaveMap<T>(
  initial: Record<string, T>,
  persist: (dirtyKeys: string[], snapshot: Record<string, T>) => Promise<void>,
  delay = 1200,
): AutosaveMap<T> {
  const [values, setValues] = useState<Record<string, T>>(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<Record<string, T>>(initial);
  const dirty = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest persist without re-creating callbacks on every render.
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    setValues(initial);
    ref.current = initial;
  }, [initial]);

  const flush = useCallback(async () => {
    if (dirty.current.size === 0) return;
    const keys = Array.from(dirty.current);
    dirty.current.clear();
    setSaving(true);
    try {
      await persistRef.current(keys, ref.current);
    } finally {
      setSaving(false);
    }
  }, []);

  const update = useCallback(
    (k: string, next: T) => {
      setValues((prev) => {
        const n = { ...prev, [k]: next };
        ref.current = n;
        return n;
      });
      dirty.current.add(k);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush();
      }, delay);
    },
    [flush, delay],
  );

  return { values, saving, update, flush };
}
