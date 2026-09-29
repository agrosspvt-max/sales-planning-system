"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AutosaveController, type AutosaveState } from "./autosave-controller";

/**
 * React binding around the framework-agnostic {@link AutosaveController}. All concurrency/coalescing/backoff
 * rules live in the controller (and are unit-tested there); this hook only feeds it the latest `key`, `enabled`
 * flag and `save`/`onConflict` closures, and mirrors its state for the "Saving…/Saved/Save failed" indicator.
 *
 *  - `key`: a serialization of the section's current save payload (recomputed each render).
 *  - `hydrate(serverKey)`: called once server data has seeded local state, so loading never triggers a save.
 *  - `opts.onConflict`: invoked when a save returns 409 (stale/frozen batch) — the section reloads the current
 *    batch instead of the controller retrying the stale write.
 */
export interface DailyAutosave {
  saving: boolean;
  savedAt: number | null;
  failed: boolean;
  hydrate: (serverKey: string) => void;
  flush: () => Promise<void>;
}

export function useDailyAutosave(
  key: string,
  enabled: boolean,
  save: () => Promise<unknown>,
  opts?: { onConflict?: () => void; delay?: number },
): DailyAutosave {
  const [state, setState] = useState<AutosaveState>({ saving: false, savedAt: null, failed: false });
  const saveRef = useRef(save);
  saveRef.current = save;
  const onConflictRef = useRef(opts?.onConflict);
  onConflictRef.current = opts?.onConflict;
  const lifecycleGenerationRef = useRef(0);

  const controllerRef = useRef<AutosaveController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new AutosaveController({
      save: async () => { await saveRef.current(); }, // rethrows ApiRequestError (carries .status for 409 detection)
      onState: setState,
      onConflict: () => onConflictRef.current?.(),
      delay: opts?.delay,
    });
  }
  const controller = controllerRef.current;
  const isCurrentLifecycle = useCallback((generation: number) => lifecycleGenerationRef.current === generation, []);

  useEffect(() => { controller.setEnabled(enabled); }, [controller, enabled]);
  useEffect(() => { controller.update(key); }, [controller, key]);
  // Flush any pending edit on a real unmount (section/tab switch or navigation), then stop all timers.
  // React development Strict Mode performs a setup → cleanup → setup probe without unmounting the component.
  // Defer cleanup by one microtask so the second setup can supersede that probe; otherwise the live component
  // retains a permanently disposed controller and both autosave and the existing Save Draft flush become no-ops.
  useEffect(() => {
    const generation = ++lifecycleGenerationRef.current;
    return () => {
      queueMicrotask(() => {
        if (!isCurrentLifecycle(generation)) return;
        void controller.flush().finally(() => controller.dispose());
      });
    };
  }, [controller, isCurrentLifecycle]);

  const hydrate = useCallback((serverKey: string) => controller.hydrate(serverKey), [controller]);
  const flush = useCallback(() => controller.flush(), [controller]);

  return { saving: state.saving, savedAt: state.savedAt, failed: state.failed, hydrate, flush };
}
