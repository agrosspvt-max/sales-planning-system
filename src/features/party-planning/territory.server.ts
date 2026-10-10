import "server-only";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getCurrentManagerId, getCurrentOwnerByDealer, getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { isAdministrativeRole, assertAdminPermission } from "@/features/accounts/permissions";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import * as XLSX from "xlsx";
import { readWorkbook, sheetNames } from "@/lib/import/workbook";
import { buildPage, type PageParams, type Paginated } from "@/lib/pagination";
import { buildDistrictCatalog } from "@/lib/district-master";
import { listDealersForAlias } from "@/features/sales-upload/alias.server";
import { cleanRequestText, STATUS_REQUEST_NOTES_MAX, validateStatusRequest, type DealerStatusReason, type DealerStatusRequestState } from "@/lib/dealer-status-request";
import {
  POTENTIALS, buildImportPlan, classifyMatch, cleanMarketName, MARKET_NAME_MAX, isPotential, marketNameKey, parseTerritorySheet, summarizeImportPlan, validateMarketRequest,
  type ImportCandidate, type ImportDistrictOutcome, type ImportPlanRow, type ImportSummary, type MarketRequestStatus, type Potential,
} from "@/lib/territory-mapping";

/**
 * Party Planning · Territory Mapping (Phase 1): Dealer → Market. Scope reuses the existing ownership model exactly like the
 * other dealer lists: a dealer is visible to the caller when its CURRENT owner (open DealerAssignment) is inside
 * `getOfficerScope` (SO = own dealers, RM = group, Admin = all). Every read and write below re-applies it server-side.
 *
 * The legacy Party Planning (appointment plans) is a separate workflow and is not touched here.
 */

/* ------------------------------------------------ guards + scope ------------------------------------------------ */

function assertTerritoryUser(ctx: AuthContext): void {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER && !isAdministrativeRole(ctx.role)) {
    throw new ApiError(403, "You do not have access to Territory Mapping");
  }
}
/** Writes: SO/RM within their scope; Admin needs the (custom-admin) manage permission — Super Admin always has it. */
function assertTerritoryWriter(ctx: AuthContext): void {
  assertTerritoryUser(ctx);
  assertAdminPermission(ctx, "partyPlanning", "manage");
}

interface ScopedDealer { id: string; name: string; status: string; ownerId: string | null }
/** The caller's authorized dealers (active, not deleted, current owner inside the caller's scope). */
async function loadScopedDealers(ctx: AuthContext): Promise<ScopedDealer[]> {
  const scope = await getOfficerScope(ctx);
  const dealers = await prisma.dealer.findMany({
    where: { deletedAt: null, isActive: true, ...(scope.all ? {} : { assignments: { some: { officerId: { in: scope.ids }, effectiveTo: null } } }) },
    select: { id: true, name: true, status: true },
  });
  const owners = await getCurrentOwnerByDealer(dealers.map((d) => d.id));
  return dealers.filter((d) => scope.all || scope.ids.includes(owners.get(d.id) ?? "")).map((d) => ({ ...d, ownerId: owners.get(d.id) ?? null }));
}
async function assertDealerInScope(ctx: AuthContext, dealerId: string): Promise<ScopedDealer> {
  const found = await prisma.dealer.findFirst({ where: { id: dealerId, deletedAt: null }, select: { id: true, name: true, status: true } });
  if (!found) throw new ApiError(404, "Dealer not found");
  const scope = await getOfficerScope(ctx);
  const owner = (await getCurrentOwnerByDealer([dealerId])).get(dealerId) ?? null;
  if (!scope.all && (!owner || !scope.ids.includes(owner))) throw new ApiError(403, "You do not have access to this dealer");
  return { ...found, ownerId: owner };
}

/* ------------------------------------------------ State + District ------------------------------------------------ */

type StateRef = { id: string; name: string };
/** dealerId → the dealer's State: Dealer → CURRENT DealerAssignment → officer → UserGroup. null = no current owner, or the owner has no group. */
async function dealerStates(dealerIds: readonly string[], db: typeof prisma = prisma): Promise<Map<string, StateRef | null>> {
  const ids = [...new Set(dealerIds)];
  const out = new Map<string, StateRef | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return out;
  const owners = await getCurrentOwnerByDealer(ids, db as unknown as Parameters<typeof getCurrentOwnerByDealer>[1]);
  const officerIds = [...new Set(owners.values())];
  const users = officerIds.length ? await db.user.findMany({ where: { id: { in: officerIds } }, select: { id: true, groupId: true } }) : [];
  const groupOf = new Map(users.map((u) => [u.id, u.groupId]));
  const groupIds = [...new Set([...groupOf.values()].filter((g): g is string => !!g))];
  const groups = groupIds.length ? await db.userGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  for (const [dealerId, officerId] of owners) { const gid = groupOf.get(officerId); out.set(dealerId, gid ? groupById.get(gid) ?? null : null); }
  return out;
}

interface MappingDistrictColumns { district: string | null; districtId: string | null; districtRef?: { name: string; groupId: string } | null }
function districtFields(m: MappingDistrictColumns | null | undefined, state: StateRef | null): DistrictFields {
  const ref = m?.districtRef ?? null;
  const text = ref?.name ?? m?.district ?? null;
  const review = ref ? (state && ref.groupId !== state.id ? "WRONG_STATE" : null) : text && text.trim() ? "LEGACY" : null;
  return { district: text, districtId: m?.districtId ?? null, stateId: state?.id ?? null, stateName: state?.name ?? null, districtReview: review };
}
const DISTRICT_SELECT = { district: true, districtId: true, districtRef: { select: { name: true, groupId: true } } } as const;

async function loadDistrictCatalog(db: typeof prisma = prisma) {
  const [districts, aliases, groups] = await Promise.all([
    db.district.findMany({ select: { id: true, groupId: true, name: true, nameKey: true, isActive: true } }),
    db.districtAlias.findMany({ select: { districtId: true, groupId: true, aliasKey: true } }),
    db.userGroup.findMany({ select: { id: true, name: true } }),
  ]);
  return { catalog: buildDistrictCatalog(districts, aliases), groupName: new Map(groups.map((g) => [g.id, g.name])) };
}

export interface DistrictOption { id: string; name: string }
/**
 * The ACTIVE districts the caller may pick from, grouped by State (UserGroup id): an Admin sees every state that has districts; an SO / RM only
 * the states of the officers inside their scope. A dealer's own list is then chosen by its resolved state (the server re-checks on save).
 */
