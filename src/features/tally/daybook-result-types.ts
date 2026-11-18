export type DaybookDealerRow = {
  key: string;
  dealerName: string;
  ledgers: string[];
  liveRecovery: string;
  srCr: string;
  other: string | null;
  status: string;
  reason?: string;
  candidates?: string[];
};
export type DaybookExcludedVoucher = {
  guid: string;
  date: string;
  voucherType: string;
  voucherNumber: string;
  reason: string;
  dealerName?: string;
  ledgerName?: string;
  amount?: string;
  direction?: "debit" | "credit" | "zero";
};
