import type { DaybookProductVoucher } from "./daybook-products";

export type DaybookBillHeader = {
  subtotal: string | null;
  family: "Sales" | "Credit Note";
  active: boolean;
  hasProducts?: boolean;
  hasQuantity?: boolean | null;
  isSalesReturn?: boolean;
};
export type DaybookBillHeaders = Record<string, DaybookBillHeader>;
export type DaybookBillAmounts = {
  subtotal: string | null;
  taxes: { name: string; kind: string; amount: string }[];
  adjustments: string | null;
  total: string | null;
};

const cents = (value: string) => {
  if (!/^-?\d+\.\d{2}$/.test(value)) throw new Error("Invalid display amount");
  return BigInt(value.replace(".", ""));
};
const decimal = (value: bigint) => {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};
export function sumDisplayAmounts(values: (string | null | undefined)[]) {
  return values.some((value) => value == null)
    ? null
    : decimal(values.reduce<bigint>((sum, value) => sum + cents(value!), 0n));
}

function taxKind(name: string) {
  for (const kind of ["CGST", "SGST", "IGST", "UTGST"])
    if (new RegExp(`(^|[^a-z])${kind.split("").join("[\\s._-]*")}([^a-z]|$)`, "i").test(name))
      return kind;
  if (/\bcess\b/i.test(name)) return "Cess";
  return null;
}

// Presentation only. Product and party amounts retain Sales/Credit Note signs.
// Tax is identified from ledger names, never guessed from an effective rate.
export function daybookBillAmounts(bill: DaybookProductVoucher): DaybookBillAmounts {
  const subtotal = bill.items.length
    ? sumDisplayAmounts(bill.items.map((item) => item.amount))
    : null;
  const party = bill.partyName.trim().toLowerCase();
  const partyLines = party
    ? bill.ledgerEntries.filter((entry) => entry.name.trim().toLowerCase() === party)
    : [];
  const total = partyLines.length
    ? decimal(-partyLines.reduce((sum, entry) => sum + cents(entry.amount), 0n))
    : null;
  const taxes = bill.ledgerEntries.flatMap((entry) => {
    if (entry.name.trim().toLowerCase() === party) return [];
    const kind = taxKind(entry.name);
    return kind && cents(entry.amount) !== 0n ? [{ ...entry, kind }] : [];
  });
  const adjustments =
    subtotal !== null && total !== null
      ? decimal(
          cents(total) -
            cents(subtotal) -
            taxes.reduce((sum, entry) => sum + cents(entry.amount), 0n),
        )
      : null;
  return { subtotal, taxes, adjustments, total };
}

export function daybookBillHeaders(vouchers: DaybookProductVoucher[]): DaybookBillHeaders {
  return Object.fromEntries(
    vouchers.map((bill) => [
      bill.guid.toLowerCase(),
      {
        subtotal: bill.items.length
          ? sumDisplayAmounts(bill.items.map((item) => item.amount))
          : null,
        family: bill.family,
        active: !bill.cancelled && !bill.optional,
        ...(bill.family === "Credit Note"
          ? {
              hasProducts: bill.items.length > 0,
              hasQuantity: billQuantityPresence(bill),
              isSalesReturn: /\bSALES[\s_-]*RETURN\b/i.test(bill.typeName),
            }
          : {}),
      },
    ]),
  );
}

// Any non-zero stock line counts, including actual quantity on a zero-billed line.
// Inspect lines independently: opposite quantities must never cancel into "without qty".
function billQuantityPresence(bill: DaybookProductVoucher): boolean | null {
  const rawQuantity = (value: string): boolean | null => {
    if (!value.trim()) return false;
    const match = value
      .trim()
      .match(
        /^([+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))\s+[^\s=\x00-\x1f]{1,40}(?:\s*=\s*[+-]?[0-9]+(?:\.[0-9]+)?\s+[^\x00-\x1f]{1,40})?$/,
      );
    return match && Number.isFinite(Number(match[1])) ? Number(match[1]) !== 0 : null;
  };
  const presence = bill.items.flatMap((item) => [
    Number(item.quantity) !== 0,
    rawQuantity(item.actualQty),
    rawQuantity(item.billedQty),
  ]);
  return presence.includes(true) ? true : presence.includes(null) ? null : false;
}
