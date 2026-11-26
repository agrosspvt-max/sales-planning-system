import { recordedLedgerAmounts } from "@/lib/tally-ledger-amounts";
/** Dealer-level credits that have no stock lines. Product-linked deductions stay in product actuals. */
export interface DealerCreditNote {
  id: string;
  guid: string;
  monthKey: string;
  date: string;
  number: string;
  type: string;
  amount: number | null;
  grossAmount?: number | null;
  taxes?: { name: string; kind: string; amount: string }[];
}
export interface DealerCreditRecord {
  dealerId: string;
  name: string;
  notes: DealerCreditNote[];
  unavailable: boolean;
}
export interface DealerCreditAdjustment {
  notes: DealerCreditNote[];
  applied: boolean;
  creditAmount: number | null;
  nbvAdjustment: number | null;
  effectiveNbvRate: number | null;
  netSales: number | null;
  netNbv: number | null;
  reason?: string;
  nbvPending?: boolean;
}
const cents = (value: number) => BigInt(value.toFixed(2).replace(".", ""));
const amount = (value: bigint) => Number(value) / 100;
function roundedRatio(numerator: bigint, denominator: bigint) {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n + d / 2n) / d;
  return negative ? -rounded : rounded;
}

/** Preserve the NBV proportion of this sales base, using signed paise throughout. */
export function proportionalCreditTotals(
  salesBeforeCredits: number,
  nbvBeforeCredits: number,
  creditAmount: number | null,
) {
  if (creditAmount === null)
    return { nbvAdjustment: null, netSales: null, netNbv: null };
  if (creditAmount === 0)
    return { nbvAdjustment: 0, netSales: salesBeforeCredits, netNbv: nbvBeforeCredits };
  const sales = cents(salesBeforeCredits);
  const nbv = cents(nbvBeforeCredits);
  const credit = cents(creditAmount);
  const reduction = sales === 0n ? null : roundedRatio(credit * nbv, sales);
  return {
    nbvAdjustment: reduction === null ? null : amount(reduction),
    netSales: amount(sales + credit),
    netNbv: reduction === null ? null : amount(nbv + reduction),
  };
}

/** Signed credit excluding the recorded GST/cess. No assumed rate or absolute-value conversion. */
export function recordedCreditAmount(partyName: string, raw: unknown): number | null {
  const value = recordedLedgerAmounts(partyName, raw).excludingGst;
  return value === null ? null : Number(value);
}

export function dealerCreditAdjustment(
  salesBeforeCredits: number,
  nbvBeforeCredits: number,
  record: Pick<DealerCreditRecord, "notes" | "unavailable">,
  categoryFiltered = false,
): DealerCreditAdjustment {
  const notes = [...new Map(record.notes.map((note) => [note.id, note])).values()];
  if (categoryFiltered)
    return {
      notes,
      applied: false,
      creditAmount: 0,
      nbvAdjustment: 0,
      effectiveNbvRate: null,
      netSales: salesBeforeCredits,
      netNbv: nbvBeforeCredits,
      reason: "Credits without products apply only with All Categories selected.",
    };
  if (record.unavailable || notes.some((note) => note.amount == null))
    return {
      notes,
      applied: true,
      creditAmount: null,
      nbvAdjustment: null,
      effectiveNbvRate: null,
      netSales: null,
      netNbv: null,
      reason:
        "Complete credit-note amounts are unavailable for this period. Refresh the Sales months or review dealer mappings.",
    };
  const sales = cents(salesBeforeCredits),
    nbv = cents(nbvBeforeCredits);
  const credit = notes.reduce((sum, note) => sum + cents(note.amount!), 0n);
  const totals = proportionalCreditTotals(salesBeforeCredits, nbvBeforeCredits, amount(credit));
  return {
    notes,
    applied: true,
    creditAmount: amount(credit),
    ...totals,
    effectiveNbvRate: sales === 0n ? null : Number(nbv) / Number(sales),
    ...(totals.netNbv === null
      ? { reason: "NBV cannot be adjusted because sales before other credits are zero." }
      : {}),
  };
}
