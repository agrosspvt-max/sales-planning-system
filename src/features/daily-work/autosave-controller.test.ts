/**
 * Unit tests for the Daily Work autosave engine. These prove the stability contract that fixes the
 * request-storm / DB-pool-exhaustion bug: single in-flight save, coalescing, latest-state-wins, no save on
 * hydration, and — critically — that a FAILED save never loops (bounded backoff; 409 stops and reconciles).
 */
import assert from "node:assert/strict";
import { AutosaveController } from "./autosave-controller";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake single-slot timer (the controller only ever keeps one timer) + a manually-settled save. */
function harness(opts: { conflictStatus?: number } = {}) {
  let pending: (() => void) | null = null;
  let latest = ""; // the "current payload" the host would serialize at save time
  const saved: string[] = []; // snapshot captured on each save call
  const deferreds: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  let autoMode: "manual" | "resolve" | "reject" | "conflict" = "manual";
  const state = { saving: false, savedAt: null as number | null, failed: false };
  let conflicts = 0;
  let clock = 1000;

  const controller = new AutosaveController({
    save: () => {
      saved.push(latest);
      if (autoMode === "resolve") return Promise.resolve();
      if (autoMode === "reject") return Promise.reject(new Error("transient"));
      if (autoMode === "conflict") return Promise.reject(Object.assign(new Error("conflict"), { status: opts.conflictStatus ?? 409 }));
      return new Promise<void>((resolve, reject) => deferreds.push({ resolve, reject }));
    },
    onState: (s) => { state.saving = s.saving; state.savedAt = s.savedAt; state.failed = s.failed; },
    onConflict: () => { conflicts += 1; },
    now: () => ++clock,
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
    maxRetries: 3,
  });

  return {
    controller,
    setLatest: (k: string) => { latest = k; },
    tick: () => { const p = pending; pending = null; if (p) p(); },
    hasTimer: () => pending !== null,
    saved,
    state,
    conflicts: () => conflicts,
    settle: (i: number, ok: boolean) => { if (ok) deferreds[i].resolve(); else deferreds[i].reject(new Error("transient")); },
    setMode: (m: typeof autoMode) => { autoMode = m; },
  };
}

