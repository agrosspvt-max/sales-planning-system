"use client";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ColumnFilterHeader } from "@/components/ui/column-filter-header";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { DealerTableBody } from "@/features/dealers/dealer-table-ui";
import { PaymentAgingFilterControl } from "./payment-aging-filter";
import {
  DEFAULT_DAYS_SORT, paymentAgingToParams, REPORT_DEFAULT_PAGE_SIZE, REPORT_FILTER_KEYS,
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
}

const FILTER_COLUMNS: { key: ReportFilterKey; label: string }[] = [
  { key: "party", label: "Party" },
  { key: "state", label: "State" },
  { key: "territory", label: "Territory" },
  { key: "officer", label: "Sales Officer" },
];
const NO_OPTIONS: ReportFilterOptions = { party: [], state: [], territory: [], officer: [] };

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
  // Column filters: multi-select per column (OR within, AND across). Applied by the server on top of the caller's scope,
  // and kept independent of search and the Days sort — changing one never resets the others.
  const [filters, setFilters] = useState<ReportFilters>({});
  // Payment Aging (Days) filter: separate from the Days sort — setting it never touches the sort, and vice versa.
  const [aging, setAging] = useState<PaymentAgingFilter | null>(null);

  const { data, isLoading, error } = useQuery<ReportPage>({
    queryKey: ["last-payment-report", search, sort, page, filters, aging],
    queryFn: () => {
      const query = new URLSearchParams({ search, sort, page: String(page), pageSize: String(REPORT_DEFAULT_PAGE_SIZE) });
      for (const key of REPORT_FILTER_KEYS) for (const value of filters[key] ?? []) query.append(key, value);
      paymentAgingToParams(aging, query);
      return api.get(`/api/reports/last-payment?${query}`);
    },
    placeholderData: keepPreviousData, // keeps the filter options (and table) steady while a new filter loads
  });
  const options = data?.options ?? NO_OPTIONS;

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Reports" }, { label: "Last Payment Report" }]}
        title="Last Payment Report"
        subtitle="The latest payment received from each dealer, and how many days ago it was."
      />
      <Input
        className="max-w-sm"
        placeholder="Search parties…"
        value={search}
        onChange={(event) => { setSearch(event.target.value); setPage(1); }}
      />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {FILTER_COLUMNS.map(({ key, label }) => (
                <ColumnFilterHeader
                  key={key}
                  label={label}
                  ariaLabel={`Filter by ${label}`}
                  options={options[key]}
                  selected={filters[key] ?? []}
                  onChange={(next) => { setFilters((current) => ({ ...current, [key]: next })); setPage(1); }}
                />
              ))}
              <TableHead className="text-right">Last Payment Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right" aria-sort={sort === "days_asc" ? "ascending" : "descending"}>
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
              <TableRow><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : !data || data.items.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No dealers found.</TableCell></TableRow>
            ) : (
              data.items.map((row) => (
                <TableRow key={row.dealerId} data-dealer-id={row.dealerId}>
                  <TableCell className="font-medium"><DealerName id={row.dealerId} name={row.party} /></TableCell>
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
