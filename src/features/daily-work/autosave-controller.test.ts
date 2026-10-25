/**
 * Unit tests for the Daily Work autosave engine. These prove the stability contract that fixes the
 * request-storm / DB-pool-exhaustion bug: single in-flight save, coalescing, latest-state-wins, no save on
 * hydration, and — critically — that a FAILED save never loops (bounded backoff; 409 stops and reconciles).
 */
import assert from "node:assert/strict";
import { AutosaveController, type AutosaveHost } from "./autosave-controller";
import { ApiNetworkError } from "@/lib/api-client";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake single-slot timer (the controller only ever keeps one timer) + a manually-settled save. */
function harness(opts: { conflictStatus?: number; runExclusive?: AutosaveHost["runExclusive"] } = {}) {
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
      if (autoMode === "reject") return Promise.reject(new ApiNetworkError(new Error("offline")));
      if (autoMode === "conflict") return Promise.reject(Object.assign(new Error("conflict"), { status: opts.conflictStatus ?? 409 }));
      return new Promise<void>((resolve, reject) => deferreds.push({ resolve, reject }));
    },
    runExclusive: opts.runExclusive,
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
    settle: (i: number, ok: boolean) => { if (ok) deferreds[i].resolve(); else deferreds[i].reject(new ApiNetworkError(new Error("offline"))); },
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

  // 8) Only TRANSIENT failures are retried: a rejected request (422 / 403 / 404 …) is not re-sent until the person edits; 5xx, 429 and network errors are (bounded).
  for (const [status, retries] of [[422, false], [403, false], [404, false], [500, true], [503, true], [408, true], [429, true], [undefined, false]] as const) {
    let pending: (() => void) | null = null; const calls: number[] = [];
    const c = new AutosaveController({
      save: () => { calls.push(1); return Promise.reject(Object.assign(new Error("fail"), status === undefined ? {} : { status })); },
      setTimer: (fn) => { pending = fn; return 1; }, clearTimer: () => { pending = null; }, maxRetries: 3,
    });
    c.setEnabled(true); c.hydrate("a"); c.update("b");
    { const fire = pending as (() => void) | null; pending = null; fire?.(); }
    await flush(); await flush();
    assert.equal(pending !== null, retries, `status ${status ?? "programming error"}: ${retries ? "a bounded retry is scheduled" : "no automatic retry"}`);
    assert.equal(calls.length, 1);
    c.update("c"); // a genuine edit always re-arms autosave
    assert.equal(pending !== null, true, "a new edit schedules a save again");
  }

  // 9) Saves of different sections for the same day go through one queue: they never overlap, and a failed one does not block the next.
  {
    const { serializeDaySave } = await import("./use-daily-autosave");
    const order: string[] = []; let release!: () => void;
    const first = serializeDaySave(() => new Promise<void>((resolve) => { order.push("a-start"); release = () => { order.push("a-end"); resolve(); }; }));
    const second = serializeDaySave(async () => { order.push("b-start"); });
    await flush(); assert.deepEqual(order, ["a-start"], "the second save waits for the first");
    release(); await first; await second; assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
    const failing = serializeDaySave(() => Promise.reject(new Error("boom")));
    await assert.rejects(failing);
    assert.equal(await serializeDaySave(async () => "next"), "next", "a failed save does not block the queue");
  }

  // A different section holds the queue: only the latest queued snapshot is sent and marked saved.
  {
    const { serializeDaySave } = await import("./use-daily-autosave");
    for (const scenario of ["edit", "revert", "lock"] as const) {
      let release!: () => void;
      const blocker = serializeDaySave(() => new Promise<void>((resolve) => { release = resolve; }));
      await flush();
      const h = harness({ runExclusive: serializeDaySave }); h.setMode("resolve");
      h.controller.setEnabled(true); h.controller.hydrate("base");
      h.setLatest("queued"); h.controller.update("queued"); h.tick(); await flush();
      assert.equal(h.saved.length, 0, "no request before its queue slot");
      if (scenario === "lock") h.controller.setEnabled(false);
      else { h.setLatest(scenario === "edit" ? "latest" : "base"); h.controller.update(scenario === "edit" ? "latest" : "base"); }
      release(); await blocker; await flush();
      assert.deepEqual(h.saved, scenario === "edit" ? ["latest"] : [], "queued work coalesces edits, skips reversions and respects a newly locked view");
      assert.equal(h.hasTimer(), false, "no redundant trailing save for an already-persisted queued snapshot");
      assert.equal(h.state.saving, false);
      await h.controller.flush();
      assert.equal(h.saved.length, scenario === "edit" ? 1 : 0, "Save Draft does not resend the captured snapshot");
      h.controller.dispose();
    }
  }
  // A local serialization/logic error is not mistaken for a network outage.
  for (const error of [new SyntaxError("bad JSON"), new TypeError("bad payload"), new Error("logic bug"), Object.assign(new Error("cancelled"), { name: "AbortError" })]) {
    let pending: (() => void) | null = null;
    const c = new AutosaveController({ save: async () => { throw error; }, setTimer: (fn) => { pending = fn; return 1; }, clearTimer: () => { pending = null; } });
    c.setEnabled(true); c.hydrate("a"); c.update("b"); await c.flush();
    assert.equal(pending, null, `${error.name} does not schedule a retry`);
    c.dispose();
  }

  console.log("autosave-controller.test.ts — all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
