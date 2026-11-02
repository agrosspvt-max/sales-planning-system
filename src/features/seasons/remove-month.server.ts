import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { calendarPeriod, identity, monthLabel } from "@/lib/season-calendar";

const schema = z.object({ targetMonthId: z.string().min(1) }).strict();
type Tx = Prisma.TransactionClient;
function assertManager(ctx: AuthContext) {
  if (!isAdministrativeRole(ctx.role))
    throw new ApiError(403, "Only an administrative account can remove season months.");
}
function conflict(message: string): never {
  throw new ApiError(409, `${message} Nothing was transferred or removed.`);
}
const key = (...parts: string[]) => JSON.stringify(parts);

// Header merges must not silently promote, reopen or replace an approval decision.
function compatible(a: object, b: object, fields: string[], label: string) {
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  if (fields.some((f) => JSON.stringify(left[f]) !== JSON.stringify(right[f]))) {
    conflict(`${label}: the two plans have different approval, lifecycle or cutoff settings.`);
  }
}
const lifecycleFields = [
  "status",
  "lifecycleState",
  "lifecycleFromParent",
  "closedAt",
  "deactivatedAt",
];
const partyFields = [
  "approvalStatus",
  "rejectionStage",
  "rejectionReason",
  "rmDecidedById",
  "adminDecidedById",
];

