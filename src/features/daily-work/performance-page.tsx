"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
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

type Attendance = "PRESENT" | "ABSENT" | "LEAVE" | "HOLIDAY";
interface Option { id: string; name: string }
interface PerfRow {
  officerId: string; officerName: string; groupId: string | null; stateName: string | null; date: string;
  attendance: Attendance; planSubmittedAt: string | null; reportSubmittedAt: string | null;
  selfRating: number | null; rmRating: number | null; submitted: boolean;
}
interface Summary {
  salesOfficers: number; presentDays: number; totalDays: number; submittedPlans: number; submittedReports: number;
  averageSelfRating: number | null; averageRmRating: number | null;
}
interface Payload {
  role: Role; from: string; to: string; rows: PerfRow[]; summary: Summary;
  officers: Option[]; states: Option[]; canEditAttendance: boolean;
}

const ratingText = (v: number | null) => (v == null ? "—" : `${v} / 10`);
const timeText = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
const dateText = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" });
const dash = <span className="text-muted-foreground">—</span>;

export function PerformancePage({ role }: { role: Role }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(currentBusinessDate);
  const [to, setTo] = useState(currentBusinessDate);
  const [officerId, setOfficerId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [detail, setDetail] = useState<{ officerId: string; date: string } | null>(null);

  const isSO = role === Role.SALES_OFFICER;
  const isRM = role === Role.REGIONAL_MANAGER;
  const isAdmin = role === Role.SUPER_ADMIN;

  const L = {
    my: useLabel("daily_work.performance.my_title"),
    team: useLabel("daily_work.performance.team_title"),
    company: useLabel("daily_work.performance.company_title"),
    breadcrumb: useLabel("daily_work.performance.breadcrumb"),
    dateFrom: useLabel("daily_work.performance.date_from"),
    dateTo: useLabel("daily_work.performance.date_to"),
    colDate: useLabel("daily_work.performance.col.date"),
    colOfficer: useLabel("daily_work.team.col.sales_officer"),
    colState: useLabel("daily_work.performance.col.state"),
    colAttendance: useLabel("daily_work.performance.col.attendance"),
    colPlan: useLabel("daily_work.performance.col.plan_submission"),
    colReport: useLabel("daily_work.performance.col.report_submission"),
    colSelf: useLabel("daily_work.team.col.self_rating"),
    colRm: useLabel("daily_work.team.col.rm_rating"),
    colAction: useLabel("daily_work.team.col.action"),
    view: useLabel("daily_work.team.action.view"),
    empty: useLabel("daily_work.performance.empty"),
    allRms: useLabel("daily_work.performance.filter.all_rms"),
    allSalesOfficers: useLabel("daily_work.performance.filter.all_sales_officers"),
    fState: useLabel("daily_work.performance.col.state"),
    allStates: useLabel("daily_work.performance.filter.all_states"),
    officerLabel: useLabel("daily_work.team.col.sales_officer"),
    present: useLabel("daily_work.performance.attendance.present"),
    absent: useLabel("daily_work.performance.attendance.absent"),
    leave: useLabel("daily_work.performance.attendance.leave"),
    holiday: useLabel("daily_work.performance.attendance.holiday"),
    sMyAttendance: useLabel("daily_work.performance.summary.my_attendance"),
    sAttendance: useLabel("daily_work.performance.summary.attendance"),
    sOfficers: useLabel("daily_work.team.summary.sales_officers"),
    sPlans: useLabel("daily_work.performance.summary.submitted_plans"),
    sReports: useLabel("daily_work.performance.summary.submitted_reports"),
    sAvgSelf: useLabel("daily_work.team.summary.avg_self_rating"),
    sAvgRm: useLabel("daily_work.team.summary.avg_rm_rating"),
  };
  const attendanceLabel: Record<Attendance, string> = { PRESENT: L.present, ABSENT: L.absent, LEAVE: L.leave, HOLIDAY: L.holiday };
  const title = isSO ? L.my : isRM ? L.team : L.company;

  const query = new URLSearchParams({ from, to });
  if (!isSO && officerId) query.set("officerId", officerId);
  if (isAdmin && groupId) query.set("groupId", groupId);
  const { data, isLoading, isFetching } = useQuery<Payload>({
    queryKey: ["performance", role, from, to, officerId, groupId],
    queryFn: () => api.get<Payload>(`/api/daily-work/performance?${query.toString()}`),
  });

  const attendanceMut = useMutation({
    mutationFn: (v: { officerId: string; workDate: string; status: Attendance }) => api.post("/api/daily-work/attendance", v),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["performance", role, from, to, officerId, groupId] }); },
  });

  const showOfficer = !isSO;
  const showState = isAdmin;
  const colCount = 1 + (showOfficer ? 1 : 0) + (showState ? 1 : 0) + 6; // date + officer? + state? + attendance/plan/report/self/rm/action
  const changeState = (value: string) => {
    setGroupId(value);
    // A State change establishes a new authoritative SO scope. Resetting is predictable and prevents a
    // previously selected officer from being sent with an incompatible State while the options refresh.
    setOfficerId("");
  };

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: L.breadcrumb }, { label: title }]} title={title} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5"><Label>{L.dateFrom}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value || currentBusinessDate())} className="w-44" /></div>
        <div className="space-y-1.5"><Label>{L.dateTo}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value || currentBusinessDate())} className="w-44" /></div>
        {showState && (
          <div className="space-y-1.5"><Label>{L.fState}</Label>
            <NativeSelect className="w-48" value={groupId} onChange={(e) => changeState(e.target.value)}
              options={[{ value: "", label: L.allStates }, ...(data?.states ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          </div>
        )}
        {showOfficer && (
          <div className="space-y-1.5"><Label>{L.officerLabel}</Label>
            <NativeSelect className="w-52" value={officerId} disabled={isAdmin && isFetching} onChange={(e) => setOfficerId(e.target.value)}
              options={[{ value: "", label: isAdmin ? L.allSalesOfficers : L.allRms }, ...(data?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))]} />
          </div>
        )}
      </div>

      {/* Summary cards for the selected range. */}
      <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-3 lg:grid-cols-5">
        {isSO ? (
          <Stat label={L.sMyAttendance} value={data ? `${data.summary.presentDays} / ${data.summary.totalDays}` : "—"} />
        ) : (
          <>
            <Stat label={L.sOfficers} value={data ? String(data.summary.salesOfficers) : "—"} />
            <Stat label={L.sAttendance} value={data ? `${data.summary.presentDays} / ${data.summary.totalDays}` : "—"} />
          </>
        )}
        <Stat label={L.sPlans} value={data ? String(data.summary.submittedPlans) : "—"} />
        <Stat label={L.sReports} value={data ? String(data.summary.submittedReports) : "—"} />
        <Stat label={L.sAvgSelf} value={data ? ratingText(data.summary.averageSelfRating) : "—"} />
        <Stat label={L.sAvgRm} value={data ? ratingText(data.summary.averageRmRating) : "—"} />
      </div>

      <div className="overflow-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{L.colDate}</TableHead>
              {showOfficer && <TableHead>{L.colOfficer}</TableHead>}
              {showState && <TableHead>{L.colState}</TableHead>}
              <TableHead>{L.colAttendance}</TableHead>
              <TableHead>{L.colPlan}</TableHead>
              <TableHead>{L.colReport}</TableHead>
              <TableHead>{L.colSelf}</TableHead>
              <TableHead>{L.colRm}</TableHead>
              <TableHead className="text-right">{L.colAction}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={colCount}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : (data?.rows.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">{L.empty}</TableCell></TableRow>
            ) : (
              data!.rows.map((r) => (
                <TableRow key={`${r.officerId}-${r.date}`}>
                  <TableCell className="whitespace-nowrap">{dateText(r.date)}</TableCell>
                  {showOfficer && <TableCell className="font-medium">{r.officerName}</TableCell>}
                  {showState && <TableCell>{r.stateName ?? dash}</TableCell>}
                  <TableCell>
                    {data!.canEditAttendance ? (
                      <NativeSelect
                        className="h-8 w-32"
                        value={r.attendance}
                        disabled={attendanceMut.isPending}
                        onChange={(e) => attendanceMut.mutate({ officerId: r.officerId, workDate: r.date, status: e.target.value as Attendance })}
                        options={(["PRESENT", "ABSENT", "LEAVE", "HOLIDAY"] as Attendance[]).map((s) => ({ value: s, label: attendanceLabel[s] }))}
                      />
                    ) : (
                      <Badge variant={r.attendance === "PRESENT" ? "success" : "muted"}>{attendanceLabel[r.attendance]}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{timeText(r.planSubmittedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{timeText(r.reportSubmittedAt)}</TableCell>
                  <TableCell className="tabular-nums">{r.selfRating == null ? dash : ratingText(r.selfRating)}</TableCell>
                  <TableCell className="tabular-nums">{r.rmRating == null ? dash : ratingText(r.rmRating)}</TableCell>
                  <TableCell className="text-right">
                    {r.submitted ? (
                      <Button size="sm" variant="outline" onClick={() => setDetail({ officerId: r.officerId, date: r.date })}><Eye className="h-4 w-4" /> {L.view}</Button>
                    ) : dash}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {detail && (
        <DailyWorkReviewDialog
          officerId={detail.officerId}
          workDate={detail.date}
          readOnly={role !== Role.REGIONAL_MANAGER}
          onClose={() => setDetail(null)}
        />
      )}
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
