import type { DaybookBillAmounts } from "./daybook-bill-amounts";
export type DaybookVoucherSource = { jobId: string; voucherGuid: string };
export type DaybookBillProducts = {
  status: "matched" | "missing" | "ambiguous" | "unlinked";
  message?: string;
  source?: "daybook";
  capturedAt?: string;
  ownVoucher?: boolean;
  bill?: {
    number: string;
    date: string;
    type: string;
    partyName: string;
    cancelled: boolean;
    optional: boolean;
    amounts?: DaybookBillAmounts;
    ledgerEntries?: { name: string; amount: string }[];
    items: {
      lineNo: number;
      productName: string;
      quantity: string;
      unit: string;
      amount: string;
      actualQty?: string;
      billedQty?: string;
    }[];
  };
};
