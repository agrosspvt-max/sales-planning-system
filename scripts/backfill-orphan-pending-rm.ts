/**
 * Backfill: correct plans STUCK at "Pending for RM" whose Sales Officer currently has NO applicable RM.
 *
 * WHY: a plan submitted while an RM existed correctly entered PENDING_RM; if that RM was later removed (or
 * the officer never had one and a prior bug still routed them to PENDING_RM), the plan now waits for an
 * approver who does not exist. Such plans should sit with the Admin instead (PENDING_ADMIN / PENDING_APPROVAL).
 *
 * SELECTION (strict): a record is corrected ONLY when BOTH hold —
 *   1. its current status is exactly PENDING_RM, AND
 *   2. its owner currently resolves to NO RM via the SAME authority the app uses at submit time
 *      (getCurrentManagerId): the officer has no group, or the officer's group has no active, non-deleted
 *      REGIONAL_MANAGER other than the officer themselves.
 * Records whose officer currently HAS an RM are LEFT UNCHANGED. Approved / Converted / Enrolled / Draft /
 * Returned / Rejected and every other status are never touched.
 *
 * SAFETY: read-only by default — it prints a per-module count and does nothing else. It mutates ONLY when
 * run with `--apply`, and then each change is made in a transaction together with an AuditLog row (the
 * app's existing audit mechanism). No schema change; no new RM system; the RM relationship is read, never
 * written.
 *
 *   npx tsx scripts/backfill-orphan-pending-rm.ts            # DRY RUN — counts only, no writes
 *   npx tsx scripts/backfill-orphan-pending-rm.ts --apply    # perform the correction (transactional + audited)
 *   npx tsx scripts/backfill-orphan-pending-rm.ts --apply --actor <superAdminUserId>   # attribute the audit rows
 */
import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const actorArg = (() => { const i = process.argv.indexOf("--actor"); return i >= 0 ? process.argv[i + 1] : undefined; })();

/**
 * Owners (by id) that currently have NO applicable RM — mirrors getCurrentManagerId exactly, in bulk.
 * An owner has an RM iff their group has an active, non-deleted REGIONAL_MANAGER whose id != the owner.
 */
async function ownersWithoutRm(ownerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(ownerIds)];
  if (ids.length === 0) return new Set();
  const owners = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, groupId: true } });
  const rms = await prisma.user.findMany({
    where: { role: Role.REGIONAL_MANAGER, isActive: true, deletedAt: null, groupId: { not: null } },
    select: { id: true, groupId: true },
  });
  const rmsByGroup = new Map<string, string[]>();
  for (const rm of rms) rmsByGroup.set(rm.groupId!, [...(rmsByGroup.get(rm.groupId!) ?? []), rm.id]);
  const noRm = new Set<string>();
  for (const o of owners) {
    const groupRms = o.groupId ? rmsByGroup.get(o.groupId) ?? [] : [];
    const hasRm = groupRms.some((rmId) => rmId !== o.id); // id != officerId guard, as in getCurrentManagerId
    if (!hasRm) noRm.add(o.id);
  }
  return noRm;
}

async function resolveActor(): Promise<string> {
  if (actorArg) return actorArg;
  const admin = await prisma.user.findFirst({ where: { role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }, select: { id: true } });
  if (!admin) throw new Error("No active Super Admin found to attribute the audit rows — pass --actor <userId>.");
  return admin.id;
}

type ModuleReport = { label: string; total: number; orphaned: number; ids: string[] };

