export interface ReceiptReview {
  rowKey: string;
  action: "KEEP" | "EXCLUDE";
  dealerId?: string;
}
export interface HistoricalRow {
  rowKey: string;
  sourceOrder: number;
  party: string;
  date: string | null;
  amount: string | null;
  voucherNumber: string | null;
  errors: string[];
  dealerId: string | null;
  candidates: { id: string; name: string; matchType: string }[];
  reviewReasons: string[];
  duplicate: boolean;
  excluded: boolean;
  ready: boolean;
}
export interface LastPaymentChange {
  dealerId: string;
  dealerName: string;
  cutoff: string;
  plans: number;
  before: { date: string; amount: number } | null;
  after: { date: string; amount: number } | null;
}
export interface HistoricalAnalysis {
  fileHash: string;
  previewToken: string;
  workbookName: string;
  sheet: string;
  ignoredSheets: string[];
  totalRows: number;
  ignoredRows: number;
  rows: HistoricalRow[];
  summary: {
    receipts: number;
    valid: number;
    dealers: number;
    invalid: number;
    unmatched: number;
    review: number;
    duplicates: number;
    excluded: number;
    importing: number;
  };
  changes: LastPaymentChange[];
  canCommit: boolean;
  alreadyImported: boolean;
}
export interface HistoricalResult {
  importId: string;
  imported: number;
  excluded: number;
  duplicates: number;
  alreadyImported: boolean;
}
