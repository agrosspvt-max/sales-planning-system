/**
 * Performance changes — pure rules: polling backoff / recovery / auth stop, transient-only retry, dealer alias / tag change detection, and the cache
 * patches applied from save responses (Sales Seasonal lines, Recovery Month / Week, Daily Report completion). No DOM, no database.
 */
import assert from "node:assert/strict";
import { pollDelay, pollingInterval, retryTransientOnce, isTransientError, POLL_BACKOFF_MAX_MS } from "./polling";
import { applySavedMonth, applySavedWeek, recoveryDealerCompleted } from "./recovery-plan-cache";
import React from "react";
import type { PlanDetail } from "@/features/planning/types";

// The client modules below are .tsx files with module-level JSX (classic runtime under tsx): give them React, then load them.
(globalThis as { React?: typeof React }).React = React;

type Q = Parameters<ReturnType<typeof pollingInterval>>[0];
// React Query hands the interval function the SAME Query object on every call; the fake keeps one object and updates its state.
const stable = { state: {} } as { state: Record<string, unknown> };
const query = (status: "success" | "error" | "pending", errorUpdateCount: number, error: unknown = null) => { stable.state = { status, error, errorUpdateCount }; return stable as unknown as Q; };
const httpError = (status?: number) => Object.assign(new Error("x"), status === undefined ? {} : { status });

