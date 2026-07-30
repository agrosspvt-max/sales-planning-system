import "server-only";
import { z } from "zod";
import { PlanStatus, Role, ImportStatus, SeasonStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { detectOfficerFromFilename } from "@/features/import/dealers/service.server";
import { finalizeApprovalTx } from "@/features/planning/service.server";
import { looseKey, decorate, matchByName, type Keyed } from "@/lib/match-key";
import { writeAudit } from "@/lib/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can import plans");
}

/** Master sheets that are never dealer sheets (skipped, like the dealer import). */
const SKIP_SHEET = /price\s*list|product\s*plan|dealer\s*summary/i;
/** Empty placeholder dealer tabs ("Dealer 38"…"Dealer 50") — not real dealers. */
const PLACEHOLDER_SHEET = /^\s*dealer\s+\d+\s*$/i;
const TOTAL_ROW = /^(grand\s*)?total/i;
// The product-name column is matched by WHOLE-CELL header text (via looseKey), never a
// substring — otherwise the sheet title ("MP SEASON PRODUCT PLAN…") or the "DEALER NAME"
// label would be mistaken for the header row and the real pack columns (row 3) never read.
const PRODUCT_HEADER_KEYS = new Set(["product name", "product", "item name", "item", "name"]);
const isProductHeaderCell = (c: string) => PRODUCT_HEADER_KEYS.has(looseKey(c));
const PACKISH = /\d|\b(kg|kgs|g|gm|gms|ml|ltr|lt|l)\b/i;

/* --------------------------------- Parse ---------------------------------- */

type MasterItem = { id: string; name: string } & Keyed;
interface Master {
  dealers: MasterItem[];
  products: MasterItem[];
  packs: MasterItem[];
}

async function loadMasters(): Promise<Master> {
  const [dealers, products, packs] = await Promise.all([
    prisma.dealer.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    prisma.packSize.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
  ]);
  return {
    dealers: decorate(dealers),
    products: decorate(products),
    packs: decorate(packs),
  };
}

function toNum(v: string | number | null): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export interface ParsedPack {
  header: string;
  packSizeId: string | null;
  quantity: number;
}
export interface ParsedRow {
  productName: string;
  productId: string | null;
  packs: ParsedPack[];
  totalQty: number;
  /** Per-month PLAN quantities (Complete Workbook mode), in month order. Never actuals. */
  monthlyPlan: number[];
}
export interface ParsedDealer {
  sheetName: string;
  dealerName: string;
  dealerId: string | null;
  duplicate: boolean;
  rows: ParsedRow[];
}
export interface SeasonalParseResult {
  workbookName: string;
  officerCandidates: { name: string; matches: { id: string; name: string }[] }[];
  dealers: ParsedDealer[];
  counts: {
    dealerCount: number;
    productRows: number;
    missingDealers: number;
    missingProducts: number;
    unknownPackSizes: number;
    duplicateDealers: number;
  };
  missingDealers: string[];
  missingProducts: string[];
  unknownPackSizes: string[];
  /** Dealer-like sheets that yielded no readable rows (header not detected / empty). */
  skippedSheets: string[];
}

/** Resolve a raw workbook value to a master (tight → loose → fuzzy), via the shared utility. */
function resolveMaster(list: MasterItem[], value: string): MasterItem | null {
  return matchByName(value, list, { fuzzy: true, threshold: 0.9 });
}

