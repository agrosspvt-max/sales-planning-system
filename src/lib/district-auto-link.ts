import { Prisma, type PrismaClient } from "@prisma/client";

export interface ClearDistrictLink {
  dealerId: string;
  previousText: string;
  districtId: string;
  districtName: string;
  stateName: string;
}
export interface DistrictAutoLinkOptions {
  /** null = administrative scope; otherwise rechecked against the CURRENT owner inside the statement. */
  officerIds: string[] | null;
  actorId: string;
  actorDesignation?: string | null;
  apply: boolean;
}

const nameKey = (column: Prisma.Sql) => Prisma.sql`lower(btrim(regexp_replace(${column}, '[[:space:]]+', ' ', 'g')))`;

/** Strict name equality after case/whitespace normalization. No spelling guesses, punctuation
 * changes, aliases, cross-state moves, inactive districts or overwrites of existing district links.
 * A single statement resolves ownership, matches, conditionally updates and writes the audit trail.
 */
export function clearDistrictLinksQuery(options: DistrictAutoLinkOptions): Prisma.Sql {
  const scope = options.officerIds === null ? Prisma.empty : options.officerIds.length ? Prisma.sql`AND owner."officerId" IN (${Prisma.join(options.officerIds)})` : Prisma.sql`AND false`;
  const candidates = Prisma.sql`
    WITH matches AS (
      SELECT m.id, m."dealerId", m.district AS "previousText", district.id AS "districtId",
        district.name AS "districtName", district."isActive", state.name AS "stateName",
        count(*) OVER (PARTITION BY m.id) AS "matchCount"
      FROM "DealerMarketMapping" m
      JOIN "Dealer" dealer ON dealer.id = m."dealerId" AND dealer."isActive" = true AND dealer."deletedAt" IS NULL
      JOIN LATERAL (
        SELECT a."officerId" FROM "DealerAssignment" a
        WHERE a."dealerId" = m."dealerId" AND a."effectiveTo" IS NULL
        ORDER BY a."effectiveFrom" DESC, a."createdAt" DESC LIMIT 1
      ) owner ON true
      JOIN "User" officer ON officer.id = owner."officerId"
      JOIN "UserGroup" state ON state.id = officer."groupId"
      JOIN "District" district ON district."groupId" = state.id
        AND ${nameKey(Prisma.sql`district.name`)} = ${nameKey(Prisma.sql`m.district`)}
      WHERE m."districtId" IS NULL AND m.district IS NOT NULL
        AND ${nameKey(Prisma.sql`m.district`)} <> '' ${scope}
    ), candidates AS (SELECT * FROM matches WHERE "matchCount" = 1 AND "isActive" = true)`;
  if (!options.apply) return Prisma.sql`${candidates}
    SELECT "dealerId", "previousText", "districtId", "districtName", "stateName" FROM candidates ORDER BY "dealerId"`;
  return Prisma.sql`${candidates}, linked AS (
    UPDATE "DealerMarketMapping" mapping
    SET "districtId" = c."districtId", district = c."districtName", "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedById" = ${options.actorId}
    FROM candidates c
    WHERE mapping.id = c.id AND mapping."districtId" IS NULL AND mapping.district IS NOT DISTINCT FROM c."previousText"
    RETURNING c."dealerId", c."previousText", c."districtId", c."districtName", c."stateName"
  ), audited AS (
    INSERT INTO "AuditLog" (id, "userId", action, entity, "entityId", summary, "actorDesignation", "createdAt")
    SELECT 'district_auto_' || md5(random()::text || clock_timestamp()::text || "dealerId"),
      ${options.actorId}, 'UPDATE', 'dealerMarketMapping', "dealerId",
      'Auto-linked district: ' || "previousText" || ' → ' || "districtName" || ' (' || "stateName" || '). Unique active match after case/whitespace normalization; market, potential and planning data unchanged.',
      ${options.actorDesignation ?? null}, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    FROM linked RETURNING id
  ) SELECT "dealerId", "previousText", "districtId", "districtName", "stateName" FROM linked ORDER BY "dealerId"`;
}

export async function autoLinkClearDistricts(db: PrismaClient, options: DistrictAutoLinkOptions): Promise<ClearDistrictLink[]> {
  return db.$transaction(async tx => {
    if (!options.apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return tx.$queryRaw<ClearDistrictLink[]>(clearDistrictLinksQuery(options));
  }, { isolationLevel: "Serializable", timeout: 30_000, maxWait: 10_000 });
}
