"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn, formatCurrency } from "@/lib/utils";
import { figuresForMode, nbv as calcNbv, type PlanningMode } from "@/lib/calc";
import { PageHeader } from "@/components/layout/page-header";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Season { id: string; name: string; year: number }
interface GroupProductRow {
  productId: string; productName: string; technicalName: string | null; rate: number; nbvPercent: number;
  packSums: Record<string, number>;
  seasonalQty: number; seasonalAmount: number; seasonalNbv: number;
  actualQty: number; actualAmount: number; actualNbv: number;
  monthly: Record<string, { planInput: number; saleInput: number; saleAmount: number }>;
}
interface GroupProductPlan {
  groupName: string; seasonName: string; monthlyMode: PlanningMode; seasonalMode: PlanningMode;
  officerCount: number; planCount: number;
  months: { id: string; name: string; order: number }[];
  packSizes: { id: string; name: string }[];
  products: GroupProductRow[];
}

type Tab = "territory" | "product";
type View = "total" | "month" | "range";
const qtyFmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/**
 * Territory (Group) Planning dashboard — READ-ONLY analytics. Mirrors the per-officer Seasonal Plan
 * UI, but the Product Plan aggregates across every Sales Officer in the group. It never modifies any
 * plan/sales data — it only summarises existing planning information.
 */
