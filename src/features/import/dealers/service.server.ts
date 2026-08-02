import "server-only";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Role, ImportStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { applyDealerAssignment, applyRmAssignment } from "@/features/assignments/service.server";
import { looseKey, tightKey, similarity, matchByName, type Keyed } from "@/lib/match-key";
import { writeAudit } from "@/lib/audit";

// Re-exported for callers that already import fuzzy similarity from this module.
export { similarity };

const DEFAULT_PASSWORD_LEN = 10;
const DUP_THRESHOLD = 0.8;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can import");
}

/* ---- Matching uses the shared utility (lib/match-key): similarity, keys, matchByName ---- */

/* --------------------------- Officer detection ---------------------------- */

const OFFICER_LABEL = /sales officer|officer name|\bso name\b|representative|sales executive/i;

function looksLikeName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 2 && /[a-zA-Z]/.test(v) && !OFFICER_LABEL.test(v);
}

function scanSheetForOfficer(rows: (string | number | null)[][]): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell === "string" && OFFICER_LABEL.test(cell)) {
        // Value may be after a colon in the same cell, to the right, or below.
        const inline = cell.split(/[:\-]/).slice(1).join(":").trim();
        const right = row[c + 1];
        const below = rows[r + 1]?.[c];
        for (const cand of [inline, right, below]) {
          if (looksLikeName(cand)) out.push(cand.trim());
        }
      }
    }
  }
  return out;
}

export function detectOfficerFromFilename(filename: string): string | null {
  const base = filename.replace(/\.(xlsx|xls)$/i, "");
  const paren = base.match(/\(([^)]*)\)/);
  const inside = paren ? paren[1] : base;
  const name = inside.split("-")[0].trim();
  return name.length > 0 ? name : null;
}

async function matchOfficers(name: string) {
  const first = name.split(/\s+/)[0];
  const rows = await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, isActive: true, name: { contains: first, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 5,
  });
  return rows;
}

export async function parseDealerWorkbook(ctx: AuthContext, buffer: Buffer, filename: string) {
  assertAdmin(ctx);
  const wb = readWorkbook(buffer);
  const names = sheetNames(wb);

  // Gather officer name candidates from filename + first three (master) sheets.
  const rawCandidates: { name: string; source: string }[] = [];
  const fromFile = detectOfficerFromFilename(filename);
  if (fromFile) rawCandidates.push({ name: fromFile, source: "filename" });
  for (const sheet of names.slice(0, 3)) {
    for (const cand of scanSheetForOfficer(sheetRows(wb, sheet))) {
      rawCandidates.push({ name: cand, source: sheet });
    }
  }
  // Deduplicate by normalized name (keep first source).
  const seen = new Set<string>();
  const candidates: { name: string; source: string; matches: { id: string; name: string }[] }[] = [];
  for (const c of rawCandidates) {
    const key = tightKey(c.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...c, matches: await matchOfficers(c.name) });
  }

  return {
    workbookName: filename,
    sheetCount: names.length,
    sheets: names.map((name, i) => ({ name, defaultIgnore: i < 3 })),
    officerCandidates: candidates,
    defaultCandidateName: candidates[0]?.name ?? null,
  };
}

