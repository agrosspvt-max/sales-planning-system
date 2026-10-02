import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildPage, type PageParams } from "@/lib/pagination";

/** Tagged-first happens in SQL BEFORE LIMIT/OFFSET. Earliest alias is used solely for ordering;
 * Dealer.name and the returned edit records remain untouched. No per-dealer lookup or extra state. */
export async function listDealerResourcePage(params: PageParams) {
  const term = `%${params.search}%`;
  const filter = params.search
    ? Prisma.sql`WHERE d."name" ILIKE ${term} OR d."town" ILIKE ${term}`
    : Prisma.empty;
  const [items, total] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT d.* FROM "Dealer" d
      LEFT JOIN LATERAL (
        SELECT a."tallyName" FROM "DealerAlias" a
        WHERE a."systemDealerId" = d."id" AND TRIM(a."tallyName") <> ''
        ORDER BY a."createdAt", a."id" LIMIT 1
      ) alias ON TRUE
      ${filter}
      ORDER BY EXISTS (
        SELECT 1 FROM "DealerTagAssignment" da JOIN "DealerTag" t ON t."id" = da."tagId"
        WHERE da."dealerId" = d."id" AND da."isActive" AND t."isActive"
      ) DESC, COALESCE(alias."tallyName", d."name") ASC, d."id" ASC
      LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}`),
    prisma.dealer.count({
      where: params.search
        ? {
            OR: [
              { name: { contains: params.search, mode: "insensitive" } },
              { town: { contains: params.search, mode: "insensitive" } },
            ],
          }
        : {},
    }),
  ]);
  return buildPage(items, total, params);
}
