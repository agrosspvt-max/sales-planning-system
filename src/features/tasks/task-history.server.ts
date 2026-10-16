import "server-only";
import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/http";

/**
 * Task rescheduling history — the ONE way a date change is recorded. Called INSIDE the transaction that moves the task, so the history row and the new date commit (or roll
 * back) together: a failed change leaves no history, a retry that finds the date already moved never reaches it (the callers' own state checks return first), and a save to the
 * SAME date writes nothing. Rows are immutable (database trigger). Nothing here reads or changes the task, the Calendar, Daily Work or any notification.
 */
export type TaskSourceType = "BILLING_EXCEPTION" | "CN_PAYMENT" | "CN_LEGACY" | "CALENDAR_ENTRY";

export async function recordTaskReschedule(
  tx: Pick<Prisma.TransactionClient, "taskRescheduleEvent" | "user">,
  ctx: AuthContext,
  move: { sourceType: TaskSourceType; sourceId: string; ownerId: string; previousDate: string; newDate: string; reason?: string | null },
): Promise<boolean> {
  if (move.previousDate === move.newDate) return false; // not a reschedule
  const actor = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
  await tx.taskRescheduleEvent.create({
    data: {
      sourceType: move.sourceType, sourceId: move.sourceId, ownerId: move.ownerId,
      previousDate: new Date(`${move.previousDate}T00:00:00.000Z`), newDate: new Date(`${move.newDate}T00:00:00.000Z`),
      actorId: ctx.userId, actorName: actor?.name ?? ctx.username ?? ctx.userId, actorRole: String(ctx.role), reason: move.reason?.trim() || null,
    },
  });
  return true;
}
