import { z } from "zod";
import { cents, decimal } from "./billwise";
import { salesPeriod } from "./sales";
import { daybookDiagnosticsSchema, type DaybookDiagnostics } from "./daybook-diagnostics";

export const DAYBOOK_PREVIEW_BYTES = 2 * 1024 * 1024;
const name = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !/[\x00-\x1f]|\[TALLY_CONTROL_/.test(value));
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  );
const displayEvidence = {
  ledgerName: name.optional(),
  amount: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/)
    .optional(),
  direction: z.enum(["debit", "credit", "zero"]).optional(),
};
const voucher = z.object({
  guid: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-[0-9a-f]{8}$/i),
  date: day,
  voucherNumber: name.or(z.literal("")),
  voucherType: name,
  category: z.enum(["receipt", "srCr", "other"]),
});
const included = voucher
  .extend({
    category: z.enum(["receipt", "srCr"]),
    ledgerName: name,
    creditAmount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/)
      .refine((value) => /[1-9]/.test(value)),
    creditSelection: z.enum(["named_party", "only_credit"]),
  })
  .strict();
const capture = z.object({
  version: z.literal("daybook.capture.v1"),
  companyName: name,
  month: z.string(),
  fromDate: day,
  throughDate: day,
  observedAt: z.string().datetime({ offset: true }),
  uploaded: z.literal(false),
  coverage: z.literal("all_vouchers").optional(),
  vouchers: z
    .array(
      z.union([
        included,
        voucher
          .extend({
            excluded: z.enum(["cancelled", "optional", "unsupported_type"]),
            ...displayEvidence,
            details: daybookDiagnosticsSchema.optional(),
          })
          .strict(),
        voucher
          .extend({
            ...displayEvidence,
            details: daybookDiagnosticsSchema.optional(),
            review: z.enum([
              "CREDIT_AMBIGUOUS",
              "CREDIT_MISSING",
              "VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE",
            ]),
          })
          .strict(),
      ]),
    )
    .max(10_000),
});

export type DaybookCredit = z.infer<typeof included>;

export function validateDaybookCapture(
  raw: unknown,
  company: { companyName: string; anchorGuid: string },
  today: string,
) {
  // Derive every preview figure from vouchers. The diagnostic's totals are informational.
  const data = capture.parse(raw);
  const period = salesPeriod(data.month, today);
  if (
    data.companyName !== company.companyName ||
    data.fromDate !== period.fromDate ||
    data.throughDate < data.fromDate ||
    data.throughDate > period.throughDate
  )
    throw new Error("The capture company or dates do not match the test connector scope.");
  const prefix = company.anchorGuid.toLowerCase().slice(0, 36);
  const ids = new Set<string>();
  const credits: DaybookCredit[] = [];
  const review: {
    guid: string;
    date: string;
    voucherNumber: string;
    voucherType: string;
    reason: string;
    details?: DaybookDiagnostics;
    ledgerName?: string;
    amount?: string;
    direction?: "debit" | "credit" | "zero";
  }[] = [];
  const excludedVouchers: (typeof review)[number][] = [];
  for (const row of data.vouchers) {
    const id = row.guid.toLowerCase();
    if (
      ids.has(id) ||
      !id.startsWith(prefix + "-") ||
      row.date < data.fromDate ||
      row.date > data.throughDate
    )
      throw new Error(
        "The capture has a duplicate voucher or a voucher outside its company or date range.",
      );
    ids.add(id);
    const type = row.voucherType.toUpperCase();
    const knownType = type === "RECEIPT" || /SALES RETURN|CREDIT NOTE/.test(type);
    const supported =
      row.category === "receipt"
        ? type === "RECEIPT"
        : row.category === "srCr" && /SALES RETURN|CREDIT NOTE/.test(type);
    if (
      "details" in row &&
      row.details &&
      (row.details.month !== data.month ||
        (row.details.companyName !== undefined && row.details.companyName !== data.companyName) ||
        row.details.fromDate < data.fromDate ||
        row.details.throughDate > data.throughDate ||
        row.details.fromDate > row.details.throughDate ||
        (row.details.voucher?.guid != null && row.details.voucher.guid.toLowerCase() !== id) ||
        (row.details.voucher?.date != null && row.details.voucher.date !== row.date))
    )
      throw new Error("Voucher details are outside the capture scope.");
    if ("review" in row) {
      // Older connectors report out-of-scope derived types (e.g. Cheque Return) as
      // review items. Match the manual importer: exclude these, but retain credit holds.
      const destination =
        row.review === "VOUCHER_TYPE_NOT_IN_DAYBOOK_RULE" && !knownType ? excludedVouchers : review;
      destination.push({
        guid: id,
        date: row.date,
        voucherNumber: row.voucherNumber,
        voucherType: row.voucherType,
        reason: row.review,
        ...(row.details ? { details: row.details } : {}),
        ...(row.ledgerName ? { ledgerName: row.ledgerName } : {}),
        ...(row.amount !== undefined ? { amount: row.amount } : {}),
        ...(row.direction ? { direction: row.direction } : {}),
      });
    } else if ("excluded" in row) {
      if (row.excluded === "unsupported_type" && knownType)
        throw new Error("A supported Daybook voucher cannot be excluded as another type.");
      excludedVouchers.push({
        guid: id,
        date: row.date,
        voucherNumber: row.voucherNumber,
        voucherType: row.voucherType,
        reason: row.excluded,
        ...(row.details ? { details: row.details } : {}),
        ...(row.ledgerName ? { ledgerName: row.ledgerName } : {}),
        ...(row.amount !== undefined ? { amount: row.amount } : {}),
        ...(row.direction ? { direction: row.direction } : {}),
      });
    } else if ("creditAmount" in row) {
      if (!supported) throw new Error("A captured voucher has an unexpected Day Book type.");
      credits.push(row);
    }
  }
  return {
    month: data.month,
    throughDate: data.throughDate,
    observedAt: data.observedAt,
    completeMonth: data.throughDate === period.throughDate,
    credits,
    review,
    coverage: data.coverage ?? "receipt_credit_families",
    excluded: excludedVouchers.length,
    excludedVouchers,
  };
}

export function creditTotals(credits: DaybookCredit[]) {
  let receipts = 0n,
    srCr = 0n,
    receiptCount = 0;
  let latestReceiptDay: string | null = null;
  let latestReceiptAmount = 0n;
  for (const credit of credits) {
    const amount = cents(credit.creditAmount);
    if (credit.category === "srCr") {
      srCr += amount;
      continue;
    }
    receipts += amount;
    receiptCount++;
    if (!latestReceiptDay || credit.date > latestReceiptDay) {
      latestReceiptDay = credit.date;
      latestReceiptAmount = amount;
    } else if (credit.date === latestReceiptDay) {
      latestReceiptAmount += amount;
    }
  }
  return {
    receiptCount,
    srCrCount: credits.length - receiptCount,
    liveRecovery: decimal(receipts),
    srCr: decimal(srCr),
    latestReceipt: latestReceiptDay
      ? { date: latestReceiptDay, amount: decimal(latestReceiptAmount) }
      : null,
  };
}
