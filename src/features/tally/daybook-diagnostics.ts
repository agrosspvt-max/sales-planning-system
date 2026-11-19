import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\x00-\x1f]/.test(value));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ledgerEntry = z
  .object({
    lineNumber: z.number().int().min(1).max(1_000_000),
    ledgerName: text(512).nullish(),
    amount: text(128).nullish(),
    isDeemedPositive: text(64).nullish(),
    isPartyLedger: text(64).nullish(),
  })
  .strict();
export const daybookDiagnosticsSchema = z
  .object({
    stage: text(64),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    companyName: text(256).optional(),
    fromDate: day,
    throughDate: day,
    voucher: z
      .object({
        guid: text(512).nullish(),
        date: text(64).nullish(),
        voucherNumber: text(512).nullish(),
        voucherType: text(512).nullish(),
        dealerName: text(512).nullish(),
        masterId: text(512).nullish(),
        alterId: text(512).nullish(),
        narration: text(2048).nullish(),
        cancelled: text(64).nullish(),
        optional: text(64).nullish(),
        lineNumber: z.number().int().min(1).max(1_000_000).optional(),
        ledgerName: text(512).nullish(),
        amount: text(128).nullish(),
        isDeemedPositive: text(64).nullish(),
        isPartyLedger: text(64).nullish(),
        ledgerEntries: z.array(ledgerEntry).max(50),
        ledgerEntryCount: z.number().int().min(0).max(1_000_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DaybookDiagnostics = z.infer<typeof daybookDiagnosticsSchema>;
