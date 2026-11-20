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
  number: string;
  date: string;
  party: string;
  type: string;
  cancelled: boolean;
  optional: boolean;
  ledgerEntries?: { name: string; amount: string }[];
  itemCount?: number;
  items: ComparisonItem[];
};
export type DaybookSalesComparison = {
  status: "matched" | "different" | "unavailable" | "period_mismatch";
  message: string;
  fromDate: string;
  throughDate: string;
  daybookCapturedAt?: string;
  salesCapturedAt?: string;
  salesThroughDate?: string;
  counts?: {
    daybookBills: number;
    salesBills: number;
    matchedBills: number;
    differentBills: number;
    onlyDaybook: number;
    onlySales: number;
  };
  differences?: {
    guid: string;
    reason: string;
    daybook?: ComparisonBill;
    sales?: ComparisonBill;
  }[];
  differenceCount?: number;
};
