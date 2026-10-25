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

/**
 * The same history rows as recordTaskReschedule for SEVERAL tasks in one statement (a final Daily Report can move many tasks): same no-op rule (previous === new writes nothing),
 * same fields, same transaction — and the actor's name is supplied by the caller instead of being read again for every task. Returns how many history rows were written.
 */
export async function recordTaskReschedules(
  tx: Pick<Prisma.TransactionClient, "taskRescheduleEvent">,
  ctx: AuthContext,
  actorName: string,
  moves: readonly { sourceType: TaskSourceType; sourceId: string; ownerId: string; previousDate: string; newDate: string; reason?: string | null }[],
): Promise<number> {
  const real = moves.filter((m) => m.previousDate !== m.newDate);
  if (real.length === 0) return 0;
  const created = await tx.taskRescheduleEvent.createMany({
    data: real.map((m) => ({
      sourceType: m.sourceType, sourceId: m.sourceId, ownerId: m.ownerId,
      previousDate: new Date(`${m.previousDate}T00:00:00.000Z`), newDate: new Date(`${m.newDate}T00:00:00.000Z`),
      actorId: ctx.userId, actorName, actorRole: String(ctx.role), reason: m.reason?.trim() || null,
    })),
  });
  return created.count;
}
