/**
 * Shared Recovery totals — the SINGLE source of the Month/Week roll-up math.
 *
 * The exact formulas that used to live in `recovery-workspace.tsx` now live here so the editing
 * workspace AND the read-only Territory Recovery view compute totals the same way (no duplication).
 * Behaviour is preserved via two knobs:
 *   - `resolve(d)` / `resolve(d, week)` — how a dealer's plan/running values are read. The workspace
 *     passes the live edit map (falling back to stored); Territory passes the stored values.
 *   - `pctMode` — the workspace keeps its existing "sum of per-dealer ratios"; Territory uses the
 *     mathematically-correct officer-level ratio (Σ running-recovery / Σ running-O/S).
 */

export interface RecoveryCalcDealer {
  dealerId: string;
  outstanding: number;
  outstandingTillDate: number;
  overdue: number;
  due: number;
  running: number;
  runningTillDate: number;
  srCr: number;
  liveRecovery: number;
  actualRunningRecovery: number;
  monthRecoveryPlan: number;
  monthRunningRecovery: number;
  weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }>;
  dueByWeek: Record<number, number>;
}

export interface RecoveryValue { plan: number; running: number }
export type PctMode = "sumOfRatios" | "ratioOfSums";

/** Read a dealer's stored MONTH plan/running (used by the read-only Territory view). */
export function storedMonth(d: RecoveryCalcDealer): RecoveryValue {
  return { plan: d.monthRecoveryPlan, running: d.monthRunningRecovery };
}
/** Read a dealer's stored values for a given WEEK (used by the read-only Territory view). */
export function storedWeek(d: RecoveryCalcDealer, w: number): RecoveryValue {
  const wk = d.weeks[w];
  return wk ? { plan: wk.weekRecoveryPlan, running: wk.weekRunningRecovery } : { plan: 0, running: 0 };
}

export interface RecoveryMonthTotals {
  outstanding: number;
  outstandingTillDate: number;
  overdue: number;
  due: number;
  recoveryPlan: number;
  runningOs: number;
  runningOsTillDate: number;
  runningRecoveryPlan: number;
  recoveryPct: number;
  srCr: number;
  liveRecovery: number;
  actualRunningRecovery: number;
  monthTotal: number;
}

/** Month View totals — identical to the original workspace reduce, with `pctMode` selecting the % rule. */
export function recoveryMonthTotals<D extends RecoveryCalcDealer>(dealers: D[], resolve: (d: D) => RecoveryValue, pctMode: PctMode): RecoveryMonthTotals {
  const t: RecoveryMonthTotals = {
    outstanding: 0, outstandingTillDate: 0, overdue: 0, due: 0, recoveryPlan: 0, runningOs: 0, runningOsTillDate: 0,
    runningRecoveryPlan: 0, recoveryPct: 0, srCr: 0, liveRecovery: 0, actualRunningRecovery: 0, monthTotal: 0,
  };
  let sumRatio = 0;
  for (const d of dealers) {
    const v = resolve(d);
    t.outstanding += d.outstanding;
    t.outstandingTillDate += d.outstandingTillDate;
    t.overdue += d.overdue;
    t.due += d.due;
    t.recoveryPlan += v.plan;
    t.runningOs += d.running;
    t.runningOsTillDate += d.runningTillDate;
    t.runningRecoveryPlan += v.running;
    sumRatio += d.running > 0 ? v.running / d.running : 0;
    t.srCr += d.srCr;
    t.liveRecovery += d.liveRecovery;
    t.actualRunningRecovery += d.actualRunningRecovery;
    t.monthTotal += v.plan + v.running;
  }
  t.recoveryPct = pctMode === "sumOfRatios" ? sumRatio : t.runningOs > 0 ? t.runningRecoveryPlan / t.runningOs : 0;
  return t;
}

/** Cumulative plan+running through the selected week (Week View "Weekly Plan Till Date"). */
export function weekTillDate<D extends RecoveryCalcDealer>(d: D, weekNo: number, resolve: (d: D, w: number) => RecoveryValue): number {
  let t = 0;
  for (let w = 1; w <= weekNo; w++) {
    const v = resolve(d, w);
    t += v.plan + v.running;
  }
  return t;
}
/** Plan+running across ALL weeks (Week View "Diff" vs the month total). */
export function weekAll<D extends RecoveryCalcDealer>(d: D, weekCount: number, resolve: (d: D, w: number) => RecoveryValue): number {
  let t = 0;
  for (let w = 1; w <= weekCount; w++) {
    const v = resolve(d, w);
    t += v.plan + v.running;
  }
  return t;
}

export interface RecoveryWeekTotals {
  outstanding: number;
  overdue: number;
  due: number;
  recoveryPlan: number;
  runningMonthPlan: number;
  weeklyPlanTillDate: number;
  runningPlanThisWeek: number;
  weekTotal: number;
  diff: number;
}

/** Week View totals — identical to the original workspace reduce. */
export function recoveryWeekTotals<D extends RecoveryCalcDealer>(dealers: D[], resolve: (d: D, w: number) => RecoveryValue, weekNo: number, weekCount: number): RecoveryWeekTotals {
  const t: RecoveryWeekTotals = { outstanding: 0, overdue: 0, due: 0, recoveryPlan: 0, runningMonthPlan: 0, weeklyPlanTillDate: 0, runningPlanThisWeek: 0, weekTotal: 0, diff: 0 };
  for (const d of dealers) {
    const v = resolve(d, weekNo);
    const monthTotal = d.monthRecoveryPlan + d.monthRunningRecovery;
    t.outstanding += d.outstanding;
    t.overdue += d.overdue;
    t.due += d.dueByWeek?.[weekNo] ?? 0;
    t.recoveryPlan += v.plan;
    t.runningMonthPlan += d.monthRunningRecovery;
    t.weeklyPlanTillDate += weekTillDate(d, weekNo, resolve);
    t.runningPlanThisWeek += v.running;
    t.weekTotal += v.plan + v.running;
    t.diff += monthTotal - weekAll(d, weekCount, resolve);
  }
  return t;
}
