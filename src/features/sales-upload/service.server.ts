import "server-only";
import { z } from "zod";
import { Role, ImportStatus, PlanStatus, SeasonStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { decorate, matchByName, similarity, tightKey, type Keyed } from "@/lib/match-key";
import { withDbRetry } from "@/lib/db-retry";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { writeAudit } from "@/lib/audit";
import { parseSalesWorkbook, type ParsedSalesWorkbook } from "./parser";

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can upload sales");
}

const inputSchema = z.object({
  seasonMonthId: z.string().min(1, "Select a Target Month"),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  // "SELECT SALES OFFICER" mode: restrict matching to THIS existing officer's approved seasonal plan so
  // the chosen officer takes precedence over the file-detected officer. Omitted = AUTO / USE DETECTED
  // (unchanged behaviour — match across every officer's plan by dealer identity).
  officerId: z.string().optional(),
});
export type SalesUploadInput = z.infer<typeof inputSchema>;

// Commit may optionally auto-add selected unplanned products to each officer's Seasonal Plan first.
const commitInputSchema = inputSchema.extend({
  autoAddUnplanned: z.array(z.object({ officerId: z.string().min(1), productId: z.string().min(1) })).default([]),
});

type MasterItem = { id: string; name: string; canonicalName: string | null } & Keyed;

interface ResolvedRow {
  planLineId: string;
  dealerId: string;
  productId: string;
  qty: number;
  amount: number;
}
interface Resolution {
  targetMonth: { id: string; name: string; seasonId: string; seasonName: string };
  rows: ResolvedRow[];
  // Matched dealer + matched product that has sales but no PlanLine yet, and whose dealer HAS an active
  // seasonal PlanDealer — i.e. exactly the rows the commit auto-adds as AUTO ADDED lines. Always built
  // (independent of the report) so the import path can create them without the admin toggling anything.
  unplannedPairs: { planDealerId: string; productId: string }[];
  unknownDealers: string[];
  unknownProducts: string[];
  dealersWithoutPlan: string[]; // matched dealer but no approved plan / assignment for this season
  dealersMatched: number;
  productsMatched: number;
  totalProductRows: number;
  mergedCount: number;
  report?: ImportPreviewReport; // built only when requested (analyze); never during commit
}

/* ------------------------- Import Preview Report -------------------------- */
// A verification-only view of exactly what an import WOULD do. Built from the same single matching
// pass used for the import (no separate matcher), plus ONE extra query (planned qtys) — and only when
// requested, so the commit path adds no work.

export type MatchedBy = "Exact" | "Alias" | "Fuzzy";
export type ReportProductStatus = "Imported" | "No Plan Found" | "Product Not Found";

export interface ReportProduct {
  productName: string;
  plannedQty: number;
  importedQty: number;
  amount: number;
  rate: number;
  status: ReportProductStatus;
  // Non-blocking warning: product matched in Master but NOT active in the dealer's group catalogue.
  // Never affects the import — sales are still recorded — it only flags a catalogue gap to fix later.
  groupUnavailable?: boolean;
}
export interface ReportDealer {
  dealerName: string;
  matchedBy: MatchedBy;
  originalTallyName: string | null; // shown when alias/fuzzy was used
  products: ReportProduct[];
}
export interface ReportOfficer {
  officerName: string;
  dealers: ReportDealer[];
}
export interface ReportNotMatched {
  originalName: string;
  suggestedMatch: string | null;
  reason: string;
}
export interface ReportPlannedNoSales {
  officerName: string;
  dealerName: string;
  productName: string;
  plannedQty: number;
}
export interface ReportMatchedNotPlanned {
  officerId: string; // "" when the matched dealer has no approved seasonal plan (cannot be auto-added)
  officerName: string;
  dealerName: string;
  productId: string;
  productName: string;
  salesQty: number;
  amount: number;
  rate: number;
  matchedBy: MatchedBy;
}
export interface ImportPreviewSummary {
  totalOfficers: number;
  dealersMatched: number;
  dealersUnmatched: number;
  productsImported: number;
  productsNotPlanned: number;
  productsNotMatched: number;
  rowsImported: number;
  totalQty: number;
  totalAmount: number;
}
export interface ImportPreviewReport {
  officers: ReportOfficer[];
  dealersNotMatched: ReportNotMatched[];
  productsNotMatched: ReportNotMatched[];
  plannedNoSales: ReportPlannedNoSales[];
  matchedNotPlanned: ReportMatchedNotPlanned[];
  summary: ImportPreviewSummary;
}

