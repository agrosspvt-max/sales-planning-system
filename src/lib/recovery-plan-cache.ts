/**
 * Recovery plan editor cache updates after a successful Month / Week save. The save response carries the values exactly as the database stored them; these
 * pure functions write them into the cached plan with the SAME derived rule the plan read uses, so the screen needs no full re-read of the plan.
 */

/** A dealer row counts as planned (Completed) once it has a Month Recovery Plan or a Month Running Recovery Plan above zero — the plan read's rule. */
export const recoveryDealerCompleted = (monthRecoveryPlan: number, monthRunningRecovery: number): boolean => monthRecoveryPlan > 0 || monthRunningRecovery > 0;

interface CacheDealer {
  dealerId: string;
  monthRecoveryPlan: number;
  monthRunningRecovery: number;
  completed: boolean;
  weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }>;
}

export function applySavedMonth<D extends { dealers: P[] }, P extends CacheDealer>(detail: D, saved: { dealerId: string; monthRecoveryPlan: number; monthRunningRecovery: number }[]): D {
  const byDealer = new Map(saved.map((s) => [s.dealerId, s]));
  return { ...detail, dealers: detail.dealers.map((d) => {
    const s = byDealer.get(d.dealerId);
    return s ? { ...d, monthRecoveryPlan: s.monthRecoveryPlan, monthRunningRecovery: s.monthRunningRecovery, completed: recoveryDealerCompleted(s.monthRecoveryPlan, s.monthRunningRecovery) } : d;
  }) };
}

export function applySavedWeek<D extends { dealers: P[] }, P extends CacheDealer>(detail: D, weekNo: number, saved: { dealerId: string; weekRecoveryPlan: number; weekRunningRecovery: number }[]): D {
  const byDealer = new Map(saved.map((s) => [s.dealerId, s]));
  return { ...detail, dealers: detail.dealers.map((d) => {
    const s = byDealer.get(d.dealerId);
    return s ? { ...d, weeks: { ...d.weeks, [weekNo]: { weekRecoveryPlan: s.weekRecoveryPlan, weekRunningRecovery: s.weekRunningRecovery } } } : d;
  }) };
}
