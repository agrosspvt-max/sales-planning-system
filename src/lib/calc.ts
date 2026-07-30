/**
 * Calculation engine — the official reference implementation of PROJECT_SPECIFICATION.md §17 / §36.8.
 * Pure functions, shared by client and server. Quantities are whole numbers; rate and
 * nbvPercent (a fraction, e.g. 0.25 = 25%) come from the product master, or from the
 * plan-line snapshot once the plan is approved. Full precision is kept here; rounding is
 * applied only at display time (see lib/utils formatters).
 *
 * Pack sizes are NOT hard-coded. A plan line's quantity is split across the configured
 * pack sizes (Pack Size master → PlanLinePack). Total Quantity is the sum of ALL of a
 * line's per-pack quantities.
 */

/**
 * Planning Configuration (V1). The Super Admin chooses what a Sales Officer enters
 * during planning. All four modes reduce to the SAME three figures (Total Qty,
 * Amount, NBV) through the formulas below — no new business math is invented.
 */
export type PlanningMode = "PACK_SIZE" | "TOTAL_QUANTITY" | "AMOUNT" | "NBV";

export const PLANNING_MODES: PlanningMode[] = ["PACK_SIZE", "TOTAL_QUANTITY", "AMOUNT", "NBV"];

export const PLANNING_MODE_LABELS: Record<PlanningMode, string> = {
  PACK_SIZE: "Pack Size",
  TOTAL_QUANTITY: "Total Quantity",
  AMOUNT: "Amount",
  NBV: "NBV",
};

/** True when the mode's primary input is a whole-unit quantity. */
export function isQuantityMode(mode: PlanningMode): boolean {
  return mode === "PACK_SIZE" || mode === "TOTAL_QUANTITY";
}

/** Figures where a member is `null` when the current mode cannot derive it. */
export interface FlexFigures {
  totalQty: number | null;
  amount: number | null;
  nbv: number | null;
}

/**
 * Derive the three figures from the single value the officer entered under `mode`.
 * `value` is interpreted per the mode:
 *   - PACK_SIZE / TOTAL_QUANTITY → `value` is Total Quantity (for PACK_SIZE the caller
 *     passes the sum of the line's per-pack quantities). amount = qty×rate, nbv = amount×nbv%.
 *   - AMOUNT → `value` is the planned Amount. nbv = amount×nbv%. Quantity is left null
 *     (not back-computed, to avoid inventing fractional pack counts).
 *   - NBV → `value` is the planned NBV. amount = nbv ÷ nbv% when nbv% > 0 (an exact
 *     inversion of the NBV formula), else null. Quantity is left null.
 */
export function figuresForMode(
  mode: PlanningMode,
  value: number,
  rate: number,
  nbvPercent: number,
): FlexFigures {
  if (isQuantityMode(mode)) {
    const amt = amount(value, rate);
    return { totalQty: value, amount: amt, nbv: nbv(amt, nbvPercent) };
  }
  if (mode === "AMOUNT") {
    return { totalQty: null, amount: value, nbv: nbv(value, nbvPercent) };
  }
  // NBV mode
  const amt = nbvPercent > 0 ? value / nbvPercent : null;
  return { totalQty: null, amount: amt, nbv: value };
}

/** Sum FlexFigures. A field stays null only if every item's field is null. */
export function sumFlex(items: FlexFigures[]): FlexFigures {
  const add = (key: keyof FlexFigures): number | null => {
    let any = false;
    let total = 0;
    for (const it of items) {
      const v = it[key];
      if (v !== null && v !== undefined) {
        any = true;
        total += v;
      }
    }
    return any ? total : null;
  };
  return { totalQty: add("totalQty"), amount: add("amount"), nbv: add("nbv") };
}

/** §17.1 Total Quantity = sum of every per-pack quantity on the plan line. */
export function totalQuantity(perPackQuantities: number[]): number {
  return perPackQuantities.reduce((a, b) => a + b, 0);
}

