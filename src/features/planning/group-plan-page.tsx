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
  packSums: Record<string, number>;
  total: { qty: number; amount: number; nbv: number };
  actual: { qty: number; amount: number; nbv: number };
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

  const { data: seasons } = useQuery<Season[]>({ queryKey: ["seasons"], queryFn: () => api.get("/api/seasons") });
  // Officers of THIS group. The endpoint is group-scoped for RMs (their own group only), so the
  // dropdown can never list officers outside the viewed group.
  const { data: officers } = useQuery<OfficerOpt[]>({
    queryKey: ["officers", groupId, "group-territory"],
    queryFn: () => api.get<OfficerOpt[]>(`/api/users/officers?groupId=${groupId}&filter=active`),
  });
  const effectiveSeason = seasonId || seasons?.[0]?.id || "";

  return (
    <div className="space-y-4">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Users", href: "/masters/users" }, { label: groupName }, { label: "Territory Plan" }]}
        title={`${groupName} — Territory Plan`}
        subtitle="Read-only analytics aggregated across every Sales Officer in this group. Nothing here is editable."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Sales Officer</span>
            <NativeSelect
              className="w-52"
              options={[{ value: "", label: "All Sales Officers" }, ...(officers ?? []).map((o) => ({ value: o.id, label: o.name }))]}
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
    queryKey: ["group-product-plan", groupId, seasonId, view, bucketsKey, monthsKey, officerId],
    queryFn: () => api.get(`/api/planning/groups/${groupId}/product-plan?seasonId=${seasonId}&buckets=${bucketsKey || "approved"}&view=${view}&months=${monthsKey}${officerId ? `&officerId=${officerId}` : ""}`),
    enabled: !!seasonId,
    placeholderData: keepPreviousData,
  });
  if (data?.months && data.months.length) monthsRef.current = data.months;

  const months = data?.months ?? monthsRef.current;
  const monthOpts = months.map((m) => ({ value: m.id, label: m.name }));
  const packMode = (data?.seasonalMode ?? "PACK_SIZE") === "PACK_SIZE";
  const showPackCols = view === "total" && packMode && (data?.packSizes.length ?? 0) > 0;

  const toggleBucket = (b: StatusBucket) =>
    setBuckets((prev) => {
      const next = prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b];
      return next.length ? next : prev; // keep at least one selected
    });

  if (!seasonId) return <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">Choose a season to view the group Product Plan.</p>;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const packCols = data.packSizes;
  const gtotal = data.products.reduce(
    (a, r) => ({ qty: a.qty + r.total.qty, amount: a.amount + r.total.amount, nbv: a.nbv + r.total.nbv }),
    { qty: 0, amount: 0, nbv: 0 },
  );

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

      {data.products.length === 0 ? (
        <div className="rounded-lg border bg-background p-10 text-center text-sm text-muted-foreground">No plan data for this group, season and selected states.</div>
      ) : (
        <div className="overflow-auto rounded-lg border bg-background">
          <Table stickyFirstColumn>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">Product</TableHead>
                {showPackCols && packCols.map((p) => <TableHead key={p.id} className="text-center">{p.name}</TableHead>)}
                <TableHead className="text-right">Total Qty</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
                <TableHead className="text-right">Planned NBV</TableHead>
                <TableHead className="text-right text-muted-foreground">{view === "total" ? "Actual Qty" : "Sold Qty"}</TableHead>
                <TableHead className="text-right text-muted-foreground">{view === "total" ? "Actual Amount" : "Sold Amount"}</TableHead>
                <TableHead className="text-right text-muted-foreground">{view === "total" ? "Actual NBV" : "Sold NBV"}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.products.map((r) => (
                <TableRow key={r.productId}>
                  <TableCell className="font-medium">
                    <button className="inline-flex items-center gap-1 text-left text-primary hover:underline" onClick={() => setDrawerProduct(r)}>
                      {r.productName} <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </TableCell>
                  {showPackCols && packCols.map((p) => <TableCell key={p.id} className="text-center tabular-nums">{qtyFmt(r.packSums[p.id] ?? 0)}</TableCell>)}
                  <TableCell className="text-right tabular-nums">{qtyFmt(r.total.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.total.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.total.nbv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{qtyFmt(r.actual.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actual.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(r.actual.nbv)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                {showPackCols && packCols.map((p) => <TableCell key={p.id} className="text-center tabular-nums">{qtyFmt(data.products.reduce((s, r) => s + (r.packSums[p.id] ?? 0), 0))}</TableCell>)}
                <TableCell className="text-right tabular-nums">{qtyFmt(gtotal.qty)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(gtotal.amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(gtotal.nbv)}</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(data.products.reduce((s, r) => s + r.actual.qty, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(data.products.reduce((s, r) => s + r.actual.amount, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(data.products.reduce((s, r) => s + r.actual.nbv, 0))}</TableCell>
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
