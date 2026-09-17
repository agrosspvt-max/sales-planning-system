import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Recovery Configuration — persisted in the existing SystemSetting table (no dedicated table), so a change
 * applies GLOBALLY and immediately with no deployment. Missing keys default ON, so existing installations
 * keep their current Recovery and Calendar behaviour until an administrator explicitly disables a feature.
 */
export const RECOVERY_DUE_VALIDATION_KEY = "recovery.dueValidation";
export const CALENDAR_ENABLED_KEY = "calendar.enabled";

export interface RecoveryConfig {
  dueValidation: boolean; // ON (default): enforce Due ≥ Overdue + Due before Running is editable
  calendarEnabled: boolean; // ON (default): expose Calendar routes, APIs, navigation and reminders
}

/** Read the recovery config (safe default ON). Cheap; call per request as needed. */
export async function getRecoveryConfig(): Promise<RecoveryConfig> {
  const rows = (await prisma.systemSetting.findMany({
    where: { key: { in: [RECOVERY_DUE_VALIDATION_KEY, CALENDAR_ENABLED_KEY] } },
    select: { key: true, value: true },
  })) as { key: string; value: string }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  // Only an explicit "false" disables it; anything else (incl. missing) keeps the ON default.
  return {
    dueValidation: values.get(RECOVERY_DUE_VALIDATION_KEY) !== "false",
    calendarEnabled: values.get(CALENDAR_ENABLED_KEY) !== "false",
  };
}

/** Fast single-flag read for navigation, dashboard, Calendar route and API guards. */
export async function getCalendarEnabled(): Promise<boolean> {
  const row = (await prisma.systemSetting.findUnique({
    where: { key: CALENDAR_ENABLED_KEY },
    select: { value: true },
  })) as { value: string } | null;
  return row?.value !== "false";
}

/** Upsert the recovery config. */
export async function saveRecoveryConfig(config: RecoveryConfig): Promise<RecoveryConfig> {
  await prisma.$transaction([
    prisma.systemSetting.upsert({
      where: { key: RECOVERY_DUE_VALIDATION_KEY },
      create: { key: RECOVERY_DUE_VALIDATION_KEY, value: config.dueValidation ? "true" : "false" },
      update: { value: config.dueValidation ? "true" : "false" },
    }),
    prisma.systemSetting.upsert({
      where: { key: CALENDAR_ENABLED_KEY },
      create: { key: CALENDAR_ENABLED_KEY, value: config.calendarEnabled ? "true" : "false" },
      update: { value: config.calendarEnabled ? "true" : "false" },
    }),
  ]);
  return config;
}
