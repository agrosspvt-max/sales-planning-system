import "server-only";
import { z } from "zod";
import { Role, SchemeRequirementType, SchemeUploadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { loadProductResolver } from "@/lib/product-resolver";
import { writeAudit } from "@/lib/audit";
import { parseSalesWorkbook } from "@/features/sales-upload/parser";
import {
  loadSchemeRequirements,
  loadEnrolledDealerIds,
  computeSchemeUploadImpact,
  loadSchemeOptionConfig,
  loadOptionSnapshotTargets,
  computeSchemeOptionUploadImpact,
  type SchemeOptionConfig,
} from "./scheme-achievement.server";
import { round2, round3, type UploadImpactRow } from "@/lib/scheme-achievement";
import type { OptionUploadImpactRow, OptionAchievementType } from "@/lib/scheme-options";
import { validateRange, schemeRangeInvalidReason, filterIncoming, type DateRange } from "@/lib/scheme-upload-logic";

/**
 * SCHEME UPLOAD (Phase 7) — a dedicated, date-range upload that feeds ONLY the scheme-achievement tracking
 * tables (SchemeUploadBatch → SchemeUploadBatchScheme → SchemeSale). It is architecturally isolated from
 * normal Sales Planning:
 *
 *   ABSOLUTE ISOLATION — this module NEVER reads or writes MonthlyEntry, PlanLine, PlanDealer,
 *   SalesUploadRun or any normal Sales/Monthly/Seasonal/Recovery actual. It never calls the Sales Upload
 *   commit. It reuses only SAFE, side-effect-free utilities: the Tally parser, the shared dealer resolver,
 *   the shared product resolver, and the Phase 4 achievement engine (`uploadImpact` via
 *   `computeSchemeUploadImpact`). Its persistence layer is entirely separate.
 *
 * Flow: Analyze (read-only) → Review → Confirm Import → Commit (atomic, writes only scheme tables).
 * Admin-only, matching the existing Sales/Daybook uploads (the upload page is SUPER_ADMIN gated).
 */

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can upload scheme sales");
}

/* --------------------------------- input --------------------------------- */

const rangeSchema = z.object({
  startDate: z.string().min(1, "Start Date is required"),
  endDate: z.string().min(1, "End Date is required"),
  schemeIds: z.array(z.string().min(1)).min(1, "Select at least one scheme"),
});
const commitSchema = rangeSchema.extend({ replace: z.boolean().default(false) });

/** Parse the YYYY-MM-DD range into UTC-midnight Dates via the shared pure validator (Start ≤ End, inclusive). */
function parseRange(input: { startDate: string; endDate: string }): DateRange {
  const r = validateRange(input.startDate, input.endDate);
  if (!r.ok) throw new ApiError(422, r.error);
  return r.range;
}

/* --------------------------------- selectable schemes --------------------------------- */

export interface SchemeUploadOption {
  id: string;
  schemeName: string;
  requirementType: SchemeRequirementType;
  valueMode: "INDIVIDUAL" | "COMBINED" | null;
  structure: "FIXED" | "MULTIPLE_OPTIONS";
  optionAchievementType: OptionAchievementType | null;
  isPerpetual: boolean;
  startDate: string | null;
  endDate: string | null;
  status: string;
}

/**
 * Schemes selectable for Scheme Upload. A FIXED scheme is excluded when its requirement is NONE (an upload
 * would create meaningless SchemeSale data; installment-only schemes are unaffected). Every MULTIPLE_OPTIONS
 * scheme IS selectable — its achievement is tracked over an eligible pool vs each dealer's snapshot target,
 * so uploads are always meaningful. Admin scope (all schemes); the upload page is already SUPER_ADMIN gated.
 */
