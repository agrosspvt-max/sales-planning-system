/**
 * The canonical Dealer Planning pack-size model — the single source of truth for which
 * pack sizes are planning columns, in the exact order and combined form the business
 * workbook uses. These 7 (and only these) appear in Dealer Planning; other pack sizes may
 * exist in the master for pricing/other uses but are NOT planning columns.
 *
 * Order matters: it is the workbook column order (never sorted alphabetically).
 */
export const CANONICAL_PLANNING_PACKS = [
  "1,2 & 5 LTR/KG",
  "500 ML/KG",
  "250 ML",
  "100 ML",
  "50 ML",
  "25 ML",
  "10/15 ML",
] as const;

export type PlanningPackName = (typeof CANONICAL_PLANNING_PACKS)[number];
