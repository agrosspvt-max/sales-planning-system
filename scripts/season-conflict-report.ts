/**
 * Season Conflict Report — STRICTLY READ-ONLY. Modifies nothing.
 *
 * Compares the case-only duplicate season(s) (e.g. "KHARIF" 2026) against the canonical season
 * ("Kharif" 2026) and prints, for every season row that shares the same case-insensitive name+year:
 *   - Season ID
 *   - Season Month IDs
 *   - Seasonal Plans (officer, status, version, active, lifecycle)
 *   - Monthly Plans (officer, month, status)
 *   - Recovery Plans (officer, month, status)
 *   - Import records
 *   - Onboarding records
 * Then it answers:
 *   1. Which Sales Officers exist only under the duplicate (not under canonical).
 *   2. Whether any of those officers already has a corresponding SEASONAL plan under canonical.
 *   3. Whether the duplicate looks like accidental duplication or unique business data.
 *
 *   npx tsx scripts/season-conflict-report.ts                 # defaults to "kharif" 2026
 *   npx tsx scripts/season-conflict-report.ts "kharif" 2026   # explicit
 */
import { PrismaClient } from "@prisma/client";
import { canonicalSeasonName, seasonNameKey } from "../src/lib/season-name";

const prisma = new PrismaClient();

const KEY = seasonNameKey(process.argv[2] ?? "Kharif");
const YEAR = Number(process.argv[3] ?? 2026);

async function officerNameMap(ids: string[]): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

