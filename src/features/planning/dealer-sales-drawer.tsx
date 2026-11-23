"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { DealerBillList } from "./dealer-bill-list";
import { DealerProductSalesTable } from "./dealer-product-sales-table";
import type { DealerSalesBills } from "./dealer-sales-bills";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TerritoryDealerSummary } from "./group-dealer-summary";

export function DealerSalesDrawer({
  dealer,
  periodLabel,
  onClose,
  trigger,
  groupId,
  queryParams,
  categoryFiltered,
}: {
  dealer: TerritoryDealerSummary;
  periodLabel: string;
  onClose: () => void;
  trigger: HTMLButtonElement | null;
  groupId: string;
  queryParams: string;
  categoryFiltered: boolean;
}) {
  const [mode, setMode] = useState<"bill" | "product">("product");
  const params = new URLSearchParams(queryParams);
  params.set("dealerId", dealer.dealerId);
  const unplanned = params.get("unplanned") === "true";
  const selectedBuckets = (params.get("buckets") ?? "approved")
    .split(",")
    .filter((value) => ["approved", "submitted", "draft"].includes(value));
  const shownBuckets = selectedBuckets.length || unplanned ? selectedBuckets : ["approved"];
  const bills = useQuery<DealerSalesBills>({
    queryKey: ["dealer-sales-bills", groupId, params.toString()],
    queryFn: () => api.get(`/api/planning/groups/${groupId}/dealer-sales-bills?${params}`),
    refetchInterval: 60000,
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="bottom-0 left-auto right-0 top-0 flex w-full max-w-5xl translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:rounded-none"
        onCloseAutoFocus={(event) => {
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      >
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle>
            <DealerName id={dealer.dealerId} name={dealer.name} />
          </DialogTitle>
          <DialogDescription>{periodLabel}</DialogDescription>
          <p className="text-xs text-muted-foreground">
            Included plans: {shownBuckets.join(", ") || "none"} · Unplanned{" "}
            {unplanned ? "included" : "excluded"}
          </p>
        </DialogHeader>

        <div role="tablist" aria-label="Dealer sales view" className="flex gap-1 border-b px-4">
          {(
            [
              { key: "bill", label: "Bill wise" },
              { key: "product", label: "Product wise" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={mode === tab.key}
              onClick={() => setMode(tab.key)}
              className={cn(
                "border-b-2 px-3 py-3 text-sm font-medium",
                mode === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          role="tabpanel"
          aria-label={mode === "bill" ? "Bill wise sales" : "Product wise sales"}
        >
          {mode === "bill" ? (
            <>
              {bills.isPending && (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  Loading bills…
                </p>
              )}
              {bills.error && (
                <p role="alert" className="p-4 text-sm">
                  Unable to load bills.{" "}
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() => void bills.refetch()}
                  >
                    Try again
                  </button>
                </p>
              )}
              {!!bills.data?.heldMonths.length && (
                <p className="p-4 pb-0 text-sm text-muted-foreground">
                  Bill details from the latest read are awaiting review for{" "}
                  {bills.data.heldMonths.join(", ")}. Product totals retain the last verified
                  figures.
                </p>
              )}
              {bills.data && (
                <DealerBillList
                  key={
                    queryParams +
                    String(categoryFiltered) +
                    dealer.products.map((p) => p.productId).join(",")
                  }
                  bills={bills.data.bills}
                  productIds={dealer.products.map((p) => p.productId)}
                  categoryFiltered={categoryFiltered}
                />
              )}
            </>
          ) : (
            <DealerProductSalesTable
              dealer={dealer}
              data={bills.data}
              pending={bills.isPending}
              error={!!bills.error}
              retry={() => void bills.refetch()}
              categoryFiltered={categoryFiltered}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
