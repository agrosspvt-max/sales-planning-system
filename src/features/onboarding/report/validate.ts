import type { OnboardingReport } from "../diagnostics";
import { CURRENT_REPORT_VERSION } from "./schema";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Validate a NORMALIZED report against the current-schema contract. Normalization should
 * already guarantee shape, so this is the safety net: it confirms the invariants and, on
 * any deviation (a normalizer bug, a value that survived as NaN, etc.), reports errors
 * instead of letting the UI render bad data silently. It never throws.
 */
export function validateReport(report: OnboardingReport): ValidationResult {
  const errors: string[] = [];
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

  try {
    const r = report as any;

    if (r?.version !== CURRENT_REPORT_VERSION) errors.push(`version is ${r?.version}, expected ${CURRENT_REPORT_VERSION}`);
    if (typeof r?.workbookName !== "string") errors.push("workbookName must be a string");

    const s = r?.summary;
    if (!s || typeof s !== "object") {
      errors.push("summary is missing");
    } else {
      for (const key of ["packSizes", "products", "dealers"] as const) {
        const group = s[key];
        if (!group || typeof group !== "object") errors.push(`summary.${key} is missing`);
        else for (const f of Object.keys(group)) if (!isNum(group[f])) errors.push(`summary.${key}.${f} is not a finite number`);
      }
      const pr = s.planningRows;
      if (!pr || typeof pr !== "object") errors.push("summary.planningRows is missing");
      else for (const f of ["parsed", "imported", "skipped"]) if (!isNum(pr[f])) errors.push(`summary.planningRows.${f} is not a finite number`);
      for (const f of ["monthlyRows", "totalSeasonalQuantity", "totalMonthlyQuantity"]) if (!isNum(s[f])) errors.push(`summary.${f} is not a finite number`);
    }

    const st = r?.statistics;
    if (!st || typeof st !== "object") errors.push("statistics is missing");
    else for (const f of Object.keys(st)) if (!isNum(st[f])) errors.push(`statistics.${f} is not a finite number`);

    if (!Array.isArray(r?.warnings)) errors.push("warnings must be an array");
    if (!Array.isArray(r?.skippedRows)) errors.push("skippedRows must be an array");

    const cm = r?.createdMasters;
    if (!cm || typeof cm !== "object") errors.push("createdMasters is missing");
    else for (const f of ["packSizes", "products", "dealers"]) if (!Array.isArray(cm[f])) errors.push(`createdMasters.${f} must be an array`);

    const mm = r?.matchedMasters;
    if (!mm || typeof mm !== "object") errors.push("matchedMasters is missing");
    else for (const f of Object.keys(mm)) if (!isNum(mm[f])) errors.push(`matchedMasters.${f} is not a finite number`);

    // Light consistency check (non-fatal signal): imported + skipped should not exceed parsed.
    const pr = s?.planningRows;
    if (pr && isNum(pr.parsed) && isNum(pr.imported) && isNum(pr.skipped) && pr.imported + pr.skipped > pr.parsed) {
      errors.push("summary.planningRows: imported + skipped exceeds parsed");
    }
  } catch (e) {
    errors.push(`validation threw: ${(e as Error).message}`);
  }

  return { valid: errors.length === 0, errors };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
