/**
 * One-time Season Name Normalization.
 *
 * Season names are case-insensitive app-wide. This script brings EXISTING data in line:
 *   1. Canonicalises every season's display name to Title Case ("KHARIF" → "Kharif").
 *   2. Merges case-only duplicate seasons (same lower(name) + same year) — but ONLY when the
 *      duplicates it removes are EMPTY (no plans, recovery, extension requests, onboarding or
 *      import records). Removing an empty season is loss-free (its unused months cascade away).
 *   3. If a case-duplicate has operational data on BOTH sides, it does NOT guess which is correct:
 *      it prints a conflict report and aborts WITHOUT changing anything, so an admin can review
 *      and consolidate the plans manually before re-running.
 *
 * Safe by default: prints what it WOULD do and makes no changes. Pass `--apply` to write.
 * All writes happen in a single transaction (all-or-nothing).
 *
 *   npx tsx scripts/normalize-season-names.ts            # dry run (report only)
 *   npx tsx scripts/normalize-season-names.ts --apply    # perform safe changes
 *
 * After a clean --apply run (no conflicts), apply the DB migration that adds the
 * case-insensitive unique index so duplicates can never be created again.
 */
import { PrismaClient } from "@prisma/client";
import { canonicalSeasonName, seasonNameKey } from "../src/lib/season-name";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

interface SeasonRow {
  id: string;
  name: string;
  year: number;
  createdAt: Date;
  seasonalPlans: number;
  approvedSeasonalPlans: number;
  monthlyPlans: number;
  recoveryPlans: number;
  extensionRequests: number;
  onboardingRecords: number;
  importRecords: number;
}

function hasData(s: SeasonRow): boolean {
  return (
    s.seasonalPlans > 0 ||
    s.recoveryPlans > 0 ||
    s.extensionRequests > 0 ||
    s.onboardingRecords > 0 ||
    s.importRecords > 0
  );
}

async function loadSeasons(): Promise<SeasonRow[]> {
  const seasons = await prisma.season.findMany({ select: { id: true, name: true, year: true, createdAt: true } });
  return Promise.all(
    seasons.map(async (s) => {
      const [seasonalPlans, approvedSeasonalPlans, monthlyPlans, recoveryPlans, extensionRequests, onboardingRecords, importRecords] =
        await Promise.all([
          prisma.seasonPlan.count({ where: { seasonId: s.id, planningType: "SEASONAL" } }),
          prisma.seasonPlan.count({ where: { seasonId: s.id, planningType: "SEASONAL", status: "APPROVED" } }),
          prisma.monthlyPlan.count({ where: { seasonPlan: { seasonId: s.id } } }),
          prisma.recoveryPlan.count({ where: { seasonId: s.id } }),
          prisma.monthExtensionRequest.count({ where: { seasonId: s.id } }),
          prisma.onboardingRecord.count({ where: { seasonId: s.id } }),
          prisma.seasonPlanImportRecord.count({ where: { seasonId: s.id } }),
        ]);
      return { ...s, seasonalPlans, approvedSeasonalPlans, monthlyPlans, recoveryPlans, extensionRequests, onboardingRecords, importRecords };
    }),
  );
}

function fmtCounts(s: SeasonRow): string {
  return `Approved Seasonal Plans: ${s.approvedSeasonalPlans}, Monthly Plans: ${s.monthlyPlans}, Recovery Plans: ${s.recoveryPlans}, Extension Requests: ${s.extensionRequests}, Onboarding: ${s.onboardingRecords}, Imports: ${s.importRecords}`;
}

async function main() {
  console.log(`\n=== Season Name Normalization (${APPLY ? "APPLY" : "DRY RUN"}) ===\n`);
  const seasons = await loadSeasons();

  // Group by canonical key + year.
  const groups = new Map<string, SeasonRow[]>();
  for (const s of seasons) {
    const key = `${seasonNameKey(s.name)}|${s.year}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  const renames: { id: string; from: string; to: string; year: number }[] = [];
  const merges: { survivor: SeasonRow; removed: SeasonRow[]; canonical: string }[] = [];
  const conflicts: SeasonRow[][] = [];

  for (const members of groups.values()) {
    const canonical = canonicalSeasonName(members[0].name);

    if (members.length === 1) {
      const s = members[0];
      if (s.name !== canonical) renames.push({ id: s.id, from: s.name, to: canonical, year: s.year });
      continue;
    }

    const withData = members.filter(hasData);
    if (withData.length > 1) {
      conflicts.push(members);
      continue;
    }

    // Safe merge: at most one member has data. It (or the oldest, if none) survives; the rest are empty.
    const survivor = withData[0] ?? [...members].sort((a, b) => +a.createdAt - +b.createdAt)[0];
    const removed = members.filter((m) => m.id !== survivor.id);
    merges.push({ survivor, removed, canonical });
    if (survivor.name !== canonical) renames.push({ id: survivor.id, from: survivor.name, to: canonical, year: survivor.year });
  }

  // ---- Report ----
  if (conflicts.length > 0) {
    console.log("❌ CONFLICTS — automatic merge skipped to prevent data loss.\n");
    for (const group of conflicts) {
      console.log(`Duplicate detected (year ${group[0].year}): ${group.map((g) => `"${g.name}"`).join(" ↔ ")}`);
      for (const g of group) console.log(`   • "${g.name}"  →  ${fmtCounts(g)}`);
      console.log("   Status: needs manual review — consolidate these plans into one, then re-run.\n");
    }
    console.log("No changes were made. Resolve the conflicts above and run again.\n");
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`Seasons scanned: ${seasons.length}`);
  console.log(`Names to canonicalise: ${renames.length}`);
  console.log(`Empty case-duplicates to merge away: ${merges.reduce((n, m) => n + m.removed.length, 0)}\n`);

  for (const r of renames) console.log(`  rename  [${r.year}] "${r.from}" → "${r.to}"`);
  for (const m of merges) {
    console.log(`  merge   [${m.survivor.year}] keep "${m.canonical}" (id ${m.survivor.id}); remove empties: ${m.removed.map((x) => `"${x.name}"`).join(", ")}`);
  }

  if (!APPLY) {
    console.log("\nDry run — no changes written. Re-run with --apply to perform the changes above.\n");
    await prisma.$disconnect();
    return;
  }

  // ---- Apply (single transaction) ----
  await prisma.$transaction(async (tx) => {
    for (const m of merges) {
      // Empty losers: no plan/recovery/etc. references. Deleting cascades their unused SeasonMonth rows.
      for (const dead of m.removed) await tx.season.delete({ where: { id: dead.id } });
    }
    for (const r of renames) {
      await tx.season.update({ where: { id: r.id }, data: { name: r.to } });
    }
  });

  console.log(`\n✅ Applied: ${renames.length} rename(s), ${merges.reduce((n, m) => n + m.removed.length, 0)} empty duplicate(s) removed.`);
  console.log("Next: run the case-insensitive unique-index migration to prevent future duplicates.\n");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
