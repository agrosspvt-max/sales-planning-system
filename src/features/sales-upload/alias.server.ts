import "server-only";
import * as XLSX from "xlsx";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { readWorkbook, sheetNames, sheetRows } from "@/lib/import/workbook";
import { tightKey } from "@/lib/match-key";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { parseDealerStatus, isActiveForStatus } from "@/lib/dealer-status";
import { writeAudit } from "@/lib/audit";
import { createDealerForOfficer } from "@/features/planning/monthly-plan.server";

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can manage dealer aliases");
}

const HEADER = /^(dealer\s*name|dealer\s*alias|system\s*dealer|tally\s*dealer)$/i;

/** A dealer awaiting approval — new "PENDING" plus the legacy "PENDING_APPROVAL" value for un-migrated rows. */
const isPending = (status: string) => status === "PENDING" || status === "PENDING_APPROVAL";

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
/**
 * SQL-level dealer→officer/group scope, applied via the existing `Dealer.assignments` relation (the
 * CURRENT owner = the open assignment range). Officer takes precedence over group; empty = no scope.
 * This reuses the stored dealer→officer link and the officer's `groupId` — no new relation/logic.
 */
function assignmentScope(groupId?: string, officerId?: string) {
  if (officerId) return { assignments: { some: { effectiveTo: null, officerId } } };
  if (groupId) return { assignments: { some: { effectiveTo: null, officer: { groupId } } } };
  return {};
}

