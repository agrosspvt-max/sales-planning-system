import "server-only";
import { prisma } from "@/lib/prisma";
import { PLANNING_MODES, type PlanningMode } from "@/lib/calc";

/**
 * Planning Configuration (V1) — persisted in the existing SystemSetting table
 * (no dedicated table). Two independent settings decide what a Sales Officer
 * enters during Seasonal and Monthly planning. Defaults to PACK_SIZE, so an
 * un-configured system behaves exactly as before (backward compatible).
 */
export const SEASONAL_MODE_KEY = "planning.seasonalMode";
export const MONTHLY_MODE_KEY = "planning.monthlyMode";

export interface PlanningConfig {
  seasonalMode: PlanningMode;
  monthlyMode: PlanningMode;
}

const DEFAULT_MODE: PlanningMode = "PACK_SIZE";

function coerceMode(value: string | undefined | null): PlanningMode {
  return value && (PLANNING_MODES as string[]).includes(value)
    ? (value as PlanningMode)
    : DEFAULT_MODE;
}

/** Read both planning modes (with safe defaults). Cheap; call per request as needed. */
export async function getPlanningConfig(): Promise<PlanningConfig> {
  const rows = (await prisma.systemSetting.findMany({
    where: { key: { in: [SEASONAL_MODE_KEY, MONTHLY_MODE_KEY] } },
    select: { key: true, value: true },
  })) as { key: string; value: string }[];
  const byKey = new Map<string, string>(rows.map((r) => [r.key, r.value]));
  return {
    seasonalMode: coerceMode(byKey.get(SEASONAL_MODE_KEY)),
    monthlyMode: coerceMode(byKey.get(MONTHLY_MODE_KEY)),
  };
}

/** Upsert both planning modes. */
export async function savePlanningConfig(config: PlanningConfig): Promise<PlanningConfig> {
  const write = (key: string, value: PlanningMode) =>
    prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  await prisma.$transaction([
    write(SEASONAL_MODE_KEY, config.seasonalMode),
    write(MONTHLY_MODE_KEY, config.monthlyMode),
  ]);
  return config;
}
