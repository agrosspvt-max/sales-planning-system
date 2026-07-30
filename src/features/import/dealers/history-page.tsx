"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Record {
  id: string;
  workbookName: string;
  importedByName: string;
  dealerCount: number;
  createdDealers: number;
  reassignedDealers: number;
  skippedDealers: number;
  officersCreated: number;
  status: "COMPLETED" | "FAILED" | "ROLLED_BACK";
  createdAt: string;
  summary: string | null;
}

const STATUS_VARIANT = {
  COMPLETED: "success",
  FAILED: "destructive",
  ROLLED_BACK: "muted",
} as const;

export function ImportHistoryPage() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useQuery<Record[]>({
    queryKey: ["import-history"],
    queryFn: () => api.get<Record[]>("/api/import/dealers/history"),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dealer Import History"
        subtitle="Metadata of past dealer imports (uploaded workbooks are never stored)."
      />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Workbook</TableHead>
              <TableHead>By</TableHead>
              <TableHead className="text-right">Dealers</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead className="text-right">Reassigned</TableHead>
              <TableHead className="text-right">Officers</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : (data?.length ?? 0) === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  No imports yet.
                </TableCell>
              </TableRow>
            ) : (
              data!.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                >
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(r.createdAt)}</TableCell>
                  <TableCell className="font-medium">{r.workbookName}</TableCell>
                  <TableCell>{r.importedByName}</TableCell>
                  <TableCell className="text-right">{r.dealerCount}</TableCell>
                  <TableCell className="text-right">{r.createdDealers}</TableCell>
                  <TableCell className="text-right">{r.reassignedDealers}</TableCell>
                  <TableCell className="text-right">{r.officersCreated}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {open && data && (
        <pre className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
          {JSON.stringify(JSON.parse(data.find((d) => d.id === open)?.summary ?? "{}"), null, 2)}
        </pre>
      )}
    </div>
  );
}