export async function listDistrictOptions(ctx: AuthContext): Promise<Record<string, DistrictOption[]>> {
  assertTerritoryUser(ctx);
  const scope = await getOfficerScope(ctx);
  let groupIds: string[] | null = null;
  if (!scope.all) {
    const users = await prisma.user.findMany({ where: { id: { in: scope.ids } }, select: { id: true, groupId: true } });
    groupIds = [...new Set(users.map((u) => u.groupId).filter((g): g is string => !!g))];
    if (groupIds.length === 0) return {};
  }
  const rows = await prisma.district.findMany({ where: { isActive: true, ...(groupIds ? { groupId: { in: groupIds } } : {}) }, select: { id: true, groupId: true, name: true } });
  const out: Record<string, DistrictOption[]> = {};
  for (const d of [...rows].sort((a, b) => a.name.localeCompare(b.name))) (out[d.groupId] ??= []).push({ id: d.id, name: d.name });
  return out;
}

/* ------------------------------------------------ markets ------------------------------------------------ */

export interface MarketDto { id: string; name: string; potential: Potential | null; source: string }
const asPotential = (v: string | null): Potential | null => (isPotential(v) ? v : null);

/** The approved/usable Market master (global list of names — not dealer data). */
export async function listMarkets(ctx: AuthContext): Promise<MarketDto[]> {
  assertTerritoryUser(ctx);
  const rows = await prisma.market.findMany({ select: { id: true, name: true, potential: true, source: true }, orderBy: { name: "asc" } });
  return rows.map((m) => ({ id: m.id, name: m.name, potential: asPotential(m.potential), source: m.source }));
}

/* ------------------------------------------------ existing dealers ------------------------------------------------ */

export type TerritoryDealerRow = {
  dealerId: string; partyName: string; status: string;
  /** `marketName` is the displayed Market: the manual override when one was confirmed, else the mapped Market master name. */
  marketId: string | null; marketName: string | null; marketEdited: boolean; potential: Potential | null;
  /** The dealer's open Status Change Request (at most one), if any — the Status cell then shows it instead of offering a new request. */
  pendingStatusRequest?: { id: string; reason: DealerStatusReason } | null;
} & DistrictFields;
/**
 * The dealer's District as the screen needs it. `district` is the shown text (the District master's name once chosen, else the legacy text).
 * `stateId/stateName` = the dealer's resolved State (current owner's group; null = cannot be determined, so no District can be assigned).
 * `districtReview`: LEGACY = free text not yet matched to the master; WRONG_STATE = the chosen district belongs to another state than the
 * dealer's current one (e.g. after a reassignment) — flagged for correction, never silently erased.
 */
export interface DistrictFields { district: string | null; districtId: string | null; stateId: string | null; stateName: string | null; districtReview: "LEGACY" | "WRONG_STATE" | null }
/** market: "" = all, "__none__" = unmapped, else a marketId. officer (RM / Admin) = a dealer-owner's user id; state (Admin) = a UserGroup id; "" / undefined = all. */
export interface TerritoryListParams extends PageParams { market: string; officer?: string; state?: string }

export async function listTerritoryDealers(ctx: AuthContext, params: TerritoryListParams): Promise<Paginated<TerritoryDealerRow> & { mapped: number; unmapped: number }> {
  assertTerritoryUser(ctx);
  const officer = params.officer?.trim() ?? "", stateFilter = params.state?.trim() ?? "";
  // Filter restrictions are enforced here, not just by hiding the controls: an SO has neither filter, an RM filters only inside their team, only Admin filters by State.
  if (stateFilter && !isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only an Admin can filter by State");
  if (officer) {
    const scope = await getOfficerScope(ctx);
    if (ctx.role === Role.SALES_OFFICER ? officer !== ctx.userId : !scope.all && !scope.ids.includes(officer)) throw new ApiError(403, "That Sales Officer is outside your scope");
  }
  const dealers = (await loadScopedDealers(ctx)).filter((d) => !officer || d.ownerId === officer);
  const ids = dealers.map((d) => d.id);
  const [aliases, mappings, edited, states, pendingRequests] = await Promise.all([
    loadDealerAliasNameMap(ids),
    ids.length ? prisma.dealerMarketMapping.findMany({ where: { dealerId: { in: ids } }, select: { dealerId: true, marketId: true, marketText: true, ...DISTRICT_SELECT, potential: true, market: { select: { name: true } } } }) : Promise.resolve([]),
    ids.length ? prisma.territoryMarketEdit.findMany({ where: { dealerId: { in: ids } }, select: { dealerId: true }, distinct: ["dealerId"] }) : Promise.resolve([]),
    dealerStates(ids),
    ids.length ? prisma.dealerStatusRequest.findMany({ where: { dealerId: { in: ids }, status: "PENDING" }, select: { id: true, dealerId: true, reason: true } }) : Promise.resolve([]),
  ]);
  const pendingByDealer = new Map(pendingRequests.map((r) => [r.dealerId, { id: r.id, reason: r.reason as DealerStatusReason }]));
  const editedIds = new Set(edited.map((e) => e.dealerId));
  const mappingByDealer = new Map(mappings.map((m) => [m.dealerId, m]));
  const all: TerritoryDealerRow[] = dealers.map((d) => {
    const m = mappingByDealer.get(d.id);
    return { dealerId: d.id, partyName: aliases.get(d.id) ?? d.name, status: d.status, marketId: m?.marketId ?? null, marketName: m?.marketText ?? m?.market?.name ?? null, marketEdited: editedIds.has(d.id), potential: asPotential(m?.potential ?? null), pendingStatusRequest: pendingByDealer.get(d.id) ?? null, ...districtFields(m, states.get(d.id) ?? null) };
  });
  const needle = params.search.trim().toLowerCase();
  // State filter (Admin) — the dealer's State is its current owner's group, exactly as shown in the District column.
  const inScope = stateFilter ? all.filter((r) => r.stateId === stateFilter) : all;
  const matches = inScope.filter((row) => {
    if (needle && !row.partyName.toLowerCase().includes(needle) && !(dealers.find((d) => d.id === row.dealerId)?.name.toLowerCase().includes(needle))) return false;
    if (params.market === "__none__") return row.marketName == null;
    if (params.market) return row.marketId === params.market;
    return true;
  }).sort((a, b) => a.partyName.localeCompare(b.partyName));
  const start = (params.page - 1) * params.pageSize;
  return {
    ...buildPage(matches.slice(start, start + params.pageSize), matches.length, params),
    // Counts follow the Sales Officer / State filters (not the Market / search filters, as before).
    mapped: inScope.filter((r) => r.marketName != null).length,
    unmapped: inScope.filter((r) => r.marketName == null).length,
  };
}

export interface TerritoryFilterOptions { officers: { id: string; name: string; groupId: string | null }[]; states: { id: string; name: string }[] }
/** The Sales Officer / State filter choices for the caller: SO none; RM their own team's Sales Officers; Admin every active Sales Officer and State. */
export async function listTerritoryFilterOptions(ctx: AuthContext): Promise<TerritoryFilterOptions> {
  assertTerritoryUser(ctx);
  if (ctx.role === Role.SALES_OFFICER) return { officers: [], states: [] };
  const scope = await getOfficerScope(ctx);
  const users = await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, isActive: true, ...(scope.all ? {} : { id: { in: scope.ids } }) },
    select: { id: true, name: true, groupId: true },
  });
  const officers = users.filter((u) => scope.all || scope.ids.includes(u.id)).sort((a, b) => a.name.localeCompare(b.name));
  const states = isAdministrativeRole(ctx.role) ? (await prisma.userGroup.findMany({ select: { id: true, name: true } })).sort((a, b) => a.name.localeCompare(b.name)) : [];
  return { officers, states };
}