export function GroupPlanPage({ groupId, groupName }: { groupId: string; groupName: string }) {
  const [tab, setTab] = useState<Tab>("product");
  const [seasonId, setSeasonId] = useState("");

  const { data: seasons } = useQuery<Season[]>({ queryKey: ["seasons"], queryFn: () => api.get("/api/seasons") });
  const effectiveSeason = seasonId || seasons?.[0]?.id || "";

  return (
    <div className="space-y-4">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Users", href: "/masters/users" }, { label: groupName }, { label: "Territory Plan" }]}
        title={`${groupName} — Territory Plan`}
        subtitle="Read-only analytics aggregated across every Sales Officer in this group. Nothing here is editable."
        actions={
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Season</span>
            <NativeSelect
              className="w-56"
              placeholder="Choose a season…"
              options={(seasons ?? []).map((s) => ({ value: s.id, label: `${s.name} ${s.year}` }))}
              value={effectiveSeason}
              onChange={(e) => setSeasonId(e.target.value)}
            />
          </div>
        }
      />

      <div className="flex gap-1 border-b">
        {([{ key: "territory", label: "Territory Plan" }, { key: "product", label: "Product Plan" }] as { key: Tab; label: string }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn("border-b-2 px-3 py-2 text-sm font-medium transition-colors", tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "territory" ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">
          Territory Plan — coming soon. This will mirror the Dealer Plan for the whole territory.
        </div>
      ) : (
        <GroupProductPlan groupId={groupId} seasonId={effectiveSeason} />
      )}
    </div>
  );
}

function GroupProductPlan({ groupId, seasonId }: { groupId: string; seasonId: string }) {
  const [view, setView] = useState<View>("total");
  const [monthA, setMonthA] = useState("");
  const [monthB, setMonthB] = useState("");

  const { data, isLoading } = useQuery<GroupProductPlan>({
    queryKey: ["group-product-plan", groupId, seasonId],
    queryFn: () => api.get(`/api/planning/groups/${groupId}/product-plan?seasonId=${seasonId}`),
    enabled: !!seasonId,
  });

  const months = useMemo(() => data?.months ?? [], [data?.months]);
  const monthOpts = months.map((m) => ({ value: m.id, label: m.name }));
  const packMode = (data?.seasonalMode ?? "PACK_SIZE") === "PACK_SIZE";
  const showPackCols = view === "total" && packMode && (data?.packSizes.length ?? 0) > 0;

  const selectedMonthIds = useMemo(() => {
    if (view === "month") return monthA ? [monthA] : months[0] ? [months[0].id] : [];
    if (view === "range") {
      const a = months.find((m) => m.id === (monthA || months[0]?.id));
      const b = months.find((m) => m.id === (monthB || months[months.length - 1]?.id));
      if (!a || !b) return [];
      const [lo, hi] = a.order <= b.order ? [a.order, b.order] : [b.order, a.order];
      return months.filter((m) => m.order >= lo && m.order <= hi).map((m) => m.id);
    }
    return [];
  }, [view, monthA, monthB, months]);

  // For Specific Month / Month Range, aggregate each product's monthly inputs over the selected months
  // (same calc engine as the per-officer view — no new formulas).
  const monthRows = useMemo(() => {
    if (!data || view === "total") return [];
    const mode = data.monthlyMode;
    return data.products
      .map((p) => {
        let planInput = 0, saleInput = 0, saleAmount = 0;
        for (const mid of selectedMonthIds) {
          const e = p.monthly[mid];
          if (e) { planInput += e.planInput; saleInput += e.saleInput; saleAmount += e.saleAmount; }
        }
        const pf = figuresForMode(mode, planInput, p.rate, p.nbvPercent);
        const sf = figuresForMode(mode, saleInput, p.rate, p.nbvPercent);
        return {
          productId: p.productId, name: p.productName,
          planQty: pf.totalQty ?? 0, planAmount: pf.amount ?? 0, planNbv: pf.nbv ?? 0,
          soldQty: sf.totalQty ?? 0, soldAmount: saleAmount, soldNbv: calcNbv(saleAmount, p.nbvPercent),
        };
      })
      .filter((r) => r.planAmount !== 0 || r.soldAmount !== 0)
      .sort((a, b) => b.planAmount - a.planAmount);
  }, [data, view, selectedMonthIds]);

  if (!seasonId) return <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">Choose a season to view the group Product Plan.</p>;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const packCols = data.packSizes;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="secondary">{data.officerCount} officer(s)</Badge>
        <Badge variant="secondary">{data.planCount} approved plan(s)</Badge>
        <span>·</span>
        <span>{data.seasonName}</span>
      </div>

      {/* Same filter UI as the per-officer Product Plan. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
          {(["total", "month", "range"] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn("rounded px-3 py-1.5 font-medium", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "total" ? "Seasonal Total" : v === "month" ? "Specific Month" : "Month Range"}
            </button>
          ))}
        </div>
        {view === "month" && months.length > 0 && (
          <NativeSelect className="w-44" options={monthOpts} value={monthA || months[0].id} onChange={(e) => setMonthA(e.target.value)} />
        )}
        {view === "range" && months.length > 0 && (
          <div className="flex items-center gap-2">
            <NativeSelect className="w-40" options={monthOpts} value={monthA || months[0].id} onChange={(e) => setMonthA(e.target.value)} />
            <span className="text-sm text-muted-foreground">to</span>
            <NativeSelect className="w-40" options={monthOpts} value={monthB || months[months.length - 1].id} onChange={(e) => setMonthB(e.target.value)} />
          </div>
        )}
      </div>

      {data.products.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">No approved plan data for this group and season.</div>
      ) : view === "total" ? (
        <div className="overflow-auto rounded-lg border bg-background">
          <Table stickyFirstColumn>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[160px]">Product</TableHead>
                {showPackCols && packCols.map((p) => <TableHead key={p.id} className="text-center">{p.name}</TableHead>)}
                <TableHead className="text-right">Total Qty</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
                <TableHead className="text-right">Planned NBV</TableHead>
                <TableHead className="text-right text-muted-foreground">Actual Qty</TableHead>
                <TableHead className="text-right text-muted-foreground">Actual Amount</TableHead>
                <TableHead className="text-right text-muted-foreground">Actual NBV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.products.map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">{r.productName}</TableCell>
                  {showPackCols && packCols.map((p) => <TableCell key={p.id} className="text-center tabular-nums">{qtyFmt(r.packSums[p.id] ?? 0)}</TableCell>)}
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.seasonalQty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.seasonalAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.seasonalNbv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{qtyFmt(r.actualQty)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actualNbv)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                {showPackCols && packCols.map((p) => <TableCell key={p.id} className="text-center tabular-nums">{qtyFmt(data.products.reduce((s, r) => s + (r.packSums[p.id] ?? 0), 0))}</TableCell>)}
                <TableCell className="text-right tabular-nums">{qtyFmt(data.products.reduce((s, r) => s + r.seasonalQty, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(data.products.reduce((s, r) => s + r.seasonalAmount, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(data.products.reduce((s, r) => s + r.seasonalNbv, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(data.products.reduce((s, r) => s + r.actualQty, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(data.products.reduce((s, r) => s + r.actualAmount, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(data.products.reduce((s, r) => s + r.actualNbv, 0))}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </div>
      ) : monthRows.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">No monthly plan data for the selected month(s).</div>
      ) : (
        <div className="overflow-auto rounded-lg border bg-background">
          <Table stickyFirstColumn>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[160px]">Product</TableHead>
                <TableHead className="text-right">Plan Qty</TableHead>
                <TableHead className="text-right">Plan Amount</TableHead>
                <TableHead className="text-right">Planned NBV</TableHead>
                <TableHead className="text-right text-muted-foreground">Sold Qty</TableHead>
                <TableHead className="text-right text-muted-foreground">Sold Amount</TableHead>
                <TableHead className="text-right text-muted-foreground">Sold NBV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monthRows.map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.planQty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.planNbv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{qtyFmt(r.soldQty)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.soldAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.soldNbv)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(monthRows.reduce((s, r) => s + r.planQty, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(monthRows.reduce((s, r) => s + r.planAmount, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(monthRows.reduce((s, r) => s + r.planNbv, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(monthRows.reduce((s, r) => s + r.soldQty, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(monthRows.reduce((s, r) => s + r.soldAmount, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(monthRows.reduce((s, r) => s + r.soldNbv, 0))}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </div>
      )}
    </div>
  );
}
