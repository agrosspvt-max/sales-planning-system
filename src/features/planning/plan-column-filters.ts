/**
 * Column filters for plan-list tables (Recovery Planning and Sales Planning), pure and React-free. Filters only ever
 * NARROW the rows the caller's role scope already returned — they never widen it — and different columns combine
 * with AND while the values selected inside one column combine with OR.
 */
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { MONTH_NAMES } from "@/lib/season-months";

export type PlanFilterKey = "month" | "officer" | "state";

/** The row fields the filters read. `monthName` is absent on plan types that have no Month column (Seasonal/Yearly). */
export interface PlanFilterable {
  monthName?: string | null;
  officerId: string;
  officerName: string;
  groupName: string | null;
}
export type PlanFilters = Partial<Record<PlanFilterKey, string[]>>;

/**
 * Which column headers are filters for a role.
 *   Admin / Super Admin → Month, Sales Officer, State
 *   Regional Manager    → Month, Sales Officer
 *   Sales Officer       → Month
 * Display only: rows were already scoped by role on the server, so this never grants access to anything.
 */
export function planFilterKeys(role: string): PlanFilterKey[] {
  if (isAdministrativeRole(role as never)) return ["month", "officer", "state"];
  if (role === "REGIONAL_MANAGER") return ["month", "officer"];
  return ["month"];
}

const valueOf = (plan: PlanFilterable, key: PlanFilterKey): string =>
  key === "month" ? (plan.monthName ?? "") : key === "officer" ? plan.officerId : (plan.groupName ?? "");

/** OR within a column, AND across columns. Columns not in `allowed` are ignored even if a selection is present. */
export function applyPlanFilters<T extends PlanFilterable>(
  plans: readonly T[],
  filters: PlanFilters,
  allowed: readonly PlanFilterKey[],
): T[] {
  const active = allowed.filter((key) => (filters[key]?.length ?? 0) > 0);
  if (active.length === 0) return [...plans];
  return plans.filter((plan) => active.every((key) => filters[key]!.includes(valueOf(plan, key))));
}

/** Option lists come from the plans the caller is already allowed to see — never from outside their scope. */
export function planFilterOptions(plans: readonly PlanFilterable[], key: PlanFilterKey): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const plan of plans) {
    const value = valueOf(plan, key);
    if ((key === "state" || key === "month") && !value) continue;
    if (!seen.has(value)) seen.set(value, key === "officer" ? plan.officerName : value);
  }
  const options = [...seen.entries()].map(([value, label]) => ({ value, label }));
  if (key === "month") {
    // Calendar order (January … December); anything unrecognised after, alphabetically.
    const rank = (name: string) => { const i = (MONTH_NAMES as readonly string[]).indexOf(name); return i < 0 ? 99 : i; };
    return options.sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}
