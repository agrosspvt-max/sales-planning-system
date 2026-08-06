"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Ban } from "lucide-react";
import { api } from "@/lib/api-client";
import { PlanGridMonthView } from "./plan-grid-month-view";
import { formatCurrency } from "@/lib/utils";
import {
  sumFlex,
  amount as calcAmount,
  nbv as calcNbv,
  isQuantityMode,
  type FlexFigures,
  type PlanningMode,
} from "@/lib/calc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionColgroup } from "@/components/ui/table-group";
import { Th, LabelSectionHeaderRow, type LabelSection } from "@/features/labels/label-ui";
import { usePlanEdit } from "./plan-edit-context";
import {
  DealerProgressBar,
  NoPlanDialog,
  dealerStatusOf,
  type StatusCounts,
} from "./dealer-completion";
import { DealerPlanningStatus } from "./dealer-status";

const fmtNum = (n: number | null) => (n === null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * Dealer Plan — the ONE editable page. It reads/writes the shared plan-edit context, so
 * every keystroke instantly recomputes Product Plan and Dealer Summary (which read the same
 * live cells). Autosave and the mode-aware calc engine are reused unchanged.
 */
export function PlanGrid() {
  const { detail, mode, packMode, packColumns, editable, saving, lastSaved, cells, setPack, setValue, lineFig, dealerCompleted, flush } =
    usePlanEdit();
  const qc = useQueryClient();

  // Default to "Choose Dealer" (no auto-select of the first dealer).
  const [dealerId, setDealerId] = useState("");
  // Month View filter: "" = Seasonal (default, unchanged). A month id → read-only monthly VIEW.
  const [monthId, setMonthId] = useState("");
  const [noPlanOpen, setNoPlanOpen] = useState(false);
  const dealer = detail.dealers.find((d) => d.dealerId === dealerId);

  // Season months for the Month View selector (all months, so months without an approved monthly
  // plan still appear and show the "not started" banner). Only fetched for approved plans.
  const { data: monthsData } = useQuery<{ months: { id: string; name: string }[] }>({
    queryKey: ["season-months", detail.id],
    queryFn: () => api.get(`/api/planning/season-plans/${detail.id}/months`),
    enabled: detail.status === "APPROVED",
  });
  const monthOptions = monthsData?.months ?? [];
  const monthName = monthOptions.find((m) => m.id === monthId)?.name ?? "";

  // Live completion (Completed = ≥1 saved qty; No Plan = flagged; else Remaining).
  const statusByDealer = useMemo(() => {
    const m = new Map<string, DealerPlanningStatus>();
    for (const d of detail.dealers) m.set(d.dealerId, dealerStatusOf(d, dealerCompleted(d.dealerId)));
    return m;
  }, [detail, dealerCompleted]);
  const counts: StatusCounts = useMemo(() => {
    let completed = 0, noPlan = 0, remaining = 0;
    for (const s of statusByDealer.values()) {
      if (s === DealerPlanningStatus.COMPLETED) completed++;
      else if (s === DealerPlanningStatus.NO_PLAN) noPlan++;
      else remaining++;
    }
    return { completed, noPlan, remaining, total: statusByDealer.size };
  }, [statusByDealer]);

  const noPlanMut = useMutation({
    mutationFn: (vars: { noPlan: boolean; reason?: string }) =>
      api.post(`/api/planning/season-plans/${detail.id}/dealers/${dealerId}/no-plan`, vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plan", detail.id] }),
  });

  const OPTION_COLOR: Record<DealerPlanningStatus, string | undefined> = {
    [DealerPlanningStatus.COMPLETED]: "hsl(var(--success))",
    [DealerPlanningStatus.NO_PLAN]: "hsl(var(--noplan))",
    [DealerPlanningStatus.REMAINING]: undefined,
  };

  const cellFor = (productId: string) => cells[`${dealerId}|${productId}`] ?? { packs: {}, value: 0 };

  const dealerTotal = useMemo<FlexFigures>(() => {
    if (!dealer) return { totalQty: null, amount: null, nbv: null };
    return sumFlex(dealer.lines.map((l) => lineFig(dealerId, l)));
  }, [dealer, dealerId, lineFig]);

  const ro = useMemo(() => {
    const acc = { actualQty: 0, liveQty: 0, actualAmount: 0, actualNbv: 0, liveAmount: 0, liveNbv: 0 };
    for (const l of dealer?.lines ?? []) {
      acc.actualQty += l.actualQty;
      acc.liveQty += l.liveMonthlyQty;
      // Actual amount comes from the uploaded sales (saleValue), not qty × rate.
      acc.actualAmount += l.actualAmount;
      acc.actualNbv += calcNbv(l.actualAmount, l.nbvPercent);
      acc.liveAmount += calcAmount(l.liveMonthlyQty, l.rate);
      acc.liveNbv += calcNbv(calcAmount(l.liveMonthlyQty, l.rate), l.nbvPercent);
    }
    return acc;
  }, [dealer]);

  const showTotalQty = mode === "PACK_SIZE" || mode === "TOTAL_QUANTITY";

  // Excel-style column sections (visual grouping only — data, order and calculations unchanged).
  // "Planning" (pack-size columns) only exists in pack mode; the single-value modes plan in Plan
  // Summary instead, so that section is omitted when there are no pack columns.
  const seasonalSections: LabelSection[] = [
    ...(packMode && packColumns.length ? [{ labelKey: "seasonal.section.planning" as const, span: packColumns.length, tone: "blue" as const }] : []),
    { labelKey: "seasonal.section.planSummary", span: (showTotalQty ? 1 : 0) + 2, tone: "slate" },
    { labelKey: "seasonal.section.actualSales", span: 3, tone: "green" },
    { labelKey: "seasonal.section.liveMonth", span: 5, tone: "amber" },
  ];

  const modeNote: Record<PlanningMode, string> = {
    PACK_SIZE: "Enter a quantity for each pack size.",
    TOTAL_QUANTITY: "Enter one Total Quantity per product.",
    AMOUNT: "Enter a planned Amount per product; NBV is derived.",
    NBV: "Enter a planned NBV per product; Amount is derived when NBV % is known.",
  };

  const onPack = (productId: string, packSizeId: string, raw: string) =>
    setPack(dealerId, productId, packSizeId, Math.max(0, Math.floor(Number(raw) || 0)));
  const onValue = (productId: string, raw: string) => {
    const parsed = Number(raw) || 0;
    setValue(dealerId, productId, isQuantityMode(mode) ? Math.max(0, Math.floor(parsed)) : Math.max(0, parsed));
  };

  const selectedStatus = dealer ? statusByDealer.get(dealer.dealerId) : undefined;

  return (
    <div className="space-y-3">
      {/* Planning progress: Green Completed · Purple No Plan · Grey Remaining. */}
      <DealerProgressBar counts={counts} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Dealer:</span>
          {/* Native select so each option can carry its status colour. */}
          <select
            className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm"
            value={dealerId}
            onChange={(e) => setDealerId(e.target.value)}
          >
            <option value="">Choose Dealer…</option>
            {detail.dealers.map((d) => (
              <option key={d.dealerId} value={d.dealerId} style={{ color: OPTION_COLOR[statusByDealer.get(d.dealerId) ?? DealerPlanningStatus.REMAINING] }}>
                {d.dealerName}
                {statusByDealer.get(d.dealerId) === DealerPlanningStatus.COMPLETED ? " ✓" : statusByDealer.get(d.dealerId) === DealerPlanningStatus.NO_PLAN ? " ⦸" : ""}
              </option>
            ))}
          </select>
          {!monthId && editable && dealer && selectedStatus !== DealerPlanningStatus.NO_PLAN && (
            <Button variant="outline" size="sm" onClick={() => setNoPlanOpen(true)} className="text-noplan">
              <Ban className="h-4 w-4" /> No Plan
            </Button>
          )}
          {!monthId && editable && dealer && selectedStatus === DealerPlanningStatus.NO_PLAN && (
            <Button variant="outline" size="sm" onClick={() => noPlanMut.mutate({ noPlan: false })} disabled={noPlanMut.isPending}>
              Undo No Plan
            </Button>
          )}
          {/* Month View filter — a VIEW only; changing it never modifies Seasonal Planning. */}
          {detail.status === "APPROVED" && monthOptions.length > 0 && (
            <>
              <span className="ml-2 text-sm font-medium">Month:</span>
              <select
                className="h-9 w-44 rounded-md border border-input bg-background px-2 text-sm"
                value={monthId}
                onChange={(e) => setMonthId(e.target.value)}
              >
                <option value="">Seasonal (all)</option>
                {monthOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </>
          )}
        </div>
        {editable && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{saving ? "Saving…" : `Saved ${new Date(lastSaved).toLocaleTimeString()}`}</span>
          </div>
        )}
      </div>

      {dealer && (
        <NoPlanDialog
          open={noPlanOpen}
          dealerName={dealer.dealerName}
          onOpenChange={setNoPlanOpen}
          saving={noPlanMut.isPending}
          onConfirm={async (reason) => {
            await flush(); // persist any pending edits first
            await noPlanMut.mutateAsync({ noPlan: true, reason });
            setNoPlanOpen(false);
          }}
        />
      )}

      {editable && !dealer && (
        <p className="rounded-md border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          Choose a dealer to enter their plan, or mark a dealer as <span className="text-noplan">No Plan</span>. Every dealer must be
          Completed or No Plan before you can submit.
        </p>
      )}

      {!monthId && (
        <p className="text-xs text-muted-foreground">
          Planning mode: <span className="font-medium">{mode.replace("_", " ")}</span> — {modeNote[mode]}
          {editable && " Changes autosave; Product Plan and Dealer Summary update instantly."}
        </p>
      )}

      {/* MONTH VIEW — read-only monthly figures for the selected dealer (Seasonal Planning untouched). */}
      {monthId && (
        !dealer ? (
          <p className="rounded-md border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
            Choose a dealer to see their {monthName} figures.
          </p>
        ) : (
          <PlanGridMonthView seasonPlanId={detail.id} dealerId={dealerId} monthId={monthId} monthName={monthName} />
        )
      )}

      {!monthId && (detail.dealers.length === 0 ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">
          No active dealers are assigned to you for this season.
        </div>
      ) : packMode && packColumns.length === 0 ? (
        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">
          No active pack sizes are configured. Ask an administrator to add pack sizes.
        </div>
      ) : !dealer ? null : (
        <div className="overflow-auto rounded-lg border bg-background">
          <Table stickyFirstColumn>
            {/* Excel-style sections (visual grouping only — the workbook layout). */}
            <SectionColgroup leading={1} sections={seasonalSections} />
            <TableHeader>
              <LabelSectionHeaderRow leading={1} sections={seasonalSections} />
              <TableRow>
                <Th labelKey="col.product" className="min-w-[160px]" />
                {packMode &&
                  packColumns.map((p) => (
                    <TableHead key={p.id} className="text-center">
                      {p.name}
                    </TableHead>
                  ))}
                {showTotalQty && <Th labelKey="seasonal.totalQty" className="text-right" />}
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
              {dealer?.lines.map((l) => {
                const cell = cellFor(l.productId);
                const fig = lineFig(dealerId, l);
                const actualAmt = calcAmount(l.actualQty, l.rate);
                const liveAmt = calcAmount(l.liveMonthlyQty, l.rate);
                const target = fig.totalQty ?? 0;
                return (
                  <TableRow key={l.productId}>
                    <TableCell className="font-medium">
                      {l.productName}
                      {/* Technical/scientific name — hidden on phones to keep the frozen column narrow. */}
                      <div className="hidden text-xs text-muted-foreground sm:block">{l.technicalName}</div>
                    </TableCell>

                    {packMode &&
                      packColumns.map((p) => (
                        <TableCell key={p.id} className="p-1 text-center">
                          <Input
                            type="number"
                            min={0}
                            className="h-8 w-16 text-center"
                            value={cell.packs[p.id] ? cell.packs[p.id] : ""}
                            placeholder="0"
                            disabled={!editable}
                            onChange={(e) => onPack(l.productId, p.id, e.target.value)}
                          />
                        </TableCell>
                      ))}

                    {showTotalQty && (
                      <TableCell className="p-1 text-right">
                        {mode === "TOTAL_QUANTITY" ? (
                          <Input
                            type="number"
                            min={0}
                            className="ml-auto h-8 w-24 text-right"
                            value={cell.value ? cell.value : ""}
                            placeholder="0"
                            disabled={!editable}
                            onChange={(e) => onValue(l.productId, e.target.value)}
                          />
                        ) : (
                          <span className="font-medium">{fmtNum(fig.totalQty)}</span>
                        )}
                      </TableCell>
                    )}

                    <TableCell className="p-1 text-right">
                      {mode === "AMOUNT" ? (
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          className="ml-auto h-8 w-28 text-right"
                          value={cell.value ? cell.value : ""}
                          placeholder="0"
                          disabled={!editable}
                          onChange={(e) => onValue(l.productId, e.target.value)}
                        />
                      ) : (
                        <span>{fig.amount === null ? "—" : formatCurrency(fig.amount)}</span>
                      )}
                    </TableCell>

                    <TableCell className="p-1 text-right">
                      {mode === "NBV" ? (
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          className="ml-auto h-8 w-28 text-right"
                          value={cell.value ? cell.value : ""}
                          placeholder="0"
                          disabled={!editable}
                          onChange={(e) => onValue(l.productId, e.target.value)}
                        />
                      ) : (
                        <span>{fig.nbv === null ? "—" : formatCurrency(fig.nbv)}</span>
                      )}
                    </TableCell>

                    <TableCell className="text-right text-muted-foreground">{l.actualQty}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(actualAmt)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(calcNbv(actualAmt, l.nbvPercent))}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{l.liveMonthlyQty}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(liveAmt)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatCurrency(calcNbv(liveAmt, l.nbvPercent))}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{target - l.liveMonthlyQty}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{target - l.actualQty}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Dealer Total</TableCell>
                {packMode && (
                  <TableCell colSpan={packColumns.length} className="text-right">
                    {fmtNum(dealerTotal.totalQty)} units
                  </TableCell>
                )}
                {showTotalQty && <TableCell className="text-right">{fmtNum(dealerTotal.totalQty)}</TableCell>}
                <TableCell className="text-right">
                  {dealerTotal.amount === null ? "—" : formatCurrency(dealerTotal.amount)}
                </TableCell>
                <TableCell className="text-right">
                  {dealerTotal.nbv === null ? "—" : formatCurrency(dealerTotal.nbv)}
                </TableCell>
                <TableCell className="text-right">{ro.actualQty}</TableCell>
                <TableCell className="text-right">{formatCurrency(ro.actualAmount)}</TableCell>
                <TableCell className="text-right">{formatCurrency(ro.actualNbv)}</TableCell>
                <TableCell className="text-right">{ro.liveQty}</TableCell>
                <TableCell className="text-right">{formatCurrency(ro.liveAmount)}</TableCell>
                <TableCell className="text-right">{formatCurrency(ro.liveNbv)}</TableCell>
                <TableCell className="text-right">{(dealerTotal.totalQty ?? 0) - ro.liveQty}</TableCell>
                <TableCell className="text-right">{(dealerTotal.totalQty ?? 0) - ro.actualQty}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </div>
      ))}

      {!monthId && editable && (
        <div className="flex justify-end">
          <SaveHint />
        </div>
      )}
    </div>
  );
}

function SaveHint() {
  const { flush, saving } = usePlanEdit();
  return (
    <Button size="sm" variant="outline" onClick={() => flush()} disabled={saving}>
      <Save className="h-4 w-4" /> Save now
    </Button>
  );
}