const mappingInput = z.object({
  marketId: z.string().min(1).nullable().optional(),
  potential: z.enum(POTENTIALS).nullable().optional(),
  /** A District master id (never free text). null = remove the dealer's district. */
  districtId: z.string().min(1).nullable().optional(),
}).refine((v) => v.marketId !== undefined || v.potential !== undefined || v.districtId !== undefined, { message: "Nothing to update" });

/**
 * Set the dealer's Market, dealer-level Potential and/or standard District. Only the provided fields change; the dealer record itself is never
 * written. A District must be an ACTIVE district of the dealer's CURRENT state (current owner's group) — checked here, whatever the client sent.
 */
export async function updateDealerMapping(ctx: AuthContext, dealerId: string, raw: unknown): Promise<TerritoryDealerRow> {
  assertTerritoryWriter(ctx);
  const parsed = mappingInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid mapping");
  const { marketId, potential } = parsed.data;
  const districtId = parsed.data.districtId;
  const dealer = await assertDealerInScope(ctx, dealerId);
  const state = (await dealerStates([dealerId])).get(dealerId) ?? null;
  let district: { id: string; name: string } | null = null;
  if (districtId) {
    if (!state) throw new ApiError(422, "This dealer's state cannot be determined (its current owner has no state group), so a District cannot be assigned yet.");
    const found = await prisma.district.findUnique({ where: { id: districtId }, select: { id: true, name: true, groupId: true, isActive: true } });
    if (!found) throw new ApiError(422, "Select a valid District");
    if (found.groupId !== state.id) throw new ApiError(422, `"${found.name}" does not belong to this dealer's state (${state.name}).`);
    if (!found.isActive) throw new ApiError(422, `"${found.name}" is inactive and cannot be assigned.`);
    district = { id: found.id, name: found.name };
  }
  const market = marketId ? await prisma.market.findUnique({ where: { id: marketId }, select: { id: true, name: true } }) : null;
  if (marketId && !market) throw new ApiError(422, "Select a valid Market");

  const row = await prisma.$transaction(async (tx) => {
    const before = await tx.dealerMarketMapping.findUnique({ where: { dealerId }, select: { marketId: true, marketText: true, ...DISTRICT_SELECT, potential: true, market: { select: { name: true } } } });
    const data: { marketId?: string | null; marketText?: string | null; potential?: string | null; district?: string | null; districtId?: string | null; updatedById: string } = { updatedById: ctx.userId };
    if (marketId !== undefined) { data.marketId = marketId; data.marketText = null; } // choosing a Market master record replaces a manual override
    if (potential !== undefined) data.potential = potential;
    if (districtId !== undefined) { data.districtId = district?.id ?? null; data.district = district?.name ?? null; } // the legacy text mirrors the master name; clearing clears both (the old value stays in the audit entry)
    const saved = await tx.dealerMarketMapping.upsert({
      where: { dealerId }, update: data,
      create: { dealerId, marketId: marketId ?? null, potential: potential ?? null, districtId: district?.id ?? null, district: district?.name ?? null, updatedById: ctx.userId },
      select: { marketId: true, district: true, districtId: true, potential: true },
    });
    const changes: string[] = [];
    if (marketId !== undefined && (before?.marketId ?? null) !== saved.marketId) changes.push(`Market: ${before?.marketText ?? before?.market?.name ?? "—"} → ${market?.name ?? "—"}`);
    const oldDistrict = before?.districtRef?.name ?? before?.district ?? null;
    if (districtId !== undefined && ((before?.districtId ?? null) !== saved.districtId || oldDistrict !== (district?.name ?? null))) changes.push(`District: ${oldDistrict ?? "—"} → ${district?.name ?? "—"}`);
    if (potential !== undefined && (before?.potential ?? null) !== saved.potential) changes.push(`Potential: ${before?.potential ?? "—"} → ${saved.potential ?? "—"}`);
    if (changes.length) await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dealerMarketMapping", entityId: dealerId, summary: `Territory Mapping · ${dealer.name} · ${changes.join("; ")}` }, tx);
    return saved;
  });
  const alias = (await loadDealerAliasNameMap([dealerId])).get(dealerId);
  const wasEdited = (await prisma.territoryMarketEdit.findMany({ where: { dealerId }, select: { dealerId: true }, take: 1 })).length > 0;
  const after = await prisma.dealerMarketMapping.findUnique({ where: { dealerId }, select: DISTRICT_SELECT });
  return { dealerId, partyName: alias ?? dealer.name, status: dealer.status, marketId: row.marketId, marketEdited: wasEdited, ...districtFields(after ?? { district: row.district, districtId: row.districtId }, state), marketName: market?.name ?? (row.marketId ? (await prisma.market.findUnique({ where: { id: row.marketId }, select: { name: true } }))?.name ?? null : null), potential: asPotential(row.potential) };
}

/* ------------------------------------------------ manual Market edit (temporary) ------------------------------------------------ */

const marketEditInput = z.object({
  expectedMarket: z.string().nullable().optional(), // the Market the user saw — guards against a concurrent change
  market: z.string().transform(cleanMarketName).pipe(z.string().min(1, "Market is required").max(MARKET_NAME_MAX, `Market can be at most ${MARKET_NAME_MAX} characters`)),
});
const sameMarket = (a: string | null | undefined, b: string | null | undefined) => (a ? marketNameKey(a) : "") === (b ? marketNameKey(b) : "");

/**
 * Manually correct ONE dealer's displayed Market (free text; NOT a Market master record — none is created and Seasonal / Monthly Planning are
 * unaffected). The current value is re-read inside the transaction and must match what the user saw; the mapping update and the append-only
 * history row (previous → new, who, when) are written together or not at all.
 */
