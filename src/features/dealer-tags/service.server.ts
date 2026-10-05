import "server-only";
import { actorDisplayName } from "@/features/accounts/identity";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { assertAdminPermission } from "@/features/accounts/permissions";

import { Prisma, Role, PlanStatus, ApprovalActionType, NotificationType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import {
  getOfficerScope,
  getCurrentOwnerByDealer,
  getCurrentManagerId,
  type ScopeReadClient,
} from "@/lib/scope";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { loadDealerMarkerMap } from "@/lib/dealer-tags.server";
import { taggedDealersFirst } from "@/lib/dealer-tags";
import { writeAudit } from "@/lib/audit";
import { notifyMany, getSuperAdminIds } from "@/features/notifications/service.server";

const tagSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    markerType: z.enum(["TEXT", "SYMBOL"]),
    marker: z.string().trim().min(1).max(32),
    isActive: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.markerType === "TEXT" && !/^[\p{L}\p{N}]{1,8}$/u.test(v.marker))
      ctx.addIssue({
        code: "custom",
        path: ["marker"],
        message: "Use 1–8 letters or numbers for a text marker.",
      });
    if (
      v.markerType === "SYMBOL" &&
      (!/[\p{S}\p{P}]/u.test(v.marker) ||
        /[\p{L}\p{N}\s]/u.test(v.marker.replace(/[0-9#*]\uFE0F?\u20E3/gu, "")))
    )
      ctx.addIssue({
        code: "custom",
        path: ["marker"],
        message: "Use a symbol or emoji for a symbol marker.",
      });
  });
const pairSchema = z
  .object({
    dealerId: z.string().min(1),
    tagId: z.string().min(1),
    operation: z.enum(["ADD", "REVOKE"]),
  })
  .strict();
const decisionSchema = z
  .object({ action: z.enum(["approve", "reject"]), remarks: z.string().trim().max(500).optional() })
  .strict();
const pending = [PlanStatus.PENDING_RM, PlanStatus.PENDING_ADMIN];
const admin = (ctx: AuthContext) => {
  if (!isAdministrativeRole(ctx.role))
    throw new ApiError(403, "Only Super Admin can manage tags or directly assign/revoke them.");
};

async function assertDealerScope(ctx: AuthContext, dealerId: string, db?: ScopeReadClient) {
  const scope = await getOfficerScope(ctx, db);
  if (scope.all) return;
  const owner = (await getCurrentOwnerByDealer([dealerId], db)).get(dealerId);
  if (!owner || !scope.ids.includes(owner))
    throw new ApiError(403, "This dealer is outside your current authorized scope.");
}
async function lockPair(tx: Prisma.TransactionClient, dealerId: string, tagId: string) {
  // Same lock order for every request/approval/direct action. No ownership rows are changed.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Dealer" WHERE "id" = ${dealerId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DealerTag" WHERE "id" = ${tagId} FOR UPDATE`);
  const [dealer, tag, assignment] = await Promise.all([
    tx.dealer.findUnique({ where: { id: dealerId } }),
    tx.dealerTag.findUnique({ where: { id: tagId } }),
    tx.dealerTagAssignment.findUnique({ where: { dealerId_tagId: { dealerId, tagId } } }),
  ]);
  if (!dealer || dealer.deletedAt) throw new ApiError(404, "Dealer not found.");
  if (!tag) throw new ApiError(404, "Tag not found.");
  return { tag, assignment };
}
async function applyAssignment(
  tx: Prisma.TransactionClient,
  dealerId: string,
  tagId: string,
  operation: "ADD" | "REVOKE",
  active: boolean,
) {
  if (active === (operation === "ADD")) return null; // Retry has no duplicate assignment or side effect.
  const assignment = await tx.dealerTagAssignment.upsert({
    where: { dealerId_tagId: { dealerId, tagId } },
    create: { dealerId, tagId, isActive: operation === "ADD" },
    update: { isActive: operation === "ADD" },
  });
  return assignment;
}
async function audit(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  action: "CREATE" | "UPDATE" | "DEACTIVATE" | "REACTIVATE",
  entity: string,
  entityId: string,
  details: object,
) {
  await writeAudit(
    { userId: ctx.userId, action, entity, entityId, summary: JSON.stringify(details) },
    tx,
  );
}
async function notify(
  tx: Prisma.TransactionClient,
  ids: string[],
  requestId: string,
  title: string,
) {
  await notifyMany(
    ids,
    {
      type: NotificationType.SYSTEM,
      title,
      message: title,
      relatedEntityType: "DealerTagRequest",
      relatedEntityId: requestId,
    },
    tx,
  );
}
export async function listTags() {
  return prisma.dealerTag.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] });
}
export async function saveTag(ctx: AuthContext, raw: unknown, id?: string) {
  admin(ctx);
  const value = tagSchema.parse(raw);
  const data = { ...value, nameKey: value.name.normalize("NFKC").toLocaleLowerCase("en-IN") };
  return prisma.$transaction(
    async (tx) => {
      if (id) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DealerTag" WHERE "id" = ${id} FOR UPDATE`);
        const old = await tx.dealerTag.findUnique({ where: { id } });
        if (!old) throw new ApiError(404, "Tag not found.");
        const row = await tx.dealerTag.update({ where: { id }, data });
        await audit(
          tx,
          ctx,
          old.isActive !== row.isActive ? (row.isActive ? "REACTIVATE" : "DEACTIVATE") : "UPDATE",
          "dealerTag",
          row.id,
          { before: old, after: row },
        );
        return row;
      }
      const row = await tx.dealerTag.create({ data });
      await audit(tx, ctx, "CREATE", "dealerTag", row.id, { tag: row });
      return row;
    },
    { timeout: 15000 },
  );
}
/** The dealers the caller may see (existing scope rules) plus each one's CURRENT owner (open DealerAssignment). */
async function scopedTagDealers(ctx: AuthContext) {
  const scope = await getOfficerScope(ctx);
  const dealers = await prisma.dealer.findMany({
    where: {
      deletedAt: null,
      ...(scope.all
        ? {}
        : { assignments: { some: { officerId: { in: scope.ids }, effectiveTo: null } } }),
    },
    select: { id: true, name: true, isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const owners = await getCurrentOwnerByDealer(dealers.map((d) => d.id));
  const allowed = dealers.filter((d) => scope.all || scope.ids.includes(owners.get(d.id) ?? ""));
  return { scope, allowed, owners };
}
async function officerNames(ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}
/**
 * Dealers for the Dealer Tags page. Optional `officerIds` narrows to dealers whose CURRENT owner is any one of the
 * given officers (OR). The filter is applied only AFTER the caller's scope, so an id outside the caller's scope can
 * never widen the result — it simply matches nothing.
 */
export async function listTagDealers(ctx: AuthContext, filter: { officerIds?: string[] } = {}) {
  const { allowed: scoped, owners } = await scopedTagDealers(ctx);
  const wanted = filter.officerIds?.length ? new Set(filter.officerIds) : null;
  const allowed = wanted ? scoped.filter((d) => wanted.has(owners.get(d.id) ?? "")) : scoped;
  const [aliases, tags, names] = await Promise.all([
    loadDealerAliasNameMap(allowed.map((d) => d.id)),
    loadDealerMarkerMap(allowed.map((d) => d.id)),
    officerNames([...new Set(allowed.map((d) => owners.get(d.id)).filter((id): id is string => !!id))]),
  ]);
  const assignments = await prisma.dealerTagAssignment.findMany({
    where: { dealerId: { in: allowed.map((d) => d.id) }, isActive: true },
    include: { tag: true },
    orderBy: { tag: { name: "asc" } },
  });
  const byDealer = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const group = byDealer.get(a.dealerId) ?? [];
    group.push(a);
    byDealer.set(a.dealerId, group);
  }
  const rows = allowed
    .map((d) => {
      const ownerId = owners.get(d.id);
      return {
        ...d,
        name: aliases.get(d.id) ?? d.name,
        tags: tags[d.id] ?? [],
        assignedTags: (byDealer.get(d.id) ?? []).map((a) => a.tag),
        // Current owner per the existing DealerAssignment model (a list so the UI never assumes a single owner).
        salesOfficers: ownerId ? [{ id: ownerId, name: names.get(ownerId) ?? "—" }] : [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return taggedDealersFirst(rows, (d) => d.id, tags);
}
/** Filter options: only the owners of dealers the caller can already see (so an RM only ever gets their own scope). */
export async function listTagSalesOfficers(ctx: AuthContext) {
  const { allowed, owners } = await scopedTagDealers(ctx);
  const ids = [...new Set(allowed.map((d) => owners.get(d.id)).filter((id): id is string => !!id))];
  const names = await officerNames(ids);
  return ids
    .map((id) => ({ id, name: names.get(id) ?? "—" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export async function requestTag(ctx: AuthContext, raw: unknown) {
  if (isAdministrativeRole(ctx.role))
    throw new ApiError(403, "Use the separate Admin direct action.");
  const pair = pairSchema.parse(raw);
  await assertDealerScope(ctx, pair.dealerId);
  const admins = await getSuperAdminIds();
  return prisma.$transaction(
    async (tx) => {
      const { tag, assignment } = await lockPair(tx, pair.dealerId, pair.tagId);
      await assertDealerScope(ctx, pair.dealerId, tx);
      const managerId =
        ctx.role === Role.SALES_OFFICER ? await getCurrentManagerId(ctx.userId, tx) : null;
      const recipients = managerId ? [managerId] : admins;
      if (pair.operation === "ADD" && !tag.isActive)
        throw new ApiError(422, "Inactive tags cannot be assigned.");
      if (!!assignment?.isActive === (pair.operation === "ADD"))
        throw new ApiError(
          409,
          pair.operation === "ADD" ? "This tag is already assigned." : "This tag is not assigned.",
        );
      if (
        await tx.dealerTagRequest.findFirst({
          where: { dealerId: pair.dealerId, tagId: pair.tagId, status: { in: pending } },
        })
      )
        throw new ApiError(409, "A request for this dealer/tag is already awaiting approval.");
      const row = await tx.dealerTagRequest.create({
        data: {
          ...pair,
          requestedById: ctx.userId,
          status: managerId ? PlanStatus.PENDING_RM : PlanStatus.PENDING_ADMIN,
        },
      });
      const approval = await tx.approvalAction.create({
        data: {
          dealerTagRequestId: row.id,
          actorId: ctx.userId, ...(ctx.designation ? { actorDesignation: ctx.designation } : {}),
          action: ApprovalActionType.SUBMIT,
          toStatus: row.status,
        },
      });
      await audit(tx, ctx, "CREATE", "dealerTagRequest", row.id, {
        ...pair,
        status: row.status,
        managerId,
        approvalActionId: approval.id,
      });
      await notify(
        tx,
        recipients,
        row.id,
        `Dealer tag ${pair.operation === "ADD" ? "addition" : "revocation"} awaiting approval`,
      );
      return row;
    },
    { timeout: 15000 },
  );
}
export async function directTag(ctx: AuthContext, raw: unknown) {
  admin(ctx);
  const pair = pairSchema.parse(raw);
  assertAdminPermission(ctx, "dealerTags", pair.operation === "ADD" ? "assign" : "revoke");
  return prisma.$transaction(
    async (tx) => {
      const { tag, assignment } = await lockPair(tx, pair.dealerId, pair.tagId);
      if (pair.operation === "ADD" && !tag.isActive)
        throw new ApiError(422, "Inactive tags cannot be assigned.");
      const changedAssignment = await applyAssignment(
        tx,
        pair.dealerId,
        pair.tagId,
        pair.operation,
        !!assignment?.isActive,
      );
      if (changedAssignment)
        await audit(tx, ctx, "UPDATE", "dealerTagAssignment", changedAssignment.id, {
          ...pair,
          direct: true,
        });
      return { changed: !!changedAssignment };
    },
    { timeout: 15000 },
  );
}
export async function decideTagRequest(ctx: AuthContext, id: string, raw: unknown) {
  const { action, remarks } = decisionSchema.parse(raw);
  assertAdminPermission(ctx, "dealerTags", action);
  if (action === "reject" && !remarks)
    throw new ApiError(422, "A reason is required to reject a tag request.");
  if (ctx.role === Role.SALES_OFFICER)
    throw new ApiError(403, "Only the applicable RM or Super Admin can decide requests.");
  const initial = await prisma.dealerTagRequest.findUnique({ where: { id } });
  if (!initial) throw new ApiError(404, "Tag request not found.");
  const admins = await getSuperAdminIds();
  return prisma.$transaction(
    async (tx) => {
      const { tag, assignment } = await lockPair(tx, initial.dealerId, initial.tagId);
      const row = await tx.dealerTagRequest.findUniqueOrThrow({ where: { id } });
      if (!pending.includes(row.status as (typeof pending)[number]))
        throw new ApiError(409, "This request has already been decided.");
      if (row.status === PlanStatus.PENDING_RM) {
        const managerId = await getCurrentManagerId(row.requestedById, tx);
        if (
          ctx.role !== Role.REGIONAL_MANAGER ||
          ctx.userId !== managerId ||
          ctx.userId === row.requestedById
        )
          throw new ApiError(
            403,
            "The applicable RM must review this request before Admin final approval.",
          );
      } else if (!isAdministrativeRole(ctx.role))
        throw new ApiError(403, "Only Super Admin can perform final approval.");
      await assertDealerScope(ctx, row.dealerId, tx);
      if (action === "approve" && row.operation === "ADD" && !tag.isActive)
        throw new ApiError(
          422,
          "Inactive tags cannot be assigned. Reactivate the tag or reject the request.",
        );
      const next =
        action === "reject"
          ? PlanStatus.REJECTED
          : row.status === PlanStatus.PENDING_RM
            ? PlanStatus.PENDING_ADMIN
            : PlanStatus.APPROVED;
      if (next === PlanStatus.APPROVED)
        await applyAssignment(
          tx,
          row.dealerId,
          row.tagId,
          row.operation as "ADD" | "REVOKE",
          !!assignment?.isActive,
        );
      await tx.dealerTagRequest.update({ where: { id }, data: { status: next } });
      const approval = await tx.approvalAction.create({
        data: {
          dealerTagRequestId: id,
          actorId: ctx.userId, ...(ctx.designation ? { actorDesignation: ctx.designation } : {}),
          action: action === "approve" ? ApprovalActionType.APPROVE : ApprovalActionType.REJECT,
          fromStatus: row.status,
          toStatus: next,
          remarks,
        },
      });
      await audit(tx, ctx, "UPDATE", "dealerTagRequest", id, {
        dealerId: row.dealerId,
        tagId: row.tagId,
        operation: row.operation,
        action,
        approvalActionId: approval.id,
        fromStatus: row.status,
        toStatus: next,
        remarks,
      });
      await notify(
        tx,
        next === PlanStatus.PENDING_ADMIN ? admins : [row.requestedById],
        id,
        next === PlanStatus.PENDING_ADMIN
          ? "Dealer tag request awaiting Admin final approval"
          : `Dealer tag request ${next.toLowerCase()}`,
      );
      return { status: next };
    },
    { timeout: 15000 },
  );
}
export async function listTagRequests(ctx: AuthContext) {
  const scope = await getOfficerScope(ctx);
  const rows = await prisma.dealerTagRequest.findMany({
    where: scope.all ? {} : { requestedById: { in: scope.ids } },
    include: {
      dealer: { select: { name: true } },
      tag: true,
      requestedBy: { select: { name: true } },
      actions: { include: { actor: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const aliases = await loadDealerAliasNameMap(rows.map((r) => r.dealerId));
  // All non-self requesters in an RM scope are SOs in that same group. Resolve the applicable
  // manager once, rather than suggesting actions to every RM or querying once per request.
  const rmCandidate =
    ctx.role === Role.REGIONAL_MANAGER
      ? rows.find((r) => r.requestedById !== ctx.userId && r.status === PlanStatus.PENDING_RM)
      : undefined;
  const applicableManager = rmCandidate
    ? await getCurrentManagerId(rmCandidate.requestedById)
    : null;
  return rows.map((r) => ({
    id: r.id,
    dealerId: r.dealerId,
    dealerName: aliases.get(r.dealerId) ?? r.dealer.name,
    tagId: r.tagId,
    tagName: r.tag.name,
    marker: r.tag.marker,
    operation: r.operation,
    status: r.status,
    requestedById: r.requestedById,
    requestedByName: r.requestedBy.name,
    createdAt: r.createdAt.toISOString(),
    canAct:
      isAdministrativeRole(ctx.role)
        ? r.status === PlanStatus.PENDING_ADMIN
        : ctx.role === Role.REGIONAL_MANAGER &&
          ctx.userId === applicableManager &&
          r.requestedById !== ctx.userId &&
          r.status === PlanStatus.PENDING_RM,
    history: r.actions.map((a) => ({
      action: a.action,
      actorName: actorDisplayName(a.actor.name, a.actorDesignation),
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      remarks: a.remarks,
      createdAt: a.createdAt.toISOString(),
    })),
  }));
}
