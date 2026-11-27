"use client";

import { formatCurrency } from "@/lib/utils";
import type { DealerSalesBill } from "./dealer-sales-bills";

const creditMoney = (amount: number) => amount.toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });
const date = (day: string) =>
  new Date(day + "T00:00:00Z").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export function DealerBillList({
  bills,
  productIds,
  categoryFiltered,
}: {
  bills: DealerSalesBill[];
  productIds: string[];
  categoryFiltered: boolean;
}) {
  const visible = bills
    .map((bill) => ({
      ...bill,
      items: categoryFiltered
        ? bill.items.filter((item) => item.productId && productIds.includes(item.productId))
        : bill.items,
    }))
    .filter((bill) => !categoryFiltered || bill.items.length > 0);
  const days = new Map<string, typeof visible>();
  for (const bill of visible) days.set(bill.date, [...(days.get(bill.date) ?? []), bill]);
  if (!visible.length)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No Tally bills for this selection. Product wise may include sales uploaded without bill
        details.
      </p>
    );
  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">
        {visible.length} vouchers · newest date first. Amounts below are product-line amounts before
        invoice taxes and charges. Credit notes without product lines show the credit amount excluding recorded GST.
        {categoryFiltered && " Only products in the selected category are shown."}
      </p>
      {visible.some((bill) => bill.items.some((item) => !item.productId)) && (
        <p className="text-xs text-muted-foreground">
          Some original Tally products are awaiting a website product match; their bill lines are
          shown here.
        </p>
      )}
      {[...days].map(([day, dayBills]) => (
        <section key={day} className="space-y-2" aria-label={date(day)}>
          <h3 className="text-sm font-semibold">{date(day)}</h3>
          {dayBills.map((bill) => (
            <details key={bill.id} className="rounded-md border">
              <summary className="cursor-pointer p-3 text-sm">
                <span className="font-medium">
                  {bill.number ? `Bill ${bill.number}` : "Voucher without number"}
                </span>
                <span className="ml-2 text-muted-foreground">{bill.type}</span>
                {bill.cancelled && <span className="ml-2 text-destructive">Cancelled</span>}
                {bill.optional && <span className="ml-2 text-muted-foreground">Optional</span>}
                {bill.items.length > 0 && (
                  <span className="ml-2 font-medium tabular-nums">
                    {formatCurrency(bill.items.reduce((total, item) => total + item.amount, 0))}
                  </span>
                )}
                {!bill.items.length && bill.family === "Credit Note" && (
                  <span className="ml-2 font-semibold tabular-nums text-destructive">
                    {bill.unallocatedAmount == null ? "Amount not recorded" : creditMoney(bill.unallocatedAmount)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">excl. GST</span>
                  </span>
                )}
              </summary>
              {(bill.cancelled || bill.optional) && (
                <p className="px-3 pb-2 text-xs text-muted-foreground">
                  This voucher is excluded from sales totals.
                </p>
              )}
              <div className="overflow-x-auto border-t">
                <table
                  className="w-full text-sm"
                  aria-label={`Products in bill ${bill.number || bill.guid}`}
                >
                  <thead className="bg-muted/30 text-left">
                    <tr>
                      <th scope="col" className="p-3">
                        Product
                      </th>
                      <th scope="col" className="p-3 text-right">
                        Qty
                      </th>
                      <th scope="col" className="p-3">
                        Unit
                      </th>
                      <th scope="col" className="p-3 text-right">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.items.map((item) => (
                      <tr key={item.lineNo} className="border-t">
                        <td className="p-3">
                          {item.productName}
                          {item.reviewNotice && <p role="status" className="mt-1 text-xs text-warning">{item.reviewNotice}</p>}
                          {!item.productId && (
                            <div className="text-xs text-muted-foreground">
                              Product match pending
                            </div>
                          )}
                        </td>
                        <td className="p-3 text-right tabular-nums">{qty.format(item.quantity)}</td>
                        <td className="p-3">{item.unit || "—"}</td>
                        <td className="whitespace-nowrap p-3 text-right tabular-nums">
                          {formatCurrency(item.amount)}
                        </td>
                      </tr>
                    ))}
                    {!bill.items.length && (
                      bill.family === "Credit Note" ? (
                        <tr className="bg-destructive/5 font-semibold text-destructive">
                          <td colSpan={3} className="p-3">Credit note without product lines (excl. GST)</td>
                          <td className="whitespace-nowrap p-3 text-right tabular-nums">
                            {bill.unallocatedAmount == null ? "Amount not recorded" : creditMoney(bill.unallocatedAmount)}
                          </td>
                        </tr>
                      ) : (
                        <tr>
                          <td colSpan={4} className="p-3 text-muted-foreground">
                            This voucher has no product lines.
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
