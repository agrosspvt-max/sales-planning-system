"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, MinusCircle, Users2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency } from "@/lib/utils";
import { type PlanningMode } from "@/lib/calc";
import { PageHeader } from "@/components/layout/page-header";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClearanceTag } from "@/components/ui/clearance-tag";
import { CategoryBadge } from "@/components/ui/category-badge";
import { CategoryFilter } from "@/components/ui/category-filter";
import { useCategories } from "@/lib/use-categories";
import { categoryForNbv, matchesCategoryFilter } from "@/lib/product-category";
import { GroupRecovery } from "./group-recovery-page";

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
}
export interface OfficerRef { id: string; name: string }
export interface GroupOfficerBreakdown {
  total: number; includedCount: number;
  byBucket: Record<StatusBucket, OfficerRef[]>;
  excluded: { name: string; reason: string }[];
}
interface GroupProductPlan {
  groupName: string; seasonName: string; monthlyMode: PlanningMode; seasonalMode: PlanningMode;
  filter: { buckets: StatusBucket[]; view: "total" | "month" | "range"; monthIds: string[] };
  officers: GroupOfficerBreakdown;
  months: { id: string; name: string; order: number }[];
  packSizes: { id: string; name: string }[];
  products: GroupProductRow[];
}

type Tab = "territory" | "product" | "recovery";
type View = "total" | "month" | "range";
const qtyFmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/**
 * Territory (Group) Planning dashboard — READ-ONLY analytics. Aggregates across every Sales Officer in
 * the group. All numbers come from ONE server aggregation (getGroupProductPlan); the client never
 * re-computes totals — it only renders and slices them (so the drawer breakdown always sums to the grid).
 */
interface OfficerOpt { id: string; name: string }

export function GroupPlanPage({ groupId, groupName }: { groupId: string; groupName: string }) {
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

      {tab === "territory" ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">
          Territory Plan — coming soon. This will mirror the Dealer Plan for the whole territory.
        </div>
      ) : tab === "product" ? (
        <GroupProductPlan groupId={groupId} seasonId={effectiveSeason} officerId={officerId} />
      ) : (
        <GroupRecovery groupId={groupId} seasonId={effectiveSeason} officerId={officerId} />
      )}
    </div>
  );
}

/* ------------------------------ Product Plan ------------------------------ */

