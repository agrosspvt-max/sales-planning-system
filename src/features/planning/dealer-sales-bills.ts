export interface DealerSalesBill {
  id: string;
  guid: string;
  date: string;
  number: string;
  type: string;
  family: string;
  cancelled: boolean;
  optional: boolean;
  unallocatedAmount?: number | null;
  ledgerEntries?: { name: string; amount: string }[];
  items: {
    lineNo: number;
    productName: string;
    productId: string | null;
    reviewNotice?: string;
    excludedFromTotals?: boolean;
    quantity: number;
    unit: string;
    amount: number;
  }[];
}
export interface DealerSalesBills {
  bills: DealerSalesBill[];
  heldMonths: string[];
  productBreakdown?: DealerProductSalesBreakdown[];
  breakdownAvailable?: boolean;
}

export type SalesMeasure = { quantity: number; amount: number; units?: { unit: string; quantity: number }[] };
export interface DealerProductSalesBreakdown {
  productId: string;
  productName: string;
  sales: SalesMeasure;
  returns: SalesMeasure;
  creditNotes: SalesMeasure;
  net: SalesMeasure;
  reconciled: boolean;
}