export async function listDealersForAlias(ctx: AuthContext, filter: DealerAliasFilter = "all", groupId?: string, officerId?: string, search?: string) {
  assertAdmin(ctx);
  const [dealers, aliases, assignments] = await Promise.all([
    prisma.dealer.findMany({
      where: { isActive: true, ...assignmentScope(groupId, officerId) },
      orderBy: { name: "asc" },
      // createdByUserId = the ORIGINAL creator (immutable; never changes on reassignment). town = Territory.
      select: { id: true, name: true, status: true, createdFrom: true, createdByUserId: true, town: true, isActive: true },
    }),
    prisma.dealerAlias.findMany({ select: { id: true, tallyName: true, systemDealerId: true }, orderBy: { tallyName: "asc" } }),
    // The CURRENT owner of each dealer (open assignment range) — the stored dealer→officer link (+ group).
    prisma.dealerAssignment.findMany({ where: { effectiveTo: null }, select: { dealerId: true, officerId: true, officer: { select: { name: true, groupId: true } } } }),
  ]);
  const dealerRows = dealers as { id: string; name: string; status: string; createdFrom: string | null; createdByUserId: string | null; town: string | null; isActive: boolean }[];
  const officerByDealer = new Map<string, { name: string; officerId: string; groupId: string | null }>();
  for (const a of assignments as { dealerId: string; officerId: string; officer: { name: string; groupId: string | null } }[]) {
    officerByDealer.set(a.dealerId, { name: a.officer.name, officerId: a.officerId, groupId: a.officer.groupId });
  }

  // Active Seasonal Plan membership — detected ONLY via the PlanDealer relation (never inferred from the
  // dealer assignment or aliases). Batched: each owner's active approved seasonal plan + its PlanDealers.
  const ownerOfficerIds = [...new Set([...officerByDealer.values()].map((o) => o.officerId))];
  const inActivePlan = new Set<string>();
  if (ownerOfficerIds.length > 0) {
    const activePlans = (await prisma.seasonPlan.findMany({
      where: { officerId: { in: ownerOfficerIds }, planningType: "SEASONAL", status: PlanStatus.APPROVED, isActiveVersion: true, lifecycleState: "ACTIVE" },
      select: { id: true, officerId: true },
    })) as { id: string; officerId: string }[];
    const planByOfficer = new Map(activePlans.map((p) => [p.officerId, p.id] as const));
    const planIds = activePlans.map((p) => p.id);
    if (planIds.length > 0) {
      const pds = (await prisma.planDealer.findMany({ where: { seasonPlanId: { in: planIds } }, select: { seasonPlanId: true, dealerId: true } })) as { seasonPlanId: string; dealerId: string }[];
      const dealersByPlan = new Map<string, Set<string>>();
      for (const pd of pds) { const s = dealersByPlan.get(pd.seasonPlanId) ?? new Set<string>(); s.add(pd.dealerId); dealersByPlan.set(pd.seasonPlanId, s); }
      for (const d of dealerRows) {
        const owner = officerByDealer.get(d.id);
        const planId = owner ? planByOfficer.get(owner.officerId) : undefined;
        if (planId && dealersByPlan.get(planId)?.has(d.id)) inActivePlan.add(d.id);
      }
    }
  }

  // Group every alias under its dealer so the page can show them inline and manage them per dealer.
  const aliasesByDealer = new Map<string, { id: string; tallyName: string }[]>();
  for (const a of aliases as { id: string; tallyName: string; systemDealerId: string }[]) {
    const list = aliasesByDealer.get(a.systemDealerId) ?? [];
    list.push({ id: a.id, tallyName: a.tallyName });
    aliasesByDealer.set(a.systemDealerId, list);
  }

  // Resolve the ORIGINAL creator's name for SO-created dealers (display-only). One batched query;
  // legacy rows with no/unknown creator simply show no name.
  const creatorIds = [...new Set(dealerRows.filter((d) => d.createdFrom === "MONTHLY_PLAN" && d.createdByUserId).map((d) => d.createdByUserId as string))];
  const creatorNameById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const creators = (await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } })) as { id: string; name: string }[];
    for (const c of creators) creatorNameById.set(c.id, c.name);
  }

  const rows = dealerRows.map((d) => {
    const dealerAliases = aliasesByDealer.get(d.id) ?? [];
    const soCreated = d.createdFrom === "MONTHLY_PLAN";
    return {
      id: d.id,
      name: d.name,
      hasAlias: dealerAliases.length > 0,
      aliases: dealerAliases,
      status: d.status,
      soCreated,
      createdByName: soCreated && d.createdByUserId ? creatorNameById.get(d.createdByUserId) ?? null : null,
      // The currently-assigned Sales Officer (owner) for EVERY dealer — from the stored assignment.
      officerName: officerByDealer.get(d.id)?.name ?? null,
      // Prefill fields for the Edit modal (owning officer + their group, territory, status).
      officerId: officerByDealer.get(d.id)?.officerId ?? null,
      groupId: officerByDealer.get(d.id)?.groupId ?? null,
      town: d.town,
      isActive: d.isActive,
      // Whether the dealer is a member of its owning officer's ACTIVE seasonal plan (via PlanDealer).
      inActivePlan: inActivePlan.has(d.id),
    };
  });

  const counts = {
    all: rows.length,
    with: rows.filter((r) => r.hasAlias).length,
    without: rows.filter((r) => !r.hasAlias).length,
    soCreated: rows.filter((r) => r.soCreated).length,
    pending: rows.filter((r) => isPending(r.status)).length,
  };

  // Server-side search runs across the FULL scoped population (every row loaded above), BEFORE the row
  // cap — so a matching dealer is found regardless of alphabetical position, on every tab. It matches the
  // dealer's own name OR any of its alias (Tally) spellings, case-insensitively (boundary-trimmed). Counts
  // are computed above over the whole scope and intentionally ignore the search (they stay scope totals).
  const q = (search ?? "").trim().toLowerCase();
  const filtered = rows.filter((r) => {
    const inTab =
      filter === "with" ? r.hasAlias
      : filter === "without" ? !r.hasAlias
      : filter === "so-created" ? r.soCreated
      : filter === "pending" ? isPending(r.status)
      : true;
    if (!inTab) return false;
    if (q && !(r.name.toLowerCase().includes(q) || r.aliases.some((a) => a.tallyName.toLowerCase().includes(q)))) return false;
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
  createdDealers: number;
  existingDealers: number;
  aliasesAdded: number;
  statusUpdated: number;
  addedToSeasonalPlans: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
  totalRows: number;
  // Back-compat fields (older UI); mirror the new counts.
  created: number;
  updated: number;
  unmatchedSystemDealers: string[];
  duplicateRows: number;
}

const truthy = (v: string) => /^(y|yes|true|1)$/i.test(v.trim());

/**
 * Upload a Dealer + Alias workbook. Columns:
 *   Dealer Name | Dealer Alias (optional) | Group | Sales Officer | Territory (optional) |
 *   Dealer Status (Pending/Active/Inactive/Defaulter — default Pending) | Add To Active Seasonal Plan (Yes/No)
 *
 * Rules (no matching/creation logic is duplicated — it reuses the central resolver + the shared
 * `createDealerForOfficer` used by the Dealers module):
 *   - Dealer already exists (resolver match on Dealer Name) → add the Alias (if provided) and/or update
 *     the Status (if provided); group/officer/territory columns are ignored.
 *   - Dealer does NOT exist → create with the given Status (default Pending) + assign group/officer +
 *     territory + alias (if provided; else aliased by name). Added to the officer's active seasonal plan
 *     ONLY when "Add To Active Seasonal Plan" is Yes AND the status is Active. Same service as the Dealers module.
 */
export async function importDealerAliases(ctx: AuthContext, buffer: Buffer): Promise<AliasUploadResult> {
  assertAdmin(ctx);
  const wb = readWorkbook(buffer);
  const sheet = sheetNames(wb)[0];
  if (!sheet) throw new ApiError(422, "The workbook has no sheets");
  const rows = sheetRows(wb, sheet);

  const resolver = await loadDealerResolver();
  // Name → id lookups for the creation columns (loaded once — no per-row queries).
  const [groups, officers] = (await Promise.all([
    prisma.userGroup.findMany({ select: { id: true, name: true } }),
    // A dealer's owner in the "Sales Officer" column may be a Sales Officer OR the group's Regional
    // Manager (RMs own their own dealers) — resolve both so an RM name in that column assigns correctly.
    prisma.user.findMany({ where: { role: { in: [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] }, isActive: true }, select: { id: true, name: true, groupId: true } }),
  ])) as [{ id: string; name: string }[], { id: string; name: string; groupId: string | null }[]];
  const norm = (s: string) => s.trim().toLowerCase();
  const groupByName = new Map(groups.map((g) => [norm(g.name), g.id] as const));
  const officerByGroupName = new Map(officers.map((o) => [`${o.groupId ?? ""}|${norm(o.name)}`, o.id] as const));

  const r: AliasUploadResult = {
    createdDealers: 0, existingDealers: 0, aliasesAdded: 0, statusUpdated: 0, addedToSeasonalPlans: 0, skipped: 0, errors: 0, errorDetails: [],
    totalRows: 0, created: 0, updated: 0, unmatchedSystemDealers: [], duplicateRows: 0,
  };

  for (const row of rows) {
    const dealerName = String(row[0] ?? "").trim();
    const aliasName = String(row[1] ?? "").trim();
    const groupName = String(row[2] ?? "").trim();
    const officerName = String(row[3] ?? "").trim();
    const territory = String(row[4] ?? "").trim();
    const statusCell = String(row[5] ?? "").trim();
    const addToPlan = truthy(String(row[6] ?? ""));
    if (!dealerName && !aliasName) continue;
    if (HEADER.test(dealerName) || HEADER.test(aliasName)) continue; // header row
    r.totalRows += 1;
    // A dealer name is required (alias is now optional — it can be blank to only set the status).
    if (!dealerName) { r.skipped += 1; continue; }

    // Validate the optional Dealer Status label up front.
    const parsedStatus = parseDealerStatus(statusCell);
    if (statusCell && !parsedStatus) {
      r.errors += 1;
      r.errorDetails.push(`Row "${dealerName}": unknown Dealer Status "${statusCell}" (use Pending/Active/Inactive/Defaulter)`);
      continue;
    }

    try {
      const match = resolver.resolveWithReason(dealerName);
      if (match) {
        // Existing dealer → add the alias (if provided) and/or update the status (if provided).
        r.existingDealers += 1;
        let touched = false;
        if (parsedStatus) {
          await prisma.dealer.update({ where: { id: match.dealer.id }, data: { status: parsedStatus, isActive: isActiveForStatus(parsedStatus) } });
          r.statusUpdated += 1;
          touched = true;
        }
        if (aliasName) {
          const tallyKey = tightKey(aliasName);
          if (tallyKey) {
            const exists = await prisma.dealerAlias.findUnique({ where: { tallyKey }, select: { id: true } });
            if (!exists) { await prisma.dealerAlias.create({ data: { systemDealerId: match.dealer.id, tallyName: aliasName, tallyKey } }); r.aliasesAdded += 1; touched = true; }
          }
        }
        if (!touched) r.skipped += 1; // nothing to add/update for this existing dealer
      } else {
        // New dealer → reuse the shared create service (assign + alias + optional plan). Default Pending.
        const groupId = groupByName.get(norm(groupName));
        if (!groupId) { r.errors += 1; r.errorDetails.push(`Row "${dealerName}": unknown group "${groupName}"`); continue; }
        const officerId = officerByGroupName.get(`${groupId}|${norm(officerName)}`);
        if (!officerId) { r.errors += 1; r.errorDetails.push(`Row "${dealerName}": officer "${officerName}" not in group "${groupName}"`); continue; }
        const outcome = await createDealerForOfficer(ctx, {
          name: dealerName, aliasName: aliasName || undefined, officerId, groupId, town: territory || undefined,
          status: parsedStatus ?? "PENDING", addToSeasonalPlan: addToPlan, force: true,
        });
        r.createdDealers += 1;
        if (aliasName) r.aliasesAdded += 1;
        if (outcome.addedToPlan) r.addedToSeasonalPlans += 1;
      }
    } catch (e) {
      r.errors += 1;
      r.errorDetails.push(`Row "${dealerName}": ${(e as Error).message}`);
    }
  }

  r.created = r.createdDealers;
  r.updated = r.aliasesAdded;

  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "dealerAlias",
    summary: `Dealer+Alias import — ${r.createdDealers} created, ${r.aliasesAdded} aliases added, ${r.statusUpdated} status updated, ${r.addedToSeasonalPlans} added to plans, ${r.errors} errors`,
  });

  return r;
}

