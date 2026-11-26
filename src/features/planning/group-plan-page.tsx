"use client";
import { DealerName, useDealerNameResolver } from "@/features/dealers/dealer-name-ui";
import { DealerOrder, useTaggedDealersFirst } from "@/features/dealers/dealer-table-ui";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Download, MinusCircle, Users2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency } from "@/lib/utils";
import { type PlanningMode } from "@/lib/calc";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClearanceTag } from "@/components/ui/clearance-tag";
import { CategoryBadge } from "@/components/ui/category-badge";
import { CategoryFilter } from "@/components/ui/category-filter";
import { useCategories } from "@/lib/use-categories";
import { categoryForNbv, matchesCategoryFilter, UNCATEGORIZED } from "@/lib/product-category";
import { GroupRecovery } from "./group-recovery-page";
import { isNegativeTerritoryPlanMetric } from "./group-plan-metrics";
import { downloadGroupPlan, getProductPlanColumns, productColumnTotals } from "./group-plan-export";
import { DealerSalesDrawer } from "./dealer-sales-drawer";
import { DealerFinancialSummaryTable } from "./dealer-financial-summary-table";
import { summarizeTerritoryDealers, type DealerProductFinancialRow } from "./group-dealer-summary";
import type { DealerCreditRecord } from "./dealer-credit-adjustments";

/* ------------------------------- Shared types ----------------------------- */

export type StatusBucket = "approved" | "submitted" | "draft";
export const ALL_BUCKETS: StatusBucket[] = ["approved", "submitted", "draft"];
export const BUCKET_LABEL: Record<StatusBucket, string> = { approved: "Approved", submitted: "Submitted", draft: "Draft" };

interface Season { id: string; name: string; year: number }
interface Contribution {
  bucket: StatusBucket; officerId: string; officerName: string; dealerId: string; dealerName: string;
  planId: string; planType: "SEASONAL" | "MONTHLY"; version: number; status: string;
  monthId: string | null; monthName: string | null; qty: number; amount: number; nbv: number;
}
interface BucketTotal { qty: number; amount: number; nbv: number; officerCount: number }
interface DrawerMeasure { qty: number; amount: number; nbv: number }
type DrawerBucket = StatusBucket | "unplanned";
const DRAWER_BUCKETS: DrawerBucket[] = [...ALL_BUCKETS, "unplanned"];

interface DrawerContribution {
  bucket: DrawerBucket; officerId: string; officerName: string; dealerId: string; dealerName: string;
  seasonPlan: DrawerMeasure; seasonSales: DrawerMeasure; periodSales: DrawerMeasure;
}
type MetricMode = "seasonPlan" | "seasonSales" | "periodSales";
interface GroupProductRow {
  productId: string; productName: string; technicalName: string | null; rate: number; nbvPercent: number;
  isClearance?: boolean; clearanceQty?: number | null;
  // Season Baseline (always the complete season; APPROVED by default). Qty + amount (Show Amounts).
  seasonQty: number; plannedAllMonths: number; remaining: number; seasonSales: number; pendingSales: number;
  seasonAmount: number; plannedAllMonthsAmount: number; remainingAmount: number; seasonSalesAmount: number; pendingAmount: number;
  // Period-level (respond to Seasonal Total / Specific Month / Month Range).
  total: { qty: number; amount: number; nbv: number };   // This Period Plan (qty) + Plan Amount/NBV
  actual: { qty: number; amount: number; nbv: number };  // This Period Sold (qty) + Actual Amount/NBV
  byBucket: Record<StatusBucket, BucketTotal>;
  contributions: Contribution[];
  drawer: DrawerContribution[];
}
export interface OfficerRef { id: string; name: string }
export interface GroupOfficerBreakdown {
  total: number; includedCount: number;
  byBucket: Record<StatusBucket, OfficerRef[]>;
  excluded: { name: string; reason: string }[];
  withUnplannedSales?: OfficerRef[];
  withUnplannedRecovery?: OfficerRef[];
}
interface GroupProductPlan {
  groupName: string; seasonName: string; monthlyMode: PlanningMode; seasonalMode: PlanningMode;
  filter: { buckets: StatusBucket[]; includeUnplanned?: boolean; view: "total" | "month" | "range"; monthIds: string[] };
  officers: GroupOfficerBreakdown;
  months: { id: string; name: string; order: number }[];
  packSizes: { id: string; name: string }[];
  products: GroupProductRow[];
  dealerProducts?: DealerProductFinancialRow[];
  dealerCredits?: DealerCreditRecord[];
}