/** Parse a dealer sheet into product rows. Header = first row that names a pack size or a product column. */
function parseDealerSheet(rows: (string | number | null)[][], packs: Master["packs"]) {
  let headerIdx = -1;
  let productCol = 0;
  let packCols: { col: number; header: string; packSizeId: string | null }[] = [];
  let monthPlanCols: number[] = []; // columns whose header is exactly "QTY" (each month's plan qty)

  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r] ?? [];
    const cells = row.map((c) => (typeof c === "string" ? c : c === null ? "" : String(c)));
    const matchedPack = cells
      .map((c, i) => ({ i, c, pk: c ? resolveMaster(packs, c) : null }))
      .filter((x) => x.pk);
    const productColIdx = cells.findIndex((c) => isProductHeaderCell(c));
    if (matchedPack.length >= 1 || productColIdx >= 0) {
      headerIdx = r;
      productCol = productColIdx >= 0 ? productColIdx : 0;
      // Pack columns: matched pack-size headers, plus "unknown pack-ish" headers to the right of product col.
      packCols = cells
        .map((c, i) => ({ col: i, header: c.trim(), pk: c ? resolveMaster(packs, c) : null }))
        .filter((x) => x.col !== productCol && x.header && (x.pk || PACKISH.test(x.header)))
        .map((x) => ({ col: x.col, header: x.header, packSizeId: x.pk?.id ?? null }));
      // Month PLAN-qty columns: each month block starts with a header cell exactly "QTY".
      monthPlanCols = cells
        .map((c, i) => ({ i, n: looseKey(c) }))
        .filter((x) => x.n === "qty")
        .map((x) => x.i);
      break;
    }
  }

  const parsed: { productName: string; packs: ParsedPack[]; monthlyPlan: number[] }[] = [];
  if (headerIdx >= 0 && packCols.length > 0) {
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const nameCell = row[productCol];
      const productName = typeof nameCell === "string" ? nameCell.trim() : nameCell === null ? "" : String(nameCell);
      if (!productName || TOTAL_ROW.test(productName)) continue;
      const packVals = packCols.map((pc) => ({
        header: pc.header,
        packSizeId: pc.packSizeId,
        quantity: Math.max(0, Math.floor(toNum(row[pc.col]))),
      }));
      const monthlyPlan = monthPlanCols.map((c) => Math.max(0, Math.floor(toNum(row[c]))));
      if (packVals.every((p) => p.quantity === 0) && monthlyPlan.every((q) => q === 0)) continue;
      parsed.push({ productName, packs: packVals, monthlyPlan });
    }
  }
  return parsed;
}

export async function parseSeasonalWorkbook(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
): Promise<SeasonalParseResult> {
  assertAdmin(ctx);
  const wb = readWorkbook(buffer);
  const names = sheetNames(wb);
  const masters = await loadMasters();

  // Officer detection from filename.
  const officerCandidates: SeasonalParseResult["officerCandidates"] = [];
  const detected = detectOfficerFromFilename(filename);
  if (detected) {
    const first = detected.split(/\s+/)[0];
    const matches = await prisma.user.findMany({
      where: { role: Role.SALES_OFFICER, isActive: true, name: { contains: first, mode: "insensitive" } },
      select: { id: true, name: true },
      take: 5,
    });
    officerCandidates.push({ name: detected, matches });
  }

  const missingProducts = new Set<string>();
  const unknownPackSizes = new Set<string>();
  const seenDealerIds = new Set<string>();
  const missingDealers: string[] = [];
  const skippedSheets: string[] = [];
  const dealers: ParsedDealer[] = [];

  for (const sheet of names) {
    if (SKIP_SHEET.test(sheet) || PLACEHOLDER_SHEET.test(sheet) || !looseKey(sheet)) continue;
    const rows = sheetRows(wb, sheet);
    const parsedRows = parseDealerSheet(rows, masters.packs);
    if (parsedRows.length === 0) {
      skippedSheets.push(sheet); // dealer-like sheet with no readable rows — surfaced, not silent
      continue;
    }

    const dealerMatch = resolveMaster(masters.dealers, sheet);
    if (!dealerMatch) missingDealers.push(sheet);
    const duplicate = dealerMatch ? seenDealerIds.has(dealerMatch.id) : false;
    if (dealerMatch) seenDealerIds.add(dealerMatch.id);

    const rowsOut: ParsedRow[] = parsedRows.map((pr) => {
      const productMatch = resolveMaster(masters.products, pr.productName);
      if (!productMatch) missingProducts.add(pr.productName);
      for (const p of pr.packs) {
        if (!p.packSizeId && p.quantity > 0) unknownPackSizes.add(p.header);
      }
      return {
        productName: pr.productName,
        productId: productMatch?.id ?? null,
        packs: pr.packs,
        totalQty: pr.packs.reduce((s, p) => s + p.quantity, 0),
        monthlyPlan: pr.monthlyPlan,
      };
    });

    dealers.push({
      sheetName: sheet,
      dealerName: dealerMatch?.name ?? sheet,
      dealerId: dealerMatch?.id ?? null,
      duplicate,
      rows: rowsOut,
    });
  }

  const productRows = dealers.reduce((s, d) => s + d.rows.length, 0);
  return {
    workbookName: filename,
    officerCandidates,
    dealers,
    counts: {
      dealerCount: dealers.length,
      productRows,
      missingDealers: missingDealers.length,
      missingProducts: missingProducts.size,
      unknownPackSizes: unknownPackSizes.size,
      duplicateDealers: dealers.filter((d) => d.duplicate).length,
    },
    missingDealers,
    missingProducts: [...missingProducts],
    unknownPackSizes: [...unknownPackSizes],
    skippedSheets,
  };
}

