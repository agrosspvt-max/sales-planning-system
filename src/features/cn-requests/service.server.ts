import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";

/**
 * CN (Credit Note) Requests. A Sales Officer raises a request for one of their assigned dealers; an RM
 * accepts/rejects team requests (never approves); the Super Admin approves/rejects with final authority
 * (no RM acceptance required). Status flow: SUBMITTED → ACCEPTED → APPROVED; SUBMITTED → REJECTED.
 */
export const CN_TYPES = ["CD", "FRAT", "Scheme"] as const;
export const CN_PAYMENT_STATUSES = ["Bill unpaid", "Bill Paid"] as const;

const createSchema = z.object({
  dealerId: z.string().min(1, "Select a party"),
  cnType: z.enum(CN_TYPES),
  amount: z.coerce.number().min(0).optional(),
  paymentStatus: z.enum(CN_PAYMENT_STATUSES),
  // When an RM raises on behalf of a team member, the target Sales Officer. Omitted / self = "My Dealer".
  officerId: z.string().optional(),
  details: z.string().max(1000).optional(),
});
const actSchema = z.object({ action: z.enum(["accept", "reject", "approve"]), remarks: z.string().max(500).optional() });

function num(d: unknown): number | null {
  return d == null ? null : Number(d.toString());
}

export interface CnRequestRow {
  id: string;
  dealerId: string;
  partyName: string;
  cnType: string;
  amount: number | null;
  paymentStatus: string;
  officerId: string;
  employeeName: string;
  state: string | null;
  territory: string | null;
  status: string;
  details: string | null;
  remarks: string | null;
  createdAt: string;
}

type RawRow = {
  id: string; dealerId: string; cnType: string; amount: unknown; paymentStatus: string; officerId: string; status: string; details: string | null; remarks: string | null; createdAt: Date;
  dealer: { name: string };
  officer: { name: string; territory: string | null; group: { name: string } | null };
};
function toRow(r: RawRow): CnRequestRow {
  return {
    id: r.id,
    dealerId: r.dealerId,
    partyName: r.dealer.name,
    cnType: r.cnType,
    amount: num(r.amount),
    paymentStatus: r.paymentStatus,
    officerId: r.officerId,
    employeeName: r.officer.name,
    state: r.officer.group?.name ?? null,
    territory: r.officer.territory ?? null,
    status: r.status,
    details: r.details ?? null,
    remarks: r.remarks,
    createdAt: r.createdAt.toISOString(),
  };
}
const INCLUDE = { dealer: { select: { name: true } }, officer: { select: { name: true, territory: true, group: { select: { name: true } } } } } as const;

/**
 * A Sales Officer or Regional Manager raises a CN Request. The SO always raises for themselves; an RM may
 * raise for themselves ("My Dealer") OR on behalf of a Sales Officer on their team ("Team"). The chosen
 * Party (dealer) must be assigned to the TARGET officer.
 */
export async function createCnRequest(ctx: AuthContext, raw: unknown): Promise<{ id: string }> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Sales Officer or Regional Manager can raise a CN Request");
  const data = createSchema.parse(raw);

  // Resolve the target officer the request is raised FOR.
  let targetOfficerId = ctx.userId;
  if (data.officerId && data.officerId !== ctx.userId) {
    if (ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "Only a Regional Manager can raise a request for a team member");
    const scope = await getOfficerScope(ctx);
    if (!scope.ids.includes(data.officerId)) throw new ApiError(403, "That Sales Officer is not on your team");
    targetOfficerId = data.officerId;
  }

  const assigned = await prisma.dealerAssignment.findFirst({ where: { officerId: targetOfficerId, dealerId: data.dealerId, effectiveTo: null }, select: { id: true } });
  if (!assigned) throw new ApiError(422, "That party is not assigned to the selected Sales Officer");

  const created = (await prisma.cnRequest.create({
    data: { officerId: targetOfficerId, dealerId: data.dealerId, cnType: data.cnType, amount: data.amount ?? null, paymentStatus: data.paymentStatus, details: data.details?.trim() || null, status: "SUBMITTED" },
    select: { id: true },
  })) as { id: string };
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "cnRequest", entityId: created.id, summary: `CN Request (${data.cnType}) raised${targetOfficerId !== ctx.userId ? " for a team member" : ""}` });
  return { id: created.id };
}

/**
 * Assigned dealers for the Party dropdown. Without `officerId` → the caller's own (SO or RM). With
 * `officerId` → that officer's dealers, allowed only when an RM requests one of THEIR team's Sales
 * Officers (RM "Team" flow). Admins get none.
 */
