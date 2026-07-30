export type ReportType =
  | "product"
  | "brand"
  | "category"
  | "dealer"
  | "officer"
  | "regional"
  | "company"
  | "season"
  | "monthly";

export type CellFormat = "text" | "number" | "currency" | "percent";

export interface ReportColumn {
  key: string;
  label: string;
  format: CellFormat;
}

export type ReportRow = { id: string } & Record<string, string | number>;

export interface ReportMeta {
  seasonName: string;
  filters: string[]; // human-readable applied filters
}

export interface ReportSort {
  key: string;
  dir: "asc" | "desc";
}

export interface ReportPayload {
  type: ReportType;
  kind: "summary" | "monthly";
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number> | null;
  /** The report type to drill into when a row is clicked (null = leaf). */
  drillChild: ReportType | null;
  meta: ReportMeta;
  sort: ReportSort;
}

export interface ReportFilters {
  manager?: string;
  officer?: string;
  dealer?: string;
  brand?: string;
  category?: string;
}

/** Compact row used by dashboard ranking tables (top/lowest lists). */
export interface RankRow {
  id: string;
  label: string;
  planAmount: number;
  actualAmount: number;
  achievementAmount: number;
}