function GroupProductPlan({ groupId, seasonId, officerId = "" }: { groupId: string; seasonId: string; officerId?: string }) {
  const [view, setView] = useState<View>("total");
  const [monthA, setMonthA] = useState("");
  const [monthB, setMonthB] = useState("");
  const [buckets, setBuckets] = useState<StatusBucket[]>(["approved"]);
  const [drawerProduct, setDrawerProduct] = useState<GroupProductRow | null>(null);
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

  // Month options come from the payload (stable per season). keepPreviousData keeps them during refetch.
  const monthsRef = useRef<{ id: string; name: string; order: number }[]>([]);
  const selectedMonthIds = useMemo(() => {
    const months = monthsRef.current;
    if (view === "month") return monthA ? [monthA] : months[0] ? [months[0].id] : [];
    if (view === "range") {
      const a = months.find((m) => m.id === (monthA || months[0]?.id));
      const b = months.find((m) => m.id === (monthB || months[months.length - 1]?.id));
      if (!a || !b) return [];
      const [lo, hi] = a.order <= b.order ? [a.order, b.order] : [b.order, a.order];
      return months.filter((m) => m.order >= lo && m.order <= hi).map((m) => m.id);
    }
    return [];
  }, [view, monthA, monthB]);

  const bucketsKey = [...buckets].sort().join(",");
  const monthsKey = selectedMonthIds.join(",");
  const { data, isLoading, isFetching } = useQuery<GroupProductPlan>({
    queryKey: ["group-product-plan", groupId, seasonId, view, bucketsKey, monthsKey, officerId, seasonMetrics],
    queryFn: () => api.get(`/api/planning/groups/${groupId}/product-plan?seasonId=${seasonId}&buckets=${bucketsKey || "approved"}&view=${view}&months=${monthsKey}${officerId ? `&officerId=${officerId}` : ""}&seasonMetrics=${seasonMetrics}`),
    enabled: !!seasonId,
    placeholderData: keepPreviousData,
  });
  if (data?.months && data.months.length) monthsRef.current = data.months;

  const months = data?.months ?? monthsRef.current;
  const monthOpts = months.map((m) => ({ value: m.id, label: m.name }));

  const toggleBucket = (b: StatusBucket) =>
    setBuckets((prev) => {
      const next = prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b];
      return next.length ? next : prev; // keep at least one selected
    });

  if (!seasonId) return <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">Choose a season to view the group Product Plan.</p>;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  // Column totals across every product (Season Baseline qty+amount, and period).
  const T = data.products.reduce(
    (a, r) => ({
      seasonQty: a.seasonQty + r.seasonQty,
      plannedAllMonths: a.plannedAllMonths + r.plannedAllMonths,
      remaining: a.remaining + r.remaining,
      seasonSales: a.seasonSales + r.seasonSales,
      pendingSales: a.pendingSales + r.pendingSales,
      seasonAmount: a.seasonAmount + r.seasonAmount,
      plannedAllMonthsAmount: a.plannedAllMonthsAmount + r.plannedAllMonthsAmount,
      remainingAmount: a.remainingAmount + r.remainingAmount,
      seasonSalesAmount: a.seasonSalesAmount + r.seasonSalesAmount,
      pendingAmount: a.pendingAmount + r.pendingAmount,
      periodPlan: a.periodPlan + r.total.qty,
      periodSold: a.periodSold + r.actual.qty,
      plannedAmount: a.plannedAmount + r.total.amount,
      plannedNbv: a.plannedNbv + r.total.nbv,
      actualAmount: a.actualAmount + r.actual.amount,
      actualNbv: a.actualNbv + r.actual.nbv,
    }),
    { seasonQty: 0, plannedAllMonths: 0, remaining: 0, seasonSales: 0, pendingSales: 0, seasonAmount: 0, plannedAllMonthsAmount: 0, remainingAmount: 0, seasonSalesAmount: 0, pendingAmount: 0, periodPlan: 0, periodSold: 0, plannedAmount: 0, plannedNbv: 0, actualAmount: 0, actualNbv: 0 },
  );
  const periodLabel = view === "total" ? "Seasonal Total" : view === "month" ? "Specific Month" : "Month Range";
  const seasonSpan = showAmounts ? 10 : 5; // Season Baseline column count (qty [+ amount] × 5 metrics)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter buckets={buckets} onToggle={toggleBucket} />
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
          <NativeSelect className="w-44" options={monthOpts} value={monthA || months[0].id} onChange={(e) => setMonthA(e.target.value)} />
        )}
        {view === "range" && months.length > 0 && (
          <div className="flex items-center gap-2">
            <NativeSelect className="w-40" options={monthOpts} value={monthA || months[0].id} onChange={(e) => setMonthA(e.target.value)} />
            <span className="text-sm text-muted-foreground">to</span>
            <NativeSelect className="w-40" options={monthOpts} value={monthB || months[months.length - 1].id} onChange={(e) => setMonthB(e.target.value)} />
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {view === "total" ? "Filtering Seasonal Plans" : "Filtering Monthly Plans"} by: {buckets.map((b) => BUCKET_LABEL[b]).join(", ")}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Season Baseline mode — Approved (management default) vs Follow the selected status filters. */}
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
        <CategoryFilter categories={categories} value={categoryFilter} onChange={setCategoryFilter} />
      </div>

      {data.products.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">No plan data for this group, season and selected states.</div>
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
                <TableHead className="border-l text-right" title="Total seasonal quantity planned (Approved seasonal plan by default)">Season Qty</TableHead>
                {showAmounts && <TableHead className="text-right" title="Amount for Season Qty">Season Amt</TableHead>}
                <TableHead className="text-right" title="Quantity distributed into monthly plans across ALL months">Planned (All Mo.)</TableHead>
                {showAmounts && <TableHead className="text-right" title="Amount for Planned (All Months)">Planned Amt</TableHead>}
                <TableHead className="text-right" title="Season Qty − Planned (All Months)">Remaining</TableHead>
                {showAmounts && <TableHead className="text-right" title="Season Amount − Planned Amount">Remaining Amt</TableHead>}
                <TableHead className="text-right" title="Actual sales quantity for the complete season">Season Sales</TableHead>
                {showAmounts && <TableHead className="text-right" title="Amount for Season Sales">Sales Amt</TableHead>}
                <TableHead className="text-right" title="Pending Sales = Season Qty − Season Sales">Pending</TableHead>
                {showAmounts && <TableHead className="text-right" title="Season Amount − Sales Amount">Pending Amt</TableHead>}
                <TableHead className="border-l text-right" title="Plan for the selected period (season / month / range)">Period Plan</TableHead>
                <TableHead className="text-right" title="Sold in the selected period">Period Sold</TableHead>
                <TableHead className="border-l text-right" title="Planned Amount for This Period Plan">Plan Amt</TableHead>
                <TableHead className="text-right" title="Planned NBV for This Period Plan">Plan NBV</TableHead>
                <TableHead className="text-right text-muted-foreground" title="Actual Amount for This Period Sold">Act. Amt</TableHead>
                <TableHead className="text-right text-muted-foreground" title="Actual NBV for This Period Sold">Act. NBV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.products.filter((r) => matchesCategoryFilter(r.nbvPercent, categoryFilter, categories)).map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">
                    <button className="inline-flex flex-wrap items-center gap-1 text-left hover:underline" onClick={() => setDrawerProduct(r)}>
                      <span className={r.isClearance ? "text-warning" : "text-primary"}>{r.productName}</span>{r.isClearance && <ClearanceTag qty={r.clearanceQty} />}
                      <CategoryBadge category={categoryForNbv(r.nbvPercent, categories)} /> <ChevronRight className="h-3.5 w-3.5 text-primary" />
                    </button>
                  </TableCell>
                  <TableCell className="border-l text-right tabular-nums">{qtyFmt(r.seasonQty)}</TableCell>
                  {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(r.seasonAmount)}</TableCell>}
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.plannedAllMonths)}</TableCell>
                  {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(r.plannedAllMonthsAmount)}</TableCell>}
                  <TableCell className={cn("text-right tabular-nums", r.remaining < 0 && "text-destructive")}>{qtyFmt(r.remaining)}</TableCell>
                  {showAmounts && <TableCell className={cn("text-right tabular-nums", r.remainingAmount < 0 && "text-destructive")}>{formatCurrency(r.remainingAmount)}</TableCell>}
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.seasonSales)}</TableCell>
                  {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(r.seasonSalesAmount)}</TableCell>}
                  <TableCell className={cn("text-right tabular-nums", r.pendingSales < 0 && "text-destructive")}>{qtyFmt(r.pendingSales)}</TableCell>
                  {showAmounts && <TableCell className={cn("text-right tabular-nums", r.pendingAmount < 0 && "text-destructive")}>{formatCurrency(r.pendingAmount)}</TableCell>}
                  <TableCell className="border-l text-right tabular-nums">{qtyFmt(r.total.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.actual.qty)}</TableCell>
                  <TableCell className="border-l text-right tabular-nums">{formatCurrency(r.total.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.total.nbv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actual.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actual.nbv)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className="border-l text-right tabular-nums">{qtyFmt(T.seasonQty)}</TableCell>
                {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(T.seasonAmount)}</TableCell>}
                <TableCell className="text-right tabular-nums">{qtyFmt(T.plannedAllMonths)}</TableCell>
                {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(T.plannedAllMonthsAmount)}</TableCell>}
                <TableCell className="text-right tabular-nums">{qtyFmt(T.remaining)}</TableCell>
                {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(T.remainingAmount)}</TableCell>}
                <TableCell className="text-right tabular-nums">{qtyFmt(T.seasonSales)}</TableCell>
                {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(T.seasonSalesAmount)}</TableCell>}
                <TableCell className="text-right tabular-nums">{qtyFmt(T.pendingSales)}</TableCell>
                {showAmounts && <TableCell className="text-right tabular-nums">{formatCurrency(T.pendingAmount)}</TableCell>}
                <TableCell className="border-l text-right tabular-nums">{qtyFmt(T.periodPlan)}</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(T.periodSold)}</TableCell>
                <TableCell className="border-l text-right tabular-nums">{formatCurrency(T.plannedAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(T.plannedNbv)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(T.actualAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(T.actualNbv)}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </div>
      )}

      {drawerProduct && (
        <ProductDrawer
          product={drawerProduct}
          seasonName={data.seasonName}
          filterLabel={`${view === "total" ? "Seasonal Total" : view === "month" ? "Specific Month" : "Month Range"} · ${buckets.map((b) => BUCKET_LABEL[b]).join(", ")}`}
          onClose={() => setDrawerProduct(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------ Status filter ----------------------------- */

export function StatusFilter({ buckets, onToggle }: { buckets: StatusBucket[]; onToggle: (b: StatusBucket) => void }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-md border bg-background px-3 py-1.5 text-sm">
      <span className="font-medium text-muted-foreground">Included Plans</span>
      {ALL_BUCKETS.map((b) => (
        <label key={b} className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="h-4 w-4" checked={buckets.includes(b)} onChange={() => onToggle(b)} />
          {BUCKET_LABEL[b]}
        </label>
      ))}
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

interface OfficerGroup { officerId: string; officerName: string; qty: number; amount: number; nbv: number; plans: Set<string>; dealers: Map<string, { name: string; qty: number; amount: number; nbv: number }> }

function ProductDrawer({ product, seasonName, filterLabel, onClose }: { product: GroupProductRow; seasonName: string; filterLabel: string; onClose: () => void }) {
  const [openBucket, setOpenBucket] = useState<StatusBucket | null>(null);
  const [openOfficer, setOpenOfficer] = useState<string | null>(null);

  // Group the SAME contributions the grid summed — so the drawer numbers add up to product.total exactly.
  const byBucket = useMemo(() => {
    const out: Record<StatusBucket, OfficerGroup[]> = { approved: [], submitted: [], draft: [] };
    for (const b of ALL_BUCKETS) {
      const officers = new Map<string, OfficerGroup>();
      for (const c of product.contributions.filter((x) => x.bucket === b)) {
        let og = officers.get(c.officerId);
        if (!og) { og = { officerId: c.officerId, officerName: c.officerName, qty: 0, amount: 0, nbv: 0, plans: new Set(), dealers: new Map() }; officers.set(c.officerId, og); }
        og.qty += c.qty; og.amount += c.amount; og.nbv += c.nbv;
        og.plans.add(`${c.planType} v${c.version} · ${c.status}${c.monthName ? ` · ${c.monthName}` : ""}`);
        const d = og.dealers.get(c.dealerId) ?? { name: c.dealerName, qty: 0, amount: 0, nbv: 0 };
        d.qty += c.qty; d.amount += c.amount; d.nbv += c.nbv;
        og.dealers.set(c.dealerId, d);
      }
      out[b] = [...officers.values()].sort((a, z) => z.amount - a.amount);
    }
    return out;
  }, [product]);

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

        <div className="grid grid-cols-3 gap-2 border-b bg-muted/30 p-4 text-center text-sm">
          <div><div className="text-xs text-muted-foreground">Grand Qty</div><div className="font-semibold tabular-nums">{qtyFmt(product.total.qty)}</div></div>
          <div><div className="text-xs text-muted-foreground">Grand Amount</div><div className="font-semibold tabular-nums">{formatCurrency(product.total.amount)}</div></div>
          <div><div className="text-xs text-muted-foreground">Grand NBV</div><div className="font-semibold tabular-nums">{formatCurrency(product.total.nbv)}</div></div>
        </div>

        <div className="flex-1 overflow-auto p-3 text-sm">
          {ALL_BUCKETS.filter((b) => product.byBucket[b].officerCount > 0 || byBucket[b].length > 0).map((b) => {
            const bt = product.byBucket[b];
            return (
              <div key={b} className="mb-2 rounded-md border">
                <button className="flex w-full items-center justify-between gap-2 p-2.5 text-left" onClick={() => setOpenBucket((x) => (x === b ? null : b))}>
                  <span className="flex items-center gap-1.5 font-semibold">
                    <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", openBucket === b && "rotate-90")} />
                    {BUCKET_LABEL[b]} <span className="text-xs font-normal text-muted-foreground">({bt.officerCount} officer{bt.officerCount === 1 ? "" : "s"})</span>
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
                              <span className="text-[11px] text-muted-foreground">{[...og.plans].join(" · ")}</span>
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground">{qtyFmt(og.qty)} · {formatCurrency(og.amount)} · {formatCurrency(og.nbv)}</span>
                          </button>
                          {openOfficer === key && (
                            <ul className="space-y-1 bg-muted/20 px-3 pb-2 pt-1 text-xs">
                              {[...og.dealers.values()].sort((a, z) => z.amount - a.amount).map((d) => (
                                <li key={d.name} className="flex items-center justify-between gap-2">
                                  <span className="truncate text-foreground">{d.name}</span>
                                  <span className="tabular-nums text-muted-foreground">{qtyFmt(d.qty)} · {formatCurrency(d.amount)} · {formatCurrency(d.nbv)}</span>
                                </li>
                              ))}
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
