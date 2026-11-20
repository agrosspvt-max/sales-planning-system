import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { daybookBillAllocationsSchema } from "./daybook-bill-allocations";
import { salesPartyNames } from "./sales-party-names";
import {
  authorizedProductJob,
  productsInJob,
  productJobsAcrossMonths,
  unavailableProducts,
} from "./daybook-product-source.server";
import type { DaybookProductVoucher } from "./daybook-products";
import type { DaybookBillProducts } from "./daybook-bill-products";

const base = z.object({
  jobId: z.string().uuid(),
  voucherGuid: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[a-f0-9]{8}$/i),
});
const input = z.union([
  base.extend({ view: z.literal("voucher") }).strict(),
  base
    .extend({
      ledgerLineNumber: z.coerce.number().int().min(1).max(1_000_000),
      allocationNumber: z.coerce.number().int().min(1).max(1_000_000),
      reference: z.string().min(1).max(512),
    })
    .strict(),
]);
const voucher = z.object({
  guid: z.string(),
  voucherType: z.string(),
  billAllocations: daybookBillAllocationsSchema.optional(),
});
const summary = z.object({
  dealerRows: z.array(z.object({ creditVouchers: z.array(voucher).optional() })).optional(),
  excludedVouchers: z.array(voucher).optional(),
});
function result(
  bill: DaybookProductVoucher,
  observedAt: string,
  own: boolean,
): DaybookBillProducts {
  return {
    status: "matched",
    source: "daybook",
    capturedAt: observedAt,
    ownVoucher: own,
    bill: {
      number: bill.billNumber,
      date: bill.billDate,
      type: bill.typeName,
      partyName: bill.partyName,
      cancelled: bill.cancelled,
      optional: bill.optional,
      items: bill.items.map((item) => ({
        lineNo: item.lineNo,
        productName: item.stockItemName,
        quantity: item.quantity,
        unit: item.unit,
        amount: item.amount,
        actualQty: item.actualQty,
        billedQty: item.billedQty,
      })),
    },
  };
}
export async function getDaybookBillProducts(
  ctx: AuthContext,
  raw: unknown,
): Promise<DaybookBillProducts> {
  const params = input.parse(raw);
  const job = await authorizedProductJob(ctx, params.jobId);
  const saved = summary.safeParse(job.summary);
  if (!saved.success)
    throw new ApiError(409, "This capture has no saved voucher details. Refresh Daybook.");
  const sources = [
    ...(saved.data.dealerRows ?? []).flatMap((row) => row.creditVouchers ?? []),
    ...(saved.data.excludedVouchers ?? []),
  ].filter((row) => row.guid.toLowerCase() === params.voucherGuid.toLowerCase());
  if (sources.length !== 1)
    throw new ApiError(404, "The voucher is not uniquely identified in this capture.");
  const captured = productsInJob(job);
  if ("view" in params) {
    if (!captured || captured.capture.status !== "complete")
      return { status: "missing", message: unavailableProducts(job) };
    const bill = captured.capture.vouchers.find(
      (row) => row.guid.toLowerCase() === params.voucherGuid.toLowerCase(),
    );
    return bill
      ? result(bill, captured.observedAt, true)
      : {
          status: "unlinked",
          message:
            "This voucher has no Sales or Credit Note product record in the Daybook capture.",
        };
  }
  const source = sources[0];
  const allocation = source.billAllocations?.entries.find(
    (entry) =>
      entry.ledgerLineNumber === params.ledgerLineNumber &&
      entry.allocationNumber === params.allocationNumber,
  );
  if (!allocation || allocation.billReference?.trim() !== params.reference.trim())
    throw new ApiError(
      409,
      "This bill reference does not match the saved Daybook voucher. Reload Daybook.",
    );
  if (allocation.referenceType?.trim().toLowerCase() !== "agst ref")
    return {
      status: "unlinked",
      message: "This is not an adjustment against a specific bill. No bill has been linked.",
    };
  if (!/^(?:RECEIPT)$|CREDIT NOTE|SALES RETURN/i.test(source.voucherType))
    return {
      status: "unlinked",
      message: "This voucher is outside the customer receipt/return/credit-note bill lookup.",
    };
  const party = allocation.ledgerName?.trim();
  if (!party)
    return {
      status: "unlinked",
      message: "The allocation has no identified party ledger to match a bill.",
    };
  if (!captured || captured.capture.status !== "complete")
    return { status: "missing", message: unavailableProducts(job) };
  const [dealers, aliases, jobs] = await Promise.all([
    prisma.dealer.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { tallyName: true, systemDealerId: true } }),
    productJobsAcrossMonths(job),
  ]);
  const names = salesPartyNames(dealers, aliases, true),
    owners = names.find((entry) => entry.name === party)?.dealerIds;
  const parties = new Set([party]);
  if (owners?.length === 1)
    for (const entry of names)
      if (entry.dealerIds.length === 1 && entry.dealerIds[0] === owners[0]) parties.add(entry.name);
  const candidates = new Map<string, { bill: DaybookProductVoucher; observedAt: string }>();
  for (const origin of jobs) {
    const data = productsInJob(origin);
    if (!data || data.capture.status !== "complete") continue;
    for (const bill of data.capture.vouchers) {
      if (
        parties.has(bill.partyName) &&
        (bill.billNumber === params.reference.trim() ||
          bill.references.includes(params.reference.trim()))
      )
        candidates.set(JSON.stringify(bill), { bill, observedAt: data.observedAt });
    }
  }
  if (!candidates.size)
    return {
      status: "missing",
      message:
        "No matching bill was found in the saved Daybook product captures. Refresh the invoice month if it is within the configured year. Products are not taken from Sales during this trial.",
    };
  if (candidates.size !== 1)
    return {
      status: "ambiguous",
      message:
        "More than one Daybook bill or version matches this party/reference. No bill has been selected automatically.",
    };
  const match = [...candidates.values()][0];
  return result(match.bill, match.observedAt, false);
}
