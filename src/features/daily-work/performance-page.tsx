"use client";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { useAdminPermission } from "@/features/accounts/permission-ui";
import { formatDMY, formatDateTimeDMY } from "@/lib/date-format";


import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { Eye } from "lucide-react";
import { api } from "@/lib/api-client";
import { currentBusinessDate } from "@/lib/daily-work";
import { Button } from "@/components/ui/button";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RmBadge } from "@/components/ui/rm-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Th, useLabel } from "@/features/labels/label-ui";
import { ColumnFilterHeader } from "@/components/ui/column-filter-header";
import { DailyWorkReviewDialog } from "./team-performance-page";
import { TaskAnalysisView } from "@/features/tasks/task-analysis-view";
import { defaultTaskFilters, type DateBasis, type TaskFilterState } from "@/lib/task-analysis";
import { cn } from "@/lib/utils";
import { LateRequestsView } from "./late-requests-view";
import { PerformanceMetricDetail, countText, rupees, type MetricRequest } from "./performance-metric-detail";

interface Option { id: string; name: string }
interface PerfRow {
  officerId: string; officerName: string; officerRole: Role; groupId: string | null; stateName: string | null; date: string;
  planSubmittedAt: string | null; reportSubmittedAt: string | null;
  selfRating: number | null; rmRating: number | null; submitted: boolean; reportMissed: boolean;
  planMissed?: boolean; lateReport?: { open: "PENDING" | "APPROVED" | null; late: boolean };
  taskActivity: { tasks: number; completed: number; reschedules: number; abandoned: number; sections: Record<string, number> } | null;
}
interface SectionTotal { planned: number; actual: number }
interface Summary {
  salesOfficers: number; employeeDays: number; submittedPlans: number; submittedReports: number;
  averageSelfRating: number | null; averageRmRating: number | null;
  sections: { sales: SectionTotal; recovery: SectionTotal; schemeConversion: SectionTotal; appointment: SectionTotal; visits: SectionTotal };
}
interface Payload {
  role: Role; from: string; to: string; rows: PerfRow[]; summary: Summary;
  officers: Option[]; states: Option[];
}

const ratingText = (v: number | null) => (v == null ? "—" : `${v} / 10`);
const timeText = (iso: string | null) => iso ? formatDateTimeDMY(iso) : "—";
const dateText = (d: string) => formatDMY(d);
const dash = <span className="text-muted-foreground">—</span>;

