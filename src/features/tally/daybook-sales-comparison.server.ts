import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import {
  authorizedProductJob,
  productsInJob,
  unavailableProducts,
} from "./daybook-product-source.server";
import type { DaybookProductVoucher } from "./daybook-products";
import type { DaybookSalesComparison, ComparisonBill } from "./daybook-sales-comparison";

type Bill = Omit<DaybookProductVoucher, "references">;
const whitespace = (text: string) => text.trim().replace(/\s+/g, " ");
function signature(bill: Bill) {
  return JSON.stringify({
    date: bill.billDate,
    number: bill.billNumber,
    party: bill.partyName,
    type: bill.typeName,
    family: bill.family,
    cancelled: bill.cancelled,
    optional: bill.optional,
    ledgerEntries: bill.ledgerEntries
      .map((entry) => JSON.stringify([entry.name, entry.amount]))
      .sort(),
    // Keep duplicate lines; only their display order and whitespace may differ.
    items: bill.items
      .map((item) =>
        JSON.stringify([
          item.stockItemName,
          item.quantity,
          item.unit,
          item.amount,
          whitespace(item.actualQty),
          whitespace(item.billedQty),
          whitespace(item.rate),
        ]),
      )
      .sort(),
  });
}
function display(bill: Bill): ComparisonBill {
  return {
    number: bill.billNumber,
    date: bill.billDate,
    party: bill.partyName,
    type: bill.typeName,
    cancelled: bill.cancelled,
    optional: bill.optional,
    ledgerEntries: bill.ledgerEntries,
    itemCount: bill.items.length,
    items: bill.items.slice(0, 100).map((item) => ({
      productName: item.stockItemName,
      quantity: item.quantity,
      unit: item.unit,
      amount: item.amount,
      actualQty: item.actualQty,
      billedQty: item.billedQty,
      rate: item.rate,
    })),
  };
}
export async function compareDaybookSales(
  ctx: AuthContext,
  rawJobId: unknown,
): Promise<DaybookSalesComparison> {
  const job = await authorizedProductJob(ctx, z.string().uuid().parse(rawJobId));
  const evidence = productsInJob(job);
  const base = {
    fromDate: job.fromDate,
    throughDate: job.throughDate,
    ...(evidence ? { daybookCapturedAt: evidence.observedAt } : {}),
  };
  if (!evidence || evidence.capture.status !== "complete")
    return { ...base, status: "unavailable", message: unavailableProducts(job) };
  const snapshot = await prisma.tallySalesSnapshot.findUnique({
    where: { connectionId_monthKey: { connectionId: job.connectionId, monthKey: job.monthKey } },
    select: { id: true, fromDate: true, throughDate: true, observedAt: true },
  });
  if (!snapshot)
    return {
      ...base,
      status: "unavailable",
      message:
        "No saved Sales capture exists for this month. Refresh Sales separately to make a comparison.",
    };
  const dates = {
    ...base,
    salesCapturedAt: snapshot.observedAt.toISOString(),
    salesThroughDate: snapshot.throughDate,
  };
  if (snapshot.fromDate !== job.fromDate || snapshot.throughDate !== job.throughDate)
    return {
      ...dates,
      status: "period_mismatch",
      message:
        "The saved captures cover different date ranges. Refresh both for the same period before comparing.",
    };
  const saved = await prisma.tallySalesVoucher.findMany({
    where: { snapshotId: snapshot.id },
    select: {
      guid: true,
      masterId: true,
      alterId: true,
      billDate: true,
      billNumber: true,
      typeName: true,
      family: true,
      partyName: true,
      cancelled: true,
      optional: true,
      ledgerEntries: true,
      items: {
        orderBy: { lineNo: "asc" },
        select: {
          lineNo: true,
          stockItemName: true,
          quantity: true,
          amount: true,
          unit: true,
          actualQty: true,
          billedQty: true,
          rate: true,
        },
      },
    },
  });
  const sales = new Map<string, Bill>(
    saved.map((bill) => [
      bill.guid.toLowerCase(),
      {
        ...bill,
        family: bill.family as Bill["family"],
        ledgerEntries: z
          .array(z.object({ name: z.string(), amount: z.string() }))
          .parse(bill.ledgerEntries),
        items: bill.items.map((item) => ({
          ...item,
          quantity: item.quantity.toFixed(6),
          amount: item.amount.toFixed(2),
        })),
      },
    ]),
  );
  const daybook = new Map(evidence.capture.vouchers.map((bill) => [bill.guid.toLowerCase(), bill]));
  const counts = {
    daybookBills: daybook.size,
    salesBills: sales.size,
    matchedBills: 0,
    differentBills: 0,
    onlyDaybook: 0,
    onlySales: 0,
  };
  const differences: NonNullable<DaybookSalesComparison["differences"]> = [];
  let differenceCount = 0;
  let differenceBytes = 0;
  for (const guid of new Set([...daybook.keys(), ...sales.keys()])) {
    const a = daybook.get(guid),
      b = sales.get(guid);
    if (a && b && signature(a) === signature(b)) {
      counts.matchedBills++;
      continue;
    }
    if (!a) counts.onlySales++;
    else if (!b) counts.onlyDaybook++;
    else counts.differentBills++;
    differenceCount++;
    if (differences.length < 100) {
      const difference = {
        guid,
        reason: !a
          ? "Only in Sales"
          : !b
            ? "Only in Daybook"
            : "Bill identity, flags or product details differ",
        ...(a ? { daybook: display(a) } : {}),
        ...(b ? { sales: display(b) } : {}),
      };
      const bytes = Buffer.byteLength(JSON.stringify(difference));
      if (differenceBytes + bytes <= 1_500_000) {
        differences.push(difference);
        differenceBytes += bytes;
      }
    }
  }
  return {
    ...dates,
    status: differenceCount ? "different" : "matched",
    message: differenceCount
      ? "The saved Daybook and Sales bill/product records have differences."
      : "The saved Daybook and Sales bill/product records match for this period.",
    counts,
    differences,
    differenceCount,
  };
}