export async function editDealerMarket(ctx: AuthContext, dealerId: string, raw: unknown): Promise<TerritoryDealerRow> {
  assertTerritoryWriter(ctx);
  const parsed = marketEditInput.safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid Market");
  const dealer = await assertDealerInScope(ctx, dealerId);
  const next = parsed.data.market;
  const saved = await prisma.$transaction(async (tx) => {
    const before = await tx.dealerMarketMapping.findUnique({ where: { dealerId }, select: { marketId: true, marketText: true, district: true, districtId: true, potential: true, market: { select: { name: true } } } });
    const current = before?.marketText ?? before?.market?.name ?? null;
    if (!sameMarket(current, parsed.data.expectedMarket)) throw new ApiError(409, "This dealer's Market was changed by someone else. Reload and try again.");
    if (sameMarket(current, next)) throw new ApiError(422, "That is already this dealer's Market");
    let row: { marketId: string | null; district: string | null; districtId: string | null; potential: string | null };
    if (before) {
      // Claim: only succeeds while the mapping still holds the value we just read.
      const claimed = await tx.dealerMarketMapping.updateMany({ where: { dealerId, marketId: before.marketId, marketText: before.marketText }, data: { marketText: next, updatedById: ctx.userId } });
      if (claimed.count !== 1) throw new ApiError(409, "This dealer's Market was changed by someone else. Reload and try again.");
      row = before;
    } else {
      row = await tx.dealerMarketMapping.create({ data: { dealerId, marketText: next, updatedById: ctx.userId }, select: { marketId: true, district: true, districtId: true, potential: true } });
    }
    await tx.territoryMarketEdit.create({ data: { dealerId, previousMarket: current, newMarket: next, editedById: ctx.userId } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dealerMarketMapping", entityId: dealerId, summary: `Territory Mapping · ${dealer.name} · Market (manual edit): ${current ?? "—"} → ${next}` }, tx);
    return row;
  });
  const alias = (await loadDealerAliasNameMap([dealerId])).get(dealerId);
  return { dealerId, partyName: alias ?? dealer.name, status: dealer.status, marketId: saved.marketId, marketName: next, marketEdited: true, potential: asPotential(saved.potential), ...districtFields((await prisma.dealerMarketMapping.findUnique({ where: { dealerId }, select: DISTRICT_SELECT })) ?? { district: saved.district, districtId: saved.districtId }, (await dealerStates([dealerId])).get(dealerId) ?? null) };
}

export interface MarketEditDto { id: string; previousMarket: string | null; newMarket: string; editedByName: string; editedAt: string }
/** Every manual Market edit of one dealer, oldest first. Same scope rule as editing. */
export async function listMarketEdits(ctx: AuthContext, dealerId: string): Promise<{ dealerName: string; edits: MarketEditDto[] }> {
  assertTerritoryUser(ctx);
  const dealer = await assertDealerInScope(ctx, dealerId);
  const alias = (await loadDealerAliasNameMap([dealerId])).get(dealerId);
  const rows = await prisma.territoryMarketEdit.findMany({ where: { dealerId }, include: { editedBy: { select: { name: true } } }, orderBy: [{ editedAt: "asc" }, { id: "asc" }] });
  return { dealerName: alias ?? dealer.name, edits: rows.map((r) => ({ id: r.id, previousMarket: r.previousMarket, newMarket: r.newMarket, editedByName: r.editedBy.name, editedAt: r.editedAt.toISOString() })) };
}

/* ------------------------------------------------ Excel import ------------------------------------------------ */

export interface ImportPreview {
  sheetNames: string[];
  sheet: string | null;
  needsSheet: boolean;
  error: string | null;
  plan: ImportPlanRow[];
  summary: ImportSummary | null;
}

const MAX_IMPORT_ROWS = 5000;
const MAX_CANDIDATES = 8;

/** Parse + match + classify — READ ONLY. Both Preview and Confirm run exactly this, so what was shown is what is applied. */
async function planFromWorkbook(ctx: AuthContext, buffer: Buffer, sheet: string | null, resolutions?: Record<number, string>): Promise<ImportPreview> {
  let workbook;
  try { workbook = readWorkbook(buffer); } catch { throw new ApiError(422, "The file could not be read as an Excel workbook"); }
  const names = sheetNames(workbook);
  if (names.length === 0) throw new ApiError(422, "The workbook has no sheets");
  const chosen = sheet ?? (names.length === 1 ? names[0]! : null);
  if (!chosen) return { sheetNames: names, sheet: null, needsSheet: true, error: null, plan: [], summary: null };
  if (!names.includes(chosen)) throw new ApiError(422, "Select a sheet from the uploaded workbook");

  // Blank rows are KEPT so a reported "row 6" is row 6 in Excel (the shared sheetRows helper drops them).
  const parsed = parseTerritorySheet(XLSX.utils.sheet_to_json(workbook.Sheets[chosen]!, { header: 1, blankrows: true, defval: null }) as unknown[][]);
  if (parsed.error) return { sheetNames: names, sheet: chosen, needsSheet: false, error: parsed.error, plan: [], summary: null };
  if (parsed.rows.length + parsed.invalid.length > MAX_IMPORT_ROWS) throw new ApiError(422, `A sheet can import at most ${MAX_IMPORT_ROWS} rows at a time`);

  const [resolver, scoped, aliasNames, mappings, markets, masters] = await Promise.all([
    loadDealerResolver(),
    loadScopedDealers(ctx),
    loadDealerAliasNameMap(),
    prisma.dealerMarketMapping.findMany({ select: { dealerId: true, district: true, districtId: true, marketText: true, market: { select: { name: true } } } }),
    prisma.market.findMany({ select: { name: true, nameKey: true } }),
    loadDistrictCatalog(),
  ]);
  const inScope = new Set(scoped.map((d) => d.id));
  // The District master decides every District cell, against the matched dealer's OWN state (current owner's group).
  const states = await dealerStates(scoped.map((d) => d.id));
  const resolveDistrict = (dealerId: string, text: string): ImportDistrictOutcome => {
    const state = states.get(dealerId) ?? null;
    const res = masters.catalog.resolve(text, state?.id ?? null);
    switch (res.kind) {
      case "OK": return { kind: "OK", districtId: res.districtId, name: res.name, viaAlias: res.viaAlias };
      case "UNKNOWN": return { kind: "UNKNOWN" };
      case "NO_STATE": return { kind: "INVALID", reason: `This dealer's state cannot be determined, so the District "${text}" cannot be assigned` };
      case "INACTIVE": return { kind: "INVALID", reason: `District "${res.name}" is inactive` };
      case "AMBIGUOUS": return { kind: "INVALID", reason: `District "${text}" matches more than one district (${res.names.join(", ")})` };
      case "WRONG_STATE": return { kind: "INVALID", reason: `District "${res.name}" belongs to ${res.groupIds.map((g) => masters.groupName.get(g) ?? g).join(" / ")}, not this dealer's state (${state?.name ?? "—"})` };
    }
  };
  const resolve = (name: string) => classifyMatch(resolver.candidates(name).slice(0, 50).map((m) => ({
    dealerId: m.dealer.id, partyName: aliasNames.get(m.dealer.id) ?? m.dealer.name, matchType: m.matchType, score: m.score, inScope: inScope.has(m.dealer.id),
  } satisfies ImportCandidate & { inScope: boolean })));
  const wrapped: typeof resolve = (name) => {
    const r = resolve(name);
    return r.kind === "MANY" ? { ...r, candidates: r.candidates.slice(0, MAX_CANDIDATES) } : r;
  };
  const plan = buildImportPlan({
    rows: parsed.rows, invalid: parsed.invalid, resolve: wrapped, resolutions,
    currentMarketByDealer: new Map(mappings.map((m) => [m.dealerId, m.marketText ?? m.market?.name ?? null])),
    currentDistrictByDealer: new Map(mappings.map((m) => [m.dealerId, m.district])),
    currentDistrictIdByDealer: new Map(mappings.map((m) => [m.dealerId, m.districtId])),
    resolveDistrict,
    existingMarketByKey: new Map(markets.map((m) => [m.nameKey, m.name])),
  });
  return { sheetNames: names, sheet: chosen, needsSheet: false, error: null, plan, summary: summarizeImportPlan(plan) };
}

/** Preview: reads only. Nothing is created or changed — not dealers, not markets, not mappings. */
export async function previewTerritoryImport(ctx: AuthContext, buffer: Buffer, sheet: string | null): Promise<ImportPreview> {
  assertTerritoryWriter(ctx);
  return planFromWorkbook(ctx, buffer, sheet);
}

export interface ImportResult {
  applied: number; noChange: number; skippedUnmatched: number; skippedAmbiguous: number; rejectedInvalid: number; duplicates: number; marketsCreated: number;
  /** Rows whose District is not in the District master — skipped whole (their Market is not changed either). */
  skippedUnknownDistrict: number;
}

/**
 * Confirm: re-runs the SAME plan from the uploaded file (never trusts the browser's preview), applies the user's ambiguity picks,
 * and writes every actionable row in ONE transaction. Dealers are never created or edited; unmatched / ambiguous / invalid rows
 * are skipped and counted.
 */
export async function commitTerritoryImport(ctx: AuthContext, buffer: Buffer, sheet: string | null, resolutions: Record<number, string>): Promise<ImportResult> {
  assertTerritoryWriter(ctx);
  const preview = await planFromWorkbook(ctx, buffer, sheet, resolutions);
  if (preview.needsSheet) throw new ApiError(422, "Select a sheet to import");
  if (preview.error) throw new ApiError(422, preview.error);

  const apply = preview.plan.filter((r) => r.status === "MATCHED" && r.action !== "NO_CHANGE");
  const count = (status: ImportPlanRow["status"]) => preview.plan.filter((r) => r.status === status).length;
  const result: ImportResult = {
    applied: apply.length, noChange: preview.plan.filter((r) => r.status === "MATCHED" && r.action === "NO_CHANGE").length,
    skippedUnmatched: count("UNMATCHED"), skippedAmbiguous: count("AMBIGUOUS"),
    rejectedInvalid: count("INVALID") + count("CONFLICT"), duplicates: count("DUPLICATE"), marketsCreated: 0, skippedUnknownDistrict: count("UNKNOWN_DISTRICT"),
  };
  if (apply.length === 0) return result;

  await prisma.$transaction(async (tx) => {
    // 0) Re-check every District against the master INSIDE the transaction (it may have changed since the plan was built): active, and of the dealer's current state.
    const districtRows = apply.filter((r) => r.districtChanged && r.districtId);
    if (districtRows.length) {
      const fresh = await tx.district.findMany({ where: { id: { in: [...new Set(districtRows.map((r) => r.districtId!))] } }, select: { id: true, groupId: true, isActive: true } });
      const freshById = new Map(fresh.map((d) => [d.id, d]));
      const freshStates = await dealerStates(districtRows.map((r) => r.dealerId!), tx as unknown as typeof prisma);
      for (const r of districtRows) {
        const d = freshById.get(r.districtId!);
        if (!d || !d.isActive || d.groupId !== freshStates.get(r.dealerId!)?.id) throw new ApiError(409, `The District "${r.districtName}" for ${r.partyName} is no longer valid. Nothing was imported — preview the file again.`);
      }
    }
    // 1) Markets named in the sheet that do not exist yet (source EXISTING; potential stays undecided — it is a MARKET-level value).
    const wanted = new Map<string, string>();
    for (const row of apply.filter((r) => r.marketChanged)) wanted.set(marketNameKey(row.marketName!), row.marketName!);
    const have = await tx.market.findMany({ where: { nameKey: { in: [...wanted.keys()] } }, select: { id: true, nameKey: true } });
    const idByKey = new Map(have.map((m) => [m.nameKey, m.id]));
    for (const [key, name] of wanted) {
      if (idByKey.has(key)) continue;
      const created = await tx.market.create({ data: { name: cleanMarketName(name), nameKey: key, source: "EXISTING", createdById: ctx.userId }, select: { id: true } });
      idByKey.set(key, created.id); result.marketsCreated += 1;
    }
    // 2) Mappings: only the Market and/or District the plan flagged as changed are written; a dealer-level Potential already chosen is preserved.
    const existing = await tx.dealerMarketMapping.findMany({ where: { dealerId: { in: apply.map((r) => r.dealerId!) } }, select: { dealerId: true } });
    const existingIds = new Set(existing.map((m) => m.dealerId));
    const creates = apply.filter((r) => !existingIds.has(r.dealerId!));
    if (creates.length) await tx.dealerMarketMapping.createMany({ data: creates.map((r) => ({ dealerId: r.dealerId!, marketId: r.marketChanged ? idByKey.get(marketNameKey(r.marketName!))! : null, district: r.districtChanged ? r.districtName! : null, districtId: r.districtChanged ? r.districtId ?? null : null, updatedById: ctx.userId })) });
    for (const row of apply.filter((r) => existingIds.has(r.dealerId!))) {
      await tx.dealerMarketMapping.update({ where: { dealerId: row.dealerId! }, data: { ...(row.marketChanged ? { marketId: idByKey.get(marketNameKey(row.marketName!))!, marketText: null } : {}), // an import-set Market replaces a manual override; it is NOT a manual edit, so no history row
         ...(row.districtChanged ? { district: row.districtName!, districtId: row.districtId ?? null } : {}), updatedById: ctx.userId } });
    }
    // 3) History: one audit row per changed dealer + one for the import itself.
    await tx.auditLog.createMany({ data: [
      ...apply.map((row) => ({ userId: ctx.userId, actorDesignation: ctx.designation ?? null, action: "UPDATE", entity: "dealerMarketMapping", entityId: row.dealerId!, summary: `Territory Mapping import · ${row.partyName} · ${[row.marketChanged ? `Market: ${row.currentMarket ?? "—"} → ${row.marketName}` : "", row.districtChanged ? `District: ${row.currentDistrict ?? "—"} → ${row.districtName}` : ""].filter(Boolean).join("; ")}` })),
      { userId: ctx.userId, actorDesignation: ctx.designation ?? null, action: "CREATE", entity: "territoryMappingImport", entityId: null, summary: `Territory Mapping import (sheet "${preview.sheet}"): ${apply.length} applied, ${result.skippedUnmatched} unmatched, ${result.skippedAmbiguous} ambiguous, ${result.rejectedInvalid} invalid, ${result.skippedUnknownDistrict} unknown district, ${result.marketsCreated} new market(s)` },
    ] });
  }, { timeout: 60_000, maxWait: 10_000 });
  return result;
}

/* ------------------------------------------------ Add Market requests ------------------------------------------------ */

export interface MarketRequestDto {
  id: string; marketName: string; potential: Potential; numberOfParties: number; status: MarketRequestStatus;
  requesterId: string; requesterName: string; createdAt: string;
  rmDecision: string | null; rmDecidedByName: string | null; rmDecidedAt: string | null;
  adminDecision: string | null; adminDecidedByName: string | null; adminDecidedAt: string | null;
  rejectionStage: string | null; rejectionReason: string | null; marketId: string | null;
  /** The District Master entry the request is for; null / null on requests made before the field existed (shown as "—"). */
  districtId: string | null; districtName: string | null;
}
const REQUEST_INCLUDE = { requester: { select: { name: true } }, district: { select: { name: true } } } as const;
type RequestRow = Prisma.MarketRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

async function toRequestDtos(rows: RequestRow[]): Promise<MarketRequestDto[]> {
  const deciderIds = [...new Set(rows.flatMap((r) => [r.rmDecidedById, r.adminDecidedById]).filter((v): v is string => !!v))];
  const users = deciderIds.length ? await prisma.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, name: true } }) : [];
  const name = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id, marketName: r.marketName, potential: r.potential as Potential, numberOfParties: r.numberOfParties, status: r.status as MarketRequestStatus,
    requesterId: r.requesterId, requesterName: r.requester.name, createdAt: r.createdAt.toISOString(),
    rmDecision: r.rmDecision, rmDecidedByName: r.rmDecidedById ? name.get(r.rmDecidedById) ?? null : null, rmDecidedAt: r.rmDecidedAt?.toISOString() ?? null,
    adminDecision: r.adminDecision, adminDecidedByName: r.adminDecidedById ? name.get(r.adminDecidedById) ?? null : null, adminDecidedAt: r.adminDecidedAt?.toISOString() ?? null,
    rejectionStage: r.rejectionStage, rejectionReason: r.rejectionReason, marketId: r.marketId,
    districtId: r.districtId, districtName: r.district?.name ?? null,
  }));
}

