import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { decorate, matchByName, tightKey } from "@/lib/match-key";
import { writeAudit } from "@/lib/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export type PriceField =
  | "productName"
  | "technicalName"
  | "rate"
  | "nbv"
  | "brand"
  | "category"
  | "packSize";

export type PriceMapping = Partial<Record<PriceField, string>>; // field → header name

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can import");
}

function headerSignature(headers: string[]): string {
  return headers.map((h) => h.trim().toLowerCase()).join("|");
}

function autoDetect(headers: string[]): PriceMapping {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const find = (pred: (h: string) => boolean) => {
    const i = norm.findIndex(pred);
    return i >= 0 ? headers[i] : undefined;
  };
  return {
    productName: find((h) => h.includes("product") || h === "name"),
    technicalName: find((h) => h.includes("technical")),
    rate: find((h) => h.includes("rate") || h.includes("price")),
    nbv: find((h) => h.includes("nbv")),
    brand: find((h) => h.includes("brand")),
    category: find((h) => h.includes("category")),
    packSize: find((h) => h.includes("pack")),
  };
}

/** Parse the price sheet: pick PRICELIST if present, else the first sheet. */
export async function parsePriceWorkbook(ctx: AuthContext, buffer: Buffer) {
  assertAdmin(ctx);
  const wb = readWorkbook(buffer);
  const names = sheetNames(wb);
  const sheetName = names.find((n) => n.trim().toUpperCase() === "PRICELIST") ?? names[0];
  if (!sheetName) throw new ApiError(422, "The file has no sheets");

  const rows = sheetRows(wb, sheetName);
  const headerRow = (rows[0] ?? []).map((c) => (c === null ? "" : String(c)));
  const dataRows = rows.slice(1).map((r) => r.map((c) => (c === null ? "" : c)));

  const signature = headerSignature(headerRow);
  const savedSetting = await prisma.systemSetting.findUnique({
    where: { key: `priceImport.mapping:${signature}` },
  });
  const savedMapping: PriceMapping | null = savedSetting ? JSON.parse(savedSetting.value) : null;

  return {
    sheetName,
    headers: headerRow,
    rows: dataRows,
    detectedMapping: autoDetect(headerRow),
    savedMapping,
    signature,
  };
}

/* -------------------------------- Preview --------------------------------- */

const itemSchema = z.object({
  productName: z.string(),
  technicalName: z.string().optional(),
  rate: z.coerce.number().optional(),
  nbvPercent: z.coerce.number().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  packSize: z.string().optional(),
});
export type PriceItem = z.infer<typeof itemSchema>;

const previewSchema = z.object({ items: z.array(z.record(z.any())) });

export type RowStatus = "new" | "update" | "duplicate" | "missing" | "invalid";

export async function previewPrices(ctx: AuthContext, raw: unknown) {
  assertAdmin(ctx);
  const { items } = previewSchema.parse(raw);

  const names = items.map((i) => String(i.productName ?? "").trim()).filter(Boolean);
  const existing = await prisma.product.findMany({
    where: { name: { in: names } },
    select: {
      name: true,
      rate: true,
      nbvPercent: true,
      technicalName: true,
      brand: { select: { name: true } },
      category: { select: { name: true } },
    },
  });
  // Match existing products through the shared matcher (tight → loose), so "SHOOT OUT"
  // resolves to "SHOOT-OUT" instead of creating a duplicate.
  const productIndex = decorate(existing);
  const nameCounts = new Map<string, number>();
  for (const n of names) nameCounts.set(tightKey(n), (nameCounts.get(tightKey(n)) ?? 0) + 1);

  const rows = items.map((raw) => {
    const parsed = itemSchema.safeParse(raw);
    const name = String(raw.productName ?? "").trim();
    const issues: string[] = [];
    let status: RowStatus = "new";

    if (!parsed.success) {
      status = "invalid";
      issues.push("Invalid values");
    }
    if (!name) {
      status = "missing";
      issues.push("Missing product name");
    }
    const dup = name && (nameCounts.get(tightKey(name)) ?? 0) > 1;
    const ex = (name ? matchByName(name, productIndex) ?? undefined : undefined) as
      | {
          rate: { toString(): string };
          nbvPercent: { toString(): string };
          technicalName: string | null;
          brand: { name: string } | null;
          category: { name: string } | null;
        }
      | undefined;

    if (status === "new") {
      if (dup) status = "duplicate";
      else if (ex) status = "update";
      else {
        // New product needs rate and NBV (non-null in the master).
        const rate = parsed.success ? parsed.data.rate : undefined;
        const nbv = parsed.success ? parsed.data.nbvPercent : undefined;
        if (rate === undefined || nbv === undefined) {
          status = "missing";
          issues.push("New product needs Rate and NBV");
        }
      }
    }

    return {
      productName: name,
      item: parsed.success ? parsed.data : { productName: name },
      status,
      issues,
      existing: ex
        ? {
            rate: Number(ex.rate.toString()),
            nbvPercent: Number(ex.nbvPercent.toString()),
            technicalName: ex.technicalName,
            brand: ex.brand?.name ?? null,
            category: ex.category?.name ?? null,
          }
        : null,
    };
  });

  // Pack-size safety: report pack-size names in the file that are NOT yet in the master.
  const packNames = Array.from(
    new Set(
      items.map((i) => (typeof i.packSize === "string" ? i.packSize.trim() : "")).filter(Boolean),
    ),
  );
  // Match against the master via tight keys ("25ML" === "25 ML"), not raw string equality.
  const allPacks = packNames.length
    ? ((await prisma.packSize.findMany({ select: { name: true } })) as { name: string }[])
    : [];
  const knownTight = new Set(allPacks.map((p) => tightKey(p.name)));
  const unknownPackSizes = packNames.filter((n) => !knownTight.has(tightKey(n)));

  return { rows, unknownPackSizes };
}

