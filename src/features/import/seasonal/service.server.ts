import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PlanStatus, Role, ImportStatus, SeasonStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { detectOfficerFromFilename } from "@/features/import/dealers/service.server";
import { finalizeApprovalTx } from "@/features/planning/service.server";
import { looseKey, tightKey, decorate, matchByName, type Keyed } from "@/lib/match-key";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { applyDealerAssignment } from "@/features/assignments/service.server";
import { writeAudit } from "@/lib/audit";

/** How a workbook dealer resolved during Seasonal Import (Existing / New-to-onboard / Invalid). */
export type ImportDealerStatus = "EXISTING" | "NEW" | "INVALID";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN)
    throw new ApiError(403, "Only the Super Admin can import plans");
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
  /** EXISTING (matched a master) · NEW (unmatched but valid — can be onboarded) · INVALID (error). */
  status: ImportDealerStatus;
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
    existingDealers: number;
    newDealers: number;
    invalidDealers: number;
    missingProducts: number;
    unknownPackSizes: number;
    duplicateDealers: number;
  };
  /** Names of dealers not found in the master — candidates to onboard as NEW. */
  newDealerNames: string[];
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
      const productName =
        typeof nameCell === "string" ? nameCell.trim() : nameCell === null ? "" : String(nameCell);
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
  const [masters, dealerResolver] = await Promise.all([loadMasters(), loadDealerResolver()]);

  // Officer detection from filename.
  const officerCandidates: SeasonalParseResult["officerCandidates"] = [];
  const detected = detectOfficerFromFilename(filename);
  if (detected) {
    const first = detected.split(/\s+/)[0];
    const matches = await prisma.user.findMany({
      where: {
        role: Role.SALES_OFFICER,
        isActive: true,
        name: { contains: first, mode: "insensitive" },
      },
      select: { id: true, name: true },
      take: 5,
    });
    officerCandidates.push({ name: detected, matches });
  }

  const missingProducts = new Set<string>();
  const unknownPackSizes = new Set<string>();
  const seenDealerIds = new Set<string>();
  const seenNewKeys = new Set<string>();
  const newDealerNames: string[] = [];
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

    // Reusable 3-outcome dealer resolution (alias → exact → loose → fuzzy → NEW/INVALID).
    const cls = dealerResolver.classify(sheet);
    let dealerId: string | null = null;
    let dealerName = sheet;
    let status: ImportDealerStatus;
    let duplicate = false;
    if (cls.outcome === "EXISTING") {
      status = "EXISTING";
      dealerId = cls.dealer.id;
      dealerName = cls.dealer.name;
      duplicate = seenDealerIds.has(dealerId);
      seenDealerIds.add(dealerId);
    } else if (cls.outcome === "NEW") {
      status = "NEW";
      dealerName = cls.rawName;
      const key = tightKey(cls.rawName);
      duplicate = seenNewKeys.has(key); // same new dealer on two sheets → onboard once
      seenNewKeys.add(key);
      if (!duplicate) newDealerNames.push(cls.rawName);
    } else {
      status = "INVALID";
    }

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

    dealers.push({ sheetName: sheet, dealerName, dealerId, status, duplicate, rows: rowsOut });
  }

  const productRows = dealers.reduce((s, d) => s + d.rows.length, 0);
  return {
    workbookName: filename,
    officerCandidates,
    dealers,
    counts: {
      dealerCount: dealers.length,
      productRows,
      existingDealers: dealers.filter((d) => d.status === "EXISTING").length,
      newDealers: dealers.filter((d) => d.status === "NEW").length,
      invalidDealers: dealers.filter((d) => d.status === "INVALID").length,
      missingProducts: missingProducts.size,
      unknownPackSizes: unknownPackSizes.size,
      duplicateDealers: dealers.filter((d) => d.duplicate).length,
    },
    newDealerNames,
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
  // Onboard unmatched (NEW) dealers into the Dealer Master during import (default on).
  autoCreateNewDealers: z.boolean().default(true),
  dealers: z.array(
    z.object({
      // Existing dealers carry a `dealerId`; NEW dealers carry a `dealerName` with a null id.
      dealerId: z.string().min(1).nullable().default(null),
      dealerName: z.string().optional(),
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
  existingDealers: number;
  createdDealers: number;
  skippedDealers: number;
}

/**
 * Validate everything, then create the whole Season Plan in ONE transaction. Nothing is
 * written unless validation passes. The imported plan is an ordinary DRAFT SeasonPlan
 * (source = IMPORT) that then flows through the normal approval/monthly/reports pipeline.
 */
export async function commitSeasonalImport(
  ctx: AuthContext,
  raw: unknown,
): Promise<SeasonalImportResult> {
  assertAdmin(ctx);
  const payload = commitSchema.parse(raw);

  // --- Validation (no writes) ---
  const season = await prisma.season.findUnique({ where: { id: payload.seasonId } });
  if (!season) throw new ApiError(422, "Season does not exist");
  if (season.status !== SeasonStatus.OPEN)
    throw new ApiError(422, "The season is closed; open it before importing");

  const officer = await prisma.user.findUnique({ where: { id: payload.officerId } });
  if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive) {
    throw new ApiError(422, "The selected Sales Officer is missing or inactive");
  }

  const withRows = payload.dealers.filter((d) => d.rows.length > 0);
  if (withRows.length === 0)
    throw new ApiError(422, "Nothing to import — no dealers with matched rows");

  // --- Resolve each payload dealer to a target dealerId (DUPLICATE-SAFE) ---------------------
  // Existing dealers use their id. NEW dealers are re-matched here (alias → exact → loose → fuzzy)
  // against the CURRENT master — if one now matches (e.g. created since the preview) it is reused,
  // never duplicated; otherwise it is queued for creation with a client-generated id. New dealers
  // are only created when `autoCreateNewDealers` is on; otherwise they are skipped (not imported).
  const resolver = await loadDealerResolver();
  const toImport: { dealerId: string; rows: (typeof withRows)[number]["rows"] }[] = [];
  const toCreate = new Map<string, { id: string; name: string }>(); // tightKey → dealer to create
  let skippedDealers = 0;

  for (const d of withRows) {
    if (d.dealerId) {
      toImport.push({ dealerId: d.dealerId, rows: d.rows });
      continue;
    }
    const name = (d.dealerName ?? "").trim();
    const cls = name ? resolver.classify(name) : ({ outcome: "INVALID" } as const);
    if (cls.outcome === "EXISTING") {
      toImport.push({ dealerId: cls.dealer.id, rows: d.rows }); // matched at commit — reuse, don't duplicate
    } else if (cls.outcome === "NEW" && payload.autoCreateNewDealers) {
      const key = tightKey(cls.rawName);
      let entry = toCreate.get(key);
      if (!entry) {
        entry = { id: randomUUID(), name: cls.rawName };
        toCreate.set(key, entry);
      }
      toImport.push({ dealerId: entry.id, rows: d.rows });
    } else {
      skippedDealers += 1; // NEW with auto-create off, or INVALID — never modified/created
    }
  }

  if (toImport.length === 0)
    throw new ApiError(422, "Nothing to import — no importable dealers after resolution");

  const importDealerIds = toImport.map((d) => d.dealerId);
  if (new Set(importDealerIds).size !== importDealerIds.length)
    throw new ApiError(422, "Duplicate dealer in the import payload");

  // Validate ONLY the existing dealers (the to-create ids don't exist yet — created in the tx).
  const createIds = new Set([...toCreate.values()].map((c) => c.id));
  const existingIds = importDealerIds.filter((id) => !createIds.has(id));
  const productIds = [...new Set(toImport.flatMap((d) => d.rows.map((r) => r.productId)))];
  const packIds = [...new Set(toImport.flatMap((d) => d.rows.flatMap((r) => r.packs.map((p) => p.packSizeId))))];
  const [dealerCount, productCount, packCount] = await Promise.all([
    prisma.dealer.count({ where: { id: { in: existingIds } } }),
    prisma.product.count({ where: { id: { in: productIds } } }),
    prisma.packSize.count({ where: { id: { in: packIds } } }),
  ]);
  if (dealerCount !== existingIds.length) throw new ApiError(422, "One or more dealers no longer exist");
  if (productCount !== productIds.length) throw new ApiError(422, "One or more products no longer exist");
  if (packCount !== packIds.length) throw new ApiError(422, "One or more pack sizes no longer exist");

  const productRows = toImport.reduce((s, d) => s + d.rows.length, 0);
  const createdDealers = toCreate.size;
  const effectiveFrom = new Date();

  // Next version for this officer/season/SEASONAL.
  const maxV = await prisma.seasonPlan.aggregate({
    where: { seasonId: payload.seasonId, officerId: payload.officerId, planningType: "SEASONAL" },
    _max: { version: true },
  });
  const version = (maxV._max.version ?? 0) + 1;

  // --- Payload preparation (NO writes, NO locking) --------------------------------------
  // The whole entity graph is materialised in memory with client-generated ids, so the
  // transaction can bulk-insert each level with createMany() instead of thousands of nested,
  // sequential inserts. IDs are opaque strings; generating them here lets us wire the foreign
  // keys (planLine → planDealer, packs/monthly → planLine) without reading rows back.
  const planId = randomUUID();

  const planDealerRows: { id: string; seasonPlanId: string; dealerId: string }[] = [];
  const planLineRows: { id: string; planDealerId: string; productId: string }[] = [];
  const planPackRows: { planLineId: string; packSizeId: string; quantity: number }[] = [];
  // "dealerId|productId" → planLineId — the same key the monthly step used before.
  const lineIdByKey = new Map<string, string>();

  for (const d of toImport) {
    const planDealerId = randomUUID();
    planDealerRows.push({ id: planDealerId, seasonPlanId: planId, dealerId: d.dealerId });
    for (const r of d.rows) {
      const planLineId = randomUUID();
      planLineRows.push({ id: planLineId, planDealerId, productId: r.productId });
      lineIdByKey.set(`${d.dealerId}|${r.productId}`, planLineId);
      // Preserve the original rule: a pack row only for quantity > 0.
      for (const p of r.packs) {
        if (p.quantity > 0)
          planPackRows.push({ planLineId, packSizeId: p.packSizeId, quantity: p.quantity });
      }
    }
  }

  // Complete Workbook mode: prepare monthly plan-qty rows. The month lookup is a READ, so it
  // runs OUTSIDE the transaction; the mapping/filtering below is byte-for-byte the original
  // logic (per-month plan qty, in month order, only q > 0, bounded by the season's months).

  //let to const
  const monthlyEntryRows: { planLineId: string; seasonMonthId: string; planQty: number }[] = [];
  let monthIdsWithData: string[] = [];
  if (payload.mode === "COMPLETE") {
    const months = await prisma.seasonMonth.findMany({
      where: { seasonId: payload.seasonId },
      orderBy: { order: "asc" },
      select: { id: true },
    });
    if (months.length > 0) {
      for (const d of toImport) {
        for (const r of d.rows) {
          const lineId = lineIdByKey.get(`${d.dealerId}|${r.productId}`);
          if (!lineId) continue;
          r.monthlyPlan.forEach((q, i) => {
            if (i < months.length && q > 0) {
              monthlyEntryRows.push({
                planLineId: lineId,
                seasonMonthId: months[i].id,
                planQty: q,
              });
            }
          });
        }
      }
      monthIdsWithData = [...new Set(monthlyEntryRows.map((e) => e.seasonMonthId))];
    }
  }

  // --- Writes only (single atomic transaction) ------------------------------------------
  // Extended timeout for Vercel + Neon (each network round-trip is far slower than
  // localhost). Every level is ONE createMany statement, so the whole import is a small,
  // bounded number of statements regardless of workbook size. Written parent-first so
  // foreign keys resolve: SeasonPlan → PlanDealers → PlanLines → PlanPacks → MonthlyEntries.
  try {
    await prisma.$transaction(
      async (tx: Tx) => {
        // Onboard NEW dealers FIRST, in the SAME transaction — a normal active Dealer Master record
        // assigned to the selected officer (reusing the shared assignment helper). If any creation
        // fails the whole import rolls back (no partial onboarding, no orphan dealers).
        for (const c of toCreate.values()) {
          await tx.dealer.create({
            data: { id: c.id, name: c.name, status: "ACTIVE", isActive: true, createdByUserId: ctx.userId, createdFrom: "SEASONAL_IMPORT" },
          });
          await applyDealerAssignment(tx, c.id, payload.officerId, effectiveFrom);
        }

        await tx.seasonPlan.create({
          data: {
            id: planId,
            seasonId: payload.seasonId,
            officerId: payload.officerId,
            planningType: "SEASONAL",
            version,
            versionName: "Imported from Excel",
            source: "IMPORT",
            status: PlanStatus.DRAFT,
          },
        });

        if (planDealerRows.length > 0) await tx.planDealer.createMany({ data: planDealerRows });
        if (planLineRows.length > 0) await tx.planLine.createMany({ data: planLineRows });
        if (planPackRows.length > 0) await tx.planLinePack.createMany({ data: planPackRows });

        // Complete Workbook mode: migrate existing Monthly plan quantities. This bypasses the
        // "monthly only after approval" gate — migration exception only. Behaviour unchanged:
        // bulk-insert entries, then auto-open only still-LOCKED months that received data
        // (never override management's OPEN/CLOSED).
        if (payload.mode === "COMPLETE" && monthlyEntryRows.length > 0) {
          await tx.monthlyEntry.createMany({ data: monthlyEntryRows });
          await tx.seasonMonth.updateMany({
            where: { id: { in: monthIdsWithData }, status: "LOCKED" },
            data: { status: "OPEN" },
          });
        }

        // Optional: mark this imported version APPROVED/active (authorised users only),
        // reusing the SAME approval finalisation as the normal approve flow (unchanged).
        if (payload.importAsApproved) {
          await finalizeApprovalTx(tx, {
            id: planId,
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
            dealerCount: toImport.length,
            productRows,
            status: ImportStatus.COMPLETED,
            summary: JSON.stringify({ dealerCount: toImport.length, productRows, version, createdDealers, skippedDealers }),
          },
        });
      },
      { timeout: 60000, maxWait: 10000 },
    );
  } catch (e) {
    await prisma.seasonPlanImportRecord.create({
      data: {
        importedById: ctx.userId,
        seasonId: payload.seasonId,
        officerId: payload.officerId,
        workbookName: payload.workbookName,
        dealerCount: toImport.length,
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
    summary: `Imported seasonal plan for ${officer.name} — ${toImport.length} dealers (${createdDealers} new), ${productRows} product rows (v${version})`,
  });

  return {
    planId,
    dealerCount: toImport.length,
    productRows,
    existingDealers: existingIds.length,
    createdDealers,
    skippedDealers,
  };
}