export interface RequesterDistricts { stateName: string | null; districts: DistrictOption[] }
/** The requester's OWN State (their UserGroup) — never the team's — and its active districts. No State / no districts → an empty list, never a fallback to others. */
async function requesterState(userId: string): Promise<StateRef | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { groupId: true } });
  if (!user?.groupId) return null;
  const group = (await prisma.userGroup.findMany({ where: { id: { in: [user.groupId] } }, select: { id: true, name: true } }))[0];
  return group ?? null;
}
export async function listRequesterDistricts(ctx: AuthContext): Promise<RequesterDistricts> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can request a Market");
  const state = await requesterState(ctx.userId);
  if (!state) return { stateName: null, districts: [] };
  const rows = await prisma.district.findMany({ where: { groupId: state.id, isActive: true }, select: { id: true, name: true } });
  return { stateName: state.name, districts: [...rows].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** SO / RM submit a request. Duplicate Markets (normalized name) and duplicate pending requests are refused, never merged. */
export async function createMarketRequest(ctx: AuthContext, raw: unknown): Promise<MarketRequestDto> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can request a Market");
  const input = (raw ?? {}) as Record<string, unknown>;
  const problem = validateMarketRequest({ marketName: input.marketName, potential: input.potential, numberOfParties: input.numberOfParties });
  if (problem) throw new ApiError(422, problem);
  // District (required for new requests): an existing, ACTIVE District Master entry of the requester's own State.
  if (typeof input.districtId !== "string" || !input.districtId.trim()) throw new ApiError(422, "Select a District.");
  const state = await requesterState(ctx.userId);
  if (!state) throw new ApiError(422, "Your State could not be identified, so a Market cannot be requested.");
  const district = await prisma.district.findUnique({ where: { id: input.districtId.trim() } });
  if (!district) throw new ApiError(422, "That District does not exist.");
  if (!district.isActive) throw new ApiError(422, "That District is not active.");
  if (district.groupId !== state.id) throw new ApiError(422, `That District does not belong to your State (${state.name}).`);
  const marketName = cleanMarketName(String(input.marketName));
  const nameKey = marketNameKey(marketName);
  const potential = input.potential as Potential;
  const numberOfParties = Number(input.numberOfParties);

  const [existingMarket, pending] = await Promise.all([
    prisma.market.findUnique({ where: { nameKey }, select: { name: true } }),
    prisma.marketRequest.findFirst({ where: { nameKey, status: { in: ["PENDING_RM", "PENDING_ADMIN"] } }, select: { id: true } }),
  ]);
  if (existingMarket) throw new ApiError(409, `The Market "${existingMarket.name}" already exists.`);
  if (pending) throw new ApiError(409, `A request for the Market "${marketName}" is already pending.`);

  // SO → their RM first; an RM (or an SO with no RM in their group) goes straight to Admin review.
  const rmId = ctx.role === Role.SALES_OFFICER ? await getCurrentManagerId(ctx.userId) : null;
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.marketRequest.create({
      data: { requesterId: ctx.userId, marketName, nameKey, potential, numberOfParties, districtId: district.id, status: rmId ? "PENDING_RM" : "PENDING_ADMIN" },
      include: REQUEST_INCLUDE,
    });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "marketRequest", entityId: row.id, summary: `Requested Market "${marketName}" (Potential ${potential}, ${numberOfParties} parties)` }, tx);
    return row;
  });
  return (await toRequestDtos([created]))[0]!;
}

