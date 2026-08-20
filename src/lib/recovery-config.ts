import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Recovery Configuration — persisted in the existing SystemSetting table (no dedicated table), so a change
 * applies GLOBALLY and immediately to every recovery plan with no deployment. Currently one setting:
 * "Enable Due Recovery Validation" — whether Running Recovery Plan requires Due ≥ Overdue + Due first.
 * Defaults to ON, so an un-configured system behaves exactly as before (backward compatible).
 */
export const RECOVERY_DUE_VALIDATION_KEY = "recovery.dueValidation";

export interface RecoveryConfig {
  dueValidation: boolean; // ON (default): enforce Due ≥ Overdue + Due before Running is editable
}

/** Read the recovery config (safe default ON). Cheap; call per request as needed. */
export async function getRecoveryConfig(): Promise<RecoveryConfig> {
  const row = (await prisma.systemSetting.findUnique({
    where: { key: RECOVERY_DUE_VALIDATION_KEY },
    select: { value: true },
  })) as { value: string } | null;
  // Only an explicit "false" disables it; anything else (incl. missing) keeps the ON default.
  return { dueValidation: row?.value !== "false" };
}

/** Upsert the recovery config. */
export async function saveRecoveryConfig(config: RecoveryConfig): Promise<RecoveryConfig> {
  await prisma.systemSetting.upsert({
    where: { key: RECOVERY_DUE_VALIDATION_KEY },
    create: { key: RECOVERY_DUE_VALIDATION_KEY, value: config.dueValidation ? "true" : "false" },
    update: { value: config.dueValidation ? "true" : "false" },
  });
  return config;
}
