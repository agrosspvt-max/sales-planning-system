import { z } from "zod";

const sourceText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\x00-\x1f]/.test(v));
export const daybookBillAllocationsSchema = z
  .object({
    scope: z.enum(["selected_credit", "voucher_ledgers"]),
    entries: z
      .array(
        z
          .object({
            ledgerLineNumber: z.number().int().min(1).max(1_000_000),
            allocationNumber: z.number().int().min(1).max(1_000_000),
            ledgerName: sourceText(512).nullish(),
            billReference: sourceText(512).nullish(),
            referenceType: sourceText(128).nullish(),
            amount: sourceText(128).nullish(),
          })
          .strict(),
      )
      .max(500),
    entryCount: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.entries.length !== Math.min(value.entryCount, 500))
      ctx.addIssue({
        code: "custom",
        message: "Bill allocation count does not match the captured rows.",
      });
    const ids = new Set<string>();
    for (const entry of value.entries) {
      const key = `${entry.ledgerLineNumber}:${entry.allocationNumber}`;
      if (ids.has(key))
        ctx.addIssue({ code: "custom", message: "Duplicate bill allocation source line." });
      ids.add(key);
    }
  });
export type DaybookBillAllocations = z.infer<typeof daybookBillAllocationsSchema>;
