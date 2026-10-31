import { z } from "zod";
import { createHash } from "node:crypto";
export const hashSales = (value: string) => createHash("sha256").update(value).digest("hex");
const text = z
  .string()
  .max(256)
  .refine((s) => !/[\x00-\x1f]/.test(s) && !s.includes("[TALLY_CONTROL_"));
const required = text.refine((s) => s.trim().length > 0 && s.trim() === s);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s);
const guid = z
  .string()
  .regex(/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}-[a-fA-F0-9]{8}$/);
const amount = z.string().regex(/^-?\d{1,12}\.\d{2}$/);
const qty = z.string().regex(/^-?\d{1,12}\.\d{6}$/);
export const salesItem = z
  .object({
    lineNo: z.number().int().min(0).max(10000),
    stockItemName: required,
    quantity: qty,
    amount,
    unit: text,
    actualQty: text,
    billedQty: text,
    rate: text,
  })
  .strict();
export const salesVoucher = z
  .object({
    guid,
    masterId: z.string().regex(/^\d{1,16}$/),
    alterId: z.string().regex(/^\d{1,16}$/),
    billDate: date,
    billNumber: text,
    typeName: required,
    family: z.enum(["Sales", "Credit Note"]),
    partyName: text,
    cancelled: z.boolean(),
    optional: z.boolean(),
    items: z.array(salesItem).max(10000),
    ledgerEntries: z.array(z.object({ name: required, amount }).strict()).max(1000),
  })
  .strict();
export const salesResult = z
  .object({
    version: z.literal("sales.sync.v1"),
    companyName: required,
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
    fromDate: date,
    throughDate: date,
    observedAt: z.string().datetime({ offset: true }),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    controlMarkerCount: z.number().int().min(0).max(1000000),
    anchorGuid: guid,
    ledgers: z.array(z.object({ name: required, guid }).strict()).max(2000),
    vouchers: z.array(salesVoucher).max(30000),
  })
  .strict();
export type SalesResult = z.infer<typeof salesResult>;
export function salesPeriod(monthKey: string, today: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey) || monthKey > today.slice(0, 7))
    throw new Error("INVALID_SALES_MONTH");
  const fromDate = monthKey + "-01";
  const throughDate =
    monthKey === today.slice(0, 7)
      ? today
      : new Date(Date.UTC(+monthKey.slice(0, 4), +monthKey.slice(5, 7), 0))
          .toISOString()
          .slice(0, 10);
  if (fromDate < "2026-04-01" || throughDate > "2027-03-31")
    throw new Error("SALES_MONTH_OUTSIDE_APPROVED_YEAR");
  return { monthKey, fromDate, throughDate };
}
export function validateSales(
  raw: unknown,
  job: {
    companyName: string;
    anchorGuid: string;
    monthKey: string;
    fromDate: string;
    throughDate: string;
    createdAt: Date;
  },
  now = new Date(),
) {
  const r = salesResult.parse(raw);
  for (const k of ["companyName", "anchorGuid", "monthKey", "fromDate", "throughDate"] as const)
    if (r[k] !== job[k]) throw new Error("SALES_CONTEXT_MISMATCH");
  const observed = Date.parse(r.observedAt);
  if (observed < +job.createdAt - 120000 || observed > +now + 120000)
    throw new Error("SALES_OBSERVATION_STALE");
  const seen = new Set<string>(),
    prefix = job.anchorGuid.slice(0, 36).toLowerCase();
  for (const v of r.vouchers) {
    if (v.guid.slice(0, 36).toLowerCase() !== prefix || seen.has(v.guid.toLowerCase()))
      throw new Error("SALES_VOUCHER_IDENTITY");
    seen.add(v.guid.toLowerCase());
    if (v.billDate < job.fromDate || v.billDate > job.throughDate)
      throw new Error("SALES_DATE_OUTSIDE_REQUEST");
    if (!v.cancelled && !v.partyName.trim()) throw new Error("SALES_PARTY_MISSING");
    const lines = new Set<number>();
    for (const i of v.items) {
      if (lines.has(i.lineNo)) throw new Error("SALES_DUPLICATE_LINE");
      lines.add(i.lineNo);
      if (
        (v.family === "Sales" && (+i.quantity < 0 || +i.amount < 0)) ||
        (v.family === "Credit Note" && (+i.quantity > 0 || +i.amount > 0))
      )
        throw new Error("SALES_SIGN_INVALID");
      if (+i.quantity !== 0 && !i.unit) throw new Error("SALES_UNIT_MISSING");
    }
  }
  const names = new Set<string>(),
    ids = new Set<string>();
  for (const l of r.ledgers) {
    if (
      l.guid.slice(0, 36).toLowerCase() !== prefix ||
      names.has(l.name) ||
      ids.has(l.guid.toLowerCase())
    )
      throw new Error("SALES_LEDGER_IDENTITY");
    names.add(l.name);
    ids.add(l.guid.toLowerCase());
  }
  return r;
}
