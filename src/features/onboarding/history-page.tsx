"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MigrationReportView } from "./report-view";
import { loadReportString, type LoadedReport } from "./report";

interface Run {
  id: string;
  source: string;
  sourceName: string;
  status: "COMPLETED" | "FAILED" | "ROLLED_BACK";
  report: string | null;
  createdAt: string;
  runByName: string;
}

const STATUS_VARIANT = { COMPLETED: "success", FAILED: "destructive", ROLLED_BACK: "muted" } as const;

// One pipeline reads every stored report (version detect → migrate → normalize → validate),
// so the page always works with a current-schema document and never crashes on old records.
function parseReport(raw: string | null): LoadedReport | null {
  return loadReportString(raw);
}

export function OnboardingHistoryPage() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useQuery<Run[]>({
    queryKey: ["onboarding-history"],
    queryFn: () => api.get<Run[]>("/api/onboarding/history"),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Onboarding History"
        subtitle="Every Company Onboarding run is a permanent, auditable migration record. Expand a run for the full report — summary, created/matched masters, skipped rows with reasons, warnings and statistics — and download it as JSON or CSV. Source files themselves are never stored."
      />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>When</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>File</TableHead>
              <TableHead>By</TableHead>
              <TableHead className="text-right">Imported / Skipped</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : (data?.length ?? 0) === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No onboarding runs yet.
                </TableCell>
              </TableRow>
            ) : (
              data!.map((r) => {
                const loaded = parseReport(r.report);
                const isOpen = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <TableRow className="cursor-pointer" onClick={() => setOpen(isOpen ? null : r.id)}>
                      <TableCell>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </Button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(r.createdAt)}</TableCell>
                      <TableCell>{r.source}</TableCell>
                      <TableCell className="font-medium">{r.sourceName}</TableCell>
                      <TableCell>{r.runByName}</TableCell>
                      <TableCell className="text-right">
                        {loaded ? `${loaded.report.summary.planningRows.imported} / ${loaded.report.summary.planningRows.skipped}` : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/20">
                          {loaded ? (
                            <MigrationReportView loaded={loaded} />
                          ) : (
                            <p className="text-sm text-muted-foreground">No report data for this run.</p>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
