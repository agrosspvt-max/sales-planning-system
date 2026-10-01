/**
 * READ-ONLY diagnostic for the dealer reassignment / dual-Sales-Officer bug. Makes NO database changes.
 *
 * It answers, for a dealer name (or alias) substring:
 *   - how many Dealer IDs resolve to that name/alias (the "two dealers that look like one" case),
 *   - each dealer's FULL DealerAssignment history + its CURRENT open owner (effectiveTo = null),
 *   - which officers' Recovery Plans and Season Plans contain each Dealer ID (the historical membership that
 *     Territory views read), so you can see under which officer(s) each id leaks.
 *
 * Usage (run against your localhost DB):
 *   npx tsx scripts/diagnose-dealer-ownership.ts "BANKE BIHARI KRISHI SEVA KENDRA (BAHADURPUR)"
 *   # or a shorter unique fragment:
 *   npx tsx scripts/diagnose-dealer-ownership.ts "BANKE BIHARI"
 *
 * Connection: prefers DIRECT_URL (falls back to DATABASE_URL). Only SELECTs are issued.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient(
  process.env.DIRECT_URL ? { datasources: { db: { url: process.env.DIRECT_URL } } } : undefined,
);

const term = process.argv.slice(2).join(" ").trim();
const tight = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function officerName(id: string | null | undefined): Promise<string> {
  if (!id) return "(none)";
  const u = await prisma.user.findUnique({ where: { id }, select: { name: true, groupId: true } });
  const g = u?.groupId ? await prisma.userGroup.findUnique({ where: { id: u.groupId }, select: { name: true } }) : null;
  return u ? `${u.name}${g ? ` [group ${g.name}]` : ""} (${id})` : `(unknown ${id})`;
}

async function main(): Promise<void> {
  if (!term) { console.error('Pass a dealer name/alias fragment, e.g. "BANKE BIHARI".'); process.exitCode = 1; return; }
  const t = tight(term);

  // 1) Every Dealer whose NAME matches, plus every Dealer reachable via a matching ALIAS (tallyName).
  const byName = await prisma.dealer.findMany({ where: { name: { contains: term, mode: "insensitive" } }, select: { id: true, name: true, status: true, isActive: true, deletedAt: true } });
  const aliasHits = await prisma.dealerAlias.findMany({ where: { tallyName: { contains: term, mode: "insensitive" } }, select: { id: true, tallyName: true, systemDealerId: true } });
  // Also catch normalization-only differences (spaces/case/punctuation) via tightKey over a wider scan.
  const wide = await prisma.dealer.findMany({ select: { id: true, name: true, status: true, isActive: true, deletedAt: true } });
  const tightName = wide.filter((d) => tight(d.name).includes(t));

  const dealerIds = [...new Set([...byName.map((d) => d.id), ...aliasHits.map((a) => a.systemDealerId), ...tightName.map((d) => d.id)])];
  console.log(`\n================ DEALER OWNERSHIP DIAGNOSTIC ================`);
  console.log(`Search term: "${term}"  (tightKey: "${t}")`);
  console.log(`Matching Dealer IDs: ${dealerIds.length}`);
  if (dealerIds.length === 0) { console.log("No dealers matched."); return; }
  if (dealerIds.length > 1) console.log(`\n⚠️  MORE THAN ONE Dealer ID resolves to this name/alias — this alone can make the "same" dealer show under multiple officers (two distinct dealers, each correctly owned).`);

  for (const id of dealerIds) {
    const d = (byName.find((x) => x.id === id) ?? tightName.find((x) => x.id === id)) ?? await prisma.dealer.findUnique({ where: { id }, select: { id: true, name: true, status: true, isActive: true, deletedAt: true } });
    console.log(`\n------------------------------------------------------------`);
    console.log(`Dealer ID: ${id}`);
    console.log(`  name:   "${d?.name}"`);
    console.log(`  status: ${d?.status}  isActive: ${d?.isActive}  deletedAt: ${d?.deletedAt ?? "null"}`);

    const aliases = await prisma.dealerAlias.findMany({ where: { systemDealerId: id }, select: { tallyName: true } });
    console.log(`  aliases: ${aliases.length ? aliases.map((a) => `"${a.tallyName}"`).join(", ") : "(none)"}`);

    const assigns = await prisma.dealerAssignment.findMany({ where: { dealerId: id }, orderBy: { effectiveFrom: "asc" }, select: { officerId: true, effectiveFrom: true, effectiveTo: true } });
    console.log(`  DealerAssignment history (${assigns.length}):`);
    for (const a of assigns) console.log(`    - officer ${await officerName(a.officerId)}  from ${a.effectiveFrom.toISOString().slice(0, 10)}  to ${a.effectiveTo ? a.effectiveTo.toISOString().slice(0, 10) : "OPEN (current)"}`);
    const open = assigns.filter((a) => a.effectiveTo === null);
    if (open.length === 0) console.log(`  ⚠️  CURRENT OWNER: (none) — no open assignment. Current-ownership filter treats owner as UNKNOWN → the dealer keeps showing under EVERY plan it is in.`);
    else if (open.length > 1) console.log(`  ⚠️  CURRENT OWNER: AMBIGUOUS — ${open.length} open assignments: ${(await Promise.all(open.map((a) => officerName(a.officerId)))).join(" , ")}`);
    else console.log(`  ✅ CURRENT OWNER: ${await officerName(open[0].officerId)}`);

    // Which officers' RECOVERY plans contain this dealer id (historical membership Territory Recovery reads).
    const rpd = await prisma.recoveryPlanDealer.findMany({ where: { dealerId: id }, select: { recoveryPlan: { select: { officerId: true, seasonMonth: { select: { name: true } }, status: true, lifecycleState: true } } } });
    const recOfficers = new Map<string, number>();
    for (const r of rpd) recOfficers.set(r.recoveryPlan.officerId, (recOfficers.get(r.recoveryPlan.officerId) ?? 0) + 1);
    console.log(`  RecoveryPlanDealer rows: ${rpd.length} across officers:`);
    for (const [oid, n] of recOfficers) console.log(`    - ${await officerName(oid)} : ${n} recovery row(s)`);

    // Which officers' SEASON plans contain this dealer id (Territory Plan reads these).
    const pdl = await prisma.planDealer.findMany({ where: { dealerId: id }, select: { seasonPlan: { select: { officerId: true, status: true, lifecycleState: true } } } });
    const planOfficers = new Map<string, number>();
    for (const p of pdl) planOfficers.set(p.seasonPlan.officerId, (planOfficers.get(p.seasonPlan.officerId) ?? 0) + 1);
    console.log(`  PlanDealer rows: ${pdl.length} across officers:`);
    for (const [oid, n] of planOfficers) console.log(`    - ${await officerName(oid)} : ${n} plan row(s)`);
  }

  console.log(`\n================ INTERPRETATION ================`);
  console.log(`• If there are 2+ Dealer IDs above, the UI shows the same NAME for different dealers — the ownership`);
  console.log(`  filter cannot (and must not) merge them. Root cause = duplicate Dealer records, not Territory code.`);
  console.log(`• If there is 1 Dealer ID but CURRENT OWNER is "(none)" or AMBIGUOUS, the assignment data is wrong —`);
  console.log(`  that is why it leaks under multiple officers despite the filter.`);
  console.log(`• If there is 1 Dealer ID with exactly one open owner = Shivveer, yet it still appears under Sunil in`);
  console.log(`  the UI, the running server is stale (rebuild/restart) OR a different endpoint feeds that view.`);
  console.log(`\nPaste this output back and I will implement the exact matching fix.\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