/** Fixed identifiers only; values always bound. Chunked to avoid one round trip per product/dealer. */
async function relink(tx: Tx, table: string, column: string, pairs: { id: string; to: string }[]) {
  const allowed = new Set([
    "MonthlyEntry.planLineId",
    "MonthlyPlan.seasonPlanId",
    "RecoveryPlan.seasonPlanId",
    "PartyMonthlyPlan.seasonalPlanId",
    "PartyMonthlyPlan.sheetId",
  ]);
  if (!allowed.has(`${table}.${column}`)) throw new Error("Unsupported month-transfer mapping");
  for (let i = 0; i < pairs.length; i += 500) {
    const values = pairs.slice(i, i + 500).map((p) => Prisma.sql`(${p.id}, ${p.to})`);
    await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} AS t
      SET ${Prisma.raw(`"${column}"`)} = v.target FROM (VALUES ${Prisma.join(values)}) AS v(id, target)
      WHERE t.id = v.id`);
  }
}

/** Read-only options. Removal always requires another OPEN season with the exact calendar identity. */
export async function getRemoveMonthOptions(ctx: AuthContext, seasonId: string, monthId: string) {
  assertManager(ctx);
  const source = await prisma.seasonMonth.findFirst({
    where: { id: monthId, seasonId },
    include: {
      season: { include: { _count: { select: { months: true } } } },
      _count: {
        select: {
          monthlyEntries: true,
          monthlyPlans: true,
          recoveryPlans: true,
          partyMonthlyPlans: true,
          partyMonthlySheets: true,
        },
      },
    },
  });
  if (!source) throw new ApiError(404, "Season month not found.");
  if (source.season.status !== "OPEN") conflict("Reopen the source season first.");
  if (!identity(source))
    conflict("The month has no verified calendar month/year. Review it first.");
  if (source.season._count.months < 2) conflict("The last month of a season cannot be removed.");
  const targets = await prisma.seasonMonth.findMany({
    where: {
      seasonId: { not: seasonId },
      calendarMonth: source.calendarMonth,
      calendarYear: source.calendarYear,
      season: { status: "OPEN" },
    },
    select: { id: true, season: { select: { id: true, name: true, year: true } } },
    orderBy: { seasonId: "asc" },
  });
  return {
    source: { id: source.id, label: monthLabel(source) },
    counts: source._count,
    targets: targets.map((t) => ({
      id: t.id,
      seasonId: t.season.id,
      label: `${t.season.name} ${t.season.year}`,
    })),
  };
}

/**
 * Remove one calendar month by transferring its operational rows, never its seasonal totals.
 * IDs on entries, options, weekly plans and history survive. Only duplicate compatible headers
 * are consolidated; their full original headers and ID mappings are recorded in the audit.
 * Serializable + season/month locks protect against concurrent imports, edits and removals.
 */
export async function removeSeasonMonth(
  ctx: AuthContext,
  seasonId: string,
  monthId: string,
  raw: unknown,
) {
  assertManager(ctx);
  const { targetMonthId } = schema.parse(raw);
  try {
    return await prisma.$transaction(
      async (tx) => {
        const initial = await tx.seasonMonth.findMany({
          where: { id: { in: [monthId, targetMonthId] } },
        });
        const from = initial.find((m) => m.id === monthId),
          to = initial.find((m) => m.id === targetMonthId);
        if (!from || from.seasonId !== seasonId)
          throw new ApiError(404, "The source month no longer exists. Refresh the season.");
        if (
          !to ||
          to.seasonId === seasonId ||
          !identity(from) ||
          !identity(to) ||
          to.calendarMonth !== from.calendarMonth ||
          to.calendarYear !== from.calendarYear
        ) {
          conflict("Choose a different season containing the exact same calendar month and year.");
        }
        const seasonIds = [seasonId, to.seasonId].sort();
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "Season" WHERE id IN (${Prisma.join(seasonIds)}) ORDER BY id FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "SeasonMonth" WHERE id IN (${Prisma.join([monthId, targetMonthId].sort())}) ORDER BY id FOR UPDATE`,
        );
        const seasons = await tx.season.findMany({
          where: { id: { in: seasonIds } },
          include: { months: true },
        });
        const sourceSeason = seasons.find((s) => s.id === seasonId)!,
          targetSeason = seasons.find((s) => s.id === to.seasonId)!;
        if (seasons.length !== 2 || seasons.some((s) => s.status !== "OPEN"))
          conflict("Both seasons must be open.");
        const remaining = sourceSeason.months.filter((m) => m.id !== monthId);
        if (!remaining.length) conflict("The last month of a season cannot be removed.");
        if (remaining.some((m) => !identity(m)))
          conflict("The remaining months need calendar identity review first.");

        // Read both scopes once. No per-dealer lookup loop and no network work in this transaction.
        const [entries, monthly, recovery, partySheets, partyRows, receiptImports, jobs] =
          await Promise.all([
            tx.monthlyEntry.findMany({
              where: { seasonMonthId: { in: [monthId, targetMonthId] } },
              include: { planLine: { include: { planDealer: { include: { seasonPlan: true } } } } },
            }),
            tx.monthlyPlan.findMany({
              where: { seasonMonthId: { in: [monthId, targetMonthId] } },
              include: { dealerStates: true, seasonPlan: true },
            }),
            tx.recoveryPlan.findMany({
              where: { seasonMonthId: { in: [monthId, targetMonthId] } },
              include: {
                dealers: { select: { id: true, dealerId: true } },
                snapshots: true,
                weekLocks: true,
                seasonPlan: { select: { seasonId: true, officerId: true, planningType: true } },
              },
            }),
            tx.partyMonthlySheet.findMany({
              where: { seasonMonthId: { in: [monthId, targetMonthId] } },
            }),
            tx.partyMonthlyPlan.findMany({
              where: { seasonMonthId: { in: [monthId, targetMonthId] } },
              include: { seasonalPlan: true },
            }),
            tx.lastPaymentImport.findMany({
              where: { kind: "REGULAR", scopeKey: { in: [monthId, targetMonthId] } },
              select: {
                id: true,
                scopeKey: true,
                fileHash: true,
                isActive: true,
                receipts: { select: { dealerId: true } },
              },
            }),
            tx.lastPaymentJob.findMany({
              where: { scopeKey: { in: [monthId, targetMonthId] }, status: { not: "DONE" } },
              select: { id: true },
            }),
          ]);
        if (jobs.length)
          conflict(
            "Finish or retry pending Last Payment processing for these months before transferring.",
          );
        const oldEntries = entries.filter((e) => e.seasonMonthId === monthId);
        const oldMonthly = monthly.filter((p) => p.seasonMonthId === monthId);
        const oldRecovery = recovery.filter((p) => p.seasonMonthId === monthId);
        const oldParty = partyRows.filter((p) => p.seasonMonthId === monthId);
        const oldSheets = partySheets.filter((p) => p.seasonMonthId === monthId);
        const people = await tx.user.findMany({
          where: {
            id: {
              in: [
                ...new Set([
                  ...entries.map((e) => e.planLine.planDealer.seasonPlan.officerId),
                  ...monthly.map((p) => p.officerId),
                  ...recovery.map((p) => p.officerId),
                  ...partyRows.map((p) => p.ownerId),
                ]),
              ],
            },
          },
          select: { id: true, name: true },
        });
        const names = new Map(people.map((p) => [p.id, p.name]));
        const officerName = (id: string) => names.get(id) ?? "Unknown officer";
        const expectedSeason = (id: string) => (id === monthId ? seasonId : to.seasonId);
        for (const e of entries) {
          if (e.planLine.planDealer.seasonPlan.seasonId !== expectedSeason(e.seasonMonthId))
            conflict(`Sales entry ${e.id} has inconsistent season links.`);
        }
        for (const p of monthly) {
          if (
            p.seasonPlan.seasonId !== expectedSeason(p.seasonMonthId) ||
            p.officerId !== p.seasonPlan.officerId
          )
            conflict(`Monthly plan ${p.id} has inconsistent season/owner links.`);
        }
        for (const p of recovery) {
          if (
            p.seasonId !== expectedSeason(p.seasonMonthId) ||
            (p.seasonPlan &&
              (p.seasonPlan.seasonId !== p.seasonId ||
                p.seasonPlan.officerId !== p.officerId ||
                p.seasonPlan.planningType !== "SEASONAL"))
          )
            conflict(`Recovery plan ${p.id} has inconsistent season/owner links.`);
        }
        for (const s of partySheets) {
          if (s.seasonId !== expectedSeason(s.seasonMonthId))
            conflict(`Party sheet ${s.id} has inconsistent season links.`);
        }
        for (const p of partyRows) {
          const sheet = partySheets.find((s) => s.id === p.sheetId);
          if (
            !sheet ||
            sheet.seasonMonthId !== p.seasonMonthId ||
            sheet.ownerId !== p.ownerId ||
            p.seasonId !== expectedSeason(p.seasonMonthId) ||
            p.seasonalPlan.seasonId !== p.seasonId ||
            p.seasonalPlan.ownerId !== p.ownerId ||
            p.seasonalPlan.marketId !== p.marketId
          )
            conflict(`Party plan ${p.id} has inconsistent season/owner links.`);
        }
        const retired: object[] = [];
        const mappings: { kind: string; from: string; to: string }[] = [];

        const required = new Map<string, { officerId: string; planningType: string }>();
        for (const p of [
          ...oldEntries.map((e) => e.planLine.planDealer.seasonPlan),
          ...oldMonthly.map((m) => m.seasonPlan),
        ]) {
          if (p.seasonId !== seasonId)
            conflict(`Sales plan ${p.id} has inconsistent season links.`);
          required.set(key(p.officerId, p.planningType), p);
        }
        for (const p of oldRecovery) {
          if (p.seasonId !== seasonId)
            conflict(`Recovery plan ${p.id} has inconsistent season links.`);
          required.set(key(p.officerId, "SEASONAL"), {
            officerId: p.officerId,
            planningType: "SEASONAL",
          });
        }
        const targets = await tx.seasonPlan.findMany({
          where: {
            seasonId: to.seasonId,
            officerId: { in: [...required.values()].map((p) => p.officerId) },
          },
          orderBy: [{ isActiveVersion: "desc" }, { version: "desc" }],
        });
        const parentByKey = new Map<string, string>();
        const newParents: Prisma.SeasonPlanCreateManyInput[] = [];
        for (const [k, p] of required) {
          const matching = targets.filter(
            (t) => t.officerId === p.officerId && t.planningType === p.planningType,
          );
          // A month already present in a particular destination version must keep that
          // version; blindly choosing the newest would split one month's actuals.
          const usedIds = new Set([
            ...entries
              .filter(
                (e) =>
                  e.seasonMonthId === targetMonthId &&
                  e.planLine.planDealer.seasonPlan.officerId === p.officerId &&
                  e.planLine.planDealer.seasonPlan.planningType === p.planningType,
              )
              .map((e) => e.planLine.planDealer.seasonPlanId),
            ...monthly
              .filter(
                (m) =>
                  m.seasonMonthId === targetMonthId &&
                  m.officerId === p.officerId &&
                  m.seasonPlan.planningType === p.planningType,
              )
              .map((m) => m.seasonPlanId),
            ...(p.planningType === "SEASONAL"
              ? recovery
                  .filter(
                    (r) =>
                      r.seasonMonthId === targetMonthId &&
                      r.officerId === p.officerId &&
                      r.seasonPlanId,
                  )
                  .map((r) => r.seasonPlanId!)
              : []),
          ]);
          if (usedIds.size > 1)
            conflict(
              `${officerName(p.officerId)} has destination-month data in multiple seasonal plan versions.`,
            );
          const eligible = matching.filter(
            (t) => t.lifecycleState === "ACTIVE" && (!usedIds.size || usedIds.has(t.id)),
          );
          if (usedIds.size && !eligible.length)
            conflict(
              `${officerName(p.officerId)} has destination-month data under a closed, deactivated or inconsistent seasonal plan.`,
            );
          if (eligible.filter((t) => t.isActiveVersion).length > 1)
            conflict(`${officerName(p.officerId)} has multiple active destination seasonal plans.`);
          let id = eligible[0]?.id;
          if (!id) {
            id = randomUUID();
            newParents.push({
              id,
              seasonId: to.seasonId,
              officerId: p.officerId,
              planningType: p.planningType,
              version: Math.max(0, ...matching.map((t) => t.version)) + 1,
              status: "DRAFT",
              isActiveVersion: false,
              description: `Created for ${monthLabel(from)} transfer from ${sourceSeason.name} ${sourceSeason.year}`,
            });
          }
          parentByKey.set(k, id);
        }
        if (newParents.length) await tx.seasonPlan.createMany({ data: newParents });
        const parentId = (officer: string, type = "SEASONAL") =>
          parentByKey.get(key(officer, type))!;

        // Monthly entries need target-season product lines, never dangling references into the old season.
        const dealerTargets = await tx.planDealer.findMany({
          where: { seasonPlanId: { in: [...parentByKey.values()] } },
          include: { lines: true },
        });
        const dealerByKey = new Map(
          dealerTargets.map((d) => [key(d.seasonPlanId, d.dealerId), d.id]),
        );
        const lineByKey = new Map(
          dealerTargets.flatMap((d) =>
            d.lines.map((l) => [key(d.seasonPlanId, d.dealerId, l.productId), l.id] as const),
          ),
        );
        const newDealers: Prisma.PlanDealerCreateManyInput[] = [],
          newLines: Prisma.PlanLineCreateManyInput[] = [];
        // No-Plan states and recovery-only dealers also need a destination parent grouping,
        // even when they have no sales entry. Never copy the old season's planned totals.
        for (const p of oldMonthly) {
          for (const state of p.dealerStates) {
            const targetPlanId = parentId(p.officerId, p.seasonPlan.planningType),
              dk = key(targetPlanId, state.dealerId);
            if (!dealerByKey.has(dk)) {
              const id = randomUUID();
              dealerByKey.set(dk, id);
              newDealers.push({
                id,
                seasonPlanId: targetPlanId,
                dealerId: state.dealerId,
                fromMonthlyPlan: true,
              });
            }
          }
        }
        for (const p of oldRecovery) {
          for (const dealer of p.dealers) {
            const targetPlanId = parentId(p.officerId),
              dk = key(targetPlanId, dealer.dealerId);
            if (!dealerByKey.has(dk)) {
              const id = randomUUID();
              dealerByKey.set(dk, id);
              newDealers.push({
                id,
                seasonPlanId: targetPlanId,
                dealerId: dealer.dealerId,
                fromMonthlyPlan: true,
              });
            }
          }
        }
        for (const e of oldEntries) {
          const pd = e.planLine.planDealer,
            p = pd.seasonPlan,
            targetPlanId = parentId(p.officerId, p.planningType);
          const dk = key(targetPlanId, pd.dealerId),
            lk = key(targetPlanId, pd.dealerId, e.planLine.productId);
          if (!dealerByKey.has(dk)) {
            const id = randomUUID();
            dealerByKey.set(dk, id);
            newDealers.push({
              id,
              seasonPlanId: targetPlanId,
              dealerId: pd.dealerId,
              fromMonthlyPlan: true,
            });
          }
          if (!lineByKey.has(lk)) {
            const id = randomUUID();
            lineByKey.set(lk, id);
            newLines.push({
              id,
              planDealerId: dealerByKey.get(dk)!,
              productId: e.planLine.productId,
              rateSnapshot: e.planLine.rateSnapshot,
              nbvPercentSnapshot: e.planLine.nbvPercentSnapshot,
              inputMode: e.planLine.inputMode,
              isAdditional: true,
              isAutoAdded: e.planLine.isAutoAdded,
            });
          }
        }
        const occupied = new Set(
          entries.filter((e) => e.seasonMonthId === targetMonthId).map((e) => e.planLineId),
        );
        const lineMoves: { id: string; to: string }[] = [];
        for (const e of oldEntries) {
          const pd = e.planLine.planDealer,
            p = pd.seasonPlan;
          const id = lineByKey.get(
            key(parentId(p.officerId, p.planningType), pd.dealerId, e.planLine.productId),
          )!;
          if (occupied.has(id)) {
            const [dealer, product] = await Promise.all([
              tx.dealer.findUnique({ where: { id: pd.dealerId }, select: { name: true } }),
              tx.product.findUnique({
                where: { id: e.planLine.productId },
                select: { name: true },
              }),
            ]);
            conflict(
              `Sales overlap for ${dealer?.name ?? "this dealer"}, ${product?.name ?? "this product"} (${officerName(p.officerId)}).`,
            );
          }
          occupied.add(id);
          lineMoves.push({ id: e.id, to: id });
        }
        if (newDealers.length) await tx.planDealer.createMany({ data: newDealers });
        if (newLines.length) await tx.planLine.createMany({ data: newLines });
        await relink(tx, "MonthlyEntry", "planLineId", lineMoves);
        await tx.monthlyEntry.updateMany({
          where: { seasonMonthId: monthId },
          data: { seasonMonthId: targetMonthId },
        });

        const targetMonthly = new Map(
          monthly.filter((m) => m.seasonMonthId === targetMonthId).map((m) => [m.seasonPlanId, m]),
        );
        const monthlyMoves: { id: string; to: string }[] = [];
        for (const p of oldMonthly) {
          const targetPlanId = parentId(p.officerId, p.seasonPlan.planningType),
            dest = targetMonthly.get(targetPlanId);
          if (dest) {
            compatible(p, dest, lifecycleFields, officerName(p.officerId));
            if (
              p.dealerStates.some((s) => dest.dealerStates.some((d) => d.dealerId === s.dealerId))
            )
              conflict(`Monthly dealer-state overlap for ${officerName(p.officerId)}.`);
            await tx.monthlyPlanDealer.updateMany({
              where: { monthlyPlanId: p.id },
              data: { monthlyPlanId: dest.id },
            });
            await tx.approvalAction.updateMany({
              where: { monthlyPlanId: p.id, seasonPlanId: { not: null } },
              data: { seasonPlanId: targetPlanId },
            });
            await tx.approvalAction.updateMany({
              where: { monthlyPlanId: p.id },
              data: { monthlyPlanId: dest.id },
            });
            retired.push(p);
            mappings.push({ kind: "MonthlyPlan", from: p.id, to: dest.id });
            await tx.monthlyPlan.delete({ where: { id: p.id } });
            dest.dealerStates.push(...p.dealerStates);
          } else {
            monthlyMoves.push({ id: p.id, to: targetPlanId });
            targetMonthly.set(targetPlanId, p);
          }
        }
        await relink(tx, "MonthlyPlan", "seasonPlanId", monthlyMoves);
        if (monthlyMoves.length) {
          const ids = monthlyMoves.map((p) => p.id);
          await tx.monthlyPlan.updateMany({
            where: { id: { in: ids } },
            data: { seasonMonthId: targetMonthId },
          });
          await tx.$executeRaw(Prisma.sql`UPDATE "ApprovalAction" a SET "seasonPlanId" = p."seasonPlanId"
            FROM "MonthlyPlan" p WHERE a."monthlyPlanId" = p.id AND p.id IN (${Prisma.join(ids)}) AND a."seasonPlanId" IS NOT NULL`);
        }

        const targetRecovery = new Map(
          recovery.filter((p) => p.seasonMonthId === targetMonthId).map((p) => [p.officerId, p]),
        );
        const recoveryMoves: { id: string; to: string }[] = [];
        for (const p of oldRecovery) {
          const dest = targetRecovery.get(p.officerId);
          if (!dest) {
            recoveryMoves.push({ id: p.id, to: parentId(p.officerId) });
            targetRecovery.set(p.officerId, p);
            continue;
          }
          compatible(
            p,
            dest,
            [...lifecycleFields, "cutoffDate", "weeklyEditEnabled"],
            `Recovery — ${officerName(p.officerId)}`,
          );
          if (p.dealers.some((d) => dest.dealers.some((x) => x.dealerId === d.dealerId)))
            conflict(`Recovery dealer overlap for ${officerName(p.officerId)}.`);
          // Upload snapshots are historical files, not additive balances. Their week
          // identity must not be rewritten or combined into another file's history.
          for (const s of p.snapshots) {
            const ds = dest.snapshots.find((x) => x.weekNo === s.weekNo);
            if (ds)
              conflict(
                `Both recovery plans contain an aging upload for week ${s.weekNo} (${officerName(p.officerId)}). Reconcile those overlapping upload histories first.`,
              );
            await tx.agingSnapshot.update({
              where: { id: s.id },
              data: { recoveryPlanId: dest.id },
            });
          }
          for (const lock of p.weekLocks) {
            const dl = dest.weekLocks.find((l) => l.weekNo === lock.weekNo);
            if (dl && dl.locked !== lock.locked)
              conflict(`Recovery week ${lock.weekNo} has conflicting locks.`);
            if (dl) {
              retired.push(lock);
              await tx.recoveryWeekLock.delete({ where: { id: lock.id } });
            } else
              await tx.recoveryWeekLock.update({
                where: { id: lock.id },
                data: { recoveryPlanId: dest.id },
              });
          }
          await tx.recoveryPlanDealer.updateMany({
            where: { recoveryPlanId: p.id },
            data: { recoveryPlanId: dest.id },
          });
          await tx.approvalAction.updateMany({
            where: { recoveryPlanId: p.id, seasonPlanId: { not: null } },
            data: { seasonPlanId: parentId(p.officerId) },
          });
          await tx.approvalAction.updateMany({
            where: { recoveryPlanId: p.id },
            data: { recoveryPlanId: dest.id },
          });
          retired.push(p);
          mappings.push({ kind: "RecoveryPlan", from: p.id, to: dest.id });
          await tx.recoveryPlan.delete({ where: { id: p.id } });
        }
        await relink(tx, "RecoveryPlan", "seasonPlanId", recoveryMoves);
        if (recoveryMoves.length) {
          const ids = recoveryMoves.map((p) => p.id);
          await tx.recoveryPlan.updateMany({
            where: { id: { in: ids } },
            data: { seasonId: to.seasonId, seasonMonthId: targetMonthId },
          });
          await tx.$executeRaw(Prisma.sql`UPDATE "ApprovalAction" a SET "seasonPlanId" = p."seasonPlanId"
            FROM "RecoveryPlan" p WHERE a."recoveryPlanId" = p.id AND p.id IN (${Prisma.join(ids)}) AND a."seasonPlanId" IS NOT NULL`);
        }

        // Party Planning retains monthly item/option/event IDs and their Daily Work references.
        const ownerIds = [...new Set(oldParty.map((p) => p.ownerId))];
        const seasonalSheets = await tx.seasonalPlanSheet.findMany({
          where: { seasonId: to.seasonId, ownerId: { in: ownerIds } },
        });
        const sheetByOwner = new Map(seasonalSheets.map((s) => [s.ownerId, s.id]));
        const newSeasonalSheets = ownerIds
          .filter((id) => !sheetByOwner.has(id))
          .map((ownerId) => {
            const id = randomUUID();
            sheetByOwner.set(ownerId, id);
            return { id, ownerId, seasonId: to.seasonId };
          });
        if (newSeasonalSheets.length)
          await tx.seasonalPlanSheet.createMany({ data: newSeasonalSheets });
        const seasonalMarkets = await tx.seasonalPlan.findMany({
          where: { seasonId: to.seasonId, ownerId: { in: ownerIds } },
          orderBy: { createdAt: "desc" },
        });
        const marketByKey = new Map<string, string>();
        const newMarkets: Prisma.SeasonalPlanCreateManyInput[] = [];
        for (const p of oldParty) {
          if (
            p.seasonId !== seasonId ||
            p.seasonalPlan.seasonId !== seasonId ||
            p.seasonalPlan.ownerId !== p.ownerId
          )
            conflict(`Party plan ${p.id} has inconsistent season/owner links.`);
          const k = key(p.ownerId, p.marketId);
          if (marketByKey.has(k)) continue;
          const candidates = seasonalMarkets.filter(
            (m) => m.ownerId === p.ownerId && m.marketId === p.marketId,
          );
          if (candidates.filter((m) => m.approvalStatus === "APPROVED").length > 1)
            conflict(
              `Multiple approved destination entries exist for ${p.marketNameAtPlanning} (${officerName(p.ownerId)}).`,
            );
          let id = (candidates.find((m) => m.approvalStatus === "APPROVED") ?? candidates[0])?.id;
          if (!id) {
            id = randomUUID();
            newMarkets.push({
              id,
              sheetId: sheetByOwner.get(p.ownerId)!,
              seasonId: to.seasonId,
              ownerId: p.ownerId,
              marketId: p.marketId,
              approvalStatus: "DRAFT",
            });
          }
          marketByKey.set(k, id);
        }
        if (newMarkets.length) await tx.seasonalPlan.createMany({ data: newMarkets });
        const partyOccupied = new Set(
          partyRows
            .filter((p) => p.seasonMonthId === targetMonthId)
            .map((p) => key(p.ownerId, p.marketId)),
        );
        for (const p of oldParty) {
          const k = key(p.ownerId, p.marketId);
          if (partyOccupied.has(k))
            conflict(
              `Party Planning overlap for ${p.marketNameAtPlanning} (${officerName(p.ownerId)}).`,
            );
          partyOccupied.add(k);
        }
        const targetSheets = new Map(
          partySheets.filter((s) => s.seasonMonthId === targetMonthId).map((s) => [s.ownerId, s]),
        );
        for (const s of oldSheets) {
          const dest = targetSheets.get(s.ownerId);
          if (dest) {
            compatible(s, dest, partyFields, `Party Planning officer ${s.ownerId}`);
            await tx.partyMonthlyPlan.updateMany({
              where: { sheetId: s.id },
              data: { sheetId: dest.id },
            });
            retired.push(s);
            mappings.push({ kind: "PartyMonthlySheet", from: s.id, to: dest.id });
            await tx.partyMonthlySheet.delete({ where: { id: s.id } });
          } else
            await tx.partyMonthlySheet.update({
              where: { id: s.id },
              data: { seasonId: to.seasonId, seasonMonthId: targetMonthId },
            });
        }
        await relink(
          tx,
          "PartyMonthlyPlan",
          "seasonalPlanId",
          oldParty.map((p) => ({ id: p.id, to: marketByKey.get(key(p.ownerId, p.marketId))! })),
        );
        await tx.partyMonthlyPlan.updateMany({
          where: { seasonMonthId: monthId },
          data: { seasonId: to.seasonId, seasonMonthId: targetMonthId },
        });

        const hashes = new Set(
          receiptImports.filter((r) => r.scopeKey === targetMonthId).map((r) => r.fileHash),
        );
        if (receiptImports.some((r) => r.scopeKey === monthId && hashes.has(r.fileHash)))
          conflict(
            "The same Day Book import exists in both months; reconcile that duplicate first.",
          );
        const receiptDealers = new Set(
          receiptImports
            .filter((r) => r.scopeKey === targetMonthId && r.isActive)
            .flatMap((r) => r.receipts.map((x) => x.dealerId)),
        );
        if (
          receiptImports.some(
            (r) =>
              r.scopeKey === monthId &&
              r.isActive &&
              r.receipts.some((x) => receiptDealers.has(x.dealerId)),
          )
        )
          conflict(
            "Active Day Book receipts overlap for a dealer in both months; reconcile them first.",
          );
        await tx.lastPaymentImport.updateMany({
          where: { kind: "REGULAR", scopeKey: monthId },
          data: { scopeKey: targetMonthId },
        });
        await tx.lastPaymentJob.updateMany({
          where: { scopeKey: monthId },
          data: { scopeKey: targetMonthId },
        });
        await tx.salesUploadRun.updateMany({
          where: { seasonMonthId: monthId },
          data: {
            seasonMonthId: targetMonthId,
            targetMonthName: `${targetSeason.name} ${targetSeason.year} · ${monthLabel(to)}`,
          },
        });
        // Preserve notification navigation when two compatible plan headers consolidate.
        for (const mapping of mappings) {
          if (mapping.kind === "MonthlyPlan" || mapping.kind === "RecoveryPlan") {
            await tx.notification.updateMany({
              where: { relatedEntityType: mapping.kind, relatedEntityId: mapping.from },
              data: { relatedEntityId: mapping.to },
            });
          }
        }
        // AdminEditAudit is immutable history: original identifiers stay in it. The transfer audit
        // provides the old/new identity mapping instead of rewriting past corrections.
        await tx.seasonMonth.delete({ where: { id: monthId } });
        const period = calendarPeriod(remaining.map((m) => identity(m)!));
        await tx.season.update({ where: { id: seasonId }, data: period });
        const counts = {
          salesEntries: oldEntries.length,
          monthlyPlans: oldMonthly.length,
          recoveryPlans: oldRecovery.length,
          partyEntries: oldParty.length,
          partySheets: oldSheets.length,
          draftSeasonalPlans: newParents.length,
          mergedHeaders: mappings.length,
        };
        const movedLineByEntry = new Map(lineMoves.map((m) => [m.id, m.to]));
        await writeAudit(
          {
            userId: ctx.userId,
            action: "TRANSFER",
            entity: "seasonMonths",
            entityId: seasonId,
            summary: JSON.stringify({
              operation: "REMOVE_AND_TRANSFER_MONTH",
              from,
              to,
              sourceSeason: sourceSeason.name,
              targetSeason: targetSeason.name,
              previousPeriod: {
                startMonth: sourceSeason.startMonth,
                startYear: sourceSeason.startYear,
                endMonth: sourceSeason.endMonth,
                endYear: sourceSeason.endYear,
              },
              period,
              counts,
              mappings,
              retired,
              newParentIds: newParents.map((p) => p.id),
              entryLinks: oldEntries.map((e) => ({
                id: e.id,
                fromLine: e.planLineId,
                toLine: movedLineByEntry.get(e.id),
              })),
              monthlyLinks: oldMonthly.map((p) => ({
                id: p.id,
                fromParent: p.seasonPlanId,
                toParent: parentId(p.officerId, p.seasonPlan.planningType),
              })),
              recoveryLinks: oldRecovery.map((p) => ({
                id: p.id,
                fromParent: p.seasonPlanId,
                toParent: parentId(p.officerId),
              })),
              partyLinks: oldParty.map((p) => ({
                id: p.id,
                fromParent: p.seasonalPlanId,
                toParent: marketByKey.get(key(p.ownerId, p.marketId)),
                fromSheet: p.sheetId,
              })),
            }),
          },
          tx,
        );
        return {
          sourceMonthId: monthId,
          targetMonthId,
          targetSeason: `${targetSeason.name} ${targetSeason.year}`,
          counts,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 60000,
        maxWait: 10000,
      },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2034", "P2002", "P2003"].includes(error.code)
    ) {
      conflict(
        "Another save or import changed these months. Refresh and review the transfer again.",
      );
    }
    throw error;
  }
}
