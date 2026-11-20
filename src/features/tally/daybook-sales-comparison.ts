export type ComparisonItem = {
  productName: string;
  quantity: string;
  unit: string;
  amount: string;
  actualQty: string;
  billedQty: string;
  rate: string;
};
export type ComparisonBill = {
  guid?: string;
  masterId?: string;
  alterId?: string;
  number: string;
  date: string;
  party: string;
  type: string;
  family?: string;
  cancelled: boolean;
  optional: boolean;
  productTotal?: string | null;
  partyLedgerAmount?: string | null;
  capturedAmount?: { amount: string; direction?: string };
  narration?: string;
  rawCancelled?: string;
  rawOptional?: string;
  references?: string[];
  referenceCount?: number;
  ledgerEntries?: { name: string; amount: string }[];
  ledgerCount?: number;
  itemCount?: number;
  items: ComparisonItem[];
};
export type ComparisonFieldChange = { field: string; daybook: string; sales: string };
export type ComparisonProductChange = {
  productName: string;
  fields: string[];
  daybook: (ComparisonItem & { copies: number })[];
  sales: (ComparisonItem & { copies: number })[];
  daybookLineCount: number;
  salesLineCount: number;
};
export type ComparisonLedgerChange = {
  name: string;
  daybook: { amount: string; copies: number }[];
  sales: { amount: string; copies: number }[];
  daybookLineCount: number;
  salesLineCount: number;
};
export type DaybookSalesComparison = {
  status: "matched" | "matched_with_ignored" | "different" | "unavailable" | "period_mismatch";
  message: string;
  fromDate: string;
  throughDate: string;
  daybookCapturedAt?: string;
  salesCapturedAt?: string;
  salesThroughDate?: string;
  companyName?: string;
  daybookJobId?: string;
  salesSnapshotId?: string;
  counts?: {
    daybookBills: number;
    salesBills: number;
    matchedBills: number;
    differentBills: number;
    onlyDaybook: number;
    onlySales: number;
    ignoredBills?: number;
  };
  differences?: {
    guid: string;
    reason: string;
    fields?: ComparisonFieldChange[];
    products?: ComparisonProductChange[];
    productDifferenceCount?: number;
    ledgers?: ComparisonLedgerChange[];
    ledgerDifferenceCount?: number;
    numberMatches?: {
      count: number;
      vouchers: { source: "Daybook" | "Sales"; bill: ComparisonBill }[];
    };
    daybook?: ComparisonBill;
    sales?: ComparisonBill;
  }[];
  differenceCount?: number;
  ignoredCases?: NonNullable<DaybookSalesComparison["differences"]>;
};
