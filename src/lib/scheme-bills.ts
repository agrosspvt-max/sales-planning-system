import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  bookingExceedsFinalInstallment,
  computeInstallmentAmounts,
  type InstallmentRuleInput,
} from "./scheme-installments";

const decimal = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((v) => {
    try {
      const n = new Prisma.Decimal(v);
      return n.isFinite() && n.gt(0) && n.lt("1000000000000") && n.decimalPlaces() <= 2;
    } catch {
      return false;
    }
  }, "Enter a positive amount below 10,00,00,00,00,000 with at most two decimal places");
export const billDate = z
  .union([z.date(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid DD/MM/YYYY date")])
  .transform((v, ctx) => {
    const result = v instanceof Date ? v : new Date(v + "T00:00:00.000Z");
    if (
      !Number.isFinite(result.getTime()) ||
      (typeof v === "string" && result.toISOString().slice(0, 10) !== v)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid calendar date" });
      return z.NEVER;
    }
    return result;
  });
const part = z.number().int().min(1).max(5);
export const soPlanBills = z.object({
  billCount: part, amountWithoutGST: decimal, amountWithGST: decimal,
  bills: z.array(z.object({ partNumber: part, soBillDate: billDate, amountWithoutGST: decimal, amountWithGST: decimal })).min(1).max(5),
});
export const adminPlanBills = z.object({
  billCount: part, amountWithoutGST: decimal, amountWithGST: decimal,
  bills: z.array(z.object({ partNumber: part, adminBillDate: billDate.nullable(), amountWithoutGST: decimal, amountWithGST: decimal })).min(1).max(5),
});

/** Shared server/browser split: integer paise, remainder in the highest-numbered bill. */
export function splitBillAmount(value: string | number, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error("Number of bills must be 1–5");
  const total = new Prisma.Decimal(value);
  if (!total.isFinite() || total.lt(0) || total.decimalPlaces() > 2) throw new Error("Enter a valid amount with at most two decimal places");
  const paise = total.times(100);
  const each = paise.div(count).floor();
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? paise.minus(each.times(count - 1)) : each).div(100).toFixed(2));
}
export function assertBillParts(count: number, bills: { partNumber: number }[]) {
  if (
    bills.length !== count ||
    new Set(bills.map((b) => b.partNumber)).size !== count ||
    bills.some((b) => b.partNumber < 1 || b.partNumber > count)
  )
    throw new Error("Provide every declared bill part exactly once");
}
export function assertBillTotals(
  total: { amountWithoutGST: string; amountWithGST: string },
  bills: { amountWithoutGST: string; amountWithGST: string }[],
) {
  for (const key of ["amountWithoutGST", "amountWithGST"] as const) {
    const sum = bills.reduce((n, b) => n.plus(b[key]), new Prisma.Decimal(0));
    if (!sum.equals(new Prisma.Decimal(total[key])))
      throw new Error(
        `Bill totals must equal the Admin-confirmed ${key === "amountWithGST" ? "With GST" : "Without GST"} total`,
      );
  }
}

/** SO conversion guard for the plan-level combined totals. Part-bill distribution is intentionally ignored. */
export function combinedPresetValueErrors(
  total: { amountWithoutGST: string | number; amountWithGST: string | number },
  preset: { amountWithoutGST: string | number; amountWithGST: string | number },
): string[] {
  const errors: string[] = [];
  const currency = (value: Prisma.Decimal) =>
    `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: value.decimalPlaces() > 0 ? 2 : 0, maximumFractionDigits: 2 }).format(value.toNumber())}`;
  for (const [key, label] of [
    ["amountWithoutGST", "Without GST"],
    ["amountWithGST", "With GST"],
  ] as const) {
    try {
      const entered = new Prisma.Decimal(total[key]);
      const minimum = new Prisma.Decimal(preset[key]);
      if (entered.isFinite() && minimum.isFinite() && entered.lt(minimum)) {
        errors.push(`Combined Scheme Value (${label}) cannot be less than the preset scheme value of ${currency(minimum)}.`);
      }
    } catch {
      // The existing bill schema reports malformed/blank amounts; this guard only owns the minimum rule.
    }
  }
  return errors;
}
export function billSchedule(
  rules: (InstallmentRuleInput & { daysAfterBillingDate: number })[],
  total: number,
  date: Date | null,
  booking: number,
  billNumber: number,
  billCount: number,
  preDays: number,
  balanceFixedAmounts = false,
) {
  if (!date || !Number.isFinite(date.getTime()))
    throw new Error("A bill requires an Admin-confirmed date before installments can start");
  if (!rules.length) throw new Error("Configure installment rules before verifying a bill");
  if (
    !Number.isInteger(preDays) ||
    preDays < 0 ||
    rules.some(
      (r) =>
        !Number.isInteger(r.daysAfterBillingDate) ||
        r.daysAfterBillingDate < 0 ||
        !Number.isFinite(r.value) ||
        r.value < 0 ||
        !["PERCENTAGE", "FIXED_AMOUNT"].includes(r.calculationType),
    ) ||
    new Set(rules.map((r) => r.installmentNumber)).size !== rules.length
  )
    throw new Error("Invalid installment rules or pre-placement days");
  const types = new Set(rules.map((r) => r.calculationType));
  const sum = rules.reduce((n, r) => n.plus(r.value), new Prisma.Decimal(0));
  const fixed = rules[0].calculationType === "FIXED_AMOUNT";
  const totalIsValid = fixed && balanceFixedAmounts ? true : sum.equals(fixed ? total : 100);
  if (types.size !== 1 || !totalIsValid)
    throw new Error(
      fixed
        ? "Fixed Amount rules must total this bill's With GST amount; they cannot be prorated"
        : "Installment percentages must total 100%",
    );
  const deduction = billNumber === billCount ? booking : 0;
  if (bookingExceedsFinalInstallment(rules, total, deduction, true))
    throw new Error(
      "The final declared bill's final installment cannot absorb the combined plan booking amount",
    );
  const days = new Map(rules.map((r) => [r.installmentNumber, r.daysAfterBillingDate]));
  return computeInstallmentAmounts(rules, total, deduction, true).map((r) => ({
    installmentNumber: r.installmentNumber,
    plannedAmount: r.plannedAmount,
    plannedDate: new Date(
      date.getTime() + (preDays + (days.get(r.installmentNumber) ?? 0)) * 86400000,
    ),
  }));
}

export interface BillInstanceInfo {
  instanceNumber: number;
  billMode: boolean;
  soBillCount: number | null;
  adminBillCount: number | null;
  amountWithoutGST: number | null;
  amountWithGST: number | null;
  locked: boolean;
  legacySchedule: boolean;
  bills: {
    partNumber: number;
    soBillDate: string | null;
    adminBillDate: string | null;
    amountWithoutGST: number | null;
    amountWithGST: number | null;
    verified: boolean;
  }[];
}

export interface PlanBillInfo {
  billMode: boolean; locked: boolean; legacySchedules: boolean;
  soBillCount: number | null; adminBillCount: number | null;
  soAmountWithoutGST: string | null; soAmountWithGST: string | null;
  amountWithoutGST: string | null; amountWithGST: string | null;
  defaultAmountWithoutGST: string; defaultAmountWithGST: string;
  bookingAmount: string | null; bookingBillNumber: number | null;
  bills: { partNumber: number; soBillDate: string | null; adminBillDate: string | null; soAmountWithoutGST: string | null; soAmountWithGST: string | null; amountWithoutGST: string | null; amountWithGST: string | null; verified: boolean }[];
}