export async function loadImportOptions(ctx: AuthContext) {
  assertAdmin(ctx);
  const [officers, managers, rmRows] = await Promise.all([
    prisma.user.findMany({ where: { role: Role.SALES_OFFICER, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { role: Role.REGIONAL_MANAGER, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.rmAssignment.findMany({ where: { effectiveTo: null }, select: { officerId: true, managerId: true } }),
  ]);
  const managerByOfficer: Record<string, string> = {};
  const officersByManager: Record<string, string[]> = {};
  for (const r of rmRows) {
    managerByOfficer[r.officerId] = r.managerId;
    (officersByManager[r.managerId] ??= []).push(r.officerId);
  }
  return { officers, managers, managerByOfficer, officersByManager };
}

/* ---------------------------- Rich resolution ----------------------------- */

interface DealerCtx extends Keyed {
  id: string;
  name: string;
  currentOfficerId: string | null;
  currentOfficerName: string | null;
  currentRmName: string | null;
}

async function loadDealerContext(): Promise<DealerCtx[]> {
  const [dealers, rmRows] = await Promise.all([
    prisma.dealer.findMany({
      include: {
        assignments: {
          where: { effectiveTo: null },
          include: { officer: { select: { id: true, name: true } } },
          take: 1,
        },
      },
    }),
    prisma.rmAssignment.findMany({
      where: { effectiveTo: null },
      include: { manager: { select: { name: true } } },
    }),
  ]);
  const rmNameByOfficer = new Map(rmRows.map((r) => [r.officerId, r.manager.name]));
  return dealers.map((d) => {
    const cur = d.assignments[0]?.officer ?? null;
    return {
      id: d.id,
      name: d.name,
      tight: tightKey(d.name),
      loose: looseKey(d.name),
      currentOfficerId: cur?.id ?? null,
      currentOfficerName: cur?.name ?? null,
      currentRmName: cur ? (rmNameByOfficer.get(cur.id) ?? null) : null,
    };
  });
}

export async function resolveDealers(ctx: AuthContext, names: string[]) {
  assertAdmin(ctx);
  const contexts = await loadDealerContext();
  return names.map((name) => {
    const exact = matchByName(name, contexts, {});
    const possibleDuplicates = exact
      ? []
      : contexts
          .map((d) => ({ d, sim: similarity(name, d.name) }))
          .filter((x) => x.sim >= DUP_THRESHOLD)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 3)
          .map((x) => ({
            id: x.d.id,
            name: x.d.name,
            confidence: Math.round(x.sim * 100),
            currentOfficerName: x.d.currentOfficerName,
          }));
    return {
      name,
      existsInDb: !!exact,
      existingId: exact?.id ?? null,
      currentOfficerId: exact?.currentOfficerId ?? null,
      currentOfficerName: exact?.currentOfficerName ?? null,
      currentRmName: exact?.currentRmName ?? null,
      possibleDuplicates,
    };
  });
}

/* --------------------- Operational-data reassignment safeguard ------------ */

export interface DealerOperationalData {
  dealerId: string;
  dealerName: string;
  currentOfficerName: string | null;
  seasonPlans: number;
  monthlyPlans: number;
  actualSales: number;
  approvalActions: number;
}

/**
 * For the given dealers, count the operational history that would make a
 * reassignment consequential: Season Plans they appear in, Monthly Plans,
 * Actual Sales entries, and Approval History actions on those plans.
 * Read-only; reuses the existing planning tables. Only dealers that actually
 * carry operational data are returned (empty history => omitted).
 */
export async function assessDealerOperationalData(
  ctx: AuthContext,
  dealerIds: string[],
): Promise<DealerOperationalData[]> {
  assertAdmin(ctx);
  const ids = Array.from(new Set(dealerIds.filter(Boolean)));
  if (ids.length === 0) return [];

  const planDealers = await prisma.planDealer.findMany({
    where: { dealerId: { in: ids } },
    select: {
      dealerId: true,
      seasonPlanId: true,
      dealer: { select: { name: true } },
      lines: {
        select: {
          monthlyEntries: { select: { planQty: true, saleQty: true } },
        },
      },
    },
  });

  interface Acc {
    dealerName: string;
    seasonPlanIds: Set<string>;
    monthlyPlans: number;
    actualSales: number;
  }
  const byDealer = new Map<string, Acc>();
  const seasonPlanToDealers = new Map<string, Set<string>>();

  for (const pd of planDealers) {
    const acc =
      byDealer.get(pd.dealerId) ??
      { dealerName: pd.dealer.name, seasonPlanIds: new Set<string>(), monthlyPlans: 0, actualSales: 0 };
    acc.seasonPlanIds.add(pd.seasonPlanId);
    for (const line of pd.lines) {
      for (const e of line.monthlyEntries) {
        if (e.planQty > 0) acc.monthlyPlans++;
        if (e.saleQty > 0) acc.actualSales++;
      }
    }
    byDealer.set(pd.dealerId, acc);
    (seasonPlanToDealers.get(pd.seasonPlanId) ?? seasonPlanToDealers.set(pd.seasonPlanId, new Set()).get(pd.seasonPlanId)!).add(pd.dealerId);
  }

  // Approval-history counts per season plan, distributed to the dealers in that plan.
  const seasonPlanIds = Array.from(seasonPlanToDealers.keys());
  const approvalByDealer = new Map<string, number>();
  if (seasonPlanIds.length > 0) {
    const grouped = await prisma.approvalAction.groupBy({
      by: ["seasonPlanId"],
      where: { seasonPlanId: { in: seasonPlanIds } },
      _count: { _all: true },
    });
    for (const g of grouped) {
      // ApprovalAction.seasonPlanId is nullable since Recovery Planning (recovery approval
      // actions have no seasonal plan). Those never match the seasonal `in` filter above, but
      // skip them explicitly to satisfy the type and preserve seasonal-only counting.
      if (g.seasonPlanId === null) continue;
      const count = g._count._all;
      for (const dealerId of seasonPlanToDealers.get(g.seasonPlanId) ?? []) {
        approvalByDealer.set(dealerId, (approvalByDealer.get(dealerId) ?? 0) + count);
      }
    }
  }

  // Current officer names (for the dialog).
  const contexts = await loadDealerContext();
  const officerByDealer = new Map(contexts.map((c) => [c.id, c.currentOfficerName]));

  const out: DealerOperationalData[] = [];
  for (const [dealerId, acc] of byDealer) {
    const seasonPlans = acc.seasonPlanIds.size;
    const approvalActions = approvalByDealer.get(dealerId) ?? 0;
    if (seasonPlans === 0 && acc.monthlyPlans === 0 && acc.actualSales === 0 && approvalActions === 0) continue;
    out.push({
      dealerId,
      dealerName: acc.dealerName,
      currentOfficerName: officerByDealer.get(dealerId) ?? null,
      seasonPlans,
      monthlyPlans: acc.monthlyPlans,
      actualSales: acc.actualSales,
      approvalActions,
    });
  }
  out.sort((a, b) => a.dealerName.localeCompare(b.dealerName));
  return out;
}

/* --------------------------- Plan / validate / commit --------------------- */

const commitSchema = z.object({
  workbookName: z.string().default("workbook"),
  effectiveFrom: z.coerce.date(),
  validateOnly: z.boolean().default(false),
  createOfficers: z.array(
    z.object({
      tempId: z.string().min(1),
      name: z.string().min(1),
      username: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      managerId: z.string().optional(),
      password: z.string().optional(),
    }),
  ),
  dealers: z.array(
    z.object({
      name: z.string(),
      town: z.string().optional().nullable(),
      action: z.enum(["import", "skip"]),
      existingOfficerId: z.string().optional(),
      newOfficerTempId: z.string().optional(),
      mergeWithExistingId: z.string().optional(),
    }),
  ),
});
type CommitPayload = z.infer<typeof commitSchema>;

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\-/]*$/u;

function genPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < DEFAULT_PASSWORD_LEN; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out + "!1";
}
function slugUsername(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  return base.length >= 3 ? base : `so_${base || "user"}`;
}

export interface ImportPlan {
  errors: string[];
  warnings: string[];
  counts: {
    dealerCount: number;
    createdDealers: number;
    reassignedDealers: number;
    noChangeDealers: number;
    skippedDealers: number;
    officersCreated: number;
    possibleDuplicates: number;
  };
}

/** Validate + compute the plan using DB reads only (no writes). Shared by validate-only and commit. */
async function planImport(payload: CommitPayload): Promise<{ plan: ImportPlan; contexts: DealerCtx[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const contexts = await loadDealerContext();
  const byId = new Map(contexts.map((c) => [c.id, c]));

  const toImport = payload.dealers.filter((d) => d.action === "import");

  // Officer reference checks.
  const existingOfficerIds = Array.from(new Set(toImport.map((d) => d.existingOfficerId).filter((x): x is string => !!x)));
  const officers = existingOfficerIds.length
    ? await prisma.user.findMany({ where: { id: { in: existingOfficerIds } } })
    : [];
  for (const id of existingOfficerIds) {
    const o = officers.find((u) => u.id === id);
    if (!o || o.role !== Role.SALES_OFFICER || !o.isActive) errors.push("A selected Sales Officer is missing or inactive");
  }
  const managerIds = Array.from(new Set(payload.createOfficers.map((o) => o.managerId).filter((x): x is string => !!x)));
  const managers = managerIds.length ? await prisma.user.findMany({ where: { id: { in: managerIds } } }) : [];
  for (const id of managerIds) {
    const m = managers.find((u) => u.id === id);
    if (!m || m.role !== Role.REGIONAL_MANAGER || !m.isActive) errors.push("A selected Regional Manager is missing or inactive");
  }

  // Username uniqueness for new officers.
  for (const o of payload.createOfficers) {
    if (o.username) {
      const exists = await prisma.user.findUnique({ where: { username: o.username } });
      if (exists) errors.push(`Username "${o.username}" is already taken`);
    }
  }

  let createdDealers = 0;
  let reassignedDealers = 0;
  let noChangeDealers = 0;
  let possibleDuplicates = 0;
  const seen = new Set<string>();

  for (const d of toImport) {
    const name = d.name.trim();
    if (!name) {
      errors.push("A dealer has an empty name");
      continue;
    }
    if (!NAME_RE.test(name)) errors.push(`Dealer name has invalid characters: "${name}"`);
    if (seen.has(tightKey(name))) errors.push(`Duplicate dealer name in this import: "${name}"`);
    seen.add(tightKey(name));
    if (!d.existingOfficerId && !d.newOfficerTempId) errors.push(`No Sales Officer selected for "${name}"`);

    // Resolve the target dealer (merge target, exact match, or new).
    const matchedExisting = matchByName(name, contexts, {});
    const target = d.mergeWithExistingId ? byId.get(d.mergeWithExistingId) : matchedExisting ?? undefined;
    if (!target && !matchedExisting) {
      // Not an exact match — was there a possible duplicate offered? (informational)
      const dup = contexts.find((c) => similarity(name, c.name) >= DUP_THRESHOLD);
      if (dup && !d.mergeWithExistingId) possibleDuplicates++;
    }

    const chosenOfficerId = d.existingOfficerId ?? `new:${d.newOfficerTempId}`;
    if (target) {
      if (target.currentOfficerId && target.currentOfficerId === d.existingOfficerId) {
        noChangeDealers++;
      } else {
        reassignedDealers++;
        if (target.currentOfficerName) {
          warnings.push(
            `"${target.name}" is currently assigned to ${target.currentOfficerName} and will be reassigned.`,
          );
        }
      }
    } else {
      createdDealers++;
    }
    void chosenOfficerId;
  }

  return {
    plan: {
      errors,
      warnings,
      counts: {
        dealerCount: toImport.length,
        createdDealers,
        reassignedDealers,
        noChangeDealers,
        skippedDealers: payload.dealers.length - toImport.length,
        officersCreated: payload.createOfficers.length,
        possibleDuplicates,
      },
    },
    contexts,
  };
}

export interface DealerImportResult extends ImportPlan {
  status: "COMPLETED" | "VALIDATED" | "FAILED";
  createdCredentials: { name: string; username: string; password: string }[];
}

export async function commitDealerImport(ctx: AuthContext, raw: unknown): Promise<DealerImportResult> {
  assertAdmin(ctx);
  const payload = commitSchema.parse(raw);
  const { plan, contexts } = await planImport(payload);
  const byId = new Map(contexts.map((c) => [c.id, c]));

  if (payload.validateOnly) {
    return { ...plan, status: "VALIDATED", createdCredentials: [] };
  }
  if (plan.errors.length > 0) {
    return { ...plan, status: "FAILED", createdCredentials: [] };
  }

  const toImport = payload.dealers.filter((d) => d.action === "import");
  const usedTempIds = new Set(
    toImport.filter((d) => d.newOfficerTempId).map((d) => d.newOfficerTempId!),
  );
  const officersToCreate = payload.createOfficers.filter((o) => usedTempIds.has(o.tempId));
  const createdCredentials: { name: string; username: string; password: string }[] = [];

  try {
    await prisma.$transaction(async (tx: Tx) => {
      const tempToId = new Map<string, string>();
      for (const o of officersToCreate) {
        let username = o.username?.trim() || slugUsername(o.name);
        let n = 1;
        while (await tx.user.findUnique({ where: { username } })) username = `${slugUsername(o.name)}_${n++}`;
        const password = o.password?.trim() || genPassword();
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await tx.user.create({
          data: {
            name: o.name,
            username,
            passwordHash,
            role: Role.SALES_OFFICER,
            phone: o.phone?.trim() || null,
            email: o.email?.trim() || null,
          },
        });
        tempToId.set(o.tempId, user.id);
        if (o.managerId) await applyRmAssignment(tx, user.id, o.managerId, payload.effectiveFrom);
        createdCredentials.push({ name: o.name, username, password });
      }

      for (const d of toImport) {
        const officerId = d.existingOfficerId ?? tempToId.get(d.newOfficerTempId!);
        if (!officerId) throw new ApiError(422, `No officer resolved for "${d.name}"`);
        const target = d.mergeWithExistingId ? byId.get(d.mergeWithExistingId) : matchByName(d.name.trim(), contexts, {}) ?? undefined;
        let dealerId: string;
        if (target) {
          dealerId = target.id;
          if (target.currentOfficerId === officerId) continue; // No Change — skip assignment
        } else {
          const created = await tx.dealer.create({ data: { name: d.name.trim(), town: d.town ?? null } });
          dealerId = created.id;
        }
        await applyDealerAssignment(tx, dealerId, officerId, payload.effectiveFrom);
      }
    });
  } catch (e) {
    await prisma.dealerImportRecord.create({
      data: {
        importedById: ctx.userId,
        workbookName: payload.workbookName,
        dealerCount: plan.counts.dealerCount,
        status: ImportStatus.FAILED,
        summary: JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      },
    });
    throw e;
  }

  await prisma.dealerImportRecord.create({
    data: {
      importedById: ctx.userId,
      workbookName: payload.workbookName,
      dealerCount: plan.counts.dealerCount,
      createdDealers: plan.counts.createdDealers,
      reassignedDealers: plan.counts.reassignedDealers,
      skippedDealers: plan.counts.skippedDealers,
      officersCreated: officersToCreate.length,
      status: ImportStatus.COMPLETED,
      summary: JSON.stringify(plan.counts),
    },
  });
  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "dealerImport",
    summary: `Imported ${plan.counts.dealerCount} dealers (${plan.counts.createdDealers} new, ${plan.counts.reassignedDealers} reassigned)`,
  });

  return {
    ...plan,
    counts: { ...plan.counts, officersCreated: officersToCreate.length },
    status: "COMPLETED",
    createdCredentials,
  };
}

/* ----------------------------- Import history ----------------------------- */

export async function listImportHistory(ctx: AuthContext) {
  assertAdmin(ctx);
  const rows = await prisma.dealerImportRecord.findMany({
    include: { importedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    workbookName: r.workbookName,
    importedByName: r.importedBy.name,
    dealerCount: r.dealerCount,
    createdDealers: r.createdDealers,
    reassignedDealers: r.reassignedDealers,
    skippedDealers: r.skippedDealers,
    officersCreated: r.officersCreated,
    status: r.status,
    createdAt: r.createdAt,
    summary: r.summary,
  }));
}
