export type DaybookVoucherSource = { jobId: string; voucherGuid: string };
export type DaybookBillProducts = {
  status: "matched" | "missing" | "ambiguous" | "unlinked";
  message?: string;
  bill?: {
    number: string;
    date: string;
    type: string;
    partyName: string;
    cancelled: boolean;
    optional: boolean;
    items: {
      lineNo: number;
      productName: string;
      quantity: string;
      unit: string;
      amount: string;
    }[];
  };
};
