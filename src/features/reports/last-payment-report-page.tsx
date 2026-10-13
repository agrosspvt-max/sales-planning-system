"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dealerStatusLabel } from "@/lib/dealer-status";
import { useAdminPermission, useCanCreateBillingException } from "@/features/accounts/permission-ui";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ColumnFilterHeader } from "@/components/ui/column-filter-header";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { PillNav, UnderlineTabs } from "@/features/planning/plan-list-ui";
import { PaymentAgingFilterControl } from "./payment-aging-filter";
import { BillingExceptionActionDialog, BillingExceptionInfoDialog, BillingStatusCell } from "./billing-exception-ui";
import { EMPTY_EXCEPTION_SUMMARY, type BillingExceptionRow, type ExceptionRankEntry, type ExceptionRanking, type ExceptionSummary, type ExceptionView } from "@/lib/billing-exception";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AUTH_FILTER_OPTIONS, BILLING_FILTER_OPTIONS, DAY_BUCKETS, DEFAULT_DAYS_SORT, bucketOfAging, dayBucketAsAging, NO_EXPORT_DATA_MESSAGE, applyFilterStep, formatLastUpdate, parseLastPaymentReportParams, paymentAgingToParams, sameReportFilters, REPORT_DEFAULT_PAGE_SIZE, REPORT_FILTER_KEYS,
  type DayBucketKey, type DaySummary, type DaysSort, type LastPaymentReportRow, type PaymentAgingFilter, type ReportFilterKey, type ReportFilterOptions, type ReportFilters,
} from "@/lib/last-payment-report";

