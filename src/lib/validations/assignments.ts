import { z } from "zod";

export const dealerAssignmentSchema = z.object({
  dealerId: z.string().min(1, "Dealer is required"),
  officerId: z.string().min(1, "Sales Officer is required"),
  effectiveFrom: z.coerce.date(),
});

export const rmAssignmentSchema = z.object({
  officerId: z.string().min(1, "Sales Officer is required"),
  managerId: z.string().min(1, "Regional Manager is required"),
  effectiveFrom: z.coerce.date(),
});

const planningModeEnum = z.enum(["PACK_SIZE", "TOTAL_QUANTITY", "AMOUNT", "NBV"]);
const monthNumber = z.coerce.number().int().min(1).max(12);
const seasonYear = z.coerce.number().int().min(2000).max(2100);

/**
 * Period-based season input. The admin picks a name + Start/End month & year; the
 * SeasonMonth rows are generated automatically (no free-text month entry). Planning
 * modes are optional (prefilled from the global default when omitted).
 */
export const seasonSchema = z.object({
  name: z.string().min(1, "Name is required"),
  startMonth: monthNumber,
  startYear: seasonYear,
  endMonth: monthNumber,
  endYear: seasonYear,
  seasonalMode: planningModeEnum.optional(),
  monthlyMode: planningModeEnum.optional(),
});

export type DealerAssignmentInput = z.infer<typeof dealerAssignmentSchema>;
export type RmAssignmentInput = z.infer<typeof rmAssignmentSchema>;
export type SeasonInput = z.infer<typeof seasonSchema>;
