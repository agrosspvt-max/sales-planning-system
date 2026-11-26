import { salesUnit } from "@/features/tally/sales-units";
import type {
  DealerProductSalesBreakdown,
  DealerSalesBill,
  SalesMeasure,
} from "./dealer-sales-bills";

type ExpectedProduct = {
  productId: string;
  productName: string;
  actualQty: number;
  actualAmount: number;
};
type IntegerMeasure = { quantity: bigint; amount: bigint; units?: Map<string, bigint> };
const scaled = (value: number, places: number) => BigInt(value.toFixed(places).replace(".", ""));
const empty = (): IntegerMeasure => ({ quantity: 0n, amount: 0n });
const numbers = (value: IntegerMeasure): SalesMeasure => ({
  quantity: (value.units?.size ?? 0) > 1 ? 0 : Number(value.quantity) / 1_000_000,
  ...(value.units ? { units: [...value.units].map(([unit, quantity]) => ({ unit, quantity: Number(quantity) / 1_000_000 })) } : {}),
  amount: Number(value.amount) / 100,
});
export function sameSalesMeasure(left: SalesMeasure, right: SalesMeasure) {
  return (
    scaled(left.quantity, 6) === scaled(right.quantity, 6) &&
    scaled(left.amount, 2) === scaled(right.amount, 2)
  );
}
export function sumSalesMeasures(values: SalesMeasure[]): SalesMeasure {
  const units = new Map<string, bigint>();
  for (const value of values) for (const entry of value.units ?? [])
    units.set(entry.unit, (units.get(entry.unit) ?? 0n) + scaled(entry.quantity, 6));
  return numbers({
    ...values.reduce(
      (sum, value) => ({
        quantity: sum.quantity + scaled(value.quantity, 6),
        amount: sum.amount + scaled(value.amount, 2),
      }),
      empty(),
    ),
    ...(units.size ? { units } : {}),
  });
}

// The source voucher family/type defines the split. Never classify an already
// netted product balance as gross sales, or subtract credits from that balance again.
export function dealerSalesBreakdown(
  bills: DealerSalesBill[],
  expected: ExpectedProduct[],
  heldMonths: string[] = [],
  historyComplete = true,
): DealerProductSalesBreakdown[] {
  const known = new Map(expected.map((row) => [row.productId, row]));
  const rows = new Map<
    string,
    {
      name: string;
      sales: IntegerMeasure;
      returns: IntegerMeasure;
      creditNotes: IntegerMeasure;
    }
  >();
  for (const bill of bills) {
    if (bill.cancelled || bill.optional || !["Sales", "Credit Note"].includes(bill.family))
      continue;
    const kind =
      bill.family === "Sales"
        ? "sales"
        : /\bSALES?\s*RETURNS?\b/.test(bill.type.toUpperCase().replace(/[^A-Z0-9]/g, " "))
          ? "returns"
          : "creditNotes";
    for (const item of bill.items) {
      if (!item.productId) continue;
      const row = rows.get(item.productId) ?? {
        name: known.get(item.productId)?.productName ?? item.productName,
        sales: empty(),
        returns: empty(),
        creditNotes: empty(),
      };
      row[kind].quantity += scaled(item.quantity, 6);
      row[kind].amount += scaled(item.amount, 2);
      if (item.quantity) {
        const units = row[kind].units ?? new Map<string, bigint>();
        const unit = salesUnit(item.unit);
        units.set(unit, (units.get(unit) ?? 0n) + scaled(item.quantity, 6));
        row[kind].units = units;
      }
      rows.set(item.productId, row);
    }
  }
  for (const row of expected) {
    if (!rows.has(row.productId))
      rows.set(row.productId, {
        name: row.productName,
        sales: empty(),
        returns: empty(),
        creditNotes: empty(),
      });
  }
  return [...rows].map(([productId, row]) => {
    const sales = numbers(row.sales),
      returns = numbers(row.returns),
      creditNotes = numbers(row.creditNotes);
    const net = sumSalesMeasures([sales, returns, creditNotes]);
    const original = known.get(productId);
    return {
      productId,
      productName: row.name,
      sales,
      returns,
      creditNotes,
      net,
      reconciled:
        historyComplete &&
        !heldMonths.length &&
        sameSalesMeasure(net, {
          quantity: original?.actualQty ?? 0,
          amount: original?.actualAmount ?? 0,
        }),
    };
  });
}