export async function listSchemeUploadOptions(ctx: AuthContext): Promise<SchemeUploadOption[]> {
  assertAdmin(ctx);
  const rows = (await prisma.scheme.findMany({
    where: { OR: [{ requirementType: { not: SchemeRequirementType.NONE } }, { structure: "MULTIPLE_OPTIONS" }] },
    orderBy: [{ isPerpetual: "desc" }, { schemeName: "asc" }],
    select: { id: true, schemeName: true, requirementType: true, valueMode: true, structure: true, optionAchievementType: true, isPerpetual: true, startDate: true, endDate: true, status: true },
  })) as unknown as {
    id: string; schemeName: string; requirementType: SchemeRequirementType; valueMode: "INDIVIDUAL" | "COMBINED" | null;
    structure: string; optionAchievementType: string | null;
    isPerpetual: boolean; startDate: Date | null; endDate: Date | null; status: string;
  }[];
  return rows.map((s) => ({
    id: s.id, schemeName: s.schemeName, requirementType: s.requirementType, valueMode: s.valueMode,
    structure: s.structure as SchemeUploadOption["structure"], optionAchievementType: (s.optionAchievementType ?? null) as OptionAchievementType | null,
    isPerpetual: s.isPerpetual, startDate: s.startDate?.toISOString() ?? null, endDate: s.endDate?.toISOString() ?? null, status: s.status,
  }));
}

/* --------------------------------- shared resolution --------------------------------- */

interface MatchedFact { dealerId: string; productId: string; qty: number; value: number; rawDealerName: string; rawProductName: string }

interface ResolvedFile {
  parsedDealers: number;
  matched: Map<string, MatchedFact>; // key `${dealerId}|${productId}` (summed across the file)
  matchedDealerIds: Set<string>;
  matchedProductIds: Set<string>;
  dealerNameById: Map<string, string>;
  unmatchedDealers: string[];
  unmatchedProducts: string[];
}

/**
 * Resolve the uploaded workbook to matched (dealerId, productId) facts using the SHARED resolvers. Pure
 * read: no scheme filtering yet, no writes. Dealer: Alias → exact → tight → loose → fuzzy. Product:
 * canonical → tight → loose → fuzzy. Duplicate products within a dealer were already merged by the parser.
 */
