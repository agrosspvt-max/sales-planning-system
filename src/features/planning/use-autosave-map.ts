"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AutosaveMapController } from "./autosave-map-controller";

/**
 * Shared autosave core for the planning edit contexts.
 *
 * PlanEditProvider (Sales seasonal), MonthlyEditProvider (Sales monthly) and the Recovery Month / Week grids edit a keyed map of cells with the same mechanics —
 * optimistic local state, a dirty set, a debounced flush and a "saving" flag. The providers keep their own cell shapes, keys, payloads and endpoints and only
 * supply a `persist` function. The ordering rules (one save in flight, revisions, trailing save, failure handling) live in AutosaveMapController.
 */
export interface AutosaveMap<T> {
  values: Record<string, T>;
  saving: boolean;
  /** The last save failed: its edits are still on screen and still pending (not saved). */
  failed: boolean;
  error: string | null;
  /** Cells with edits the server has not confirmed yet. */
  pending: number;
  /** Replace one entry's value and schedule a debounced save. */
  update: (key: string, next: T) => void;
  /** Persist any pending (dirty) changes immediately; rejects if the save fails (the edits stay pending). */
  flush: () => Promise<void>;
}

export function useAutosaveMap<T>(
  initial: Record<string, T>,
  persist: (dirtyKeys: string[], snapshot: Record<string, T>) => Promise<void>,
  delay = 1200,
): AutosaveMap<T> {
  // Keep the latest persist without re-creating the controller on every render.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const [state, setState] = useState(() => ({ values: initial, saving: false, failed: false, error: null as string | null, pending: 0 }));
  const controllerRef = useRef<AutosaveMapController<T> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new AutosaveMapController<T>(initial, { persist: (keys, snapshot) => persistRef.current(keys, snapshot), onState: setState, delay });
  }
  const controller = controllerRef.current;
  // A new baseline (another plan / version — the callers seed `initial` once per plan identity) starts a new save stream; skip the first render.
  // `committedPersist` is the persist of the last COMMITTED render (updated after the reset effect below), i.e. the old stream's endpoint when `initial` changes.
  const committedPersist = useRef(persist);
  const seeded = useRef(initial);
  useEffect(() => {
    if (seeded.current === initial) return;
    seeded.current = initial;
    controller.reset(initial, committedPersist.current);
  }, [initial, controller]);
  useEffect(() => { committedPersist.current = persist; });
  // Leaving the editor saves what is pending (as the debounce timer did before), then stops all timers. React development Strict Mode runs a
  // setup → cleanup → setup probe without unmounting: the cleanup is deferred by a microtask so the second setup supersedes it (same as useDailyAutosave).
  const lifecycle = useRef(0);
  useEffect(() => {
    const counter = lifecycle;
    const generation = ++counter.current;
    return () => {
      queueMicrotask(() => {
        if (counter.current !== generation) return;
        void controller.flush().catch(() => undefined).finally(() => controller.dispose());
      });
    };
  }, [controller]);

  const update = useCallback((k: string, next: T) => controller.update(k, next), [controller]);
  const flush = useCallback(() => controller.flush(), [controller]);
  return { values: state.values, saving: state.saving, failed: state.failed, error: state.error, pending: state.pending, update, flush };
}