export function PerformancePage({ role }: { role: Role }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(currentBusinessDate);
  const [to, setTo] = useState(currentBusinessDate);
  const [officerIds, setOfficerIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<{ officerId: string; date: string } | null>(null);
  // Performance (the default, unchanged view) | Tasks (task analysis). Tasks opens on Auto; its filters live here so they survive switching back and forth, and so a Task Activity
  // link in the Performance table can open it pre-filtered. Once opened, Tasks stays mounted (hidden) so its page, calendar and selection are kept.
  const [mode, setMode] = useState<"performance" | "tasks" | "requests">("performance");
  const [requestsOpened, setRequestsOpened] = useState(false); // Requests are fetched only once that view is opened
  const [tasksOpened, setTasksOpened] = useState(false);
  const [taskFilters, setTaskFilters] = useState<TaskFilterState>(() => defaultTaskFilters(currentBusinessDate()));
  const showMode = (next: "performance" | "tasks" | "requests") => { setMode(next); if (next === "tasks") setTasksOpened(true); if (next === "requests") setRequestsOpened(true); };
  const openTasks = (r: PerfRow, basis: DateBasis) => {
    // The row's employee and date: tasks ORIGINALLY scheduled on that date, or the reschedules MADE on that date (the active basis is shown on the Tasks page). All types.
    setTaskFilters({ ...defaultTaskFilters(currentBusinessDate(), "ALL"), basis, from: r.date, to: r.date, officerId: isSO ? "" : r.officerId });
    showMode("tasks");
  };
  const [metric, setMetric] = useState<{ metric: string; title: string } | null>(null); // the summary card whose contribution details are open

  const isSO = role === Role.SALES_OFFICER;
  const isRM = role === Role.REGIONAL_MANAGER;
  const isAdmin = isAdministrativeRole(role);
  const canReadRequests = useAdminPermission("performance");
  const canReviewRequests = (role === Role.REGIONAL_MANAGER || isAdmin) && canReadRequests; // the server still decides what each reviewer may see and decide

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
    colPlan: useLabel("daily_work.performance.col.plan_submission"),
    colReport: useLabel("daily_work.performance.col.report_submission"),
    reportMissed: useLabel("daily_work.performance.report_missed"),
    colSelf: useLabel("daily_work.team.col.self_rating"),
    colRm: useLabel("daily_work.team.col.rm_rating"),
    colAction: useLabel("daily_work.team.col.action"),
    view: useLabel("daily_work.team.action.view"),
    empty: useLabel("daily_work.performance.empty"),
    fState: useLabel("daily_work.performance.col.state"),
    allStates: useLabel("daily_work.performance.filter.all_states"),
    officerLabel: useLabel("daily_work.team.col.sales_officer"),
    sOfficers: useLabel("daily_work.team.summary.sales_officers"),
    sNotSubmitted: useLabel("daily_work.team.summary.not_submitted"),
    rmBadge: useLabel("daily_work.performance.rm_badge"),
    rmNoRating: useLabel("daily_work.performance.rm_no_rating"),
    sPlans: useLabel("daily_work.performance.summary.submitted_plans"),
    sReports: useLabel("daily_work.performance.summary.submitted_reports"),
    sAvgSelf: useLabel("daily_work.team.summary.avg_self_rating"),
    sAvgRm: useLabel("daily_work.team.summary.avg_rm_rating"),
    sSalesP: useLabel("daily_work.performance.summary.sales_planned"),
    sSalesA: useLabel("daily_work.performance.summary.sales_actual"),
    sRecoveryP: useLabel("daily_work.performance.summary.recovery_planned"),
    sRecoveryA: useLabel("daily_work.performance.summary.recovery_actual"),
    sSchemeP: useLabel("daily_work.performance.summary.scheme_conversion_planned"),
    sSchemeA: useLabel("daily_work.performance.summary.scheme_conversion_actual"),
    sApptP: useLabel("daily_work.performance.summary.appointment_planned"),
    sApptA: useLabel("daily_work.performance.summary.appointment_actual"),
    sVisitsP: useLabel("daily_work.performance.summary.visits_planned"),
    sVisitsA: useLabel("daily_work.performance.summary.visits_actual"),
    detailTitle: useLabel("daily_work.performance.detail.title"),
    openHint: useLabel("daily_work.performance.detail.open_hint"),
    modePerformance: useLabel("tasks.mode.performance"), modeTasks: useLabel("tasks.mode.tasks"), modeRequests: useLabel("daily_work.requests.mode"), late: useLabel("daily_work.performance.late"), pendingApproval: useLabel("daily_work.performance.pending_approval"), reopened: useLabel("daily_work.performance.reopened"),
    actCol: useLabel("tasks.activity.col"), actOne: useLabel("tasks.activity.tasks_one"), actMany: useLabel("tasks.activity.tasks_many"), actNone: useLabel("tasks.activity.none"),
    abandonedOne: useLabel("tasks.activity.abandoned_one"), abandonedMany: useLabel("tasks.activity.abandoned_many"), openAbandonedHint: useLabel("tasks.activity.open_abandoned"), activityTip: useLabel("tasks.activity.tip"),
    unavailable: useLabel("tasks.activity.unavailable"), unavailableTip: useLabel("tasks.activity.unavailable_tip"), bySection: useLabel("tasks.activity.by_section"),
    secSALES: useLabel("daily_work.section.sales"), secRECOVERY: useLabel("daily_work.section.recovery"), secAPPOINTMENT: useLabel("daily_work.section.appointment"), secSCHEME_CONVERSION: useLabel("daily_work.section.scheme_conversion"), secVISITS: useLabel("daily_work.section.visits"), secOTHERS: useLabel("daily_work.section.others"),
    movesOne: useLabel("tasks.activity.resched_one"), movesMany: useLabel("tasks.activity.resched_many"), openTasksHint: useLabel("tasks.activity.open_tasks"), openMovesHint: useLabel("tasks.activity.open_moves"),
  };
  const title = isSO ? L.my : isRM ? L.team : L.company;
  /** "Sales 3 · Recovery 2 · …" — how the row's task total is made up, in Daily Work order (sections with no task are left out). */
  const sectionBreakdown = (sections: Record<string, number>): string =>
    (["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "VISITS", "OTHERS"] as const).filter((k) => (sections[k] ?? 0) > 0).map((k) => `${L[`sec${k}` as const]} ${sections[k]}`).join(" · ");

  const query = new URLSearchParams({ from, to });
  if (!isSO) officerIds.forEach((id) => query.append("officerId", id));
  if (isAdmin) groupIds.forEach((id) => query.append("groupId", id));
  const { data, isLoading } = useQuery<Payload>({
    queryKey: ["performance", role, from, to, officerIds, groupIds],
    queryFn: () => api.get<Payload>(`/api/daily-work/performance?${query.toString()}`),
  });

  const showOfficer = !isSO;
  const showState = isAdmin;
  const colCount = 1 + (showOfficer ? 1 : 0) + (showState ? 1 : 0) + 6; // date + officer? + state? + plan/report/self/rm/task activity/action
  const changeState = (values: string[]) => {
    setGroupIds(values);
    // A State change establishes a new authoritative SO scope. Resetting is predictable and prevents a
    // previously selected officer from being sent with an incompatible State while the options refresh.
    setOfficerIds([]);
  };

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: L.breadcrumb }, { label: title }]} title={title} />

      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm" role="group" aria-label={`${L.modePerformance} / ${L.modeTasks}${canReviewRequests ? ` / ${L.modeRequests}` : ""}`} data-testid="mode-switch">
        {([["performance", L.modePerformance], ["tasks", L.modeTasks], ...(canReviewRequests ? [["requests", L.modeRequests] as const] : [])] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={mode === value} onClick={() => showMode(value)}
            className={cn("rounded px-4 py-1.5 font-medium", mode === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>
      {requestsOpened && canReviewRequests && <div hidden={mode !== "requests"}><LateRequestsView active={mode === "requests"} /></div>}
      {tasksOpened && <div hidden={mode !== "tasks"}><TaskAnalysisView role={role} filters={taskFilters} onFilters={setTaskFilters} /></div>}

      {mode === "performance" && (
        <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5"><Label>{L.dateFrom}</Label><DateInputDMY value={from} onChange={(v) => setFrom(v || currentBusinessDate())} className="w-44" aria-label={L.dateFrom} /></div>
        <div className="space-y-1.5"><Label>{L.dateTo}</Label><DateInputDMY value={to} onChange={(v) => setTo(v || currentBusinessDate())} className="w-44" aria-label={L.dateTo} /></div>

      </div>

      {/* Summary cards for the selected range. */}
      <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-3 lg:grid-cols-5">
        {!isSO && <Stat label={L.sOfficers} value={data ? String(data.summary.salesOfficers) : "—"} />}
        <Stat label={L.sPlans} value={data ? String(data.summary.submittedPlans) : "—"} />
        <Stat label={L.sReports} value={data ? String(data.summary.submittedReports) : "—"} />
        {isRM && <Stat label={L.sNotSubmitted} value={data ? String(data.summary.employeeDays - data.summary.submittedReports) : "—"} />}
        <Stat label={L.sAvgSelf} value={data ? ratingText(data.summary.averageSelfRating) : "—"} />
        <Stat label={L.sAvgRm} value={data ? ratingText(data.summary.averageRmRating) : "—"} />
        {/* Planned vs Actual per section, over the same filtered officers and dates as the table (Others has no totals). */}
        <div className="col-span-full grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-3 border-t pt-4" data-testid="section-totals">
          {([
            [L.sSalesP, L.sSalesA, "sales", rupees, "sales"], [L.sRecoveryP, L.sRecoveryA, "recovery", rupees, "recovery"], [L.sSchemeP, L.sSchemeA, "schemeConversion", countText, "scheme_conversion"],
            [L.sApptP, L.sApptA, "appointment", countText, "appointment"], [L.sVisitsP, L.sVisitsA, "visits", countText, "visits"],
          ] as const).map(([planned, actual, key, fmt, id]) => (
            <div key={key} className="grid min-w-0 grid-cols-1 gap-4 rounded-md border bg-muted/20 p-3 min-[480px]:grid-cols-2" aria-label={`${planned} / ${actual}`}>
              <Stat label={planned} value={data ? fmt(data.summary.sections[key].planned) : "—"} hint={L.openHint} onOpen={data ? () => setMetric({ metric: `${id}_planned`, title: L.detailTitle.replace("{metric}", planned) }) : undefined} />
              <Stat label={actual} value={data ? fmt(data.summary.sections[key].actual) : "—"} hint={L.openHint} onOpen={data ? () => setMetric({ metric: `${id}_actual`, title: L.detailTitle.replace("{metric}", actual) }) : undefined} />
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-auto rounded-lg border bg-background">
        <Table numbered>
          <TableHeader>
            <TableRow>
              <TableHead>{L.colDate}</TableHead>
              {showOfficer && (
                <ColumnFilterHeader
                  label={L.colOfficer}
                  ariaLabel={L.officerLabel}
                  options={(data?.officers ?? []).map((o) => ({ value: o.id, label: o.name }))}
                  selected={officerIds}
                  onChange={setOfficerIds}
                />
              )}
              {showState && (
                <ColumnFilterHeader
                  label={L.colState}
                  ariaLabel={L.fState}
                  options={(data?.states ?? []).map((s) => ({ value: s.id, label: s.name }))}
                  selected={groupIds}
                  onChange={changeState}
                />
              )}
              <TableHead>{L.colPlan}</TableHead>
              <TableHead>{L.colReport}</TableHead>
              <TableHead>{L.colSelf}</TableHead>
              <TableHead>{L.colRm}</TableHead>
              <Th labelKey="tasks.activity.col" />
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
                  <TableCell className="whitespace-nowrap tabular-nums">{r.planSubmittedAt ? timeText(r.planSubmittedAt) : r.planMissed ? <Badge variant="destructive" data-testid="plan-missed">{L.reportMissed}</Badge> : timeText(null)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {r.reportSubmittedAt ? <>{timeText(r.reportSubmittedAt)}{r.lateReport?.late && <div className="text-[11px] leading-tight text-muted-foreground" data-testid="late-label">{L.late}</div>}</> : r.reportMissed ? <>
                      <Badge variant="destructive">{L.reportMissed}</Badge>
                      {r.lateReport?.open && <div className="text-[11px] leading-tight text-muted-foreground" data-testid="late-open">{r.lateReport.open === "PENDING" ? L.pendingApproval : L.reopened}</div>}
                    </> : timeText(null)}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.selfRating == null ? dash : ratingText(r.selfRating)}</TableCell>
                  {/* Decided by the role of the person this ROW represents (never by the viewer): an RM has no RM rating, so the RM capsule shows. */}
                  <TableCell className="tabular-nums">{r.officerRole === Role.REGIONAL_MANAGER ? <RmBadge label={L.rmBadge} title={L.rmNoRating} /> : r.rmRating == null ? dash : ratingText(r.rmRating)}</TableCell>
                  <TableCell className="min-w-[9rem] text-xs" data-testid="task-activity">
                    {r.taskActivity ? (
                      <div className="space-y-0.5">
                        {r.taskActivity.tasks > 0
                          ? <button type="button" title={`${L.openTasksHint}. ${L.bySection.replace("{list}", sectionBreakdown(r.taskActivity.sections))}. ${L.activityTip}`} className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => openTasks(r, "ORIGINAL")}>{(r.taskActivity.tasks === 1 ? L.actOne : L.actMany).replace("{n}", String(r.taskActivity.tasks)).replace("{c}", String(r.taskActivity.completed))}</button>
                          : <div className="text-muted-foreground">{L.actNone}</div>}
                        {r.taskActivity.tasks > 0 && <div className="text-[11px] leading-tight text-muted-foreground" data-testid="activity-sections">{sectionBreakdown(r.taskActivity.sections)}</div>}
                        <div className="flex flex-wrap gap-x-1" data-testid="activity-moves">
                          {r.taskActivity.reschedules > 0
                            ? <button type="button" title={`${L.openMovesHint}. ${L.activityTip}`} className="text-primary underline-offset-2 hover:underline" onClick={() => openTasks(r, "RESCHEDULED_ON")}>{(r.taskActivity.reschedules === 1 ? L.movesOne : L.movesMany).replace("{n}", String(r.taskActivity.reschedules))}</button>
                            : <span className="text-muted-foreground" title={L.activityTip}>{L.movesMany.replace("{n}", "0")}</span>}
                          {r.taskActivity.abandoned > 0 && <>
                            <span aria-hidden>·</span>
                            <button type="button" title={`${L.openAbandonedHint}. ${L.activityTip}`} className="font-medium text-destructive underline-offset-2 hover:underline" data-testid="activity-abandoned" onClick={() => openTasks(r, "ABANDONED_ON")}>{(r.taskActivity.abandoned === 1 ? L.abandonedOne : L.abandonedMany).replace("{n}", String(r.taskActivity.abandoned))}</button>
                          </>}
                        </div>
                      </div>
                    ) : <span className="text-muted-foreground" title={L.unavailableTip} data-testid="activity-unavailable">{L.unavailable}</span>}
                  </TableCell>
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

        </>
      )}

      {metric && data && (
        // The drill-down uses the filters of the data the card was computed from (this page's Date From / Date To / State / officer).
        <PerformanceMetricDetail request={{ ...metric, from: data.from, to: data.to, officerIds, groupIds, isSO, isAdmin } satisfies MetricRequest} onClose={() => setMetric(null)} />
      )}

      {detail && (
        <DailyWorkReviewDialog
          officerId={detail.officerId}
          workDate={detail.date}
          // Only an RM viewer, and only on a Sales Officer's day, can rate: an RM's own day (or any RM's) is view-only.
          readOnly={role !== Role.REGIONAL_MANAGER || data?.rows.find((r) => r.officerId === detail.officerId)?.officerRole === Role.REGIONAL_MANAGER}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, hint, onOpen }: { label: string; value: string; hint?: string; onOpen?: () => void }) {
  const body = (
    <>
      <div className="text-xs leading-5 text-muted-foreground">{label}</div>
      <div className="break-words text-lg font-semibold tabular-nums [overflow-wrap:anywhere]">{value}</div>
    </>
  );
  if (!onOpen) return <div className="min-w-0">{body}</div>;
  // A clickable card: same look, plus a pointer, hover and keyboard-focus state. A real button, so Enter / Space open it.
  return (
    <button type="button" title={hint} onClick={onOpen} className="min-w-0 cursor-pointer rounded-md p-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </button>
  );
}
