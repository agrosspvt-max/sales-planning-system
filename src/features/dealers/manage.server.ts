import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { tightKey } from "@/lib/match-key";
import { writeAudit } from "@/lib/audit";
import { applyDealerAssignment } from "@/features/assignments/service.server";

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
  town: z.string().max(120).optional(), // "Territory"
  alias: z.string().max(200).optional(), // optional Tally alias to ADD for this dealer
  // Optional edit-mode extras (Dealer Alias page). Absent → unchanged (backward-compatible).
  officerId: z.string().optional(), // reassign the owning Sales Officer
  groupId: z.string().optional(), // validate the officer belongs to this group
  isActive: z.boolean().optional(), // Active / Inactive status
});

/**
 * Edit all dealer info (SAME service the Dealers module uses) + optional alias, plus — for the Dealer
 * Alias page — Territory, Sales-Officer reassignment (reuses `applyDealerAssignment`, so it PRESERVES all
 * existing planning: no PlanDealer is recreated or removed), and Active/Inactive status. One edit flow.
 */
export async function editDealer(ctx: AuthContext, dealerId: string, raw: unknown) {
  assertAdmin(ctx);
  const data = editSchema.parse(raw);
  const dealer = await loadDealerOr404(dealerId);

  // Validate a reassignment target up front (active Sales Officer, and — if a group was supplied — in it).
  if (data.officerId) {
    const officer = await prisma.user.findUnique({ where: { id: data.officerId }, select: { role: true, isActive: true, groupId: true } });
    if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive) throw new ApiError(422, "The selected Sales Officer is missing or inactive");
    if (data.groupId && officer.groupId !== data.groupId) throw new ApiError(422, "The selected Sales Officer does not belong to the selected group");
  }
  if (data.isActive === true && dealer.deletedAt) throw new ApiError(409, "Deleted dealers cannot be reactivated");
  // Current owner — so an unchanged officer never opens a duplicate assignment range.
  const currentOwner = data.officerId
    ? ((await prisma.dealerAssignment.findFirst({ where: { dealerId, effectiveTo: null }, select: { officerId: true } })) as { officerId: string } | null)
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.dealer.update({
      where: { id: dealerId },
      data: {
        name: data.name.trim(),
        mobile: data.mobile?.trim() || null,
        village: data.village?.trim() || null,
        tehsil: data.tehsil?.trim() || null,
        district: data.district?.trim() || null,
        address: data.address?.trim() || null,
        town: data.town?.trim() || null,
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
    // Reassign the owning officer ONLY when it actually changes — reuses the time-aware assignment
    // primitive (close current range + open new). Planning is intentionally left untouched.
    if (data.officerId && currentOwner?.officerId !== data.officerId) {
      await applyDealerAssignment(tx, dealerId, data.officerId, new Date());
    }
    // Optionally ADD a Tally alias (unchanged behaviour). Alias removal is a separate action.
    const aliasName = data.alias?.trim();
    if (aliasName) {
      const key = tightKey(aliasName);
      if (key) {
        const existing = await tx.dealerAlias.findUnique({ where: { tallyKey: key }, select: { id: true } });
        if (!existing) await tx.dealerAlias.create({ data: { systemDealerId: dealerId, tallyName: aliasName, tallyKey: key } });
      }
    }
  });
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
