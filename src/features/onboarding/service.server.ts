import "server-only";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Role, ImportStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { tightKey } from "@/lib/match-key";
import { findOrCreateSeason } from "@/features/seasons/service.server";
import { applyDealerAssignment } from "@/features/assignments/service.server";
import { parseSeasonalWorkbook, commitSeasonalImport } from "@/features/import/seasonal/service.server";
import { extractExcelMasters, type OnboardingMasters } from "./excel-adapter.server";
import { buildImportDiagnostics, type OnboardingReport } from "./diagnostics";
import { CURRENT_REPORT_VERSION } from "./report";
import { CANONICAL_PLANNING_PACKS } from "@/lib/planning-packs";
import { writeAudit } from "@/lib/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can run onboarding");
}

/** The 7 canonical planning pack sizes — single source of truth (Section 41 decision). */
const CANONICAL_PACKS: string[] = [...CANONICAL_PLANNING_PACKS];

/* --------------------------------- Analyze -------------------------------- */

export interface OnboardingAnalysis {
  sourceName: string;
  officer: { name: string | null; matched: boolean };
  seasonHint: OnboardingMasters["seasonHint"];
  packSizes: { total: number; existing: number; missing: string[] };
  products: { total: number; existing: number; missing: number };
  dealers: { total: number; existing: number; missing: number };
  planningRows: number;
  warnings: string[];
}

async function countExisting(model: "product" | "dealer" | "packSize", names: string[]): Promise<Set<string>> {
  // Returns the set of input names (tight-keyed) that already exist in the master.
  const rows =
    model === "product"
      ? await prisma.product.findMany({ where: { isActive: true }, select: { name: true } })
      : model === "dealer"
        ? await prisma.dealer.findMany({ where: { isActive: true }, select: { name: true } })
        : await prisma.packSize.findMany({ where: { isActive: true }, select: { name: true } });
  const have = new Set((rows as { name: string }[]).map((r) => tightKey(r.name)));
  const matched = new Set<string>();
  for (const n of names) if (have.has(tightKey(n))) matched.add(n);
  return matched;
}

export async function analyzeOnboarding(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
): Promise<OnboardingAnalysis> {
  assertAdmin(ctx);
  const masters = extractExcelMasters(buffer, filename);
  const parse = await parseSeasonalWorkbook(ctx, buffer, filename); // dealers + planning rows (raw)

  const productNames = masters.products.map((p) => p.name);
  const [prodMatched, dealerMatched, packMatched] = await Promise.all([
    countExisting("product", productNames),
    countExisting("dealer", masters.dealerNames),
    countExisting("packSize", CANONICAL_PACKS),
  ]);

  const officerMatched = masters.officerName
    ? (await prisma.user.count({
        where: { role: Role.SALES_OFFICER, isActive: true, name: { contains: masters.officerName.split(/\s+/)[0], mode: "insensitive" } },
      })) > 0
    : false;

  const warnings: string[] = [];
  if (!masters.officerName) warnings.push("Sales Officer could not be detected from the filename — choose one at commit.");
  if (masters.products.length === 0) warnings.push("No PRICELIST products found — products cannot be created.");

  return {
    sourceName: filename,
    officer: { name: masters.officerName, matched: officerMatched },
    seasonHint: masters.seasonHint,
    packSizes: {
      total: CANONICAL_PACKS.length,
      existing: packMatched.size,
      missing: CANONICAL_PACKS.filter((n) => !packMatched.has(n)),
    },
    products: { total: productNames.length, existing: prodMatched.size, missing: productNames.length - prodMatched.size },
    dealers: { total: masters.dealerNames.length, existing: dealerMatched.size, missing: masters.dealerNames.length - dealerMatched.size },
    planningRows: parse.counts.productRows,
    warnings,
  };
}

/* --------------------------------- Commit --------------------------------- */

const commitSchema = z.object({
  seasonName: z.string().min(1),
  startMonth: z.coerce.number().int().min(1).max(12),
  startYear: z.coerce.number().int().min(2000).max(2100),
  endMonth: z.coerce.number().int().min(1).max(12),
  endYear: z.coerce.number().int().min(2000).max(2100),
  officerId: z.string().optional(), // if the admin picked/created an officer explicitly
  importAsApproved: z.boolean().default(false),
});
export type OnboardingCommitInput = z.infer<typeof commitSchema>;

function slugUsername(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  return base.length >= 3 ? base : `so_${base || "user"}`;
}