async function main() {
  const reports: ModuleReport[] = [];

  /* ---- Seasonal + Yearly (SeasonPlan.status, split by planningType) ---- */
  for (const [label, planningType] of [["Seasonal", "SEASONAL"], ["Yearly", "YEARLY"]] as const) {
    const rows = await prisma.seasonPlan.findMany({ where: { status: "PENDING_RM", planningType }, select: { id: true, officerId: true } });
    const noRm = await ownersWithoutRm(rows.map((r) => r.officerId));
    const ids = rows.filter((r) => noRm.has(r.officerId)).map((r) => r.id);
    reports.push({ label, total: rows.length, orphaned: ids.length, ids });
    if (APPLY && ids.length) {
      const actor = await resolveActor();
      for (const id of ids) {
        await prisma.$transaction(async (tx) => {
          await tx.seasonPlan.update({ where: { id }, data: { status: "PENDING_ADMIN" } });
          await tx.auditLog.create({ data: { userId: actor, action: "UPDATE", entity: "seasonPlan", entityId: id, summary: `RM-routing backfill: officer has no RM → PENDING_RM → PENDING_ADMIN (${label})` } });
        });
      }
    }
  }

  /* ---- Monthly (MonthlyPlan.status) ---- */
  {
    const rows = await prisma.monthlyPlan.findMany({ where: { status: "PENDING_RM" }, select: { id: true, officerId: true } });
    const noRm = await ownersWithoutRm(rows.map((r) => r.officerId));
    const ids = rows.filter((r) => noRm.has(r.officerId)).map((r) => r.id);
    reports.push({ label: "Monthly", total: rows.length, orphaned: ids.length, ids });
    if (APPLY && ids.length) {
      const actor = await resolveActor();
      for (const id of ids) {
        await prisma.$transaction(async (tx) => {
          await tx.monthlyPlan.update({ where: { id }, data: { status: "PENDING_ADMIN" } });
          await tx.auditLog.create({ data: { userId: actor, action: "UPDATE", entity: "monthlyPlan", entityId: id, summary: "RM-routing backfill: officer has no RM → PENDING_RM → PENDING_ADMIN (Monthly)" } });
        });
      }
    }
  }

  /* ---- Recovery (RecoveryPlan.status) ---- */
  {
    const rows = await prisma.recoveryPlan.findMany({ where: { status: "PENDING_RM" }, select: { id: true, officerId: true } });
    const noRm = await ownersWithoutRm(rows.map((r) => r.officerId));
    const ids = rows.filter((r) => noRm.has(r.officerId)).map((r) => r.id);
    reports.push({ label: "Recovery", total: rows.length, orphaned: ids.length, ids });
    if (APPLY && ids.length) {
      const actor = await resolveActor();
      for (const id of ids) {
        await prisma.$transaction(async (tx) => {
          await tx.recoveryPlan.update({ where: { id }, data: { status: "PENDING_ADMIN" } });
          await tx.auditLog.create({ data: { userId: actor, action: "UPDATE", entity: "recoveryPlan", entityId: id, summary: "RM-routing backfill: officer has no RM → PENDING_RM → PENDING_ADMIN (Recovery)" } });
        });
      }
    }
  }

  /* ---- Scheme (DealerSchemePlan.planStatus; dual-write legacy planningStatus per the skip-RM convention) ---- */
  {
    const rows = await prisma.dealerSchemePlan.findMany({ where: { planStatus: "PENDING_RM" }, select: { id: true, salesOfficerId: true } });
    const noRm = await ownersWithoutRm(rows.map((r) => r.salesOfficerId));
    const ids = rows.filter((r) => noRm.has(r.salesOfficerId)).map((r) => r.id);
    reports.push({ label: "Scheme", total: rows.length, orphaned: ids.length, ids });
    if (APPLY && ids.length) {
      const actor = await resolveActor();
      for (const id of ids) {
        await prisma.$transaction(async (tx) => {
          // Matches the "skip RM" mapping used by submitSchemePlan: PENDING_APPROVAL + legacy RM_APPROVED,
          // rmActedById stays null (no RM acted). Nothing else on the record is touched.
          await tx.dealerSchemePlan.update({ where: { id }, data: { planStatus: "PENDING_APPROVAL", planningStatus: "RM_APPROVED" } });
          await tx.auditLog.create({ data: { userId: actor, action: "UPDATE", entity: "dealerSchemePlan", entityId: id, summary: "RM-routing backfill: officer has no RM → PENDING_RM → PENDING_APPROVAL (Scheme)" } });
        });
      }
    }
  }

  /* ---- Report ---- */
  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN (no writes)"} — orphaned Pending-for-RM records (officer currently has NO RM):\n`);
  let totalOrphan = 0;
  for (const r of reports) {
    totalOrphan += r.orphaned;
    console.log(`  ${r.label.padEnd(9)}: ${r.orphaned} orphaned  (of ${r.total} total at PENDING_RM)`);
  }
  console.log(`  ${"Other".padEnd(9)}: 0 orphaned  (no other SO→RM submission flow exists; CN Requests have no RM-blocking state)`);
  console.log(`\n  TOTAL to correct: ${totalOrphan}`);
  if (!APPLY && totalOrphan > 0) console.log(`\n  Re-run with --apply to correct these ${totalOrphan} record(s) (transactional + audited).`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
