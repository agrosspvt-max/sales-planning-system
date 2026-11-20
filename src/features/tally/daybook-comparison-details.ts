import type { DaybookProductVoucher } from "./daybook-products";
import type {
  ComparisonFieldChange,
  ComparisonItem,
  ComparisonProductChange,
  ComparisonLedgerChange,
} from "./daybook-sales-comparison";
export type ComparisonSourceBill = Omit<DaybookProductVoucher, "references">;
const whitespace = (text: string) => text.trim().replace(/\s+/g, " ");
const itemKey = (item: ComparisonSourceBill["items"][number]) =>
  JSON.stringify([
    item.stockItemName,
    item.quantity,
    item.unit,
    item.amount,
    whitespace(item.actualQty),
    whitespace(item.billedQty),
    whitespace(item.rate),
  ]);
const ledgerKey = (entry: { name: string; amount: string }) =>
  JSON.stringify([entry.name, entry.amount]);
export function comparisonSignature(bill: ComparisonSourceBill) {
  return JSON.stringify({
    date: bill.billDate,
    number: bill.billNumber,
    party: bill.partyName,
    type: bill.typeName,
    family: bill.family,
    cancelled: bill.cancelled,
    optional: bill.optional,
    ledgerEntries: bill.ledgerEntries.map(ledgerKey).sort(),
    items: bill.items.map(itemKey).sort(),
  });
}
// Cancel out identical occurrences, not just distinct values: repeated lines matter.
function unmatched<T>(a: T[], b: T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of b) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return a.filter((item) => {
    const remaining = counts.get(key(item)) ?? 0;
    if (!remaining) return true;
    counts.set(key(item), remaining - 1);
    return false;
  });
}
function copies<T>(items: T[], key: (item: T) => string) {
  const rows = new Map<string, T & { copies: number }>();
  for (const item of items) {
    const id = key(item),
      current = rows.get(id);
    rows.set(id, { ...item, copies: (current?.copies ?? 0) + 1 });
  }
  return [...rows.values()];
}
const itemDisplay = (item: ComparisonSourceBill["items"][number]): ComparisonItem => ({
  productName: item.stockItemName,
  quantity: item.quantity,
  unit: item.unit,
  amount: item.amount,
  actualQty: item.actualQty,
  billedQty: item.billedQty,
  rate: item.rate,
});
export function billMismatchDetails(a: ComparisonSourceBill, b: ComparisonSourceBill) {
  const fields: ComparisonFieldChange[] = [];
  const field = (label: string, left: string | boolean, right: string | boolean) => {
    if (left !== right)
      fields.push({
        field: label,
        daybook: typeof left === "boolean" ? (left ? "Yes" : "No") : left,
        sales: typeof right === "boolean" ? (right ? "Yes" : "No") : right,
      });
  };
  field("Bill number", a.billNumber, b.billNumber);
  field("Bill date", a.billDate, b.billDate);
  field("Dealer / party", a.partyName, b.partyName);
  field("Voucher type", a.typeName, b.typeName);
  field("Voucher family", a.family, b.family);
  field("Recorded cancelled", a.cancelled, b.cancelled);
  field("Recorded optional", a.optional, b.optional);
  const leftItems = unmatched(a.items, b.items, itemKey),
    rightItems = unmatched(b.items, a.items, itemKey);
  const productNames = [
    ...new Set([...leftItems, ...rightItems].map((item) => item.stockItemName)),
  ];
  const products: ComparisonProductChange[] = productNames.slice(0, 20).map((productName) => {
    const left = leftItems.filter((item) => item.stockItemName === productName),
      right = rightItems.filter((item) => item.stockItemName === productName);
    const changed = Object.entries({
      quantity: "Quantity",
      unit: "Unit",
      amount: "Item amount",
      actualQty: "Actual quantity text",
      billedQty: "Billed quantity text",
      rate: "Rate",
    }).flatMap(([key, label]) => {
      const values = (items: typeof left) =>
        JSON.stringify(
          items
            .map((item) =>
              key === "actualQty" || key === "billedQty" || key === "rate"
                ? whitespace(item[key])
                : item[key as "quantity" | "unit" | "amount"],
            )
            .sort(),
        );
      return values(left) !== values(right) ? [label] : [];
    });
    return {
      productName,
      fields: changed.length ? changed : ["Line combinations / repetitions"],
      daybook: copies(left, itemKey)
        .slice(0, 20)
        .map((item) => ({ ...itemDisplay(item), copies: item.copies })),
      sales: copies(right, itemKey)
        .slice(0, 20)
        .map((item) => ({ ...itemDisplay(item), copies: item.copies })),
      daybookLineCount: left.length,
      salesLineCount: right.length,
    };
  });
  const leftLedgers = unmatched(a.ledgerEntries, b.ledgerEntries, ledgerKey),
    rightLedgers = unmatched(b.ledgerEntries, a.ledgerEntries, ledgerKey);
  const ledgerNames = [...new Set([...leftLedgers, ...rightLedgers].map((entry) => entry.name))];
  const ledgers: ComparisonLedgerChange[] = ledgerNames.slice(0, 20).map((name) => {
    const left = leftLedgers.filter((entry) => entry.name === name),
      right = rightLedgers.filter((entry) => entry.name === name);
    return {
      name,
      daybook: copies(left, ledgerKey)
        .slice(0, 20)
        .map(({ amount, copies }) => ({ amount, copies })),
      sales: copies(right, ledgerKey)
        .slice(0, 20)
        .map(({ amount, copies }) => ({ amount, copies })),
      daybookLineCount: left.length,
      salesLineCount: right.length,
    };
  });
  return {
    fields,
    products,
    productDifferenceCount: productNames.length,
    ledgers,
    ledgerDifferenceCount: ledgerNames.length,
    reason:
      "Changed: " +
      [
        ...fields.map((entry) => entry.field),
        ...(productNames.length ? ["Product lines"] : []),
        ...(ledgerNames.length ? ["Ledger amounts"] : []),
      ].join(", "),
  };
}
