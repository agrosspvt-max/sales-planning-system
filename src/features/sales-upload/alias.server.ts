import "server-only";
import * as XLSX from "xlsx";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { decorate, matchByName, tightKey, type Keyed } from "@/lib/match-key";
import { writeAudit } from "@/lib/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can manage dealer aliases");
}

const HEADER = /system\s*dealer|tally\s*dealer/i;

export async function listDealerAliases(ctx: AuthContext) {
  assertAdmin(ctx);
  const rows = (await prisma.dealerAlias.findMany({
    orderBy: { updatedAt: "desc" },
    include: { systemDealer: { select: { name: true } } },
  })) as { id: string; tallyName: string; systemDealerId: string; systemDealer: { name: string }; updatedAt: Date }[];
  return rows.map((r) => ({
    id: r.id,
    tallyName: r.tallyName,
    systemDealerId: r.systemDealerId,
    systemDealerName: r.systemDealer.name,
    updatedAt: r.updatedAt,
  }));
}

export async function deleteDealerAlias(ctx: AuthContext, id: string) {
  assertAdmin(ctx);
  await prisma.dealerAlias.delete({ where: { id } });
  return { deleted: true };
}

export type DealerAliasFilter = "all" | "with" | "without" | "so-created" | "pending";

/**
 * Dealers annotated with their alias status for the Dealer Alias page filters, plus the counts
 * for each tab. Reuses the existing Dealer + DealerAlias models (no new tables).
 */
export async function listDealersForAlias(ctx: AuthContext, filter: DealerAliasFilter = "all") {
  assertAdmin(ctx);
  const [dealers, aliases] = await Promise.all([
    prisma.dealer.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, status: true, createdFrom: true },
    }),
    prisma.dealerAlias.findMany({ select: { id: true, tallyName: true, systemDealerId: true }, orderBy: { tallyName: "asc" } }),
  ]);
  // Group every alias under its dealer so the page can show them inline and manage them per dealer.
  const aliasesByDealer = new Map<string, { id: string; tallyName: string }[]>();
  for (const a of aliases as { id: string; tallyName: string; systemDealerId: string }[]) {
    const list = aliasesByDealer.get(a.systemDealerId) ?? [];
    list.push({ id: a.id, tallyName: a.tallyName });
    aliasesByDealer.set(a.systemDealerId, list);
  }

  const rows = (dealers as { id: string; name: string; status: string; createdFrom: string | null }[]).map((d) => {
    const dealerAliases = aliasesByDealer.get(d.id) ?? [];
    return {
      id: d.id,
      name: d.name,
      hasAlias: dealerAliases.length > 0,
      aliases: dealerAliases,
      status: d.status,
      soCreated: d.createdFrom === "MONTHLY_PLAN",
    };
  });

  const counts = {
    all: rows.length,
    with: rows.filter((r) => r.hasAlias).length,
    without: rows.filter((r) => !r.hasAlias).length,
    soCreated: rows.filter((r) => r.soCreated).length,
    pending: rows.filter((r) => r.status === "PENDING_APPROVAL").length,
  };

  const filtered = rows.filter((r) => {
    if (filter === "with") return r.hasAlias;
    if (filter === "without") return !r.hasAlias;
    if (filter === "so-created") return r.soCreated;
    if (filter === "pending") return r.status === "PENDING_APPROVAL";
    return true;
  });
  return { counts, dealers: filtered.slice(0, 500) };
}

/** Add a single alias inline (System Dealer + Tally name). Reuses the unique tallyKey guard. */
export async function addSingleAlias(ctx: AuthContext, systemDealerId: string, tallyName: string) {
  assertAdmin(ctx);
  const name = tallyName.trim();
  if (!name) throw new ApiError(422, "Tally name is required");
  const tallyKey = tightKey(name);
  const dealer = await prisma.dealer.findUnique({ where: { id: systemDealerId }, select: { id: true } });
  if (!dealer) throw new ApiError(404, "Dealer not found");
  const existing = await prisma.dealerAlias.findUnique({ where: { tallyKey }, select: { id: true } });
  if (existing) throw new ApiError(409, "An alias for that Tally name already exists");
  await prisma.dealerAlias.create({ data: { systemDealerId, tallyName: name, tallyKey } });
  return { created: true };
}

/** Edit an existing alias's Tally name in place (same uniqueness guard, allowing the row itself). */
export async function updateSingleAlias(ctx: AuthContext, id: string, tallyName: string) {
  assertAdmin(ctx);
  const name = tallyName.trim();
  if (!name) throw new ApiError(422, "Tally name is required");
  const tallyKey = tightKey(name);
  const alias = await prisma.dealerAlias.findUnique({ where: { id }, select: { id: true } });
  if (!alias) throw new ApiError(404, "Alias not found");
  // A different alias must not already own this Tally key (case/spacing-only edits keep the same key).
  const clash = await prisma.dealerAlias.findUnique({ where: { tallyKey }, select: { id: true } });
  if (clash && clash.id !== id) throw new ApiError(409, "An alias for that Tally name already exists");
  await prisma.dealerAlias.update({ where: { id }, data: { tallyName: name, tallyKey } });
  return { updated: true };
}

export interface AliasUploadResult {
  created: number;
  updated: number;
  unmatchedSystemDealers: string[];
  duplicateRows: number;
  totalRows: number;
}

/**
 * Upload an alias mapping workbook (columns: System Dealer | Tally Dealer). The System Dealer is
 * matched to the Dealer master (exact → loose → fuzzy, reusing matchByName); the Tally name is
 * stored verbatim with a unique tightKey. Existing tally keys are updated, new ones inserted.
 */