export type MarketRequestView = "mine" | "review" | "history";

/**
 * mine    → the caller's own requests (any status).
 * review  → what the caller must act on now: RM → PENDING_RM of requesters in their group; Admin → PENDING_ADMIN.
 * history → decided requests (APPROVED / REJECTED, or past the caller's step) within the caller's scope (RM: group, Admin: all).
 */
export async function listMarketRequests(ctx: AuthContext, view: MarketRequestView): Promise<MarketRequestDto[]> {
  assertTerritoryUser(ctx);
  const include = REQUEST_INCLUDE;
  const scope = await getOfficerScope(ctx);
  const inScope: Prisma.MarketRequestWhereInput = scope.all ? {} : { requesterId: { in: scope.ids } };
  let where: Prisma.MarketRequestWhereInput;
  if (view === "mine") where = { requesterId: ctx.userId };
  else if (view === "review") {
    if (ctx.role === Role.REGIONAL_MANAGER) where = { status: "PENDING_RM", ...inScope, requesterId: { in: scope.ids.filter((id) => id !== ctx.userId) } };
    else if (isAdministrativeRole(ctx.role)) where = { status: "PENDING_ADMIN" };
    else where = { id: "__none__" }; // a Sales Officer reviews nothing
  } else {
    if (ctx.role === Role.SALES_OFFICER) where = { requesterId: ctx.userId, status: { in: ["APPROVED", "REJECTED"] } };
    else where = { ...inScope, OR: [{ status: { in: ["APPROVED", "REJECTED"] } }, ...(ctx.role === Role.REGIONAL_MANAGER ? [{ status: "PENDING_ADMIN" }] : [])] };
  }
  const rows = await prisma.marketRequest.findMany({ where, include, orderBy: { createdAt: "desc" }, take: 500 });
  return toRequestDtos(rows);
}