async function main() {
  const { changedDealerIds, queryMentionsDealer } = await import("@/features/dealers/dealer-name-ui");
  const { applySavedLines } = await import("@/features/planning/plan-edit-context");
  const { applyReportCompletion } = await import("@/features/daily-work/daily-work-page");
  // ── Retry: only temporary failures, at most once ──
  assert.equal(isTransientError(httpError()), true, "network error (no status) is temporary");
  for (const s of [500, 503, 408, 429]) assert.equal(isTransientError(httpError(s)), true, `${s} is temporary`);
  for (const s of [400, 401, 403, 404, 409, 422]) assert.equal(isTransientError(httpError(s)), false, `${s} is not retried`);
  assert.equal(retryTransientOnce(0, httpError(503)), true);
  assert.equal(retryTransientOnce(1, httpError(503)), false, "only one extra attempt");
  assert.equal(retryTransientOnce(0, httpError(409)), false);

  // ── Backoff: exponential, capped, jittered ±20 % ──
  const mid = () => 0.5; // jitter factor 1.0
  assert.equal(pollDelay(15_000, 0, mid), 15_000, "healthy → base interval");
  assert.deepEqual([1, 2, 3].map((n) => pollDelay(15_000, n, mid)), [30_000, 60_000, 120_000]);
  assert.equal(pollDelay(15_000, 50, mid), POLL_BACKOFF_MAX_MS, "capped at 5 minutes — it keeps probing, never stops");
  assert.equal(pollDelay(15_000, 1, () => 0), 24_000, "-20 % jitter");
  assert.equal(pollDelay(15_000, 1, () => 1), 36_000, "+20 % jitter");

  // ── pollingInterval: healthy → base; failing → backoff counted from the last success; recovery → base again; auth → stop; inactive → stop ──
  {
    const interval = pollingInterval(15_000);
    const realRandom = Math.random; Math.random = mid;
    try {
      assert.equal(interval(query("success", 0)), 15_000);
      assert.equal(interval(query("error", 1, httpError(503))), 30_000, "first failure doubles");
      assert.equal(interval(query("error", 1, httpError(503))), 30_000, "asking twice for the same failure does not double again");
      assert.equal(interval(query("error", 2, httpError())), 60_000, "second consecutive failure");
      assert.equal(interval(query("success", 2)), 15_000, "recovered by itself → normal interval");
      assert.equal(interval(query("error", 3, httpError(500))), 30_000, "counted from the last success, not from the first ever failure");
      assert.equal(interval(query("error", 1, httpError(401))), false, "signed out → stop");
      assert.equal(interval(query("error", 1, httpError(403))), false, "no permission → stop");
      // A query whose FIRST load failed keeps probing (it never had a success).
      const fresh = pollingInterval(30_000);
      assert.equal(fresh(query("error", 1, httpError())), 60_000);
      assert.equal(fresh(query("error", 4, httpError())), 480_000 > POLL_BACKOFF_MAX_MS ? POLL_BACKOFF_MAX_MS : 480_000);
      let open = true;
      const gated = pollingInterval(15_000, () => open);
      assert.equal(gated(query("success", 0)), 15_000);
      open = false;
      assert.equal(gated(query("success", 0)), false, "nothing under process / panel hidden → no polling");
    } finally { Math.random = realRandom; }
  }

  // ── Dealer alias / tag changes ──
  {
    const before = { overrides: { d1: "Alias One", d2: "Alias Two" }, tags: { d1: [{ id: "t", name: "VIP" }] } } as never;
    assert.deepEqual([...changedDealerIds(before, before)], [], "same feed → nothing refreshed");
    const after = { overrides: { d1: "Alias One", d2: "Alias 2", d3: "New" }, tags: {} } as never;
    assert.deepEqual([...changedDealerIds(before, after)].sort(), ["d1", "d2", "d3"], "edit (d2), add (d3), tag removed (d1)");
    const removed = { overrides: { d1: "Alias One" }, tags: { d1: [{ id: "t", name: "VIP" }] } } as never;
    assert.deepEqual([...changedDealerIds(before, removed)], ["d2"], "alias deleted");
    assert.equal(queryMentionsDealer({ dealers: [{ dealerId: "d2" }] }, new Set(["d2"])), true);
    assert.equal(queryMentionsDealer({ dealers: [{ dealerId: "d22" }] }, new Set(["d2"])), false, "matches the whole id, not a prefix");
    assert.equal(queryMentionsDealer(undefined, new Set(["d2"])), true, "a query without data yet is refreshed");
  }

  // ── Sales Seasonal: cache after save === what the plan read returns for the stored lines ──
  {
    const detail = {
      id: "p1", lastSavedAt: "2026-01-01T00:00:00.000Z",
      dealers: [
        { dealerId: "d1", lines: [{ productId: "x", inputMode: "TOTAL_QUANTITY", inputValue: 1, packs: {} }, { productId: "y", inputMode: null, inputValue: null, packs: { s1: 2, s2: 3 } }] },
        { dealerId: "d2", lines: [{ productId: "x", inputMode: "TOTAL_QUANTITY", inputValue: 5, packs: {} }] },
      ],
    } as unknown as PlanDetail;
    const next = applySavedLines(detail, [
      { dealerId: "d1", productId: "x", inputMode: "TOTAL_QUANTITY", inputValue: 12.3457, packs: {} }, // value AS STORED (Decimal 14,4), not as typed
      { dealerId: "d1", productId: "y", inputMode: null, inputValue: null, packs: { s2: 0 } },
    ], "2026-01-02T00:00:00.000Z");
    assert.equal(next.lastSavedAt, "2026-01-02T00:00:00.000Z");
    assert.deepEqual(next.dealers[0]!.lines, [
      { productId: "x", inputMode: "TOTAL_QUANTITY", inputValue: 12.3457, packs: {} },
      { productId: "y", inputMode: null, inputValue: null, packs: { s1: 2, s2: 0 } }, // untouched pack sizes kept
    ]);
    assert.equal(next.dealers[1], detail.dealers[1], "untouched dealer keeps its identity (no re-render)");
    assert.equal(detail.dealers[0]!.lines[0]!.inputValue, 1, "the previous cache object is not mutated");
  }

  // ── Recovery Month / Week: same Completed rule as the plan read ──
  {
    assert.deepEqual([recoveryDealerCompleted(0, 0), recoveryDealerCompleted(1, 0), recoveryDealerCompleted(0, 0.5)], [false, true, true]);
    type Row = { dealerId: string; monthRecoveryPlan: number; monthRunningRecovery: number; completed: boolean; weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }>; name: string };
    const detail: { dealers: Row[] } = { dealers: [
      { dealerId: "d1", monthRecoveryPlan: 0, monthRunningRecovery: 0, completed: false, weeks: { 1: { weekRecoveryPlan: 1, weekRunningRecovery: 0 } }, name: "A" },
      { dealerId: "d2", monthRecoveryPlan: 5, monthRunningRecovery: 0, completed: true, weeks: {}, name: "B" },
    ] };
    const m = applySavedMonth(detail, [{ dealerId: "d1", monthRecoveryPlan: 100, monthRunningRecovery: 0 }, { dealerId: "d2", monthRecoveryPlan: 0, monthRunningRecovery: 0 }]);
    assert.deepEqual(m.dealers.map((d) => [d.monthRecoveryPlan, d.completed, d.name]), [[100, true, "A"], [0, false, "B"]], "cleared month → not Completed");
    const w = applySavedWeek(m, 2, [{ dealerId: "d1", weekRecoveryPlan: 40, weekRunningRecovery: 10 }]);
    assert.deepEqual(w.dealers[0]!.weeks, { 1: { weekRecoveryPlan: 1, weekRunningRecovery: 0 }, 2: { weekRecoveryPlan: 40, weekRunningRecovery: 10 } }, "other weeks kept");
    assert.equal(w.dealers[1], m.dealers[1]);
  }

  // ── Daily Report: ticks / Submit Report from the save response, following the server's rule ──
  {
    const prev = { isFinalized: false, reportDeadlinePassed: false, reportSections: [], hasSubmittedWork: false, canSubmitReport: false, planStatus: "SUBMITTED" } as never;
    const report = { hasBatches: true, complete: true, sections: [{ section: "SALES", reported: true }] } as never;
    const next = applyReportCompletion(prev, report) as unknown as Record<string, unknown>;
    assert.deepEqual([next.canSubmitReport, next.hasSubmittedWork, next.planStatus], [true, true, "SUBMITTED"], "other status fields preserved");
    assert.deepEqual(next.reportSections, [{ section: "SALES", reported: true }]);
    assert.equal((applyReportCompletion({ ...(prev as object), reportDeadlinePassed: true } as never, report) as { canSubmitReport: boolean }).canSubmitReport, false, "deadline passed → no Submit");
    assert.equal((applyReportCompletion({ ...(prev as object), isFinalized: true } as never, report) as { canSubmitReport: boolean }).canSubmitReport, false, "finalized → no Submit");
    assert.equal((applyReportCompletion(prev, { ...(report as object), complete: false } as never) as { canSubmitReport: boolean }).canSubmitReport, false, "incomplete → no Submit");
  }

  console.log("performance-cache.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
