/**
 * Daily Report autosave. Report sections reuse the Daily Plan autosave engine (useDailyAutosave → AutosaveController)
 * and persist today's actuals through the existing /api/daily-work/actual endpoint, which only updates actuals — it
 * never finalizes. This proves (a) the wiring in each active section, (b) the engine behaviour with a Report-shaped
 * payload (debounce, coalescing, failure, flush, ordering) and (c) that autosave can never submit/finalize/review.
 * Server-side "actuals never finalize" is asserted in daily-work-completion.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AutosaveController } from "./autosave-controller";

const read = (p: string) => readFileSync(p, "utf8");
const page = read("src/features/daily-work/daily-work-page.tsx");
const hook = read("src/features/daily-work/use-daily-autosave.ts");
const flush = () => new Promise((r) => setTimeout(r, 0));

/* ---------------------------------- wiring ---------------------------------- */
const sectionSource = (startMarker: string, endMarker: string) => page.slice(page.indexOf(startMarker), page.indexOf(endMarker, page.indexOf(startMarker) + 10));
const sales = sectionSource("function DailyWorkSection(", "function AppointmentSection(").replace(/function AppointmentSection[\s\S]*/, "");
const appt = sectionSource("function AppointmentSection(", "SECTION 4 — Scheme Conversion");
const visits = sectionSource("function SummarySection(", "CN follow-up tasks");

