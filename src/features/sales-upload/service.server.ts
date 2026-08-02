import "server-only";
import { z } from "zod";
import { Role, ImportStatus, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { decorate, matchByName, type Keyed } from "@/lib/match-key";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { writeAudit } from "@/lib/audit";
import { parseSalesWorkbook, type ParsedSalesWorkbook } from "./parser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can upload sales");
}

const inputSchema = z.object({
  seasonMonthId: z.string().min(1, "Select a Target Month"),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});
export type SalesUploadInput = z.infer<typeof inputSchema>;

type MasterItem = { id: string; name: string } & Keyed;

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
  unknownDealers: string[];
  unknownProducts: string[];
  dealersWithoutPlan: string[]; // matched dealer but no approved plan / assignment for this season
  dealersMatched: number;
  productsMatched: number;
  totalProductRows: number;
  mergedCount: number;
}

/**
 * Resolve the parsed workbook against masters (NO writes). Shared by analyze and commit so the
 * matching logic is defined once. Dealer: Alias → exact → loose → fuzzy. Product: exact → loose
 * → fuzzy (both via the shared matchByName). A row is importable only when the matched dealer +
 * product correspond to a PlanLine in an APPROVED, active seasonal plan for the target month's
 * season — that PlanDealer IS the dealer → Sales Officer link, so no officer is ever chosen.
 */
async function resolveWorkbook(parsed: ParsedSalesWorkbook, seasonMonthId: string): Promise<Resolution> {
  const month = await prisma.seasonMonth.findUnique({
    where: { id: seasonMonthId },
    include: { season: { select: { id: true, name: true, year: true } } },
  });
  if (!month) throw new ApiError(422, "The selected Target Month does not exist");

  const [resolver, productRows] = await Promise.all([
    loadDealerResolver(),
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
  ]);
  const products: MasterItem[] = decorate(productRows as { id: string; name: string }[]);

  // Approved active seasonal plans for this season → planLine lookup + dealers that have a plan.
  const plans = await prisma.planDealer.findMany({
    where: {
      seasonPlan: {
        seasonId: month.season.id,
        planningType: "SEASONAL",
        status: PlanStatus.APPROVED,
        isActiveVersion: true,
      },
    },
    select: { dealerId: true, lines: { select: { id: true, productId: true } } },
  });
  const planLineByKey = new Map<string, string>();
  const dealersWithPlan = new Set<string>();
  for (const pd of plans as { dealerId: string; lines: { id: string; productId: string }[] }[]) {
    dealersWithPlan.add(pd.dealerId);
    for (const l of pd.lines) planLineByKey.set(`${pd.dealerId}|${l.productId}`, l.id);
  }

  const rows: ResolvedRow[] = [];
  const unknownDealers: string[] = [];
  const unknownProducts = new Set<string>();
  const dealersWithoutPlan: string[] = [];
  const dealersMatched = new Set<string>();
  const productsMatched = new Set<string>();

  for (const d of parsed.dealers) {
    // Dealer: the ONE shared resolver — Alias → exact → loose → fuzzy (same as Recovery).
    const dealer = resolver.resolve(d.rawName);
    if (!dealer) {
      unknownDealers.push(d.rawName);
      continue;
    }
    dealersMatched.add(dealer.id);
    if (!dealersWithPlan.has(dealer.id)) dealersWithoutPlan.push(dealer.name);

    for (const p of d.products) {
      const product = matchByName(p.cleanName, products, { fuzzy: true, threshold: 0.9 });
      if (!product) {
        unknownProducts.add(p.cleanName);
        continue;
      }
      productsMatched.add(product.id);
      const planLineId = planLineByKey.get(`${dealer.id}|${product.id}`);
      if (!planLineId) continue; // matched, but not in an approved plan for this season
      rows.push({ planLineId, dealerId: dealer.id, productId: product.id, qty: p.qty, amount: p.amount });
    }
  }

  return {
    targetMonth: { id: month.id, name: month.name, seasonId: month.season.id, seasonName: `${month.season.name} ${month.season.year}` },
    rows,
    unknownDealers,
    unknownProducts: [...unknownProducts],
    dealersWithoutPlan: [...new Set(dealersWithoutPlan)],
    dealersMatched: dealersMatched.size,
    productsMatched: productsMatched.size,
    totalProductRows: parsed.totalProductRows,
    mergedCount: parsed.mergedCount,
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
  const res = await resolveWorkbook(parsed, input.seasonMonthId);

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
    warnings,
  };
}

export interface SalesUploadResult {
  runId: string;
  rowsImported: number;
  dealersUpdated: number;
  productsUpdated: number;
  unknownDealers: number;
  unknownProducts: number;
}

/**
 * Commit — the ONLY step that writes. Populates MonthlyEntry.saleQty / saleValue (the Actual
 * fields) for the target month; planQty / planValue are never touched. All writes happen in ONE
 * transaction. New entries are bulk-inserted with createMany (the Seasonal Import pattern);
 * existing entries are updated in concurrent batches (no per-row serial await). Amount comes
 * straight from the workbook — never recomputed.
 */
export async function commitSalesUpload(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  raw: unknown,
): Promise<SalesUploadResult> {
  assertAdmin(ctx);
  const input = inputSchema.parse(raw);
  const parsed = parseSalesWorkbook(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealer rows were found in the workbook");
  const res = await resolveWorkbook(parsed, input.seasonMonthId);
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
    runId = await prisma.$transaction(
      async (tx: Tx) => {
        // Which target entries already exist (so we UPDATE actuals) vs must be created.
        const existing = (await tx.monthlyEntry.findMany({
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
        if (creates.length > 0) await tx.monthlyEntry.createMany({ data: creates });

        // Existing entries: update ONLY the actual fields (saleQty/saleValue); planQty/planValue
        // are preserved. Batched with Promise.all (no serial await inside a loop).
        const CHUNK = 100;
        for (let i = 0; i < updates.length; i += CHUNK) {
          const slice = updates.slice(i, i + CHUNK);
          await Promise.all(
            slice.map((u) =>
              tx.monthlyEntry.update({ where: { id: u.id }, data: { saleQty: u.saleQty, saleValue: u.saleValue } }),
            ),
          );
        }

        const run = await tx.salesUploadRun.create({
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
            }),
          },
        });
        return run.id as string;
      },
      { timeout: 60000, maxWait: 10000 },
    );
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
    summary: `Sales Upload for ${res.targetMonth.seasonName} · ${res.targetMonth.name} — ${byLine.size} rows, ${dealersUpdatedCount} dealers, ${productsUpdatedCount} products (workbook: ${filename})`,
  });

  return {
    runId,
    rowsImported: byLine.size,
    dealersUpdated: dealersUpdatedCount,
    productsUpdated: productsUpdatedCount,
    unknownDealers: res.unknownDealers.length,
    unknownProducts: res.unknownProducts.length,
  };
}

/** Target-month options for the upload screen (every season's months). */
export async function listTargetMonths(ctx: AuthContext) {
  assertAdmin(ctx);
  const seasons = await prisma.season.findMany({
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
