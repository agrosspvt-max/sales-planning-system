/**
 * Shared, PURE Scheme Achievement + Installment calculation engine.
 *
 * This module has NO database access and NO `server-only` import, so it is the ONE authoritative
 * definition of every scheme calculation and can be unit-tested directly. The server layer
 * (`scheme-achievement.server.ts`) loads data with batched Prisma queries and feeds these functions;
 * Scheme Follow-up, Dealer Follow-up, Scheme View Plan and Scheme Upload Analysis all consume the SAME
 * functions here, so their numbers can never disagree.
 *
 * Rules (approved Phase 2 decisions):
 *  - Installment is PAID only when received/allocated amount >= planned amount (partial never counts).
 *  - Product Based: remaining = max(requiredQty − achievedQty, 0); completed when achieved >= required.
 *  - Value Based (INDIVIDUAL or COMBINED): remaining = max(requiredValue − achievedValue, 0).
 *  - Achievement is aggregated per (scheme, dealer, product); the same sale contributes independently to
 *    every scheme (callers pass each scheme's own sales). Only ENROLLED dealers contribute (callers pass
 *    the enrolled set). Negative remaining is never produced.
 *  - Money uses 2-decimal (paise) precision; quantities use 3-decimal precision — matching the schema
 *    Decimal(14,2) / Decimal(14,3) columns. Comparisons round to that precision to avoid float noise.
 */

export type SchemeRequirementType = "NONE" | "PRODUCT_BASED" | "VALUE_BASED";
export type SchemeValueMode = "INDIVIDUAL" | "COMBINED";

/** A required product on a Scheme's requirement (qty for PRODUCT_BASED, per-product value for VALUE_BASED
 *  INDIVIDUAL, or just the participating product for VALUE_BASED COMBINED — both nulls). */
export interface RequirementProduct {
  productId: string;
  requiredQty: number | null;
  requiredValue: number | null;
}

export interface SchemeRequirement {
  type: SchemeRequirementType;
  valueMode: SchemeValueMode | null;
  combinedRequiredValue: number | null;
  products: RequirementProduct[];
}

/** One achievement fact fed to the engine (already ACTIVE-scope, already for this scheme). */
export interface SchemeSaleFact {
  dealerId: string;
  productId: string;
  qty: number;
  value: number;
}

/* --------------------------------- precision helpers --------------------------------- */

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const paise = (v: number): number => Math.round(n(v) * 100);
const milli = (v: number): number => Math.round(n(v) * 1000);
export const round2 = (v: number): number => paise(v) / 100;
export const round3 = (v: number): number => milli(v) / 1000;
/** achieved >= required at money precision (paise). */
const valueGte = (achieved: number, required: number): boolean => paise(achieved) >= paise(required);
/** achieved >= required at quantity precision (milli). */
const qtyGte = (achieved: number, required: number): boolean => milli(achieved) >= milli(required);
const remainingOf = (required: number, achieved: number, kind: "qty" | "value"): number => {
  const diff = kind === "qty" ? round3(required) - round3(achieved) : round2(required) - round2(achieved);
  const floored = Math.max(diff, 0);
  return kind === "qty" ? round3(floored) : round2(floored);
};

/* ------------------------------------ installments ------------------------------------ */

export interface InstallmentPaidInput {
  plannedAmount: number;
  /** The authoritative received/allocated amount (rollup of SchemePaymentAllocation); null = nothing. */
  receivedAmount: number | null;
}

/** Paid / Total installment counts. An installment counts as PAID only when its received amount is present
 *  AND >= its planned amount (a partial payment stays 0/1). The payment ledger is never modified. */
export function installmentPaidTotal(items: InstallmentPaidInput[]): { paid: number; total: number } {
  let paid = 0;
  for (const it of items) {
    if (it.receivedAmount != null && paise(it.plannedAmount) > 0 && valueGte(it.receivedAmount, it.plannedAmount)) paid++;
  }
  return { paid, total: items.length };
}

/* --------------------------------- per-dealer building block --------------------------------- */

/** Sum each dealer's sales by product, keeping only ENROLLED dealers. */
function salesByDealerProduct(
  sales: SchemeSaleFact[],
  enrolled: Set<string>,
): Map<string, Map<string, { qty: number; value: number }>> {
  const out = new Map<string, Map<string, { qty: number; value: number }>>();
  for (const s of sales) {
    if (!enrolled.has(s.dealerId)) continue; // only enrolled dealers contribute
    let byProduct = out.get(s.dealerId);
    if (!byProduct) {
      byProduct = new Map();
      out.set(s.dealerId, byProduct);
    }
    const cur = byProduct.get(s.productId) ?? { qty: 0, value: 0 };
    cur.qty = round3(cur.qty + n(s.qty));
    cur.value = round2(cur.value + n(s.value));
    byProduct.set(s.productId, cur);
  }
  return out;
}

