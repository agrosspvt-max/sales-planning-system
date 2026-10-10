/**
 * DRY-RUN backfill: link existing free-text Territory Mapping districts (DealerMarketMapping.district) to the District master.
 *   - Default is a REPORT only — nothing is written. --apply links ONLY the unambiguous matches (district of the dealer's own state, by name
 *     or approved alias, active). Legacy text is never deleted or overwritten; unmatched / cross-state / ambiguous / no-state rows are reported
 *     for manual review and left exactly as they are. The separate Dealer.district contact field is not touched.
 *   - State of a dealer = Dealer → CURRENT open DealerAssignment → officer → UserGroup (most recent open assignment wins, like the app).
 *
 *   npx tsx scripts/district-backfill.ts [--csv review.csv] [--apply [--user <userId for the audit entry>]]
 *
 * Connection: DIRECT_URL, else DATABASE_URL. Never apply to production without the owner's sign-off.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveCurrentOwner } from "../src/lib/dealer-ownership";
import { buildDistrictCatalog, planDistrictBackfill } from "../src/lib/district-master";

async function main() {
  const apply = process.argv.includes("--apply");
  const csvIdx = process.argv.indexOf("--csv"), userIdx = process.argv.indexOf("--user");
  const prisma = new PrismaClient(process.env.DIRECT_URL ? { datasources: { db: { url: process.env.DIRECT_URL } } } : undefined);
  try {
    const [districts, aliases, mappings] = await Promise.all([
      prisma.district.findMany({ select: { id: true, groupId: true, name: true, nameKey: true, isActive: true } }),
      prisma.districtAlias.findMany({ select: { districtId: true, groupId: true, aliasKey: true } }),
      prisma.dealerMarketMapping.findMany({ select: { dealerId: true, district: true, districtId: true, dealer: { select: { name: true } } } }),
    ]);
    if (districts.length === 0) throw new Error("The District master is empty — load it first (scripts/district-seed.ts).");
    const dealerIds = mappings.filter((m) => !m.districtId && (m.district ?? "").trim()).map((m) => m.dealerId);
    const open = dealerIds.length ? await prisma.dealerAssignment.findMany({ where: { dealerId: { in: dealerIds }, effectiveTo: null }, select: { dealerId: true, officerId: true, effectiveFrom: true, createdAt: true } }) : [];
    const byDealer = new Map<string, typeof open>();
    for (const r of open) byDealer.set(r.dealerId, [...(byDealer.get(r.dealerId) ?? []), r]);
    const ownerOf = new Map<string, string>();
    for (const [dealerId, list] of byDealer) { const o = resolveCurrentOwner(list); if (o) ownerOf.set(dealerId, o); }
    const officers = await prisma.user.findMany({ where: { id: { in: [...new Set(ownerOf.values())] } }, select: { id: true, groupId: true } });
    const groupOf = new Map(officers.map((u) => [u.id, u.groupId]));

    const catalog = buildDistrictCatalog(districts, aliases);
    const rows = planDistrictBackfill(mappings.map((m) => ({ dealerId: m.dealerId, text: m.district, districtId: m.districtId, groupId: groupOf.get(ownerOf.get(m.dealerId) ?? "") ?? null })), catalog);
    const tally = new Map<string, number>();
    for (const r of rows) tally.set(r.status, (tally.get(r.status) ?? 0) + 1);
    console.log("Backfill report (" + (apply ? "APPLY" : "DRY RUN") + "):", Object.fromEntries(tally));
    const review = rows.filter((r) => ["UNMATCHED", "CROSS_STATE", "NO_STATE", "AMBIGUOUS", "INACTIVE"].includes(r.status));
    const nameOf = new Map(mappings.map((m) => [m.dealerId, m.dealer.name]));
    const csv = ["dealerId,dealer,status,legacyText,detail", ...review.map((r) => [r.dealerId, nameOf.get(r.dealerId) ?? "", r.status, r.text ?? "", r.detail ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    if (csvIdx >= 0) { writeFileSync(process.argv[csvIdx + 1] ?? "district-review.csv", csv); console.log(`Review list written (${review.length} rows).`); } else if (review.length) console.log(csv.split("\n").slice(0, 40).join("\n") + (review.length > 39 ? "\n…" : ""));
    const matched = rows.filter((r) => r.status === "MATCHED");
    if (!apply) { console.log(`\nDRY RUN — nothing written. ${matched.length} row(s) would be linked.`); return; }
    await prisma.$transaction(async (tx) => {
      for (const r of matched) await tx.dealerMarketMapping.update({ where: { dealerId: r.dealerId }, data: { districtId: r.districtId!, district: r.districtName! } });
      const user = userIdx >= 0 ? process.argv[userIdx + 1] : null; // optional: an existing user id to attribute the audit entry to
      if (user) await tx.auditLog.create({ data: { userId: user, action: "UPDATE", entity: "dealerMarketMapping", entityId: null, summary: `District backfill: ${matched.length} mapping(s) linked to the District master; ${review.length} left for review` } });
    }, { timeout: 120_000 });
    console.log(`Applied: ${matched.length} linked.`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
