import "server-only";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertAdminPermission, isAdministrativeRole } from "@/features/accounts/permissions";
import { inOpenPlanningPeriod } from "@/lib/open-planning-period";
import { calendarRows } from "@/lib/season-calendar";
import { MONTH_NAMES } from "@/lib/season-months";
import { PLANNING_MODE_LABELS, type PlanningMode } from "@/lib/calc";
import { seasonalSeedValue } from "@/lib/seasonal-line";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { planningProductsForOfficer } from "@/features/users/catalogue.server";
import { loadEffectiveProduct } from "@/features/products/merge.server";
import { STATUS_LABELS } from "./types";
import { seasonalPlanWorkbookBuffer, type ExportDealer, type ExportLine, type ExportMonth, type SeasonalExportModel } from "@/lib/export/seasonal-plan-workbook";
import { zipStore } from "@/lib/export/zip-store";

/**
 * Seasonal Plan Excel export (administrators). READ-ONLY: it never creates a plan, changes a quantity, refreshes a saved price, changes a status or
 * touches dealer assignments. One specific seasonal plan version per officer → one workbook per officer (several officers → one ZIP).
 *
 * Authorization: an administrative role, and for a Custom Admin the Sales Planning "export" grant (independent of Import Seasonal Plan). Visibility
 * follows the existing rules: only OPEN seasons (closed planning periods are not offered), administrators see every officer's plans in every
 * approval / lifecycle state. Months are the season's OPEN months; figures of closed months stay in the totals (as on the Product Plan screen) as
 * one combined section, never as month detail.
 *
 * Cost: shared data (products, merges, pack sizes) is read once per request; each plan is read with a fixed number of statements inside one
 * short REPEATABLE READ, read-only transaction (a consistent snapshot even if someone saves meanwhile) — the transaction is closed before any
 * workbook is generated. Officers are processed one at a time (bounded memory) and the request is capped.
 */
export const MAX_EXPORT_OFFICERS = 60;
const SNAPSHOT_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 };
const EXPORTABLE_TYPE = "SEASONAL";

export function assertSeasonalExportAllowed(ctx: AuthContext): void {
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only administrators can export seasonal plans");
  assertAdminPermission(ctx, "salesPlanning", "export");
}

const statusLabel = (status: string, lifecycleState: string) =>
  `${STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status}${lifecycleState && lifecycleState !== "ACTIVE" ? ` · ${lifecycleState === "CLOSED" ? "Closed" : "Deactivated"}` : ""}`;
const versionLabel = (version: number, versionName: string | null) => `Version ${version}${versionName ? ` (${versionName})` : ""}`;

async function openSeasonOr404(seasonId: string) {
  const season = await prisma.season.findFirst({ where: { id: seasonId, status: "OPEN" }, select: { id: true, name: true, year: true, seasonalMode: true } });
  if (!season) throw new ApiError(404, "This season is not open for planning (closed seasons cannot be exported)");
  return season;
}

/* ------------------------------------------------ dialog options ------------------------------------------------ */

export interface ExportPlanOption { planId: string; version: number; versionName: string | null; status: string; statusLabel: string; lifecycleState: string; isActiveVersion: boolean; label: string }
export interface ExportOfficerOption { officerId: string; name: string; role: string; stateName: string | null; plans: ExportPlanOption[]; defaultPlanId: string | null }