/** §17.3 Amount = quantity × rate. */
export function amount(qty: number, rate: number): number {
  return qty * rate;
}

/** §17.4 NBV = amount × NBV%. */
export function nbv(amountValue: number, nbvPercent: number): number {
  return amountValue * nbvPercent;
}

/** §17.8 Achievement = actual ÷ plan, with the zero-plan guard (returns 0 when plan = 0). */
export function achievement(actual: number, plan: number): number {
  if (plan === 0) return 0;
  return actual / plan;
}

/** §17.9 Variance = actual − plan (signed). */
export function variance(actual: number, plan: number): number {
  return actual - plan;
}

/** Shortfall used by dashboards: max(0, plan − actual). */
export function gap(plan: number, actual: number): number {
  return Math.max(0, plan - actual);
}

/** §15.4 / §17.7 Excess over the approved seasonal quantity: max(0, planned − target). */
export function excess(planned: number, target: number): number {
  return Math.max(0, planned - target);
}

/** Remaining seasonal quantity = target − used (may be negative when over-planned). */
export function remaining(target: number, used: number): number {
  return target - used;
}

export interface LineFigures {
  totalQty: number;
  amount: number;
  nbv: number;
}

/** Compute a single plan line's totals from its total quantity and effective price. */
export function lineFigures(totalQty: number, rate: number, nbvPercent: number): LineFigures {
  const amt = amount(totalQty, rate);
  return { totalQty, amount: amt, nbv: nbv(amt, nbvPercent) };
}

/** Convenience: compute a line's figures directly from its per-pack quantities. */
export function lineFiguresFromPacks(
  perPackQuantities: number[],
  rate: number,
  nbvPercent: number,
): LineFigures {
  return lineFigures(totalQuantity(perPackQuantities), rate, nbvPercent);
}

/** Sum an array of line figures (dealer / product / territory roll-up — §17.10 / §36.8). */
export function sumFigures(items: LineFigures[]): LineFigures {
  return items.reduce<LineFigures>(
    (acc, f) => ({
      totalQty: acc.totalQty + f.totalQty,
      amount: acc.amount + f.amount,
      nbv: acc.nbv + f.nbv,
    }),
    { totalQty: 0, amount: 0, nbv: 0 },
  );
}

export interface MonthlyProductSummary {
  approvedSeasonQty: number;
  totalMonthlyPlanned: number;
  totalSold: number;
  remainingSeasonQty: number; // approved − planned (may be negative)
  excessQty: number; // max(0, planned − approved)
  remainingAmount: number;
  remainingNbv: number;
  achievementQty: number; // sold ÷ approved (fraction)
  varianceQty: number; // sold − approved
  isOverPlanned: boolean;
}

/**
 * §15 / §17.7 Monthly roll-up for one product in one dealer.
 * Over-planning is allowed: remaining may be negative and excess is surfaced — never blocked.
 */
export function monthlyProductSummary(
  approvedSeasonQty: number,
  monthlyPlanned: number[],
  monthlySold: number[],
  rate: number,
  nbvPercent: number,
): MonthlyProductSummary {
  const totalMonthlyPlanned = monthlyPlanned.reduce((a, b) => a + b, 0);
  const totalSold = monthlySold.reduce((a, b) => a + b, 0);
  const remainingSeasonQty = remaining(approvedSeasonQty, totalMonthlyPlanned);
  const excessQty = excess(totalMonthlyPlanned, approvedSeasonQty);
  const remainingForValue = Math.max(0, remainingSeasonQty);
  const remainingAmount = amount(remainingForValue, rate);
  return {
    approvedSeasonQty,
    totalMonthlyPlanned,
    totalSold,
    remainingSeasonQty,
    excessQty,
    remainingAmount,
    remainingNbv: nbv(remainingAmount, nbvPercent),
    achievementQty: achievement(totalSold, approvedSeasonQty),
    varianceQty: variance(totalSold, approvedSeasonQty),
    isOverPlanned: excessQty > 0,
  };
}

