import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { assertAdminPermission, isAdministrativeRole } from "@/features/accounts/permissions";
import { getCurrentDealerIds, getCurrentOwnerByDealer, getOfficerScope } from "@/lib/scope";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { territoryText } from "@/lib/territory-mapping";
import { cleanText, validateRetailerInput, type RetailerInputError } from "@/lib/retailer";

/**
 * RETAILER MAPPING. A Retailer is its own entity (never a Dealer) linked to any number of dealers. An SO / RM submits a creation REQUEST (Pending); Admin approves (one retailer + its dealer
 * links, atomically) or rejects (with a reason). Linked dealers a requester may pick are the dealers CURRENTLY assigned to that requester — an RM's own, never their team's. Every submitted
 * dealer id is re-verified on the server, and the whole submission is refused if any one of them is not the requester's.
 */
const ERROR: Record<RetailerInputError, string> = {
  name_required: "Enter the Retailer Name.", name_long: "The Retailer Name is too long.", firm_required: "Enter the Firm Name.", firm_long: "The Firm Name is too long.",
  phone_invalid: "The Phone Number must be exactly 10 digits.", dealers_required: "Select at least one Linked Dealer.", dealers_too_many: "Too many Linked Dealers selected.",
};
function assertRequester(ctx: AuthContext): void {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can add a Retailer");
}
function assertReviewer(ctx: AuthContext): void {
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, "Only an Admin can review Retailer requests");
  assertAdminPermission(ctx, "partyPlanning", "manage");
}

export interface RetailerDealerChoice { id: string; name: string }
/** The requester's OWN current dealers (SO: theirs; RM: their directly assigned ones — team dealers are not included). Displayed name = alias-aware. */
export async function listRetailerDealerChoices(ctx: AuthContext): Promise<RetailerDealerChoice[]> {
  assertRequester(ctx);
  const ids = await getCurrentDealerIds(ctx.userId);
  if (ids.length === 0) return [];
  const [rows, alias] = await Promise.all([prisma.dealer.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true } }), loadDealerAliasNameMap(ids)]);
  return rows.map((d) => ({ id: d.id, name: alias.get(d.id) ?? d.name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface RetailerRequestDto {
  id: string; retailerName: string; firmName: string; phone: string; dealers: { id: string; name: string }[];
  requestedById: string; requestedByName: string; requestedByTerritory: string | null; createdAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED"; decidedByName: string | null; decidedAt: string | null; rejectionReason: string | null; retailerId: string | null;
}
type Row = Prisma.RetailerRequestGetPayload<{ include: { dealers: true; requester: { select: { name: true; territory: true } } } }>;
const INCLUDE = { dealers: { orderBy: { dealerName: "asc" as const } }, requester: { select: { name: true, territory: true } } };
const toDto = (r: Row): RetailerRequestDto => ({
  id: r.id, retailerName: r.retailerName, firmName: r.firmName, phone: r.phone, dealers: r.dealers.map((d) => ({ id: d.dealerId, name: d.dealerName })),
  requestedById: r.requesterId, requestedByName: r.requester.name, requestedByTerritory: territoryText(r.requester.territory), createdAt: r.createdAt.toISOString(),
  status: r.status as RetailerRequestDto["status"], decidedByName: r.decidedByName, decidedAt: r.decidedAt?.toISOString() ?? null, rejectionReason: r.rejectionReason, retailerId: r.retailerId,
});

/** Submit a retailer-creation request. Idempotent per `submissionKey` (a double click / retry returns the SAME request); nothing is created if any dealer is not the requester's. */
export async function createRetailerRequest(ctx: AuthContext, raw: unknown): Promise<RetailerRequestDto> {
  assertRequester(ctx);
  const input = (raw ?? {}) as Record<string, unknown>;
  if (Array.isArray(input.dealerIds) && input.dealerIds.some((id) => typeof id !== "string" || !id || id.length > 64)) throw new ApiError(422, "Select valid Linked Dealers.");
  const dealerIds = [...new Set(Array.isArray(input.dealerIds) ? input.dealerIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64) : [])];
  const problem = validateRetailerInput({ retailerName: input.retailerName, firmName: input.firmName, phone: input.phone, dealerIds });
  if (problem) throw new ApiError(422, ERROR[problem]);
  const key = typeof input.submissionKey === "string" && /^[A-Za-z0-9-]{8,64}$/.test(input.submissionKey) ? input.submissionKey : randomUUID();
  const retailerName = cleanText(input.retailerName), firmName = cleanText(input.firmName), phone = input.phone as string;
  const replay = (existing: Row) => {
    if (existing.retailerName !== retailerName || existing.firmName !== firmName || existing.phone !== phone || existing.dealers.map((d) => d.dealerId).sort().join("|") !== [...dealerIds].sort().join("|")) throw new ApiError(409, "This submission was already saved with different details. Close the form and start a new request.");
    return toDto(existing);
  };
  const existing = await prisma.retailerRequest.findUnique({ where: { requesterId_submissionKey: { requesterId: ctx.userId, submissionKey: key } }, include: INCLUDE });
  if (existing) return replay(existing); // retries still work if an assignment changed after the first successful submission
  // Every dealer must CURRENTLY belong to the requester. One forged / stale id refuses the whole submission (never a partial acceptance).
  const mine = new Set(await getCurrentDealerIds(ctx.userId));
  if (dealerIds.some((id) => !mine.has(id))) throw new ApiError(403, "One or more selected dealers are not currently assigned to you.");
  const [dealers, alias] = await Promise.all([prisma.dealer.findMany({ where: { id: { in: dealerIds }, deletedAt: null }, select: { id: true, name: true } }), loadDealerAliasNameMap(dealerIds)]);
  if (dealers.length !== dealerIds.length) throw new ApiError(422, "One or more selected dealers no longer exist.");
  try {
    const id = await prisma.$transaction(async (tx) => {
      const row = await tx.retailerRequest.create({
        data: { requesterId: ctx.userId, requesterRole: ctx.role, retailerName, firmName, phone, submissionKey: key, dealers: { create: dealers.map((d) => ({ dealerId: d.id, dealerName: alias.get(d.id) ?? d.name })) } },
        select: { id: true },
      });
      await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "retailerRequest", entityId: row.id, summary: `Requested Retailer "${retailerName}" (${firmName}) linked to ${dealers.length} dealer(s)` }, tx);
      return row.id;
    });
    return toDto(await prisma.retailerRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE }));
  } catch (e) {
    // The same submission again (double click / retry): return the request it already created.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.retailerRequest.findUnique({ where: { requesterId_submissionKey: { requesterId: ctx.userId, submissionKey: key } }, include: INCLUDE });
      if (existing) return replay(existing);
    }
    throw e;
  }
}

