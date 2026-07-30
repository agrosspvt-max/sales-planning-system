"use client";

import Link from "next/link";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface PerfRowVM {
  id: string;
  label: string;
  planQty: number;
  actualQty: number;
  pendingQty: number;
  planAmount: number;
  actualAmount: number;
  achievementAmount: number;
  planNbv: number;
  actualNbv: number;
  status?: string;
  href?: string;
}

const qty = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/**
 * Reusable performance table for a set of entities (dealers or products). The label cell
 * becomes a link when `href` is present, enabling drill-down (Officer → Dealer).
 */
export function PerformanceTable({
  rows,
  labelHeader,
  emptyText = "Nothing planned yet.",
  showStatus = false,
}: {
  rows: PerfRowVM[];
  labelHeader: string;
  emptyText?: string;
  showStatus?: boolean;
}) {
  return (
    <div className="overflow-auto rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{labelHeader}</TableHead>
            <TableHead className="text-right">Plan Qty</TableHead>
            <TableHead className="text-right">Actual Qty</TableHead>
            <TableHead className="text-right">Pending</TableHead>
            <TableHead className="text-right">Plan Amt</TableHead>
            <TableHead className="text-right">Actual Amt</TableHead>
            <TableHead className="text-right">Achv %</TableHead>
            <TableHead className="text-right">NBV</TableHead>
            {showStatus && <TableHead>Status</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showStatus ? 9 : 8} className="py-8 text-center text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.href ? (
                    <Link href={r.href} className="text-primary hover:underline">
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{qty(r.planQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{qty(r.actualQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{qty(r.pendingQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.planAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.actualAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(r.achievementAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(r.planNbv)}</TableCell>
                {showStatus && (
                  <TableCell>
                    <Badge variant={r.status === "Inactive" ? "muted" : "success"}>{r.status ?? "—"}</Badge>
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
