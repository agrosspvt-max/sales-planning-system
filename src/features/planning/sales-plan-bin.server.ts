import "server-only";
import { Role } from "@prisma/client";
import { assertAdminPermission, isAdministrativeRole } from "@/features/accounts/permissions";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { inOpenPlanningPeriod } from "@/lib/open-planning-period";
import type { SalesPlanBinRow } from "./sales-plan-bin.types";

/** Same officer and open-period scope as Sales Planning; archived approval states are all included. */
export async function listSalesPlanBin(ctx: AuthContext): Promise<SalesPlanBinRow[]> {
  if (!isAdministrativeRole(ctx.role) && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, "You cannot access deactivated plans");
  assertAdminPermission(ctx, "salesPlanning", "read");
  const scope = await getOfficerScope(ctx);
  const where = { lifecycleState: "DEACTIVATED", officerId: scope.all ? undefined : { in: scope.ids } };
  const [seasonal, monthly] = await Promise.all([
    prisma.seasonPlan.findMany({
      where: inOpenPlanningPeriod("seasonPlan", where),
      select: { id: true, planningType: true, version: true, status: true, deactivatedAt: true, officer: { select: { name: true } }, season: { select: { name: true, year: true } } },
    }),
    prisma.monthlyPlan.findMany({
      where: inOpenPlanningPeriod("monthlyPlan", where),
      select: { id: true, status: true, deactivatedAt: true, lifecycleFromParent: true, officer: { select: { name: true } }, seasonMonth: { select: { name: true } }, seasonPlan: { select: { id: true, version: true, season: { select: { name: true, year: true } } } } },
    }),
  ]);
  const rows = [
    ...seasonal.map((p): SalesPlanBinRow => ({ id: p.id, kind: "SEASONAL", planType: p.planningType === "YEARLY" ? "Yearly" : "Seasonal", seasonName: `${p.season.name} ${p.season.year}`, monthName: null, officerName: p.officer.name, version: p.version, status: p.status, openHref: `/planning/${p.id}`, deactivatedAt: p.deactivatedAt?.toISOString() ?? null, inherited: false, parentPlanId: null, reason: "", actor: null, auditSummary: null })),
    ...monthly.map((p): SalesPlanBinRow => ({ id: p.id, kind: "MONTHLY", planType: "Monthly", seasonName: `${p.seasonPlan.season.name} ${p.seasonPlan.season.year}`, monthName: p.seasonMonth.name, officerName: p.officer.name, version: p.seasonPlan.version, status: p.status, openHref: `/planning/monthly/${p.id}`, deactivatedAt: p.deactivatedAt?.toISOString() ?? null, inherited: p.lifecycleFromParent, parentPlanId: p.seasonPlan.id, reason: "", actor: null, auditSummary: null })),
  ];
  if (!rows.length) return [];
  const parentIds = [...new Set([...seasonal.map(p => p.id), ...monthly.filter(p => p.lifecycleFromParent).map(p => p.seasonPlan.id)])];
  const childIds = monthly.filter(p => !p.lifecycleFromParent).map(p => p.id);
  const events = await prisma.auditLog.findMany({
    where: { action: { in: ["DEACTIVATE", "REPLACE"] }, OR: [{ entity: "seasonPlan", entityId: { in: parentIds } }, { entity: "monthlyPlan", entityId: { in: childIds } }] },
    select: { entity: true, entityId: true, action: true, summary: true, createdAt: true, user: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(row => {
    const entity = row.kind === "MONTHLY" && !row.inherited ? "monthlyPlan" : "seasonPlan";
    const id = row.inherited ? row.parentPlanId : row.id;
    // Audit writes follow the lifecycle transaction. Match the current deactivation, rather than
    // accidentally attributing an old event after a later restore/deactivate cycle.
    const event = events.find(e => e.entity === entity && e.entityId === id && row.deactivatedAt && Math.abs(e.createdAt.getTime() - new Date(row.deactivatedAt).getTime()) < 60_000);
    const cause = event?.action === "REPLACE" ? "Archived using Replace Plan for a replacement import." : event ? "Deactivated by an administrator." : "The specific reason was not recorded.";
    return { ...row, reason: row.inherited ? `Deactivated with seasonal plan v${row.version}. ${cause}` : cause, actor: event?.user.name ?? null, auditSummary: event?.summary ?? null };
  }).sort((a, b) => (b.deactivatedAt ?? "").localeCompare(a.deactivatedAt ?? "") || a.officerName.localeCompare(b.officerName) || a.id.localeCompare(b.id));
}