/** The requester's own submissions with their status (newest first). */
export async function listMyRetailerRequests(ctx: AuthContext): Promise<RetailerRequestDto[]> {
  assertRequester(ctx);
  return (await prisma.retailerRequest.findMany({ where: { requesterId: ctx.userId }, include: INCLUDE, orderBy: { createdAt: "desc" }, take: 200 })).map(toDto);
}

export interface RetailerDto { id: string; name: string; firmName: string; phone: string; createdAt: string; createdByName: string; dealers: { id: string; name: string }[] }
/**
 * Approved retailers inside the viewer's scope: a retailer is listed when at least one of its linked dealers is currently owned by someone in the viewer's scope, and ONLY those in-scope
 * dealer links are shown (an RM never sees a retailer's dealers outside their team; an SO only their own).
 */
export async function listRetailers(ctx: AuthContext): Promise<RetailerDto[]> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER && !isAdministrativeRole(ctx.role)) throw new ApiError(403, "You do not have access to Retailer Mapping");
  assertAdminPermission(ctx, "partyPlanning", "read");
  const scope = await getOfficerScope(ctx);
  let dealerFilter: { in: string[] } | undefined;
  if (!scope.all) {
    const assigned = await prisma.dealerAssignment.findMany({ where: { officerId: { in: scope.ids }, effectiveTo: null }, select: { dealerId: true }, distinct: ["dealerId"] });
    const ids = assigned.map((a) => a.dealerId);
    const owners = await getCurrentOwnerByDealer(ids);
    dealerFilter = { in: ids.filter((id) => scope.ids.includes(owners.get(id) ?? "")) };
  }
  const retailers = await prisma.retailer.findMany({
    where: dealerFilter ? { links: { some: { dealerId: dealerFilter } } } : {},
    include: { createdBy: { select: { name: true } }, links: { where: dealerFilter ? { dealerId: dealerFilter } : {}, include: { dealer: { select: { id: true, name: true } } } } },
    orderBy: { createdAt: "desc" }, take: 500,
  });
  const alias = await loadDealerAliasNameMap([...new Set(retailers.flatMap((r) => r.links.map((l) => l.dealerId)))]);
  return retailers.map((r) => ({ id: r.id, name: r.name, firmName: r.firmName, phone: r.phone, createdAt: r.createdAt.toISOString(), createdByName: r.createdBy.name, dealers: r.links.map((l) => ({ id: l.dealerId, name: alias.get(l.dealerId) ?? l.dealer.name })).sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Admin review list: pending (oldest first, to be worked) or resolved (newest decision first). */
export async function listRetailerRequestsForReview(ctx: AuthContext, view: "pending" | "resolved"): Promise<RetailerRequestDto[]> {
  assertReviewer(ctx);
  const rows = await prisma.retailerRequest.findMany({
    where: view === "pending" ? { status: "PENDING" } : { status: { in: ["APPROVED", "REJECTED"] } }, include: INCLUDE,
    orderBy: view === "pending" ? { createdAt: "asc" } : { decidedAt: "desc" }, take: 500,
  });
  return rows.map(toDto);
}

/**
 * Approve (retailer + dealer links, atomically) or reject (reason required). The FIRST decision resolves the request in one conditional update; a second / concurrent one matches nothing and is
 * refused, so no duplicate retailer or relationship can exist. At review time the requester must still be an active SO / RM and every selected dealer must still be currently assigned to them —
 * otherwise approval is refused with the conflicting dealers named (the request stays Pending; Admin may reject it). Nothing is merged with another retailer by name or phone.
 */
export async function decideRetailerRequest(ctx: AuthContext, id: string, raw: unknown): Promise<RetailerRequestDto> {
  assertReviewer(ctx);
  const input = (raw ?? {}) as Record<string, unknown>;
  const action = input.action === "approve" || input.action === "reject" ? input.action : null;
  if (!action) throw new ApiError(422, "Choose approve or reject.");
  const reason = cleanText(input.reason);
  if (action === "reject" && reason.length < 3) throw new ApiError(422, "Enter the reason for rejecting this request.");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "RetailerRequest" WHERE "id" = ${id} FOR UPDATE`);
    const request = await tx.retailerRequest.findUnique({ where: { id }, include: { dealers: true, requester: { select: { isActive: true, deletedAt: true, role: true } } } });
    if (!request) throw new ApiError(404, "Retailer request not found");
    if (request.status !== "PENDING") throw new ApiError(409, "This request has already been decided.");
    const actor = (await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? ctx.username ?? ctx.userId;
    if (action === "approve") {
      const owners = await getCurrentOwnerByDealer(request.dealers.map((d) => d.dealerId), tx);
      const lost = request.dealers.filter((d) => owners.get(d.dealerId) !== request.requesterId).map((d) => d.dealerName);
      if (!request.requester.isActive || request.requester.deletedAt || (request.requester.role !== Role.SALES_OFFICER && request.requester.role !== Role.REGIONAL_MANAGER)) throw new ApiError(409, "The requester is no longer an active SO or RM, so this request cannot be approved. Reject it instead.");
      if (lost.length > 0) throw new ApiError(409, `These dealers are no longer assigned to the requester: ${lost.join(", ")}. Reject the request or ask them to submit it again.`);
      const available = await tx.dealer.count({ where: { id: { in: request.dealers.map((d) => d.dealerId) }, deletedAt: null } });
      if (available !== request.dealers.length) throw new ApiError(409, "One or more linked dealers are no longer available. Reject the request or ask for a new submission.");
    }
    let retailerId: string | null = null;
    if (action === "approve") {
      const retailer = await tx.retailer.create({ data: { name: request.retailerName, firmName: request.firmName, phone: request.phone, createdById: request.requesterId, requestId: id, links: { create: request.dealers.map((d) => ({ dealerId: d.dealerId })) } }, select: { id: true } });
      retailerId = retailer.id;
    }
    // The row lock serializes decisions. The approved status and its required retailer link are written together.
    const claimed = await tx.retailerRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: action === "approve" ? "APPROVED" : "REJECTED", decidedById: ctx.userId, decidedByName: actor, decidedAt: new Date(), retailerId, rejectionReason: action === "reject" ? reason : null } });
    if (claimed.count !== 1) throw new ApiError(409, "This request has already been decided.");
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "retailerRequest", entityId: id, summary: `${action === "approve" ? "Approved" : "Rejected"} Retailer request "${request.retailerName}"${action === "reject" ? `: ${reason}` : ""}` }, tx);
    return toDto(await tx.retailerRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE }));
  });
}