export async function myAssignedDealers(ctx: AuthContext, officerId?: string): Promise<{ id: string; name: string }[]> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) return [];
  let targetOfficerId = ctx.userId;
  if (officerId && officerId !== ctx.userId) {
    if (ctx.role !== Role.REGIONAL_MANAGER) return [];
    const scope = await getOfficerScope(ctx);
    if (!scope.ids.includes(officerId)) return []; // not on the RM's team
    targetOfficerId = officerId;
  }
  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId: targetOfficerId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const ids = assignments.map((a) => a.dealerId);
  if (ids.length === 0) return [];
  const dealers = (await prisma.dealer.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } })) as { id: string; name: string }[];
  return dealers;
}

/**
 * The Sales Officers on a Regional Manager's team (for the "Team" request flow's officer dropdown).
 * RM only — the RM's own group Sales Officers, excluding the RM. Others get none.
 */
export async function myTeamOfficers(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  if (ctx.role !== Role.REGIONAL_MANAGER || !ctx.groupId) return [];
  const officers = (await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, groupId: ctx.groupId, isActive: true, deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })) as { id: string; name: string }[];
  return officers;
}

/** Scoped list: SO → own; RM → their team (own + group officers); Admin → all. Newest first. */
export async function listCnRequests(ctx: AuthContext): Promise<CnRequestRow[]> {
  const scope = await getOfficerScope(ctx);
  const rows = (await prisma.cnRequest.findMany({
    where: scope.all ? {} : { officerId: { in: scope.ids } },
    include: INCLUDE,
    orderBy: { createdAt: "desc" },
  })) as unknown as RawRow[];
  return rows.map(toRow);
}

export async function getCnRequest(ctx: AuthContext, id: string): Promise<CnRequestRow> {
  const r = (await prisma.cnRequest.findUnique({ where: { id }, include: INCLUDE })) as unknown as RawRow | null;
  if (!r) throw new ApiError(404, "CN Request not found");
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(r.officerId)) throw new ApiError(403, "You cannot view this CN Request");
  return toRow(r);
}

/**
 * Act on a request. RM: accept/reject a team SUBMITTED request (never approve). Admin: approve (from
 * SUBMITTED or ACCEPTED) or reject — no RM acceptance required.
 */
export async function actOnCnRequest(ctx: AuthContext, id: string, raw: unknown): Promise<{ status: string }> {
  const { action, remarks } = actSchema.parse(raw);
  const r = (await prisma.cnRequest.findUnique({ where: { id }, select: { id: true, officerId: true, status: true } })) as { id: string; officerId: string; status: string } | null;
  if (!r) throw new ApiError(404, "CN Request not found");

  if (ctx.role === Role.REGIONAL_MANAGER) {
    // An RM may also raise requests, but cannot act on their OWN — only on a team member's.
    if (r.officerId === ctx.userId) throw new ApiError(403, "You cannot accept or reject your own CN Request");
    const scope = await getOfficerScope(ctx);
    if (!scope.ids.includes(r.officerId)) throw new ApiError(403, "This CN Request is not from your team");
    if (action === "approve") throw new ApiError(403, "Only the Super Admin can approve a CN Request");
    if (r.status !== "SUBMITTED") throw new ApiError(409, "Only a submitted CN Request can be accepted or rejected");
    const next = action === "accept" ? "ACCEPTED" : "REJECTED";
    await prisma.cnRequest.update({ where: { id }, data: { status: next, actedByRmId: ctx.userId, remarks: action === "reject" ? remarks?.trim() || null : null } });
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnRequest", entityId: id, summary: `CN Request ${action === "accept" ? "accepted" : "rejected"} by RM` });
    return { status: next };
  }

  if (ctx.role === Role.SUPER_ADMIN) {
    if (action === "accept") throw new ApiError(422, "The Super Admin approves or rejects (there is no accept step)");
    if (!(r.status === "SUBMITTED" || r.status === "ACCEPTED")) throw new ApiError(409, "This CN Request is not awaiting a decision");
    const next = action === "approve" ? "APPROVED" : "REJECTED";
    await prisma.cnRequest.update({ where: { id }, data: { status: next, actedByAdminId: ctx.userId, remarks: action === "reject" ? remarks?.trim() || null : null } });
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnRequest", entityId: id, summary: `CN Request ${action === "approve" ? "approved" : "rejected"} by Super Admin` });
    return { status: next };
  }

  throw new ApiError(403, "You cannot act on this CN Request");
}
