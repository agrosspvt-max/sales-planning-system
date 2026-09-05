import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { isDealerOwnerRole } from "@/lib/scope";
import { tightKey } from "@/lib/match-key";
import { writeAudit } from "@/lib/audit";
import { applyDealerAssignment } from "@/features/assignments/service.server";
import { addDealerToActiveSeasonalPlan } from "@/features/planning/monthly-plan.server";
import { DEALER_STATUSES, isActiveForStatus, type DealerStatus } from "@/lib/dealer-status";

/**
 * Dealer management (Admin). Reuses the existing Dealer / DealerAlias models. Deactivate & Delete
 * are soft (isActive / deletedAt) so historical plans and reports keep working; matching and all
 * planning selectors already gate on ACTIVE, so deactivated/deleted dealers disappear from them.
 */

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can manage dealers");
}
async function loadDealerOr404(id: string) {
  const d = await prisma.dealer.findUnique({ where: { id }, select: { id: true, name: true, isActive: true, status: true, deletedAt: true } });
  if (!d) throw new ApiError(404, "Dealer not found");
  return d as { id: string; name: string; isActive: boolean; status: string; deletedAt: Date | null };
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
  // 4-status approval lifecycle (Dealer Alias → Edit). Admin can freely set any status; isActive is
  // derived (only INACTIVE = isActive:false). Legacy `isActive` boolean still accepted for compatibility.
  status: z.enum(DEALER_STATUSES).optional(),
  isActive: z.boolean().optional(),
  addToSeasonalPlan: z.boolean().optional(), // add (never removes) to the officer's active seasonal plan
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
    // Owner may be an active Sales Officer OR the group's Regional Manager (RMs own their own dealers too).
    if (!officer || !isDealerOwnerRole(officer.role) || !officer.isActive) throw new ApiError(422, "The selected owner must be an active Sales Officer or Regional Manager");
    if (data.groupId && officer.groupId !== data.groupId) throw new ApiError(422, "The selected owner does not belong to the selected group");
  }
  // Resolve the requested status → the 4-way `status` wins; a legacy `isActive` boolean maps to
  // ACTIVE/INACTIVE. `isActive` is always derived from status (only INACTIVE = inactive).
  const nextStatus: DealerStatus | undefined =
    data.status ?? (data.isActive !== undefined ? (data.isActive ? "ACTIVE" : "INACTIVE") : undefined);
  const nextIsActive = nextStatus !== undefined ? isActiveForStatus(nextStatus) : undefined;
  // Effective status after this edit (what it will be, defaulting to the current stored status).
  const effectiveStatus = nextStatus ?? (dealer.status as DealerStatus);

  if (nextIsActive === true && dealer.deletedAt) throw new ApiError(409, "Deleted dealers cannot be reactivated");
  // Current owner — so an unchanged officer never opens a duplicate assignment range, and so an
  // "add to plan" without reassignment still knows whose active plan to target.
  const currentOwner = data.officerId || data.addToSeasonalPlan
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
        ...(nextStatus !== undefined ? { status: nextStatus, isActive: nextIsActive } : {}),
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
    // Optionally ADD to the selected officer's active seasonal plan — idempotent (never creates a
    // duplicate PlanDealer, never removes). Only adds when an active plan exists and the dealer stays active.
    // Only ACTIVE dealers are plan-eligible — never add a Pending/Inactive/Defaulter dealer to a plan.
    const targetOfficerId = data.officerId ?? currentOwner?.officerId;
    if (data.addToSeasonalPlan && effectiveStatus === "ACTIVE" && targetOfficerId) {
      await addDealerToActiveSeasonalPlan(tx, targetOfficerId, dealerId);
    }
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Edited dealer ${data.name}` });
  return { ok: true };
}

export async function deactivateDealer(ctx: AuthContext, dealerId: string) {
  assertAdmin(ctx);
  const d = await loadDealerOr404(dealerId);
  // status is the source of truth; INACTIVE ⇔ isActive:false.
  await prisma.dealer.update({ where: { id: dealerId }, data: { status: "INACTIVE", isActive: false } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Deactivated dealer ${d.name}` });
  return { ok: true };
}

export async function activateDealer(ctx: AuthContext, dealerId: string) {
  assertAdmin(ctx);
  const d = await loadDealerOr404(dealerId);
  if (d.deletedAt) throw new ApiError(409, "Deleted dealers cannot be reactivated");
  await prisma.dealer.update({ where: { id: dealerId }, data: { status: "ACTIVE", isActive: true } });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "dealer", entityId: dealerId, summary: `Activated dealer ${d.name}` });
  return { ok: true };
}

/** Soft delete — never hard delete; historical plans/reports keep referencing the row. */
export async function deleteDealer(ctx: AuthContext, dealerId: string) {
  assertAdmin(ctx);
  const d = await loadDealerOr404(dealerId);
  await prisma.dealer.update({ where: { id: dealerId }, data: { status: "INACTIVE", isActive: false, deletedAt: new Date() } });
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
