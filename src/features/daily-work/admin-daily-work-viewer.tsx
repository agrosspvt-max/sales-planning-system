"use client";

import { DealerTableBody as TableBody } from "@/features/dealers/dealer-table-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiRequestError } from "@/lib/api-client";
import { cn, formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import {
  combineAppointmentRows, combineConversionRows, combineDailyWorkRows, currentBusinessDate, rowTaskType,
  type AppointmentRow, type ConversionRow, type DailyWorkDealerRow, type DailyWorkType, type RecoveryPaymentMode,
} from "@/lib/daily-work";
import { useLabel } from "@/features/labels/label-ui";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DailyWorkFieldset } from "./daily-work-fieldset";
import { MonthlyRecoveryPlanHeader, RecoveryPaymentModeField } from "./recovery-payment-mode";

type Section = "SALES" | "RECOVERY" | "APPOINTMENT" | "SCHEME_CONVERSION" | "VISITS" | "OTHERS";

interface Option { id: string; name: string }
interface GroupOption extends Option { memberCount: number }
interface OfficerOption extends Option { groupId: string | null }
interface DealerRow {
  entryId: string; dealerId: string; dealerName: string; monthlyPlan: number; pending: number;
  todaysPlan: number | null; todaysActual: number | null; entryType: DailyWorkType;
  paymentMode?: RecoveryPaymentMode | null;
}
interface DealerPayload { dealers: DealerRow[]; autoTaskEntryIds: string[] }
interface AppointmentPayload {
  rows: { entryId: string; dealerName: string; marketName: string; status: "APPOINTED" | "NOT_APPOINTED" | null }[];
}
interface ConversionPayload {
  rows: { entryId: string; dealerId: string; schemeId: string; dealerName: string; schemeName: string; plannedUnits: number; pending: number; todaysPlan: number | null; achievability: "YES" | "NO" | null }[];
}
interface SummaryBatch {
  entryId: string; dealerVisits: number; newPartyVisits: number; actualDealerVisits: number | null;
  actualNewPartyVisits: number | null; others: string; noPlanSections: string | null;
}
interface SummaryPayload { batches: SummaryBatch[]; others: string }
interface ReportPayload {
  officerId: string; officerName: string; workDate: string;
  sales: DealerPayload; recovery: DealerPayload; appointment: AppointmentPayload; conversion: ConversionPayload;
  summary: SummaryPayload; selfRating: number | null; review: { rating: number } | null;
}

const dash = <span className="text-muted-foreground">—</span>;
const money = (value: number) => formatCurrency(value);
const rating = (value: number | null) => value == null ? "—" : `${value} / 10`;

