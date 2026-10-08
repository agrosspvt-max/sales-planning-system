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
import {
  POTENTIALS, DISTRICT_MAX, buildImportPlan, classifyMatch, cleanDistrict, cleanMarketName, isPotential, marketNameKey, parseTerritorySheet, summarizeImportPlan, validateMarketRequest,
  type ImportCandidate, type ImportPlanRow, type ImportSummary, type MarketRequestStatus, type Potential,
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

interface ScopedDealer { id: string; name: string; status: string }
/** The caller's authorized dealers (active, not deleted, current owner inside the caller's scope). */
async function loadScopedDealers(ctx: AuthContext): Promise<ScopedDealer[]> {
  const scope = await getOfficerScope(ctx);
  const dealers = await prisma.dealer.findMany({
    where: { deletedAt: null, isActive: true, ...(scope.all ? {} : { assignments: { some: { officerId: { in: scope.ids }, effectiveTo: null } } }) },
    select: { id: true, name: true, status: true },
  });
  const owners = await getCurrentOwnerByDealer(dealers.map((d) => d.id));
  return dealers.filter((d) => scope.all || scope.ids.includes(owners.get(d.id) ?? ""));
}
async function assertDealerInScope(ctx: AuthContext, dealerId: string): Promise<ScopedDealer> {
  const dealer = await prisma.dealer.findFirst({ where: { id: dealerId, deletedAt: null }, select: { id: true, name: true, status: true } });
  if (!dealer) throw new ApiError(404, "Dealer not found");
  const scope = await getOfficerScope(ctx);
  if (!scope.all) {
    const owner = (await getCurrentOwnerByDealer([dealerId])).get(dealerId);
    if (!owner || !scope.ids.includes(owner)) throw new ApiError(403, "You do not have access to this dealer");
  }
  return dealer;
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

export interface TerritoryDealerRow {
  dealerId: string; partyName: string; status: string;
  marketId: string | null; marketName: string | null; district: string | null; potential: Potential | null;
}
export interface TerritoryListParams extends PageParams { market: string } // "" = all, "__none__" = unmapped, else a marketId

export async function listTerritoryDealers(ctx: AuthContext, params: TerritoryListParams): Promise<Paginated<TerritoryDealerRow> & { mapped: number; unmapped: number }> {
  assertTerritoryUser(ctx);
  const dealers = await loadScopedDealers(ctx);
  const ids = dealers.map((d) => d.id);
  const [aliases, mappings] = await Promise.all([
    loadDealerAliasNameMap(ids),
    ids.length ? prisma.dealerMarketMapping.findMany({ where: { dealerId: { in: ids } }, select: { dealerId: true, marketId: true, district: true, potential: true, market: { select: { name: true } } } }) : Promise.resolve([]),
  ]);
  const mappingByDealer = new Map(mappings.map((m) => [m.dealerId, m]));
  const all: TerritoryDealerRow[] = dealers.map((d) => {
    const m = mappingByDealer.get(d.id);
    return { dealerId: d.id, partyName: aliases.get(d.id) ?? d.name, status: d.status, marketId: m?.marketId ?? null, marketName: m?.market?.name ?? null, district: m?.district ?? null, potential: asPotential(m?.potential ?? null) };
  });
  const needle = params.search.trim().toLowerCase();
  const matches = all.filter((row) => {
    if (needle && !row.partyName.toLowerCase().includes(needle) && !(dealers.find((d) => d.id === row.dealerId)?.name.toLowerCase().includes(needle))) return false;
    if (params.market === "__none__") return row.marketId == null;
    if (params.market) return row.marketId === params.market;
    return true;
  }).sort((a, b) => a.partyName.localeCompare(b.partyName));
  const start = (params.page - 1) * params.pageSize;
  return {
    ...buildPage(matches.slice(start, start + params.pageSize), matches.length, params),
    mapped: all.filter((r) => r.marketId != null).length,
    unmapped: all.filter((r) => r.marketId == null).length,
  };
}

const mappingInput = z.object({
  marketId: z.string().min(1).nullable().optional(),
  potential: z.enum(POTENTIALS).nullable().optional(),
  district: z.string().max(DISTRICT_MAX, `District can be at most ${DISTRICT_MAX} characters`).nullable().optional(),
}).refine((v) => v.marketId !== undefined || v.potential !== undefined || v.district !== undefined, { message: "Nothing to update" });

/** Set the dealer's Market and/or dealer-level Potential. Only the provided fields change; the dealer record itself is never written. */
export async function updateDealerMapping(ctx: AuthContext, dealerId: string, raw: unknown): Promise<TerritoryDealerRow> {
  assertTerritoryWriter(ctx);
  const parsed = mappingInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid mapping");
  const { marketId, potential } = parsed.data;
  const district = parsed.data.district === undefined ? undefined : cleanDistrict(parsed.data.district ?? "") || null;
  const dealer = await assertDealerInScope(ctx, dealerId);
  const market = marketId ? await prisma.market.findUnique({ where: { id: marketId }, select: { id: true, name: true } }) : null;
  if (marketId && !market) throw new ApiError(422, "Select a valid Market");

  const row = await prisma.$transaction(async (tx) => {
    const before = await tx.dealerMarketMapping.findUnique({ where: { dealerId }, select: { marketId: true, district: true, potential: true, market: { select: { name: true } } } });
    const data: { marketId?: string | null; potential?: string | null; district?: string | null; updatedById: string } = { updatedById: ctx.userId };
    if (marketId !== undefined) data.marketId = marketId;
    if (potential !== undefined) data.potential = potential;
    if (district !== undefined) data.district = district;
    const saved = await tx.dealerMarketMapping.upsert({
      where: { dealerId }, update: data,
      create: { dealerId, marketId: marketId ?? null, potential: potential ?? null, district: district ?? null, updatedById: ctx.userId },
      select: { marketId: true, district: true, potential: true },
    });
    const changes: string[] = [];
    if (marketId !== undefined && (before?.marketId ?? null) !== saved.marketId) changes.push(`Market: ${before?.market?.name ?? "—"} → ${market?.name ?? "—"}`);
    if (district !== undefined && (before?.district ?? null) !== saved.district) changes.push(`District: ${before?.district ?? "—"} → ${saved.district ?? "—"}`);
    if (potential !== undefined && (before?.potential ?? null) !== saved.potential) changes.push(`Potential: ${before?.potential ?? "—"} → ${saved.potential ?? "—"}`);
    if (changes.length) await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dealerMarketMapping", entityId: dealerId, summary: `Territory Mapping · ${dealer.name} · ${changes.join("; ")}` }, tx);
    return saved;
  });
  const alias = (await loadDealerAliasNameMap([dealerId])).get(dealerId);
  return { dealerId, partyName: alias ?? dealer.name, status: dealer.status, marketId: row.marketId, district: row.district, marketName: market?.name ?? (row.marketId ? (await prisma.market.findUnique({ where: { id: row.marketId }, select: { name: true } }))?.name ?? null : null), potential: asPotential(row.potential) };
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

  const [resolver, scoped, aliasNames, mappings, markets] = await Promise.all([
    loadDealerResolver(),
    loadScopedDealers(ctx),
    loadDealerAliasNameMap(),
    prisma.dealerMarketMapping.findMany({ select: { dealerId: true, district: true, market: { select: { name: true } } } }),
    prisma.market.findMany({ select: { name: true, nameKey: true } }),
  ]);
  const inScope = new Set(scoped.map((d) => d.id));
  const resolve = (name: string) => classifyMatch(resolver.candidates(name).slice(0, 50).map((m) => ({
    dealerId: m.dealer.id, partyName: aliasNames.get(m.dealer.id) ?? m.dealer.name, matchType: m.matchType, score: m.score, inScope: inScope.has(m.dealer.id),
  } satisfies ImportCandidate & { inScope: boolean })));
  const wrapped: typeof resolve = (name) => {
    const r = resolve(name);
    return r.kind === "MANY" ? { ...r, candidates: r.candidates.slice(0, MAX_CANDIDATES) } : r;
  };
  const plan = buildImportPlan({
    rows: parsed.rows, invalid: parsed.invalid, resolve: wrapped, resolutions,
    currentMarketByDealer: new Map(mappings.map((m) => [m.dealerId, m.market?.name ?? null])),
    currentDistrictByDealer: new Map(mappings.map((m) => [m.dealerId, m.district])),
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
    rejectedInvalid: count("INVALID") + count("CONFLICT"), duplicates: count("DUPLICATE"), marketsCreated: 0,
  };
  if (apply.length === 0) return result;

  await prisma.$transaction(async (tx) => {
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
    if (creates.length) await tx.dealerMarketMapping.createMany({ data: creates.map((r) => ({ dealerId: r.dealerId!, marketId: r.marketChanged ? idByKey.get(marketNameKey(r.marketName!))! : null, district: r.districtChanged ? r.districtName! : null, updatedById: ctx.userId })) });
    for (const row of apply.filter((r) => existingIds.has(r.dealerId!))) {
      await tx.dealerMarketMapping.update({ where: { dealerId: row.dealerId! }, data: { ...(row.marketChanged ? { marketId: idByKey.get(marketNameKey(row.marketName!))! } : {}), ...(row.districtChanged ? { district: row.districtName! } : {}), updatedById: ctx.userId } });
    }
    // 3) History: one audit row per changed dealer + one for the import itself.
    await tx.auditLog.createMany({ data: [
      ...apply.map((row) => ({ userId: ctx.userId, actorDesignation: ctx.designation ?? null, action: "UPDATE", entity: "dealerMarketMapping", entityId: row.dealerId!, summary: `Territory Mapping import · ${row.partyName} · ${[row.marketChanged ? `Market: ${row.currentMarket ?? "—"} → ${row.marketName}` : "", row.districtChanged ? `District: ${row.currentDistrict ?? "—"} → ${row.districtName}` : ""].filter(Boolean).join("; ")}` })),
      { userId: ctx.userId, actorDesignation: ctx.designation ?? null, action: "CREATE", entity: "territoryMappingImport", entityId: null, summary: `Territory Mapping import (sheet "${preview.sheet}"): ${apply.length} applied, ${result.skippedUnmatched} unmatched, ${result.skippedAmbiguous} ambiguous, ${result.rejectedInvalid} invalid, ${result.marketsCreated} new market(s)` },
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
}
type RequestRow = Prisma.MarketRequestGetPayload<{ include: { requester: { select: { name: true } } } }>;

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
  }));
}

/** SO / RM submit a request. Duplicate Markets (normalized name) and duplicate pending requests are refused, never merged. */
export async function createMarketRequest(ctx: AuthContext, raw: unknown): Promise<MarketRequestDto> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can request a Market");
  const input = (raw ?? {}) as Record<string, unknown>;
  const problem = validateMarketRequest({ marketName: input.marketName, potential: input.potential, numberOfParties: input.numberOfParties });
  if (problem) throw new ApiError(422, problem);
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
      data: { requesterId: ctx.userId, marketName, nameKey, potential, numberOfParties, status: rmId ? "PENDING_RM" : "PENDING_ADMIN" },
      include: { requester: { select: { name: true } } },
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
  const include = { requester: { select: { name: true } } } as const;
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
    const request = await tx.marketRequest.findUnique({ where: { id }, include: { requester: { select: { name: true } } } });
    if (!request) throw new ApiError(404, "Market request not found");
    const now = new Date();
    if (isRm) {
      if (request.status !== "PENDING_RM") throw new ApiError(409, "This request is not waiting for RM review");
      const scope = await getOfficerScope(ctx, tx);
      if (request.requesterId === ctx.userId || !scope.ids.includes(request.requesterId)) throw new ApiError(403, "This request is outside your team");
      const data = action === "approve"
        ? { status: "PENDING_ADMIN", rmDecision: "APPROVED", rmDecidedById: ctx.userId, rmDecidedAt: now }
        : { status: "REJECTED", rmDecision: "REJECTED", rmDecidedById: ctx.userId, rmDecidedAt: now, rejectionStage: "RM", rejectionReason: reason };
      const row = await tx.marketRequest.update({ where: { id }, data, include: { requester: { select: { name: true } } } });
      await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "marketRequest", entityId: id, summary: `RM ${action === "approve" ? "approved" : "rejected"} Market request "${request.marketName}"${action === "reject" ? ` — ${reason}` : ""}` }, tx);
      return row;
    }
    if (request.status !== "PENDING_ADMIN") throw new ApiError(409, "This request is not waiting for Admin review");
    if (action === "reject") {
      const row = await tx.marketRequest.update({ where: { id }, data: { status: "REJECTED", adminDecision: "REJECTED", adminDecidedById: ctx.userId, adminDecidedAt: now, rejectionStage: "ADMIN", rejectionReason: reason }, include: { requester: { select: { name: true } } } });
      await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "marketRequest", entityId: id, summary: `Admin rejected Market request "${request.marketName}" — ${reason}` }, tx);
      return row;
    }
    // Final approval is the ONLY point at which the Market becomes real / usable.
    if (await tx.market.findUnique({ where: { nameKey: request.nameKey }, select: { id: true } })) throw new ApiError(409, `The Market "${request.marketName}" already exists.`);
    const market = await tx.market.create({ data: { name: request.marketName, nameKey: request.nameKey, potential: request.potential, source: "REQUESTED", expectedParties: request.numberOfParties, createdById: request.requesterId }, select: { id: true } });
    const row = await tx.marketRequest.update({ where: { id }, data: { status: "APPROVED", adminDecision: "APPROVED", adminDecidedById: ctx.userId, adminDecidedAt: now, marketId: market.id }, include: { requester: { select: { name: true } } } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "market", entityId: market.id, summary: `Admin approved Market request "${request.marketName}" (Potential ${request.potential})` }, tx);
    return row;
  });
  return (await toRequestDtos([updated]))[0]!;
}
