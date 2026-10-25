/** Planning autosave ordering (Sales Seasonal / Monthly, Recovery Month / Week): one save in flight, revisions, trailing save, failures, streams. No DOM. */
import assert from "node:assert/strict";
import { AutosaveMapController } from "./autosave-map-controller";

const tick = () => new Promise((r) => setTimeout(r, 0));
type Call = { keys: string[]; values: Record<string, number>; resolve: () => void; reject: (e: unknown) => void };

function harness(initial: Record<string, number> = { a: 0, b: 0 }) {
  const calls: Call[] = [];
  let timer: (() => void) | null = null;
  const states: { saving: boolean; failed: boolean; pending: number }[] = [];
  const c = new AutosaveMapController<number>(initial, {
    persist: (keys, snapshot) => new Promise<void>((resolve, reject) => calls.push({ keys, values: Object.fromEntries(keys.map((k) => [k, snapshot[k]!])), resolve, reject })),
    onState: (s) => states.push({ saving: s.saving, failed: s.failed, pending: s.pending }),
    setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = null; },
    delay: 1200, maxRetries: 3,
  });
  return { c, calls, states, fire: () => { const t = timer; timer = null; t?.(); }, hasTimer: () => timer !== null, last: () => states.at(-1)! };
}

async function main() {
  // 1) Hydration and unchanged values never write.
  { const h = harness(); h.c.update("a", 0); assert.equal(h.hasTimer(), false); h.fire(); await tick(); assert.equal(h.calls.length, 0, "a value equal to the stored one is not sent"); }

  // 2) Rapid edits coalesce into ONE save with the latest value.
  { const h = harness(); h.c.update("a", 1); h.c.update("a", 2); h.c.update("a", 3); h.fire(); await tick();
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0]!.values, { a: 3 }); h.calls[0]!.resolve(); await tick(); assert.equal(h.last().pending, 0); }

  // 3) One save in flight; an edit of the SAME cell during it stays pending and goes out in ONE trailing save with the newer value.
  { const h = harness(); h.c.update("a", 1); h.fire(); await tick();
    h.c.update("a", 5); h.c.update("b", 7);
    assert.equal(h.hasTimer(), false, "no second save is scheduled while one is in flight");
    h.fire(); await tick(); assert.equal(h.calls.length, 1, "still only one request in flight");
    h.calls[0]!.resolve(); await tick();
    assert.equal(h.last().pending, 2, "the newer edit of a and the edit of b are still pending (the response acknowledged only a=1)");
    assert.equal(h.hasTimer(), true, "a trailing save is scheduled"); h.fire(); await tick();
    assert.deepEqual(h.calls[1]!.values, { a: 5, b: 7 }, "the trailing save carries the latest values");
    h.calls[1]!.resolve(); await tick(); assert.equal(h.last().pending, 0); }

  // 4) Delayed responses cannot reorder writes: the second request starts only after the first finished.
  { const h = harness(); h.c.update("a", 1); h.fire(); await tick(); h.c.update("a", 2);
    await new Promise((r) => setTimeout(r, 20)); assert.equal(h.calls.length, 1);
    h.calls[0]!.resolve(); await tick(); h.fire(); await tick(); assert.deepEqual(h.calls.map((x) => x.values.a), [1, 2], "older value first, newer value last"); h.calls[1]!.resolve(); await tick(); }

  // 5) A failure keeps the edits pending and visible; a transient failure retries (bounded) with the CURRENT value, never an older one.
  { const h = harness(); h.c.update("a", 1); h.fire(); await tick();
    h.calls[0]!.reject(Object.assign(new Error("Service unavailable"), { status: 503 })); await tick();
    assert.deepEqual([h.last().failed, h.last().pending], [true, 1], "failed, still pending");
    h.c.update("a", 9); // edited again after the failure
    h.fire(); await tick();
    assert.deepEqual(h.calls[1]!.values, { a: 9 }, "the retry sends the newest value (a=1 is never replayed over a=9)");
    h.calls[1]!.resolve(); await tick(); assert.deepEqual([h.last().failed, h.last().pending], [false, 0]); }

  // 6) A refused save (409 locked / 422) is not retried automatically; edits stay unsaved; a new edit or Save re-sends.
  { const h = harness(); h.c.update("a", 1); h.fire(); await tick();
    h.calls[0]!.reject(Object.assign(new Error("Plan is submitted"), { status: 409 })); await tick();
    assert.deepEqual([h.hasTimer(), h.last().failed, h.last().pending], [false, true, 1], "no automatic retry of a refused save");
    const flushing = h.c.flush(); await tick(); h.calls[1]!.reject(Object.assign(new Error("Plan is submitted"), { status: 409 }));
    await assert.rejects(flushing, /submitted/, "Save (flush) reports the failure to the caller (Submit / No Plan then do not proceed)"); }

  // 7) Bounded retries: after maxRetries transient failures the controller stops until the next edit.
  { const h = harness(); h.c.update("a", 1);
    for (let i = 0; i < 4; i++) { h.fire(); await tick(); h.calls[i]!.reject(Object.assign(new Error("x"), { status: 500 })); await tick(); }
    assert.equal(h.hasTimer(), false, "gives up after 3 retries"); assert.equal(h.last().pending, 1, "…but the edit is still pending");
    h.c.update("a", 2); assert.equal(h.hasTimer(), true, "a new edit re-arms autosave"); }

  // 8) flush() waits for an in-flight save, then sends what is still pending; resolves only when everything is saved.
  { const h = harness(); h.c.update("a", 1); h.fire(); await tick(); h.c.update("b", 2);
    let done = false; const f = h.c.flush().then(() => { done = true; });
    h.calls[0]!.resolve(); await tick(); await tick();
    assert.equal(h.calls.length, 2, "flush sent the remaining edit"); assert.equal(done, false);
    h.calls[1]!.resolve(); await f; assert.equal(done, true); }

  // 9) Streams are isolated: a reset (another plan / week) hands pending edits to the OLD stream's persist, and a late response of the old stream is ignored.
  { const h = harness(); const oldSaves: Record<string, number>[] = [];
    h.c.update("a", 1); h.fire(); await tick(); h.c.update("b", 4);
    h.c.reset({ x: 0 }, async (keys, snap) => { oldSaves.push(Object.fromEntries(keys.map((k) => [k, snap[k]!]))); });
    assert.deepEqual(oldSaves, [{ a: 1, b: 4 }], "the old plan's pending edits go to the old plan's endpoint");
    h.calls[0]!.resolve(); await tick();
    assert.deepEqual([h.last().pending, h.hasTimer()], [0, false], "the old stream's response does not touch the new stream");
    h.c.update("x", 3); h.fire(); await tick(); assert.deepEqual(h.calls.at(-1)!.values, { x: 3 }); }

  // 10) Changing a cell back to its stored value while it is NOT in flight drops it; while in flight it is re-sent (the stored value changes on ack).
  { const h = harness(); h.c.update("a", 1); h.c.update("a", 0); assert.equal(h.last().pending, 0, "back to the stored value → nothing to save");
    h.c.update("a", 1); h.fire(); await tick(); h.c.update("a", 0); h.calls[0]!.resolve(); await tick();
    assert.equal(h.last().pending, 1, "a=0 must still be saved because the server now holds a=1"); h.fire(); await tick(); assert.deepEqual(h.calls[1]!.values, { a: 0 }); }

  console.log("autosave-map-controller.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
