/**
 * Delete a case-only DUPLICATE season and all data that belongs ONLY to it.
 *
 * Context: the duplicate "KHARIF" 2026 holds planning history for a single resigned Sales Officer
 * (Vinod Patidar). Rather than merge into the canonical "Kharif", we remove the duplicate outright.
 *
 * SAFETY — the script refuses to delete unless ALL of these hold (otherwise it aborts, no writes):
 *   1. A canonical season named exactly "Kharif" (same year) exists and is a DIFFERENT row — never touched.
 *   2. Every Seasonal Plan under the duplicate belongs to exactly the expected officer (default "Vinod Patidar").
 *   3. NO other officer (of any kind: seasonal, monthly, recovery, import, onboarding, extension) appears
 *      under the duplicate; and no such other officer is active.
 *   4. NO Recovery Plans are linked to the duplicate — neither by seasonId nor by seasonPlanId
 *      (RecoveryPlan.seasonPlan is onDelete: Restrict, so any link would both be business data AND block deletion).
 *
 * Deletion runs in a SINGLE transaction, in dependency order:
 *   Monthly Plans → Seasonal Plans (cascades PlanDealer/PlanLine/MonthlyEntry/Packs/ApprovalActions/MonthlyPlanDealer)
 *   → Month Extension Requests → Import records → Onboarding records → Season Months → the duplicate Season.
 * (Import/Onboarding records have a bare seasonId with no FK cascade, so they are deleted explicitly.)
 *
 * Read-only by default. Pass --apply to actually delete.
 *   npx tsx scripts/delete-duplicate-season.ts                                  # dry run
 *   npx tsx scripts/delete-duplicate-season.ts --apply                          # execute
 *   npx tsx scripts/delete-duplicate-season.ts "kharif" 2026 "Vinod Patidar" --apply
 */
import { PrismaClient } from "@prisma/client";
import { canonicalSeasonName, seasonNameKey } from "../src/lib/season-name";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const positional = argv.filter((a) => !a.startsWith("--"));
const KEY = seasonNameKey(positional[0] ?? "Kharif");
const YEAR = Number(positional[1] ?? 2026);
const OFFICER = (positional[2] ?? "Vinod Patidar").trim();

const fail = (msg: string) => {
  console.log(`\n❌ ABORTED — ${msg}`);
  console.log(`No changes were made.\n`);
};