/* --------------------------------- Commit --------------------------------- */

const commitSchema = z.object({
  seasonId: z.string().min(1),
  officerId: z.string().min(1),
  workbookName: z.string().default("workbook"),
  // "SEASONAL_ONLY" (packs) or "COMPLETE" (packs + monthly plan quantities).
  mode: z.enum(["SEASONAL_ONLY", "COMPLETE"]).default("SEASONAL_ONLY"),
  // Optional: mark the imported version APPROVED/active on commit (authorised users only).
  importAsApproved: z.boolean().default(false),
  dealers: z.array(
    z.object({
      dealerId: z.string().min(1),
      rows: z.array(
        z.object({
          productId: z.string().min(1),
          packs: z.array(
            z.object({ packSizeId: z.string().min(1), quantity: z.coerce.number().int().min(0) }),
          ),
          monthlyPlan: z.array(z.coerce.number().int().min(0)).optional().default([]),
        }),
      ),
    }),
  ),
});

export interface SeasonalImportResult {
  planId: string;
  dealerCount: number;
  productRows: number;
}

/**
 * Validate everything, then create the whole Season Plan in ONE transaction. Nothing is
 * written unless validation passes. The imported plan is an ordinary DRAFT SeasonPlan
 * (source = IMPORT) that then flows through the normal approval/monthly/reports pipeline.
 */
