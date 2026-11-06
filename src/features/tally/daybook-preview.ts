import { z } from "zod";
import { cents, decimal } from "./billwise";
import { salesPeriod } from "./sales";

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
const voucher = z.object({
  guid: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-[0-9a-f]{8}$/i),
  date: day,
  voucherNumber: name,
  voucherType: name,
  category: z.enum(["receipt", "srCr"]),
});
const included = voucher
  .extend({
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
  vouchers: z
    .array(
      z.union([
        included,
        voucher.extend({ excluded: z.enum(["cancelled", "optional"]) }).strict(),
        voucher
          .extend({
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
  }[] = [];
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
    if ("review" in row) {
      review.push({
        guid: id,
        date: row.date,
        voucherNumber: row.voucherNumber,
        voucherType: row.voucherType,
        reason: row.review,
      });
    } else if ("creditAmount" in row) {
      const type = row.voucherType.toUpperCase();
      if (row.category === "receipt" ? type !== "RECEIPT" : !/SALES RETURN|CREDIT NOTE/.test(type))
        throw new Error("A captured voucher has an unexpected Day Book type.");
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
    excluded: ids.size - credits.length - review.length,
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