async function main() {
  console.log(`\n===== DELETE DUPLICATE SEASON (${APPLY ? "APPLY" : "DRY RUN"}) — key "${KEY}", year ${YEAR}, officer "${OFFICER}" =====`);

  // --- Resolve the season rows in this (key, year) group. ---
  const rows = (await prisma.season.findMany({
    where: { year: YEAR, name: { equals: KEY, mode: "insensitive" } },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  })) as { id: string; name: string }[];

  const canonicalName = canonicalSeasonName(KEY);
  const canonical = rows.find((r) => r.name === canonicalName);
  const duplicates = rows.filter((r) => r.name !== canonicalName);

  if (rows.length === 0) return fail(`no season found for "${canonicalName}" ${YEAR}.`), prisma.$disconnect();
  if (!canonical) return fail(`the canonical season "${canonicalName}" ${YEAR} does not exist — refusing to delete the only copy.`), prisma.$disconnect();
  if (duplicates.length === 0) return console.log(`\n✅ No duplicate rows — only the canonical "${canonical.name}" (id ${canonical.id}) exists. Nothing to delete.\n`), prisma.$disconnect();

  console.log(`\nCanonical (WILL NOT be touched): "${canonical.name}" id=${canonical.id}`);
  console.log(`Duplicate(s) targeted for deletion: ${duplicates.map((d) => `"${d.name}" id=${d.id}`).join(", ")}`);

  // --- Resolve the expected officer. ---
  const officers = await prisma.user.findMany({ where: { name: { equals: OFFICER, mode: "insensitive" } }, select: { id: true, name: true, isActive: true } });
  if (officers.length !== 1) return fail(`expected exactly one user named "${OFFICER}", found ${officers.length}.`), prisma.$disconnect();
  const expected = officers[0];
  console.log(`Expected sole owner: ${expected.name} (id ${expected.id}, active=${expected.isActive})`);

  // --- Verify each duplicate, gathering the delete plan. ---
  for (const dup of duplicates) {
    console.log(`\n──── Verifying duplicate "${dup.name}" (id ${dup.id}) ────`);

    const [seasonPlans, months, monthlyPlanCount, recoveryBySeason, recoveryByPlan, imports, onboarding, extensions] = await Promise.all([
      prisma.seasonPlan.findMany({ where: { seasonId: dup.id }, select: { id: true, officerId: true, planningType: true, status: true, version: true, officer: { select: { name: true, isActive: true } } } }),
      prisma.seasonMonth.findMany({ where: { seasonId: dup.id }, select: { id: true } }),
      prisma.monthlyPlan.count({ where: { seasonPlan: { seasonId: dup.id } } }),
      prisma.recoveryPlan.count({ where: { seasonId: dup.id } }),
      prisma.recoveryPlan.count({ where: { seasonPlan: { seasonId: dup.id } } }),
      prisma.seasonPlanImportRecord.findMany({ where: { seasonId: dup.id }, select: { id: true, officerId: true } }),
      prisma.onboardingRecord.findMany({ where: { seasonId: dup.id }, select: { id: true, officerId: true } }),
      prisma.monthExtensionRequest.findMany({ where: { seasonId: dup.id }, select: { id: true, requestedById: true } }),
    ]);

    console.log(`   Seasonal Plans: ${seasonPlans.length} | Monthly Plans: ${monthlyPlanCount} | Recovery(by season): ${recoveryBySeason} | Recovery(by plan link): ${recoveryByPlan}`);
    console.log(`   Season Months: ${months.length} | Imports: ${imports.length} | Onboarding: ${onboarding.length} | Extension Requests: ${extensions.length}`);

    // Check 4 — no recovery plans at all (both link paths).
    if (recoveryBySeason > 0 || recoveryByPlan > 0) return fail(`duplicate "${dup.name}" has Recovery Plans linked (season=${recoveryBySeason}, viaPlan=${recoveryByPlan}).`), prisma.$disconnect();

    // Checks 2 & 3 — collect every officer id referenced under the duplicate.
    const referenced = new Map<string, string>(); // id -> label
    for (const p of seasonPlans) referenced.set(p.officerId, p.officer.name);
    for (const r of imports) referenced.set(r.officerId, "(import)");
    for (const r of onboarding) if (r.officerId) referenced.set(r.officerId, "(onboarding)");
    for (const e of extensions) referenced.set(e.requestedById, "(extension request)");

    const others = [...referenced.keys()].filter((id) => id !== expected.id);
    if (others.length > 0) {
      const activeOthers = await prisma.user.findMany({ where: { id: { in: others } }, select: { id: true, name: true, isActive: true } });
      console.log(`   Other officers found under duplicate: ${activeOthers.map((u) => `${u.name}(active=${u.isActive})`).join(", ")}`);
      return fail(`duplicate "${dup.name}" references officers other than ${expected.name}. Not safe to delete.`), prisma.$disconnect();
    }

    // Check 2 explicit — every SEASONAL plan officer is the expected one (already implied, but assert clearly).
    const seasonalOffenders = seasonPlans.filter((p) => p.planningType === "SEASONAL" && p.officerId !== expected.id);
    if (seasonalOffenders.length > 0) return fail(`some seasonal plans under "${dup.name}" are not ${expected.name}'s.`), prisma.$disconnect();

    console.log(`   ✅ Checks passed: all data under "${dup.name}" belongs solely to ${expected.name}; no recovery plans; canonical untouched.`);

    if (!APPLY) {
      console.log(`   (dry run) Would delete in order: ${monthlyPlanCount} monthly plan(s) → ${seasonPlans.length} seasonal plan(s) (+cascade) → ${extensions.length} extension(s) → ${imports.length} import(s) → ${onboarding.length} onboarding → ${months.length} month(s) → the season.`);
      continue;
    }

    // --- Delete in one transaction, dependency-ordered. ---
    const planIds = seasonPlans.map((p) => p.id);
    const result = await prisma.$transaction(async (tx) => {
      const mp = await tx.monthlyPlan.deleteMany({ where: { seasonPlanId: { in: planIds } } }); // cascades MonthlyPlanDealer + ApprovalAction(monthlyPlanId)
      const sp = await tx.seasonPlan.deleteMany({ where: { seasonId: dup.id } });                // cascades PlanDealer→PlanLine→MonthlyEntry/Packs + ApprovalAction(seasonPlanId)
      const ext = await tx.monthExtensionRequest.deleteMany({ where: { seasonId: dup.id } });
      const imp = await tx.seasonPlanImportRecord.deleteMany({ where: { seasonId: dup.id } });    // no FK cascade — explicit
      const onb = await tx.onboardingRecord.deleteMany({ where: { seasonId: dup.id } });          // no FK cascade — explicit
      const sm = await tx.seasonMonth.deleteMany({ where: { seasonId: dup.id } });
      await tx.season.delete({ where: { id: dup.id } });
      return { mp: mp.count, sp: sp.count, ext: ext.count, imp: imp.count, onb: onb.count, sm: sm.count };
    });
    console.log(`   ✅ DELETED "${dup.name}" (id ${dup.id}): monthlyPlans=${result.mp}, seasonalPlans=${result.sp}, extensions=${result.ext}, imports=${result.imp}, onboarding=${result.onb}, months=${result.sm}, season=1`);
  }

  if (!APPLY) console.log(`\nDry run complete — no changes written. Re-run with --apply to delete.\n`);
  else console.log(`\n✅ Done. Next: run "npm run db:normalize-seasons" (dry) to confirm no remaining conflicts, then "-- --apply", then apply the unique-index migration.\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