export async function commitSeasonalImport(ctx: AuthContext, raw: unknown): Promise<SeasonalImportResult> {
  assertAdmin(ctx);
  const payload = commitSchema.parse(raw);

  // --- Validation (no writes) ---
  const season = await prisma.season.findUnique({ where: { id: payload.seasonId } });
  if (!season) throw new ApiError(422, "Season does not exist");
  if (season.status !== SeasonStatus.OPEN) throw new ApiError(422, "The season is closed; open it before importing");

  const officer = await prisma.user.findUnique({ where: { id: payload.officerId } });
  if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive) {
    throw new ApiError(422, "The selected Sales Officer is missing or inactive");
  }

  const dealers = payload.dealers.filter((d) => d.rows.length > 0);
  if (dealers.length === 0) throw new ApiError(422, "Nothing to import — no matched dealers with rows");

  const dealerIds = [...new Set(dealers.map((d) => d.dealerId))];
  if (dealerIds.length !== dealers.length) throw new ApiError(422, "Duplicate dealer in the import payload");

  const [dealerCount, productCount, packCount] = await Promise.all([
    prisma.dealer.count({ where: { id: { in: dealerIds } } }),
    prisma.product.count({ where: { id: { in: [...new Set(dealers.flatMap((d) => d.rows.map((r) => r.productId)))] } } }),
    prisma.packSize.count({
      where: { id: { in: [...new Set(dealers.flatMap((d) => d.rows.flatMap((r) => r.packs.map((p) => p.packSizeId))))] } },
    }),
  ]);
  if (dealerCount !== dealerIds.length) throw new ApiError(422, "One or more dealers no longer exist");
  const productIds = [...new Set(dealers.flatMap((d) => d.rows.map((r) => r.productId)))];
  if (productCount !== productIds.length) throw new ApiError(422, "One or more products no longer exist");
  const packIds = [...new Set(dealers.flatMap((d) => d.rows.flatMap((r) => r.packs.map((p) => p.packSizeId))))];
  if (packCount !== packIds.length) throw new ApiError(422, "One or more pack sizes no longer exist");

  const productRows = dealers.reduce((s, d) => s + d.rows.length, 0);

  // Next version for this officer/season/SEASONAL.
  const maxV = await prisma.seasonPlan.aggregate({
    where: { seasonId: payload.seasonId, officerId: payload.officerId, planningType: "SEASONAL" },
    _max: { version: true },
  });
  const version = (maxV._max.version ?? 0) + 1;

  let planId = "";
  try {
    await prisma.$transaction(async (tx: Tx) => {
      const plan = await tx.seasonPlan.create({
        data: {
          seasonId: payload.seasonId,
          officerId: payload.officerId,
          planningType: "SEASONAL",
          version,
          versionName: "Imported from Excel",
          source: "IMPORT",
          status: PlanStatus.DRAFT,
          dealers: {
            create: dealers.map((d) => ({
              dealerId: d.dealerId,
              lines: {
                create: d.rows.map((r) => ({
                  productId: r.productId,
                  packs: {
                    create: r.packs
                      .filter((p) => p.quantity > 0)
                      .map((p) => ({ packSizeId: p.packSizeId, quantity: p.quantity })),
                  },
                })),
              },
            })),
          },
        },
      });
      planId = plan.id;

      // Complete Workbook mode: also migrate existing Monthly plan quantities. This
      // bypasses the "monthly only after approval" gate — migration exception only.
      if (payload.mode === "COMPLETE") {
        const months = await tx.seasonMonth.findMany({
          where: { seasonId: payload.seasonId },
          orderBy: { order: "asc" },
          select: { id: true },
        });
        if (months.length > 0) {
          const lines = await tx.planLine.findMany({
            where: { planDealer: { seasonPlanId: plan.id } },
            select: { id: true, productId: true, planDealer: { select: { dealerId: true } } },
          });
          const lineMap = new Map<string, string>(
            lines.map((l: { id: string; productId: string; planDealer: { dealerId: string } }) => [
              `${l.planDealer.dealerId}|${l.productId}`,
              l.id,
            ]),
          );
          const entries: { planLineId: string; seasonMonthId: string; planQty: number }[] = [];
          for (const d of dealers) {
            for (const r of d.rows) {
              const lineId = lineMap.get(`${d.dealerId}|${r.productId}`);
              if (!lineId) continue;
              r.monthlyPlan.forEach((q, i) => {
                if (i < months.length && q > 0) {
                  entries.push({ planLineId: lineId, seasonMonthId: months[i].id, planQty: q });
                }
              });
            }
          }
          if (entries.length > 0) {
            await tx.monthlyEntry.createMany({ data: entries });
            // Open-Month initialization for imports (Section 42): a month that received imported
            // monthly-plan data represents an in-progress planning window carried over from Excel,
            // so auto-open it (only if still LOCKED — never override management's OPEN/CLOSED).
            const monthIdsWithData = [...new Set(entries.map((e) => e.seasonMonthId))];
            await tx.seasonMonth.updateMany({
              where: { id: { in: monthIdsWithData }, status: "LOCKED" },
              data: { status: "OPEN" },
            });
          }
        }
      }

      // Optional: mark this imported version APPROVED/active (authorised users only),
      // reusing the SAME approval finalisation as the normal approve flow.
      if (payload.importAsApproved) {
        await finalizeApprovalTx(tx, {
          id: plan.id,
          seasonId: payload.seasonId,
          officerId: payload.officerId,
          planningType: "SEASONAL",
        });
      }

      await tx.seasonPlanImportRecord.create({
        data: {
          importedById: ctx.userId,
          seasonId: payload.seasonId,
          officerId: payload.officerId,
          workbookName: payload.workbookName,
          dealerCount: dealers.length,
          productRows,
          status: ImportStatus.COMPLETED,
          summary: JSON.stringify({ dealerCount: dealers.length, productRows, version }),
        },
      });
    });
  } catch (e) {
    await prisma.seasonPlanImportRecord.create({
      data: {
        importedById: ctx.userId,
        seasonId: payload.seasonId,
        officerId: payload.officerId,
        workbookName: payload.workbookName,
        dealerCount: dealers.length,
        productRows,
        status: ImportStatus.FAILED,
        summary: JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      },
    });
    throw e;
  }

  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "seasonPlanImport",
    entityId: planId,
    summary: `Imported seasonal plan for ${officer.name} — ${dealers.length} dealers, ${productRows} product rows (v${version})`,
  });

  return { planId, dealerCount: dealers.length, productRows };
}
