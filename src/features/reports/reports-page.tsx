"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, Download } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatCurrency, formatPercent } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CellFormat, ReportPayload, ReportRow, ReportSort, ReportType } from "./types";

interface SeasonOption {
  id: string;
  name: string;
  year: number;
}

const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: "product", label: "Product Summary" },
  { value: "brand", label: "Brand Summary" },
  { value: "category", label: "Category Summary" },
  { value: "dealer", label: "Dealer Summary" },
  { value: "officer", label: "Sales Officer Summary" },
  { value: "regional", label: "Regional Manager Summary" },
  { value: "company", label: "Company Summary" },
  { value: "season", label: "Seasonal Summary" },
  { value: "monthly", label: "Monthly Summary" },
];

// The filter parameter a drill from `type` contributes (null = no filter, e.g. company→regional).
const DRILL_PARAM: Record<ReportType, string | null> = {
  company: null,
  regional: "manager",
  officer: "officer",
  dealer: "dealer",
  brand: "brand",
  category: "category",
  product: null,
  season: null,
  monthly: null,
};

interface DrillStep {
  label: string;
  param: string | null;
  id: string;
  childType: ReportType;
}

function formatCell(value: string | number, format: CellFormat): string {
  if (format === "currency") return formatCurrency(Number(value));
  if (format === "percent") return formatPercent(Number(value));
  if (format === "number") return new Intl.NumberFormat("en-IN").format(Number(value));
  return String(value);
}

export function ReportsPage({ initialType = "product", lockType = false, title }: { initialType?: ReportType; lockType?: boolean; title?: string } = {}) {
  const [baseType, setBaseType] = useState<ReportType>(initialType);
  const [seasonId, setSeasonId] = useState("");
  const [drill, setDrill] = useState<DrillStep[]>([]);
  const [sort, setSort] = useState<ReportSort | null>(null);

  const { data: seasons } = useQuery<SeasonOption[]>({
    queryKey: ["seasons"],
    queryFn: () => api.get<SeasonOption[]>("/api/seasons"),
  });
  const effectiveSeason = seasonId || seasons?.[0]?.id || "";

  const currentType = drill.length ? drill[drill.length - 1].childType : baseType;
  const filters: Record<string, string> = {};
  for (const step of drill) if (step.param) filters[step.param] = step.id;

  const params = new URLSearchParams({ type: currentType, season: effectiveSeason, ...filters });
  if (sort) {
    params.set("sortKey", sort.key);
    params.set("sortDir", sort.dir);
  }

  const { data, isLoading } = useQuery<ReportPayload>({
    queryKey: ["report", params.toString()],
    queryFn: () => api.get<ReportPayload>(`/api/reports?${params.toString()}`),
    enabled: !!effectiveSeason,
  });

  function changeType(t: ReportType) {
    setBaseType(t);
    setDrill([]);
    setSort(null);
  }

  function onRowClick(row: ReportRow) {
    if (!data?.drillChild) return;
    setDrill((d) => [
      ...d,
      { label: String(row.label), param: DRILL_PARAM[currentType], id: row.id, childType: data.drillChild! },
    ]);
    setSort(null);
  }

  function goToCrumb(index: number) {
    // index -1 = base; otherwise truncate drill to index+1
    setDrill((d) => (index < 0 ? [] : d.slice(0, index + 1)));
    setSort(null);
  }

  function toggleSort(key: string) {
    setSort((s) =>
      s && s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
    );
  }

  const activeSort = data?.sort;

  return (
    <div className="space-y-4">
      <PageHeader
        title={title ?? "Reports"}
        subtitle="Calculated live from approved plans and actual sales — nothing is stored."
        actions={
          <Button
            variant="outline"
            size="sm"
            asChild
            disabled={!effectiveSeason || (data?.rows.length ?? 0) === 0}
          >
            <a href={`/api/reports/export?${params.toString()}`}>
              <Download className="h-4 w-4" /> Export to Excel
            </a>
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        {!lockType && (
          <div className="space-y-1.5">
            <Label htmlFor="report">Report</Label>
            <NativeSelect
              id="report"
              className="w-56"
              options={REPORT_TYPES}
              value={baseType}
              onChange={(e) => changeType(e.target.value as ReportType)}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="season">Season</Label>
          <NativeSelect
            id="season"
            className="w-56"
            options={(seasons ?? []).map((s) => ({ value: s.id, label: `${s.name} ${s.year}` }))}
            value={effectiveSeason}
            onChange={(e) => {
              setSeasonId(e.target.value);
              setDrill([]);
            }}
          />
        </div>
      </div>

      {/* Drill breadcrumb */}
      {drill.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button className="text-primary hover:underline" onClick={() => goToCrumb(-1)}>
            {REPORT_TYPES.find((t) => t.value === baseType)?.label}
          </button>
          {drill.map((step, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              {i === drill.length - 1 ? (
                <span className="font-medium">{step.label}</span>
              ) : (
                <button className="text-primary hover:underline" onClick={() => goToCrumb(i)}>
                  {step.label}
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {data?.meta.filters.length ? (
        <p className="text-xs text-muted-foreground">Filters: {data.meta.filters.join(" · ")}</p>
      ) : null}

      <div className="rounded-lg border bg-background">
        {isLoading || !data ? (
          <div className="p-4">
            <Skeleton className="h-6 w-full" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {data.columns.map((c) => (
                  <TableHead
                    key={c.key}
                    className={cn("cursor-pointer select-none", c.format !== "text" && "text-right")}
                    onClick={() => toggleSort(c.key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      {activeSort?.key === c.key &&
                        (activeSort.dir === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        ))}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={data.columns.length} className="py-10 text-center text-muted-foreground">
                    No approved-plan data for this selection.
                  </TableCell>
                </TableRow>
              ) : (
                data.rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={cn(data.drillChild && "cursor-pointer")}
                    onClick={() => onRowClick(row)}
                  >
                    {data.columns.map((c) => (
                      <TableCell key={c.key} className={cn(c.format !== "text" && "text-right")}>
                        {formatCell(row[c.key], c.format)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
            {data.totals && data.rows.length > 0 && (
              <tfoot>
                <TableRow className="bg-muted/40 font-semibold">
                  {data.columns.map((c, i) => (
                    <TableCell key={c.key} className={cn(c.format !== "text" && "text-right")}>
                      {i === 0
                        ? "Total"
                        : c.key in data.totals!
                          ? formatCell(data.totals![c.key], c.format)
                          : ""}
                    </TableCell>
                  ))}
                </TableRow>
              </tfoot>
            )}
          </Table>
        )}
      </div>
      {data?.drillChild && (data.rows.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">Tip: click a row to drill down.</p>
      )}
    </div>
  );
}
