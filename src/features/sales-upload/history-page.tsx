"use client";

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

interface Run {
  id: string;
  workbookName: string;
  targetMonthName: string;
  fromDate: string | null;
  toDate: string | null;
  dealersUpdated: number;
  productsUpdated: number;
  rowsImported: number;
  unknownDealers: number;
  unknownProducts: number;
  status: string;
  createdAt: string;
  uploadedByName: string;
}

export function SalesUploadHistoryPage() {
  const { data, isLoading } = useQuery<Run[]>({
    queryKey: ["sales-upload-history"],
    queryFn: () => api.get<Run[]>("/api/sales-upload/history"),
  });

  return (
    <div className="space-y-5">
      <PageHeader title="Sales Upload History" subtitle="Every Tally sales import — audit trail only; workbooks are never stored." />
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Target Month</TableHead>
              <TableHead>Workbook</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead className="text-right">Dealers</TableHead>
              <TableHead className="text-right">Products</TableHead>
              <TableHead className="text-right">Unknown</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (data?.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No sales uploads yet.</TableCell></TableRow>
            ) : (
              data!.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground">{formatDate(r.createdAt)}</TableCell>
                  <TableCell>{r.uploadedByName}</TableCell>
                  <TableCell className="font-medium">{r.targetMonthName}</TableCell>
                  <TableCell className="text-muted-foreground">{r.workbookName}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.rowsImported}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.dealersUpdated}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.productsUpdated}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.unknownDealers + r.unknownProducts}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "COMPLETED" ? "success" : "destructive"}>{r.status}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