/**
 * Export the "Without Alias" list as an .xlsx: two columns [Dealer Name, Sales Officer]. Uses the
 * SAME dealer set as the "Without Alias" filter (active dealers with no alias — inactive/deleted/
 * rejected are isActive=false and already excluded), so the row count matches the filter badge.
 * The Sales Officer is the CURRENT assigned officer (DealerAssignment.effectiveTo = null — the one
 * assignment source of truth used everywhere), or "Unassigned". Ownership is never inferred from plans.
 */
export async function exportMissingAliases(ctx: AuthContext, groupId?: string, officerId?: string): Promise<{ buffer: Buffer; filename: string }> {
  assertAdmin(ctx);
  const [dealers, aliases, assignments] = await Promise.all([
    prisma.dealer.findMany({ where: { isActive: true, ...assignmentScope(groupId, officerId) }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
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

/** Build the sample Dealer+Alias workbook as an .xlsx buffer. */
export function buildAliasSampleWorkbook(): Buffer {
  const data = [
    ["Dealer Name", "Dealer Alias", "Group", "Sales Officer", "Territory", "Dealer Status", "Add To Active Seasonal Plan"],
    ["ABC Seeds", "ABC SEEDS MP", "MP", "Rajesh Kundu", "Bhopal", "Pending", "No"],
    ["XYZ Traders", "XYZ TRADERS CG", "CG", "Chittaranjan", "Raipur", "Active", "Yes"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dealer Alias");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
