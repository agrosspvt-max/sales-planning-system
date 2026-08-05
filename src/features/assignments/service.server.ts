import "server-only";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  dealerAssignmentSchema,
  rmAssignmentSchema,
} from "@/lib/validations/assignments";
import { ApiError } from "@/lib/http";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/**
 * Apply a dealer→officer assignment inside an existing transaction: close the
 * current open range and open a new one. Shared by the assignment API and the
 * import wizard so the time-aware logic is never duplicated.
 */
export async function applyDealerAssignment(
  tx: Tx,
  dealerId: string,
  officerId: string,
  effectiveFrom: Date,
): Promise<void> {
  await tx.dealerAssignment.updateMany({
    where: { dealerId, effectiveTo: null },
    data: { effectiveTo: effectiveFrom },
  });
  await tx.dealerAssignment.create({ data: { dealerId, officerId, effectiveFrom } });
}

/**
 * Onboard a brand-new dealer inside an existing transaction: create an ACTIVE Dealer Master record
 * (client-supplied id) and assign it to the officer. The ONE place importers create+assign a new
 * dealer (Seasonal Import + the Seasonal→Recovery flow), so the create/assign pair is never duplicated.
 */
export async function createAndAssignDealer(
  tx: Tx,
  args: { id: string; name: string; officerId: string; createdByUserId: string; effectiveFrom: Date; createdFrom?: string },
): Promise<void> {
  await tx.dealer.create({
    data: { id: args.id, name: args.name, status: "ACTIVE", isActive: true, createdByUserId: args.createdByUserId, createdFrom: args.createdFrom ?? "SEASONAL_IMPORT" },
  });
  await applyDealerAssignment(tx, args.id, args.officerId, args.effectiveFrom);
}

/** Apply an officer→RM assignment inside an existing transaction (close + open). */
export async function applyRmAssignment(
  tx: Tx,
  officerId: string,
  managerId: string,
  effectiveFrom: Date,
): Promise<void> {
  await tx.rmAssignment.updateMany({
    where: { officerId, effectiveTo: null },
    data: { effectiveTo: effectiveFrom },
  });
  await tx.rmAssignment.create({ data: { officerId, managerId, effectiveFrom } });
}

/* ---------------------------- Dealer → Officer ---------------------------- */

export async function listCurrentDealerAssignments(search: string) {
  const rows = await prisma.dealerAssignment.findMany({
    where: {
      effectiveTo: null,
      dealer: search ? { name: { contains: search, mode: "insensitive" } } : undefined,
    },
    include: { dealer: true, officer: { select: { id: true, name: true, username: true } } },
    orderBy: { dealer: { name: "asc" } },
  });
  return rows.map((r) => ({
    id: r.id,
    dealerId: r.dealerId,
    dealerName: r.dealer.name,
    officerId: r.officerId,
    officerName: r.officer.name,
    effectiveFrom: r.effectiveFrom,
  }));
}

export async function getDealerAssignmentHistory(dealerId: string) {
  const rows = await prisma.dealerAssignment.findMany({
    where: { dealerId },
    include: { officer: { select: { name: true } } },
    orderBy: { effectiveFrom: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    officerName: r.officer.name,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
}

export async function assignDealer(raw: unknown) {
  const { dealerId, officerId, effectiveFrom } = dealerAssignmentSchema.parse(raw);

  const officer = await prisma.user.findUnique({ where: { id: officerId } });
  if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive) {
    throw new ApiError(422, "Target must be an active Sales Officer");
  }
  const dealer = await prisma.dealer.findUnique({ where: { id: dealerId } });
  if (!dealer || !dealer.isActive) throw new ApiError(422, "Dealer must be active");

  await prisma.$transaction((tx) => applyDealerAssignment(tx, dealerId, officerId, effectiveFrom));
}

/* ------------------------------ Officer → RM ------------------------------ */

export async function listCurrentRmAssignments(search: string) {
  const rows = await prisma.rmAssignment.findMany({
    where: {
      effectiveTo: null,
      officer: search ? { name: { contains: search, mode: "insensitive" } } : undefined,
    },
    include: {
      officer: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true } },
    },
    orderBy: { officer: { name: "asc" } },
  });
  return rows.map((r) => ({
    id: r.id,
    officerId: r.officerId,
    officerName: r.officer.name,
    managerId: r.managerId,
    managerName: r.manager.name,
    effectiveFrom: r.effectiveFrom,
  }));
}

export async function getRmAssignmentHistory(officerId: string) {
  const rows = await prisma.rmAssignment.findMany({
    where: { officerId },
    include: { manager: { select: { name: true } } },
    orderBy: { effectiveFrom: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    managerName: r.manager.name,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
}

export async function assignRm(raw: unknown) {
  const { officerId, managerId, effectiveFrom } = rmAssignmentSchema.parse(raw);

  const officer = await prisma.user.findUnique({ where: { id: officerId } });
  if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive) {
    throw new ApiError(422, "Officer must be an active Sales Officer");
  }
  const manager = await prisma.user.findUnique({ where: { id: managerId } });
  if (!manager || manager.role !== Role.REGIONAL_MANAGER || !manager.isActive) {
    throw new ApiError(422, "Manager must be an active Regional Manager");
  }

  await prisma.$transaction((tx) => applyRmAssignment(tx, officerId, managerId, effectiveFrom));
}

/* --------------------------- Option list helpers -------------------------- */

export async function loadAssignmentOptions() {
  const [dealers, officers, managers] = await Promise.all([
    prisma.dealer.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({
      where: { role: Role.SALES_OFFICER, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      where: { role: Role.REGIONAL_MANAGER, isActive: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return {
    dealers: dealers.map((d) => ({ value: d.id, label: d.name })),
    officers: officers.map((o) => ({ value: o.id, label: o.name })),
    managers: managers.map((m) => ({ value: m.id, label: m.name })),
  };
}
