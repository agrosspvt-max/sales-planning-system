export type PlanStatus =
  | "DRAFT"
  | "PENDING_RM"
  | "PENDING_ADMIN"
  | "APPROVED"
  | "RETURNED"
  | "REJECTED";

export const STATUS_LABELS: Record<PlanStatus, string> = {
  DRAFT: "Draft",
  PENDING_RM: "Pending RM",
  PENDING_ADMIN: "Pending Super Admin",
  APPROVED: "Approved",
  RETURNED: "Returned",
  REJECTED: "Rejected",
};

import type { MonthStatus } from "./planning-state";

export type PlanningMode = "PACK_SIZE" | "TOTAL_QUANTITY" | "AMOUNT" | "NBV";

export type PlanningType = "SEASONAL" | "MONTHLY" | "YEARLY";

export const PLANNING_TYPE_LABELS: Record<PlanningType, string> = {
  SEASONAL: "Seasonal",
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
};

export interface PackSizeColumn {
  id: string;
  name: string;
}

export interface PlanLineDetail {
  planLineId: string;
  productId: string;
  productName: string;
  technicalName: string | null;
  productActive: boolean;
  rate: number;
  nbvPercent: number;
  /** How this line was stored (null => PACK_SIZE). */
  inputMode: PlanningMode | null;
  /** The single entered value for a non-pack mode (qty / amount / nbv), else null. */
  inputValue: number | null;
  /** packSizeId → quantity (all stored packs; totals sum every entry). */
  packs: Record<string, number>;
  /** Read-only roll-ups: Σ monthly plan qty (Live Monthly) and Σ monthly sale qty (Actual). */
  liveMonthlyQty: number;
  actualQty: number;
  /** Σ actual SALES VALUE from the uploaded Tally sheet (saleValue); not qty × rate. */
  actualAmount: number;
}

export interface PlanDealerDetail {
  planDealerId: string;
  dealerId: string;
  dealerName: string;
  dealerActive: boolean;
  /** Dealer completion: intentionally skipped ("No Plan") with an optional reason. */
  noPlan: boolean;
  noPlanReason: string | null;
  lines: PlanLineDetail[];
}

export interface PlanDetail {
  id: string;
  seasonId: string;
  seasonName: string;
  seasonOpen: boolean;
  officerId: string;
  officerName: string;
  version: number;
  status: PlanStatus;
  isActiveVersion: boolean;
  revisionRequested: boolean;
  revisionReason: string | null;
  lastSavedAt: string;
  canEdit: boolean;
  /** Configured seasonal planning mode for this workspace. */
  seasonalMode: PlanningMode;
  planningType: PlanningType;
  versionName: string | null;
  description: string | null;
  source: string;
  packSizes: PackSizeColumn[];
  dealers: PlanDealerDetail[];
}

export interface PlanListItem {
  id: string;
  seasonId: string;
  seasonName: string;
  officerId: string;
  officerName: string;
  planningType: PlanningType;
  planningMode: PlanningMode;
  versionName: string | null;
  source: string;
  version: number;
  status: PlanStatus;
  isActiveVersion: boolean;
  lastSavedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InboxItem {
  id: string;
  seasonName: string;
  officerName: string;
  version: number;
  status: PlanStatus;
  revisionRequested: boolean;
  revisionReason: string | null;
  submittedAt: string | null;
}

export interface TimelineItem {
  id: string;
  actorName: string;
  action: string;
  fromStatus: PlanStatus | null;
  toStatus: PlanStatus | null;
  remarks: string | null;
  createdAt: string;
}

export interface VersionItem {
  id: string;
  version: number;
  status: PlanStatus;
  isActiveVersion: boolean;
  approvedAt: string | null;
}

export interface MonthlyProductRow {
  planLineId: string;
  productId: string;
  productName: string;
  rate: number;
  nbvPercent: number;
  /** Approved season target expressed in the active monthly unit (qty / amount / nbv). */
  target: number;
  /**
   * Per-month figures in the active monthly unit. `sale` is the actual quantity (or value in
   * value modes); `saleAmount` is the actual SALES VALUE sourced from the uploaded Tally sheet
   * (MonthlyEntry.saleValue) — the authoritative Actual Amount, never recomputed from qty×rate.
   */
  monthly: Record<string, { plan: number; sale: number; saleAmount: number }>;
}

export interface MonthlyDealer {
  dealerId: string;
  dealerName: string;
  products: MonthlyProductRow[];
  /** Dealer completion for this month (first-class Monthly Plan only): No Plan is stored,
   *  Completed (≥1 monthly plan value) is derived; both absent on the legacy all-months view. */
  noPlan?: boolean;
  noPlanReason?: string | null;
  completed?: boolean;
}

export interface MonthlyData {
  planId: string;
  seasonName: string;
  canEdit: boolean;
  /** Configured monthly planning mode for this workspace. */
  monthlyMode: PlanningMode;
  months: { id: string; name: string; order: number; status: MonthStatus; editable: boolean }[];
  dealers: MonthlyDealer[];
}
