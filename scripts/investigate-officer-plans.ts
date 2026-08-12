/**
 * READ-ONLY investigation — prints nothing but SELECTs. Modifies no data.
 *
 * For each named officer + season, shows every SeasonPlan, identifies the one Territory Plan uses
 * (status=APPROVED, isActiveVersion=true, lifecycleState=ACTIVE, planningType=SEASONAL), explains why
 * it ALSO appears in the Approvals inbox, and traces the August aggregation:
 *   SeasonPlan -> PlanDealer -> PlanLine -> MonthlyEntry  (with IDs and values).
 *
 *   npx tsx scripts/investigate-officer-plans.ts
 *   npx tsx scripts/investigate-officer-plans.ts "Kharif" 2026 "August" "Rajesh Kundu" "Chittaranjan"
 */
import { PrismaClient } from "@prisma/client";
import { seasonNameKey } from "../src/lib/season-name";

const prisma = new PrismaClient();
const [seasonArg = "Kharif", yearArg = "2026", monthArg = "August", ...officerArgs] = process.argv.slice(2);
const OFFICERS = officerArgs.length ? officerArgs : ["Rajesh Kundu", "Chittaranjan"];
const KEY = seasonNameKey(seasonArg);
const YEAR = Number(yearArg);

async function main() {
  const seasons = (await prisma.season.findMany({
    where: { year: YEAR, name: { equals: KEY, mode: "insensitive" } },
    select: { id: true, name: true, months: { select: { id: true, name: true, order: true } } },
  })) as { id: string; name: string; months: { id: string; name: string; order: number }[] }[];
  if (seasons.length === 0) return console.log(`No season "${seasonArg}" ${YEAR} found.`), prisma.$disconnect();
  const season = seasons[0];
  const august = season.months.find((m) => m.name.toLowerCase() === monthArg.toLowerCase());
  console.log(`Season: "${season.name}" ${YEAR} (id ${season.id}) — ${monthArg} month id: ${august?.id ?? "NOT FOUND"}\n`);

  for (const name of OFFICERS) {
    const officer = (await prisma.user.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true } })) as { id: string; name: string } | null;
    console.log(`\n══════ ${name} ══════`);
    if (!officer) { console.log("  user not found"); continue; }

    // (1) Every SeasonPlan for this officer + season.
    const plans = (await prisma.seasonPlan.findMany({
      where: { officerId: officer.id, seasonId: season.id },
      orderBy: [{ planningType: "asc" }, { version: "asc" }],
      select: { id: true, version: true, status: true, lifecycleState: true, isActiveVersion: true, planningType: true, revisionRequested: true, createdAt: true, approvedAt: true, submittedAt: true },
    })) as {
      id: string; version: number; status: string; lifecycleState: string; isActiveVersion: boolean;
      planningType: string; revisionRequested: boolean; createdAt: Date; approvedAt: Date | null; submittedAt: Date | null;
    }[];

    for (const p of plans) {
      const usedByTerritory = p.planningType === "SEASONAL" && p.status === "APPROVED" && p.isActiveVersion && p.lifecycleState === "ACTIVE";
      const inApprovals = p.status === "PENDING_ADMIN" || (p.status === "APPROVED" && p.isActiveVersion && p.revisionRequested);
      console.log(
        `  [${p.id}] ${p.planningType} v${p.version} status=${p.status} active=${p.isActiveVersion} lifecycle=${p.lifecycleState} ` +
          `revisionRequested=${p.revisionRequested} created=${p.createdAt.toISOString()} approved=${p.approvedAt?.toISOString() ?? "—"}` +
          `${usedByTerritory ? "  ⟵ TERRITORY PLAN USES THIS" : ""}${inApprovals ? "  ⟵ SHOWN IN APPROVALS" : ""}`,
      );
    }

    // (2/3) The plan Territory Plan selects.
    const selected = plans.find((p) => p.planningType === "SEASONAL" && p.status === "APPROVED" && p.isActiveVersion && p.lifecycleState === "ACTIVE");
    if (!selected) { console.log("  → Territory Plan selects: NONE (officer excluded from group totals)"); continue; }
    console.log(`  → Territory Plan selects SeasonPlan ${selected.id} (SEASONAL, APPROVED, active, ACTIVE)`);
    console.log(`  → Same plan appears in Approvals? ${selected.revisionRequested ? "YES — revisionRequested=true (a revision was requested on the approved plan)" : "no (via this plan)"}`);

    // THE DIVERGENCE, on this exact plan: the per-officer Product Plan selector lists only months with an
    // APPROVED MonthlyPlan; Territory Plan lists every month that has MonthlyEntry data under the plan.
    const nameById = new Map(season.months.map((m) => [m.id, m.name] as const));
    const approvedMonthly = (await prisma.monthlyPlan.findMany({ where: { seasonPlanId: selected.id, status: "APPROVED" }, select: { seasonMonthId: true } })) as { seasonMonthId: string }[];
    const entryMonths = (await prisma.monthlyEntry.findMany({ where: { planLine: { planDealer: { seasonPlanId: selected.id } } }, select: { seasonMonthId: true }, distinct: ["seasonMonthId"] })) as { seasonMonthId: string }[];
    console.log(`  → Months with APPROVED MonthlyPlan (what the per-officer Product Plan offers): ${approvedMonthly.map((a) => nameById.get(a.seasonMonthId) ?? a.seasonMonthId).join(", ") || "none"}`);
    console.log(`  → Months with MonthlyEntry data (what Territory Plan sums): ${entryMonths.map((e) => nameById.get(e.seasonMonthId) ?? e.seasonMonthId).join(", ") || "none"}`);

    // (6) August aggregation trace for the selected plan.
    if (!august) { console.log("  (no August month to trace)"); continue; }
    const dealers = (await prisma.planDealer.findMany({ where: { seasonPlanId: selected.id }, select: { id: true, dealer: { select: { name: true } } } })) as { id: string; dealer: { name: string } }[];
    const entries = (await prisma.monthlyEntry.findMany({
      where: { seasonMonthId: august.id, planLine: { planDealer: { seasonPlanId: selected.id } } },
      select: { id: true, planLineId: true, planQty: true, saleQty: true, planValue: true, saleValue: true, planLine: { select: { planDealerId: true, product: { select: { name: true } } } } },
    })) as { id: string; planLineId: string; planQty: number; saleQty: number; planValue: unknown; saleValue: unknown; planLine: { planDealerId: string; product: { name: string } } }[];

    console.log(`     PlanDealers (${dealers.length}): ${dealers.map((d) => `${d.id}[${d.dealer.name}]`).join(", ") || "none"}`);
    console.log(`     [SOURCE OF TERRITORY VALUES] ${monthArg} MonthlyEntries (${entries.length}) under SeasonPlan ${selected.id}:`);
    for (const e of entries)
      console.log(`        entry=${e.id} planLine=${e.planLineId} (${e.planLine.product.name}) planDealer=${e.planLine.planDealerId} planQty=${e.planQty} saleQty=${e.saleQty} planValue=${e.planValue} saleValue=${e.saleValue}`);

    // Contrast: the MonthlyPlan approval wrapper(s) for this month — what the "Plans" page shows.
    // NOTE: Territory Plan does NOT read these; they gate approval only, not the values above.
    const monthlyPlans = (await prisma.monthlyPlan.findMany({
      where: { officerId: officer.id, seasonMonthId: august.id },
      select: { id: true, seasonPlanId: true, status: true, lifecycleState: true },
    })) as { id: string; seasonPlanId: string; status: string; lifecycleState: string }[];
    console.log(`     [APPROVAL WRAPPER — shown on Plans page, NOT used by Territory Plan] ${monthArg} MonthlyPlan rows (${monthlyPlans.length}):`);
    for (const mp of monthlyPlans)
      console.log(`        monthlyPlan=${mp.id} seasonPlan=${mp.seasonPlanId} status=${mp.status} lifecycle=${mp.lifecycleState}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
