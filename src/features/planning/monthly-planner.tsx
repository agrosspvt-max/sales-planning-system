"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Save, Ban, Plus } from "lucide-react";
import { api } from "@/lib/api-client";
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
import { DealerProgressBar, NoPlanDialog, type StatusCounts } from "./dealer-completion";
import { DealerPlanningStatus } from "./dealer-status";
import { CreateDealerButton, EditDealerButton, AdditionalProductsSection } from "./monthly-additional-ui";

const OPTION_COLOR: Record<DealerPlanningStatus, string | undefined> = {
  [DealerPlanningStatus.COMPLETED]: "hsl(var(--success))",
  [DealerPlanningStatus.NO_PLAN]: "hsl(var(--noplan))",
  [DealerPlanningStatus.REMAINING]: undefined,
};

/**
 * Dealer Monthly Plan — the editable Monthly page. Reads/writes the shared monthly-edit
 * context so Monthly Product Plan and Monthly Dealer Summary recompute live. Per the new
 * workflow the last two columns are Planned Amount and Planned NBV (previously Diff Amount
 * and Achievement %).
 */
export function MonthlyPlanner() {
  const { data, monthlyPlanId, monthlyMode, qtyMode, cellFor, monthEditable, setCell, saving, flush, setAdditionalOpen } = useMonthlyEdit();
  const qc = useQueryClient();

  // First-class Monthly Plan shows the Seasonal-style dealer progress (tick / colour / No Plan).
  const isFirstClass = !!monthlyPlanId;
  const [dealerId, setDealerId] = useState(isFirstClass ? "" : data.dealers[0]?.dealerId ?? "");
  const [monthId, setMonthId] = useState(data.months[0]?.id ?? "");
  const [noPlanOpen, setNoPlanOpen] = useState(false);

  const fmtUnit = (v: number) => (qtyMode ? String(Math.round(v)) : formatCurrency(v));
  const dealer = data.dealers.find((d) => d.dealerId === dealerId);
  const unitLabel = PLANNING_MODE_LABELS[monthlyMode];
  const selMonth = data.months.find((m) => m.id === monthId);
  const editable = monthEditable(monthId);
  const inputsDisabled = !editable;

  // Dealer completion (Completed = ≥1 monthly plan value; No Plan = flagged; else Remaining) —
  // the same three-state model and progress component as Seasonal Planning.
  const statusByDealer = useMemo(() => {
    const m = new Map<string, DealerPlanningStatus>();
    for (const d of data.dealers)
      m.set(d.dealerId, d.noPlan ? DealerPlanningStatus.NO_PLAN : d.completed ? DealerPlanningStatus.COMPLETED : DealerPlanningStatus.REMAINING);
    return m;
  }, [data.dealers]);
  const counts: StatusCounts = useMemo(() => {
    let completed = 0, noPlan = 0, remaining = 0;
    for (const s of statusByDealer.values()) {
      if (s === DealerPlanningStatus.COMPLETED) completed++;
      else if (s === DealerPlanningStatus.NO_PLAN) noPlan++;
      else remaining++;
    }
    return { completed, noPlan, remaining, total: statusByDealer.size };
  }, [statusByDealer]);
  const selectedStatus = dealer ? statusByDealer.get(dealer.dealerId) : undefined;

  const noPlanMut = useMutation({
    mutationFn: (vars: { noPlan: boolean; reason?: string }) =>
      api.post(`/api/planning/monthly-plans/${monthlyPlanId}/dealers/${dealerId}/no-plan`, vars),
    onSuccess: () => {
      setNoPlanOpen(false);
      qc.invalidateQueries({ queryKey: ["monthly-plan", monthlyPlanId] });
    },
  });

  // Only the PLAN is editable now. "This Month Sold" (actual) comes from the Sales Upload and
  // is read-only for everyone — Sales Officers can view but never enter actuals.
  const onChangePlan = (planLineId: string, raw: string) => {
    const parsed = Number(raw) || 0;
    setCell(planLineId, monthId, "plan", qtyMode ? Math.max(0, Math.floor(parsed)) : Math.max(0, parsed));
  };

  return (
    <div className="space-y-3">
      {/* Planning progress: Green Completed · Purple No Plan · Grey Remaining (same component). */}
      {isFirstClass && <DealerProgressBar counts={counts} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {isFirstClass ? (
            // Native select so each option can carry its status colour + tick (like Seasonal).
            <select
              className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm"
              value={dealerId}
              onChange={(e) => setDealerId(e.target.value)}
            >
              <option value="">Choose Dealer…</option>
              {data.dealers.map((d) => (
                <option key={d.dealerId} value={d.dealerId} style={{ color: OPTION_COLOR[statusByDealer.get(d.dealerId) ?? DealerPlanningStatus.REMAINING] }}>
                  {d.dealerName}
                  {statusByDealer.get(d.dealerId) === DealerPlanningStatus.COMPLETED ? " ✓" : statusByDealer.get(d.dealerId) === DealerPlanningStatus.NO_PLAN ? " ⦸" : ""}
                </option>
              ))}
            </select>
          ) : (
            <NativeSelect
              className="w-56"
              options={data.dealers.map((d) => ({ value: d.dealerId, label: d.dealerName }))}
              value={dealerId}
              onChange={(e) => setDealerId(e.target.value)}
            />
          )}
          {isFirstClass && data.canEdit && dealer && selectedStatus !== DealerPlanningStatus.NO_PLAN && (
            <Button variant="outline" size="sm" onClick={() => setNoPlanOpen(true)} className="text-noplan">
              <Ban className="h-4 w-4" /> No Plan
            </Button>
          )}
          {isFirstClass && data.canEdit && dealer && selectedStatus === DealerPlanningStatus.NO_PLAN && (
            <Button variant="outline" size="sm" onClick={() => noPlanMut.mutate({ noPlan: false })} disabled={noPlanMut.isPending}>
              Undo No Plan
            </Button>
          )}
          {/* NEW DEALER badge for dealers created from Monthly Planning. */}
          {isFirstClass && dealer?.isNewDealer && <Badge variant="default" className="bg-info text-info-foreground">NEW DEALER</Badge>}
          {/* Create a dealer directly from Monthly Planning (reuses the Dealer model). */}
          {isFirstClass && data.canEdit && monthlyPlanId && (
            <CreateDealerButton monthlyPlanId={monthlyPlanId} onCreated={(id) => setDealerId(id)} />
          )}
          {/* Edit a pending dealer created here (DRAFT/RETURNED only). */}
          {isFirstClass && data.canEdit && monthlyPlanId && dealer?.isNewDealer && (
            <EditDealerButton
              monthlyPlanId={monthlyPlanId}
              dealerId={dealer.dealerId}
              initial={{
                name: dealer.dealerName,
                mobile: dealer.contact?.mobile ?? undefined,
                village: dealer.contact?.village ?? undefined,
                tehsil: dealer.contact?.tehsil ?? undefined,
                district: dealer.contact?.district ?? undefined,
                address: dealer.contact?.address ?? undefined,
              }}
            />
          )}
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

      {/* Horizontal scroll on small screens so the wide product grid never overflows the page (req #4). */}
      <div className="overflow-x-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[150px]">Product</TableHead>
              <TableHead className="text-right">Season {qtyMode ? "Qty" : unitLabel}</TableHead>
              <TableHead className="text-right">Planned (all months)</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-center">This Month Plan</TableHead>
              <TableHead className="text-center text-muted-foreground">This Month Sold</TableHead>
              <TableHead className="text-right">Pending (mo)</TableHead>
              <TableHead className="text-right">Planned Amount</TableHead>
              <TableHead className="text-right text-muted-foreground">Actual Amount</TableHead>
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
                // Actual amount comes from the uploaded sales (saleValue) — not qty × rate.
                const actualAmount = p.monthly[monthId]?.saleAmount ?? 0;
                return (
                  <TableRow key={p.planLineId} className={cn(isOver && "bg-warning/10")}>
                    <TableCell className="font-medium">
                      {p.productName}
                      {p.isAdditional && <Badge variant="secondary" className="ml-2 align-middle text-[10px]">ADDITIONAL PRODUCT</Badge>}
                    </TableCell>
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
                        onChange={(e) => onChangePlan(p.planLineId, e.target.value)}
                      />
                    </TableCell>
                    {/* This Month Sold — read-only; sourced from the uploaded Sales Upload. */}
                    <TableCell className="text-center tabular-nums text-muted-foreground">{fmtUnit(cur.sale)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{fmtUnit(cur.plan - cur.sale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(plannedAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(actualAmount)}</TableCell>
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

      {/* Additional Products: plan products not in the approved Seasonal Plan (collapsed). */}
      {isFirstClass && monthlyPlanId && dealer && (
        <AdditionalProductsSection monthlyPlanId={monthlyPlanId} dealerId={dealer.dealerId} canEdit={data.canEdit} />
      )}

      {isFirstClass && dealer && (
        <NoPlanDialog
          open={noPlanOpen}
          dealerName={dealer.dealerName}
          onOpenChange={setNoPlanOpen}
          saving={noPlanMut.isPending}
          onConfirm={(reason) => {
            void flush().then(() => noPlanMut.mutate({ noPlan: true, reason }));
          }}
        />
      )}

      {/* Mobile-only Floating Action Button (req #1): always visible while scrolling, opens the
          Additional Products selector directly (context open-state + auto-scroll) without hunting
          at the bottom of the page. Desktop keeps the inline section only. */}
      {isFirstClass && data.canEdit && monthlyPlanId && dealer && (
        <Button
          onClick={() => setAdditionalOpen(true)}
          className="fixed bottom-20 right-4 z-40 rounded-full shadow-lg sm:hidden"
          size="sm"
        >
          <Plus className="h-4 w-4" /> Add Product
        </Button>
      )}
    </div>
  );
}
