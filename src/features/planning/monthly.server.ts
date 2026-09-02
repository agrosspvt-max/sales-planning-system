import "server-only";
import { PlanStatus, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertOfficerInScope, isPlanOwner } from "@/lib/scope";
import { clearanceMapForGroup } from "@/features/users/catalogue.server";
import { saveMonthlySchema } from "@/lib/validations/planning";
import { figuresForMode, isQuantityMode, type PlanningMode } from "@/lib/calc";
import { getEditableMonthMap, assertMonthOpen } from "./planning-state.server";
import { isMonthEditable, type MonthStatus } from "./planning-state";

function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

/** The season target for a line expressed in the active monthly unit. */
function targetForMonthlyMode(
  seasonalFig: { totalQty: number | null; amount: number | null; nbv: number | null },
  monthlyMode: PlanningMode,
): number {
  if (isQuantityMode(monthlyMode)) return seasonalFig.totalQty ?? 0;
  if (monthlyMode === "AMOUNT") return seasonalFig.amount ?? 0;
  return seasonalFig.nbv ?? 0; // NBV
}

async function loadActiveApprovedPlan(planId: string) {
  const plan = await prisma.seasonPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new ApiError(404, "Plan not found");
  if (!(plan.status === PlanStatus.APPROVED && plan.isActiveVersion)) {
    // V8 — monthly planning is blocked until the seasonal plan is approved.
    throw new ApiError(409, "Monthly planning is available only for the active approved plan");
  }
  return plan;
}

export async function getMonthly(ctx: AuthContext, planId: string) {
  const plan = await loadActiveApprovedPlan(planId);
  await assertOfficerInScope(ctx, plan.officerId);

  const [season, planDealers, months] = await Promise.all([
    prisma.season.findUnique({
      where: { id: plan.seasonId },
      select: { name: true, year: true, monthlyMode: true },
    }),
    prisma.planDealer.findMany({
      where: { seasonPlanId: planId },
      include: {
        dealer: { select: { name: true } },
        lines: {
          include: {
            product: { select: { name: true, rate: true, nbvPercent: true } },
            packs: { select: { quantity: true } },
            monthlyEntries: true,
          },
        },
      },
    }),
    prisma.seasonMonth.findMany({ where: { seasonId: plan.seasonId }, orderBy: { order: "asc" } }),
  ]);

  const isOwner = isPlanOwner(ctx, plan.officerId);
  // Mode saved on THIS season, never the current global default.
  const monthlyMode = (season?.monthlyMode ?? "PACK_SIZE") as PlanningMode;
  // Clearance flags (group-specific, by the plan officer's group + productId) — display-only.
  const officer = (await prisma.user.findUnique({ where: { id: plan.officerId }, select: { groupId: true } })) as { groupId: string | null } | null;
  const clearance = await clearanceMapForGroup(officer?.groupId ?? null);

  return {
    planId: plan.id,
    seasonName: season ? `${season.name} ${season.year}` : "",
    canEdit: isOwner || ctx.role === Role.SUPER_ADMIN, // manual actuals: owner SO or admin
    monthlyMode,
    months: months.map((m) => {
      const status = ((m as { status?: string }).status as MonthStatus) ?? "OPEN";
      return { id: m.id, name: m.name, order: m.order, status, editable: isMonthEditable(status) };
    }),
    dealers: buildMonthlyDealers(planDealers, months, monthlyMode, clearance),
  };
}

/**
 * Shared monthly dealer/product transform — reused by both the (legacy) all-months
 * `getMonthly` view and the first-class single-month `getMonthlyPlan` view. It re-expresses
 * each line's seasonal target in the active monthly unit and projects stored MonthlyEntry
 * values per month. NO calculation is duplicated — figures come from `lib/calc`.
 */
