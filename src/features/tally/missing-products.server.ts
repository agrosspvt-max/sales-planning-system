import "server-only";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { loadProductResolver } from "@/lib/product-resolver";
import { cleanProductName } from "@/features/sales-upload/parser";
import { approvedTestPreview } from "./sales-rollout";
import { assertSuper } from "./service.server";
import type { MissingProductsStatus } from "./missing-products";

export async function missingProductsStatus(ctx: AuthContext): Promise<MissingProductsStatus> {
  if (!approvedTestPreview())
    throw new ApiError(404, "Missing products are available on the test Preview.");
  assertSuper(ctx);
  const connection = await prisma.tallyConnection.findFirst({
    where: { enabled: true },
    select: { id: true },
  });
  if (!connection) return { configured: false, months: [], products: [] };

  const [resolver, months, lines] = await Promise.all([
    loadProductResolver(),
    prisma.tallySalesSnapshot.findMany({
      where: { connectionId: connection.id },
      select: { monthKey: true, observedAt: true },
      orderBy: { monthKey: "desc" },
    }),
    prisma.$queryRaw<{ dealerName: string; stockItemName: string; monthKey: string }[]>`
      SELECT DISTINCT v."partyName" AS "dealerName", i."stockItemName", s."monthKey"
      FROM "TallySalesItem" i
      JOIN "TallySalesVoucher" v ON v.id = i."voucherId"
      JOIN "TallySalesSnapshot" s ON s.id = v."snapshotId"
      WHERE s."connectionId" = ${connection.id} AND NOT v.cancelled AND NOT v.optional
    `,
  ]);
  const known = new Map<string, boolean>();
  const products = new Map<
    string,
    { dealerName: string; stockItemName: string; months: Set<string> }
  >();
  const key = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  for (const line of lines) {
    if (!known.has(line.stockItemName))
      known.set(
        line.stockItemName,
        Boolean(resolver.resolveProductUnique(cleanProductName(line.stockItemName))),
      );
    if (known.get(line.stockItemName)) continue;
    const identity = JSON.stringify([key(line.dealerName), key(line.stockItemName)]);
    const row = products.get(identity) ?? { ...line, months: new Set<string>() };
    row.months.add(line.monthKey);
    products.set(identity, row);
  }
  return {
    configured: true,
    months: months.map((row) => ({
      monthKey: row.monthKey,
      observedAt: row.observedAt.toISOString(),
    })),
    products: [...products.values()]
      .map(({ dealerName, stockItemName, months }) => ({
        dealerName,
        stockItemName,
        months: [...months].sort(),
      }))
      .sort(
        (a, b) =>
          a.dealerName.localeCompare(b.dealerName) ||
          a.stockItemName.localeCompare(b.stockItemName),
      ),
  };
}