/* ------------------------------------ Product Based ------------------------------------ */

export interface ProductItem {
  productId: string;
  requiredQty: number;
  achievedQty: number;
  remainingQty: number;
  completed: boolean;
}
export interface DealerProductAchievement {
  requiredQty: number;
  achievedQty: number;
  remainingQty: number;
  productsCompleted: number;
  productsTotal: number;
  progress: number | null; // achievedQty / requiredQty (uncapped; UI may cap at 100%)
  items: ProductItem[];
}

/** One enrolled dealer's Product Based achievement for a scheme. */
export function dealerProductAchievement(
  req: SchemeRequirement,
  dealerSums: Map<string, { qty: number; value: number }>,
): DealerProductAchievement {
  const items: ProductItem[] = req.products.map((p) => {
    const requiredQty = round3(p.requiredQty ?? 0);
    const achievedQty = round3(dealerSums.get(p.productId)?.qty ?? 0);
    return {
      productId: p.productId,
      requiredQty,
      achievedQty,
      remainingQty: remainingOf(requiredQty, achievedQty, "qty"),
      completed: qtyGte(achievedQty, requiredQty),
    };
  });
  const requiredQty = round3(items.reduce((s, i) => s + i.requiredQty, 0));
  const achievedQty = round3(items.reduce((s, i) => s + i.achievedQty, 0));
  const remainingQty = round3(items.reduce((s, i) => s + i.remainingQty, 0)); // per-item floored (no offset)
  return {
    requiredQty,
    achievedQty,
    remainingQty,
    productsCompleted: items.filter((i) => i.completed).length,
    productsTotal: items.length,
    progress: requiredQty > 0 ? achievedQty / requiredQty : null,
    items,
  };
}

export interface SchemeProductAchievement {
  dealerCount: number;
  productCount: number;
  requiredQty: number;
  achievedQty: number;
  remainingQty: number;
  productsCompleted: number; // products whose AGGREGATE (Σ dealers) achieved >= aggregate required
  productsTotal: number;
  progress: number | null;
  perDealer: { dealerId: string; achievement: DealerProductAchievement }[];
}

/** Scheme-level Product Based achievement across every enrolled dealer (dealers with no sales included). */
export function schemeProductAchievement(
  req: SchemeRequirement,
  sales: SchemeSaleFact[],
  enrolledDealerIds: string[],
): SchemeProductAchievement {
  const enrolled = new Set(enrolledDealerIds);
  const byDealer = salesByDealerProduct(sales, enrolled);
  const perDealer = enrolledDealerIds.map((dealerId) => ({
    dealerId,
    achievement: dealerProductAchievement(req, byDealer.get(dealerId) ?? new Map()),
  }));

  // Scheme "Products Completed" = per product, aggregate achieved (Σ dealers) >= aggregate required
  // (requiredQty × enrolled count). Dealers with no sales still add to the required denominator.
  const dealerCount = enrolledDealerIds.length;
  const aggAchievedByProduct = new Map<string, number>();
  for (const byProduct of byDealer.values()) {
    for (const [pid, s] of byProduct) aggAchievedByProduct.set(pid, round3((aggAchievedByProduct.get(pid) ?? 0) + s.qty));
  }
  let productsCompleted = 0;
  for (const p of req.products) {
    const aggReq = round3((p.requiredQty ?? 0) * dealerCount);
    const aggAch = round3(aggAchievedByProduct.get(p.productId) ?? 0);
    if (qtyGte(aggAch, aggReq)) productsCompleted += 1;
  }

  const requiredQty = round3(perDealer.reduce((s, d) => s + d.achievement.requiredQty, 0));
  const achievedQty = round3(perDealer.reduce((s, d) => s + d.achievement.achievedQty, 0));
  const remainingQty = round3(perDealer.reduce((s, d) => s + d.achievement.remainingQty, 0));
  return {
    dealerCount,
    productCount: req.products.length,
    requiredQty,
    achievedQty,
    remainingQty,
    productsCompleted,
    productsTotal: req.products.length,
    progress: requiredQty > 0 ? achievedQty / requiredQty : null,
    perDealer,
  };
}

/* ------------------------------------- Value Based ------------------------------------- */

export interface ValueItem {
  productId: string;
  requiredValue: number; // 0 for COMBINED participating products (single target lives on the requirement)
  achievedValue: number;
  achievedQty: number; // supporting info
  remainingValue: number;
  completed: boolean; // INDIVIDUAL only; ignored for COMBINED
}
export interface DealerValueAchievement {
  mode: SchemeValueMode;
  requiredValue: number;
  achievedValue: number;
  achievedQty: number; // supporting: Σ qty over participating products
  remainingValue: number;
  completed: boolean;
  itemsCompleted: number; // INDIVIDUAL: products met; COMBINED: 1 if met else 0
  itemsTotal: number; // INDIVIDUAL: product count; COMBINED: 1
  progress: number | null;
  items: ValueItem[]; // participating products (for the expandable detail)
}

