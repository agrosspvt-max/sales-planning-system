import { z } from "zod";
import { cents, decimal, tight, type BillResult, type ScopeAlias } from "./billwise";

const money = z.string().regex(/^-?\d+\.\d{2}$/);
export const recoveryEvidenceSchema = z.object({
  version: z.literal(1),
  companyName: z.string(),
  asOf: z.string(),
  observedAt: z.string(),
  ledgers: z.array(
    z.object({
      name: z.string(),
      dealerId: z.string(),
      reason: z.string(),
      guid: z.string().nullable(),
      closingOutstanding: money.nullable(),
      pendingTotal: money,
      difference: money.nullable(),
      bills: z.array(
        z.object({
          billDate: z.string(),
          reference: z.string(),
          pendingAmount: money,
          dueDate: z.string(),
        }),
      ),
    }),
  ),
});
export type RecoveryEvidence = z.infer<typeof recoveryEvidenceSchema>;
export type RecoveryLedgerEvidence = RecoveryEvidence["ledgers"][number];

/** Retain the exact checked source behind a hold, independently of published balances. */
export function recoveryEvidence(
  report: BillResult,
  aliases: ScopeAlias[],
  held: { name: string; reason: string }[],
): RecoveryEvidence {
  const ledgers = new Map(report.ledgers.map((row) => [tight(row.name), row]));
  const scope = new Map(aliases.map((row) => [tight(row.name), row]));
  const bills = new Map<string, BillResult["bills"]>();
  for (const bill of report.bills) {
    const key = tight(bill.partyName);
    const rows = bills.get(key) ?? [];
    rows.push(bill);
    bills.set(key, rows);
  }
  return {
    version: 1,
    companyName: report.companyName,
    asOf: report.asOf,
    observedAt: report.observedAt,
    ledgers: held.map((row) => {
      const key = tight(row.name),
        ledger = ledgers.get(key);
      const pending = bills.get(key) ?? [];
      const total = pending.reduce((sum, bill) => sum + cents(bill.pendingAmount), 0n);
      const closing = ledger ? -cents(ledger.closingBalance) : null;
      return {
        ...row,
        dealerId: scope.get(key)!.dealerId,
        guid: ledger?.guid ?? null,
        closingOutstanding: closing === null ? null : decimal(closing),
        pendingTotal: decimal(total),
        difference: closing === null ? null : decimal(closing - total),
        bills: pending.map(({ partyName: _party, ...bill }) => bill),
      };
    }),
  };
}

/** Detailed financial evidence is fetched only after opening the info dialog. */
export function publicRecoverySummary<T>(summary: T): T {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return summary;
  return Object.fromEntries(
    Object.entries(summary).filter(([key]) => key !== "_recoveryEvidence"),
  ) as T;
}