/** Best in-memory fuzzy suggestion (≥ 0.5) from an already-loaded master list — no DB query. */
function bestSuggestion(name: string, candidates: { name: string }[]): string | null {
  let best: { name: string; s: number } | null = null;
  for (const c of candidates) {
    const s = similarity(name, c.name);
    if (s >= 0.5 && (!best || s > best.s)) best = { name: c.name, s };
  }
  return best?.name ?? null;
}
const NO_PLAN_OFFICER = "— No approved seasonal plan —";

/**
 * Resolve the parsed workbook against masters (NO writes). Shared by analyze and commit so the
 * matching logic is defined once. Dealer: Alias → exact → loose → fuzzy. Product: exact → loose
 * → fuzzy (both via the shared matchByName). A row is importable only when the matched dealer +
 * product correspond to a PlanLine in an APPROVED, active seasonal plan for the target month's
 * season — that PlanDealer IS the dealer → Sales Officer link, so no officer is ever chosen.
 */
async function resolveWorkbook(parsed: ParsedSalesWorkbook, seasonMonthId: string, opts: { withReport?: boolean; officerId?: string } = {}): Promise<Resolution> {
  const withReport = opts.withReport ?? false;
  const officerId = opts.officerId; // when set, only this officer's approved seasonal plan is matched
  const month = await prisma.seasonMonth.findUnique({
    where: { id: seasonMonthId },
    include: { season: { select: { id: true, name: true, year: true } } },
  });
  if (!month) throw new ApiError(422, "The selected Target Month does not exist");

  const [resolver, productRows] = await Promise.all([
    loadDealerResolver(),
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true, canonicalName: true } }),
  ]);
  const products: MasterItem[] = decorate(productRows as { id: string; name: string; canonicalName: string | null }[]);
  const productNameById = new Map(products.map((p) => [p.id, p.name]));

  // Canonical Name resolver (Tally matching). For each canonicalName group, the "target" is the product
  // whose OWN name equals the canonicalName (the master/canonical row) — so an alternate spelling never
  // becomes the selected product. Both the canonical name and every alternate spelling in that group point
  // to the same target. If no self-canonical product exists, the group is skipped (no arbitrary pick) and
  // matching falls back to the existing name logic. Products without canonicalName are never indexed here.
  const canonicalTargetByKey = new Map<string, MasterItem>();
  const selfCanonical = new Map<string, MasterItem>(); // tightKey(canonicalName) -> the master row
  for (const p of products) {
    if (p.canonicalName && tightKey(p.name) === tightKey(p.canonicalName)) selfCanonical.set(tightKey(p.canonicalName), p);
  }
  for (const p of products) {
    if (!p.canonicalName) continue;
    const target = selfCanonical.get(tightKey(p.canonicalName));
    if (!target) continue; // canonical/master row not present → don't arbitrarily choose; fall back
    canonicalTargetByKey.set(tightKey(p.name), target);            // Tally sends this spelling → canonical
    canonicalTargetByKey.set(tightKey(p.canonicalName), target);   // Tally sends the canonical spelling → canonical
  }
  const resolveProduct = (rawName: string): MasterItem | null =>
    canonicalTargetByKey.get(tightKey(rawName)) ?? matchByName(rawName, products, { fuzzy: true, threshold: 0.9 });

  // Approved active seasonal plans for this season → planLine lookup + dealers that have a plan.
  // Officer + dealer name are selected too (cheap joins) so the preview report can group by officer.
  const plans = await prisma.planDealer.findMany({
    where: {
      seasonPlan: {
        seasonId: month.season.id,
        planningType: "SEASONAL",
        status: PlanStatus.APPROVED,
        isActiveVersion: true,
        // Never post actual sales against a closed/deactivated (frozen/archived) seasonal plan.
        lifecycleState: "ACTIVE",
        // SELECT SALES OFFICER: restrict to the chosen officer's plan (AUTO leaves this open).
        ...(officerId ? { officerId } : {}),
      },
      // Only ACTIVE dealers participate — excludes still-pending dealers created in Monthly
      // Planning (their PlanDealer/additional lines must not receive imported actuals).
      dealer: { status: "ACTIVE" },
    },
    select: {
      id: true,
      dealerId: true,
      dealer: { select: { name: true } },
      seasonPlan: { select: { officer: { select: { id: true, name: true } } } },
      lines: { select: { id: true, productId: true } },
    },
  });
  const planLineByKey = new Map<string, string>();
  const dealersWithPlan = new Set<string>();
  const planDealerIdByDealer = new Map<string, string>(); // dealerId → active seasonal PlanDealer id
  const officerByDealer = new Map<string, { officerId: string; officerName: string }>();
  const dealerNameById = new Map<string, string>();
  const planLinesAll: { dealerId: string; productId: string; planLineId: string }[] = [];
  for (const pd of plans as {
    id: string;
    dealerId: string;
    dealer: { name: string };
    seasonPlan: { officer: { id: string; name: string } | null } | null;
    lines: { id: string; productId: string }[];
  }[]) {
    dealersWithPlan.add(pd.dealerId);
    planDealerIdByDealer.set(pd.dealerId, pd.id);
    dealerNameById.set(pd.dealerId, pd.dealer.name);
    if (pd.seasonPlan?.officer) officerByDealer.set(pd.dealerId, { officerId: pd.seasonPlan.officer.id, officerName: pd.seasonPlan.officer.name });
    for (const l of pd.lines) {
      planLineByKey.set(`${pd.dealerId}|${l.productId}`, l.id);
      planLinesAll.push({ dealerId: pd.dealerId, productId: l.productId, planLineId: l.id });
    }
  }

  // ONE extra query, only for the report: the planned quantity per plan line for the target month.
  const plannedQtyByLine = new Map<string, number>();
  if (withReport && planLinesAll.length > 0) {
    const entries = (await prisma.monthlyEntry.findMany({
      where: { seasonMonthId: month.id, planLineId: { in: planLinesAll.map((p) => p.planLineId) } },
      select: { planLineId: true, planQty: true },
    })) as { planLineId: string; planQty: number }[];
    for (const e of entries) plannedQtyByLine.set(e.planLineId, e.planQty);
  }

  // Group-catalogue availability (report warning only — never blocks import). Maps each matched dealer to
  // its officer's group and the set of ACTIVE (groupId|productId) catalogue entries; groups with NO
  // catalogue are treated as "everything available" (Master fallback), so they never warn.
  const groupByDealer = new Map<string, string>();
  const activeCatalogue = new Set<string>(); // `${groupId}|${productId}`
  const groupsWithCatalogue = new Set<string>();
  if (withReport && officerByDealer.size > 0) {
    const offIds = [...new Set([...officerByDealer.values()].map((o) => o.officerId))];
    const officers = (await prisma.user.findMany({ where: { id: { in: offIds } }, select: { id: true, groupId: true } })) as { id: string; groupId: string | null }[];
    const groupByOfficer = new Map(officers.map((o) => [o.id, o.groupId] as const));
    for (const [dealerId, o] of officerByDealer) { const g = groupByOfficer.get(o.officerId); if (g) groupByDealer.set(dealerId, g); }
    const groupIds = [...new Set([...groupByDealer.values()])];
    if (groupIds.length > 0) {
      const cat = (await prisma.groupProductCatalogue.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, productId: true, isActive: true } })) as { groupId: string; productId: string; isActive: boolean }[];
      for (const c of cat) { groupsWithCatalogue.add(c.groupId); if (c.isActive) activeCatalogue.add(`${c.groupId}|${c.productId}`); }
    }
  }
  const groupUnavailableFor = (dealerId: string, productId: string): boolean => {
    const g = groupByDealer.get(dealerId);
    if (!g || !groupsWithCatalogue.has(g)) return false; // no catalogue → Master fallback → available
    return !activeCatalogue.has(`${g}|${productId}`);
  };

  const rows: ResolvedRow[] = [];
  // Matched-but-unplanned sales whose dealer has an active seasonal PlanDealer — the commit turns these
  // into AUTO ADDED lines. De-duped by (planDealerId|productId). Built regardless of `withReport`.
  const unplannedByKey = new Map<string, { planDealerId: string; productId: string }>();
  const unknownDealers: string[] = [];
  const unknownProducts = new Set<string>();
  const dealersWithoutPlan: string[] = [];
  const dealersMatched = new Set<string>();
  const productsMatched = new Set<string>();

  // Report accumulators (only used when withReport).
  const officersMap = new Map<string, Map<string, ReportDealer>>();
  const dealersNotMatched: ReportNotMatched[] = [];
  const productsNotMatchedMap = new Map<string, ReportNotMatched>();
  const matchedNotPlanned: ReportMatchedNotPlanned[] = [];
  const salesPairs = new Set<string>();

  for (const d of parsed.dealers) {
    // Dealer: the ONE shared resolver — Alias → exact → loose → fuzzy (same as Recovery). Using the
    // reason-carrying variant does NOT change which dealer is matched — only surfaces HOW.
    const match = resolver.resolveWithReason(d.rawName);
    if (!match) {
      unknownDealers.push(d.rawName);
      if (withReport) dealersNotMatched.push({ originalName: d.rawName, suggestedMatch: bestSuggestion(d.rawName, resolver.dealers), reason: "No Dealer Alias or master match" });
      continue;
    }
    const dealer = match.dealer;
    dealersMatched.add(dealer.id);
    if (!dealersWithPlan.has(dealer.id)) dealersWithoutPlan.push(dealer.name);
    const matchedBy: MatchedBy = match.matchType === "ALIAS" ? "Alias" : match.matchType === "FUZZY" ? "Fuzzy" : "Exact";

    let repDealer: ReportDealer | undefined;
    if (withReport) {
      const officerName = officerByDealer.get(dealer.id)?.officerName ?? NO_PLAN_OFFICER;
      let dealerMap = officersMap.get(officerName);
      if (!dealerMap) { dealerMap = new Map(); officersMap.set(officerName, dealerMap); }
      repDealer = dealerMap.get(dealer.id);
      if (!repDealer) { repDealer = { dealerName: dealer.name, matchedBy, originalTallyName: matchedBy === "Exact" ? null : d.rawName, products: [] }; dealerMap.set(dealer.id, repDealer); }
    }

    for (const p of d.products) {
      // Canonical Name first (exact), else the existing tight → loose → fuzzy name match (unchanged).
      const product = resolveProduct(p.cleanName);
      const rate = p.qty > 0 ? p.amount / p.qty : 0;
      if (!product) {
        unknownProducts.add(p.cleanName);
        if (withReport) {
          if (!productsNotMatchedMap.has(p.cleanName)) productsNotMatchedMap.set(p.cleanName, { originalName: p.cleanName, suggestedMatch: bestSuggestion(p.cleanName, products), reason: "No Product Master match" });
          repDealer?.products.push({ productName: p.cleanName, plannedQty: 0, importedQty: p.qty, amount: p.amount, rate, status: "Product Not Found" });
        }
        continue;
      }
      productsMatched.add(product.id);
      if (withReport) salesPairs.add(`${dealer.id}|${product.id}`);
      const planLineId = planLineByKey.get(`${dealer.id}|${product.id}`);
      if (!planLineId) {
        // Dealer matched + product matched, but this dealer never planned this product this season.
        // If this dealer has an active seasonal PlanDealer, queue an AUTO ADDED line so the commit can
        // create it and post the actual — regardless of catalogue availability (actuals capture any
        // Master product). Dealers without an approved plan can't receive a line, so they're skipped.
        const pdId = planDealerIdByDealer.get(dealer.id);
        if (pdId) unplannedByKey.set(`${pdId}|${product.id}`, { planDealerId: pdId, productId: product.id });
        if (withReport) {
          const officer = officerByDealer.get(dealer.id);
          repDealer?.products.push({ productName: product.name, plannedQty: 0, importedQty: p.qty, amount: p.amount, rate, status: "No Plan Found", groupUnavailable: groupUnavailableFor(dealer.id, product.id) });
          matchedNotPlanned.push({ officerId: officer?.officerId ?? "", officerName: officer?.officerName ?? NO_PLAN_OFFICER, dealerName: dealer.name, productId: product.id, productName: product.name, salesQty: p.qty, amount: p.amount, rate, matchedBy });
        }
        continue; // unchanged: not importable
      }
      rows.push({ planLineId, dealerId: dealer.id, productId: product.id, qty: p.qty, amount: p.amount });
      if (withReport) repDealer?.products.push({ productName: product.name, plannedQty: plannedQtyByLine.get(planLineId) ?? 0, importedQty: p.qty, amount: p.amount, rate, status: "Imported", groupUnavailable: groupUnavailableFor(dealer.id, product.id) });
    }
  }

  let report: ImportPreviewReport | undefined;
  if (withReport) {
    // Planned products with no sales in the file this month (planned qty > 0, no matching sale pair).
    const plannedNoSales: ReportPlannedNoSales[] = [];
    for (const pl of planLinesAll) {
      const plannedQty = plannedQtyByLine.get(pl.planLineId) ?? 0;
      if (plannedQty <= 0) continue;
      if (salesPairs.has(`${pl.dealerId}|${pl.productId}`)) continue;
      plannedNoSales.push({ officerName: officerByDealer.get(pl.dealerId)?.officerName ?? NO_PLAN_OFFICER, dealerName: dealerNameById.get(pl.dealerId) ?? pl.dealerId, productName: productNameById.get(pl.productId) ?? pl.productId, plannedQty });
    }
    const officers: ReportOfficer[] = [...officersMap.entries()]
      .map(([officerName, dealerMap]) => ({ officerName, dealers: [...dealerMap.values()].sort((a, b) => a.dealerName.localeCompare(b.dealerName)) }))
      .sort((a, b) => a.officerName.localeCompare(b.officerName));
    const totalOfficers = new Set(rows.map((r) => officerByDealer.get(r.dealerId)?.officerId).filter((x): x is string => !!x)).size;
    report = {
      officers,
      dealersNotMatched,
      productsNotMatched: [...productsNotMatchedMap.values()],
      plannedNoSales,
      matchedNotPlanned,
      summary: {
        totalOfficers,
        dealersMatched: dealersMatched.size,
        dealersUnmatched: new Set(unknownDealers).size,
        productsImported: rows.length,
        productsNotPlanned: matchedNotPlanned.length,
        productsNotMatched: productsNotMatchedMap.size,
        rowsImported: rows.length,
        totalQty: rows.reduce((s, r) => s + r.qty, 0),
        totalAmount: rows.reduce((s, r) => s + r.amount, 0),
      },
    };
  }

  return {
    targetMonth: { id: month.id, name: month.name, seasonId: month.season.id, seasonName: `${month.season.name} ${month.season.year}` },
    rows,
    unplannedPairs: [...unplannedByKey.values()],
    unknownDealers,
    unknownProducts: [...unknownProducts],
    dealersWithoutPlan: [...new Set(dealersWithoutPlan)],
    dealersMatched: dealersMatched.size,
    productsMatched: productsMatched.size,
    totalProductRows: parsed.totalProductRows,
    mergedCount: parsed.mergedCount,
    report,
  };
}

