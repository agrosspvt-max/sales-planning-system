import "server-only";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { isMonthEditable, MONTH_TRANSITIONS, type MonthStatus } from "./planning-state";

/**
 * Centralized planning-state authority (Open-Month, Section 42). Every planning operation that
 * depends on month state — Monthly Planning, Actual Sales, and the management open/close action —
 * goes through here, so the business rules exist in ONE place. Imports (migration) write
 * directly and intentionally bypass this gate; Reports and Approvals do not consult it (open
 * state governs editability only, never what is reported or how the seasonal plan is approved).
 */

export interface MonthState {
  id: string;
  name: string;
  order: number;
  status: MonthStatus;
  editable: boolean;
}

/** All months of a season with their lifecycle status (ordered). */
export async function getSeasonMonthStates(seasonId: string): Promise<MonthState[]> {
  const rows = (await prisma.seasonMonth.findMany({
    where: { seasonId },
    orderBy: { order: "asc" },
    select: { id: true, name: true, order: true, status: true },
  })) as { id: string; name: string; order: number; status: string }[];
  return rows.map((m) => {
    const status = (m.status as MonthStatus) ?? "OPEN";
    return { id: m.id, name: m.name, order: m.order, status, editable: isMonthEditable(status) };
  });
}

/** Map of seasonMonthId → editable, for O(1) enforcement inside a save loop. */
export async function getEditableMonthMap(seasonId: string): Promise<Map<string, boolean>> {
  const states = await getSeasonMonthStates(seasonId);
  return new Map(states.map((s) => [s.id, s.editable]));
}

/**
 * The single enforcement point for month entry. Throws if the month is not OPEN. Used by
 * Monthly Planning saves (both plan quantity and actual sales) — no other place gates months.
 */
export function assertMonthOpen(editableByMonth: Map<string, boolean>, seasonMonthId: string, monthName?: string) {
  if (!editableByMonth.get(seasonMonthId)) {
    throw new ApiError(
      422,
      `${monthName ? `"${monthName}" ` : "This month "}is not open for entry. Management must open it first.`,
    );
  }
}

/**
 * Management (Super Admin) opens / closes / reopens a month. Validates the transition against
 * the shared state machine and records an audit entry. Supports multiple simultaneously-open
 * months and reopening previous months without redesign.
 */
export async function setMonthStatus(
  ctx: AuthContext,
  seasonMonthId: string,
  next: MonthStatus,
): Promise<{ id: string; status: MonthStatus }> {
  if (ctx.role !== Role.SUPER_ADMIN) {
    throw new ApiError(403, "Only the Super Admin can open or close planning months");
  }
  const month = (await prisma.seasonMonth.findUnique({
    where: { id: seasonMonthId },
    select: { id: true, name: true, status: true, seasonId: true },
  })) as { id: string; name: string; status: string; seasonId: string } | null;
  if (!month) throw new ApiError(404, "Month not found");

  const current = (month.status as MonthStatus) ?? "OPEN";
  if (current !== next && !MONTH_TRANSITIONS[current].includes(next)) {
    throw new ApiError(422, `Cannot change month from ${current} to ${next}`);
  }
  await prisma.seasonMonth.update({ where: { id: seasonMonthId }, data: { status: next } });
  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "seasonMonth",
    entityId: seasonMonthId,
    summary: `Month "${month.name}" ${next === "OPEN" ? "opened" : next.toLowerCase()} for entry`,
  });
  return { id: seasonMonthId, status: next };
}
