export const UNLIMITED_EXTENSION_ATTEMPTS = -1;

const EXTENDABLE_PLAN_STATUSES = new Set(["PENDING_RM", "PENDING_APPROVAL", "APPROVED"]);

/** 0 keeps its historical disabled meaning; -1 is the only unlimited-attempt sentinel. */
export function extensionAttemptsEnabled(maxAttempts: number): boolean {
  return maxAttempts === UNLIMITED_EXTENSION_ATTEMPTS || maxAttempts > 0;
}

export function hasExtensionAttemptsRemaining(attemptsUsed: number, maxAttempts: number): boolean {
  return maxAttempts === UNLIMITED_EXTENSION_ATTEMPTS || (maxAttempts > 0 && attemptsUsed < maxAttempts);
}

export function isConversionExtensionStatusEligible(planStatus: string, schemeStatus: string, isAdminVerified: boolean): boolean {
  return EXTENDABLE_PLAN_STATUSES.has(planStatus) && schemeStatus !== "CONVERTED" && !isAdminVerified;
}

export function isWithinConversionExtensionDayLimit(maxDays: number, daysUsed: number, daysAdded: number): boolean {
  return maxDays > 0 && daysAdded >= 1 && daysUsed + daysAdded <= maxDays;
}

