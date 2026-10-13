import "server-only";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { currentBusinessDate } from "@/lib/daily-work";
import { getCurrentOwnerByDealer, getOfficerScope } from "@/lib/scope";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { hasAdminPermission, isAdministrativeRole } from "@/features/accounts/permissions";

/**
 * WHO MAY SEE a Billing Exception task outside Daily Work (Calendar, task details). ONE task, many authorized viewers — never a copy assigned to someone else.
 * EFFECTIVE OWNER = the officer who will receive it: for a task that has not entered Daily Work yet, the dealer's CURRENT assignment (the same rule materialization uses,
 * so a reassigned dealer's pending task moves its visibility with it); once linked to a Daily Work row, the officer recorded on the task. Falls back to the recorded
 * officer if the dealer currently has no assignment.
 * VIEWERS: the effective owner; a Regional Manager whose team scope contains the owner (getOfficerScope — the Calendar's own rule); an administrative account only with
 * Last Payment Report read (they can already see the originating exception there). Seeing a task never grants the right to create a Billing Exception.
 */

export type BillingTaskCalendarStatus = "SCHEDULED" | "IN_DAILY_WORK" | "OVERDUE";
export interface CalendarBillingTaskDto {
  id: string; billingExceptionId: string; dateKey: string; dealerId: string; dealerName: string; amount: number;
  taskType: "BILLING_EXCEPTION"; ownerId: string; ownerName: string; promisedDate: string; rescheduled: boolean;
  status: BillingTaskCalendarStatus; confirmed: boolean;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

type TaskLike = { officerId: string; dealerId: string; dailyWorkEntryId: string | null };

/** The effective owner of each task (see above), resolved with ONE assignment query for all unlinked tasks. */
export async function effectiveBillingTaskOwners<T extends TaskLike>(tasks: readonly T[]): Promise<string[]> {
  const pending = tasks.filter((t) => !t.dailyWorkEntryId).map((t) => t.dealerId);
  const current = pending.length ? await getCurrentOwnerByDealer(pending) : new Map<string, string>();
  return tasks.map((t) => (t.dailyWorkEntryId ? t.officerId : current.get(t.dealerId) ?? t.officerId));
}

/** True when `ctx` may view a task whose effective owner is `ownerId`. */
export async function canViewBillingTask(ctx: AuthContext, ownerId: string): Promise<boolean> {
  if (ownerId === ctx.userId) return true;
  if (isAdministrativeRole(ctx.role)) return hasAdminPermission(ctx, "lastPaymentReport", "read");
  if (ctx.role !== Role.REGIONAL_MANAGER) return false;
  const scope = await getOfficerScope(ctx);
  return scope.all || scope.ids.includes(ownerId);
}

/**
 * The month's Billing Exception tasks for the Calendar, narrowed to `ownerIds` (the Calendar's already-resolved owner set; null = no narrowing, administrative only).
 * Read-only: shown on the CURRENT scheduled date (a reschedule moves it); an overdue, unlinked task stays on its past date flagged Overdue. Never writes, never
 * creates a Daily Work contribution — the Calendar only looks at the one authoritative task row.
 */
export async function loadCalendarBillingTasks(ctx: AuthContext, gte: Date, lt: Date, ownerIds: string[] | null): Promise<CalendarBillingTaskDto[]> {
  if (isAdministrativeRole(ctx.role) && !hasAdminPermission(ctx, "lastPaymentReport", "read")) return [];
  const rows = await prisma.billingExceptionTask.findMany({
    where: { taskDate: { gte, lt } },
    select: { id: true, billingExceptionId: true, dealerId: true, officerId: true, amount: true, promisedDate: true, taskDate: true, rescheduled: true, dailyWorkEntryId: true, dailyWorkConfirmed: true },
    orderBy: [{ taskDate: "asc" }, { createdAt: "asc" }],
  });
  if (rows.length === 0) return [];
  const owners = await effectiveBillingTaskOwners(rows);
  const keep = rows.map((r, i) => ({ r, owner: owners[i]! })).filter(({ owner }) => ownerIds === null || ownerIds.includes(owner));
  if (keep.length === 0) return [];
  const dealerIds = [...new Set(keep.map(({ r }) => r.dealerId))];
  const [aliases, dealers, users] = await Promise.all([
    loadDealerAliasNameMap(dealerIds),
    prisma.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(keep.map(({ owner }) => owner))] } }, select: { id: true, name: true } }),
  ]);
  const dealerName = new Map(dealers.map((d) => [d.id, aliases.get(d.id) ?? d.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const today = currentBusinessDate();
  return keep.map(({ r, owner }) => ({
    id: r.id, billingExceptionId: r.billingExceptionId, dateKey: iso(r.taskDate), dealerId: r.dealerId, dealerName: dealerName.get(r.dealerId) ?? "—", amount: Number(r.amount),
    taskType: "BILLING_EXCEPTION" as const, ownerId: owner, ownerName: userName.get(owner) ?? "—", promisedDate: iso(r.promisedDate), rescheduled: r.rescheduled,
    status: r.dailyWorkEntryId ? "IN_DAILY_WORK" as const : iso(r.taskDate) < today ? "OVERDUE" as const : "SCHEDULED" as const, confirmed: r.dailyWorkConfirmed,
  }));
}