const actInput = z.object({ action: z.enum(["approve", "reject"]), reason: z.string().optional() });

/** RM review (PENDING_RM) then Admin review (PENDING_ADMIN). Rejection needs a reason at either step. */
export async function actOnMarketRequest(ctx: AuthContext, id: string, raw: unknown): Promise<MarketRequestDto> {
  const parsed = actInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, "Choose approve or reject");
  const { action } = parsed.data;
  const reason = parsed.data.reason?.trim() ?? "";
  if (action === "reject" && !reason) throw new ApiError(422, "A rejection reason is required.");
  if (reason.length > 500) throw new ApiError(422, "The reason can be at most 500 characters.");

  const isRm = ctx.role === Role.REGIONAL_MANAGER;
  const isAdmin = isAdministrativeRole(ctx.role);
  if (!isRm && !isAdmin) throw new ApiError(403, "Only a Regional Manager or Admin can review Market requests");
  if (isAdmin) assertAdminPermission(ctx, "partyPlanning", action === "approve" ? "approve" : "reject");

  const updated = await prisma.$transaction(async (tx) => {
    const request = await tx.marketRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
    if (!request) throw new ApiError(404, "Market request not found");
    const now = new Date();
    if (isRm) {
      if (request.status !== "PENDING_RM") throw new ApiError(409, "This request is not waiting for RM review");
      const scope = await getOfficerScope(ctx, tx);
      if (request.requesterId === ctx.userId || !scope.ids.includes(request.requesterId)) throw new ApiError(403, "This request is outside your team");
      const data = action === "approve"
        ? { status: "PENDING_ADMIN", rmDecision: "APPROVED", rmDecidedById: ctx.userId, rmDecidedAt: now }
        : { status: "REJECTED", rmDecision: "REJECTED", rmDecidedById: ctx.userId, rmDecidedAt: now, rejectionStage: "RM", rejectionReason: reason };
      const row = await tx.marketRequest.update({ where: { id }, data, include: REQUEST_INCLUDE });
      await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "marketRequest", entityId: id, summary: `RM ${action === "approve" ? "approved" : "rejected"} Market request "${request.marketName}"${action === "reject" ? ` — ${reason}` : ""}` }, tx);
      return row;
    }
    if (request.status !== "PENDING_ADMIN") throw new ApiError(409, "This request is not waiting for Admin review");
    if (action === "reject") {
      const row = await tx.marketRequest.update({ where: { id }, data: { status: "REJECTED", adminDecision: "REJECTED", adminDecidedById: ctx.userId, adminDecidedAt: now, rejectionStage: "ADMIN", rejectionReason: reason }, include: REQUEST_INCLUDE });
      await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "marketRequest", entityId: id, summary: `Admin rejected Market request "${request.marketName}" — ${reason}` }, tx);
      return row;
    }
    // Final approval is the ONLY point at which the Market becomes real / usable.
    if (await tx.market.findUnique({ where: { nameKey: request.nameKey }, select: { id: true } })) throw new ApiError(409, `The Market "${request.marketName}" already exists.`);
    const market = await tx.market.create({ data: { name: request.marketName, nameKey: request.nameKey, potential: request.potential, source: "REQUESTED", expectedParties: request.numberOfParties, createdById: request.requesterId }, select: { id: true } });
    const row = await tx.marketRequest.update({ where: { id }, data: { status: "APPROVED", adminDecision: "APPROVED", adminDecidedById: ctx.userId, adminDecidedAt: now, marketId: market.id }, include: REQUEST_INCLUDE });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "market", entityId: market.id, summary: `Admin approved Market request "${request.marketName}" (Potential ${request.potential})` }, tx);
    return row;
  });
  return (await toRequestDtos([updated]))[0]!;
}

/* ------------------------------------------------ Dealer Status Change Requests ------------------------------------------------ */

/** The Edit-dialog prefill (same shape the Dealer Alias page gives its Edit dialog) — null when the dealer is not editable there (e.g. deleted). */
export interface StatusRequestEditDealer { id: string; name: string; officerId: string | null; groupId: string | null; town: string | null; status: string; inActivePlan: boolean; aliases: { id: string; tallyName: string }[] }
export interface DealerStatusRequestDto {
  id: string; dealerId: string; partyName: string; statusAtRequest: string; currentStatus: string;
  reason: DealerStatusReason; description: string | null;
  requestedById: string; requestedByName: string; requestedByRole: Role; createdAt: string;
  status: DealerStatusRequestState; resolvedByName: string | null; resolvedAt: string | null; resolutionNotes: string | null;
  editDealer: StatusRequestEditDealer | null;
}
type StatusRequestRow = Prisma.DealerStatusRequestGetPayload<Record<string, never>>;