/* ------------------------- Workbook-faithful metrics ---------------------- */
/**
 * Corrected planning metrics (Section 34.8 / 40.2) — authoritative over the Excel
 * workbook. Defined so normal use never shows confusing negatives.
 */
/** Pending Qty = Season Target − Actual Sales (how much is still left to achieve). */
export function pendingQty(target: number, actual: number): number {
  return target - actual;
}
/** Season-vs-Month Difference = Season Target − Total Monthly Planned (unallocated to months). */
export function seasonVsMonth(target: number, monthlyPlanned: number): number {
  return target - monthlyPlanned;
}

export interface WorkbookMonth {
  planQty: number;
  planAmount: number;
  planNbv: number;
  saleQty: number;
  saleAmount: number;
  actualNbv: number;
  pendingQty: number; // month plan − month sale
  differenceAmount: number; // month plan amount − month sale amount
}

export interface WorkbookLine {
  // Season target (primary figure of the seasonal mode).
  targetQty: number | null;
  planAmount: number | null;
  planNbv: number | null;
  // Actual sales (Σ monthly sale).
  actualQty: number;
  actualAmount: number;
  actualNbv: number;
  // Live monthly plan (Σ monthly plan).
  liveMonthlyQty: number;
  liveMonthlyAmount: number;
  liveMonthlyNbv: number;
  // Corrected metrics.
  seasonVsMonthDiff: number; // target − monthly planned
  pendingQty: number; // target − actual
  achievement: number; // actual ÷ target
  months: WorkbookMonth[];
}

/**
 * The ONE place the workbook line is assembled. Every screen (Seasonal grid read-only
 * columns, Monthly planner, Workbook View) consumes this — no duplicated formulas.
 * `seasonalInput` is the stored seasonal figure (pack-sum for PACK_SIZE, else inputValue);
 * monthly plan/sale are per-month quantities. Amount = qty×rate, NBV = amount×nbv%.
 */
export function assembleWorkbookLine(
  seasonalMode: PlanningMode,
  seasonalInput: number,
  monthlyPlanQty: number[],
  monthlySaleQty: number[],
  rate: number,
  nbvPercent: number,
): WorkbookLine {
  const season = figuresForMode(seasonalMode, seasonalInput, rate, nbvPercent);
  const targetQty = season.totalQty; // null for AMOUNT/NBV modes
  const targetForMetrics = targetQty ?? 0;

  const liveMonthlyQty = monthlyPlanQty.reduce((a, b) => a + b, 0);
  const actualQty = monthlySaleQty.reduce((a, b) => a + b, 0);

  const months: WorkbookMonth[] = monthlyPlanQty.map((pq, i) => {
    const sq = monthlySaleQty[i] ?? 0;
    const planAmount = amount(pq, rate);
    const saleAmount = amount(sq, rate);
    return {
      planQty: pq,
      planAmount,
      planNbv: nbv(planAmount, nbvPercent),
      saleQty: sq,
      saleAmount,
      actualNbv: nbv(saleAmount, nbvPercent),
      pendingQty: pq - sq,
      differenceAmount: planAmount - saleAmount,
    };
  });

  const actualAmount = amount(actualQty, rate);
  const liveMonthlyAmount = amount(liveMonthlyQty, rate);
  return {
    targetQty,
    planAmount: season.amount,
    planNbv: season.nbv,
    actualQty,
    actualAmount,
    actualNbv: nbv(actualAmount, nbvPercent),
    liveMonthlyQty,
    liveMonthlyAmount,
    liveMonthlyNbv: nbv(liveMonthlyAmount, nbvPercent),
    seasonVsMonthDiff: seasonVsMonth(targetForMetrics, liveMonthlyQty),
    pendingQty: pendingQty(targetForMetrics, actualQty),
    achievement: achievement(actualQty, targetForMetrics),
    months,
  };
}
