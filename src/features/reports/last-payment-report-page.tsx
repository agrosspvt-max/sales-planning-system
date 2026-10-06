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
import { useAdminPermission } from "@/features/accounts/permission-ui";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ColumnFilterHeader } from "@/components/ui/column-filter-header";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { PaymentAgingFilterControl } from "./payment-aging-filter";
import {
  DEFAULT_DAYS_SORT, NO_EXPORT_DATA_MESSAGE, applyFilterStep, formatLastUpdate, parseLastPaymentReportParams, paymentAgingToParams, sameReportFilters, REPORT_DEFAULT_PAGE_SIZE, REPORT_FILTER_KEYS,
  type DaysSort, type LastPaymentReportRow, type PaymentAgingFilter, type ReportFilterKey, type ReportFilterOptions, type ReportFilters,
} from "@/lib/last-payment-report";

interface ReportPage {
  items: LastPaymentReportRow[];
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
const NO_OPTIONS: ReportFilterOptions = { party: [], status: [], state: [], territory: [], officer: [] };
const STATUS_VARIANT: Record<string, "success" | "muted" | "secondary" | "destructive"> = { ACTIVE: "success", INACTIVE: "muted", PENDING: "secondary", DEFAULTER: "destructive" };

const dash = <span className="text-muted-foreground">—</span>;
// Receipt dates are plain calendar dates: build a local-midnight Date so no timezone can shift the day.
const dateLabel = (isoDate: string) => formatDate(new Date(`${isoDate}T00:00:00`));

/**
 * Last Payment Report — a read-only list of the caller's dealers with the same Last Payment value Recovery Planning
 * shows, plus Days since that payment. Scope, search, Days sorting and paging are all applied by the server.
 */
export function LastPaymentReportPage() {
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

  // The report's query string. The table (paged) and the Excel export (all rows) are built from the SAME function, so the export
  // always carries exactly the filters / search / Payment Aging / Days sort that are in effect at the moment it is requested.
  const reportQuery = (extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ search, sort, ...extra });
    for (const key of REPORT_FILTER_KEYS) for (const value of applied[key] ?? []) query.append(key, value); // APPLIED, never pending
    paymentAgingToParams(aging, query);
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
      const response = await fetch(`/api/reports/last-payment/export?${reportQuery()}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setExportMessage(body.error ?? "Failed to export report");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = "Last_Payment_Report.xlsx";
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportMessage("Failed to export report");
    } finally {
      setExporting(false);
    }
  };

  const { data, isLoading, isFetching, error, isPlaceholderData } = useQuery<ReportPage>({
    queryKey: ["last-payment-report", search, sort, page, applied, aging],
    queryFn: () => api.get(`/api/reports/last-payment?${reportQuery({ page: String(page), pageSize: String(REPORT_DEFAULT_PAGE_SIZE) })}`),
    placeholderData: keepPreviousData, // keeps the filter options (and table) steady while a new filter loads
  });
  // Cascading dropdown options follow the PENDING selections (a lightweight options-only request: no table rows, no receipt lookup),
  // so choosing State = MP immediately narrows Territory / Sales Officer / Party / Status while the table keeps showing the
  // applied result. The server also returns the cleaned selection: children that no longer fit are cleared from `pending`.
  const optionsQuery = useQuery<{ options: ReportFilterOptions; appliedFilters: ReportFilters }>({
    queryKey: ["last-payment-report-options", pending],
    queryFn: () => {
      const query = new URLSearchParams({ optionsOnly: "1" });
      for (const key of REPORT_FILTER_KEYS) for (const value of pending[key] ?? []) query.append(key, value);
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
      <PageHeader
        crumbs={[{ label: "Reports" }, { label: "Last Payment Report" }]}
        title="Last Payment Report"
        subtitle="The latest payment received from each dealer, and how many days ago it was."
      />
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
      <div className="overflow-auto rounded-lg border bg-background">
        <Table className="min-w-[1120px] table-fixed">
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
              <TableHead className="w-32 text-right">Amount</TableHead>
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
                <PaymentAgingFilterControl value={aging} onChange={(next) => { setAging(next); setPage(1); }} />
                </div>
              </TableHead>
            </TableRow>
          </TableHeader>
          <DealerTableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : !data || data.items.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No dealers found.</TableCell></TableRow>
            ) : (
              data.items.map((row) => (
                <TableRow key={row.dealerId} data-dealer-id={row.dealerId}>
                  <TableCell className="font-medium"><DealerName id={row.dealerId} name={row.party} /></TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[row.status] ?? "muted"}>{dealerStatusLabel(row.status)}</Badge></TableCell>
                  <TableCell>{row.state ?? dash}</TableCell>
                  <TableCell>{row.territory ?? dash}</TableCell>
                  <TableCell>{row.salesOfficer ?? dash}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.lastPaymentDate ? dateLabel(row.lastPaymentDate) : dash}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.amount != null ? formatCurrency(row.amount) : dash}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.days != null ? row.days : dash}</TableCell>
                </TableRow>
              ))
            )}
          </DealerTableBody>
        </Table>
      </div>
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
