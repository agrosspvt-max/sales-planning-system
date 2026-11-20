/**
 * Recovery plan editor cache updates after a successful Month / Week save. The save response carries the values exactly as the database stored them; these
 * pure functions write them into the cached plan with the SAME derived rule the plan read uses, so the screen needs no full re-read of the plan.
 */

/** Positive monthly or weekly planning amounts take priority over a saved No Plan flag. */
export function recoveryDealerCompleted(
  monthRecoveryPlan: number,
  monthRunningRecovery: number,
  weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }> = {},
): boolean {
  return monthRecoveryPlan > 0 || monthRunningRecovery > 0
    || Object.values(weeks).some((w) => w.weekRecoveryPlan > 0 || w.weekRunningRecovery > 0);
}

interface CacheDealer {
  dealerId: string;
  monthRecoveryPlan: number;
  monthRunningRecovery: number;
  completed: boolean;
  noPlan?: boolean;
  weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }>;
}

export function applySavedMonth<D extends { dealers: P[] }, P extends CacheDealer>(detail: D, saved: { dealerId: string; monthRecoveryPlan: number; monthRunningRecovery: number }[]): D {
  const byDealer = new Map(saved.map((s) => [s.dealerId, s]));
  return { ...detail, dealers: detail.dealers.map((d) => {
    const s = byDealer.get(d.dealerId);
    if (!s) return d;
    const completed = recoveryDealerCompleted(s.monthRecoveryPlan, s.monthRunningRecovery, d.weeks);
    return { ...d, monthRecoveryPlan: s.monthRecoveryPlan, monthRunningRecovery: s.monthRunningRecovery, completed, ...(completed ? { noPlan: false } : {}) };
  }) };
}

export function applySavedWeek<D extends { dealers: P[] }, P extends CacheDealer>(detail: D, weekNo: number, saved: { dealerId: string; weekRecoveryPlan: number; weekRunningRecovery: number }[]): D {
  const byDealer = new Map(saved.map((s) => [s.dealerId, s]));
  return { ...detail, dealers: detail.dealers.map((d) => {
    const s = byDealer.get(d.dealerId);
    if (!s) return d;
    const weeks = { ...d.weeks, [weekNo]: { weekRecoveryPlan: s.weekRecoveryPlan, weekRunningRecovery: s.weekRunningRecovery } };
    const completed = recoveryDealerCompleted(d.monthRecoveryPlan, d.monthRunningRecovery, weeks);
    return { ...d, weeks, completed, ...(completed ? { noPlan: false } : {}) };
  }) };
}
