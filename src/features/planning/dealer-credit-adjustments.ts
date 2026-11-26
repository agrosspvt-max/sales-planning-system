/** Dealer-level credits that have no stock lines. Product-linked deductions stay in product actuals. */
export interface DealerCreditNote {
  id: string;
  guid: string;
  monthKey: string;
  date: string;
  number: string;
  type: string;
  amount: number | null;
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

/** Original signed party-ledger total. No assumed tax rate or absolute-value conversion. */
export function recordedCreditAmount(partyName: string, raw: unknown): number | null {
  if (!partyName.trim() || !Array.isArray(raw)) return null;
  const party = partyName.trim().toLowerCase();
  const lines: bigint[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") return null;
    const line = value as { name?: unknown; amount?: unknown };
    if (
      typeof line.name !== "string" ||
      typeof line.amount !== "string" ||
      !/^-?\d+\.\d{2}$/.test(line.amount)
    )
      return null;
    if (line.name.trim().toLowerCase() === party) lines.push(BigInt(line.amount.replace(".", "")));
  }
  return lines.length ? amount(-lines.reduce((sum, line) => sum + line, 0n)) : null;
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
  const reduction = credit === 0n ? 0n : sales === 0n ? null : roundedRatio(credit * nbv, sales);
  return {
    notes,
    applied: true,
    creditAmount: amount(credit),
    nbvAdjustment: reduction === null ? null : amount(reduction),
    effectiveNbvRate: sales === 0n ? null : Number(nbv) / Number(sales),
    netSales: credit === 0n ? salesBeforeCredits : amount(sales + credit),
    netNbv: credit === 0n ? nbvBeforeCredits : reduction === null ? null : amount(nbv + reduction),
    ...(reduction === null
      ? { reason: "NBV cannot be adjusted because sales before other credits are zero." }
      : {}),
  };
}