type Tab = "territory" | "product" | "recovery";
type View = "total" | "month" | "range";
const qtyFmt = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 }).format(n);

/**
 * Territory (Group) Planning dashboard — READ-ONLY analytics. Aggregates across every Sales Officer in
 * the group. All numbers come from ONE server aggregation (getGroupProductPlan); the client never
 * re-computes totals — it only renders and slices them (so the drawer breakdown always sums to the grid).
 */
interface OfficerOpt { id: string; name: string }

export function GroupPlanPage({ groupId, groupName, showUnplanned = false }: { groupId: string; groupName: string; showUnplanned?: boolean }) {
  const [tab, setTab] = useState<Tab>("product");
  const [seasonId, setSeasonId] = useState("");
  const [officerId, setOfficerId] = useState(""); // "" = all officers in the group

  // Active (OPEN) seasons only — a CLOSED season must not be selectable for Territory planning/recovery.
  const { data: seasons } = useQuery<Season[]>({ queryKey: ["seasons", "active"], queryFn: () => api.get("/api/seasons?active=true") });
  // Contributors of THIS group — Sales Officers PLUS the group's Regional Manager (roles=all), matching the
  // Territory Plan aggregation. The endpoint is group-scoped for RMs (their own group only), so the
  // dropdown can never list contributors outside the viewed group.
  const { data: officers } = useQuery<OfficerOpt[]>({
    queryKey: ["officers", groupId, "group-territory"],
    queryFn: () => api.get<OfficerOpt[]>(`/api/users/officers?groupId=${groupId}&filter=active&roles=all`),
  });
  const effectiveSeason = seasonId || seasons?.[0]?.id || "";

  return (
    <div className="space-y-4">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Users", href: "/masters/users" }, { label: groupName }, { label: "Territory Plan" }]}
        title={`${groupName} — Territory Plan`}
        subtitle="Read-only analytics aggregated across every team member (Sales Officers + Regional Manager) in this group. Nothing here is editable."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Team Member</span>
            <NativeSelect
              className="w-52"
              options={[{ value: "", label: "All Team Members" }, ...(officers ?? []).map((o) => ({ value: o.id, label: o.name }))]}
              value={officerId}
              onChange={(e) => setOfficerId(e.target.value)}
            />
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
        {([{ key: "territory", label: "Territory Plan" }, { key: "product", label: "Product Plan" }, { key: "recovery", label: "Territory Recovery" }] as { key: Tab; label: string }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn("border-b-2 px-3 py-2 text-sm font-medium transition-colors", tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "recovery" ? (
        <GroupRecovery groupId={groupId} seasonId={effectiveSeason} officerId={officerId} showUnplanned={showUnplanned} />
      ) : (
        <GroupSalesPlan groupId={groupId} seasonId={effectiveSeason} officerId={officerId}
          officerLabel={officers?.find((officer) => officer.id === officerId)?.name ?? "All Team Members"}
          showUnplanned={showUnplanned} dealerView={tab === "territory"} />
      )}
    </div>
  );
}

/* ----------------------------- Territory sales ---------------------------- */

function GroupSalesPlan({ groupId, seasonId, officerId = "", officerLabel, showUnplanned = false, dealerView }: {
  groupId: string; seasonId: string; officerId?: string; officerLabel: string; showUnplanned?: boolean; dealerView: boolean;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const dealerName = useDealerNameResolver();
  const orderDealers = useTaggedDealersFirst();
  const [includeUnplanned, setIncludeUnplanned] = useState(false);
  const [view, setView] = useState<View>("total");
  const [monthA, setMonthA] = useState("");
  const [monthB, setMonthB] = useState("");
  const [buckets, setBuckets] = useState<StatusBucket[]>(["approved"]);
  const [drawerProductId, setDrawerProductId] = useState<string | null>(null);
  const [drawerDealerId, setDrawerDealerId] = useState<string | null>(null);
  const dealerTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (dealerView) setDrawerProductId(null);
    else setDrawerDealerId(null);
  }, [dealerView]);
  const categories = useCategories();
  const [categoryFilter, setCategoryFilter] = useState("");
  // Season Baseline mode (default Approved). Show Amounts is a persisted per-user UI preference.
  const [seasonMetrics, setSeasonMetrics] = useState<"approved" | "filters">("approved");
  const [showAmounts, setShowAmounts] = useState(false);
  useEffect(() => {
    try { setShowAmounts(localStorage.getItem("territory-plan-show-amounts") === "1"); } catch { /* ignore */ }
  }, []);
  const toggleAmounts = () =>
    setShowAmounts((v) => {
      const next = !v;
      try { localStorage.setItem("territory-plan-show-amounts", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });

  const bucketsKey = [...buckets].sort().join(",");
  const params = new URLSearchParams({
    seasonId, buckets: bucketsKey, unplanned: String(includeUnplanned), view,
    fromMonth: view === "total" ? "" : monthA,
    toMonth: view === "range" ? monthB : "",
    officerId, seasonMetrics,
  });
  if (dealerView) params.set("groupBy", "dealer");
  const { data, isError, isFetching, isPlaceholderData, refetch } = useQuery<GroupProductPlan>({
    queryKey: ["group-product-plan", groupId, params.toString()],
    refetchInterval: 60000,
    queryFn: () => api.get(`/api/planning/groups/${groupId}/product-plan?${params}`),
    enabled: !!seasonId,
    placeholderData: keepPreviousData,
  });
  const months = data?.months ?? [];
  const monthOpts = months.map((m) => ({ value: m.id, label: m.name }));
  const startMonth = months.find((month) => month.id === monthA)?.id ?? months[0]?.id;
  const endMonth = months.find((month) => month.id === monthB)?.id ?? months.at(-1)?.id;
  const visibleProducts = data?.products.filter((r) => matchesCategoryFilter(r.nbvPercent, categoryFilter, categories)) ?? [];
  const drawerProduct = visibleProducts.find((r) => r.productId === drawerProductId);
  const dealers = useMemo(() => summarizeTerritoryDealers(data?.dealerProducts ?? [], categoryFilter, categories, data?.dealerCredits),
    [data?.dealerProducts, data?.dealerCredits, categoryFilter, categories]);
  const drawerDealer = dealers.find((dealer) => dealer.dealerId === drawerDealerId);

  const toggleBucket = (b: StatusBucket) =>
    setBuckets((prev) => {
      const next = prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b];
      return next.length || includeUnplanned ? next : prev; // keep at least one selected
    });

  if (!seasonId) return <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">Choose a season to view the {dealerView ? "Territory Plan" : "Product Plan"}.</p>;
  if (isError && !data) return (
    <p role="alert" className="rounded-md border p-4 text-sm">
      Unable to load the {dealerView ? "Territory Plan" : "Product Plan"}.{" "}
      <button type="button" className="text-primary underline" onClick={() => void refetch()}>Try again</button>
    </p>
  );
  if (!data) return <Skeleton className="h-64 w-full" />;

  const productColumns = getProductPlanColumns(showAmounts);
  const totals = productColumnTotals(visibleProducts, productColumns);
  const periodLabel = view === "total" ? "Seasonal Total" : view === "month" ? "Specific Month" : "Month Range";
  const selectedMonths = months.filter((month) => data.filter.monthIds.includes(month.id));
  let selectedPeriodLabel = periodLabel;
  if (view !== "total" && selectedMonths.length) {
    selectedPeriodLabel = selectedMonths.length === 1
      ? selectedMonths[0].name
      : `${selectedMonths[0].name} – ${selectedMonths[selectedMonths.length - 1].name}`;
  }
  const seasonSpan = showAmounts ? 10 : 5;
  const plansLabel = [...data.filter.buckets.map((b) => BUCKET_LABEL[b]), ...(data.filter.includeUnplanned ? ["Unplanned"] : [])].join(", ");
  const baselineLabel = seasonMetrics === "approved" ? "Approved" : "Follow Selected Filters";

  async function exportPlan() {
    if (!data || isPlaceholderData || exporting) return;
    const category = categoryFilter === UNCATEGORIZED ? "Uncategorized" :
      categories.find((item) => item.id === categoryFilter)?.name ?? "All Categories";
    const context = {
      group: data.groupName,
      season: data.seasonName,
      period: selectedPeriodLabel,
      officer: officerLabel,
      plans: plansLabel,
      category,
    };

    setExportError("");
    setExporting(true);
    try {
      if (dealerView) {
        const rows = orderDealers(dealers, (row) => row.dealerId)
          .map((row) => ({ ...row, name: dealerName(row.dealerId, row.name) }));
        await downloadGroupPlan({ ...context, view: "dealer", rows });
      } else {
        await downloadGroupPlan({ ...context, view: "product", rows: visibleProducts, showAmounts, baseline: baselineLabel });
      }
    } catch {
      setExportError("Couldn’t export the plan. Try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter buckets={buckets} onToggle={toggleBucket} unplanned={showUnplanned ? {
          checked: includeUnplanned,
          onToggle: () => {
            if (includeUnplanned && !buckets.length) setBuckets(["approved"]);
            setIncludeUnplanned(!includeUnplanned);
          },
        } : undefined} />
        <OfficersBadge officers={data.officers} />
        <span className="text-sm text-muted-foreground">·</span>
        <span className="text-sm text-muted-foreground">{data.seasonName}</span>
        {isFetching && <span className="text-xs text-muted-foreground">updating…</span>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
          {(["total", "month", "range"] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn("rounded px-3 py-1.5 font-medium", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "total" ? "Seasonal Total" : v === "month" ? "Specific Month" : "Month Range"}
            </button>
          ))}
        </div>
        {view === "month" && months.length > 0 && (
          <NativeSelect className="w-44" options={monthOpts} aria-label="From month" value={startMonth} onChange={(e) => setMonthA(e.target.value)} />
        )}
        {view === "range" && months.length > 0 && (
          <div className="flex items-center gap-2">
            <NativeSelect className="w-40" options={monthOpts} aria-label="From month" value={startMonth} onChange={(e) => setMonthA(e.target.value)} />
            <span className="text-sm text-muted-foreground">to</span>
            <NativeSelect className="w-40" options={monthOpts} aria-label="To month" value={endMonth} onChange={(e) => setMonthB(e.target.value)} />
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {view === "total" && !dealerView ? "Filtering Seasonal Plans" : "Filtering Monthly Plans"} by: {[...buckets.map((b) => BUCKET_LABEL[b]), ...(includeUnplanned ? ["Unplanned sales"] : [])].join(", ")}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!dealerView && (
          <>
            <div className="inline-flex items-center gap-2 text-sm">
              <span className="font-medium text-muted-foreground">Season Metrics</span>
              <NativeSelect
                className="w-52"
                value={seasonMetrics}
                onChange={(e) => setSeasonMetrics(e.target.value as "approved" | "filters")}
                options={[{ value: "approved", label: "Approved Baseline" }, { value: "filters", label: "Follow Selected Filters" }]}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={showAmounts} onChange={toggleAmounts} />
              Show Amounts
            </label>
          </>
        )}
        <CategoryFilter categories={categories} value={categoryFilter} onChange={setCategoryFilter} />
        <Button
          type="button"
          variant="outline"
          className="ml-auto"
          onClick={() => void exportPlan()}
          disabled={exporting || isPlaceholderData || (dealerView ? dealers.length === 0 : visibleProducts.length === 0)}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {exporting ? "Exporting…" : "Export Excel"}
        </Button>
        {exportError && <p role="alert" className="w-full text-sm text-destructive">{exportError}</p>}
      </div>

      {dealerView && data.dealerCredits && (
        <p className="text-xs text-muted-foreground">
          {categoryFilter ? "Category views show product figures. Select All Categories to include credit notes without products."
            : "Actual Sales includes additional credit notes. Actual NBV uses the same dealer-level proportional adjustment."}
          {dealers.some((dealer) => dealer.actualSalesAvailable === false || dealer.actualNbvAvailable === false)
            && " A dash marks an unavailable net figure; open the dealer details for the reason."}
        </p>
      )}
      {isPlaceholderData ? (
        <Skeleton className="h-64 w-full" />
      ) : dealerView ? (
        <DealerFinancialSummaryTable
          rows={dealers}
          emptyMessage="No sales or plan data for this selection."
          onDealerSelect={(dealerId, trigger) => {
            dealerTrigger.current = trigger;
            setDrawerDealerId(dealerId);
          }}
        />
      ) : visibleProducts.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">No sales or plan data for this selection.</div>
      ) : (
        <div className="overflow-auto rounded-lg border bg-background">
          <Table stickyFirstColumn>
            <TableHeader>
              {/* Grouping row: SEASON BASELINE never changes with the period; THIS PERIOD + FINANCIALS do. */}
              <TableRow className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <TableHead className="min-w-[170px]" />
                <TableHead className="border-l text-center" colSpan={seasonSpan}>Season Baseline · {seasonMetrics === "approved" ? "Approved" : "Filters"}</TableHead>
                <TableHead className="border-l text-center" colSpan={2}>This Period · {periodLabel}</TableHead>
                <TableHead className="border-l text-center" colSpan={4}>Financials · {periodLabel}</TableHead>
              </TableRow>
              <TableRow>
                <TableHead className="min-w-[170px]">Product</TableHead>
                {productColumns.map((column) => (
                  <TableHead key={column.key} className={cn("text-right", column.sectionStart && "border-l")} title={column.title}>
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleProducts.map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">
                    <button className="inline-flex flex-wrap items-center gap-1 text-left hover:underline" onClick={() => setDrawerProductId(r.productId)}>
                      <span className={r.isClearance ? "text-warning" : "text-primary"}>{r.productName}</span>{r.isClearance && <ClearanceTag qty={r.clearanceQty} />}
                      <CategoryBadge category={categoryForNbv(r.nbvPercent, categories)} /> <ChevronRight className="h-3.5 w-3.5 text-primary" />
                    </button>
                  </TableCell>
                  {productColumns.map((column) => {
                    const value = column.value(r);
                    return (
                      <TableCell key={column.key} className={cn("text-right tabular-nums",
                        column.sectionStart && "border-l", column.muted && "text-muted-foreground",
                        column.comparison && isNegativeTerritoryPlanMetric(value) && "text-destructive")}>
                        {column.format === "currency" ? formatCurrency(value) : qtyFmt(value)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                {productColumns.map((column, index) => {
                  const value = totals[index];
                  return (
                    <TableCell key={column.key} className={cn("text-right tabular-nums", column.sectionStart && "border-l",
                      column.comparison && isNegativeTerritoryPlanMetric(value) && "text-destructive")}>
                      {column.format === "currency" ? formatCurrency(value) : qtyFmt(value)}
                    </TableCell>
                  );
                })}
              </TableRow>
            </tfoot>
          </Table>
        </div>
      )}

      {dealerView && !isPlaceholderData && drawerDealer && (
        <DealerSalesDrawer
          key={drawerDealer.dealerId}
          groupId={groupId}
          queryParams={params.toString()}
          categoryFiltered={!!categoryFilter}
          dealer={drawerDealer}
          periodLabel={`${selectedPeriodLabel} · ${data.seasonName}`}
          onClose={() => setDrawerDealerId(null)}
          trigger={dealerTrigger.current}
        />
      )}
      {!dealerView && !isPlaceholderData && drawerProduct && (
        <ProductDrawer
          key={drawerProduct.productId}
          product={drawerProduct}
          seasonName={data.seasonName}
          filterLabel={`${view === "total" ? "Seasonal Total" : view === "month" ? "Specific Month" : "Month Range"} · ${[...buckets.map((b) => BUCKET_LABEL[b]), ...(includeUnplanned ? ["Unplanned sales"] : [])].join(", ")}`}
          onClose={() => setDrawerProductId(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------ Status filter ----------------------------- */

export function StatusFilter({ buckets, onToggle, unplanned }: {
  buckets: StatusBucket[];
  onToggle: (b: StatusBucket) => void;
  unplanned?: { checked: boolean; onToggle: () => void; title?: string };
}) {
  return (
    <div className="inline-flex items-center gap-3 rounded-md border bg-background px-3 py-1.5 text-sm">
      <span className="font-medium text-muted-foreground">Included Plans</span>
      {ALL_BUCKETS.map((b) => (
        <label key={b} className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="h-4 w-4" checked={buckets.includes(b)} onChange={() => onToggle(b)} />
          {BUCKET_LABEL[b]}
        </label>
      ))}
      {unplanned && (
        <label className="flex cursor-pointer items-center gap-1.5" title={unplanned.title ?? "Actuals for months without an approved monthly plan"}>
          <input type="checkbox" className="h-4 w-4" checked={unplanned.checked} onChange={unplanned.onToggle} />
          Unplanned
        </label>
      )}
    </div>
  );
}

/* ---------------------------- Officer summary ----------------------------- */

const BUCKET_DOT: Record<StatusBucket, string> = { approved: "text-emerald-600", submitted: "text-amber-500", draft: "text-muted-foreground" };

export function OfficersBadge({ officers }: { officers: GroupOfficerBreakdown }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-md border bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80">
        <Users2 className="h-3.5 w-3.5" /> Officers: {officers.includedCount} / {officers.total}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-md border bg-popover p-3 text-xs shadow-md">
          {ALL_BUCKETS.map((b) => (
            <div key={b} className="mb-2">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
                <CheckCircle2 className={cn("h-3.5 w-3.5", BUCKET_DOT[b])} /> {BUCKET_LABEL[b]} ({officers.byBucket[b].length})
              </div>
              {officers.byBucket[b].length === 0 ? (
                <p className="pl-5 text-muted-foreground">None</p>
              ) : (
                <ul className="space-y-0.5 pl-5">
                  {officers.byBucket[b].map((o) => <li key={o.id} className="truncate text-foreground">{o.name}</li>)}
                </ul>
              )}
            </div>
          ))}
          {!!officers.withUnplannedSales?.length && (
            <div>
              <div className="text-xs font-medium">Unplanned sales ({officers.withUnplannedSales.length})</div>
              <ul>{officers.withUnplannedSales.map((officer) => <li key={officer.id}>{officer.name}</li>)}</ul>
            </div>
          )}
          {!!officers.withUnplannedRecovery?.length && (
            <div>
              <div className="text-xs font-medium">Unplanned recovery ({officers.withUnplannedRecovery.length})</div>
              <ul>{officers.withUnplannedRecovery.map((officer) => <li key={officer.id}>{officer.name}</li>)}</ul>
            </div>
          )}
          <div className="mt-1 border-t pt-1.5">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-foreground"><MinusCircle className="h-3.5 w-3.5 text-muted-foreground" /> Not Included ({officers.excluded.length})</div>
            {officers.excluded.length === 0 ? (
              <p className="pl-5 text-muted-foreground">None — every officer contributes.</p>
            ) : (
              <ul className="space-y-0.5 pl-5">
                {officers.excluded.map((o) => <li key={o.name}><span className="text-foreground">{o.name}</span><span className="text-muted-foreground"> — {o.reason}</span></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Product drawer ---------------------------- */

interface OfficerGroup { officerId: string; officerName: string; qty: number; amount: number; nbv: number; dealers: Map<string, { dealerId: string; name: string; qty: number; amount: number; nbv: number }> }

const METRIC_MODES: { id: MetricMode; label: string }[] = [
  { id: "seasonPlan", label: "Season Plan" },
  { id: "seasonSales", label: "Season Sales" },
  { id: "periodSales", label: "Period Sales" },
];

function ProductDrawer({ product, seasonName, filterLabel, onClose }: { product: GroupProductRow; seasonName: string; filterLabel: string; onClose: () => void }) {
  const [openBucket, setOpenBucket] = useState<DrawerBucket | null>(null);
  const [openOfficer, setOpenOfficer] = useState<string | null>(null);
  // Default to PERIOD SALES every time a product opens (the drawer remounts per product via `key`).
  const [metricMode, setMetricMode] = useState<MetricMode>("periodSales");

  // ONE dataset, three synchronized measures. The selected mode drives grand + officer + dealer alike, so
  // levels can never mix plan and actual. Reuses the server's drawer aggregation (never re-derived here).
  const { byBucket, bucketTotals, grand } = useMemo(() => {
    const out: Record<DrawerBucket, OfficerGroup[]> = { approved: [], submitted: [], draft: [], unplanned: [] };
    const totals: Record<DrawerBucket, DrawerMeasure & { officerCount: number }> = {
      approved: { qty: 0, amount: 0, nbv: 0, officerCount: 0 }, submitted: { qty: 0, amount: 0, nbv: 0, officerCount: 0 }, draft: { qty: 0, amount: 0, nbv: 0, officerCount: 0 },
      unplanned: { qty: 0, amount: 0, nbv: 0, officerCount: 0 },
    };
    const g: DrawerMeasure = { qty: 0, amount: 0, nbv: 0 };
    for (const b of DRAWER_BUCKETS) {
      const officers = new Map<string, OfficerGroup>();
      for (const c of product.drawer.filter((x) => x.bucket === b)) {
        const m = c[metricMode];
        if (b === "unplanned" && !m.qty && !m.amount && !m.nbv) continue;
        let og = officers.get(c.officerId);
        if (!og) { og = { officerId: c.officerId, officerName: c.officerName, qty: 0, amount: 0, nbv: 0, dealers: new Map() }; officers.set(c.officerId, og); }
        og.qty += m.qty; og.amount += m.amount; og.nbv += m.nbv;
        const d = og.dealers.get(c.dealerId) ?? { dealerId: c.dealerId, name: c.dealerName, qty: 0, amount: 0, nbv: 0 };
        d.qty += m.qty; d.amount += m.amount; d.nbv += m.nbv;
        og.dealers.set(c.dealerId, d);
        totals[b].qty += m.qty; totals[b].amount += m.amount; totals[b].nbv += m.nbv;
        g.qty += m.qty; g.amount += m.amount; g.nbv += m.nbv;
      }
      totals[b].officerCount = officers.size;
      out[b] = [...officers.values()].sort((a, z) => z.amount - a.amount);
    }
    return { byBucket: out, bucketTotals: totals, grand: g };
  }, [product, metricMode]);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l bg-background shadow-xl">
        <div className="flex items-start justify-between border-b p-4">
          <div>
            <h2 className="text-base font-semibold">{product.productName}</h2>
            <p className="text-xs text-muted-foreground">{filterLabel} · {seasonName}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>

        {/* Metric switcher — controls BOTH the grand totals AND the officer/dealer breakdown below. */}
        <div className="flex gap-1 border-b bg-muted/30 px-4 pt-3">
          {METRIC_MODES.map((mm) => (
            <button key={mm.id} type="button" onClick={() => setMetricMode(mm.id)}
              className={cn("rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium", metricMode === mm.id ? "border-border bg-background text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {mm.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2 border-b bg-muted/30 p-4 text-center text-sm">
          <div><div className="text-xs text-muted-foreground">Grand Qty</div><div className="font-semibold tabular-nums">{qtyFmt(grand.qty)}</div></div>
          <div><div className="text-xs text-muted-foreground">Grand Amount</div><div className="font-semibold tabular-nums">{formatCurrency(grand.amount)}</div></div>
          <div><div className="text-xs text-muted-foreground">Grand NBV</div><div className="font-semibold tabular-nums">{formatCurrency(grand.nbv)}</div></div>
        </div>

        <div className="flex-1 overflow-auto p-3 text-sm">
          {DRAWER_BUCKETS.filter((b) => byBucket[b].length > 0).map((b) => {
            const bt = bucketTotals[b];
            return (
              <div key={b} className="mb-2 rounded-md border">
                <button className="flex w-full items-center justify-between gap-2 p-2.5 text-left" onClick={() => setOpenBucket((x) => (x === b ? null : b))}>
                  <span className="flex items-center gap-1.5 font-semibold">
                    <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", openBucket === b && "rotate-90")} />
                    {b === "unplanned" ? "Unplanned" : BUCKET_LABEL[b]} <span className="text-xs font-normal text-muted-foreground">({bt.officerCount} officer{bt.officerCount === 1 ? "" : "s"})</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{qtyFmt(bt.qty)} · {formatCurrency(bt.amount)} · {formatCurrency(bt.nbv)}</span>
                </button>

                {openBucket === b && (
                  <div className="border-t">
                    {byBucket[b].map((og) => {
                      const key = `${b}:${og.officerId}`;
                      return (
                        <div key={key} className="border-b last:border-b-0">
                          <button className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left" onClick={() => setOpenOfficer((x) => (x === key ? null : key))}>
                            <span className="flex items-center gap-1.5">
                              <ChevronRight className={cn("h-3 w-3 transition-transform", openOfficer === key && "rotate-90")} />
                              <span className="font-medium">{og.officerName}</span>
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground">{qtyFmt(og.qty)} · {formatCurrency(og.amount)} · {formatCurrency(og.nbv)}</span>
                          </button>
                          {openOfficer === key && (
                            <ul className="space-y-1 bg-muted/20 px-3 pb-2 pt-1 text-xs">
                              <DealerOrder>{[...og.dealers.values()].sort((a, z) => z.amount - a.amount).map((d) => (
                                <li key={d.dealerId} data-dealer-id={d.dealerId} className="flex items-center justify-between gap-2">
                                  <span className="truncate text-foreground"><DealerName id={d.dealerId} name={d.name} /></span>
                                  <span className="tabular-nums text-muted-foreground">{qtyFmt(d.qty)} · {formatCurrency(d.amount)} · {formatCurrency(d.nbv)}</span>
                                </li>
                              ))}</DealerOrder>
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