async function reportSeason(seasonId: string, label: string) {
  const [months, seasonalPlans, monthlyPlans, recoveryPlans, imports, onboarding] = await Promise.all([
    prisma.seasonMonth.findMany({ where: { seasonId }, orderBy: { order: "asc" }, select: { id: true, name: true, order: true } }),
    prisma.seasonPlan.findMany({
      where: { seasonId, planningType: "SEASONAL" },
      orderBy: [{ officerId: "asc" }, { version: "asc" }],
      select: { id: true, officerId: true, status: true, version: true, isActiveVersion: true, lifecycleState: true, officer: { select: { name: true } } },
    }),
    prisma.monthlyPlan.findMany({
      where: { seasonPlan: { seasonId } },
      select: { id: true, officerId: true, status: true, lifecycleState: true, officer: { select: { name: true } }, seasonMonth: { select: { name: true, order: true } } },
    }),
    prisma.recoveryPlan.findMany({
      where: { seasonId },
      select: { id: true, officerId: true, status: true, lifecycleState: true, officer: { select: { name: true } }, seasonMonth: { select: { name: true, order: true } } },
    }),
    prisma.seasonPlanImportRecord.findMany({ where: { seasonId }, select: { id: true, officerId: true, workbookName: true, status: true, createdAt: true } }),
    prisma.onboardingRecord.findMany({ where: { seasonId }, select: { id: true, officerId: true, sourceName: true, status: true, createdAt: true } }),
  ]);

  console.log(`\n────────────────────────────────────────────────────────`);
  console.log(`${label}`);
  console.log(`  Season ID: ${seasonId}`);
  console.log(`  Season Month IDs (${months.length}): ${months.map((m) => `#${m.order} ${m.name}=${m.id}`).join("  |  ") || "(none)"}`);

  console.log(`  Seasonal Plans (${seasonalPlans.length}):`);
  for (const p of seasonalPlans)
    console.log(`     • ${p.officer.name.padEnd(22)} status=${p.status} v${p.version} active=${p.isActiveVersion} lifecycle=${p.lifecycleState}  [${p.id}]`);

  console.log(`  Monthly Plans (${monthlyPlans.length}):`);
  for (const p of monthlyPlans)
    console.log(`     • ${p.officer.name.padEnd(22)} month=#${p.seasonMonth.order} ${p.seasonMonth.name} status=${p.status} lifecycle=${p.lifecycleState}  [${p.id}]`);

  console.log(`  Recovery Plans (${recoveryPlans.length}):`);
  for (const p of recoveryPlans)
    console.log(`     • ${p.officer.name.padEnd(22)} month=#${p.seasonMonth.order} ${p.seasonMonth.name} status=${p.status} lifecycle=${p.lifecycleState}  [${p.id}]`);

  console.log(`  Import records (${imports.length}):`);
  for (const r of imports) console.log(`     • officerId=${r.officerId} "${r.workbookName}" status=${r.status} ${r.createdAt.toISOString()}  [${r.id}]`);

  console.log(`  Onboarding records (${onboarding.length}):`);
  for (const r of onboarding) console.log(`     • officerId=${r.officerId ?? "-"} "${r.sourceName}" status=${r.status} ${r.createdAt.toISOString()}  [${r.id}]`);

  // Officer sets for the comparison step.
  const seasonalByOfficer = new Map<string, typeof seasonalPlans>();
  for (const p of seasonalPlans) {
    const arr = seasonalByOfficer.get(p.officerId) ?? [];
    arr.push(p);
    seasonalByOfficer.set(p.officerId, arr);
  }
  const allOfficerIds = new Set<string>([
    ...seasonalPlans.map((p) => p.officerId),
    ...monthlyPlans.map((p) => p.officerId),
    ...recoveryPlans.map((p) => p.officerId),
    ...imports.map((r) => r.officerId),
    ...onboarding.map((r) => r.officerId).filter((x): x is string => !!x),
  ]);
  return { seasonId, months, seasonalPlans, monthlyPlans, recoveryPlans, imports, onboarding, seasonalByOfficer, allOfficerIds };
}

async function main() {
  console.log(`\n===== SEASON CONFLICT REPORT (READ-ONLY) — key "${KEY}", year ${YEAR} =====`);

  const rows = (await prisma.season.findMany({
    where: { year: YEAR, name: { equals: KEY, mode: "insensitive" } },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })) as { id: string; name: string; createdAt: Date }[];

  if (rows.length === 0) {
    console.log(`\nNo season found for key "${KEY}" ${YEAR}. Nothing to report.\n`);
    return prisma.$disconnect();
  }
  if (rows.length === 1) {
    console.log(`\nOnly ONE season row exists for "${rows[0].name}" ${YEAR} (id ${rows[0].id}). No case-duplicate — nothing to merge.\n`);
    await reportSeason(rows[0].id, `SEASON: "${rows[0].name}" ${YEAR}`);
    return prisma.$disconnect();
  }

  const canonicalName = canonicalSeasonName(rows[0].name);
  const canonicalRow = rows.find((r) => r.name === canonicalName) ?? rows[0];
  const duplicateRows = rows.filter((r) => r.id !== canonicalRow.id);
  console.log(`\nFound ${rows.length} case-variant rows: ${rows.map((r) => `"${r.name}"`).join(", ")}`);
  console.log(`Treating "${canonicalRow.name}" (id ${canonicalRow.id}) as CANONICAL; the rest as DUPLICATES.`);

  const canonical = await reportSeason(canonicalRow.id, `CANONICAL: "${canonicalRow.name}" ${YEAR}`);
  const dups = [];
  for (const d of duplicateRows) dups.push(await reportSeason(d.id, `DUPLICATE: "${d.name}" ${YEAR}`));

  // Resolve names for all officers involved anywhere.
  const nameMap = await officerNameMap([...canonical.allOfficerIds, ...dups.flatMap((d) => [...d.allOfficerIds])]);
  const nm = (id: string) => nameMap.get(id) ?? id;

  console.log(`\n════════════════════ COMPARISON ════════════════════`);

  // 1. Officers only under the duplicate(s).
  const dupOfficers = new Set<string>(dups.flatMap((d) => [...d.allOfficerIds]));
  const onlyUnderDup = [...dupOfficers].filter((id) => !canonical.allOfficerIds.has(id));
  console.log(`\n1) Sales Officers present ONLY under the duplicate (not under "${canonicalRow.name}"): ${onlyUnderDup.length}`);
  for (const id of onlyUnderDup) console.log(`   • ${nm(id)}  (${id})`);
  if (onlyUnderDup.length === 0) console.log(`   (none — every duplicate officer also appears under canonical)`);

  // 2. For each duplicate officer, does canonical already have a SEASONAL plan?
  console.log(`\n2) Does each duplicate officer already have a corresponding SEASONAL plan under "${canonicalRow.name}"?`);
  for (const id of dupOfficers) {
    const canon = canonical.seasonalByOfficer.get(id) ?? [];
    const dupPlans = dups.flatMap((d) => d.seasonalByOfficer.get(id) ?? []);
    const canonDesc = canon.length ? canon.map((p) => `v${p.version}/${p.status}${p.isActiveVersion ? "/active" : ""}`).join(", ") : "NONE";
    const dupDesc = dupPlans.map((p) => `v${p.version}/${p.status}${p.isActiveVersion ? "/active" : ""}`).join(", ") || "(no seasonal plan)";
    console.log(`   • ${nm(id).padEnd(22)} duplicate: ${dupDesc.padEnd(28)} canonical: ${canonDesc}`);
  }

  // 3. Heuristic verdict.
  const overlap = [...dupOfficers].filter((id) => (canonical.seasonalByOfficer.get(id) ?? []).length > 0);
  const dupHasData =
    dups.some((d) => d.seasonalPlans.length + d.monthlyPlans.length + d.recoveryPlans.length + d.imports.length + d.onboarding.length > 0);
  console.log(`\n3) Assessment (heuristic — for human confirmation, not an automatic decision):`);
  if (!dupHasData) {
    console.log(`   The duplicate holds NO operational data → safe to remove automatically (the normalization script will merge it).`);
  } else if (onlyUnderDup.length === 0 && overlap.length === dupOfficers.size) {
    console.log(`   Every officer under the duplicate ALSO has a seasonal plan under canonical.`);
    console.log(`   → Looks like ACCIDENTAL DUPLICATION (same officers planned under both spellings). Verify the duplicate's`);
    console.log(`     plans are redundant, then delete the duplicate rows manually and re-run the normalization script.`);
  } else {
    console.log(`   The duplicate contains officers/plans that do NOT exist under canonical (${onlyUnderDup.length} officer(s) unique).`);
    console.log(`   → Treat as UNIQUE BUSINESS DATA. Do not auto-merge; reassign/re-point these plans to the canonical season`);
    console.log(`     deliberately (admin decision) before removing the duplicate.`);
  }
  console.log(`\n(READ-ONLY report — nothing was modified.)\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