async function main() {
  // 1) Hydration is not an edit — seeding never saves.
  {
    const h = harness(); h.setMode("resolve");
    h.controller.setEnabled(true);
    h.setLatest("k0"); h.controller.hydrate("k0"); h.controller.update("k0");
    assert.equal(h.hasTimer(), false, "no timer scheduled for the seeded snapshot");
    h.tick(); await flush();
    assert.equal(h.saved.length, 0, "no save on hydrate");
  }

  // 2) Disabled → never saves.
  {
    const h = harness(); h.setMode("resolve");
    h.controller.setEnabled(false);
    h.controller.hydrate("k0"); h.setLatest("k1"); h.controller.update("k1");
    assert.equal(h.hasTimer(), false);
    h.tick(); await flush();
    assert.equal(h.saved.length, 0, "disabled autosave does not run");
  }

  // 3) Rapid edits coalesce into ONE save carrying the latest snapshot.
  {
    const h = harness(); h.setMode("resolve");
    h.controller.setEnabled(true); h.controller.hydrate("k0");
    h.setLatest("k1"); h.controller.update("k1");
    h.setLatest("k10"); h.controller.update("k10");
    h.setLatest("k100"); h.controller.update("k100");
    h.tick(); await flush();
    assert.deepEqual(h.saved, ["k100"], "one save with the latest value only");
  }

  // 4) Single in-flight + latest-wins: change during save A does NOT start a concurrent save;
  //    a trailing save runs after A with the newest state (the required scenario).
  {
    const h = harness(); h.setMode("manual");
    h.controller.setEnabled(true); h.controller.hydrate("k0");
    h.setLatest("10000"); h.controller.update("10000");
    h.tick(); await flush();                     // save A starts (pending)
    assert.equal(h.saved.length, 1, "save A in flight");
    assert.equal(h.state.saving, true);
    // user changes value while A is pending
    h.setLatest("20000"); h.controller.update("20000");
    await flush();
    assert.equal(h.saved.length, 1, "no concurrent save B while A is pending");
    h.settle(0, true); await flush();            // A resolves
    assert.equal(h.hasTimer(), true, "trailing save scheduled after A");
    h.tick(); await flush();                     // trailing save B
    assert.equal(h.saved.length, 2, "exactly one trailing save");
    assert.equal(h.saved[1], "20000", "latest state wins");
    h.settle(1, true); await flush();
    assert.equal(h.hasTimer(), false, "no further saves once settled");
    assert.equal(h.state.saving, false);
  }

  // 5) A failed (transient) save does NOT loop — bounded backoff, then stop. (The root-cause fix.)
  {
    const h = harness(); h.setMode("reject");
    h.controller.setEnabled(true); h.controller.hydrate("k0");
    h.setLatest("k1"); h.controller.update("k1");
    // initial attempt + up to maxRetries(3) backoff attempts = 4 total, then it STOPS.
    for (let i = 0; i < 10; i++) { h.tick(); await flush(); }
    assert.equal(h.saved.length, 4, "1 initial + 3 bounded retries, then no more (no infinite loop)");
    assert.equal(h.state.failed, true, "surfaced as failed");
    assert.equal(h.hasTimer(), false, "no pending retry after giving up");
  }

  // 6) After giving up, a NEW user edit re-arms autosave and it eventually persists.
  {
    const h = harness(); h.setMode("reject");
    h.controller.setEnabled(true); h.controller.hydrate("k0");
    h.setLatest("k1"); h.controller.update("k1");
    for (let i = 0; i < 10; i++) { h.tick(); await flush(); }
    assert.equal(h.saved.length, 4);
    h.setMode("resolve");
    h.setLatest("k2"); h.controller.update("k2"); // fresh edit re-arms
    h.tick(); await flush();
    assert.equal(h.saved.length, 5, "re-armed and saved");
    assert.equal(h.saved[4], "k2");
    assert.equal(h.state.failed, false);
  }

  // 7) 409 conflict STOPS immediately and calls onConflict — the stale payload is never re-sent.
  {
    const h = harness(); h.setMode("conflict");
    h.controller.setEnabled(true); h.controller.hydrate("k0");
    h.setLatest("k1"); h.controller.update("k1");
    h.tick(); await flush();
    assert.equal(h.saved.length, 1, "one attempt only");
    assert.equal(h.conflicts(), 1, "onConflict invoked for reconciliation");
    assert.equal(h.hasTimer(), false, "no retry of the stale write");
    for (let i = 0; i < 5; i++) { h.tick(); await flush(); }
    assert.equal(h.saved.length, 1, "still no stale retries after 409");
  }

  // 8) Manual Save Draft flushes the existing dirty snapshot immediately (without waiting for debounce).
  {
    const h = harness(); h.setMode("resolve");
    h.controller.setEnabled(true); h.controller.hydrate("k0");
    h.setLatest("k1"); h.controller.update("k1");
    assert.equal(h.hasTimer(), true, "the edit is waiting for autosave");
    await h.controller.flush();
    assert.deepEqual(h.saved, ["k1"], "manual flush uses the existing save flow");
    assert.equal(h.hasTimer(), false, "manual flush consumes the pending debounce");
  }

  // 9) Section/view switching while a save is in flight drains the newer edit before cleanup completes.
  {
    const h = harness(); h.setMode("manual");
    h.controller.setEnabled(true); h.controller.hydrate("k0");
    h.setLatest("k1"); h.controller.update("k1");
    h.tick(); await flush();
    assert.deepEqual(h.saved, ["k1"], "first save is in flight");

    h.setLatest("k2"); h.controller.update("k2");
    const draining = h.controller.flush();
    h.settle(0, true); await flush();
    assert.deepEqual(h.saved, ["k1", "k2"], "flush starts one immediate trailing save with the latest edit");
    h.settle(1, true);
    await draining;
    assert.equal(h.hasTimer(), false, "the section is clean before unmount disposal");
  }

  console.log("autosave-controller.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
