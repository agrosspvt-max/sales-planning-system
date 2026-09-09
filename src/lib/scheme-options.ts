/**
 * Multiple Options (Phase 10) — PURE logic (no DB, no `server-only`), shared by the Scheme Master server +
 * client (validation), the achievement engine, the Scheme Upload analyzer, and Follow-up. Fixed schemes do
 * NOT use anything here — their behaviour stays in `scheme-achievement.ts` / `scheme-requirement.ts`.
 *
 * Rules (finalised): a Multiple Options scheme has an achievement type (QUANTITY_BASED | VALUE_BASED), an
 * eligible product pool (no per-product requirement), and ≥1 option (label? + target + value pair). A dealer
 * commits to exactly ONE option; its config is snapshotted onto the plan at submission. Achievement is a
 * single combined total across eligible products vs the dealer's snapshot target. Installment rules are
 * percentage-only. Money at paise (2dp), qty at milli (3dp) — matching the schema + the Fixed engine.
 */

import { round2, round3 } from "./scheme-achievement";

export type OptionAchievementType = "QUANTITY_BASED" | "VALUE_BASED";

/* --------------------------------- master validation --------------------------------- */

export interface OptionInput {
  label?: string | null;
  target?: number | null; // qty (QUANTITY_BASED) or value (VALUE_BASED)
  valueWithoutGST?: number | null;
  valueWithGST?: number | null;
}
export interface MultipleOptionsInput {
  achievementType: OptionAchievementType;
  eligibleProductIds: string[];
  options: OptionInput[];
  // Installment calculation types present on the scheme (to enforce percentage-only for options).
  installmentCalcTypes?: string[];
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Validate a Multiple Options configuration. Returns human-readable errors (empty = valid). Enforced on the
 * server (never trust the client) and reused by the client to gate Save.
 */
export function validateMultipleOptions(input: MultipleOptionsInput): string[] {
  const errors: string[] = [];
  if (input.achievementType !== "QUANTITY_BASED" && input.achievementType !== "VALUE_BASED") {
    errors.push("Select an achievement type (Quantity Based or Value Based).");
  }
  const eligible = [...new Set(input.eligibleProductIds ?? [])];
  if (eligible.length === 0) errors.push("Add at least one eligible product.");
  if ((input.eligibleProductIds ?? []).length !== eligible.length) errors.push("An eligible product is listed more than once.");

  const options = input.options ?? [];
  if (options.length === 0) errors.push("Add at least one option.");
  const targetKeys = new Set<string>();
  for (const o of options) {
    const target = num(o.target);
    const vWithout = num(o.valueWithoutGST);
    const vWith = num(o.valueWithGST);
    if (target == null || target <= 0) errors.push("Every option needs a target greater than zero.");
    if (vWithout == null || vWithout <= 0) errors.push("Every option needs a Value (Without GST) greater than zero.");
    if (vWith == null || vWith <= 0) errors.push("Every option needs a Value (With GST) greater than zero.");
    // Options must be distinguishable by target (avoids ambiguous duplicate commitments).
    if (target != null) {
      const key = String(Math.round(target * 1000));
      if (targetKeys.has(key)) errors.push("Two options have the same target — options must be distinguishable.");
      targetKeys.add(key);
    }
  }
  // Installment rules for Multiple Options are percentage-only (FIXED_AMOUNT can't map to per-option values).
  if ((input.installmentCalcTypes ?? []).some((t) => t !== "PERCENTAGE")) {
    errors.push("Multiple Options installment rules must be percentage-based (fixed amounts are not allowed).");
  }
  return errors;
}

/** Normalize one option row to its canonical stored shape for the scheme's achievement type. */
export function normalizeOption(o: OptionInput, achievementType: OptionAchievementType): {
  label: string | null; targetQty: number | null; targetValue: number | null; valueWithoutGST: number; valueWithGST: number;
} {
  const target = num(o.target) ?? 0;
  return {
    label: o.label?.trim() ? o.label.trim() : null,
    targetQty: achievementType === "QUANTITY_BASED" ? round3(target) : null,
    targetValue: achievementType === "VALUE_BASED" ? round2(target) : null,
    valueWithoutGST: round2(num(o.valueWithoutGST) ?? 0),
    valueWithGST: round2(num(o.valueWithGST) ?? 0),
  };
}

/* --------------------------------- effective value / target resolver --------------------------------- */

/**
 * The ONE authoritative value resolver. FIXED → the scheme-level value; MULTIPLE_OPTIONS → the plan's frozen
 * option snapshot. Never a scattered `?? 0`: for a committed plan exactly one branch has the real number.
 * (During Draft the caller passes the live option value directly; this is for committed reads.)
 */
export function effectiveValueWithGST(p: { structure: string; schemeValueWithGST: number | null; optionValueWithGST: number | null }): number {
  const v = p.structure === "MULTIPLE_OPTIONS" ? p.optionValueWithGST : p.schemeValueWithGST;
  return v == null ? 0 : v;
}
export function effectiveValueWithoutGST(p: { structure: string; schemeValueWithoutGST: number | null; optionValueWithoutGST: number | null }): number {
  const v = p.structure === "MULTIPLE_OPTIONS" ? p.optionValueWithoutGST : p.schemeValueWithoutGST;
  return v == null ? 0 : v;
}
/** A committed option plan's target (qty or value) from its snapshot; null for non-option plans. */
export function effectiveOptionTarget(p: { achievementType: OptionAchievementType | null; optionTargetQty: number | null; optionTargetValue: number | null }): number | null {
  if (p.achievementType === "QUANTITY_BASED") return p.optionTargetQty;
  if (p.achievementType === "VALUE_BASED") return p.optionTargetValue;
  return null;
}

/* --------------------------------- achievement (option) --------------------------------- */

export interface OptionSaleFact { dealerId: string; productId: string; qty: number; value: number }
export interface OptionContribution { productId: string; achievedQty: number; achievedValue: number }
export interface DealerOptionAchievement {
  achievementType: OptionAchievementType;
  target: number;
  achieved: number;
  remaining: number;
  completed: boolean;
  progress: number | null; // achieved / target (uncapped; UI caps at 100%)
  contributions: OptionContribution[]; // eligible-product sales breakdown (contribution, NOT requirement)
}

const n = (v: unknown): number => { const x = typeof v === "number" ? v : Number(v); return Number.isFinite(x) ? x : 0; };
const paise = (v: number) => Math.round(n(v) * 100);
const milli = (v: number) => Math.round(n(v) * 1000);

/** Sum an enrolled dealer's ELIGIBLE-product sales into one achieved total vs their snapshot target. */
export function dealerOptionAchievement(
  achievementType: OptionAchievementType,
  target: number,
  eligible: Set<string>,
  dealerSums: Map<string, { qty: number; value: number }>,
): DealerOptionAchievement {
  const contributions: OptionContribution[] = [];
  let achievedQty = 0;
  let achievedValue = 0;
  for (const [productId, s] of dealerSums) {
    if (!eligible.has(productId)) continue; // non-eligible products never contribute
    achievedQty = round3(achievedQty + n(s.qty));
    achievedValue = round2(achievedValue + n(s.value));
    contributions.push({ productId, achievedQty: round3(n(s.qty)), achievedValue: round2(n(s.value)) });
  }
  contributions.sort((a, b) => a.productId.localeCompare(b.productId));
  const isQty = achievementType === "QUANTITY_BASED";
  const achieved = isQty ? achievedQty : achievedValue;
  const t = isQty ? round3(target) : round2(target);
  const gte = isQty ? milli(achieved) >= milli(t) : paise(achieved) >= paise(t);
  const remainingRaw = Math.max(t - achieved, 0);
  return {
    achievementType,
    target: t,
    achieved: isQty ? round3(achieved) : round2(achieved),
    remaining: isQty ? round3(remainingRaw) : round2(remainingRaw),
    completed: gte,
    progress: t > 0 ? achieved / t : null,
    contributions,
  };
}

export interface OptionPerDealer { dealerId: string; target: number; achievement: DealerOptionAchievement }
export interface SchemeOptionAchievement {
  achievementType: OptionAchievementType;
  dealerCount: number;
  eligibleCount: number;
  perDealer: OptionPerDealer[];
}

/**
 * Scheme-level option achievement across enrolled dealers. Each dealer uses THEIR OWN snapshot target
 * (`targetByDealer`); dealers with no target (e.g. not committed) are skipped. Only ACTIVE-scope sales +
 * enrolled dealers are passed in by the caller (same contract as the Fixed engine).
 */
export function schemeOptionAchievement(
  achievementType: OptionAchievementType,
  eligibleProductIds: string[],
  sales: OptionSaleFact[],
  targetByDealer: Map<string, number>,
): SchemeOptionAchievement {
  const eligible = new Set(eligibleProductIds);
  // Group sales by dealer → product (only enrolled dealers appear in targetByDealer).
  const byDealer = new Map<string, Map<string, { qty: number; value: number }>>();
  for (const s of sales) {
    if (!targetByDealer.has(s.dealerId)) continue;
    let m = byDealer.get(s.dealerId);
    if (!m) { m = new Map(); byDealer.set(s.dealerId, m); }
    const cur = m.get(s.productId) ?? { qty: 0, value: 0 };
    cur.qty = round3(cur.qty + n(s.qty));
    cur.value = round2(cur.value + n(s.value));
    m.set(s.productId, cur);
  }
  const perDealer: OptionPerDealer[] = [...targetByDealer.entries()].map(([dealerId, target]) => ({
    dealerId,
    target,
    achievement: dealerOptionAchievement(achievementType, target, eligible, byDealer.get(dealerId) ?? new Map()),
  }));
  return { achievementType, dealerCount: targetByDealer.size, eligibleCount: eligible.size, perDealer };
}

/* --------------------------------- upload impact (option) --------------------------------- */

export interface OptionUploadImpactRow {
  dealerId: string;
  target: number;
  previouslyAchieved: number;
  incoming: number;
  newTotal: number;
  remaining: number;
  completedBefore: boolean;
  completedAfter: boolean;
  contributions: OptionContribution[]; // incoming eligible-product breakdown
}

/**
 * Scheme Upload impact for a Multiple Options scheme. `previous`/`incoming` are keyed `${dealerId}|${productId}`
 * → {qty,value} (the caller excludes the exact-range scope from `previous`, exactly like the Fixed path).
 * Only enrolled dealers with a target contribute; only eligible products count; achieved is the combined
 * total (qty or value). Mirrors the Fixed `uploadImpact` shape but per-dealer target over the eligible pool.
 */
export function optionUploadImpact(
  achievementType: OptionAchievementType,
  eligibleProductIds: string[],
  targetByDealer: Map<string, number>,
  previous: Map<string, { qty: number; value: number }>,
  incoming: Map<string, { qty: number; value: number }>,
): OptionUploadImpactRow[] {
  const eligible = new Set(eligibleProductIds);
  const isQty = achievementType === "QUANTITY_BASED";
  const pick = (v: { qty: number; value: number }) => (isQty ? n(v.qty) : n(v.value));
  const round = (x: number) => (isQty ? round3(x) : round2(x));
  const gte = (a: number, b: number) => (isQty ? milli(a) >= milli(b) : paise(a) >= paise(b));

  const prevByDealer = new Map<string, number>();
  const incByDealer = new Map<string, number>();
  const incContribByDealer = new Map<string, OptionContribution[]>();
  const accumulate = (src: Map<string, { qty: number; value: number }>, dst: Map<string, number>, contribDst?: Map<string, OptionContribution[]>) => {
    for (const [key, v] of src) {
      const [dealerId, productId] = key.split("|");
      if (!targetByDealer.has(dealerId) || !eligible.has(productId)) continue;
      dst.set(dealerId, round((dst.get(dealerId) ?? 0) + pick(v)));
      if (contribDst) {
        const list = contribDst.get(dealerId) ?? [];
        list.push({ productId, achievedQty: round3(n(v.qty)), achievedValue: round2(n(v.value)) });
        contribDst.set(dealerId, list);
      }
    }
  };
  accumulate(previous, prevByDealer);
  accumulate(incoming, incByDealer, incContribByDealer);

  const rows: OptionUploadImpactRow[] = [];
  for (const [dealerId, target] of targetByDealer) {
    const prev = round(prevByDealer.get(dealerId) ?? 0);
    const inc = round(incByDealer.get(dealerId) ?? 0);
    const total = round(prev + inc);
    const t = round(target);
    if (prev === 0 && inc === 0) continue; // nothing to show for this dealer
    rows.push({
      dealerId, target: t,
      previouslyAchieved: prev, incoming: inc, newTotal: total,
      remaining: round(Math.max(t - total, 0)),
      completedBefore: gte(prev, t), completedAfter: gte(total, t),
      contributions: (incContribByDealer.get(dealerId) ?? []).sort((a, b) => a.productId.localeCompare(b.productId)),
    });
  }
  rows.sort((a, b) => a.dealerId.localeCompare(b.dealerId));
  return rows;
}