/** One enrolled dealer's Value Based achievement for a scheme (INDIVIDUAL or COMBINED). */
export function dealerValueAchievement(
  req: SchemeRequirement,
  dealerSums: Map<string, { qty: number; value: number }>,
): DealerValueAchievement {
  const mode: SchemeValueMode = req.valueMode ?? "INDIVIDUAL";
  const items: ValueItem[] = req.products.map((p) => {
    const sums = dealerSums.get(p.productId);
    const achievedValue = round2(sums?.value ?? 0);
    const achievedQty = round3(sums?.qty ?? 0);
    const requiredValue = mode === "INDIVIDUAL" ? round2(p.requiredValue ?? 0) : 0;
    return {
      productId: p.productId,
      requiredValue,
      achievedValue,
      achievedQty,
      remainingValue: mode === "INDIVIDUAL" ? remainingOf(requiredValue, achievedValue, "value") : 0,
      completed: mode === "INDIVIDUAL" ? valueGte(achievedValue, requiredValue) : false,
    };
  });
  const achievedValue = round2(items.reduce((s, i) => s + i.achievedValue, 0)); // Σ over participating products (no double count)
  const achievedQty = round3(items.reduce((s, i) => s + i.achievedQty, 0));

  if (mode === "COMBINED") {
    const requiredValue = round2(req.combinedRequiredValue ?? 0);
    const remainingValue = remainingOf(requiredValue, achievedValue, "value");
    const completed = valueGte(achievedValue, requiredValue);
    return {
      mode, requiredValue, achievedValue, achievedQty, remainingValue, completed,
      itemsCompleted: completed ? 1 : 0, itemsTotal: 1,
      progress: requiredValue > 0 ? achievedValue / requiredValue : null,
      items,
    };
  }
  // INDIVIDUAL
  const requiredValue = round2(items.reduce((s, i) => s + i.requiredValue, 0));
  const remainingValue = round2(items.reduce((s, i) => s + i.remainingValue, 0));
  return {
    mode, requiredValue, achievedValue, achievedQty, remainingValue,
    completed: items.every((i) => i.completed),
    itemsCompleted: items.filter((i) => i.completed).length, itemsTotal: items.length,
    progress: requiredValue > 0 ? achievedValue / requiredValue : null,
    items,
  };
}

export interface SchemeValueAchievement {
  mode: SchemeValueMode;
  dealerCount: number;
  productCount: number;
  requiredValue: number;
  achievedValue: number;
  achievedQty: number;
  remainingValue: number;
  progress: number | null;
  perDealer: { dealerId: string; achievement: DealerValueAchievement }[];
}

/** Scheme-level Value Based achievement across every enrolled dealer. */
export function schemeValueAchievement(
  req: SchemeRequirement,
  sales: SchemeSaleFact[],
  enrolledDealerIds: string[],
): SchemeValueAchievement {
  const enrolled = new Set(enrolledDealerIds);
  const byDealer = salesByDealerProduct(sales, enrolled);
  const perDealer = enrolledDealerIds.map((dealerId) => ({
    dealerId,
    achievement: dealerValueAchievement(req, byDealer.get(dealerId) ?? new Map()),
  }));
  const requiredValue = round2(perDealer.reduce((s, d) => s + d.achievement.requiredValue, 0));
  const achievedValue = round2(perDealer.reduce((s, d) => s + d.achievement.achievedValue, 0));
  const remainingValue = round2(perDealer.reduce((s, d) => s + d.achievement.remainingValue, 0));
  const achievedQty = round3(perDealer.reduce((s, d) => s + d.achievement.achievedQty, 0));
  return {
    mode: req.valueMode ?? "INDIVIDUAL",
    dealerCount: enrolledDealerIds.length,
    productCount: req.products.length,
    requiredValue,
    achievedValue,
    achievedQty,
    remainingValue,
    progress: requiredValue > 0 ? achievedValue / requiredValue : null,
    perDealer,
  };
}

/* ----------------------------- cross-scheme dealer aggregation ----------------------------- */

/** Combine one dealer's Product Based achievement across several schemes (Dealer Follow-up summary). */
export function combineDealerProduct(parts: DealerProductAchievement[]): Omit<DealerProductAchievement, "items"> {
  const requiredQty = round3(parts.reduce((s, p) => s + p.requiredQty, 0));
  const achievedQty = round3(parts.reduce((s, p) => s + p.achievedQty, 0));
  const remainingQty = round3(parts.reduce((s, p) => s + p.remainingQty, 0));
  return {
    requiredQty,
    achievedQty,
    remainingQty,
    productsCompleted: parts.reduce((s, p) => s + p.productsCompleted, 0),
    productsTotal: parts.reduce((s, p) => s + p.productsTotal, 0),
    progress: requiredQty > 0 ? achievedQty / requiredQty : null,
  };
}