export interface SalesUploadAnalysis {
  workbookName: string;
  targetMonth: { id: string; name: string; seasonName: string };
  dealersFound: number;
  productsFound: number;
  duplicatesMerged: number;
  unknownDealers: string[];
  unknownProducts: string[];
  dealersWithoutPlan: string[];
  rowsToImport: number;
  warnings: string[];
  // Officer(s) detected from the matched dealers' plans (AUTO / USE DETECTED display). Empty when nothing
  // matched. `selectedOfficerId` echoes the SELECT-SALES-OFFICER choice that was actually applied (if any).
  detectedOfficers: string[];
  selectedOfficerId: string | null;
  report: ImportPreviewReport | null;
}

export async function analyzeSalesUpload(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  raw: unknown,
): Promise<SalesUploadAnalysis> {
  assertAdmin(ctx);
  const input = inputSchema.parse(raw);
  const parsed = parseSalesWorkbook(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealer rows were found — is this a Tally Sales Register export?");
  const res = await resolveWorkbook(parsed, input.seasonMonthId, { withReport: true, officerId: input.officerId });

  const warnings: string[] = [];
  if (res.unknownDealers.length > 0) warnings.push(`${res.unknownDealers.length} dealer(s) could not be matched — add a Dealer Alias or master.`);
  if (res.unknownProducts.length > 0) warnings.push(`${res.unknownProducts.length} product(s) could not be matched to the Product Master.`);
  if (res.dealersWithoutPlan.length > 0) warnings.push(`${res.dealersWithoutPlan.length} matched dealer(s) have no approved plan for this season — their sales will be skipped.`);
  if (res.rows.length === 0) warnings.push("No rows resolved to an approved plan line — nothing would be imported.");

  return {
    workbookName: filename,
    targetMonth: { id: res.targetMonth.id, name: res.targetMonth.name, seasonName: res.targetMonth.seasonName },
    dealersFound: res.dealersMatched,
    productsFound: res.productsMatched,
    duplicatesMerged: res.mergedCount,
    unknownDealers: res.unknownDealers,
    unknownProducts: res.unknownProducts,
    dealersWithoutPlan: res.dealersWithoutPlan,
    rowsToImport: res.rows.length,
    detectedOfficers: [...new Set((res.report?.officers ?? []).map((o) => o.officerName).filter((n) => n !== NO_PLAN_OFFICER))].sort(),
    selectedOfficerId: input.officerId ?? null,
    warnings,
    report: res.report ?? null,
  };
}

export interface SalesUploadResult {
  runId: string;
  rowsImported: number;
  dealersUpdated: number;
  productsUpdated: number;
  unknownDealers: number;
  unknownProducts: number;
  autoAddedLines: number;
}

/**
 * Automatic AUTO ADDED lines — the dealer-specific counterpart to `autoAddUnplannedProducts`. For every
 * (PlanDealer, product) that had actual sales but no PlanLine (from `resolveWorkbook().unplannedPairs`),
 * create ONE normal seasonal PlanLine flagged `isAutoAdded` (isAdditional stays FALSE) on THAT dealer
 * only — so the sold product shows as AUTO ADDED with Season/Plan 0 and the actual can then post. This is
 * intentionally unconditional on the Group Catalogue: catalogue governs PLANNING availability, but actual
 * sales must be captured for any Master product. `skipDuplicates` on (planDealerId, productId) →
 * idempotent/retry-safe. No rate/NBV snapshot is written; planning amounts read `rateSnapshot ?? live`.
 * Returns the number of PlanLines created.
 */
async function autoAddUnplannedLines(pairs: { planDealerId: string; productId: string }[]): Promise<number> {
  if (pairs.length === 0) return 0;
  const creates: Prisma.PlanLineCreateManyInput[] = pairs.map((p) => ({
    planDealerId: p.planDealerId,
    productId: p.productId,
    isAutoAdded: true,
  }));
  let created = 0;
  const CHUNK = 500;
  for (let i = 0; i < creates.length; i += CHUNK) {
    const slice = creates.slice(i, i + CHUNK);
    const r = (await withDbRetry(() => prisma.planLine.createMany({ data: slice, skipDuplicates: true }))) as { count: number };
    created += r.count;
  }
  return created;
}

/**
 * Auto-add selected UNPLANNED products to each officer's approved Seasonal Plan BEFORE the import so
 * the normal Sales Upload pipeline can then post their actuals. For every selected (officer, product):
 * add a NORMAL seasonal PlanLine (isAdditional stays FALSE; flagged `isAutoAdded` for the badge) with
 * zero planning (rate/NBV snapshotted) to EVERY active-dealer PlanDealer in that officer's plan —
 * keeping the plan structure consistent so the product shows wherever seasonal products show. Batched +
 * `skipDuplicates` on the (planDealerId, productId) unique → idempotent/retry-safe; never duplicates.
 * Returns the number of PlanLines created.
 */
async function autoAddUnplannedProducts(
  ctx: AuthContext,
  seasonMonthId: string,
  selections: { officerId: string; productId: string }[],
): Promise<number> {
  if (selections.length === 0) return 0;
  const month = await prisma.seasonMonth.findUnique({ where: { id: seasonMonthId }, select: { seasonId: true } });
  if (!month) return 0;

  const byOfficer = new Map<string, Set<string>>();
  for (const s of selections) {
    const set = byOfficer.get(s.officerId) ?? new Set<string>();
    set.add(s.productId);
    byOfficer.set(s.officerId, set);
  }
  const allProductIds = [...new Set(selections.map((s) => s.productId))];
  const activeProductIds = new Set(
    (await prisma.product.findMany({
      where: { id: { in: allProductIds }, isActive: true },
      select: { id: true },
    })).map((p) => p.id),
  );

  let created = 0;
  for (const [officerId, productIds] of byOfficer) {
    // The officer's approved, active seasonal plan for this season (the same plan Sales Upload imports into).
    const plan = (await prisma.seasonPlan.findFirst({
      where: { seasonId: month.seasonId, officerId, planningType: "SEASONAL", status: PlanStatus.APPROVED, isActiveVersion: true, lifecycleState: "ACTIVE" },
      select: { id: true },
    })) as { id: string } | null;
    if (!plan) continue;

    const planDealers = (await prisma.planDealer.findMany({
      where: { seasonPlanId: plan.id, dealer: { status: "ACTIVE" } },
      select: { id: true, lines: { where: { productId: { in: [...productIds] } }, select: { productId: true } } },
    })) as { id: string; lines: { productId: string }[] }[];

    const creates: Prisma.PlanLineCreateManyInput[] = [];
    for (const pd of planDealers) {
      const have = new Set(pd.lines.map((l) => l.productId));
      for (const pid of productIds) {
        if (have.has(pid)) continue;
        if (!activeProductIds.has(pid)) continue;
        // isAdditional stays FALSE (a normal seasonal line); isAutoAdded=true drives the badge only.
        // Planning prices are always read live from Product Master, never from line snapshots.
        creates.push({ planDealerId: pd.id, productId: pid, isAutoAdded: true });
      }
    }

    const CHUNK = 500;
    for (let i = 0; i < creates.length; i += CHUNK) {
      const slice = creates.slice(i, i + CHUNK);
      const r = (await withDbRetry(() => prisma.planLine.createMany({ data: slice, skipDuplicates: true }))) as { count: number };
      created += r.count;
    }
  }
  void ctx;
  return created;
}

/**
 * Commit — the ONLY step that writes. Populates MonthlyEntry.saleQty / saleValue (the Actual
 * fields) for the target month; planQty / planValue are never touched. Optionally auto-adds selected
 * unplanned products to the Seasonal Plan first (so their actuals can import through the same pipeline).
 * New entries are bulk-inserted with createMany; existing entries updated in short chunked transactions.
 * Amount comes straight from the workbook — never recomputed.
 */
export async function commitSalesUpload(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  raw: unknown,
): Promise<SalesUploadResult> {
  assertAdmin(ctx);
  const input = commitInputSchema.parse(raw);
  const parsed = parseSalesWorkbook(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealer rows were found in the workbook");
  // Resolve once to discover both importable rows AND matched-but-unplanned sales (unplannedPairs).
  const first = await resolveWorkbook(parsed, input.seasonMonthId, { officerId: input.officerId });
  // AUTO ADDED lines are created BEFORE the import so the actuals post through the normal path:
  //  1. Automatic + dealer-specific — every sold product missing from that dealer's plan (the reported
  //     regression: these used to vanish; now they always become AUTO ADDED rows).
  //  2. Selection-based + officer-wide — the admin's explicit "add this product across the plan" choices
  //     from the Import Preview (kept for backward compatibility; skipDuplicates avoids double-creates).
  const autoLines = await autoAddUnplannedLines(first.unplannedPairs);
  const selectionLines = await autoAddUnplannedProducts(ctx, input.seasonMonthId, input.autoAddUnplanned);
  const autoAddedLines = autoLines + selectionLines;
  // Re-resolve only if new lines exist, so their (dealer, product) now map to a PlanLine and import.
  const res = autoAddedLines > 0 ? await resolveWorkbook(parsed, input.seasonMonthId, { officerId: input.officerId }) : first;
  const monthId = res.targetMonth.id;

  // One actual per (planLine, month) — the parser already merged duplicates per dealer, but a
  // product could appear under one dealer only, so planLineId is unique across rows here.
  const byLine = new Map<string, { saleQty: number; saleValue: number }>();
  for (const r of res.rows) {
    const cur = byLine.get(r.planLineId) ?? { saleQty: 0, saleValue: 0 };
    cur.saleQty += Math.round(r.qty);
    cur.saleValue += r.amount;
    byLine.set(r.planLineId, cur);
  }
  const lineIds = [...byLine.keys()];

  const fromDate = input.fromDate ? new Date(input.fromDate) : null;
  const toDate = input.toDate ? new Date(input.toDate) : null;
  const dealersUpdatedCount = new Set(res.rows.map((r) => r.dealerId)).size;
  const productsUpdatedCount = new Set(res.rows.map((r) => r.productId)).size;

  let runId = "";
  try {
    // Which target entries already exist (UPDATE actuals) vs must be created (INSERT). Read outside a
    // long transaction so no connection is pinned for the whole import.
    const existing = (await prisma.monthlyEntry.findMany({
      where: { seasonMonthId: monthId, planLineId: { in: lineIds } },
      select: { id: true, planLineId: true },
    })) as { id: string; planLineId: string }[];
    const existingByLine = new Map(existing.map((e) => [e.planLineId, e.id]));

    const creates: { planLineId: string; seasonMonthId: string; saleQty: number; saleValue: number }[] = [];
    const updates: { id: string; saleQty: number; saleValue: number }[] = [];
    for (const [planLineId, v] of byLine) {
      const id = existingByLine.get(planLineId);
      if (id) updates.push({ id, saleQty: v.saleQty, saleValue: v.saleValue });
      else creates.push({ planLineId, seasonMonthId: monthId, saleQty: v.saleQty, saleValue: v.saleValue });
    }

    // New entries: one bulk insert (planQty defaults to 0 — actuals without a monthly plan).
    // `skipDuplicates` guards the (planLineId, seasonMonthId) unique so a retry after a partial run can
    // never create a duplicate row — the import stays idempotent.
    if (creates.length > 0) {
      await withDbRetry(() => prisma.monthlyEntry.createMany({ data: creates, skipDuplicates: true }));
    }

    // Existing entries: update ONLY the actual fields (saleQty/saleValue); planQty/planValue are
    // preserved. Values are SET (not incremented), so each chunk is idempotent. Each chunk runs in its
    // OWN short transaction (array form) so a DB connection is held for a fraction of a second and then
    // released — no single 60s transaction pins a connection while other requests (auth, labels,
    // notifications) need one. Chunk failures are retried on transient connectivity errors.
    const CHUNK = 500;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const slice = updates.slice(i, i + CHUNK);
      await withDbRetry(() =>
        prisma.$transaction(slice.map((u) => prisma.monthlyEntry.update({ where: { id: u.id }, data: { saleQty: u.saleQty, saleValue: u.saleValue } }))),
      );
    }

    // NOT wrapped in withDbRetry: SalesUploadRun has no unique key, so retrying a create whose INSERT
    // may have already committed (ack lost on a dropped connection) would append a DUPLICATE run row.
    // A transient failure here instead throws → the catch records FAILED and a re-import (idempotent)
    // writes a single fresh run — never a duplicate.
    const run = (await prisma.salesUploadRun.create({
      data: {
        uploadedById: ctx.userId,
        workbookName: filename,
        seasonMonthId: monthId,
        targetMonthName: `${res.targetMonth.seasonName} · ${res.targetMonth.name}`,
        fromDate,
        toDate,
        dealersUpdated: dealersUpdatedCount,
        productsUpdated: productsUpdatedCount,
        rowsImported: byLine.size,
        unknownDealers: res.unknownDealers.length,
        unknownProducts: res.unknownProducts.length,
        status: ImportStatus.COMPLETED,
        summary: JSON.stringify({
          targetMonth: res.targetMonth,
          rowsImported: byLine.size,
          dealersUpdated: dealersUpdatedCount,
          productsUpdated: productsUpdatedCount,
          duplicatesMerged: res.mergedCount,
          unknownDealers: res.unknownDealers,
          unknownProducts: res.unknownProducts,
          dealersWithoutPlan: res.dealersWithoutPlan,
          autoAddedLines,
        }),
      },
    })) as { id: string };
    runId = run.id;
  } catch (e) {
    await prisma.salesUploadRun.create({
      data: {
        uploadedById: ctx.userId,
        workbookName: filename,
        seasonMonthId: monthId,
        targetMonthName: `${res.targetMonth.seasonName} · ${res.targetMonth.name}`,
        fromDate,
        toDate,
        rowsImported: 0,
        unknownDealers: res.unknownDealers.length,
        unknownProducts: res.unknownProducts.length,
        status: ImportStatus.FAILED,
        summary: JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      },
    });
    throw e;
  }

  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "salesUpload",
    entityId: runId,
    summary: `Sales Upload for ${res.targetMonth.seasonName} · ${res.targetMonth.name} — ${byLine.size} rows, ${dealersUpdatedCount} dealers, ${productsUpdatedCount} products${autoAddedLines > 0 ? `, ${autoAddedLines} auto-added plan line(s)` : ""} (workbook: ${filename})`,
  });

  return {
    runId,
    rowsImported: byLine.size,
    dealersUpdated: dealersUpdatedCount,
    productsUpdated: productsUpdatedCount,
    unknownDealers: res.unknownDealers.length,
    unknownProducts: res.unknownProducts.length,
    autoAddedLines,
  };
}

