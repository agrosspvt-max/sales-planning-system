import "server-only";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { MONTH_NAMES } from "@/lib/season-months";
import { validateAddMonths } from "@/lib/season-calendar";

const schema = z
  .object({
    months: z
      .array(
        z
          .object({
            year: z.number().int().min(2000).max(2100),
            month: z.number().int().min(1).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export async function addSeasonMonths(ctx: AuthContext, seasonId: string, raw: unknown) {
  if (ctx.role !== Role.SUPER_ADMIN)
    throw new ApiError(403, "Only the Super Admin can add Season months");
  const payload = schema.parse(raw);
  return prisma.$transaction(
    async (tx) => {
      // Serializes additions with other additions, period edits, and Season status updates.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Season" WHERE "id" = ${seasonId} FOR UPDATE`);
      const season = await tx.season.findUnique({
        where: { id: seasonId },
        include: { months: true },
      });
      if (!season) throw new ApiError(404, "Season not found");
      if (season.status !== "OPEN")
        throw new ApiError(409, "Reopen this Season before adding months.");
      let validated;
      try {
        validated = validateAddMonths(season.months, payload.months);
      } catch (error) {
        throw new ApiError(422, (error as Error).message);
      }
      const maxOrder = Math.max(...season.months.map((m) => m.order));
      const created = await tx.seasonMonth.createManyAndReturn({
        data: validated.additions.map((m, i) => ({
          seasonId,
          calendarMonth: m.month,
          calendarYear: m.year,
          name: MONTH_NAMES[m.month - 1],
          order: maxOrder + i + 1,
          status: "OPEN",
        })),
        select: { id: true, calendarMonth: true, calendarYear: true },
      });
      // Stable Season.year remains the identity/key year, even when a previous-year month is added.
      await tx.season.update({ where: { id: seasonId }, data: validated.newPeriod });
      await writeAudit(
        {
          userId: ctx.userId,
          action: "UPDATE",
          entity: "seasonMonths",
          entityId: seasonId,
          summary: JSON.stringify({
            operation: "ADD_MONTHS",
            seasonId,
            actor: ctx.userId,
            added: created,
            existingPeriod: validated.existingPeriod,
            newPeriod: validated.newPeriod,
          }),
        },
        tx,
      );
      return { created, period: validated.newPeriod };
    },
    { timeout: 15000 },
  );
}