// One engine for Plan and Report: every active section uses useDailyAutosave; no second implementation was added.
assert.equal((page.match(/useDailyAutosave\(/g) ?? []).length, 4, "Sales/Recovery, Appointment, Scheme Conversion (dormant) and Visits/Others — no extra implementation");
assert.ok(!/new AutosaveController|setTimeout\(/.test(page), "the page has no timer/engine of its own");
assert.ok(hook.includes("new AutosaveController"), "the engine still lives only in the shared hook");

for (const [name, src, section] of [["Sales/Recovery", sales, "section"], ["Appointment", appt, 'section: "APPOINTMENT"'], ["Visits", visits, 'section: "VISITS"']] as const) {
  assert.ok(src.includes("isReport"), `${name}: Report mode is handled`);
  assert.ok(src.includes(`api.post("/api/daily-work/actual", { ${section}`), `${name}: Report autosave posts actuals to the existing /actual endpoint`);
  assert.ok(/draftKey = isReport \? `R\|/.test(src), `${name}: Report has its own dirty-key (payload of the editable actuals)`);
  assert.ok(src.includes("useRegisterSaveDraft(autosaveEnabled"), `${name}: Report publishes the same Save Draft handle/state`);
  assert.ok(!/saveActuals\b.*Button|statusMut|actualMut\.mutate|achMut/.test(src.replace(/saveActuals: useLabel[^\n]*/g, "")), `${name}: the manual Save Actuals mutation/button is gone`);
}
// Report is gated by the section's own "can enter actuals" flag and by the finalized lock.
assert.ok(sales.includes("isReport ? canEnterActual && !locked"));
assert.ok(appt.includes("isReport ? canEnterStatus && !locked"));
assert.ok(visits.includes("reportEditable && !locked"));
// Others is read-only in the report, so it is deliberately not autosaved there.
assert.ok(visits.includes('disabled={busy || locked || view === DailyWorkView.REPORT}'), "Others stays read-only in Report");
assert.ok(visits.includes('isReport && focus === "VISITS"'), "only Visits actuals autosave in Report");
// Plan behaviour is unchanged: same endpoint and payloads, enabled only in PLAN view.
assert.ok(sales.includes('api.post("/api/daily-work/save", { section, workDate, rows: payloadRows() })'));
assert.ok(appt.includes('api.post("/api/daily-work/save", { section: "APPOINTMENT", workDate, rows: payloadRows() })'));
assert.ok(visits.includes('api.post("/api/daily-work/save", body())'));
assert.ok(sales.includes(": view === DailyWorkView.PLAN && !locked") && appt.includes(": view === DailyWorkView.PLAN && !locked") && visits.includes(": view === DailyWorkView.PLAN && !locked"));
// Never submits / finalizes / reviews from autosave.
for (const [name, src] of [["Sales/Recovery", sales], ["Appointment", appt], ["Visits", visits]] as const) {
  assert.ok(!/submit-report|submit-day|daily-work\/review|submitDailyReport/.test(src), `${name}: no submit/finalize/review call anywhere in the section`);
}
const toolbar = sectionSource("function DailyReportProgress(", "Day-level Submit → Self Rating modal");
assert.equal((toolbar.match(/submit-report/g) ?? []).length, 1, "Submit Daily Report is still the single explicit finalization call");
assert.ok(toolbar.includes("api.post(\"/api/daily-work/submit-report\", { workDate, selfRating })") && toolbar.includes("onConfirm={(rating) => submitMut.mutate(rating)}"), "submission still goes through the self-rating modal");
assert.ok(toolbar.includes("void draft?.flush()") && !/submitMut\.mutate\(\)/.test(toolbar), "Save Draft in Report only flushes autosave");
assert.ok(toolbar.includes("daily_work.state.save_failed") && toolbar.includes("daily_work.state.saved"), "save status uses the existing labels");
// Switching sections / views remounts (key includes view) and the hook flushes on unmount.
assert.ok(page.includes("key={`${section}-${workDate}-${view}`}") && page.includes("key={`appt-${workDate}-${view}`}") && page.includes("key={`summary-${workDate}-${view}`}"));
assert.ok(hook.includes("void controller.flush().finally(() => controller.dispose())"), "pending edits are flushed on unmount (section switch, Plan↔Report, navigation)");
// The server endpoint used only stores actuals.
const actualRoute = read("src/app/api/daily-work/actual/route.ts");
assert.ok(!/submitDailyReport|createDailyWorkReview|submitDailyWorkDay/.test(actualRoute), "the actuals route cannot finalize or review");
// Scheme Conversion stays disabled and is not part of Report autosave.
assert.ok(read("src/lib/daily-work.ts").includes("SCHEME_CONVERSION_ENABLED = false;"));
assert.ok(!/SCHEME_CONVERSION|Conversion/.test(sales + appt + visits));

/* ---------------------------------- engine behaviour with a Report-shaped payload ---------------------------------- */
function harness() {
  let timer: (() => void) | null = null;
  let latest = "";
  const posts: string[] = [];
  const state = { saving: false, savedAt: null as number | null, failed: false };
  const waiting: Array<{ ok: () => void; fail: () => void }> = [];
  let mode: "resolve" | "reject" | "manual" = "resolve";
  const controller = new AutosaveController({
    save: () => {
      posts.push(latest);
      if (mode === "resolve") return Promise.resolve();
      if (mode === "reject") return Promise.reject(new Error("network"));
      return new Promise<void>((ok, fail) => waiting.push({ ok, fail: () => fail(new Error("network")) }));
    },
    onState: (s) => Object.assign(state, s),
    setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = null; },
    now: () => 1, delay: 1000, maxRetries: 3,
  });
  controller.setEnabled(true);
  const edit = (entries: unknown) => { latest = `R|${JSON.stringify(entries)}`; controller.update(latest); };
  return { controller, edit, posts, state, waiting, setMode: (m: typeof mode) => { mode = m; }, fire: () => { const t = timer; timer = null; t?.(); }, armed: () => timer !== null, hydrate: (entries: unknown) => { latest = `R|${JSON.stringify(entries)}`; controller.hydrate(latest); controller.update(latest); } };
}
const e = (v: string) => [{ entryId: "e1", todaysActual: Number(v) }];

async function main() {
  // 1, 2, 3 — typing "10000" is one debounced save carrying the final value, never five.
  {
    const h = harness(); h.hydrate([]);
    for (const v of ["1", "10", "100", "1000", "10000"]) h.edit(e(v));
    assert.equal(h.posts.length, 0, "nothing is sent while the debounce timer is pending");
    assert.equal(h.armed(), true);
    h.fire(); await flush();
    assert.deepEqual(h.posts, [`R|${JSON.stringify(e("10000"))}`], "one request with the final value");
    assert.equal(h.state.failed, false); assert.ok(h.state.savedAt);
  }
  // loading the saved report is not an edit
  { const h = harness(); h.hydrate(e("500")); h.fire(); await flush(); assert.equal(h.posts.length, 0, "hydration never saves"); assert.equal(h.armed(), false); }
  // a no-op change back to the persisted value does not save
  { const h = harness(); h.hydrate(e("500")); h.edit(e("501")); h.edit(e("500")); h.fire(); await flush(); assert.equal(h.posts.length, 0); }
  // 13 — failure: never shows "saved", keeps the edit, retries (bounded) and succeeds later.
  {
    const h = harness(); h.hydrate([]); h.setMode("reject");
    h.edit(e("7")); h.fire(); await flush();
    assert.equal(h.state.failed, true, "failure is visible"); assert.equal(h.state.savedAt, null, "no Saved after a failed save");
    assert.equal(h.armed(), true, "a retry is scheduled (existing backoff)");
    h.setMode("resolve"); h.fire(); await flush();
    assert.equal(h.state.failed, false); assert.ok(h.state.savedAt); assert.equal(h.posts.at(-1), `R|${JSON.stringify(e("7"))}`, "the user's value was kept and re-sent");
  }
  // out-of-order / rapid edits while a save is in flight: one in-flight, one trailing save with the NEWEST value.
  {
    const h = harness(); h.hydrate([]); h.setMode("manual");
    h.edit(e("1")); h.fire(); await flush();
    assert.equal(h.posts.length, 1);
    h.edit(e("2")); h.edit(e("3")); h.fire(); await flush();
    assert.equal(h.posts.length, 1, "no second concurrent save while one is running");
    h.waiting[0].ok(); await flush();
    h.fire(); await flush();
    assert.equal(h.posts.length, 2, "exactly one trailing save after the in-flight one");
    assert.ok(h.posts[0].includes('"todaysActual":1') && !h.posts[1].includes('"todaysActual":2'), "the intermediate value 2 is never sent");
    assert.ok(h.posts[1].includes('"todaysActual":3'));
  }
  // 10, 11, 12 — leaving the section / view / page: flush saves the pending edit immediately (what unmount does).
  {
    const h = harness(); h.hydrate([]); h.edit(e("42"));
    assert.equal(h.posts.length, 0);
    await h.controller.flush();
    assert.deepEqual(h.posts, [`R|${JSON.stringify(e("42"))}`], "pending debounced edit is saved on flush, not lost");
    assert.equal(h.armed(), false);
  }
  // disabled (finalized / no actuals allowed) → nothing is ever saved
  { const h = harness(); h.hydrate([]); h.controller.setEnabled(false); h.edit(e("9")); h.fire(); await h.controller.flush(); assert.equal(h.posts.length, 0); }

  console.log("report-autosave.test.ts — all assertions passed");
}
main().catch((err) => { console.error(err); process.exit(1); });
