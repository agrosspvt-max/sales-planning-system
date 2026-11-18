"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { MissingProductsStatus } from "./missing-products";

export function TallyMissingProducts() {
  const [month, setMonth] = useState("");
  const query = useQuery({
    queryKey: ["tally-missing-products"],
    queryFn: () => api.get<MissingProductsStatus>("/api/tally/missing-products"),
    refetchInterval: 30_000,
  });
  const rows = query.data?.products.filter((row) => !month || row.months.includes(month)) ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Tally stock items that need a product match. Updates when sales are refreshed from Tally.
      </p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isLoading && <p role="status">Loading missing products…</p>}
      {query.data?.configured === false && (
        <p className="text-sm">Configure the office connector to start.</p>
      )}
      {query.data?.configured && !query.data.months.length && (
        <p className="text-sm">Refresh a sales month from Tally to check its products.</p>
      )}
      {Boolean(query.data?.months.length) && (
        <>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Sales month
            <select
              className="rounded-md border bg-background px-3 py-2"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            >
              <option value="">All captured months</option>
              {query.data?.months.map(({ monthKey }) => (
                <option key={monthKey} value={monthKey}>
                  {monthKey}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm">{rows.length.toLocaleString("en-IN")} missing product entries</p>
          {rows.length ? (
            <div className="max-h-96 overflow-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Tally dealer
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Tally product
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Sales month
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={JSON.stringify([row.dealerName, row.stockItemName])}>
                      <td className="px-3 py-2">{row.dealerName}</td>
                      <td className="px-3 py-2">{row.stockItemName}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row.months.filter((value) => !month || value === month).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm">All captured products matched for this selection.</p>
          )}
        </>
      )}
    </div>
  );
}
