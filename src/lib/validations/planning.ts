import { z } from "zod";
import { canonicalSeasonName } from "@/lib/season-name";

const qty = z.coerce.number().int().min(0, "Quantity cannot be negative"); // V1, V2, V30
const nonNegative = z.coerce.number().min(0, "Value cannot be negative");

/** Planning Configuration modes (kept in sync with lib/calc PlanningMode). */
export const planningModeSchema = z.enum(["PACK_SIZE", "TOTAL_QUANTITY", "AMOUNT", "NBV"]);

export const packQtySchema = z.object({
  packSizeId: z.string().min(1),
  quantity: qty,
});

/**
 * A seasonal line update. Backward compatible: with only `packs` it behaves exactly
 * as before (PACK_SIZE). For the other modes the client sends `mode` + a single
 * `value` (quantity for TOTAL_QUANTITY; amount/nbv for AMOUNT/NBV).
 */
export const lineUpdateSchema = z.object({
  dealerId: z.string().min(1),
  productId: z.string().min(1),
  mode: planningModeSchema.optional(),
  packs: z.array(packQtySchema).optional().default([]),
  value: nonNegative.optional(),
});

export const saveLinesSchema = z.object({
  lines: z.array(lineUpdateSchema),
});

export const planningTypeSchema = z.enum(["SEASONAL", "MONTHLY", "YEARLY"]);

export const createPlanSchema = z.object({
  seasonId: z.string().min(1),
  planningType: planningTypeSchema.default("SEASONAL"),
  // Only used by Super Admin (creating on behalf of an officer). Officers plan for themselves.
  officerId: z.string().optional(),
  versionName: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
});

/**
 * Simplified Seasonal create (Phase 3): the business form gives Season name + Year + period
 * (not a seasonId). The season is resolved via findOrCreateSeason. Admins may target a
 * single officer, several officers, or all active Sales Officers; officers plan for
 * themselves (officer fields ignored server-side).
 */
export const createSeasonalPlanSchema = z.object({
  season: z.object({
    name: z.string().trim().min(1).transform(canonicalSeasonName),
    year: z.coerce.number().int().min(2000).max(2100),
    startMonth: z.coerce.number().int().min(1).max(12),
    endMonth: z.coerce.number().int().min(1).max(12),
  }),
  officerScope: z.enum(["single", "multiple", "all"]).optional(),
  officerIds: z.array(z.string().min(1)).optional(),
});

export const remarksSchema = z.object({
  remarks: z.string().min(1, "Remarks are required"), // V14
});

export const revisionRequestSchema = z.object({
  reason: z.string().min(1, "A reason is required"),
});

export const monthlyUpdateSchema = z.object({
  planLineId: z.string().min(1),
  seasonMonthId: z.string().min(1),
  // Quantity modes (PACK_SIZE / TOTAL_QUANTITY) send planQty/saleQty (integers).
  planQty: qty.optional(),
  saleQty: qty.optional(),
  // Value modes (AMOUNT / NBV) send mode + planValue/saleValue (decimals).
  mode: planningModeSchema.optional(),
  planValue: nonNegative.optional(),
  saleValue: nonNegative.optional(),
});

export const saveMonthlySchema = z.object({
  entries: z.array(monthlyUpdateSchema),
});

export type LineUpdate = z.infer<typeof lineUpdateSchema>;
export type MonthlyUpdate = z.infer<typeof monthlyUpdateSchema>;
