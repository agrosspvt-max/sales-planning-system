import "server-only";
import { z } from "zod";
import { Role } from "@prisma/client";
import { ApiError, type AuthContext } from "@/lib/http";
import { PLANNING_MODES } from "@/lib/calc";
import { getPlanningConfig, savePlanningConfig, type PlanningConfig } from "@/lib/planning-config";
import { writeAudit } from "@/lib/audit";

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) {
    throw new ApiError(403, "Only the Super Admin can change planning configuration");
  }
}

const modeSchema = z.enum(PLANNING_MODES as [string, ...string[]]);
const configSchema = z.object({
  seasonalMode: modeSchema,
  monthlyMode: modeSchema,
});

export async function loadPlanningConfig(ctx: AuthContext): Promise<PlanningConfig> {
  assertAdmin(ctx);
  return getPlanningConfig();
}

export async function updatePlanningConfig(ctx: AuthContext, raw: unknown): Promise<PlanningConfig> {
  assertAdmin(ctx);
  const config = configSchema.parse(raw) as PlanningConfig;
  const saved = await savePlanningConfig(config);
  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "planningConfig",
    summary: `Planning configuration set — Seasonal: ${saved.seasonalMode}, Monthly: ${saved.monthlyMode}`,
  });
  return saved;
}
