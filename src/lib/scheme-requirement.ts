/**
 * Scheme Achievement Requirement — PURE validation + normalization (no DB, no `server-only`).
 *
 * ONE authoritative definition of the valid requirement-type/value-mode combinations, shared by the
 * Scheme Master server (Zod superRefine + persistence) and the client form, and unit-tested directly.
 * It NEVER touches SchemeSale/achievement — it only shapes and validates the requirement DEFINITION.
 *
 * Approved combinations:
 *   NONE                     → no products, valueMode null, combinedRequiredValue null (installment-only).
 *   PRODUCT_BASED            → ≥1 product, each requiredQty > 0, requiredValue null, no duplicates.
 *   VALUE_BASED + INDIVIDUAL → ≥1 product, each requiredValue > 0, requiredQty null, no duplicates.
 *   VALUE_BASED + COMBINED   → ≥1 product (participating only, both null), combinedRequiredValue > 0.
 */

export type SchemeRequirementType = "NONE" | "PRODUCT_BASED" | "VALUE_BASED";
export type SchemeValueMode = "INDIVIDUAL" | "COMBINED";

export interface RequirementProductInput {
  productId: string;
  requiredQty?: number | null;
  requiredValue?: number | null;
}
export interface SchemeRequirementInput {
  requirementType: SchemeRequirementType;
  valueMode?: SchemeValueMode | null;
  combinedRequiredValue?: number | null;
  products?: RequirementProductInput[];
}

export interface NormalizedRequirementProduct {
  productId: string;
  requiredQty: number | null;
  requiredValue: number | null;
}
export interface NormalizedSchemeRequirement {
  requirementType: SchemeRequirementType;
  valueMode: SchemeValueMode | null;
  combinedRequiredValue: number | null;
  products: NormalizedRequirementProduct[];
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Duplicate product ids present in the list. */
function duplicateProductIds(products: RequirementProductInput[]): boolean {
  const seen = new Set<string>();
  for (const p of products) {
    if (seen.has(p.productId)) return true;
    seen.add(p.productId);
  }
  return false;
}

/**
 * Validate a requirement configuration. Returns a list of human-readable error messages (empty = valid).
 * Every invalid/ambiguous combination is rejected here, so both the client and the server (superRefine)
 * enforce identical rules — the server never trusts the client.
 */
export function validateSchemeRequirement(input: SchemeRequirementInput): string[] {
  const errors: string[] = [];
  const type = input.requirementType;
  const products = input.products ?? [];
  const combined = num(input.combinedRequiredValue);

  if (type === "NONE") {
    if (products.length > 0) errors.push("A 'None' requirement cannot have any products.");
    if (input.valueMode != null) errors.push("A 'None' requirement cannot have a value mode.");
    if (combined != null) errors.push("A 'None' requirement cannot have a combined required value.");
    return errors;
  }

  if (type === "PRODUCT_BASED") {
    if (input.valueMode != null) errors.push("A Product Based requirement cannot have a value mode.");
    if (combined != null) errors.push("A Product Based requirement cannot have a combined required value.");
    if (products.length === 0) errors.push("Add at least one required product.");
    if (duplicateProductIds(products)) errors.push("The same product cannot be added twice.");
    for (const p of products) {
      const qty = num(p.requiredQty);
      if (qty == null || qty <= 0) errors.push("Every product needs a required quantity greater than zero.");
      if (num(p.requiredValue) != null) errors.push("A Product Based requirement must not set a required value.");
    }
    return errors;
  }

  // VALUE_BASED
  const mode = input.valueMode;
  if (mode !== "INDIVIDUAL" && mode !== "COMBINED") {
    errors.push("Select a value mode (Individual or Combined).");
    return errors; // can't validate further without a mode
  }
  if (products.length === 0) errors.push("Add at least one product.");
  if (duplicateProductIds(products)) errors.push("The same product cannot be added twice.");

  if (mode === "INDIVIDUAL") {
    if (combined != null) errors.push("Individual value requirements cannot have a combined required value.");
    for (const p of products) {
      const val = num(p.requiredValue);
      if (val == null || val <= 0) errors.push("Every product needs a required value greater than zero.");
      if (num(p.requiredQty) != null) errors.push("A Value Based requirement must not set a required quantity.");
    }
  } else {
    // COMBINED
    if (combined == null || combined <= 0) errors.push("Enter a combined required value greater than zero.");
    for (const p of products) {
      if (num(p.requiredValue) != null) errors.push("Combined mode must not set per-product required values.");
      if (num(p.requiredQty) != null) errors.push("A Value Based requirement must not set a required quantity.");
    }
  }
  return errors;
}

/**
 * Canonical persisted shape for a requirement. Assumes the input has already passed
 * `validateSchemeRequirement`; it strips fields that must be null for the chosen type so the DB never
 * stores an ambiguous mix (e.g. a requiredValue on a Product Based row).
 */
export function normalizeSchemeRequirement(input: SchemeRequirementInput): NormalizedSchemeRequirement {
  const products = input.products ?? [];
  if (input.requirementType === "PRODUCT_BASED") {
    return {
      requirementType: "PRODUCT_BASED",
      valueMode: null,
      combinedRequiredValue: null,
      products: products.map((p) => ({ productId: p.productId, requiredQty: num(p.requiredQty), requiredValue: null })),
    };
  }
  if (input.requirementType === "VALUE_BASED") {
    const mode: SchemeValueMode = input.valueMode === "COMBINED" ? "COMBINED" : "INDIVIDUAL";
    if (mode === "COMBINED") {
      return {
        requirementType: "VALUE_BASED",
        valueMode: "COMBINED",
        combinedRequiredValue: num(input.combinedRequiredValue),
        products: products.map((p) => ({ productId: p.productId, requiredQty: null, requiredValue: null })),
      };
    }
    return {
      requirementType: "VALUE_BASED",
      valueMode: "INDIVIDUAL",
      combinedRequiredValue: null,
      products: products.map((p) => ({ productId: p.productId, requiredQty: null, requiredValue: num(p.requiredValue) })),
    };
  }
  // NONE
  return { requirementType: "NONE", valueMode: null, combinedRequiredValue: null, products: [] };
}