/** Combine one dealer's Value Based achievement across several schemes (Dealer Follow-up summary). */
export function combineDealerValue(parts: DealerValueAchievement[]): {
  requiredValue: number; achievedValue: number; remainingValue: number; achievedQty: number;
  itemsCompleted: number; itemsTotal: number; progress: number | null;
} {
  const requiredValue = round2(parts.reduce((s, p) => s + p.requiredValue, 0));
  const achievedValue = round2(parts.reduce((s, p) => s + p.achievedValue, 0));
  const remainingValue = round2(parts.reduce((s, p) => s + p.remainingValue, 0));
  return {
    requiredValue,
    achievedValue,
    remainingValue,
    achievedQty: round3(parts.reduce((s, p) => s + p.achievedQty, 0)),
    itemsCompleted: parts.reduce((s, p) => s + p.itemsCompleted, 0),
    itemsTotal: parts.reduce((s, p) => s + p.itemsTotal, 0),
    progress: requiredValue > 0 ? achievedValue / requiredValue : null,
  };
}

/* ------------------------------------ Upload Impact ------------------------------------ */

export interface UploadImpactRow {
  dealerId: string;
  productId: string;
  requiredQty: number;
  requiredValue: number;
  previouslyAchievedQty: number;
  previouslyAchievedValue: number;
  newAchievedQty: number;
  newAchievedValue: number;
  totalAchievedQty: number;
  totalAchievedValue: number;
  remainingQty: number;
  remainingValue: number;
  completedBefore: boolean;
  completedAfter: boolean;
}

/**
 * Scheme Upload impact for the review screen. `previous` = achievement from OTHER active scopes (the caller
 * excludes the scope being replaced), `incoming` = the parsed file's contribution. Both are keyed
 * `${dealerId}|${productId}` → {qty,value}. Only enrolled dealers are considered. Total = previous + incoming.
 * "completed" uses the PRODUCT_BASED qty rule or the VALUE_BASED INDIVIDUAL value rule per required product;
 * COMBINED completion is a scheme/dealer-level concept and is computed by the value functions above.
 */
export function uploadImpact(
  req: SchemeRequirement,
  previous: Map<string, { qty: number; value: number }>,
  incoming: Map<string, { qty: number; value: number }>,
  enrolledDealerIds: string[],
): UploadImpactRow[] {
  const enrolled = new Set(enrolledDealerIds);
  const isValue = req.type === "VALUE_BASED";
  const reqByProduct = new Map(req.products.map((p) => [p.productId, p]));
  const rows: UploadImpactRow[] = [];
  const keys = new Set<string>([...previous.keys(), ...incoming.keys()]);
  for (const key of keys) {
    const [dealerId, productId] = key.split("|");
    if (!enrolled.has(dealerId)) continue;
    const rp = reqByProduct.get(productId);
    if (!rp) continue; // product not required by this scheme
    const prev = previous.get(key) ?? { qty: 0, value: 0 };
    const inc = incoming.get(key) ?? { qty: 0, value: 0 };
    const requiredQty = round3(rp.requiredQty ?? 0);
    const requiredValue = round2(rp.requiredValue ?? 0);
    const previouslyAchievedQty = round3(prev.qty);
    const previouslyAchievedValue = round2(prev.value);
    const newAchievedQty = round3(inc.qty);
    const newAchievedValue = round2(inc.value);
    const totalAchievedQty = round3(previouslyAchievedQty + newAchievedQty);
    const totalAchievedValue = round2(previouslyAchievedValue + newAchievedValue);
    rows.push({
      dealerId, productId,
      requiredQty, requiredValue,
      previouslyAchievedQty, previouslyAchievedValue,
      newAchievedQty, newAchievedValue,
      totalAchievedQty, totalAchievedValue,
      remainingQty: isValue ? 0 : remainingOf(requiredQty, totalAchievedQty, "qty"),
      remainingValue: isValue ? remainingOf(requiredValue, totalAchievedValue, "value") : 0,
      completedBefore: isValue ? valueGte(previouslyAchievedValue, requiredValue) : qtyGte(previouslyAchievedQty, requiredQty),
      completedAfter: isValue ? valueGte(totalAchievedValue, requiredValue) : qtyGte(totalAchievedQty, requiredQty),
    });
  }
  rows.sort((a, b) => a.dealerId.localeCompare(b.dealerId) || a.productId.localeCompare(b.productId));
  return rows;
}
