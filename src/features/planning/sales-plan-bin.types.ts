export type BinPlanKind = "SEASONAL" | "MONTHLY";
export interface SalesPlanBinRow {
  id: string;
  kind: BinPlanKind;
  planType: string;
  seasonName: string;
  monthName: string | null;
  officerName: string;
  version: number;
  status: string;
  openHref: string;
  deactivatedAt: string | null;
  inherited: boolean;
  parentPlanId: string | null;
  reason: string;
  actor: string | null;
  auditSummary: string | null;
}
export interface BinRestoreContext {
  parentVersion: number;
  needsParent: boolean;
  activeVersions: { id: string; version: number }[];
}
export type BinRestoreMode = "RESTORE" | "REPLACE_ACTIVE" | "HISTORICAL";