export function AdminDailyWorkViewer() {
  const [workDate, setWorkDate] = useState(currentBusinessDate);
  const [groupId, setGroupId] = useState("");
  const [officerId, setOfficerId] = useState("");
  const [section, setSection] = useState<Section>("SALES");
  const L = {
    title: useLabel("daily_work.title"), planning: useLabel("daily_work.page.breadcrumb_planning"),
    subtitle: useLabel("daily_work.admin.subtitle"), planReport: useLabel("daily_work.container.plan_report"),
    planningTitle: useLabel("daily_work.container.planning"), taskTitle: useLabel("daily_work.container.daily_task"),
    date: useLabel("daily_work.team.date"), state: useLabel("daily_work.performance.col.state"),
    officer: useLabel("daily_work.team.col.sales_officer"), selectState: useLabel("daily_work.admin.select_state"),
    selectOfficer: useLabel("daily_work.admin.select_officer"), chooseState: useLabel("daily_work.admin.choose_state"),
    chooseOfficer: useLabel("daily_work.admin.choose_officer"), dailyPlan: useLabel("daily_work.view.plan"),
    dailyReport: useLabel("daily_work.view.report"), noReport: useLabel("daily_work.report.no_submitted"),
    noSection: useLabel("daily_work.report.no_submitted_section"), noPlan: useLabel("daily_work.action.no_plan"),
    selfRating: useLabel("daily_work.review.self_rating"), rmRating: useLabel("daily_work.team.col.rm_rating"),
  };
  const sectionLabels: Record<Section, string> = {
    SALES: useLabel("daily_work.section.sales"), RECOVERY: useLabel("daily_work.section.recovery"),
    APPOINTMENT: useLabel("daily_work.section.appointment"), SCHEME_CONVERSION: useLabel("daily_work.section.scheme_conversion"),
    VISITS: useLabel("daily_work.section.visits"), OTHERS: useLabel("daily_work.section.others"),
  };

  const groups = useQuery<GroupOption[]>({ queryKey: ["daily-work-admin-states"], queryFn: () => api.get<GroupOption[]>("/api/groups") });
  const officers = useQuery<OfficerOption[]>({
    queryKey: ["daily-work-admin-officers", groupId],
    queryFn: () => api.get<OfficerOption[]>(`/api/users/officers?filter=active&groupId=${encodeURIComponent(groupId)}`),
    enabled: !!groupId,
  });
  const report = useQuery<ReportPayload>({
    queryKey: ["daily-work-admin-report", workDate, groupId, officerId],
    queryFn: () => {
      const query = new URLSearchParams({ date: workDate, groupId, officerId });
      return api.get<ReportPayload>(`/api/daily-work/admin-view?${query.toString()}`);
    },
    enabled: !!groupId && !!officerId,
    retry: false,
  });

  const changeGroup = (value: string) => { setGroupId(value); setOfficerId(""); };
  const emptyMessage = !groupId ? L.chooseState : !officerId ? L.chooseOfficer : report.error instanceof ApiRequestError && report.error.status === 409 ? L.noReport : null;

  return (
    <div className="space-y-5">
      <PageHeader crumbs={[{ label: L.planning }, { label: L.title }]} title={L.title} subtitle={L.subtitle} />

      <DailyWorkFieldset legend={L.planReport}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5"><Label>{L.date}</Label><Input type="date" value={workDate} onChange={(event) => setWorkDate(event.target.value || currentBusinessDate())} className="w-44" /></div>
          <div className="space-y-1.5"><Label>{L.state}</Label><NativeSelect className="w-48" value={groupId} onChange={(event) => changeGroup(event.target.value)} options={[{ value: "", label: L.selectState }, ...(groups.data ?? []).map((group) => ({ value: group.id, label: group.name }))]} /></div>
          <div className="space-y-1.5"><Label>{L.officer}</Label><NativeSelect className="w-56" value={officerId} disabled={!groupId || officers.isLoading} onChange={(event) => setOfficerId(event.target.value)} options={[{ value: "", label: L.selectOfficer }, ...(officers.data ?? []).map((officer) => ({ value: officer.id, label: officer.name }))]} /></div>
        </div>
        <div className="inline-flex max-w-full flex-wrap rounded-md border bg-background p-0.5 text-sm">
          <button type="button" disabled className="cursor-not-allowed rounded px-4 py-1.5 font-medium text-muted-foreground opacity-60">{L.dailyPlan}</button>
          <button type="button" className="rounded bg-primary px-4 py-1.5 font-medium text-primary-foreground">{L.dailyReport}</button>
        </div>
      </DailyWorkFieldset>

      <DailyWorkFieldset legend={L.planningTitle}>
        <div className="inline-flex flex-wrap rounded-md border bg-background p-0.5 text-sm">
          {(Object.keys(sectionLabels) as Section[]).map((value) => (
            <button key={value} type="button" onClick={() => setSection(value)} className={cn("rounded px-3 py-1.5 font-medium", section === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{sectionLabels[value]}</button>
          ))}
        </div>
      </DailyWorkFieldset>

      <DailyWorkFieldset legend={L.taskTitle}>
        {groups.isError || officers.isError ? <ErrorState error={(groups.error ?? officers.error) as Error} />
          : emptyMessage ? <EmptyState text={emptyMessage} />
          : report.isLoading || report.isFetching ? <Skeleton className="h-52 w-full" />
          : report.isError ? <ErrorState error={report.error as Error} />
          : report.data ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
                <span className="font-medium">{report.data.officerName} · {new Date(`${report.data.workDate}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" })}</span>
                <span className="flex gap-5 text-muted-foreground"><span>{L.selfRating}: <b className="text-foreground">{rating(report.data.selfRating)}</b></span><span>{L.rmRating}: <b className="text-foreground">{rating(report.data.review?.rating ?? null)}</b></span></span>
              </div>
              <AdminReportSection section={section} report={report.data} noSection={L.noSection} noPlan={L.noPlan} />
            </div>
          ) : null}
      </DailyWorkFieldset>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-lg border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">{text}</div>;
}

function ErrorState({ error }: { error: Error }) {
  return <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-8 text-center text-sm text-destructive">{error.message}</div>;
}

function AdminReportSection({ section, report, noSection, noPlan }: { section: Section; report: ReportPayload; noSection: string; noPlan: string }) {
  const isNoPlan = (value: Section) => report.summary.batches.length > 0 && report.summary.batches.every((batch) => new Set((batch.noPlanSections ?? "").split(",").filter(Boolean)).has(value));
  if (section === "SALES" || section === "RECOVERY") {
    if (report[section === "SALES" ? "sales" : "recovery"].dealers.length === 0) return <EmptyState text={isNoPlan(section) ? noPlan : noSection} />;
    return <AdminDealerReport section={section} data={report[section === "SALES" ? "sales" : "recovery"]} />;
  }
  if (section === "APPOINTMENT") {
    if (report.appointment.rows.length === 0) return <EmptyState text={isNoPlan(section) ? noPlan : noSection} />;
    return <AdminAppointmentReport data={report.appointment} />;
  }
  if (section === "SCHEME_CONVERSION") {
    if (report.conversion.rows.length === 0) return <EmptyState text={isNoPlan(section) ? noPlan : noSection} />;
    return <AdminConversionReport data={report.conversion} />;
  }
  if (section === "VISITS") {
    const batches = report.summary.batches.filter((batch) => !new Set((batch.noPlanSections ?? "").split(",").filter(Boolean)).has("VISITS"));
    if (batches.length === 0) return <EmptyState text={isNoPlan(section) ? noPlan : noSection} />;
    return <AdminVisitsReport batches={batches} />;
  }
  return report.summary.others.trim() ? <div className="whitespace-pre-wrap rounded-lg border bg-background p-4 text-sm">{report.summary.others}</div> : <EmptyState text={isNoPlan(section) ? noPlan : noSection} />;
}

function AdminDealerReport({ section, data }: { section: "SALES" | "RECOVERY"; data: DealerPayload }) {
  const L = {
    dealer: useLabel("col.dealer"), dealers: useLabel("daily_work.count.dealers"), task: useLabel("daily_work.col.task_type"),
    auto: useLabel("daily_work.task_type.auto"), manual: useLabel("daily_work.task_type.manual"), none: useLabel("daily_work.combined.none"),
    plan: useLabel(section === "SALES" ? "daily_work.col.monthly_sales_plan" : "daily_work.col.monthly_recovery_plan"),
    pending: useLabel("col.pending"), today: useLabel("daily_work.col.todays_plan"),
    type: useLabel(section === "SALES" ? "daily_work.col.sales_type" : "daily_work.col.recovery_type"),
    paymentMode: useLabel("daily_work.col.payment_mode"),
    actual: useLabel(section === "SALES" ? "daily_work.col.todays_sales" : "daily_work.col.todays_recovery"),
    regular: useLabel("daily_work.type.regular"), scheme: useLabel("daily_work.type.scheme"),
  };
  const combined = combineDailyWorkRows(data.dealers.map((row): DailyWorkDealerRow => ({ monthlyPlan: row.monthlyPlan, actual: 0, pending: row.pending, todaysPlan: row.todaysPlan ?? 0, todaysActual: row.todaysActual ?? 0, type: row.entryType })), { dealer: L.dealer, dealers: L.dealers });
  const autoEntries = new Set(data.autoTaskEntryIds);
  const task = (row: DealerRow) => rowTaskType(autoEntries.has(row.entryId)) === "AUTO" ? L.auto : L.manual;
  const type = (value: DailyWorkType) => value === "SCHEME" ? L.scheme : L.regular;
  return <div className="overflow-auto rounded-lg border bg-background"><Table className={cn("table-fixed", section === "RECOVERY" ? "min-w-[1104px]" : "min-w-[960px]")}><TableHeader><TableRow>
    <TableHead className="w-60">{L.dealer}</TableHead><TableHead className="w-32">{L.task}</TableHead><TableHead className="w-44 text-right">{section === "RECOVERY" ? <MonthlyRecoveryPlanHeader label={L.plan} /> : L.plan}</TableHead><TableHead className="w-32 text-right">{L.pending}</TableHead><TableHead className="w-36 text-right">{L.today}</TableHead>{section === "RECOVERY" && <TableHead className="w-36">{L.paymentMode}</TableHead>}<TableHead className="w-44">{L.type}</TableHead><TableHead className="w-36 text-right">{L.actual}</TableHead>
  </TableRow></TableHeader><TableBody>
    <TableRow className="border-b-2 bg-muted/40 font-semibold"><TableCell>{combined.dealerLabel}</TableCell><TableCell>{L.none}</TableCell><TableCell className="text-right tabular-nums">{money(combined.monthlyPlan)}</TableCell><TableCell className="text-right tabular-nums">{money(combined.pending)}</TableCell><TableCell className="text-right tabular-nums">{money(combined.todaysPlan)}</TableCell>{section === "RECOVERY" && <TableCell>{L.none}</TableCell>}<TableCell>{L.none}</TableCell><TableCell className="text-right tabular-nums">{money(combined.todaysActual)}</TableCell></TableRow>
    {data.dealers.map((row) => <TableRow data-dealer-id={row.dealerId} key={row.entryId}><TableCell className="font-medium"><DealerName id={row.dealerId} name={row.dealerName} /></TableCell><TableCell>{task(row)}</TableCell><TableCell className="text-right tabular-nums">{money(row.monthlyPlan)}</TableCell><TableCell className="text-right tabular-nums">{money(row.pending)}</TableCell><TableCell className="text-right tabular-nums">{row.todaysPlan == null ? dash : money(row.todaysPlan)}</TableCell>{section === "RECOVERY" && <TableCell><RecoveryPaymentModeField value={row.paymentMode ?? null} /></TableCell>}<TableCell>{type(row.entryType)}</TableCell><TableCell className="text-right tabular-nums">{row.todaysActual == null ? dash : money(row.todaysActual)}</TableCell></TableRow>)}
  </TableBody></Table></div>;
}

function AdminAppointmentReport({ data }: { data: AppointmentPayload }) {
  const L = { dealer: useLabel("col.dealer"), dealers: useLabel("daily_work.count.dealers"), task: useLabel("daily_work.col.task_type"), manual: useLabel("daily_work.task_type.manual"), market: useLabel("daily_work.col.market"), markets: useLabel("daily_work.count.markets"), plan: useLabel("daily_work.col.monthly_dealer_plan"), pending: useLabel("col.pending"), work: useLabel("daily_work.col.todays_appointment"), result: useLabel("daily_work.col.appointment_status"), appointed: useLabel("daily_work.status.appointed"), not: useLabel("daily_work.status.not_appointed"), none: useLabel("daily_work.combined.none") };
  const combined = combineAppointmentRows(data.rows.map((row): AppointmentRow => ({ marketName: row.marketName, status: row.status })), { dealer: L.dealer, dealers: L.dealers, market: L.market, markets: L.markets });
  return <div className="overflow-auto rounded-lg border bg-background"><Table className="min-w-[960px] table-fixed"><TableHeader><TableRow><TableHead className="w-52">{L.dealer}</TableHead><TableHead className="w-32">{L.task}</TableHead><TableHead className="w-44">{L.market}</TableHead><TableHead className="w-44 text-right">{L.plan}</TableHead><TableHead className="w-32 text-right">{L.pending}</TableHead><TableHead className="w-40">{L.work}</TableHead><TableHead className="w-44">{L.result}</TableHead></TableRow></TableHeader><TableBody>
    <TableRow className="border-b-2 bg-muted/40 font-semibold"><TableCell>{combined.dealerLabel}</TableCell><TableCell>{L.none}</TableCell><TableCell>{L.none}</TableCell><TableCell className="text-right">{L.none}</TableCell><TableCell className="text-right">{L.none}</TableCell><TableCell>{L.none}</TableCell><TableCell>{L.none}</TableCell></TableRow>
    {data.rows.map((row) => <TableRow key={row.entryId}><TableCell className="font-medium">{row.dealerName}</TableCell><TableCell>{L.manual}</TableCell><TableCell>{row.marketName || dash}</TableCell><TableCell className="text-right">{dash}</TableCell><TableCell className="text-right">{dash}</TableCell><TableCell>{dash}</TableCell><TableCell>{row.status === "APPOINTED" ? L.appointed : row.status === "NOT_APPOINTED" ? L.not : dash}</TableCell></TableRow>)}
  </TableBody></Table></div>;
}

function AdminConversionReport({ data }: { data: ConversionPayload }) {
  const L = { dealer: useLabel("col.dealer"), dealers: useLabel("daily_work.count.dealers"), task: useLabel("daily_work.col.task_type"), manual: useLabel("daily_work.task_type.manual"), scheme: useLabel("daily_work.col.scheme"), planned: useLabel("daily_work.col.planned_scheme_units"), pending: useLabel("col.pending"), today: useLabel("daily_work.col.todays_plan"), result: useLabel("daily_work.col.todays_conversion"), yes: useLabel("daily_work.achievability.yes"), no: useLabel("daily_work.achievability.no"), none: useLabel("daily_work.combined.none") };
  const combined = combineConversionRows(data.rows.map((row): ConversionRow => ({ schemeId: row.schemeId, plannedUnits: row.plannedUnits, pending: row.pending, todaysPlan: row.todaysPlan ?? 0, achievability: row.achievability })), { dealer: L.dealer, dealers: L.dealers });
  return <div className="overflow-auto rounded-lg border bg-background"><Table className="min-w-[960px] table-fixed"><TableHeader><TableRow><TableHead className="w-52">{L.dealer}</TableHead><TableHead className="w-32">{L.task}</TableHead><TableHead className="w-56">{L.scheme}</TableHead><TableHead className="w-44 text-right">{L.planned}</TableHead><TableHead className="w-32 text-right">{L.pending}</TableHead><TableHead className="w-36 text-right">{L.today}</TableHead><TableHead className="w-36">{L.result}</TableHead></TableRow></TableHeader><TableBody>
    <TableRow className="border-b-2 bg-muted/40 font-semibold"><TableCell>{combined.dealerLabel}</TableCell><TableCell>{L.none}</TableCell><TableCell>{L.none}</TableCell><TableCell className="text-right tabular-nums">{combined.plannedUnits}</TableCell><TableCell className="text-right tabular-nums">{combined.pending}</TableCell><TableCell className="text-right tabular-nums">{combined.todaysPlan}</TableCell><TableCell>{L.none}</TableCell></TableRow>
    {data.rows.map((row) => <TableRow key={row.entryId} data-dealer-id={row.dealerId}><TableCell className="font-medium"><DealerName id={row.dealerId} name={row.dealerName} /></TableCell><TableCell>{L.manual}</TableCell><TableCell>{row.schemeName}</TableCell><TableCell className="text-right tabular-nums">{row.plannedUnits}</TableCell><TableCell className="text-right tabular-nums">{row.pending}</TableCell><TableCell className="text-right tabular-nums">{row.todaysPlan ?? dash}</TableCell><TableCell>{row.achievability === "YES" ? L.yes : row.achievability === "NO" ? L.no : dash}</TableCell></TableRow>)}
  </TableBody></Table></div>;
}

function AdminVisitsReport({ batches }: { batches: SummaryBatch[] }) {
  const L = { batch: useLabel("daily_work.col.batch"), pd: useLabel("daily_work.visits.planned_dealer_visits"), pn: useLabel("daily_work.visits.planned_new_party_visits"), ad: useLabel("daily_work.visits.actual_dealer_visits"), an: useLabel("daily_work.visits.actual_new_party_visits") };
  return <div className="overflow-auto rounded-lg border bg-background"><Table><TableHeader><TableRow><TableHead>{L.batch}</TableHead><TableHead className="text-right">{L.pd}</TableHead><TableHead className="text-right">{L.pn}</TableHead><TableHead className="text-right">{L.ad}</TableHead><TableHead className="text-right">{L.an}</TableHead></TableRow></TableHeader><TableBody>{batches.map((batch, index) => <TableRow key={batch.entryId}><TableCell className="font-medium">{index + 1}</TableCell><TableCell className="text-right tabular-nums">{batch.dealerVisits}</TableCell><TableCell className="text-right tabular-nums">{batch.newPartyVisits}</TableCell><TableCell className="text-right tabular-nums">{batch.actualDealerVisits ?? dash}</TableCell><TableCell className="text-right tabular-nums">{batch.actualNewPartyVisits ?? dash}</TableCell></TableRow>)}</TableBody></Table></div>;
}
