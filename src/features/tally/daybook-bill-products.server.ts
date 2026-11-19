import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertDaybookEnabled } from "./daybook.server";
import { assertSuper } from "./service.server";
import { daybookBillAllocationsSchema } from "./daybook-bill-allocations";
import { salesPartyNames } from "./sales-party-names";
import type { DaybookBillProducts } from "./daybook-bill-products";

const input = z
  .object({
    jobId: z.string().uuid(),
    voucherGuid: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[a-f0-9]{8}$/i),
    ledgerLineNumber: z.coerce.number().int().min(1).max(1_000_000),
    allocationNumber: z.coerce.number().int().min(1).max(1_000_000),
    reference: z.string().min(1).max(512),
  })
  .strict();
const voucher = z.object({
  guid: z.string(),
  voucherType: z.string(),
  billAllocations: daybookBillAllocationsSchema.optional(),
});
const summary = z.object({
  dealerRows: z.array(z.object({ creditVouchers: z.array(voucher).optional() })).optional(),
  excludedVouchers: z.array(voucher).optional(),
});

export async function getDaybookBillProducts(
  ctx: AuthContext,
  raw: unknown,
): Promise<DaybookBillProducts> {
  assertDaybookEnabled();
  assertSuper(ctx);
  const params = input.parse(raw);
  // Resolve the reference from a saved authorized capture, never from a client-supplied party.
  const job = await prisma.tallyDaybookJob.findFirst({
    where: { id: params.jobId, status: "SUCCEEDED", connection: { enabled: true } },
    select: { connectionId: true, summary: true },
  });
  if (!job)
    throw new ApiError(404, "This published Daybook capture is unavailable. Reload Daybook.");
  const saved = summary.safeParse(job.summary);
  if (!saved.success)
    throw new ApiError(409, "This capture has no saved voucher details. Refresh Daybook.");
  const sources = [
    ...(saved.data.dealerRows ?? []).flatMap((row) => row.creditVouchers ?? []),
    ...(saved.data.excludedVouchers ?? []),
  ].filter((row) => row.guid.toLowerCase() === params.voucherGuid.toLowerCase());
  if (sources.length !== 1)
    throw new ApiError(404, "The voucher is not uniquely identified in this capture.");
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
      message: "This is not an adjustment against a specific bill. No sales bill has been linked.",
    };
  if (!/^(?:RECEIPT)$|CREDIT NOTE|SALES RETURN/i.test(source.voucherType))
    return {
      status: "unlinked",
      message:
        "This voucher is outside the receipt/SR/CR lookup. Supplier purchase bills are not part of the saved Territory sales bills.",
    };
  const party = allocation.ledgerName?.trim();
  if (!party)
    return {
      status: "unlinked",
      message: "The allocation has no identified party ledger to match a bill.",
    };
  const [dealers, aliases] = await Promise.all([
    prisma.dealer.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { tallyName: true, systemDealerId: true } }),
  ]);
  const names = salesPartyNames(dealers, aliases, true);
  const owners = names.find((entry) => entry.name === party)?.dealerIds;
  const parties = new Set([party]);
  if (owners?.length === 1) {
    for (const entry of names)
      if (entry.dealerIds.length === 1 && entry.dealerIds[0] === owners[0]) parties.add(entry.name);
  }
  // Search every saved month: payment month and invoice month need not match.
  // Preserve exact punctuation/case of reference numbers; never match by amount.
  const candidates = await prisma.tallySalesVoucher.findMany({
    where: {
      snapshot: { connectionId: job.connectionId },
      partyName: { in: [...parties] },
      billNumber: params.reference.trim(),
    },
    take: 21,
    orderBy: [{ billDate: "desc" }, { guid: "asc" }],
    select: {
      guid: true,
      billDate: true,
      billNumber: true,
      typeName: true,
      family: true,
      partyName: true,
      cancelled: true,
      optional: true,
      items: {
        orderBy: { lineNo: "asc" },
        select: { lineNo: true, stockItemName: true, quantity: true, unit: true, amount: true },
      },
    },
  });
  if (!candidates.length)
    return {
      status: "missing",
      message:
        "No saved sales bill matches this party and reference. The bill may belong to an older year or may not have been captured yet.",
    };
  const versions = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) versions.set(JSON.stringify(candidate), candidate);
  if (candidates.length > 20 || versions.size !== 1)
    return {
      status: "ambiguous",
      message:
        "More than one saved bill or version matches this party and reference. Products are not selected automatically.",
    };
  const bill = [...versions.values()][0];
  return {
    status: "matched",
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
        quantity: item.quantity.toFixed(6),
        unit: item.unit,
        amount: item.amount.toFixed(2),
      })),
    },
  };
}
