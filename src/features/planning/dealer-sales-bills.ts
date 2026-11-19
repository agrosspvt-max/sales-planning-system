export interface DealerSalesBill {
  id: string;
  guid: string;
  date: string;
  number: string;
  type: string;
  family: string;
  cancelled: boolean;
  optional: boolean;
  items: {
    lineNo: number;
    productName: string;
    productId: string | null;
    quantity: number;
    unit: string;
    amount: number;
  }[];
}
export interface DealerSalesBills {
  bills: DealerSalesBill[];
  heldMonths: string[];
}
