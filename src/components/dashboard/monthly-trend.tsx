"use client";

import { formatPercent } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface MonthVM {
  id: string;
  label: string;
  plan: number;
  actual: number;
  achievement: number;
}

const num = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/** Reusable month-wise Plan / Actual / Achievement table (charts can layer on later). */
export function MonthlyTrend({ rows }: { rows: MonthVM[] }) {
  return (
    <div className="overflow-auto rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            <TableHead className="text-right">Plan</TableHead>
            <TableHead className="text-right">Actual</TableHead>
            <TableHead className="text-right">Difference</TableHead>
            <TableHead className="text-right">Achievement</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                No monthly data.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.label}</TableCell>
                <TableCell className="text-right tabular-nums">{num(m.plan)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(m.actual)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(m.actual - m.plan)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(m.achievement)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
