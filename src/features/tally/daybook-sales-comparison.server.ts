import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import {
  authorizedProductJob,
  productsInJob,
  unavailableProducts,
} from "./daybook-product-source.server";
import { cents, decimal } from "./billwise";
import { daybookDiagnosticsSchema } from "./daybook-diagnostics";
import {
  comparisonSignature,
  billMismatchDetails,
  type ComparisonSourceBill,
} from "./daybook-comparison-details";
import type { DaybookSalesComparison, ComparisonBill } from "./daybook-sales-comparison";

type Bill = ComparisonSourceBill;
const sourceEvidence = z.object({
  guid: z.string(),
  amount: z.string().optional(),
  direction: z.string().optional(),
  details: daybookDiagnosticsSchema.optional(),
});
type SourceEvidence = z.infer<typeof sourceEvidence>;
function diagnosticVouchers(summary: unknown) {
  const saved = z.object({ excludedVouchers: z.array(z.unknown()).optional() }).safeParse(summary);
  const entries = new Map<string, SourceEvidence>();
  for (const value of saved.success ? (saved.data.excludedVouchers ?? []) : []) {
    const row = sourceEvidence.safeParse(value);
    if (row.success) entries.set(row.data.guid.toLowerCase(), row.data);
  }
  return entries;
}
function display(bill: Bill, original?: SourceEvidence, includeLines = true): ComparisonBill {
  const partyEntries = bill.partyName
    ? bill.ledgerEntries.filter(
        (entry) => entry.name.toLowerCase() === bill.partyName.toLowerCase(),
      )
    : [];
  const details = original?.details?.voucher;
  const references =
    "references" in bill && Array.isArray(bill.references)
      ? (bill.references as string[])
      : undefined;
  return {
    guid: bill.guid,
    masterId: bill.masterId,
    alterId: bill.alterId,
    family: bill.family,
    productTotal: bill.items.length
      ? decimal(bill.items.reduce((sum, item) => sum + cents(item.amount), 0n))
      : null,
    partyLedgerAmount: partyEntries.length
      ? decimal(partyEntries.reduce((sum, entry) => sum + cents(entry.amount), 0n))
      : null,
    ...(details?.narration ? { narration: details.narration } : {}),
    ...(details?.cancelled ? { rawCancelled: details.cancelled } : {}),
    ...(details?.optional ? { rawOptional: details.optional } : {}),
    ...(original?.amount !== undefined
      ? { capturedAmount: { amount: original.amount, direction: original.direction } }
      : {}),
    ...(references
      ? { references: references.slice(0, 50), referenceCount: references.length }
      : {}),
    number: bill.billNumber,
    date: bill.billDate,
    party: bill.partyName,
    type: bill.typeName,
    cancelled: bill.cancelled,
    optional: bill.optional,
    ledgerEntries: includeLines ? bill.ledgerEntries.slice(0, 100) : [],
    ledgerCount: bill.ledgerEntries.length,
    itemCount: bill.items.length,
    items: (includeLines ? bill.items.slice(0, 100) : []).map((item) => ({
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
    daybookJobId: job.id,
    fromDate: job.fromDate,
    throughDate: job.throughDate,
    ...(evidence ? { daybookCapturedAt: evidence.observedAt } : {}),
  };
  if (!evidence || evidence.capture.status !== "complete")
    return { ...base, status: "unavailable", message: unavailableProducts(job) };
  const snapshot = await prisma.tallySalesSnapshot.findUnique({
    where: { connectionId_monthKey: { connectionId: job.connectionId, monthKey: job.monthKey } },
    select: {
      id: true,
      fromDate: true,
      throughDate: true,
      observedAt: true,
      connection: { select: { companyName: true } },
    },
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
    companyName: snapshot.connection.companyName,
    salesSnapshotId: snapshot.id,
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
  const originals = diagnosticVouchers(job.summary);
  const numberIndex = new Map<string, { source: "Daybook" | "Sales"; bill: Bill }[]>();
  for (const [source, bills] of [
    ["Daybook", daybook],
    ["Sales", sales],
  ] as const) {
    for (const bill of bills.values()) {
      const number = bill.billNumber.trim().toLowerCase();
      if (number) {
        const entries = numberIndex.get(number) ?? [];
        entries.push({ source, bill });
        numberIndex.set(number, entries);
      }
    }
  }
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
    if (a && b && comparisonSignature(a) === comparisonSignature(b)) {
      counts.matchedBills++;
      continue;
    }
    if (!a) counts.onlySales++;
    else if (!b) counts.onlyDaybook++;
    else counts.differentBills++;
    differenceCount++;
    if (differences.length < 100) {
      const numbers = new Set(
        [a?.billNumber, b?.billNumber]
          .filter((number): number is string => !!number?.trim())
          .map((number) => number.trim().toLowerCase()),
      );
      const numberMatches = [...numbers]
        .flatMap((number) => numberIndex.get(number) ?? [])
        .filter((entry) => entry.bill.guid.toLowerCase() !== guid);
      const difference = {
        guid,
        ...(!a
          ? { reason: "Only in Sales" }
          : !b
            ? { reason: "Only in Daybook" }
            : billMismatchDetails(a, b)),
        ...(a ? { daybook: display(a, originals.get(guid)) } : {}),
        ...(b ? { sales: display(b) } : {}),
        numberMatches: {
          count: numberMatches.length,
          vouchers: numberMatches.slice(0, 10).map(({ source, bill }) => ({
            source,
            bill: display(
              bill,
              source === "Daybook" ? originals.get(bill.guid.toLowerCase()) : undefined,
              false,
            ),
          })),
        },
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