export async function importDealerAliases(ctx: AuthContext, buffer: Buffer): Promise<AliasUploadResult> {
  assertAdmin(ctx);
  const wb = readWorkbook(buffer);
  const sheet = sheetNames(wb)[0];
  if (!sheet) throw new ApiError(422, "The workbook has no sheets");
  const rows = sheetRows(wb, sheet);

  const dealerRows = (await prisma.dealer.findMany({ where: { isActive: true }, select: { id: true, name: true } })) as {
    id: string;
    name: string;
  }[];
  const dealers: ({ id: string; name: string } & Keyed)[] = decorate(dealerRows);

  // Parse rows → { systemName, tallyName }, skipping the header.
  const parsed: { systemName: string; tallyName: string }[] = [];
  for (const row of rows) {
    const a = String(row[0] ?? "").trim();
    const b = String(row[1] ?? "").trim();
    if (!a && !b) continue;
    if (HEADER.test(a) || HEADER.test(b)) continue;
    if (!a || !b) continue;
    parsed.push({ systemName: a, tallyName: b });
  }

  const unmatched: string[] = [];
  const seenTallyKeys = new Set<string>();
  let duplicateRows = 0;
  const wanted = new Map<string, { systemDealerId: string; tallyName: string; tallyKey: string }>();
  for (const p of parsed) {
    const dealer = matchByName(p.systemName, dealers, { fuzzy: true, threshold: 0.9 });
    if (!dealer) {
      unmatched.push(p.systemName);
      continue;
    }
    const tallyKey = tightKey(p.tallyName);
    if (!tallyKey) continue;
    if (seenTallyKeys.has(tallyKey)) duplicateRows += 1; // same Tally dealer twice in the sheet — last wins
    seenTallyKeys.add(tallyKey);
    wanted.set(tallyKey, { systemDealerId: dealer.id, tallyName: p.tallyName, tallyKey });
  }

  const keys = [...wanted.keys()];
  const existing = (await prisma.dealerAlias.findMany({
    where: { tallyKey: { in: keys } },
    select: { id: true, tallyKey: true },
  })) as { id: string; tallyKey: string }[];
  const existingByKey = new Map(existing.map((e) => [e.tallyKey, e.id]));

  const creates: { systemDealerId: string; tallyName: string; tallyKey: string }[] = [];
  const updates: { id: string; systemDealerId: string; tallyName: string }[] = [];
  for (const [key, w] of wanted) {
    const id = existingByKey.get(key);
    if (id) updates.push({ id, systemDealerId: w.systemDealerId, tallyName: w.tallyName });
    else creates.push(w);
  }

  await prisma.$transaction(
    async (tx: Tx) => {
      if (creates.length > 0) await tx.dealerAlias.createMany({ data: creates, skipDuplicates: true });
      const CHUNK = 100;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const slice = updates.slice(i, i + CHUNK);
        await Promise.all(
          slice.map((u) => tx.dealerAlias.update({ where: { id: u.id }, data: { systemDealerId: u.systemDealerId, tallyName: u.tallyName } })),
        );
      }
    },
    { timeout: 60000, maxWait: 10000 },
  );

  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "dealerAlias",
    summary: `Dealer Alias import — +${creates.length} new, ${updates.length} updated, ${unmatched.length} unmatched`,
  });

  return { created: creates.length, updated: updates.length, unmatchedSystemDealers: unmatched, duplicateRows, totalRows: parsed.length };
}

/**
 * Export the "Without Alias" list as an .xlsx: two columns [Dealer Name, Sales Officer]. Uses the
 * SAME dealer set as the "Without Alias" filter (active dealers with no alias — inactive/deleted/
 * rejected are isActive=false and already excluded), so the row count matches the filter badge.
 * The Sales Officer is the CURRENT assigned officer (DealerAssignment.effectiveTo = null — the one
 * assignment source of truth used everywhere), or "Unassigned". Ownership is never inferred from plans.
 */
export async function exportMissingAliases(ctx: AuthContext): Promise<{ buffer: Buffer; filename: string }> {
  assertAdmin(ctx);
  const [dealers, aliases, assignments] = await Promise.all([
    prisma.dealer.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.dealerAlias.findMany({ select: { systemDealerId: true } }),
    prisma.dealerAssignment.findMany({ where: { effectiveTo: null }, select: { dealerId: true, officer: { select: { name: true } } } }),
  ]);
  const withAlias = new Set((aliases as { systemDealerId: string }[]).map((a) => a.systemDealerId));
  const officerByDealer = new Map<string, string>(
    (assignments as { dealerId: string; officer: { name: string } }[]).map((a) => [a.dealerId, a.officer.name]),
  );

  const missing = (dealers as { id: string; name: string }[]).filter((d) => !withAlias.has(d.id));
  const rows: (string | number)[][] = [
    ["Dealer Name", "Sales Officer"],
    ...missing.map((d) => [d.name, officerByDealer.get(d.id) ?? "Unassigned"]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Bold header row (applied by style-capable readers; ignored otherwise).
  for (const addr of ["A1", "B1"]) {
    const cell = ws[addr] as { s?: unknown } | undefined;
    if (cell) cell.s = { font: { bold: true } };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Missing Alias");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const date = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `Missing_Dealer_Alias_${date}.xlsx` };
}

/** Build the sample alias workbook (System Dealer | Tally Dealer) as an .xlsx buffer. */
export function buildAliasSampleWorkbook(): Buffer {
  const data = [
    ["System Dealer", "Tally Dealer"],
    ["ABC Seeds", "ABC SEEDS MP"],
    ["XYZ Traders", "XYZ TRADERS CG"],
    ["AARADHYA BEEJ AGENCY", "AARADHYA BEEJ AGENCY (NAGLA SADU) UP"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dealer Alias");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
