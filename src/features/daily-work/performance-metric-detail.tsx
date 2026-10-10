"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import type { PerformanceDetailPayload } from "./service.server";

type Detail = Omit<PerformanceDetailPayload, never>;
type SortKey = "date" | "employee" | "value";
export interface MetricRequest { metric: string; title: string; from: string; to: string; officerId: string; groupId: string; isSO: boolean; isAdmin: boolean }

export const rupees = (v: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v)}`; // Sales / Recovery are money
export const countText = (v: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v); // Scheme units, appointments and visits are counts
const formatValue = (unit: string, v: number) => (unit === "currency" ? rupees(v) : countText(v));
const dateText = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" });
const fill = (t: string, vars: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/**
 * Contribution details of ONE Company Performance summary card: the individual submitted-plan records that add up to its total, under the page's
 * own Date From / Date To / State / officer filters (no independent filters). The total, record and employee counts cover EVERY matching record;
 * only the table is paged. The server owns scope and rules (getPerformanceMetricDetail).
 */
export function PerformanceMetricDetail({ request, onClose }: { request: MetricRequest; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("date");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const L = {
    total: useLabel("daily_work.performance.detail.total"), records: useLabel("daily_work.performance.detail.records"), employees: useLabel("daily_work.performance.detail.employees"),
    range: useLabel("daily_work.performance.detail.date_range"), state: useLabel("daily_work.performance.detail.state"), officer: useLabel("daily_work.performance.detail.officer"),
    allStates: useLabel("daily_work.performance.filter.all_states"),
    colDate: useLabel("daily_work.performance.col.date"), colEmployee: useLabel("daily_work.performance.detail.col.employee"), colRole: useLabel("daily_work.performance.detail.col.role"),
    colState: useLabel("daily_work.performance.col.state"), colValue: useLabel("daily_work.performance.detail.col.value"), colSource: useLabel("daily_work.performance.detail.col.source"),
    colRecord: useLabel("daily_work.performance.detail.col.record"), colReport: useLabel("daily_work.performance.detail.col.report"),
    finalized: useLabel("daily_work.performance.detail.report_finalized"), pending: useLabel("daily_work.performance.detail.report_pending"),
    roleSO: useLabel("daily_work.performance.detail.role_sales_officer"), roleRM: useLabel("daily_work.performance.detail.role_regional_manager"),
    visitParts: useLabel("daily_work.performance.detail.visit_parts"), pageTotal: useLabel("daily_work.performance.detail.page_total"), grandTotal: useLabel("daily_work.performance.detail.grand_total"),
    pageOf: useLabel("daily_work.performance.detail.page_of"), empty: useLabel("daily_work.performance.detail.empty"), error: useLabel("daily_work.performance.detail.error"),
    close: useLabel("daily_work.performance.detail.close"), previous: useLabel("daily_work.performance.detail.previous"), next: useLabel("daily_work.performance.detail.next"),
    secSales: useLabel("daily_work.section.sales"), secRecovery: useLabel("daily_work.section.recovery"), secAppointment: useLabel("daily_work.section.appointment"),
    secScheme: useLabel("daily_work.section.scheme_conversion"), secVisits: useLabel("daily_work.section.visits"),
  };
  const sectionText: Record<string, string> = { SALES: L.secSales, RECOVERY: L.secRecovery, APPOINTMENT: L.secAppointment, SCHEME_CONVERSION: L.secScheme, SUMMARY: L.secVisits };

  const query = new URLSearchParams({ metric: request.metric, from: request.from, to: request.to, page: String(page), pageSize: "25", sort, dir });
  if (!request.isSO && request.officerId) query.set("officerId", request.officerId);
  if (request.isAdmin && request.groupId) query.set("groupId", request.groupId);
  const { data, isLoading, error } = useQuery<Detail>({
    queryKey: ["performance-detail", request.metric, request.from, request.to, request.officerId, request.groupId, page, sort, dir],
    queryFn: () => api.get<Detail>(`/api/daily-work/performance/detail?${query.toString()}`),
    placeholderData: keepPreviousData,
  });

  const sortBy = (key: SortKey) => { setPage(1); if (sort === key) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(key); setDir(key === "value" ? "desc" : key === "date" ? "desc" : "asc"); } };
  const SortHead = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <TableHead className={className} aria-sort={sort === k ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => sortBy(k)}>{children}{sort === k ? (dir === "asc" ? " ▲" : " ▼") : ""}</button>
    </TableHead>
  );
  const pageSum = data ? Math.round(data.rows.reduce((s, r) => s + r.value, 0) * 100) / 100 : 0;
  const roleText = (r: string) => (r === "REGIONAL_MANAGER" ? L.roleRM : L.roleSO);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader><DialogTitle>{request.title}</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <span>{L.range}: <b className="text-foreground">{dateText(request.from)} – {dateText(request.to)}</b></span>
          {request.isAdmin && <span>{L.state}: <b className="text-foreground">{data ? data.stateName ?? L.allStates : request.groupId ? "…" : L.allStates}</b></span>}
          {data?.officerName && <span>{L.officer}: <b className="text-foreground">{data.officerName}</b></span>}
        </div>
        <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/30 p-3">
          <div><div className="text-xs text-muted-foreground">{L.total}</div><div className="text-lg font-semibold tabular-nums" data-testid="detail-total">{data ? formatValue(data.unit, data.total) : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">{L.records}</div><div className="text-lg font-semibold tabular-nums">{data ? countText(data.recordCount) : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">{L.employees}</div><div className="text-lg font-semibold tabular-nums">{data ? countText(data.employeeCount) : "—"}</div></div>
        </div>
        {error && !data ? <p className="text-sm text-destructive">{(error as Error).message || L.error}</p> : isLoading ? <Skeleton className="h-24 w-full" /> : data && data.recordCount === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{L.empty}</p>
        ) : data && (
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead k="date">{L.colDate}</SortHead><SortHead k="employee">{L.colEmployee}</SortHead><TableHead>{L.colRole}</TableHead><TableHead>{L.colState}</TableHead>
                  <TableHead>{L.colSource}</TableHead><TableHead>{L.colRecord}</TableHead><TableHead>{L.colReport}</TableHead><SortHead k="value" className="text-right">{L.colValue}</SortHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.entryId}>
                    <TableCell className="whitespace-nowrap">{dateText(r.date)}</TableCell>
                    <TableCell className="font-medium">{r.employeeName}</TableCell>
                    <TableCell>{roleText(r.role)}</TableCell>
                    <TableCell>{r.stateName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>{sectionText[r.section] ?? r.section}</TableCell>
                    <TableCell>
                      {r.visitParts ? fill(L.visitParts, { dealer: r.visitParts.dealer, newParty: r.visitParts.newParty }) : (<>{r.record ?? <span className="text-muted-foreground">—</span>}{r.recordDetail && <div className="text-xs text-muted-foreground">{r.recordDetail}</div>}</>)}
                    </TableCell>
                    <TableCell><Badge variant={r.reportFinalized ? "success" : "muted"}>{r.reportFinalized ? L.finalized : L.pending}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{formatValue(data.unit, r.value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <tfoot>
                <TableRow className="font-semibold">
                  <TableCell colSpan={7} className="text-right">{L.pageTotal}</TableCell><TableCell className="text-right tabular-nums" data-testid="detail-page-total">{formatValue(data.unit, pageSum)}</TableCell>
                </TableRow>
                {data.totalPages > 1 && (
                  <TableRow className="font-semibold">
                    <TableCell colSpan={7} className="text-right">{fill(L.grandTotal, { count: data.recordCount })}</TableCell><TableCell className="text-right tabular-nums">{formatValue(data.unit, data.total)}</TableCell>
                  </TableRow>
                )}
              </tfoot>
            </Table>
          </div>
        )}
        <DialogFooter className="items-center sm:justify-between">
          {data && data.totalPages > 1 ? (
            <div className="flex items-center gap-2 text-sm">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>{L.previous}</Button>
              <span className="tabular-nums">{fill(L.pageOf, { page: data.page, pages: data.totalPages })}</span>
              <Button size="sm" variant="outline" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>{L.next}</Button>
            </div>
          ) : <span />}
          <Button variant="outline" onClick={onClose}>{L.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