/** Officers (Sales Officers and Regional Managers, who also own seasonal plans) with their seasonal plan versions in one OPEN season. */
export async function listSeasonalExportOptions(ctx: AuthContext, seasonId: string): Promise<{ officers: ExportOfficerOption[] }> {
  assertSeasonalExportAllowed(ctx);
  await openSeasonOr404(seasonId);
  const [plans, users] = await Promise.all([
    prisma.seasonPlan.findMany({
      where: inOpenPlanningPeriod("seasonPlan", { seasonId, planningType: EXPORTABLE_TYPE }),
      select: { id: true, officerId: true, version: true, versionName: true, status: true, lifecycleState: true, isActiveVersion: true },
      orderBy: [{ version: "desc" }],
    }),
    prisma.user.findMany({
      where: { role: { in: [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] }, deletedAt: null },
      select: { id: true, name: true, role: true, isActive: true, group: { select: { name: true } } },
    }),
  ]);
  const byOfficer = new Map<string, ExportPlanOption[]>();
  for (const p of plans) {
    const list = byOfficer.get(p.officerId) ?? [];
    const label = `${versionLabel(p.version, p.versionName)} — ${statusLabel(p.status, p.lifecycleState)}${p.isActiveVersion ? " · active version" : ""}`;
    list.push({ planId: p.id, version: p.version, versionName: p.versionName, status: p.status, statusLabel: statusLabel(p.status, p.lifecycleState), lifecycleState: p.lifecycleState, isActiveVersion: p.isActiveVersion, label });
    byOfficer.set(p.officerId, list);
  }
  const officers = users
    // An inactive officer is offered only when they still own a plan in this season (history stays exportable).
    .filter((u) => u.isActive || byOfficer.has(u.id))
    .map((u) => {
      const own = byOfficer.get(u.id) ?? [];
      // The pre-selected version: the officer's active version, or the only version. With several versions and none active, nothing is chosen —
      // the administrator must pick one explicitly (versions are never combined or chosen arbitrarily).
      const active = own.filter((p) => p.isActiveVersion);
      const defaultPlanId = active.length === 1 ? active[0]!.planId : own.length === 1 ? own[0]!.planId : null;
      return { officerId: u.id, name: u.name, role: u.role, stateName: u.group?.name ?? null, plans: own, defaultPlanId };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { officers };
}

/* ------------------------------------------------ export ------------------------------------------------ */

export interface SeasonalExportFile { name: string; data: Buffer }

const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Officer";

export async function exportSeasonalPlans(ctx: AuthContext, raw: unknown): Promise<{ filename: string; contentType: string; data: Buffer; officers: number }> {
  assertSeasonalExportAllowed(ctx);
  const input = parseExportRequest(raw);
  const season = await openSeasonOr404(input.seasonId);

  // Validate EVERY selection before any work: the plan must be a seasonal plan of that officer in this open season. Nothing is created or guessed.
  const planIds = input.plans.map((p) => p.planId);
  const found = await prisma.seasonPlan.findMany({
    where: inOpenPlanningPeriod("seasonPlan", { id: { in: planIds }, seasonId: season.id, planningType: EXPORTABLE_TYPE }),
    select: { id: true, officerId: true },
  });
  const ownerOf = new Map(found.map((p) => [p.id, p.officerId]));
  const invalid = input.plans.filter((p) => ownerOf.get(p.planId) !== p.officerId);
  if (invalid.length > 0) {
    const names = await prisma.user.findMany({ where: { id: { in: invalid.map((p) => p.officerId) } }, select: { id: true, name: true } });
    const nameOf = new Map(names.map((u) => [u.id, u.name]));
    throw new ApiError(422, `No eligible seasonal plan was found for: ${invalid.map((p) => nameOf.get(p.officerId) ?? p.officerId).join(", ")}. Nothing was exported.`);
  }

  // Shared, read once: every product's names (price list rows, merged identities) and the merge resolver.
  const [productRows, eff] = await Promise.all([
    prisma.product.findMany({ select: { id: true, name: true, technicalName: true } }),
    loadEffectiveProduct(),
  ]);
  const productMeta = new Map(productRows.map((p) => [p.id, p]));

  const files: SeasonalExportFile[] = [];
  const usedNames = new Set<string>();
  for (const sel of input.plans) {
    let model: SeasonalExportModel & { fileStem: string };
    try {
      model = await readPlanSnapshot(sel.planId, season, productMeta, eff);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error("[seasonal-export] read failed", sel.planId, error);
      throw new ApiError(500, "The export could not read one of the selected plans. Nothing was exported; please try again.");
    }
    let name = `${model.fileStem}.xlsx`;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${model.fileStem} (${n}).xlsx`;
    usedNames.add(name.toLowerCase());
    try {
      files.push({ name, data: await seasonalPlanWorkbookBuffer(model) });
    } catch (error) {
      console.error("[seasonal-export] workbook failed", sel.planId, error);
      throw new ApiError(500, `The workbook for ${model.officerName} could not be generated. Nothing was exported.`);
    }
  }
  if (files.length === 1) {
    return { filename: files[0]!.name, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: files[0]!.data, officers: 1 };
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return { filename: `${fileSafe(`Seasonal Plans - ${season.name} ${season.year}`)} - ${stamp}.zip`, contentType: "application/zip", data: zipStore(files), officers: files.length };
}

function parseExportRequest(raw: unknown): { seasonId: string; plans: { officerId: string; planId: string }[] } {
  const body = (raw ?? {}) as { seasonId?: unknown; plans?: unknown };
  const seasonId = typeof body.seasonId === "string" ? body.seasonId.trim() : "";
  if (!seasonId) throw new ApiError(422, "Select a season");
  const plans = Array.isArray(body.plans) ? body.plans : [];
  const parsed = plans.map((p) => p as { officerId?: unknown; planId?: unknown })
    .map((p) => ({ officerId: typeof p.officerId === "string" ? p.officerId : "", planId: typeof p.planId === "string" ? p.planId : "" }));
  if (parsed.length === 0) throw new ApiError(422, "Select at least one Sales Officer");
  if (parsed.some((p) => !p.officerId || !p.planId)) throw new ApiError(422, "Choose the plan version to export for every selected officer");
  if (new Set(parsed.map((p) => p.officerId)).size !== parsed.length) throw new ApiError(422, "Select one plan version per officer (versions are never combined)");
  if (parsed.length > MAX_EXPORT_OFFICERS) throw new ApiError(422, `Export at most ${MAX_EXPORT_OFFICERS} officers at a time`);
  return { seasonId, plans: parsed };
}

const num = (d: unknown): number => (typeof d === "object" && d !== null ? Number(d.toString()) : Number(d ?? 0));
const monthLabel = (m: { name: string; calendarMonth: number | null; calendarYear: number | null }) =>
  m.calendarMonth && m.calendarYear ? `${MONTH_NAMES[m.calendarMonth - 1]} ${m.calendarYear}` : m.name;

/** One plan, read as ONE consistent snapshot (fixed statement count, no per-dealer / per-product queries), shaped into the workbook model. */
async function readPlanSnapshot(
  planId: string,
  season: { id: string; name: string; year: number; seasonalMode: string },
  productMeta: Map<string, { id: string; name: string; technicalName: string | null }>,
  eff: Awaited<ReturnType<typeof loadEffectiveProduct>>,
): Promise<SeasonalExportModel & { fileStem: string }> {
  const snap = await prisma.$transaction(async (tx) => {
    const plan = await tx.seasonPlan.findUnique({
      where: { id: planId },
      select: {
        id: true, version: true, versionName: true, status: true, lifecycleState: true, officerId: true,
        officer: { select: { name: true, groupId: true, group: { select: { name: true } } } },
        // The seasonal workspace's eligibility (getPlanDetail): the plan's own seasonal dealers that are active and not Defaulters; seasonal lines.
        dealers: {
          where: { fromMonthlyPlan: false, dealer: { isActive: true, status: { not: "DEFAULTER" } } },
          select: {
            dealerId: true, noPlan: true, noPlanReason: true, dealer: { select: { name: true } },
            lines: {
              where: { isAdditional: false },
              select: {
                productId: true, rateSnapshot: true, nbvPercentSnapshot: true, inputMode: true, inputValue: true,
                product: { select: { rate: true, nbvPercent: true } },
                packs: { select: { packSizeId: true, quantity: true } },
                monthlyEntries: { select: { seasonMonthId: true, planQty: true, saleQty: true, saleValue: true } },
              },
            },
          },
        },
      },
    });
    if (!plan) throw new ApiError(404, "Plan not found");
    const [months, packs, aliases, catalogue, stateCatalogueEntries] = await Promise.all([
      tx.seasonMonth.findMany({ where: { seasonId: season.id, status: "OPEN" }, select: { id: true, name: true, order: true, calendarMonth: true, calendarYear: true } }),
      tx.packSize.findMany({ where: { isActive: true, isPlanning: true }, select: { id: true, name: true, displayOrder: true } }),
      loadDealerAliasNameMap(plan.dealers.map((d) => d.dealerId), tx),
      planningProductsForOfficer(plan.officerId, tx as unknown as typeof prisma),
      plan.officer.groupId ? tx.groupProductCatalogue.count({ where: { groupId: plan.officer.groupId, isActive: true, product: { isActive: true, mergedIntoId: null } } }) : Promise.resolve(0),
    ]);
    // Pack-size columns = the planning packs plus any pack holding a stored quantity in this plan (as the seasonal grid does).
    const used = new Set(plan.dealers.flatMap((d) => d.lines.flatMap((l) => l.packs.filter((p) => p.quantity > 0).map((p) => p.packSizeId))));
    const extraIds = [...used].filter((id) => !packs.some((p) => p.id === id));
    const extra = extraIds.length ? await tx.packSize.findMany({ where: { id: { in: extraIds } }, select: { id: true, name: true, displayOrder: true } }) : [];
    return { plan, months, packs: [...packs, ...extra].sort((a, b) => a.displayOrder - b.displayOrder), aliases, catalogue, stateCatalogue: stateCatalogueEntries > 0 };
  }, SNAPSHOT_TRANSACTION);

  const mode = season.seasonalMode as PlanningMode;
  const { plan } = snap;
  const openMonths = calendarRows(snap.months);
  const openIds = new Set(openMonths.map((m) => m.id));
  const CLOSED = "CLOSED";
  let closedData = false;
  const products = new Map<string, { productId: string; name: string; technicalName: string | null; effectiveId: string; effectiveName: string; effectiveTechnicalName: string | null }>();
  const dealers: ExportDealer[] = plan.dealers.map((pd): ExportDealer => {
    const lines: Record<string, ExportLine> = {};
    for (const l of pd.lines) {
      const rate = num(l.rateSnapshot ?? l.product.rate); // the saved planning price (legacy lines: the Master price — the system's fallback)
      const nbvPercent = num(l.nbvPercentSnapshot ?? l.product.nbvPercent);
      const packsById = Object.fromEntries(l.packs.map((p) => [p.packSizeId, p.quantity]));
      const stored = { inputMode: (l.inputMode as PlanningMode | null) ?? null, inputValue: l.inputValue == null ? null : num(l.inputValue), packs: packsById, rate, nbvPercent };
      const months: ExportLine["months"] = {};
      for (const e of l.monthlyEntries) {
        const k = openIds.has(e.seasonMonthId) ? e.seasonMonthId : CLOSED;
        const cur = months[k] ?? { planQty: 0, saleQty: 0, saleAmount: 0 };
        cur.planQty += e.planQty; cur.saleQty += e.saleQty; cur.saleAmount += num(e.saleValue ?? 0);
        months[k] = cur;
        if (k === CLOSED && (e.planQty !== 0 || e.saleQty !== 0 || num(e.saleValue ?? 0) !== 0)) closedData = true;
      }
      lines[l.productId] = { rate, nbvPercent, packs: packsById, value: mode === "PACK_SIZE" ? 0 : seasonalSeedValue(stored, mode), months };
      if (!products.has(l.productId)) {
        const meta = productMeta.get(l.productId);
        const effId = eff.effId(l.productId);
        const effMeta = effId === l.productId ? meta : productMeta.get(effId);
        products.set(l.productId, {
          productId: l.productId, name: meta?.name ?? l.productId, technicalName: meta?.technicalName ?? null,
          effectiveId: effId, effectiveName: effMeta?.name ?? eff.meta(effId)?.name ?? meta?.name ?? l.productId, effectiveTechnicalName: effMeta?.technicalName ?? meta?.technicalName ?? null,
        });
      }
    }
    // Completed = at least one stored quantity / value (the seasonal completion rule); No Plan is only the explicit flag — a blank dealer is Remaining.
    const hasQty = pd.lines.some((l) => (l.inputValue != null && num(l.inputValue) > 0) || l.packs.some((p) => p.quantity > 0));
    return {
      dealerId: pd.dealerId, name: snap.aliases.get(pd.dealerId) ?? pd.dealer.name,
      status: pd.noPlan ? "NO_PLAN" : hasQty ? "COMPLETED" : "REMAINING", noPlanReason: pd.noPlan ? pd.noPlanReason : null, lines,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const monthsOut: ExportMonth[] = openMonths.map((m) => ({ key: m.id, label: monthLabel(m) }));
  if (closedData) monthsOut.push({ key: CLOSED, label: "Closed months (combined)" });
  const catalogue = snap.catalogue
    .map((c) => ({ productId: c.productId, name: productMeta.get(c.productId)?.name ?? c.productId, technicalName: productMeta.get(c.productId)?.technicalName ?? null, rate: c.rate, nbvPercent: c.nbvPercent }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const stateName = plan.officer.group?.name ?? null;
  return {
    officerName: plan.officer.name,
    stateName,
    seasonLabel: `${season.name} ${season.year}`,
    planLabel: `${versionLabel(plan.version, plan.versionName)} · ${statusLabel(plan.status, plan.lifecycleState)}`,
    modeLabel: PLANNING_MODE_LABELS[mode] ?? mode,
    mode,
    packs: mode === "PACK_SIZE" ? snap.packs.map((p) => ({ id: p.id, name: p.name })) : [],
    months: monthsOut,
    catalogue,
    catalogueSourceLabel: snap.stateCatalogue && stateName ? `${stateName} state catalogue (as configured today)` : "Master price list (no state catalogue is configured for this officer's state)",
    products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name)),
    dealers,
    fileStem: fileSafe(`Seasonal Plan - ${plan.officer.name} - ${season.name} ${season.year} - v${plan.version}`),
  };
}
