"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { api } from "@/lib/api-client";
import { currentBusinessDate } from "@/lib/daily-work";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLabel } from "@/features/labels/label-ui";
import { DailyWorkReviewDialog } from "./team-performance-page";

interface FilterOption { id: string; name: string }
interface AdminRow {
  officerId: string; officerName: string; groupId: string | null; groupName: string | null;
  rmId: string | null; rmName: string | null; submitted: boolean; selfRating: number | null; rmRating: number | null;
}
interface Summary { salesOfficers: number; submitted: number; notSubmitted: number; averageSelfRating: number | null; averageRmRating: number | null }
interface AdminPayload { workDate: string; summary: Summary; rows: AdminRow[]; rms: FilterOption[]; groups: FilterOption[] }

const ratingText = (v: number | null) => (v == null ? "—" : `${v} / 10`);
const dash = <span className="text-muted-foreground">—</span>;

export function AdminPerformancePage() {
  const [workDate, setWorkDate] = useState(currentBusinessDate);
  const [rmId, setRmId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [submission, setSubmission] = useState<"ALL" | "SUBMITTED" | "NOT_SUBMITTED">("ALL");
  const [openOfficer, setOpenOfficer] = useState<string | null>(null);

  const L = {
    title: useLabel("daily_work.performance.title"),
    breadcrumb: useLabel("daily_work.performance.breadcrumb"),
    subtitle: useLabel("daily_work.performance.subtitle"),
    date: useLabel("daily_work.team.date"),
    colOfficer: useLabel("daily_work.team.col.sales_officer"),
    colRm: useLabel("daily_work.performance.col.rm"),
    colGroup: useLabel("daily_work.performance.col.group"),
    colSubmission: useLabel("daily_work.team.col.submission"),
    colSelf: useLabel("daily_work.team.col.self_rating"),
    colRmRating: useLabel("daily_work.team.col.rm_rating"),
    colAction: useLabel("daily_work.team.col.action"),
    view: useLabel("daily_work.team.action.view"),
    submitted: useLabel("daily_work.team.submitted"),
    notSubmitted: useLabel("daily_work.team.not_submitted"),
    empty: useLabel("daily_work.performance.empty"),
    noRm: useLabel("daily_work.performance.no_rm"),
    sTotal: useLabel("daily_work.performance.summary.total_officers"),
    sSubmitted: useLabel("daily_work.team.summary.submitted"),
    sNotSubmitted: useLabel("daily_work.team.summary.not_submitted"),
    sAvgSelf: useLabel("daily_work.team.summary.avg_self_rating"),
    sAvgRm: useLabel("daily_work.team.summary.avg_rm_rating"),
    fRm: useLabel("daily_work.performance.filter.rm"),
    fGroup: useLabel("daily_work.performance.filter.group"),
    fSubmission: useLabel("daily_work.performance.filter.submission"),
    fAll: useLabel("daily_work.performance.filter.all"),
    fAllRms: useLabel("daily_work.performance.filter.all_rms"),
    fAllGroups: useLabel("daily_work.performance.filter.all_groups"),
  };

  const query = new URLSearchParams({ date: workDate, submission });
  if (rmId) query.set("rmId", rmId);
  if (groupId) query.set("groupId", groupId);
  const { data, isLoading } = useQuery<AdminPayload>({
    queryKey: ["admin-performance", workDate, rmId, groupId, submission],
    queryFn: () => api.get<AdminPayload>(`/api/daily-work/admin-performance?${query.toString()}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: L.breadcrumb }, { label: L.title }]} title={L.title} subtitle={L.subtitle} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>{L.date}</Label>
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value || currentBusinessDate())} className="w-48" />
        </div>
        <div className="space-y-1.5">
          <Label>{L.fRm}</Label>
          <NativeSelect className="w-48" value={rmId} onChange={(e) => setRmId(e.target.value)}
            options={[{ value: "", label: L.fAllRms }, ...(data?.rms ?? []).map((r) => ({ value: r.id, label: r.name }))]} />
        </div>
        <div className="space-y-1.5">
          <Label>{L.fGroup}</Label>
          <NativeSelect className="w-48" value={groupId} onChange={(e) => setGroupId(e.target.value)}
            options={[{ value: "", label: L.fAllGroups }, ...(data?.groups ?? []).map((g) => ({ value: g.id, label: g.name }))]} />
        </div>
        <div className="space-y-1.5">
          <Label>{L.fSubmission}</Label>
          <NativeSelect className="w-44" value={submission} onChange={(e) => setSubmission(e.target.value as typeof submission)}
            options={[{ value: "ALL", label: L.fAll }, { value: "SUBMITTED", label: L.submitted }, { value: "NOT_SUBMITTED", label: L.notSubmitted }]} />
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={L.sTotal} value={data ? String(data.summary.salesOfficers) : "—"} />
        <Stat label={L.sSubmitted} value={data ? String(data.summary.submitted) : "—"} />
        <Stat label={L.sNotSubmitted} value={data ? String(data.summary.notSubmitted) : "—"} />
        <Stat label={L.sAvgSelf} value={data ? ratingText(data.summary.averageSelfRating) : "—"} />
        <Stat label={L.sAvgRm} value={data ? ratingText(data.summary.averageRmRating) : "—"} />
      </div>

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{L.colOfficer}</TableHead>
              <TableHead>{L.colRm}</TableHead>
              <TableHead>{L.colGroup}</TableHead>
              <TableHead>{L.colSubmission}</TableHead>
              <TableHead>{L.colSelf}</TableHead>
              <TableHead>{L.colRmRating}</TableHead>
              <TableHead className="text-right">{L.colAction}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (data?.rows.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{L.empty}</TableCell></TableRow>
            ) : (
              data!.rows.map((r) => (
                <TableRow key={r.officerId}>
                  <TableCell className="font-medium">{r.officerName}</TableCell>
                  <TableCell>{r.rmName ?? <span className="text-muted-foreground">{L.noRm}</span>}</TableCell>
                  <TableCell>{r.groupName ?? dash}</TableCell>
                  <TableCell>{r.submitted ? <Badge variant="success">{L.submitted}</Badge> : <Badge variant="muted">{L.notSubmitted}</Badge>}</TableCell>
                  <TableCell className="tabular-nums">{r.selfRating == null ? dash : ratingText(r.selfRating)}</TableCell>
                  <TableCell className="tabular-nums">{r.rmRating == null ? dash : ratingText(r.rmRating)}</TableCell>
                  <TableCell className="text-right">
                    {r.submitted ? (
                      <Button size="sm" variant="outline" onClick={() => setOpenOfficer(r.officerId)}><Eye className="h-4 w-4" /> {L.view}</Button>
                    ) : dash}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {openOfficer && <DailyWorkReviewDialog officerId={openOfficer} workDate={workDate} readOnly onClose={() => setOpenOfficer(null)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