async function upsertPackSizes() {
  const existing = (await prisma.packSize.findMany({ select: { id: true, name: true } })) as { id: string; name: string }[];
  const byTight = new Map(existing.map((p) => [tightKey(p.name), p.id]));
  const createdNames: string[] = [];
  for (let i = 0; i < CANONICAL_PACKS.length; i++) {
    const id = byTight.get(tightKey(CANONICAL_PACKS[i]));
    if (id) {
      // Heal existing canonical pack: ensure it is a planning column, active, in order.
      await prisma.packSize.update({ where: { id }, data: { isPlanning: true, isActive: true, displayOrder: i + 1 } });
    } else {
      await prisma.packSize.create({ data: { name: CANONICAL_PACKS[i], displayOrder: i + 1, isPlanning: true } });
      createdNames.push(CANONICAL_PACKS[i]);
    }
  }
  return { created: createdNames.length, existing: CANONICAL_PACKS.length - createdNames.length, createdNames };
}

async function upsertProducts(products: OnboardingMasters["products"]) {
  const existing = (await prisma.product.findMany({ select: { name: true } })) as { name: string }[];
  const have = new Set(existing.map((p) => tightKey(p.name)));
  const createdNames: string[] = [];
  let matched = 0;
  for (const p of products) {
    if (have.has(tightKey(p.name))) {
      matched++;
      continue;
    }
    await prisma.product.create({
      data: { name: p.name, technicalName: p.technicalName, rate: p.rate, nbvPercent: p.nbvPercent },
    });
    have.add(tightKey(p.name));
    createdNames.push(p.name);
  }
  return { created: createdNames.length, matched, createdNames };
}

async function upsertDealers(names: string[]) {
  const existing = (await prisma.dealer.findMany({ where: { isActive: true }, select: { id: true, name: true } })) as {
    id: string;
    name: string;
  }[];
  const byTight = new Map(existing.map((d) => [tightKey(d.name), d.id]));
  const createdNames: string[] = [];
  let matched = 0;
  for (const name of names) {
    if (byTight.has(tightKey(name))) {
      matched++;
      continue;
    }
    const d = await prisma.dealer.create({ data: { name } });
    byTight.set(tightKey(name), d.id);
    createdNames.push(name);
  }
  return { created: createdNames.length, matched, createdNames };
}

async function findOrCreateOfficer(name: string | null, explicitId?: string): Promise<{ id: string; created: boolean }> {
  if (explicitId) return { id: explicitId, created: false };
  if (!name) throw new ApiError(422, "No Sales Officer detected — pick one before committing");
  const first = name.split(/\s+/)[0];
  const found = (await prisma.user.findFirst({
    where: { role: Role.SALES_OFFICER, isActive: true, name: { contains: first, mode: "insensitive" } },
    select: { id: true },
  })) as { id: string } | null;
  if (found) return { id: found.id, created: false };
  let username = slugUsername(name);
  let n = 1;
  while (await prisma.user.findUnique({ where: { username } })) username = `${slugUsername(name)}_${n++}`;
  const passwordHash = await bcrypt.hash("Password123!", 10);
  const u = await prisma.user.create({ data: { name, username, passwordHash, role: Role.SALES_OFFICER } });
  return { id: u.id, created: true };
}

/**
 * Orchestrate onboarding: idempotent master upserts, then create the Sales Plan by
 * reusing the lightweight Seasonal Plan Import (which assumes masters exist). No master
 * or planning business logic is duplicated here.
 */