/* -------------------------------- Commit ---------------------------------- */

const commitSchema = z.object({
  items: z.array(z.record(z.any())),
  mapping: z.record(z.string()).optional(),
  signature: z.string().optional(),
  // Pack sizes are NEVER created silently. The admin resolves each unknown pack size.
  packSizeResolutions: z
    .array(z.object({ name: z.string(), action: z.enum(["create", "ignore", "map"]), mapToId: z.string().optional() }))
    .optional(),
});

async function upsertNamed(tx: Tx, model: "brand" | "category", name: string): Promise<string> {
  const existing = await tx[model].findUnique({ where: { name } });
  if (existing) return existing.id;
  const created = await tx[model].create({ data: { name } });
  return created.id;
}

export interface PriceImportSummary {
  newProducts: number;
  updatedProducts: number;
  skipped: number;
}

export async function commitPriceImport(ctx: AuthContext, raw: unknown): Promise<PriceImportSummary> {
  assertAdmin(ctx);
  const { items, mapping, signature, packSizeResolutions } = commitSchema.parse(raw);

  const summary = await prisma.$transaction(async (tx: Tx) => {
    let newProducts = 0;
    let updatedProducts = 0;
    let skipped = 0;

    // Pack sizes are only created when the admin explicitly chose "create".
    const toCreate = (packSizeResolutions ?? []).filter((r) => r.action === "create");
    if (toCreate.length) {
      const existingPacks = await tx.packSize.findMany({ select: { name: true, displayOrder: true } });
      const existingNames = new Set(existingPacks.map((p: { name: string }) => p.name));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let order = existingPacks.reduce((m: number, p: any) => Math.max(m, p.displayOrder), 0);
      for (const r of toCreate) {
        // Price-import pack sizes are pricing units, NOT Dealer Planning columns: created
        // with isPlanning=false so they never appear in the planning grid (business rule).
        if (!existingNames.has(r.name)) await tx.packSize.create({ data: { name: r.name, displayOrder: ++order, isPlanning: false } });
      }
    }

    // Match existing products through the shared matcher (tight → loose). Loaded once and
    // kept updated as products are created, so a name repeated in the file resolves.
    const productIndex = decorate(
      (await tx.product.findMany({ select: { id: true, name: true } })) as { id: string; name: string }[],
    );

    for (const rawItem of items) {
      const parsed = itemSchema.safeParse(rawItem);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const it = parsed.data;
      const name = it.productName.trim();
      if (!name) {
        skipped++;
        continue;
      }

      const existing = matchByName(name, productIndex);

      // Only mapped/provided fields are applied; unmapped fields are left untouched.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = {};
      if (it.technicalName !== undefined) data.technicalName = it.technicalName;
      if (it.rate !== undefined) data.rate = it.rate;
      if (it.nbvPercent !== undefined) data.nbvPercent = it.nbvPercent;
      if (it.brand !== undefined && it.brand.trim())
        data.brandId = await upsertNamed(tx, "brand", it.brand.trim());
      if (it.category !== undefined && it.category.trim())
        data.categoryId = await upsertNamed(tx, "category", it.category.trim());

      if (existing) {
        if (Object.keys(data).length > 0) await tx.product.update({ where: { id: existing.id }, data });
        updatedProducts++;
      } else {
        if (it.rate === undefined || it.nbvPercent === undefined) {
          skipped++;
          continue;
        }
        const created = await tx.product.create({ data: { name, ...data, rate: it.rate, nbvPercent: it.nbvPercent } });
        productIndex.push(...decorate([{ id: created.id, name }]));
        newProducts++;
      }
    }
    return { newProducts, updatedProducts, skipped };
  });

  // Remember the mapping for future imports of the same header structure.
  if (mapping && signature) {
    await prisma.systemSetting.upsert({
      where: { key: `priceImport.mapping:${signature}` },
      create: { key: `priceImport.mapping:${signature}`, value: JSON.stringify(mapping) },
      update: { value: JSON.stringify(mapping) },
    });
  }

  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "priceImport",
    summary: `${summary.newProducts} new, ${summary.updatedProducts} updated products`,
  });
  return summary;
}