/** Status requests are reviewed by Admin only; Custom Admins need the Party Planning "manage" permission (Super Admin always has it). */
function assertStatusRequestAdmin(ctx: AuthContext): void {
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only an Admin can review dealer status requests");
  assertAdminPermission(ctx, "partyPlanning", "manage");
}

async function toStatusRequestDtos(ctx: AuthContext, rows: StatusRequestRow[], withEdit: boolean): Promise<DealerStatusRequestDto[]> {
  if (rows.length === 0) return [];
  const dealerIds = [...new Set(rows.map((r) => r.dealerId))];
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.resolvedById]).filter((v): v is string => !!v))];
  const [dealers, users, aliasNames, editable] = await Promise.all([
    prisma.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true, status: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    loadDealerAliasNameMap(dealerIds),
    // The SAME loader the Dealer Alias page uses for its Edit dialog — no second dealer-data path.
    withEdit ? listDealersForAlias(ctx, "all", undefined, undefined, undefined, dealerIds) : Promise.resolve(null),
  ]);
  const dealerById = new Map(dealers.map((d) => [d.id, d]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const editById = new Map((editable?.dealers ?? []).map((d) => [d.id, d]));
  return rows.map((r) => {
    const d = dealerById.get(r.dealerId);
    const e = editById.get(r.dealerId);
    return {
      id: r.id, dealerId: r.dealerId, partyName: aliasNames.get(r.dealerId) ?? d?.name ?? "—", statusAtRequest: r.statusAtRequest, currentStatus: d?.status ?? r.statusAtRequest,
      reason: r.reason as DealerStatusReason, description: r.description,
      requestedById: r.requestedById, requestedByName: userName.get(r.requestedById) ?? "—", requestedByRole: r.requestedByRole, createdAt: r.createdAt.toISOString(),
      status: r.status as DealerStatusRequestState, resolvedByName: r.resolvedById ? userName.get(r.resolvedById) ?? null : null, resolvedAt: r.resolvedAt?.toISOString() ?? null, resolutionNotes: r.resolutionNotes,
      editDealer: e ? { id: e.id, name: e.name, officerId: e.officerId, groupId: e.groupId, town: e.town, status: e.status, inActivePlan: e.inActivePlan, aliases: e.aliases } : null,
    };
  });
}

/**
 * SO / RM report a dealer in their own scope. This ONLY records a PENDING request — the dealer row is never written. At most one open request
 * per dealer (checked here and enforced by a partial unique index, so concurrent submits cannot both succeed).
 */
export async function createDealerStatusRequest(ctx: AuthContext, raw: unknown): Promise<DealerStatusRequestDto> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can request a dealer status change");
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input.dealerId !== "string" || !input.dealerId.trim()) throw new ApiError(422, "Choose a dealer.");
  const problem = validateStatusRequest({ reason: input.reason, description: input.description });
  if (problem) throw new ApiError(422, problem);
  const reason = input.reason as DealerStatusReason;
  const description = cleanRequestText(input.description) || null;

  const dealer = await assertDealerInScope(ctx, input.dealerId); // server-side scope: 404 unknown, 403 outside the caller's dealers
  let created: StatusRequestRow;
  try {
    created = await prisma.$transaction(async (tx) => {
      if (await tx.dealerStatusRequest.findFirst({ where: { dealerId: dealer.id, status: "PENDING" }, select: { id: true } })) throw new ApiError(409, "A status change request for this dealer is already pending.");
      const row = await tx.dealerStatusRequest.create({
        data: { dealerId: dealer.id, statusAtRequest: dealer.status, reason, description, requestedById: ctx.userId, requestedByRole: ctx.role, status: "PENDING" },
      });
      await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "dealerStatusRequest", entityId: row.id, summary: `Requested a status change for dealer "${dealer.name}" (${reason}${description ? `: ${description}` : ""}); current status ${dealer.status}` }, tx);
      return row;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ApiError(409, "A status change request for this dealer is already pending.");
    throw e;
  }
  return (await toStatusRequestDtos(ctx, [created], false))[0]!;
}

/** Admin list: "pending" (oldest first, to be worked) or "resolved" (history, newest first). */
export async function listDealerStatusRequests(ctx: AuthContext, view: "pending" | "resolved"): Promise<DealerStatusRequestDto[]> {
  assertStatusRequestAdmin(ctx);
  const rows = await prisma.dealerStatusRequest.findMany({
    where: { status: view === "pending" ? "PENDING" : "RESOLVED" },
    orderBy: view === "pending" ? { createdAt: "asc" } : { resolvedAt: "desc" },
    take: 500,
  });
  return toStatusRequestDtos(ctx, rows, view === "pending");
}

/**
 * Admin marks a request RESOLVED — an explicit action, separate from editing the dealer (opening / cancelling / failing the edit never reaches
 * here). It changes only the request (resolver, time, optional notes); the dealer and the request's reason / history are untouched.
 */
export async function resolveDealerStatusRequest(ctx: AuthContext, id: string, raw: unknown): Promise<DealerStatusRequestDto> {
  assertStatusRequestAdmin(ctx);
  const notes = cleanRequestText(((raw ?? {}) as Record<string, unknown>).notes);
  if (notes.length > STATUS_REQUEST_NOTES_MAX) throw new ApiError(422, `The notes can be at most ${STATUS_REQUEST_NOTES_MAX} characters.`);
  const resolved = await prisma.$transaction(async (tx) => {
    const request = await tx.dealerStatusRequest.findUnique({ where: { id } });
    if (!request) throw new ApiError(404, "Status request not found");
    // Conditional write: only a still-PENDING row can be resolved, so two Admins cannot both resolve it.
    const { count } = await tx.dealerStatusRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "RESOLVED", resolvedById: ctx.userId, resolvedAt: new Date(), resolutionNotes: notes || null } });
    if (count !== 1) throw new ApiError(409, "This request has already been resolved.");
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dealerStatusRequest", entityId: id, summary: `Resolved dealer status request (${request.reason}) for dealer ${request.dealerId}${notes ? ` — ${notes}` : ""}` }, tx);
    return (await tx.dealerStatusRequest.findUnique({ where: { id } }))!;
  });
  return (await toStatusRequestDtos(ctx, [resolved], false))[0]!;
}
