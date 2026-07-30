import "server-only";
import { prisma } from "@/lib/prisma";
import { buildPage, type PageParams, type Paginated } from "@/lib/pagination";

export interface AuditFilters {
  userId?: string;
  entity?: string;
  action?: string;
  from?: string;
  to?: string;
}

export async function listAudit(
  filters: AuditFilters,
  page: PageParams,
): Promise<Paginated<unknown>> {
  const where: Record<string, unknown> = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.entity) where.entity = filters.entity;
  if (filters.action) where.action = filters.action;
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: new Date(filters.from) } : {}),
      ...(filters.to ? { lte: new Date(filters.to) } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  const items = rows.map((r) => ({
    id: r.id,
    userName: r.user.name,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    summary: r.summary,
    createdAt: r.createdAt,
  }));
  return buildPage(items, total, page);
}

/** Distinct entities & actions, for the filter dropdowns. */
export async function getAuditFilterOptions() {
  const [entities, actions, users] = await Promise.all([
    prisma.auditLog.findMany({ distinct: ["entity"], select: { entity: true }, orderBy: { entity: "asc" } }),
    prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
    prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return {
    entities: entities.map((e) => e.entity),
    actions: actions.map((a) => a.action),
    users: users.map((u) => ({ id: u.id, name: u.name })),
  };
}
