import { z } from "zod";
import { salesVoucher } from "./sales";

const name = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim() === s && !/[\x00-\x1f]/.test(s));
export const daybookProductVoucher = salesVoucher
  .extend({ references: z.array(name).max(10000) })
  .strict();
export const daybookProductCapture = z.discriminatedUnion("status", [
  z
    .object({
      version: z.literal("daybook.products.v1"),
      status: z.literal("complete"),
      voucherTypes: z
        .array(z.object({ typeName: name, family: z.enum(["Sales", "Credit Note"]) }).strict())
        .max(2000),
      vouchers: z.array(daybookProductVoucher).max(10000),
    })
    .strict(),
  z
    .object({
      version: z.literal("daybook.products.v1"),
      status: z.literal("unavailable"),
      error: z.string().regex(/^[A-Z_]{1,80}$/),
    })
    .strict(),
]);
export const savedDaybookProducts = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    capture: daybookProductCapture,
  })
  .strict();
export type DaybookProductCapture = z.infer<typeof daybookProductCapture>;
export type DaybookProductVoucher = z.infer<typeof daybookProductVoucher>;

type Source = {
  guid: string;
  date: string;
  voucherType: string;
  voucherNumber: string;
  excluded?: string;
  creditAmount?: string;
};
export function validateProductEvidence(
  capture: DaybookProductCapture | undefined,
  sources: Source[],
  prefix: string,
) {
  if (!capture || capture.status !== "complete") return;
  const families = new Map<string, string>();
  for (const type of capture.voucherTypes) {
    if (families.has(type.typeName)) throw new Error("Duplicate Daybook product voucher type");
    families.set(type.typeName, type.family);
  }
  if (!new Set(families.values()).has("Sales") || !new Set(families.values()).has("Credit Note"))
    throw new Error("Daybook product voucher families are incomplete");
  const sourceById = new Map(sources.map((row) => [row.guid.toLowerCase(), row]));
  const seen = new Set<string>();
  let items = 0;
  for (const bill of capture.vouchers) {
    const key = bill.guid.toLowerCase(),
      source = sourceById.get(key);
    if (
      seen.has(key) ||
      !key.startsWith(prefix + "-") ||
      !source ||
      source.date !== bill.billDate ||
      source.voucherType !== bill.typeName ||
      source.voucherNumber !== bill.billNumber ||
      families.get(bill.typeName) !== bill.family
    )
      throw new Error("Daybook product evidence does not match the captured voucher");
    seen.add(key);
    if (
      (source.creditAmount && (bill.cancelled || bill.optional)) ||
      (source.excluded === "cancelled" && !bill.cancelled) ||
      (source.excluded === "optional" && (!bill.optional || bill.cancelled))
    )
      throw new Error("Daybook product flags do not match the captured voucher");
    const lines = new Set<number>();
    for (const item of bill.items) {
      if (
        lines.has(item.lineNo) ||
        (bill.family === "Sales" && (+item.quantity < 0 || +item.amount < 0)) ||
        (bill.family === "Credit Note" && (+item.quantity > 0 || +item.amount > 0)) ||
        (+item.quantity !== 0 && !item.unit)
      )
        throw new Error("Invalid Daybook product line");
      lines.add(item.lineNo);
      items++;
    }
  }
  if (
    items > 50000 ||
    sources.some((row) => families.has(row.voucherType) && !seen.has(row.guid.toLowerCase()))
  )
    throw new Error("Daybook product capture is incomplete or oversized");
}
