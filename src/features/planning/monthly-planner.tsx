"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Save, Ban, Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency } from "@/lib/utils";
import { amount, nbv, PLANNING_MODE_LABELS } from "@/lib/calc";
import { MONTH_STATUS_LABELS } from "./planning-state";
import { AdminEditBar, EditPlanButton, ChangeReviewDialog } from "./admin-edit-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { ProductName } from "@/components/ui/product-name";
import { CategoryFilter } from "@/components/ui/category-filter";
import { useCategories } from "@/lib/use-categories";
import { matchesCategoryFilter } from "@/lib/product-category";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Th, ThPlain } from "@/features/labels/label-ui";
import { useMonthlyEdit } from "./monthly-edit-context";
import type { MonthlyProductRow } from "./types";
import { DealerProgressBar, NoPlanDialog, type StatusCounts } from "./dealer-completion";
import { DealerPlanningStatus } from "./dealer-status";
import { AddDealerButton, EditDealerButton, AdditionalProductsSection } from "./monthly-additional-ui";

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
  const { data, monthlyPlanId, monthlyMode, qtyMode, cellFor, monthEditable, setCell, saving, flush, setAdditionalOpen,
    canAdminEdit, adminMode, adminSaving, adminError, enterAdminMode, cancelAdminMode, adminChanges, adminSave } = useMonthlyEdit();
  const qc = useQueryClient();
  const categories = useCategories();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("");

  // First-class Monthly Plan shows the Seasonal-style dealer progress (tick / colour / No Plan).
  const isFirstClass = !!monthlyPlanId;
  const [dealerId, setDealerId] = useState(isFirstClass ? "" : data.dealers[0]?.dealerId ?? "");
  const [monthId, setMonthId] = useState(data.months[0]?.id ?? "");
  const [noPlanOpen, setNoPlanOpen] = useState(false);

  // Actual-sales columns (This Month Sold, Pending (MO), Actual Amount) show ONLY when the MonthlyPlan
  // itself is APPROVED — never based on season/admin/completion/sales presence.
  const isApproved = data.status === "APPROVED";
  const fmtUnit = (v: number) => (qtyMode ? String(Math.round(v)) : formatCurrency(v));
  const dealer = data.dealers.find((d) => d.dealerId === dealerId);
  const unitLabel = PLANNING_MODE_LABELS[monthlyMode];
  const selMonth = data.months.find((m) => m.id === monthId);
  const editable = monthEditable(monthId);
  const inputsDisabled = !(editable || adminMode);

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

  // The product rows actually rendered (includes Additional Products, which live in dealer.products).
  const visibleProducts = useMemo(
    () => (dealer?.products ?? []).filter((p) => matchesCategoryFilter(p.nbvPercent, categoryFilter, categories)),
    [dealer, categoryFilter, categories],
  );
  // ONE per-row derivation reused by both the body rows AND the Total footer (no second calc system).
  const rowValues = useCallback((p: MonthlyProductRow) => {
    const totalPlanned = data.months.reduce((s, m) => s + cellFor(p.planLineId, m.id).plan, 0);
    const remaining = p.target - totalPlanned;
    const excess = Math.max(0, totalPlanned - p.target);
    const cur = cellFor(p.planLineId, monthId);
    const plannedAmount = qtyMode ? amount(cur.plan, p.rate) : cur.plan;
    const actualAmount = p.monthly[monthId]?.saleAmount ?? 0;
    const seasonSale = qtyMode ? (p.seasonSaleQty ?? 0) : (p.seasonSaleValue ?? 0);
    const seasonPending = p.target - seasonSale;
    const plannedNbv = nbv(plannedAmount, p.masterNbvPercent ?? p.nbvPercent);
    return { totalPlanned, remaining, excess, isOver: excess > 0, cur, plannedAmount, actualAmount, seasonSale, seasonPending, plannedNbv };
  }, [cellFor, monthId, qtyMode, data.months]);
  // Footer Total = mathematical aggregation of the SAME rendered rows (Additional Products included).
  const totals = useMemo(() => {
    const t = { seasonQty: 0, plannedAllMonths: 0, remaining: 0, seasonSale: 0, seasonPending: 0, thisMonthPlan: 0, thisMonthSold: 0, pendingMo: 0, plannedAmount: 0, plannedNbv: 0, actualAmount: 0 };
    for (const p of visibleProducts) {
      const v = rowValues(p);
      t.seasonQty += p.target;
      t.plannedAllMonths += v.totalPlanned;
      t.remaining += v.remaining;
      t.seasonSale += v.seasonSale;
      t.seasonPending += v.seasonPending;
      t.thisMonthPlan += v.cur.plan;
      t.thisMonthSold += v.cur.sale;
      t.pendingMo += v.cur.plan - v.cur.sale;
      t.plannedAmount += v.plannedAmount;
      t.plannedNbv += v.plannedNbv;
      t.actualAmount += v.actualAmount;
    }
    return t;
  }, [visibleProducts, rowValues]);

  return (
    // Flex column so the grid box (below) can fill the remaining height and own the single vertical
    // scroll when this planner is mounted inside a full-height (flex) dealer tab; falls back to normal
    // flow anywhere it is not.
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {canAdminEdit && !adminMode && (
        <div className="flex justify-end"><EditPlanButton onClick={enterAdminMode} /></div>
      )}
      {adminMode && <AdminEditBar onDone={() => setReviewOpen(true)} onCancel={cancelAdminMode} disabled={adminSaving} />}
      <ChangeReviewDialog
        open={reviewOpen}
        title={`Monthly Plan · ${data.seasonName}`}
        subtitle={data.monthName ?? ""}
        changes={adminMode ? adminChanges() : []}
        saving={adminSaving}
        error={adminError}
        onConfirm={(reason) => { adminSave(reason).then(() => setReviewOpen(false)).catch(() => {}); }}
        onClose={() => setReviewOpen(false)}
      />

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
          {/* Add an existing in-scope dealer or create a new one, directly from Monthly Planning. */}
          {isFirstClass && data.canEdit && monthlyPlanId && (
            <AddDealerButton monthlyPlanId={monthlyPlanId} onAdded={(id) => setDealerId(id)} />
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
          <CategoryFilter categories={categories} value={categoryFilter} onChange={setCategoryFilter} />
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

      <p className="hidden text-xs text-muted-foreground sm:block">
        Monthly mode: <span className="font-medium">{unitLabel}</span> — officers enter{" "}
        {qtyMode ? "a quantity" : `a ${unitLabel.toLowerCase()} value`} per month. Product Plan and Dealer Summary update live.
      </p>
      {data.canEdit && selMonth && !editable && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm text-warning">
          <AlertTriangle className="h-4 w-4" />
          {selMonth.name} is {MONTH_STATUS_LABELS[selMonth.status].toLowerCase()} — entry is read-only until management opens it.
        </div>
      )}

      {/* Horizontal scroll on small screens so the wide product grid never overflows the page (req #4).
          The Product column is frozen (stickyFirstColumn) so it stays visible while scrolling sideways. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
        <Table stickyFirstColumn stickyHeader>
          <TableHeader>
            <TableRow>
              <Th labelKey="col.product" className="min-w-[150px]" />
              <ThPlain className="text-right">Season {qtyMode ? "Qty" : unitLabel}</ThPlain>
              <Th labelKey="monthly.plannedAllMonths" className="text-right" />
              <Th labelKey="monthly.remaining" className="text-right" />
              <ThPlain className="text-right text-muted-foreground">Season Sales</ThPlain>
              <ThPlain className="text-right">Pending</ThPlain>
              <Th labelKey="monthly.thisMonthPlan" className="text-center" />
              {isApproved && <Th labelKey="monthly.thisMonthSold" className="text-center text-muted-foreground" />}
              {isApproved && <Th labelKey="monthly.pendingMo" className="text-right" />}
              <Th labelKey="monthly.plannedAmount" className="text-right" />
              <ThPlain className="text-right">Planned NBV</ThPlain>
              {isApproved && <Th labelKey="monthly.actualAmount" className="text-right text-muted-foreground" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleProducts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isApproved ? 12 : 9} className="py-8 text-center text-muted-foreground">
                  Nothing planned for this dealer in the approved season plan.
                </TableCell>
              </TableRow>
            ) : (
              visibleProducts.map((p) => {
                const { totalPlanned, remaining, excess, isOver, cur, plannedAmount, actualAmount, seasonSale, seasonPending, plannedNbv } = rowValues(p);
                return (
                  <TableRow key={p.planLineId} className={cn(isOver && "bg-warning/10")}>
                    <TableCell className="font-medium">
                      <ProductName name={p.productName} nbvPercent={p.nbvPercent} categories={categories} isClearance={p.isClearance} clearanceQty={p.clearanceQty}>
                        {p.isAdditional && <Badge variant="secondary" className="ml-2 align-middle text-[10px]">ADDITIONAL PRODUCT</Badge>}
                        {p.isAutoAdded && <Badge variant="default" className="ml-2 align-middle bg-info text-info-foreground text-[10px]">AUTO ADDED</Badge>}
                      </ProductName>
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
                    {/* Season Sales = total actual sales for the WHOLE season (all months), from the server. */}
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtUnit(seasonSale)}</TableCell>
                    {/* Pending = Season Qty − Season Sales (never clamped; negative = over-sold). */}
                    <TableCell className={cn("text-right tabular-nums", seasonPending < 0 && "text-destructive")}>{fmtUnit(seasonPending)}</TableCell>
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
                    {/* This Month Sold + Pending (MO) — actual-sales columns, only when the plan is APPROVED. */}
                    {isApproved && <TableCell className="text-center tabular-nums text-muted-foreground">{fmtUnit(cur.sale)}</TableCell>}
                    {isApproved && <TableCell className="text-right text-muted-foreground">{fmtUnit(cur.plan - cur.sale)}</TableCell>}
                    <TableCell className="text-right tabular-nums">{formatCurrency(plannedAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(plannedNbv)}</TableCell>
                    {isApproved && <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(actualAmount)}</TableCell>}
                  </TableRow>
                );
              })
            )}
          </TableBody>
          {/* Permanent Total footer — a dedicated summary row (NOT part of the product data array),
              so it is ALWAYS the last row (after any Additional Products) and can never be edited.
              Values are the aggregation of the SAME rowValues() used per row; the actual-sales
              columns follow the exact same isApproved gating as the body. */}
          {dealer && visibleProducts.length > 0 && (
            <tfoot>
              <TableRow className="border-t-2 bg-muted/60 font-semibold hover:bg-muted/60">
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right">{fmtUnit(totals.seasonQty)}</TableCell>
                <TableCell className="text-right">{fmtUnit(totals.plannedAllMonths)}</TableCell>
                <TableCell className={cn("text-right", totals.remaining < 0 && "text-destructive")}>{fmtUnit(totals.remaining)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUnit(totals.seasonSale)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", totals.seasonPending < 0 && "text-destructive")}>{fmtUnit(totals.seasonPending)}</TableCell>
                <TableCell className="text-center tabular-nums">{fmtUnit(totals.thisMonthPlan)}</TableCell>
                {isApproved && <TableCell className="text-center tabular-nums">{fmtUnit(totals.thisMonthSold)}</TableCell>}
                {isApproved && <TableCell className="text-right">{fmtUnit(totals.pendingMo)}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatCurrency(totals.plannedAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(totals.plannedNbv)}</TableCell>
                {isApproved && <TableCell className="text-right tabular-nums">{formatCurrency(totals.actualAmount)}</TableCell>}
              </TableRow>
            </tfoot>
          )}
        </Table>
      </div>
      <p className="hidden text-xs text-muted-foreground sm:block">
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
