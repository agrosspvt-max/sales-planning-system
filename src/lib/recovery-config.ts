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

// DashboardLayout reads this flag on every authenticated navigation. A short process-local cache removes that
// repeated pool checkout; single-flight also collapses simultaneous layout/page/API guards into one lookup.
// Admin writes refresh this process immediately. Other server instances observe the new value after this short
// TTL, so the setting remains globally persisted without keeping stale feature state for long.
const CALENDAR_CACHE_TTL_MS = Number(process.env.CALENDAR_SETTING_CACHE_TTL_MS ?? 5_000);
let calendarCache: { value: boolean; expiresAt: number } | null = null;
let calendarLookup: Promise<boolean> | null = null;
let calendarCacheGeneration = 0;

function rememberCalendarEnabled(value: boolean): boolean {
  calendarCache = { value, expiresAt: Date.now() + Math.max(0, CALENDAR_CACHE_TTL_MS) };
  return value;
}

/** Read the recovery config (safe default ON). Cheap; call per request as needed. */
export async function getRecoveryConfig(): Promise<RecoveryConfig> {
  const rows = (await prisma.systemSetting.findMany({
    where: { key: { in: [RECOVERY_DUE_VALIDATION_KEY, CALENDAR_ENABLED_KEY] } },
    select: { key: true, value: true },
  })) as { key: string; value: string }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  // Only an explicit "false" disables it; anything else (incl. missing) keeps the ON default.
  const config = {
    dueValidation: values.get(RECOVERY_DUE_VALIDATION_KEY) !== "false",
    calendarEnabled: values.get(CALENDAR_ENABLED_KEY) !== "false",
  };
  rememberCalendarEnabled(config.calendarEnabled);
  return config;
}

/** Fast single-flag read for navigation, dashboard, Calendar route and API guards. */
export async function getCalendarEnabled(): Promise<boolean> {
  if (calendarCache && calendarCache.expiresAt > Date.now()) return calendarCache.value;
  if (calendarLookup) return calendarLookup;
  const generation = calendarCacheGeneration;
  const lookup = prisma.systemSetting.findUnique({
    where: { key: CALENDAR_ENABLED_KEY },
    select: { value: true },
  }).then((row) => {
    const value = row?.value !== "false";
    // A completed settings write is authoritative over any lookup that began before that write.
    return generation === calendarCacheGeneration ? rememberCalendarEnabled(value) : (calendarCache?.value ?? value);
  });
  calendarLookup = lookup;
  try {
    return await lookup;
  } finally {
    if (calendarLookup === lookup) calendarLookup = null;
  }
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
  calendarCacheGeneration += 1;
  calendarLookup = null;
  rememberCalendarEnabled(config.calendarEnabled);
  return config;
}
