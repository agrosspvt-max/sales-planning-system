import type { DaybookDiagnostics } from "./daybook-diagnostics";
import type { DaybookBillHeaders } from "./daybook-bill-amounts";
import type { DaybookDealerRow, DaybookExcludedVoucher } from "./daybook-result-types";

type LedgerAmounts = { ledgerName: string; liveRecovery: string; srCr: string };
export type DaybookSummary = {
  billHeaders?: DaybookBillHeaders;
  diagnostics?: DaybookDiagnostics;
  changedRows?: number;
  matchedDealers?: number;
  receiptCount?: number;
  srCrCount?: number;
  excluded?: number;
  excludedVouchers?: DaybookExcludedVoucher[];
  dealerRows?: DaybookDealerRow[];
  coverage?: string;
  unmatched?: (LedgerAmounts & { candidates: string[]; reason?: string })[];
  excludedAccounts?: LedgerAmounts[];
  recoveryIssues?: { dealerName: string; issue: string }[];
  heldPrevious?: string[];
  review?: {
    guid: string;
    date: string;
    voucherType: string;
    voucherNumber: string;
    reason: string;
    details?: DaybookDiagnostics;
  }[];
};
export type DaybookMonthStatus = {
  month: string;
  configured: boolean;
  job: { status: string; error: string | null; summary: DaybookSummary | null } | null;
  published: {
    id: string;
    completedAt: string;
    throughDate: string;
    summary: DaybookSummary;
  } | null;
};
export type DaybookRangeStatus = {
  configured: boolean;
  fromMonth: string;
  toMonth: string;
  months: DaybookMonthStatus[];
};
export function summaryDealerRows(summary: DaybookSummary): DaybookDealerRow[] {
  return (
    summary.dealerRows ?? [
      ...(summary.unmatched ?? []).map((row) => ({
        key: "ledger:" + row.ledgerName,
        dealerName: row.ledgerName,
        ledgers: [row.ledgerName],
        liveRecovery: row.liveRecovery,
        srCr: row.srCr,
        other: null,
        status: "Needs dealer link",
        candidates: row.candidates,
        reason:
          row.reason ??
          (row.candidates.length
            ? "Possible name matches only; confirm a Dealer Alias."
            : "No exact website name or Dealer Alias matches."),
      })),
      ...(summary.excludedAccounts ?? []).map((row) => ({
        key: "ledger:" + row.ledgerName,
        dealerName: row.ledgerName,
        ledgers: [row.ledgerName],
        liveRecovery: row.liveRecovery,
        srCr: row.srCr,
        other: null,
        status: "Accounting ledger",
        reason: "Excluded from dealer Recovery figures.",
      })),
    ]
  );
}