export async function commitOnboarding(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  raw: unknown,
): Promise<OnboardingReport> {
  assertAdmin(ctx);
  const input = commitSchema.parse(raw);
  const masters = extractExcelMasters(buffer, filename);

  // 1) Master data — idempotent upserts (safe to re-run).
  const packRes = await upsertPackSizes();
  const prod = await upsertProducts(masters.products);
  const deal = await upsertDealers(masters.dealerNames);
  const officer = await findOrCreateOfficer(masters.officerName, input.officerId);
  const season = await findOrCreateSeason({
    name: input.seasonName,
    startMonth: input.startMonth,
    startYear: input.startYear,
    endMonth: input.endMonth,
    endYear: input.endYear,
  });

  // 2) Assign this workbook's dealers to the officer (scoping), idempotently.
  const effectiveFrom = new Date(input.startYear, input.startMonth - 1, 1);
  const dealerRows = (await prisma.dealer.findMany({ where: { isActive: true }, select: { id: true, name: true } })) as {
    id: string;
    name: string;
  }[];
  const dealerByTight = new Map(dealerRows.map((d) => [tightKey(d.name), d.id]));
  await prisma.$transaction(
    async (tx: Tx) => {
      for (const name of masters.dealerNames) {
        const id = dealerByTight.get(tightKey(name));
        if (id) await applyDealerAssignment(tx, id, officer.id, effectiveFrom);
      }
    },
    // Long-running import path on Vercel + Neon: extend beyond Prisma's 5s default. The
    // per-dealer assignment logic (range-closing + insert) is unchanged — batching it would
    // alter business behaviour, which is out of scope for this performance refactor.
    { timeout: 60000, maxWait: 10000 },
  );

  // 3) Sales Plan — re-parse now that masters exist, then reuse the seasonal importer.
  const parse = await parseSeasonalWorkbook(ctx, buffer, filename);
  const dealers = parse.dealers
    .filter((d) => d.dealerId && !d.duplicate)
    .map((d) => ({
      dealerId: d.dealerId as string,
      rows: d.rows
        .filter((r) => r.productId)
        .map((r) => ({
          productId: r.productId as string,
          packs: r.packs
            .filter((p) => p.packSizeId && p.quantity > 0)
            .map((p) => ({ packSizeId: p.packSizeId as string, quantity: p.quantity })),
          monthlyPlan: r.monthlyPlan,
        }))
        .filter((r) => r.packs.length > 0 || r.monthlyPlan.some((q) => q > 0)),
    }))
    .filter((d) => d.rows.length > 0);

  let planId: string | null = null;
  if (dealers.length > 0) {
    const result = await commitSeasonalImport(ctx, {
      seasonId: season.id,
      officerId: officer.id,
      workbookName: filename,
      mode: "COMPLETE",
      importAsApproved: input.importAsApproved,
      dealers,
    });
    planId = result.planId;
  }

  // Full auditable diagnostics: every non-imported row + reason, warnings, statistics.
  const diag = buildImportDiagnostics(parse, masters.products);
  if (dealers.length === 0) {
    diag.warnings.push({ type: "No Data", message: "No dealer rows resolved to masters — the Sales Plan was not created." });
  }

  const report: OnboardingReport = {
    version: CURRENT_REPORT_VERSION,
    workbookName: filename,
    summary: {
      packSizes: { total: CANONICAL_PACKS.length, existing: packRes.existing, created: packRes.created },
      products: { total: masters.products.length, matched: prod.matched, created: prod.created },
      dealers: { total: masters.dealerNames.length, matched: deal.matched, created: deal.created },
      planningRows: diag.planningRows,
      monthlyRows: diag.monthlyRows,
      totalSeasonalQuantity: diag.totalSeasonalQuantity,
      totalMonthlyQuantity: diag.totalMonthlyQuantity,
    },
    createdMasters: {
      packSizes: packRes.createdNames,
      products: prod.createdNames,
      dealers: deal.createdNames,
      officer: officer.created ? (masters.officerName ?? "New officer") : null,
      season: season.created ? input.seasonName : null,
    },
    matchedMasters: { products: prod.matched, dealers: deal.matched, officers: officer.created ? 0 : 1 },
    skippedRows: diag.skippedRows,
    warnings: diag.warnings,
    statistics: diag.statistics,
    planId,
    seasonId: season.id,
  };

  await prisma.onboardingRecord.create({
    data: {
      runById: ctx.userId,
      source: "EXCEL",
      sourceName: filename,
      seasonId: season.id,
      officerId: officer.id,
      status: ImportStatus.COMPLETED,
      report: JSON.stringify(report),
    },
  });
  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "onboarding",
    entityId: planId ?? season.id,
    summary: `Onboarding from ${filename}: +${prod.created} products, +${deal.created} dealers, ${planId ? "1 sales plan" : "no plan"}`,
  });

  return report;
}

export async function listOnboardingRuns(ctx: AuthContext) {
  assertAdmin(ctx);
  const rows = (await prisma.onboardingRecord.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { runBy: { select: { name: true } } },
  })) as {
    id: string;
    source: string;
    sourceName: string;
    status: string;
    report: string | null;
    createdAt: Date;
    runBy: { name: string };
  }[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sourceName: r.sourceName,
    status: r.status,
    report: r.report,
    createdAt: r.createdAt,
    runByName: r.runBy.name,
  }));
}