/** The three tables of the page: the Last Payment report itself, and Billing Exception → Current / History (one row per exception). */
type ReportViewKey = "last-payment" | ExceptionView;
interface ReportPage {
  /** Last Payment tab only: dealer counts (before the quick filter) for the summary panel. */
  summary?: DaySummary & Partial<ExceptionSummary>;
  items: (LastPaymentReportRow | BillingExceptionRow)[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Filter options built from the caller's scoped dataset (never from the whole database). */
  options: ReportFilterOptions;
  /** The selections the server actually applied — incompatible ones (e.g. a Territory outside the new State) are dropped. */
  appliedFilters: ReportFilters;
  /** Business date (YYYY-MM-DD) of the most recent successful Day Book upload, or null. */
  lastUpdate: string | null;
}

// Column order: Party | Status | State | Territory | Sales Officer. `width` rebalances the (fixed-layout) table: Party takes the
// remaining space, the rest are compact — no large empty gaps between the right-hand columns.
const FILTER_COLUMNS: { key: ReportFilterKey; label: string; width?: string }[] = [
  { key: "party", label: "Party" },
  { key: "status", label: "Status", width: "w-28" },
  { key: "state", label: "State", width: "w-24" },
  { key: "territory", label: "Territory", width: "w-40" },
  { key: "officer", label: "Sales Officer", width: "w-36" },
];
const NO_OPTIONS: ReportFilterOptions = { party: [], status: [], state: [], territory: [], officer: [], billing: BILLING_FILTER_OPTIONS, authBy: AUTH_FILTER_OPTIONS };
const STATUS_VARIANT: Record<string, "success" | "muted" | "secondary" | "destructive"> = { ACTIVE: "success", INACTIVE: "muted", PENDING: "secondary", DEFAULTER: "destructive" };

const dash = <span className="text-muted-foreground">—</span>;
// Receipt dates are plain calendar dates: build a local-midnight Date so no timezone can shift the day.
const dateLabel = (isoDate: string) => formatDate(new Date(`${isoDate}T00:00:00`));

/** Billing Exception summary (Total Ex. Bills · Dealers · Top Dealers · Top SO) — same container / label / count look as the Last Payment panel. Informational only: nothing here filters the table. */
function ExceptionSummaryPanel({ summary }: { summary: ExceptionSummary | undefined }) {
  const [open, setOpen] = useState<"dealers" | "officers" | null>(null);
  const s = summary ?? EMPTY_EXCEPTION_SUMMARY;
  const count = (n: number | undefined) => (summary ? new Intl.NumberFormat("en-IN").format(n ?? 0) : "—");
  const preview = (entries: ExceptionRankEntry[]) => entries.length === 0
    ? <div className="text-sm text-muted-foreground">—</div>
    : <ol className="space-y-0.5 text-xs">{entries.map((e, i) => <li key={e.id} className="flex justify-between gap-2"><span className="truncate">{i + 1}. {e.name}</span><span className="font-semibold tabular-nums">{e.bills}</span></li>)}</ol>;
  const ranked = (title: string, testId: string, entries: ExceptionRankEntry[], kind: "dealers" | "officers") => (
    <button
      type="button" onClick={() => setOpen(kind)} data-testid={testId} aria-haspopup="dialog" title={`${title} — details`}
      className="-m-1 col-span-2 min-w-0 cursor-pointer rounded-md p-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:col-span-1"
    >
      <div className="mb-0.5 text-xs text-muted-foreground">{title}</div>
      {preview(entries)}
    </button>
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-3 rounded-lg border bg-background p-4 sm:grid-cols-4" data-testid="exception-summary">
        <div><div className="text-xs text-muted-foreground">Total Ex. Bills</div><div className="text-lg font-semibold tabular-nums" data-testid="summary-total-bills">{count(summary?.totalBills)}</div></div>
        <div><div className="text-xs text-muted-foreground">Dealers</div><div className="text-lg font-semibold tabular-nums" data-testid="summary-dealers">{count(summary?.dealers)}</div></div>
        {ranked("Top Dealers", "summary-top-dealers", s.topDealers.byBills, "dealers")}
        {ranked("Top SO", "summary-top-so", s.topOfficers.byBills, "officers")}
      </div>
      {open === "dealers" && <RankingDialog title="Top Dealers" nameHeader="Dealer Name" ranking={s.topDealers} incomplete={s.amountsIncomplete} onClose={() => setOpen(null)} />}
      {open === "officers" && <RankingDialog title="Top Sales Officers" nameHeader="Sales Officer" ranking={s.topOfficers} incomplete={s.amountsIncomplete} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Small information popup: Rank → name → No of Bills → Total Billing Amount, ranked by the chosen metric (each metric's list is computed on the server from ALL entries). */
function RankingDialog({ title, nameHeader, ranking, incomplete, onClose }: { title: string; nameHeader: string; ranking: ExceptionRanking; incomplete: boolean; onClose: () => void }) {
  const [metric, setMetric] = useState<"bills" | "amount">("bills");
  const entries = metric === "bills" ? ranking.byBills : ranking.byAmount;
  const anyIncomplete = entries.some((e) => e.incomplete);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto" data-testid="ranking-dialog">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <PillNav value={metric} onChange={setMetric} items={[{ value: "bills", label: "No of Bills" }, { value: "amount", label: "Amount of Bills" }]} />
        {entries.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground" data-testid="ranking-empty">No billing exceptions match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-1 pr-2 font-medium">Rank</th><th className="py-1 pr-2 font-medium">{nameHeader}</th><th className="py-1 pr-2 text-right font-medium">No of Bills</th><th className="py-1 text-right font-medium">Total Billing Amount</th></tr></thead>
              <tbody data-testid="ranking-rows">
                {entries.map((e, i) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 tabular-nums">{i + 1}</td>
                    <td className="py-1.5 pr-2 font-medium">{e.name}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{e.bills}</td>
                    <td className="py-1.5 text-right tabular-nums">{e.incomplete && e.amount === 0 ? dash : formatCurrency(e.amount)}{e.incomplete && e.amount !== 0 ? <span title="Some exceptions have no saved Billing Amount">*</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(anyIncomplete || (incomplete && entries.length > 0 && entries.some((e) => e.incomplete))) && <p className="text-xs text-muted-foreground" data-testid="ranking-incomplete">* Some exceptions were recorded without a Billing Amount; those are left out of the amount, so it is incomplete.</p>}
      </DialogContent>
    </Dialog>
  );
}

const countText = (n: number | undefined) => (n === undefined ? "—" : new Intl.NumberFormat("en-IN").format(n));
/** Clickable dealer summary (Performance's summary-panel look: bordered container, muted labels, bold counts). Counts come from the server for the whole filtered result. */
function DaySummaryPanel({ summary, selected, onSelect, onAll }: { summary: DaySummary | undefined; selected: DayBucketKey | null; onSelect: (key: DayBucketKey) => void; onAll: () => void }) {
  const item = (label: string, count: number | undefined, active: boolean, onClick: () => void, testId: string) => (
    <button
      key={testId} type="button" onClick={onClick} aria-pressed={active} data-testid={testId} title={label}
      className={`-m-1 cursor-pointer rounded-md p-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-primary/10 ring-1 ring-primary" : ""}`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{countText(count)}</div>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border bg-background p-4 sm:grid-cols-3 lg:grid-cols-6" data-testid="day-summary">
      {item("All Dealers", summary?.total, selected === null, onAll, "summary-all")}
      {DAY_BUCKETS.map((b) => item(b.label, summary?.buckets[b.key], selected === b.key, () => onSelect(b.key), `summary-${b.key}`))}
    </div>
  );
}

/**
 * One table of the page. Scope, search, Days sorting, filters and paging are all applied by the server; the three views share this
 * component (and the same search / filter / Payment Aging / export controls) and differ only in endpoint, extra column and row identity.
 */
function ReportView({ view }: { view: ReportViewKey }) {
  const exceptionView = view !== "last-payment";
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DaysSort>(DEFAULT_DAYS_SORT);
  const [page, setPage] = useState(1);
  // Column filters (Party / Status / State / Territory / Sales Officer) are applied EXPLICITLY:
  //   pending  = what the user has selected in the dropdowns (drives the cascading OPTIONS and the header counts only)
  //   applied  = what the table, the export and the URL use — it changes only when "Apply Filters" is clicked.
  // Both start from the filters in the URL (if any). Search, the Days sort and Payment Aging (which has its own Apply) are unchanged.
  const urlFilters = parseLastPaymentReportParams(new URLSearchParams(useSearchParams()?.toString() ?? "")).filters;
  const [pending, setPending] = useState<ReportFilters>(urlFilters);
  // Payment Aging (Days) filter: separate from the Days sort — setting it never touches the sort, and vice versa.
  const [aging, setAging] = useState<PaymentAgingFilter | null>(null);
  const [applied, setApplied] = useState<ReportFilters>(urlFilters);
  const [applying, setApplying] = useState(false);
  // Summary panel quick filter (one selected day range, or none). It is a separate layer ON TOP of the manual Days filter: counts are taken before it, the table after it.
  const [bucket, setBucket] = useState<DayBucketKey | null>(null);
  // Billing Exception: the dealer whose status was clicked (action popup → form) and the exception whose Info is open.
  const [target, setTarget] = useState<{ dealerId: string; party: string } | null>(null);
  const [infoId, setInfoId] = useState<string | null>(null);
  const canCreate = useCanCreateBillingException(); // Super Admin / a Custom Admin granted create — never SO / RM

  // The report's query string. The table (paged) and the Excel export (all rows) are built from the SAME function, so the export
  // always carries exactly the filters / search / Payment Aging / Days sort that are in effect at the moment it is requested.
  const reportQuery = (extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ search, sort, ...extra });
    for (const key of REPORT_FILTER_KEYS) for (const value of applied[key] ?? []) query.append(key, value); // APPLIED, never pending
    paymentAgingToParams(aging, query);
    if (bucket && !exceptionView) query.set("bucket", bucket);
    return query;
  };
  const canExport = useAdminPermission("reports", "export");
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const exportReport = async () => {
    if (exporting) return; // no duplicate requests
    setExportMessage(null);
    if (data && data.total === 0) { setExportMessage(NO_EXPORT_DATA_MESSAGE); return; }
    setExporting(true);
    try {
      const response = await fetch(exceptionView ? `/api/reports/last-payment/billing-exceptions/export?${reportQuery({ view })}` : `/api/reports/last-payment/export?${reportQuery()}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setExportMessage(body.error ?? "Failed to export report");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = exceptionView ? `Billing_Exception_${view === "history" ? "History" : "Current"}.xlsx` : "Last_Payment_Report.xlsx";
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportMessage("Failed to export report");
    } finally {
      setExporting(false);
    }
  };

  const { data, isLoading, isFetching, error, isPlaceholderData } = useQuery<ReportPage>({
    queryKey: exceptionView ? ["billing-exceptions", view, search, sort, page, applied, aging] : ["last-payment-report", search, sort, page, applied, aging, bucket],
    queryFn: () => exceptionView
      ? api.get(`/api/reports/last-payment/billing-exceptions?${reportQuery({ view, page: String(page), pageSize: String(REPORT_DEFAULT_PAGE_SIZE) })}`)
      : api.get(`/api/reports/last-payment?${reportQuery({ page: String(page), pageSize: String(REPORT_DEFAULT_PAGE_SIZE) })}`),
    placeholderData: keepPreviousData, // keeps the filter options (and table) steady while a new filter loads
  });
  // Cascading dropdown options follow the PENDING selections (a lightweight options-only request: no table rows, no receipt lookup),
  // so choosing State = MP immediately narrows Territory / Sales Officer / Party / Status while the table keeps showing the
  // applied result. The server also returns the cleaned selection: children that no longer fit are cleared from `pending`.
  const optionsQuery = useQuery<{ options: ReportFilterOptions; appliedFilters: ReportFilters }>({
    queryKey: exceptionView ? ["billing-exceptions-options", view, pending] : ["last-payment-report-options", pending],
    queryFn: () => {
      const query = new URLSearchParams({ optionsOnly: "1" });
      for (const key of REPORT_FILTER_KEYS) for (const value of pending[key] ?? []) query.append(key, value);
      if (exceptionView) { query.set("view", view); return api.get(`/api/reports/last-payment/billing-exceptions?${query}`); }
      return api.get(`/api/reports/last-payment?${query}`);
    },
    placeholderData: keepPreviousData,
  });
  const options = optionsQuery.data?.options ?? data?.options ?? NO_OPTIONS;
  useEffect(() => {
    const cleaned = optionsQuery.data?.appliedFilters;
    if (cleaned && !optionsQuery.isPlaceholderData && !sameReportFilters(cleaned, pending)) setPending(cleaned);
  }, [optionsQuery.data, optionsQuery.isPlaceholderData, pending]);
  // The applied selection was already cleaned (it came from `pending`); adopt the server's cleaned copy defensively.
  useEffect(() => {
    if (data && !isPlaceholderData && data.appliedFilters && !sameReportFilters(data.appliedFilters, applied)) setApplied(data.appliedFilters);
  }, [data, isPlaceholderData, applied]);
  // "Apply Filters": nothing is fetched until it is clicked; with no pending change it does nothing (no needless refetch).
  const dirty = !sameReportFilters(pending, applied);
  const applyFilters = () => {
    const next = applyFilterStep({ pending, applied, page, applying }); // no duplicate clicks; no refetch when nothing changed
    if (!next.changed) return;
    setApplying(next.applying);
    setApplied(next.applied);
    setPage(next.page); // a changed filter always starts at page 1
    if (typeof window !== "undefined") { // the APPLIED filters (only) are mirrored to the URL, without adding history entries
      const url = new URLSearchParams(window.location.search);
      for (const key of REPORT_FILTER_KEYS) url.delete(key);
      for (const key of REPORT_FILTER_KEYS) for (const value of pending[key] ?? []) url.append(key, value);
      window.history.replaceState(null, "", url.toString() ? `?${url}` : window.location.pathname);
    }
  };
  useEffect(() => { if (applying && !isFetching) setApplying(false); }, [applying, isFetching]);

  return (
    <div className="space-y-5">
      {/* Search on the left, the read-only Last Update on the right of the SAME row; wraps (no overflow) on narrow screens. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-72 max-w-sm"
            placeholder="Search parties…"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          />
          <Button size="sm" variant={dirty ? "default" : "outline"} disabled={applying} onClick={applyFilters} aria-busy={applying}>
            {applying && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {applying ? "Applying…" : "Apply Filters"}
          </Button>
        </div>
        <div className="flex items-center gap-3">
          {canExport && (
            <Button variant="outline" size="sm" disabled={exporting || isLoading} onClick={() => void exportReport()}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} {exporting ? "Exporting…" : "Export"}
            </Button>
          )}
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" data-testid="last-update">Last Update: {formatLastUpdate(data?.lastUpdate) ?? "—"}</span>
        </div>
      </div>
      {exportMessage && <p className="text-sm text-destructive" role="alert">{exportMessage}</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {exceptionView && <ExceptionSummaryPanel summary={data?.summary as ExceptionSummary | undefined} />}
      {!exceptionView && (
        <DaySummaryPanel
          summary={data?.summary}
          selected={bucket}
          onSelect={(key) => { setBucket(key); setPage(1); }}
          onAll={() => {
            // "All Dealers": back to everything the user may see — search, every column filter (Billing Status included), the Days constraint and the quick filter.
            setSearch(""); setPending({}); setApplied({}); setAging(null); setBucket(null); setPage(1);
            if (typeof window !== "undefined") window.history.replaceState(null, "", window.location.pathname);
          }}
        />
      )}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table className={exceptionView ? "min-w-[1360px] table-fixed" : "min-w-[1130px] table-fixed"}>
          <TableHeader>
            <TableRow>
              {FILTER_COLUMNS.map(({ key, label, width }) => (
                <ColumnFilterHeader
                  key={key}
                  className={width}
                  label={label}
                  ariaLabel={`Filter by ${label}`}
                  options={options[key]}
                  selected={pending[key] ?? []}
                  onChange={(next) => setPending((current) => ({ ...current, [key]: next }))}
                />
              ))}
              <TableHead className="w-40 text-right">Last Payment Date</TableHead>
              <TableHead className="w-24 text-right" aria-sort={sort === "days_asc" ? "ascending" : "descending"}>
                <div className="inline-flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Sort by Days"
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
                  onClick={() => { setSort(sort === "days_asc" ? "days_desc" : "days_asc"); setPage(1); }}
                >
                  Days
                  {sort === "days_asc" ? <ArrowUp className="h-3.5 w-3.5" aria-label="ascending" /> : <ArrowDown className="h-3.5 w-3.5" aria-label="descending" />}
                </button>
                {/* One Days filter: with a quick-filter range selected and no manual constraint, the control shows that range; changing / clearing it here keeps both in step. */}
                <PaymentAgingFilterControl
                  value={aging ?? (bucket ? dayBucketAsAging(bucket) : null)}
                  onChange={(next) => {
                    const exact = bucketOfAging(next);
                    setBucket(exact); // an exact quick-filter range selects that item; a custom constraint or "All" clears the selection
                    setAging(exact ? null : next);
                    setPage(1);
                  }}
                />
                </div>
              </TableHead>
              {exceptionView ? (
                <>
                  <TableHead className="w-32 text-right">Billing Date</TableHead>
                  <ColumnFilterHeader className="w-36" label="Authorized By" ariaLabel="Filter by Authorized By" options={AUTH_FILTER_OPTIONS} selected={pending.authBy ?? []} onChange={(next) => setPending((current) => ({ ...current, authBy: next }))} />
                  <TableHead className="w-20 text-center">Info</TableHead>
                </>
              ) : (
                // Same component / dropdown / selection / Apply Filters behaviour as the Sales Officer header filter.
                <ColumnFilterHeader className="w-40" label="Billing Status" ariaLabel="Filter by Billing Status" options={BILLING_FILTER_OPTIONS} selected={pending.billing ?? []} onChange={(next) => setPending((current) => ({ ...current, billing: next }))} />
              )}
            </TableRow>
          </TableHeader>
          <DealerTableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={exceptionView ? 10 : 8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : !data || data.items.length === 0 ? (
              <TableRow><TableCell colSpan={exceptionView ? 10 : 8} className="py-8 text-center text-muted-foreground">{exceptionView ? "No billing exceptions found." : "No dealers found."}</TableCell></TableRow>
            ) : (
              data.items.map((row) => (
                // One row per EXCEPTION in the exception views (its id is the key — a dealer with three exceptions has three rows).
                <TableRow key={"exceptionId" in row ? row.exceptionId : row.dealerId} data-dealer-id={row.dealerId} {...("exceptionId" in row ? { "data-exception-id": row.exceptionId } : {})}>
                  <TableCell className="font-medium"><DealerName id={row.dealerId} name={row.party} /></TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[row.status] ?? "muted"}>{dealerStatusLabel(row.status)}</Badge></TableCell>
                  <TableCell>{row.state ?? dash}</TableCell>
                  <TableCell>{row.territory ?? dash}</TableCell>
                  <TableCell>{row.salesOfficer ?? dash}</TableCell>
                  {/* ONE cell: the date (primary) with that payment's amount underneath (secondary). Display only — both stay separate fields in the API and the Excel export. */}
                  <TableCell className="text-right tabular-nums">
                    {row.lastPaymentDate || row.amount != null ? (
                      <div className="flex flex-col items-end gap-0.5">
                        {row.lastPaymentDate ? <span>{dateLabel(row.lastPaymentDate)}</span> : dash}
                        {row.amount != null && <span className="text-xs text-muted-foreground" data-testid="payment-amount">{formatCurrency(row.amount)}</span>}
                      </div>
                    ) : dash}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.days != null ? row.days : dash}</TableCell>
                  {"exceptionId" in row ? (
                    <>
                      {/* This exception's OWN Date of Billing with ITS Billing Amount underneath (not the dealer's last payment) — same stacked layout as Last Payment Date. */}
                      <TableCell className="text-right tabular-nums">
                        {row.billingDate || row.billingAmount != null ? (
                          <div className="flex flex-col items-end gap-0.5">
                            {row.billingDate ? <span>{dateLabel(row.billingDate)}</span> : dash}
                            {row.billingAmount != null && <span className="text-xs text-muted-foreground" data-testid="billing-amount">{formatCurrency(row.billingAmount)}</span>}
                          </div>
                        ) : dash}
                      </TableCell>
                      {/* The Auth Person option chosen on that exception (not the creating admin). */}
                      <TableCell>{row.authPerson || dash}</TableCell>
                    <TableCell className="text-center"><Button variant="outline" size="sm" aria-label={`Info — exception ${row.billNo} for ${row.party}`} onClick={() => setInfoId(row.exceptionId)}>Info</Button></TableCell>
                    </>
                  ) : (
                    <TableCell><BillingStatusCell status={row.billingStatus} clickable={canCreate} party={row.party} onOpen={() => { if (canCreate) setTarget({ dealerId: row.dealerId, party: row.party }); }} /></TableCell>
                  )}
                </TableRow>
              ))
            )}
          </DealerTableBody>
        </Table>
      </div>
      {canCreate && target && <BillingExceptionActionDialog dealerId={target.dealerId} party={target.party} onClose={() => setTarget(null)} />}
      {infoId && <BillingExceptionInfoDialog exceptionId={infoId} onClose={() => setInfoId(null)} />}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Page {data.page} of {data.totalPages} · {data.total} total</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Last Payment Report. Two top-level tabs — Last Payment (the existing report + Billing Status) and Billing Exception — and, only inside Billing Exception,
 * the nested Current | History tabs. They are navigation (one table at a time), never independent switches; the default is Last Payment, and
 * Billing Exception opens on Current.
 */
export function LastPaymentReportPage() {
  const [main, setMain] = useState<"last-payment" | "billing-exception">("last-payment");
  const [sub, setSub] = useState<ExceptionView>("current");
  const view: ReportViewKey = main === "last-payment" ? "last-payment" : sub;
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Reports" }, { label: "Last Payment Report" }]}
        title="Last Payment Report"
        subtitle="The latest payment received from each dealer, and how many days ago it was."
      />

      <PillNav value={main} onChange={setMain} items={[{ value: "last-payment", label: "Last Payment" }, { value: "billing-exception", label: "Billing Exception" }]} />
      {/* Own line below the main switch, above search / filters: the SAME underlined text tabs as Sales Planning's Seasonal / Monthly / Yearly. */}
      {main === "billing-exception" && <UnderlineTabs value={sub} onChange={setSub} items={[{ value: "current", label: "Current" }, { value: "history", label: "History" }]} />}
      <ReportView key={view} view={view} />
    </div>
  );
}