export function buildMonthlyDealers(
  planDealers: MonthlyPlanDealerRow[],
  months: { id: string }[],
  monthlyMode: PlanningMode,
  clearance?: Map<string, { clearanceQty: number | null }>, // group-specific clearance (by productId), display-only
) {
  const valueMode = !isQuantityMode(monthlyMode);
  return planDealers
    .slice()
    .sort((a, b) => a.dealer.name.localeCompare(b.dealer.name))
    .map((pd) => ({
      dealerId: pd.dealerId,
      dealerName: pd.dealer.name,
      // A dealer added to this plan from Monthly Planning (new dealer).
      isNewDealer: pd.fromMonthlyPlan ?? false,
      products: pd.lines
        .map((line) => {
          // Snapshot-first pricing (frozen on the line at creation) with live-Master fallback.
          const rate = num(line.rateSnapshot ?? line.product.rate);
          const nbvPercent = num(line.nbvPercentSnapshot ?? line.product.nbvPercent);
          // The season target comes from the line's OWN stored seasonal mode,
          // re-expressed in the active monthly unit.
          const seasonalMode: PlanningMode = (line.inputMode as PlanningMode | null) ?? "PACK_SIZE";
          const seasonalInput =
            seasonalMode === "PACK_SIZE"
              ? line.packs.reduce((sum, pk) => sum + pk.quantity, 0)
              : line.inputValue !== null
                ? num(line.inputValue)
                : 0;
          const seasonalFig = figuresForMode(seasonalMode, seasonalInput, rate, nbvPercent);
          const target = targetForMonthlyMode(seasonalFig, monthlyMode);
          return { line, rate, nbvPercent, target };
        })
        .filter(
          (x) =>
            // Existing additional products remain visible, preserving the established monthly
            // planning behaviour and all previously entered values. A zero-value MonthlyEntry
            // also makes a seasonal product explicitly added to this month visible before a
            // quantity is entered.
            (x.line.isAdditional ?? false) ||
            (x.line.isAutoAdded ?? false) ||
            x.target > 0 ||
            x.line.monthlyEntries.length > 0,
        )
        .sort((a, b) => a.line.product.name.localeCompare(b.line.product.name))
        .map(({ line, rate, nbvPercent, target }) => {
          const entryByMonth = new Map(line.monthlyEntries.map((e) => [e.seasonMonthId, e]));
          return {
            planLineId: line.id,
            productId: line.productId,
            productName: line.product.name,
            isAdditional: line.isAdditional ?? false,
            isAutoAdded: line.isAutoAdded ?? false,
            isClearance: clearance?.has(line.productId) ?? false,
            clearanceQty: clearance?.get(line.productId)?.clearanceQty ?? null,
            rate,
            nbvPercent,
            // State Product Master NBV% (live master, ignores the plan snapshot) — used for Planned NBV.
            masterNbvPercent: num(line.product.nbvPercent),
            target,
            monthly: Object.fromEntries(
              months.map((m) => {
                const e = entryByMonth.get(m.id);
                const plan = valueMode ? num(e?.planValue ?? 0) : e?.planQty ?? 0;
                const sale = valueMode ? num(e?.saleValue ?? 0) : e?.saleQty ?? 0;
                // Actual SALES VALUE comes only from the uploaded Sales file.
                const saleAmount = num(e?.saleValue ?? 0);
                return [m.id, { plan, sale, saleAmount }];
              }),
            ),
          };
        }),
    }));
}

interface MonthlyEntryRow {
  seasonMonthId: string;
  planQty: number;
  saleQty: number;
  planValue: unknown;
  saleValue: unknown;
}
interface MonthlyLineRow {
  id: string;
  productId: string;
  product: { name: string; rate: unknown; nbvPercent: unknown };
  rateSnapshot?: unknown;
  nbvPercentSnapshot?: unknown;
  inputMode: string | null;
  inputValue: unknown;
  isAdditional?: boolean;
  isAutoAdded?: boolean;
  packs: { quantity: number }[];
  monthlyEntries: MonthlyEntryRow[];
}
interface MonthlyPlanDealerRow {
  dealerId: string;
  dealer: { name: string };
  fromMonthlyPlan?: boolean;
  lines: MonthlyLineRow[];
}

export async function saveMonthly(ctx: AuthContext, planId: string, raw: unknown) {
  const { entries } = saveMonthlySchema.parse(raw);
  const plan = await loadActiveApprovedPlan(planId);
  // The owning Sales Officer enters plan & actuals for their own plan; a Super Admin may
  // also enter actuals (manual Actual Sales entry) on any plan. Manual entry and the future
  // Tally Import write to the SAME MonthlyEntry records — one actual-sales store.
  const isOwner = isPlanOwner(ctx, plan.officerId);
  if (!(isOwner || ctx.role === Role.SUPER_ADMIN)) {
    throw new ApiError(403, "Only the owning Sales Officer or a Super Admin can enter monthly figures");
  }

  const validMonths = new Set(
    (
      await prisma.seasonMonth.findMany({ where: { seasonId: plan.seasonId }, select: { id: true } })
    ).map((m) => m.id),
  );
  const validLines = new Set(
    (
      await prisma.planLine.findMany({
        where: { planDealer: { seasonPlanId: planId } },
        select: { id: true },
      })
    ).map((l) => l.id),
  );
  // Open-Month gate (Section 42): entry is only allowed for months management has OPENed.
  // This is the single enforcement point — no month checks elsewhere.
  const editableByMonth = await getEditableMonthMap(plan.seasonId);

  await prisma.$transaction(async (tx) => {
    for (const e of entries) {
      if (!validLines.has(e.planLineId)) {
        throw new ApiError(422, "Plan line is not part of this plan");
      }
      if (!validMonths.has(e.seasonMonthId)) {
        throw new ApiError(422, "Month does not belong to this season"); // V28 (belongs-to-season)
      }
      assertMonthOpen(editableByMonth, e.seasonMonthId);
      const existing = (await tx.monthlyEntry.findUnique({
        where: {
          planLineId_seasonMonthId: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId },
        },
      })) as {
        planQty: number;
        planValue: unknown;
      } | null;

      const mode = (e.mode ?? "PACK_SIZE") as PlanningMode;
      const where = {
        planLineId_seasonMonthId: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId },
      };

      // Actual sales (saleQty / saleValue) are owned by the Sales Upload only; monthly saving
      // writes plan fields exclusively and preserves any imported actuals on the same entry.
      if (isQuantityMode(mode)) {
        const planQty = e.planQty ?? existing?.planQty ?? 0;
        await tx.monthlyEntry.upsert({
          where,
          create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, planQty },
          update: { planQty },
        });
      } else {
        const planValue = e.planValue ?? num(existing?.planValue ?? 0);
        await tx.monthlyEntry.upsert({
          where,
          create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, inputMode: mode, planValue },
          update: { inputMode: mode, planValue },
        });
      }
    }
  });

  return { saved: true };
}
