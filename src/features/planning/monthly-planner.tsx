"use client";

import { useState } from "react";
import { AlertTriangle, Save } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { amount, nbv, PLANNING_MODE_LABELS } from "@/lib/calc";
import { MONTH_STATUS_LABELS } from "./planning-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMonthlyEdit } from "./monthly-edit-context";

/**
 * Dealer Monthly Plan — the editable Monthly page. Reads/writes the shared monthly-edit
 * context so Monthly Product Plan and Monthly Dealer Summary recompute live. Per the new
 * workflow the last two columns are Planned Amount and Planned NBV (previously Diff Amount
 * and Achievement %).
 */
export function MonthlyPlanner() {
  const { data, monthlyMode, qtyMode, cellFor, monthEditable, setCell, saving, flush } = useMonthlyEdit();

  const [dealerId, setDealerId] = useState(data.dealers[0]?.dealerId ?? "");
  const [monthId, setMonthId] = useState(data.months[0]?.id ?? "");

  const fmtUnit = (v: number) => (qtyMode ? String(Math.round(v)) : formatCurrency(v));
  const dealer = data.dealers.find((d) => d.dealerId === dealerId);
  const unitLabel = PLANNING_MODE_LABELS[monthlyMode];
  const selMonth = data.months.find((m) => m.id === monthId);
  const editable = monthEditable(monthId);
  const inputsDisabled = !editable;

  const onChange = (planLineId: string, field: "plan" | "sale", raw: string) => {
    const parsed = Number(raw) || 0;
    setCell(planLineId, monthId, field, qtyMode ? Math.max(0, Math.floor(parsed)) : Math.max(0, parsed));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            className="w-56"
            options={data.dealers.map((d) => ({ value: d.dealerId, label: d.dealerName }))}
            value={dealerId}
            onChange={(e) => setDealerId(e.target.value)}
          />
          {/* A first-class Monthly Plan is exactly ONE month — no in-page month selector. */}
          {data.months.length > 1 ? (
            <NativeSelect
              className="w-48"
              options={data.months.map((m) => ({
                value: m.id,
                label: m.status === "OPEN" ? m.name : `${m.name} · ${MONTH_STATUS_LABELS[m.status]}`,
              }))}
              value={monthId}
              onChange={(e) => setMonthId(e.target.value)}
            />
          ) : (
            selMonth && <Badge variant="muted" className="text-sm">{selMonth.name}</Badge>
          )}
          {selMonth && data.months.length > 1 && (
            <Badge variant={selMonth.status === "OPEN" ? "success" : "muted"}>{MONTH_STATUS_LABELS[selMonth.status]}</Badge>
          )}
        </div>
        {data.canEdit && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{saving ? "Saving…" : "Saved"}</span>
            <Button size="sm" variant="outline" onClick={() => flush()} disabled={saving}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Monthly mode: <span className="font-medium">{unitLabel}</span> — officers enter{" "}
        {qtyMode ? "a quantity" : `a ${unitLabel.toLowerCase()} value`} per month. Product Plan and Dealer Summary update live.
      </p>
      {data.canEdit && selMonth && !editable && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm text-warning">
          <AlertTriangle className="h-4 w-4" />
          {selMonth.name} is {MONTH_STATUS_LABELS[selMonth.status].toLowerCase()} — entry is read-only until management opens it.
        </div>
      )}

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[150px]">Product</TableHead>
              <TableHead className="text-right">Season {qtyMode ? "Qty" : unitLabel}</TableHead>
              <TableHead className="text-right">Planned (all months)</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-center">This Month Plan</TableHead>
              <TableHead className="text-center">This Month Sold</TableHead>
              <TableHead className="text-right">Pending (mo)</TableHead>
              <TableHead className="text-right">Planned Amount</TableHead>
              <TableHead className="text-right">Planned NBV</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!dealer || dealer.products.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  Nothing planned for this dealer in the approved season plan.
                </TableCell>
              </TableRow>
            ) : (
              dealer.products.map((p) => {
                const totalPlanned = data.months.reduce((s, m) => s + cellFor(p.planLineId, m.id).plan, 0);
                const remaining = p.target - totalPlanned;
                const excess = Math.max(0, totalPlanned - p.target);
                const isOver = excess > 0;
                const cur = cellFor(p.planLineId, monthId);
                const plannedAmount = qtyMode ? amount(cur.plan, p.rate) : cur.plan;
                const plannedNbv = nbv(plannedAmount, p.nbvPercent);
                return (
                  <TableRow key={p.planLineId} className={cn(isOver && "bg-warning/10")}>
                    <TableCell className="font-medium">{p.productName}</TableCell>
                    <TableCell className="text-right">{fmtUnit(p.target)}</TableCell>
                    <TableCell className="text-right">
                      {fmtUnit(totalPlanned)}
                      {isOver && (
                        <Badge variant="destructive" className="ml-1">
                          <AlertTriangle className="mr-1 h-3 w-3" />+{fmtUnit(excess)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className={cn("text-right", remaining < 0 && "text-destructive")}>{fmtUnit(remaining)}</TableCell>
                    <TableCell className="p-1 text-center">
                      <Input
                        type="number"
                        min={0}
                        step={qtyMode ? 1 : "0.01"}
                        className="h-8 w-20 text-center"
                        value={cur.plan === 0 ? "" : cur.plan}
                        placeholder="0"
                        disabled={inputsDisabled}
                        onChange={(e) => onChange(p.planLineId, "plan", e.target.value)}
                      />
                    </TableCell>
                    <TableCell className="p-1 text-center">
                      <Input
                        type="number"
                        min={0}
                        step={qtyMode ? 1 : "0.01"}
                        className="h-8 w-20 text-center"
                        value={cur.sale === 0 ? "" : cur.sale}
                        placeholder="0"
                        disabled={inputsDisabled}
                        onChange={(e) => onChange(p.planLineId, "sale", e.target.value)}
                      />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{fmtUnit(cur.plan - cur.sale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(plannedAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(plannedNbv)}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Over-planning is allowed. Rows where monthly plans exceed the approved season figure are highlighted; submission is never blocked.
      </p>
    </div>
  );
}
