export type RecordedTaxAmount = { name: string; kind: string; amount: string };
const cents = (value: string) => BigInt(value.replace(".", ""));
const decimal = (value: bigint) => {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

function taxKind(name: string) {
  for (const kind of ["CGST", "SGST", "IGST", "UTGST"])
    if (new RegExp(`(^|[^a-z])${kind.split("").join("[\\s._-]*")}([^a-z]|$)`, "i").test(name))
      return kind;
  if (/\bcess\b/i.test(name)) return "Cess";
  return null;
}

/** Signed original party total less explicitly named GST/cess ledgers. Never infer a tax rate. */
export function recordedLedgerAmounts(partyName: string, raw: unknown): {
  total: string | null;
  taxes: RecordedTaxAmount[];
  excludingGst: string | null;
} {
  const unavailable = { total: null, taxes: [], excludingGst: null };
  if (!Array.isArray(raw)) return unavailable;
  const party = partyName.trim().toLowerCase();
  let partyTotal = 0n;
  let hasParty = false;
  const taxes: RecordedTaxAmount[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") return unavailable;
    const entry = value as { name?: unknown; amount?: unknown };
    if (typeof entry.name !== "string" || typeof entry.amount !== "string" || !/^-?\d+\.\d{2}$/.test(entry.amount))
      return unavailable;
    if (party && entry.name.trim().toLowerCase() === party) {
      partyTotal -= cents(entry.amount);
      hasParty = true;
    } else {
      const kind = taxKind(entry.name);
      if (kind && cents(entry.amount) !== 0n) taxes.push({ name: entry.name, amount: entry.amount, kind });
    }
  }
  return {
    total: hasParty ? decimal(partyTotal) : null,
    taxes,
    excludingGst: hasParty ? decimal(partyTotal - taxes.reduce((sum, tax) => sum + cents(tax.amount), 0n)) : null,
  };
}