async function resolveFile(buffer: Buffer): Promise<ResolvedFile> {
  const parsed = parseSalesWorkbook(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealer rows were found — is this a Tally Sales Register export?");
  const [resolver, productResolver] = await Promise.all([loadDealerResolver(), loadProductResolver()]);

  const matched = new Map<string, MatchedFact>();
  const matchedDealerIds = new Set<string>();
  const matchedProductIds = new Set<string>();
  const dealerNameById = new Map<string, string>();
  const unmatchedDealers: string[] = [];
  const unmatchedProducts = new Set<string>();

  for (const d of parsed.dealers) {
    const dealerMatch = resolver.resolveWithReason(d.rawName);
    if (!dealerMatch) { unmatchedDealers.push(d.rawName); continue; }
    const dealer = dealerMatch.dealer;
    matchedDealerIds.add(dealer.id);
    dealerNameById.set(dealer.id, dealer.name);
    for (const p of d.products) {
      const product = productResolver.resolveProduct(p.cleanName);
      if (!product) { unmatchedProducts.add(p.cleanName); continue; }
      matchedProductIds.add(product.id);
      const key = `${dealer.id}|${product.id}`;
      const cur = matched.get(key);
      if (cur) { cur.qty = round3(cur.qty + p.qty); cur.value = round2(cur.value + p.amount); }
      else matched.set(key, { dealerId: dealer.id, productId: product.id, qty: round3(p.qty), value: round2(p.amount), rawDealerName: d.rawName, rawProductName: p.rawName });
    }
  }
  return { parsedDealers: parsed.dealers.length, matched, matchedDealerIds, matchedProductIds, dealerNameById, unmatchedDealers, unmatchedProducts: [...unmatchedProducts] };
}

/* --------------------------------- analysis --------------------------------- */

export interface SchemeUploadImpactLine {
  dealerId: string; dealerName: string; productId: string; productName: string;
  requiredQty: number; requiredValue: number;
  previouslyAchievedQty: number; previouslyAchievedValue: number;
  incomingQty: number; incomingValue: number;
  newTotalQty: number; newTotalValue: number;
  remainingQty: number; remainingValue: number;
  completedBefore: boolean; completedAfter: boolean;
}
export interface CombinedDealerLine {
  dealerId: string; dealerName: string;
  requiredValue: number; previouslyAchievedValue: number; incomingValue: number; newTotalValue: number;
  remainingValue: number; completedBefore: boolean; completedAfter: boolean;
}
/** Per-dealer combined line for a MULTIPLE_OPTIONS scheme (single snapshot target across the eligible pool). */
export interface OptionDealerLine {
  dealerId: string; dealerName: string;
  target: number; previouslyAchieved: number; incoming: number; newTotal: number; remaining: number;
  completedBefore: boolean; completedAfter: boolean;
}
export interface SchemeUploadSchemeAnalysis {
  schemeId: string; schemeName: string;
  requirementType: SchemeRequirementType; valueMode: "INDIVIDUAL" | "COMBINED" | null;
  structure: "FIXED" | "MULTIPLE_OPTIONS"; optionAchievementType: OptionAchievementType | null;
  valid: boolean; invalidReason: string | null;
  hasExistingScope: boolean; // exact-range ACTIVE scope exists → this upload would REPLACE it
  enrolledChecked: number;
  matchedDealers: number;      // enrolled dealers contributing ≥1 fact
  notEnrolledDealers: number;  // matched dealers in the file, not enrolled, with facts on required/eligible products
  requiredProducts: number;    // FIXED: required products; MULTIPLE_OPTIONS: eligible pool size
  matchedRequiredProducts: number;
  notRequiredProducts: number; // matched products in the file this scheme does not require / find eligible
  incomingQty: number; incomingValue: number;
  dealersAffected: number;
  newlyCompleted: number;      // requirement/target items newly completed by this upload
  contributions: number;       // SchemeSale facts that would be created
  lines: SchemeUploadImpactLine[];
  combinedByDealer: CombinedDealerLine[]; // populated only for Fixed VALUE_BASED COMBINED
  optionByDealer: OptionDealerLine[];     // populated only for MULTIPLE_OPTIONS
}
export interface SchemeUploadAnalysis {
  fileName: string;
  startDate: string; endDate: string;
  parsedDealers: number;
  unmatchedDealers: string[];
  unmatchedProducts: string[];
  schemes: SchemeUploadSchemeAnalysis[];
  totalContributions: number;
  anyExistingScope: boolean;
}

export async function analyzeSchemeUpload(ctx: AuthContext, buffer: Buffer, fileName: string, raw: unknown): Promise<SchemeUploadAnalysis> {
  assertAdmin(ctx);
  const input = rangeSchema.parse(raw);
  const range = parseRange(input);
  const schemeIds = [...new Set(input.schemeIds)];

  const file = await resolveFile(buffer);
  const { productNameById } = await loadProductResolver();

  const [requirements, enrolledMap, schemeRows, optionConfig] = await Promise.all([
    loadSchemeRequirements(schemeIds),
    loadEnrolledDealerIds(ctx, schemeIds),
    prisma.scheme.findMany({ where: { id: { in: schemeIds } }, select: { id: true, schemeName: true, requirementType: true, valueMode: true, isPerpetual: true, startDate: true, endDate: true } }),
    loadSchemeOptionConfig(schemeIds),
  ]);
  const schemeById = new Map((schemeRows as { id: string; schemeName: string; requirementType: SchemeRequirementType; valueMode: "INDIVIDUAL" | "COMBINED" | null; isPerpetual: boolean; startDate: Date | null; endDate: Date | null }[]).map((s) => [s.id, s]));
  // Per-dealer FROZEN snapshot targets for MULTIPLE_OPTIONS schemes (no-op for Fixed schemes).
  const optionTargets = await loadOptionSnapshotTargets(ctx, optionConfig, schemeIds);

  // Names for every dealer that appears in any impact row (matched-in-file OR previously-achieved).
  const dealerNameById = new Map(file.dealerNameById);

  const schemes: SchemeUploadSchemeAnalysis[] = [];
  for (const schemeId of schemeIds) {
    const meta = schemeById.get(schemeId);
    const req = requirements.get(schemeId);
    const cfg = optionConfig.get(schemeId);
    const invalidReason = schemeRangeInvalidReason(meta, range);
    const base: SchemeUploadSchemeAnalysis = {
      schemeId, schemeName: meta?.schemeName ?? schemeId,
      requirementType: meta?.requirementType ?? SchemeRequirementType.NONE, valueMode: meta?.valueMode ?? null,
      structure: (cfg?.structure ?? "FIXED"), optionAchievementType: cfg?.optionAchievementType ?? null,
      valid: !invalidReason, invalidReason,
      hasExistingScope: false, enrolledChecked: 0, matchedDealers: 0, notEnrolledDealers: 0,
      requiredProducts: cfg?.structure === "MULTIPLE_OPTIONS" ? (cfg.eligibleProductIds.length) : (req?.products.length ?? 0), matchedRequiredProducts: 0, notRequiredProducts: 0,
      incomingQty: 0, incomingValue: 0, dealersAffected: 0, newlyCompleted: 0, contributions: 0,
      lines: [], combinedByDealer: [], optionByDealer: [],
    };
    if (invalidReason) { schemes.push(base); continue; }

    // MULTIPLE_OPTIONS: eligible pool + per-dealer snapshot target (combined achievement), isolated path.
    if (cfg && cfg.structure === "MULTIPLE_OPTIONS" && cfg.optionAchievementType) {
      schemes.push(await analyzeOptionScheme(base, cfg, cfg.optionAchievementType, optionTargets.get(schemeId) ?? new Map(), file, dealerNameById, range));
      continue;
    }
    if (!req) { schemes.push(base); continue; }

    const enrolled = new Set(enrolledMap.get(schemeId) ?? []);
    const required = new Set(req.products.map((p) => p.productId));
    const incoming = filterIncoming(file.matched, enrolled, required);

    // Categorisation counts (from the matched file facts).
    const notEnrolled = new Set<string>();
    const notRequired = new Set<string>();
    const matchedRequired = new Set<string>();
    for (const f of file.matched.values()) {
      if (required.has(f.productId)) {
        if (enrolled.has(f.dealerId)) matchedRequired.add(f.productId);
        else notEnrolled.add(f.dealerId);
      } else if (enrolled.has(f.dealerId)) {
        notRequired.add(f.productId);
      }
    }

    // Previous (other active scopes, EXCLUDING the exact range) + incoming → projected result (Phase 4).
    const impact = await computeSchemeUploadImpact(ctx, schemeId, { startDate: range.start, endDate: range.end }, incoming);
    const isCombined = req.type === "VALUE_BASED" && req.valueMode === "COMBINED";

    const lines: SchemeUploadImpactLine[] = impact.rows.map((r: UploadImpactRow) => {
      if (!dealerNameById.has(r.dealerId)) dealerNameById.set(r.dealerId, r.dealerId);
      return {
        dealerId: r.dealerId, dealerName: dealerNameById.get(r.dealerId) ?? r.dealerId,
        productId: r.productId, productName: productNameById.get(r.productId) ?? r.productId,
        requiredQty: r.requiredQty, requiredValue: r.requiredValue,
        previouslyAchievedQty: r.previouslyAchievedQty, previouslyAchievedValue: r.previouslyAchievedValue,
        incomingQty: r.newAchievedQty, incomingValue: r.newAchievedValue,
        newTotalQty: r.totalAchievedQty, newTotalValue: r.totalAchievedValue,
        remainingQty: r.remainingQty, remainingValue: r.remainingValue,
        completedBefore: r.completedBefore, completedAfter: r.completedAfter,
      };
    });

    // COMBINED completion is a per-dealer concept (single target across products), so derive it from the
    // per-product rows rather than the row-level flags (which are meaningless when each product's target=0).
    const combinedByDealer: CombinedDealerLine[] = [];
    let newlyCompleted = 0;
    if (isCombined) {
      const requiredValue = round2(req.combinedRequiredValue ?? 0);
      const byDealer = new Map<string, { prev: number; inc: number }>();
      for (const l of lines) {
        const cur = byDealer.get(l.dealerId) ?? { prev: 0, inc: 0 };
        cur.prev = round2(cur.prev + l.previouslyAchievedValue);
        cur.inc = round2(cur.inc + l.incomingValue);
        byDealer.set(l.dealerId, cur);
      }
      for (const [dealerId, sums] of byDealer) {
        const after = round2(sums.prev + sums.inc);
        const completedBefore = Math.round(sums.prev * 100) >= Math.round(requiredValue * 100);
        const completedAfter = Math.round(after * 100) >= Math.round(requiredValue * 100);
        if (completedAfter && !completedBefore) newlyCompleted += 1;
        combinedByDealer.push({
          dealerId, dealerName: dealerNameById.get(dealerId) ?? dealerId,
          requiredValue, previouslyAchievedValue: sums.prev, incomingValue: sums.inc, newTotalValue: after,
          remainingValue: round2(Math.max(requiredValue - after, 0)), completedBefore, completedAfter,
        });
      }
    } else {
      newlyCompleted = lines.filter((l) => l.completedAfter && !l.completedBefore).length;
    }

    const contributionEntries = [...incoming.values()];
    const incomingQty = round3(contributionEntries.reduce((s, x) => s + x.qty, 0));
    const incomingValue = round2(contributionEntries.reduce((s, x) => s + x.value, 0));
    const dealersAffected = new Set([...incoming.keys()].map((k) => k.split("|")[0])).size;
    const hasExistingScope = await hasExactActiveScope(schemeId, range);

    schemes.push({
      ...base,
      hasExistingScope,
      enrolledChecked: enrolled.size,
      matchedDealers: dealersAffected,
      notEnrolledDealers: notEnrolled.size,
      matchedRequiredProducts: matchedRequired.size,
      notRequiredProducts: notRequired.size,
      incomingQty, incomingValue, dealersAffected,
      newlyCompleted,
      contributions: incoming.size,
      lines, combinedByDealer,
    });
  }

  const totalContributions = schemes.reduce((s, x) => s + x.contributions, 0);
  return {
    fileName,
    startDate: range.start.toISOString(), endDate: range.end.toISOString(),
    parsedDealers: file.parsedDealers,
    unmatchedDealers: file.unmatchedDealers,
    unmatchedProducts: file.unmatchedProducts,
    schemes,
    totalContributions,
    anyExistingScope: schemes.some((s) => s.hasExistingScope),
  };
}

/**
 * Analyze one MULTIPLE_OPTIONS scheme: achievement is a single combined total over the ELIGIBLE pool vs each
 * enrolled dealer's FROZEN snapshot target. Non-eligible products are ignored; dealers without a snapshot
 * (not committed) never contribute. Mirrors the Fixed COMBINED shape but per-dealer, with an option target.
 */
async function analyzeOptionScheme(
  base: SchemeUploadSchemeAnalysis,
  cfg: SchemeOptionConfig,
  achievementType: OptionAchievementType,
  targetByDealer: Map<string, number>,
  file: ResolvedFile,
  dealerNameById: Map<string, string>,
  range: DateRange,
): Promise<SchemeUploadSchemeAnalysis> {
  const eligible = new Set(cfg.eligibleProductIds);
  const committed = new Set(targetByDealer.keys()); // enrolled dealers with a frozen snapshot target
  const incoming = filterIncoming(file.matched, committed, eligible);

  // Categorisation counts from the matched file facts.
  const notCommitted = new Set<string>();
  const notEligible = new Set<string>();
  const matchedEligible = new Set<string>();
  for (const f of file.matched.values()) {
    if (eligible.has(f.productId)) {
      if (committed.has(f.dealerId)) matchedEligible.add(f.productId);
      else notCommitted.add(f.dealerId);
    } else if (committed.has(f.dealerId)) {
      notEligible.add(f.productId);
    }
  }

  const impact = await computeSchemeOptionUploadImpact(base.schemeId, achievementType, cfg.eligibleProductIds, targetByDealer, { startDate: range.start, endDate: range.end }, incoming);
  const optionByDealer: OptionDealerLine[] = impact.rows.map((r: OptionUploadImpactRow) => {
    if (!dealerNameById.has(r.dealerId)) dealerNameById.set(r.dealerId, r.dealerId);
    return {
      dealerId: r.dealerId, dealerName: dealerNameById.get(r.dealerId) ?? r.dealerId,
      target: r.target, previouslyAchieved: r.previouslyAchieved, incoming: r.incoming, newTotal: r.newTotal,
      remaining: r.remaining, completedBefore: r.completedBefore, completedAfter: r.completedAfter,
    };
  });
  const contributionEntries = [...incoming.values()];
  const incomingQty = round3(contributionEntries.reduce((s, x) => s + x.qty, 0));
  const incomingValue = round2(contributionEntries.reduce((s, x) => s + x.value, 0));
  const dealersAffected = new Set([...incoming.keys()].map((k) => k.split("|")[0])).size;
  const hasExistingScope = await hasExactActiveScope(base.schemeId, range);

  return {
    ...base,
    hasExistingScope,
    enrolledChecked: committed.size,
    matchedDealers: dealersAffected,
    notEnrolledDealers: notCommitted.size,
    matchedRequiredProducts: matchedEligible.size,
    notRequiredProducts: notEligible.size,
    incomingQty, incomingValue, dealersAffected,
    newlyCompleted: optionByDealer.filter((l) => l.completedAfter && !l.completedBefore).length,
    contributions: incoming.size,
    lines: [], combinedByDealer: [], optionByDealer,
  };
}

/** True when an ACTIVE scope already exists for this scheme + EXACT date range (the replacement key). */
async function hasExactActiveScope(schemeId: string, range: { start: Date; end: Date }): Promise<boolean> {
  const found = await prisma.schemeUploadBatchScheme.findFirst({
    where: { schemeId, status: SchemeUploadStatus.ACTIVE, startDate: range.start, endDate: range.end },
    select: { id: true },
  });
  return !!found;
}

/* --------------------------------- commit --------------------------------- */

export interface SchemeUploadCommitScheme { schemeId: string; schemeName: string; contributions: number; dealersAffected: number; superseded: boolean }
export interface SchemeUploadResult { batchId: string; schemes: SchemeUploadCommitScheme[]; totalContributions: number }

/**
 * Commit — the ONLY writing step. Atomic. Writes ONLY the scheme tables (SchemeUploadBatch,
 * SchemeUploadBatchScheme, SchemeSale). For each selected scheme with ≥1 contribution:
 *   1. If an ACTIVE exact-range scope exists AND replacement is confirmed → mark it SUPERSEDED (never deleted).
 *   2. Create the new ACTIVE scope for (scheme + range).
 *   3. Bulk-insert its SchemeSale facts (enrolled dealer + required product only).
 * Same underlying sale contributes independently to each selected scheme (its own scope + facts). Schemes
 * with zero valid contributions are skipped (no meaningless data, no accidental supersede). Never touches
 * MonthlyEntry or any normal Sales Planning actual — there is no path to the Sales Upload commit.
 */
export async function commitSchemeUpload(ctx: AuthContext, buffer: Buffer, fileName: string, raw: unknown): Promise<SchemeUploadResult> {
  assertAdmin(ctx);
  const input = commitSchema.parse(raw);
  const range = parseRange(input);
  const schemeIds = [...new Set(input.schemeIds)];

  const file = await resolveFile(buffer);
  const [requirements, enrolledMap, schemeRows, optionConfig] = await Promise.all([
    loadSchemeRequirements(schemeIds),
    loadEnrolledDealerIds(ctx, schemeIds),
    prisma.scheme.findMany({ where: { id: { in: schemeIds } }, select: { id: true, schemeName: true, requirementType: true, valueMode: true, isPerpetual: true, startDate: true, endDate: true } }),
    loadSchemeOptionConfig(schemeIds),
  ]);
  const schemeById = new Map((schemeRows as { id: string; schemeName: string; requirementType: SchemeRequirementType; valueMode: "INDIVIDUAL" | "COMBINED" | null; isPerpetual: boolean; startDate: Date | null; endDate: Date | null }[]).map((s) => [s.id, s]));
  // Committed (snapshot) targets identify enrolled MULTIPLE_OPTIONS dealers; Fixed schemes ignore this.
  const optionTargets = await loadOptionSnapshotTargets(ctx, optionConfig, schemeIds);

  // Validate every selected scheme up front — a single invalid selection fails the whole request (nothing
  // is written), so the admin never gets a silent partial import outside a scheme's period.
  for (const schemeId of schemeIds) {
    const reason = schemeRangeInvalidReason(schemeById.get(schemeId), range);
    if (reason) throw new ApiError(422, `${schemeById.get(schemeId)?.schemeName ?? "Scheme"}: ${reason}`);
  }

  // Build each scheme's contributing facts + detect existing exact scopes.
  interface Plan { schemeId: string; schemeName: string; facts: MatchedFact[]; existingScopeId: string | null }
  const plans: Plan[] = [];
  for (const schemeId of schemeIds) {
    const cfg = optionConfig.get(schemeId);
    const isOption = cfg?.structure === "MULTIPLE_OPTIONS";
    // MULTIPLE_OPTIONS: contributing set = eligible pool + committed (snapshot) dealers.
    // FIXED: required products + enrolled dealers (unchanged).
    const req = requirements.get(schemeId)!;
    const dealerSet = isOption ? new Set((optionTargets.get(schemeId) ?? new Map()).keys()) : new Set(enrolledMap.get(schemeId) ?? []);
    const productSet = isOption ? new Set(cfg!.eligibleProductIds) : new Set(req.products.map((p) => p.productId));
    const facts: MatchedFact[] = [];
    for (const f of file.matched.values()) {
      if (!dealerSet.has(f.dealerId) || !productSet.has(f.productId)) continue;
      if (f.qty === 0 && f.value === 0) continue;
      facts.push(f);
    }
    const existing = await prisma.schemeUploadBatchScheme.findFirst({
      where: { schemeId, status: SchemeUploadStatus.ACTIVE, startDate: range.start, endDate: range.end },
      select: { id: true },
    });
    plans.push({ schemeId, schemeName: schemeById.get(schemeId)!.schemeName, facts, existingScopeId: existing?.id ?? null });
  }

  const toImport = plans.filter((p) => p.facts.length > 0);
  if (toImport.length === 0) throw new ApiError(422, "No valid scheme contributions to import from this file.");

  // Replacement guard: any scheme being imported that already has an exact-range ACTIVE scope requires
  // explicit confirmation (client sends replace=true after the prompt). We never silently double-count.
  const needsReplace = toImport.filter((p) => p.existingScopeId);
  if (needsReplace.length > 0 && !input.replace) {
    throw new ApiError(409, `Existing Scheme Upload data already exists for this date range: ${needsReplace.map((p) => p.schemeName).join(", ")}. Confirm replacement to supersede it.`);
  }

  const { committed: result, batchId } = await prisma.$transaction(async (tx) => {
    const batch = (await tx.schemeUploadBatch.create({
      data: { uploadedById: ctx.userId, fileName, startDate: range.start, endDate: range.end },
      select: { id: true },
    })) as { id: string };

    const committed: SchemeUploadCommitScheme[] = [];
    for (const p of toImport) {
      // 1. Supersede ONLY this scheme's exact-range ACTIVE scope(s) — enforces one active scope per
      //    scheme+range. Other schemes and other date ranges are untouched. History is preserved.
      if (p.existingScopeId) {
        await tx.schemeUploadBatchScheme.updateMany({
          where: { schemeId: p.schemeId, status: SchemeUploadStatus.ACTIVE, startDate: range.start, endDate: range.end },
          data: { status: SchemeUploadStatus.SUPERSEDED, supersededAt: new Date() },
        });
      }
      // 2. New ACTIVE scope.
      const matchedQty = round3(p.facts.reduce((s, f) => s + f.qty, 0));
      const matchedValue = round2(p.facts.reduce((s, f) => s + f.value, 0));
      const enrolledChecked = optionConfig.get(p.schemeId)?.structure === "MULTIPLE_OPTIONS"
        ? (optionTargets.get(p.schemeId)?.size ?? 0)
        : (enrolledMap.get(p.schemeId) ?? []).length;
      const scope = (await tx.schemeUploadBatchScheme.create({
        data: {
          batchId: batch.id, schemeId: p.schemeId, startDate: range.start, endDate: range.end,
          status: SchemeUploadStatus.ACTIVE, enrolledChecked, matchedQty, matchedValue,
        },
        select: { id: true },
      })) as { id: string };
      // 3. SchemeSale facts (audit-preserving raw names). Chunked createMany.
      const data = p.facts.map((f) => ({ scopeId: scope.id, dealerId: f.dealerId, productId: f.productId, qty: f.qty, value: f.value, rawDealerName: f.rawDealerName, rawProductName: f.rawProductName }));
      const CHUNK = 1000;
      for (let i = 0; i < data.length; i += CHUNK) await tx.schemeSale.createMany({ data: data.slice(i, i + CHUNK) });
      committed.push({ schemeId: p.schemeId, schemeName: p.schemeName, contributions: p.facts.length, dealersAffected: new Set(p.facts.map((f) => f.dealerId)).size, superseded: !!p.existingScopeId });
    }

    await writeAudit(
      {
        userId: ctx.userId, action: "CREATE", entity: "schemeUpload", entityId: batch.id,
        summary: JSON.stringify({
          fileName, startDate: range.start.toISOString(), endDate: range.end.toISOString(),
          schemes: committed.map((c) => ({ scheme: c.schemeName, contributions: c.contributions, dealersAffected: c.dealersAffected, replaced: c.superseded })),
        }),
      },
      tx,
    );
    return { committed, batchId: batch.id };
  });

  return { batchId, schemes: result, totalContributions: result.reduce((s, c) => s + c.contributions, 0) };
}

/* --------------------------------- history --------------------------------- */

export interface SchemeUploadHistoryRow {
  id: string; fileName: string; startDate: string; endDate: string; createdAt: string; uploadedByName: string;
  schemes: { schemeName: string; status: string; contributions: number }[];
}

/** Recent Scheme Upload batches (auditability). Superseded scopes are retained and shown. Admin-only. */
export async function listSchemeUploadHistory(ctx: AuthContext): Promise<SchemeUploadHistoryRow[]> {
  assertAdmin(ctx);
  const rows = (await prisma.schemeUploadBatch.findMany({
    orderBy: { createdAt: "desc" }, take: 50,
    select: {
      id: true, fileName: true, startDate: true, endDate: true, createdAt: true,
      uploadedBy: { select: { name: true } },
      scopes: { select: { status: true, scheme: { select: { schemeName: true } }, _count: { select: { sales: true } } } },
    },
  })) as {
    id: string; fileName: string; startDate: Date; endDate: Date; createdAt: Date; uploadedBy: { name: string };
    scopes: { status: string; scheme: { schemeName: string }; _count: { sales: number } }[];
  }[];
  return rows.map((b) => ({
    id: b.id, fileName: b.fileName, startDate: b.startDate.toISOString(), endDate: b.endDate.toISOString(), createdAt: b.createdAt.toISOString(),
    uploadedByName: b.uploadedBy.name,
    schemes: b.scopes.map((sc) => ({ schemeName: sc.scheme.schemeName, status: sc.status, contributions: sc._count.sales })),
  }));
}