/** Existing active Sales Officers for the "SELECT SALES OFFICER" dropdown (no new officer is ever created). */
export async function listSalesOfficers(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  assertAdmin(ctx);
  return (await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, isActive: true, deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })) as { id: string; name: string }[];
}

/** Target-month options for the upload screen (every season's months). */
export async function listTargetMonths(ctx: AuthContext) {
  assertAdmin(ctx);
  const seasons = await prisma.season.findMany({
    where: { status: SeasonStatus.OPEN }, // CLOSED seasons disappear from Sales Upload / Aging import selectors
    orderBy: [{ year: "desc" }, { name: "asc" }],
    select: { name: true, year: true, months: { orderBy: { order: "asc" }, select: { id: true, name: true, order: true } } },
  });
  const out: { id: string; label: string }[] = [];
  for (const s of seasons as { name: string; year: number; months: { id: string; name: string; order: number }[] }[]) {
    for (const m of s.months) out.push({ id: m.id, label: `${s.name} ${s.year} · ${m.name}` });
  }
  return out;
}

export async function listSalesUploadRuns(ctx: AuthContext) {
  assertAdmin(ctx);
  const rows = (await prisma.salesUploadRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { uploadedBy: { select: { name: true } } },
  })) as {
    id: string;
    workbookName: string;
    targetMonthName: string;
    fromDate: Date | null;
    toDate: Date | null;
    dealersUpdated: number;
    productsUpdated: number;
    rowsImported: number;
    unknownDealers: number;
    unknownProducts: number;
    status: string;
    createdAt: Date;
    uploadedBy: { name: string };
  }[];
  return rows.map((r) => ({
    id: r.id,
    workbookName: r.workbookName,
    targetMonthName: r.targetMonthName,
    fromDate: r.fromDate,
    toDate: r.toDate,
    dealersUpdated: r.dealersUpdated,
    productsUpdated: r.productsUpdated,
    rowsImported: r.rowsImported,
    unknownDealers: r.unknownDealers,
    unknownProducts: r.unknownProducts,
    status: r.status,
    createdAt: r.createdAt,
    uploadedByName: r.uploadedBy.name,
  }));
}
