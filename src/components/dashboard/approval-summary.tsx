"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface ApprovalVM {
  seasonalPlanStatus: string;
  monthlyPlansOpen: number;
  pending: number;
  approved: number;
  rejected: number;
  draft: number;
}

/** Reusable approval status summary. */
export function ApprovalSummary({ data }: { data: ApprovalVM }) {
  const stats: { label: string; value: string | number }[] = [
    { label: "Seasonal Plan", value: data.seasonalPlanStatus },
    { label: "Monthly Plans Open", value: data.monthlyPlansOpen },
    { label: "Pending", value: data.pending },
    { label: "Approved", value: data.approved },
    { label: "Rejected", value: data.rejected },
    { label: "Draft", value: data.draft },
  ];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Approval Status</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-md border p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</p>
              <div className="mt-1 text-sm font-semibold">
                {typeof s.value === "string" ? <Badge variant="secondary">{s.value}</Badge> : s.value}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
