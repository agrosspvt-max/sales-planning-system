"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";
import { figuresForMode, nbv as calcNbv, isQuantityMode, type PlanningMode } from "@/lib/calc";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { SectionColgroup } from "@/components/ui/table-group";
import { Th, LabelSectionHeaderRow, type LabelSection } from "@/features/labels/label-ui";
import { ProductName } from "@/components/ui/product-name";
import { useCategories } from "@/lib/use-categories";

/**
 * Read-only MONTH VIEW of an approved Seasonal Plan's Dealer Plan. It is a VIEW only — it never
 * writes and never touches Seasonal Planning. It reuses the EXACT monthly pipeline that already
 * powers the Product Plan / Dealer Summary month filters (`getApprovedMonthlyForSeasonPlan` +
 * `lib/calc`); no calculation is duplicated. The Planning input section is hidden and "Total Qty"
 * becomes "Monthly Planned Qty" (the approved monthly plan for the selected month). If no approved
 * Monthly Plan exists for the month, every monthly-derived value shows 0 and a banner is shown.
 */

interface AMProduct {
  productId: string;
  productName: string;
  rate: number;
  nbvPercent: number;
  isClearance?: boolean;
  clearanceQty?: number | null;
  target: number;
  monthly: Record<string, { plan: number; sale: number; saleAmount: number }>;
}
interface AMDealer { dealerId: string; dealerName: string; products: AMProduct[] }
interface ApprovedMonthly {
  monthlyMode: PlanningMode;
  months: { id: string; name: string; order: number }[];
  dealers: AMDealer[];
}

const fmtNum = (n: number) => String(Math.round(n));

