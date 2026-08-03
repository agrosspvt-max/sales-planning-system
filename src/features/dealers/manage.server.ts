import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { tightKey } from "@/lib/match-key";
import { writeAudit } from "@/lib/audit";

/**
 * Dealer management (Admin). Reuses the existing Dealer / DealerAlias models. Deactivate & Delete
 * are soft (isActive / deletedAt) so historical plans and reports keep working; matching and all
 * planning selectors already gate on ACTIVE, so deactivated/deleted dealers disappear from them.
 */

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can manage dealers");
}
async function loadDealerOr404(id: string) {
  const d = await prisma.dealer.findUnique({ where: { id }, select: { id: true, name: true, isActive: true, deletedAt: true } });
  if (!d) throw new ApiError(404, "Dealer not found");
  return d as { id: string; name: string; isActive: boolean; deletedAt: Date | null };
}

const editSchema = z.object({
  name: z.string().min(1).max(200),
  mobile: z.string().max(20).optional(),
  village: z.string().max(120).optional(),
  tehsil: z.string().max(120).optional(),
  district: z.string().max(120).optional(),
  address: z.string().max(400).optional(),
  alias: z.string().max(200).optional(), // optional Tally alias to add for this dealer
});

/** Edit all dealer info (reuses the same fields as the Create Dealer dialog) + optional alias. */
export async function editDealer(ctx: AuthContext, dealerId: string, raw: unknown) {
  assertAdmin(ctx);
  const data = editSchema.parse(raw);
  await loadDealerOr404(dealerId);
  await prisma.dealer.update({
    where: { id: dealerId },
    data: {
      name: data.name.trim(),
      mobile: data.mobile?.trim() || null,
      village: data.village?.trim() || null,
      tehsil: data.tehsil?.trim() || null,
      district: data.district?.trim() || null,
      address: data.address?.trim() || null,
    },
  });
  const aliasName = data.alias?.trim();
  if (aliasName) {
    const key = tightKey(aliasName);
    if (key) {
      const existing = await prisma.dealerAlias.findUnique({ where: { tallyKey: key }, select: { id: true } });
      if (!existing) await prisma.dealerAlias.create({ data: { systemDealerId: dealerId, tallyName: aliasName, tallyKey: key } });
    }
  }
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Edited dealer ${data.name}` });
  return { ok: true };
}

export async function deactivateDealer(ctx: AuthContext, dealerId: string) {
  assertAdmin(ctx);
  const d = await loadDealerOr404(dealerId);
  await prisma.dealer.update({ where: { id: dealerId }, data: { isActive: false } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Deactivated dealer ${d.name}` });
  return { ok: true };
}

export async function activateDealer(ctx: AuthContext, dealerId: string) {
  assertAdmin(ctx);
  const d = await loadDealerOr404(dealerId);
  if (d.deletedAt) throw new ApiError(409, "Deleted dealers cannot be reactivated");
  await prisma.dealer.update({ where: { id: dealerId }, data: { isActive: true } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Activated dealer ${d.name}` });
  return { ok: true };
}

/** Soft delete — never hard delete; historical plans/reports keep referencing the row. */
export async function deleteDealer(ctx: AuthContext, dealerId: string) {
  assertAdmin(ctx);
  const d = await loadDealerOr404(dealerId);
  await prisma.dealer.update({ where: { id: dealerId }, data: { isActive: false, deletedAt: new Date() } });
  await writeAudit({ userId: ctx.userId, action: "DELETE", entity: "dealer", entityId: dealerId, summary: `Soft-deleted dealer ${d.name}` });
  return { ok: true };
}

export type DealerFilter = "active" | "inactive" | "deleted" | "all";

/** Dealers CURRENTLY assigned to an officer, for the profile dealer list. Server-side filtered. */
export async function listOfficerDealers(ctx: AuthContext, officerId: string, filter: DealerFilter = "active") {
  assertAdmin(ctx);
  const assignments = (await prisma.dealerAssignment.findMany({
    where: { officerId, effectiveTo: null },
    select: { dealerId: true },
  })) as { dealerId: string }[];
  const ids = assignments.map((a) => a.dealerId);
  if (ids.length === 0) return [];

  const where: Record<string, unknown> = { id: { in: ids } };
  if (filter === "active") Object.assign(where, { isActive: true, deletedAt: null });
  else if (filter === "inactive") Object.assign(where, { isActive: false, deletedAt: null });
  else if (filter === "deleted") Object.assign(where, { deletedAt: { not: null } });

  const dealers = (await prisma.dealer.findMany({
    where,
    orderBy: { name: "asc" },
    select: { id: true, name: true, mobile: true, village: true, tehsil: true, district: true, address: true, isActive: true, deletedAt: true, status: true },
  })) as {
    id: string; name: string; mobile: string | null; village: string | null; tehsil: string | null;
    district: string | null; address: string | null; isActive: boolean; deletedAt: Date | null; status: string;
  }[];
  return dealers.map((d) => ({ ...d, deleted: !!d.deletedAt }));
}
