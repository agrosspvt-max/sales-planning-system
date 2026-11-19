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
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    billReferences: z
      .array(
        z
          .object({
            name: text(512).nullish(),
            type: text(128).nullish(),
            amount: text(128).nullish(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    billReferenceCount: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
export const daybookDiagnosticsSchema = z
  .object({
    stage: text(64),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    companyName: text(256).optional(),
    fromDate: day,
    throughDate: day,
    layoutResponse: z
      .object({
        responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
        responseBytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024),
        localResponseFile: text(1024).optional(),
        captureStatus: z.enum(["saved", "save_failed", "limit_reached"]),
      })
      .strict()
      .optional(),
    encoding: z
      .object({
        expectedEncoding: z.literal("UTF-8"),
        byteOffset: z
          .number()
          .int()
          .min(0)
          .max(8 * 1024 * 1024),
        byteEnd: z
          .number()
          .int()
          .min(0)
          .max(8 * 1024 * 1024),
        responseBytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024),
        decodeReason: text(160),
        invalidBytesHex: text(128),
        contextStart: z
          .number()
          .int()
          .min(0)
          .max(8 * 1024 * 1024),
        contextHex: text(512),
        contextText: text(512),
        responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
        bom: text(32).optional(),
        declaredEncoding: text(64).optional(),
        fieldName: text(128).optional(),
        metadataRecovered: z.boolean(),
        localResponseFile: text(1024).optional(),
        captureStatus: z.enum(["saved", "save_failed", "limit_reached"]).optional(),
        isolationError: text(80).optional(),
      })
      .strict()
      .optional(),
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
        layoutResolution: z.enum(["duplicate", "empty_alternate", "conflicting"]).optional(),
        ledgerLayouts: z
          .array(
            z
              .object({
                source: z.enum(["ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"]),
                entryCount: z.number().int().min(0).max(1_000_000),
                meaningfulEntryCount: z.number().int().min(0).max(1_000_000),
                entries: z.array(ledgerEntry).max(50),
              })
              .strict(),
          )
          .max(2)
          .optional(),
        inventoryEntries: z
          .array(
            z
              .object({
                lineNumber: z.number().int().min(1).max(1_000_000),
                productName: text(512).nullish(),
                actualQty: text(128).nullish(),
                billedQty: text(128).nullish(),
                amount: text(128).nullish(),
                isDeemedPositive: text(64).nullish(),
              })
              .strict(),
          )
          .max(50)
          .optional(),
        inventoryEntryCount: z.number().int().min(0).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DaybookDiagnostics = z.infer<typeof daybookDiagnosticsSchema>;