export function PlanGridMonthView({
  seasonPlanId,
  dealerId,
  monthId,
  monthName,
}: {
  seasonPlanId: string;
  dealerId: string;
  monthId: string;
  monthName: string;
}) {
  const { data, isLoading } = useQuery<ApprovedMonthly>({
    queryKey: ["approved-monthly", seasonPlanId],
    queryFn: () => api.get(`/api/planning/season-plans/${seasonPlanId}/approved-monthly`),
  });
  const categories = useCategories();

  // The month has monthly data only if an APPROVED monthly plan exists for it.
  const monthApproved = !!data?.months.some((m) => m.id === monthId);
  const dealer = data?.dealers.find((d) => d.dealerId === dealerId);
  const mode = data?.monthlyMode ?? "PACK_SIZE";
  const qtyMode = isQuantityMode(mode);

  const rows = useMemo(() => {
    if (!data || !dealer || !monthApproved) return [];
    return dealer.products.map((p) => {
      const planInput = p.monthly[monthId]?.plan ?? 0;
      const saleInput = p.monthly[monthId]?.sale ?? 0;
      const saleAmount = p.monthly[monthId]?.saleAmount ?? 0;
      const planFig = figuresForMode(mode, planInput, p.rate, p.nbvPercent);
      const saleFig = figuresForMode(mode, saleInput, p.rate, p.nbvPercent);
      // Season − Month = season target (in the monthly unit) minus what is planned across ALL months.
      const totalPlannedInput = data.months.reduce((s, m) => s + (p.monthly[m.id]?.plan ?? 0), 0);
      return {
        productId: p.productId,
        productName: p.productName,
        nbvPercent: p.nbvPercent,
        isClearance: p.isClearance ?? false,
        clearanceQty: p.clearanceQty ?? null,
        monthlyPlannedQty: planFig.totalQty ?? 0,
        amount: planFig.amount,
        nbv: planFig.nbv,
        actualQty: saleFig.totalQty ?? 0,
        actualAmount: saleAmount,
        actualNbv: calcNbv(saleAmount, p.nbvPercent),
        // For a single month, the "live" monthly plan IS this month's plan (same figures).
        liveQty: planFig.totalQty ?? 0,
        liveAmount: planFig.amount,
        liveNbv: planFig.nbv,
        seasonMinusMonth: p.target - totalPlannedInput,
        pending: planInput - saleInput,
      };
    });
  }, [data, dealer, monthApproved, monthId, mode]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (t, r) => ({
          monthlyPlannedQty: t.monthlyPlannedQty + r.monthlyPlannedQty,
          amount: t.amount + (r.amount ?? 0),
          nbv: t.nbv + (r.nbv ?? 0),
          actualQty: t.actualQty + r.actualQty,
          actualAmount: t.actualAmount + r.actualAmount,
          actualNbv: t.actualNbv + r.actualNbv,
          liveQty: t.liveQty + r.liveQty,
          liveAmount: t.liveAmount + (r.liveAmount ?? 0),
          liveNbv: t.liveNbv + (r.liveNbv ?? 0),
          seasonMinusMonth: t.seasonMinusMonth + r.seasonMinusMonth,
          pending: t.pending + r.pending,
        }),
        { monthlyPlannedQty: 0, amount: 0, nbv: 0, actualQty: 0, actualAmount: 0, actualNbv: 0, liveQty: 0, liveAmount: 0, liveNbv: 0, seasonMinusMonth: 0, pending: 0 },
      ),
    [rows],
  );

  // Excel-style sections mirror the Dealer Plan layout, minus the Planning input section.
  const sections: LabelSection[] = [
    { labelKey: "monthView.section.monthlyPlan", span: 3, tone: "slate" },
    { labelKey: "seasonal.section.actualSales", span: 3, tone: "green" },
    { labelKey: "seasonal.section.liveMonth", span: 5, tone: "amber" },
  ];

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-3">
      {!monthApproved && (
        <div className="flex items-center gap-2 rounded-md border border-info/40 bg-info/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4" /> Monthly Planning has not started for {monthName}.
        </div>
      )}

      <div className="overflow-auto rounded-lg border bg-background">
        <Table stickyFirstColumn>
          <SectionColgroup leading={1} sections={sections} />
          <TableHeader>
            <LabelSectionHeaderRow leading={1} sections={sections} />
            <TableRow>
              <Th labelKey="col.product" className="min-w-[160px]" />
              <Th labelKey="monthView.monthlyPlannedQty" className="text-right" />
              <Th labelKey="col.amount" className="text-right" />
              <Th labelKey="col.nbv" className="text-right" />
              <Th labelKey="col.actualQty" className="text-right text-muted-foreground" />
              <Th labelKey="col.actualAmt" className="text-right text-muted-foreground" />
              <Th labelKey="col.actualNbv" className="text-right text-muted-foreground" />
              <Th labelKey="col.liveQty" className="text-right text-muted-foreground" />
              <Th labelKey="col.liveAmt" className="text-right text-muted-foreground" />
              <Th labelKey="col.liveNbv" className="text-right text-muted-foreground" />
              <Th labelKey="col.seasonMinusMonth" className="text-right text-muted-foreground" />
              <Th labelKey="col.pending" className="text-right text-muted-foreground" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!dealer || rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="py-8 text-center text-muted-foreground">
                  {monthApproved ? "Nothing planned for this dealer." : "No monthly figures — showing 0 for every value."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium"><ProductName name={r.productName} nbvPercent={r.nbvPercent} categories={categories} isClearance={r.isClearance} clearanceQty={r.clearanceQty} /></TableCell>
                  <TableCell className="text-right">{qtyMode ? fmtNum(r.monthlyPlannedQty) : (r.amount === null ? "—" : formatCurrency(r.amount))}</TableCell>
                  <TableCell className="text-right">{r.amount === null ? "—" : formatCurrency(r.amount)}</TableCell>
                  <TableCell className="text-right">{r.nbv === null ? "—" : formatCurrency(r.nbv)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{fmtNum(r.actualQty)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatCurrency(r.actualAmount)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatCurrency(r.actualNbv)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{fmtNum(r.liveQty)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{r.liveAmount === null ? "—" : formatCurrency(r.liveAmount)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{r.liveNbv === null ? "—" : formatCurrency(r.liveNbv)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{fmtNum(r.seasonMinusMonth)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{fmtNum(r.pending)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          {rows.length > 0 && (
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Dealer Total</TableCell>
                <TableCell className="text-right">{qtyMode ? fmtNum(totals.monthlyPlannedQty) : formatCurrency(totals.amount)}</TableCell>
                <TableCell className="text-right">{formatCurrency(totals.amount)}</TableCell>
                <TableCell className="text-right">{formatCurrency(totals.nbv)}</TableCell>
                <TableCell className="text-right">{fmtNum(totals.actualQty)}</TableCell>
                <TableCell className="text-right">{formatCurrency(totals.actualAmount)}</TableCell>
                <TableCell className="text-right">{formatCurrency(totals.actualNbv)}</TableCell>
                <TableCell className="text-right">{fmtNum(totals.liveQty)}</TableCell>
                <TableCell className="text-right">{formatCurrency(totals.liveAmount)}</TableCell>
                <TableCell className="text-right">{formatCurrency(totals.liveNbv)}</TableCell>
                <TableCell className="text-right">{fmtNum(totals.seasonMinusMonth)}</TableCell>
                <TableCell className="text-right">{fmtNum(totals.pending)}</TableCell>
              </TableRow>
            </tfoot>
          )}
        </Table>
      </div>
    </div>
  );
}
