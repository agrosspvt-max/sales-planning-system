"use client";
import { isAdministrativeRole } from "@/features/accounts/permissions";


import { DealerTableBody as TableBody } from "@/features/dealers/dealer-table-ui";
import { DealerName } from "@/features/dealers/dealer-name-ui";
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { CalendarClock, Eye, FileText, MoreVertical, Plus, Trash2, Save, Send, Check, Ban } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLabel } from "@/features/labels/label-ui";
import { useDailyAutosave } from "./use-daily-autosave";
import { DailyWorkFieldset } from "./daily-work-fieldset";
import { MonthlyRecoveryPlanHeader, RecoveryPaymentModeField } from "./recovery-payment-mode";
import { AdminDailyWorkViewer } from "./admin-daily-work-viewer";
import { CnRequestDetailDialog } from "@/features/cn-requests/cn-request-detail-dialog";
import { isCnSundayDateKey } from "@/lib/cn-request";
import {
  combineDailyWorkRows, combineAppointmentRows, combineConversionRows, rowTaskType,
  currentBusinessDate, dailyWorkShowsResults, visibleDailyWorkRows, DEFAULT_DAILY_WORK_VIEW, DailyWorkView,
  type RecoveryPaymentMode, type DailyWorkDealerRow, type DailyWorkType, type AppointmentRow, type ConversionRow, type TaskType, type DailyWorkView as DailyWorkViewType,
} from "@/lib/daily-work";

/* --------------------------------- Types (mirror the service DTO) --------------------------------- */

interface SchemeOption { id: string; name: string }
interface DealerDto {
  entryId: string; batchId: string;
  dealerId: string; dealerName: string; monthlyPlan: number; actual: number; pending: number;
  todaysPlan: number | null; todaysActual: number | null; entryType: DailyWorkType; schemeId: string | null;
  paymentMode?: RecoveryPaymentMode | null;
  status: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" | "NEW";
}
interface CnTask {
  taskId: string | null; cnRequestId: string; dealerId: string; taskType: "CN_REQUEST"; planType: "RECOVERY";
  partyName: string; cnType: string; details: string | null; amount: number | null; reason: "PAYMENT_PENDING" | "OTHER" | null;
  kind: "CN_RECOVERY" | "CN_TASK"; recoveryAmount: number | null; taskDate: string | null;
  taskRescheduled: boolean; confirmed: boolean;
  acceptanceDate: string | null; expiryDate: string | null; paymentStatus: string | null;
}
interface Payload {
  section: "SALES" | "RECOVERY"; workDate: string; monthName: string | null; canEnterActual: boolean;
  availableDealers: AvailableDealer[]; applicableSchemes: SchemeOption[];
  applicableSchemesByDealer: Record<string, SchemeOption[]>; cnTasks?: CnTask[]; materializedCnTasks?: CnTask[]; dealers: DealerDto[];
}
interface AvailableDealer { id: string; name: string; monthlyPlan: number; actual: number; pending: number }

/** Local editable row (extends the server row with in-progress edits before save). */
interface EditRow {
  entryId: string; batchId: string;
  dealerId: string; dealerName: string; monthlyPlan: number; actual: number; pending: number;
  todaysPlan: string; entryType: DailyWorkType; schemeId: string; todaysActual: string;
  paymentMode: RecoveryPaymentMode | null;
  status: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" | "NEW";
}

const money = (n: number) => formatCurrency(n);
const numOr0 = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };

/** Shared Task Type cell text for individual Daily Plan rows. */
interface TaskTypeLabels { auto: string; manual: string; none: string }
const taskTypeText = (value: TaskType | null, L: TaskTypeLabels): string =>
  value === "AUTO" ? L.auto : value === "MANUAL" ? L.manual : L.none;

/**
 * The active section's Save Draft handle, lifted to the page so the button can live in the Plan Type toolbar
 * (next to No Plan + Submit) instead of at the bottom of each section. The section still OWNS the handler/state
 * (its own autosave.flush + saving/failed); this context only carries a reference — no duplicated logic.
 */
interface SaveDraftHandle { flush: () => Promise<void>; saving: boolean; failed: boolean; savedAt: number | null }
const SaveDraftContext = createContext<{ register: (h: SaveDraftHandle | null) => void } | null>(null);

/** Called by the active section (PLAN, not finalized) to publish its Save Draft handle to the Plan Type toolbar. */
function useRegisterSaveDraft(active: boolean, handle: SaveDraftHandle): void {
  const ctx = useContext(SaveDraftContext);
  const { flush, saving, failed, savedAt } = handle;
  const registeredHandle = useMemo<SaveDraftHandle>(
    () => ({ flush, saving, failed, savedAt }),
    [flush, saving, failed, savedAt],
  );
  const register = ctx?.register;
  useEffect(() => {
    if (!register || !active) return;
    register(registeredHandle);
    // No cleanup-to-null on value change (would flicker the button); the next mounted section overwrites it, and
    // the toolbar only renders in PLAN view where a section is always mounted.
  }, [register, active, registeredHandle]);
}

/* ---- Section completion status (progress bar + No Plan + submit gate) ---- */

type MandatorySection = "SALES" | "RECOVERY" | "APPOINTMENT" | "SCHEME_CONVERSION" | "VISITS";
type SectionStatusValue = "FILLED" | "NO_PLAN" | "REMAINING";
interface StatusPayload {
  workDate: string;
  sections: { section: MandatorySection; status: SectionStatusValue; hasData: boolean }[];
  counts: { filled: number; noPlan: number; remaining: number; total: number };
  canSubmit: boolean;
  hasSubmittedWork: boolean;
  canSubmitReport: boolean;
  isFinalized: boolean;
  selfRating: number | null;
  reportSections: { section: MandatorySection; required: boolean; complete: boolean }[];
  autoTasksEnabled: boolean;
}
/** Shared status query — every section save/No-Plan invalidates this key so the bar updates immediately. */
const STATUS_KEY = (workDate: string) => ["daily-work-status", workDate] as const;
function useDailyStatus(workDate: string) {
  return useQuery<StatusPayload>({ queryKey: STATUS_KEY(workDate), queryFn: () => api.get<StatusPayload>("/api/daily-work/status") });
}

/* ==================================== Page ==================================== */

type Section = "SALES" | "RECOVERY" | "APPOINTMENT" | "SCHEME_CONVERSION" | "VISITS" | "OTHERS";

export function DailyWorkPage({ role }: { role: Role }) {
  return isAdministrativeRole(role) ? <AdminDailyWorkViewer /> : <OwnerDailyWorkPage />;
}

function OwnerDailyWorkPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<DailyWorkViewType>(DEFAULT_DAILY_WORK_VIEW);
  const [section, setSection] = useState<Section>("SALES");
  const [workDate, setWorkDate] = useState(currentBusinessDate);
  // Keep a long-open page aligned with the India business day when midnight passes.
  useEffect(() => {
    const syncBusinessDate = () => setWorkDate(currentBusinessDate());
    const timer = window.setInterval(syncBusinessDate, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const { data: dayStatus } = useDailyStatus(workDate);
  // The server is authoritative; this also closes the brief boundary window if a request crosses midnight.
  useEffect(() => {
    if (dayStatus?.workDate && dayStatus.workDate !== workDate) setWorkDate(dayStatus.workDate);
  }, [dayStatus?.workDate, workDate]);
  const title = useLabel("daily_work.title");
  const planning = useLabel("daily_work.page.breadcrumb_planning");
  const subtitle = useLabel("daily_work.page.subtitle");
  const dailyPlan = useLabel("daily_work.view.plan");
  const dailyReport = useLabel("daily_work.view.report");
  const noSubmittedReport = useLabel("daily_work.report.no_submitted");
  const dailyReportLocked = useLabel("daily_work.report.locked");
  const selfRatingLabel = useLabel("daily_work.rating.self_rating");
  const planReportTitle = useLabel("daily_work.container.plan_report");
  const cnTasksTitle = useLabel("daily_work.container.cn_tasks");
  const dailyWorkPlanningTitle = useLabel("daily_work.container.planning");
  const dailyTaskTitle = useLabel("daily_work.container.daily_task");
  const labels: Record<Section, string> = {
    SALES: useLabel("daily_work.section.sales"),
    RECOVERY: useLabel("daily_work.section.recovery"),
    APPOINTMENT: useLabel("daily_work.section.appointment"),
    SCHEME_CONVERSION: useLabel("daily_work.section.scheme_conversion"),
    VISITS: useLabel("daily_work.section.visits"),
    OTHERS: useLabel("daily_work.section.others"),
  };
  // Authoritative per-section status (FILLED / NO_PLAN / REMAINING) reused for the minimal per-tab indicators.
  const sectionStatusMap = new Map<MandatorySection, SectionStatusValue>((dayStatus?.sections ?? []).map((x) => [x.section, x.status]));
  // The active section publishes its Save Draft handle here so the Plan Type toolbar can render the button.
  const [draftHandle, setDraftHandle] = useState<SaveDraftHandle | null>(null);
  const registerSaveDraft = useCallback((next: SaveDraftHandle | null) => {
    setDraftHandle((current) => {
      if (current === next) return current;
      if (current && next
        && current.flush === next.flush
        && current.saving === next.saving
        && current.failed === next.failed
        && current.savedAt === next.savedAt) return current;
      return next;
    });
  }, []);
  const saveDraftContextValue = useMemo(() => ({ register: registerSaveDraft }), [registerSaveDraft]);
  return (
    <SaveDraftContext.Provider value={saveDraftContextValue}>
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: planning }, { label: title }]}
        title={title}
        subtitle={subtitle}
      />
      <DailyWorkFieldset legend={planReportTitle}>
        <div className="inline-flex max-w-full flex-wrap rounded-md border bg-background p-0.5 text-sm">
          {([
            { value: DailyWorkView.PLAN, label: dailyPlan },
            { value: DailyWorkView.REPORT, label: dailyReport },
          ] as const).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setView(option.value)}
              className={cn("rounded px-4 py-1.5 font-medium", view === option.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {option.label}
            </button>
          ))}
        </div>
      </DailyWorkFieldset>

      <DailyWorkFieldset legend={dailyWorkPlanningTitle}>
        {/* Left: section tabs (with status icons below each). Right: the actions for the selected view.
            On narrow widths the action group wraps to its own line instead of overlapping the tabs. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="inline-flex flex-wrap rounded-md border bg-background p-0.5 text-sm">
            {(["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "VISITS", "OTHERS"] as const).map((s) => (
              // Each section is a column: the button holds ONLY the label; the status icon sits directly below it,
              // outside the button, so the active (blue) button never hides the icon. Reuses the existing status.
              <div key={s} className="flex flex-col items-center">
                <button
                  onClick={() => setSection(s)}
                  className={cn("rounded px-3 py-1.5 font-medium", section === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {labels[s]}
                </button>
                <SectionStatusIcon status={sectionStatusMap.get(s as MandatorySection)} />
              </div>
            ))}
          </div>
          {/* Plan and Report actions share this toolbar while retaining their existing handlers. */}
          {view === DailyWorkView.PLAN && !dayStatus?.isFinalized && (
            <DailyWorkActions workDate={workDate} section={section} draft={draftHandle} />
          )}
          {view === DailyWorkView.REPORT && dayStatus?.hasSubmittedWork && (
            <DailyReportProgress workDate={workDate} />
          )}
        </div>
      </DailyWorkFieldset>

      {/* Today's Auto Tasks — a shared Daily Work block, separate from the selected planning section. This block's
          VISIBILITY alone is controlled by the "Enable Auto Tasks" Recovery Setting (default OFF). Auto Task
          scheduling, materialization, rescheduling, payment and the Daily Report are unaffected by this flag. */}
      {dayStatus?.autoTasksEnabled && (
        <DailyWorkFieldset legend={cnTasksTitle}>
          <CnTasksPanel onChanged={() => { qc.invalidateQueries({ queryKey: ["daily-work"] }); qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); }} />
        </DailyWorkFieldset>
      )}

      <DailyWorkFieldset legend={dailyTaskTitle}>
        {/* Day actions live in the Plan Type fieldset; Daily Task starts directly with its content. */}
        {view === DailyWorkView.REPORT && dayStatus && !dayStatus.hasSubmittedWork && (
          <div className="rounded-lg border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            {noSubmittedReport}
          </div>
        )}
        {/* Final Self Rating is shown only after the Daily Report is finalized. */}
        {view === DailyWorkView.REPORT && dayStatus?.isFinalized && (
          <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-2.5 text-sm">
            <span className="text-muted-foreground">{selfRatingLabel}</span>
            <span className="font-medium tabular-nums">{dayStatus.selfRating != null ? `${dayStatus.selfRating} / 10` : "—"}</span>
          </div>
        )}

        {/* Remount when the authoritative business date changes so today's editor re-seeds cleanly. */}
        <div className={cn(
          view === DailyWorkView.REPORT && dayStatus && !dayStatus.hasSubmittedWork && "hidden",
          view === DailyWorkView.PLAN && dayStatus?.isFinalized && "hidden",
        )}>
          {section === "APPOINTMENT" ? (
            <AppointmentSection key={`appt-${workDate}-${view}`} workDate={workDate} view={view} locked={dayStatus?.isFinalized ?? false} />
          ) : section === "SCHEME_CONVERSION" ? (
            <ConversionSection key={`conv-${workDate}-${view}`} workDate={workDate} view={view} locked={dayStatus?.isFinalized ?? false} />
          ) : section === "VISITS" || section === "OTHERS" ? (
            // Visits + Others share one SUMMARY record per planning batch; the toggle focuses the visible fields.
            <SummarySection key={`summary-${workDate}-${view}`} workDate={workDate} focus={section} view={view} locked={dayStatus?.isFinalized ?? false} />
          ) : (
            <DailyWorkSection key={`${section}-${workDate}-${view}`} section={section} workDate={workDate} view={view} locked={dayStatus?.isFinalized ?? false} />
          )}
        </div>
        {view === DailyWorkView.PLAN && dayStatus?.isFinalized && (
          <div className="rounded-lg border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">{dailyReportLocked}</div>
        )}
      </DailyWorkFieldset>
    </div>
    </SaveDraftContext.Provider>
  );
}

/* ==================================== Section status + Submit ==================================== */

/**
 * Minimal per-section status shown directly under a section tab label. FILLED → green tick; NO_PLAN → the same
 * purple Ban symbol the Recovery No-Plan UI uses (lucide `Ban` + `text-noplan`); REMAINING/undefined → nothing.
 * Fixed height so tab labels stay aligned whether or not an icon is present.
 */
function SectionStatusIcon({ status }: { status?: SectionStatusValue }) {
  return (
    <span className="flex h-3.5 items-center justify-center">
      {status === "FILLED" ? <Check className="h-3.5 w-3.5 text-success" aria-label="Filled" />
        : status === "NO_PLAN" ? <Ban className="h-3.5 w-3.5 text-noplan" aria-label="No Plan" />
          : null}
    </span>
  );
}

/**
 * Day-level actions rendered on the right of the Plan Type fieldset (no separate box): No Plan (active section) +
 * Save Draft (the active section's own flush, lifted via context) + Submit Daily Work. All three reuse the exact
 * existing handlers/state — No-Plan eligibility, autosave flush, and submission gating (`canSubmit`) are unchanged.
 */
function DailyWorkActions({ workDate, section, draft }: { workDate: string; section: Section; draft: SaveDraftHandle | null }) {
  const qc = useQueryClient();
  const { data } = useDailyStatus(workDate);
  const [error, setError] = useState<string | null>(null);
  const L = {
    submit: useLabel("daily_work.action.submit_day"),
    submitting: useLabel("daily_work.state.submitting"),
    saveDraft: useLabel("daily_work.action.save_draft"),
    saving: useLabel("daily_work.state.saving"),
  };
  const submitMut = useMutation({
    mutationFn: () => api.post("/api/daily-work/submit-day", { workDate }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ["daily-work"] }); qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); },
    onError: (e) => setError((e as Error).message),
  });
  if (!data || data.isFinalized) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SectionNoPlanButton workDate={workDate} section={section} />
        {/* Save Draft = the active section's own autosave flush (same handler/state), lifted here via context. */}
        <Button variant="outline" size="sm" disabled={!draft || draft.saving} onClick={() => { void draft?.flush(); }}>
          <Save className="h-4 w-4" /> {draft?.saving ? L.saving : L.saveDraft}
        </Button>
        <Button size="sm" disabled={!data.canSubmit || submitMut.isPending} onClick={() => { setError(null); submitMut.mutate(); }}>
          <Send className="h-4 w-4" /> {submitMut.isPending ? L.submitting : L.submit}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The existing single Daily Report submission action, rendered in the Plan Type toolbar. */
function DailyReportProgress({ workDate }: { workDate: string }) {
  const qc = useQueryClient();
  const { data } = useDailyStatus(workDate);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useLabel("daily_work.action.submit_report");
  const submitMut = useMutation({
    mutationFn: (selfRating: number) => api.post("/api/daily-work/submit-report", { workDate, selfRating }),
    onSuccess: () => { setError(null); setRatingOpen(false); qc.invalidateQueries({ queryKey: ["daily-work"] }); qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); },
    onError: (e) => setError((e as Error).message),
  });
  if (!data || data.isFinalized) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" disabled={!data.canSubmitReport || submitMut.isPending} onClick={() => { setError(null); setRatingOpen(true); }}>
        <Send className="h-4 w-4" /> {submit}
      </Button>
      {error && !ratingOpen && <p className="text-xs text-destructive">{error}</p>}
      {ratingOpen && <SelfRatingModal pending={submitMut.isPending} serverError={error} onCancel={() => { setError(null); setRatingOpen(false); }} onConfirm={(rating) => submitMut.mutate(rating)} />}
    </div>
  );
}

/**
 * Day-level Submit → Self Rating modal. The rating starts UNSET (no business default); the slider and numeric
 * input stay in sync; Confirm is disabled until a valid integer 1–10 is chosen. The server re-validates and
 * finalizes the submission + rating atomically, so this is a convenience gate, not the source of truth.
 */
function SelfRatingModal({ pending, serverError, onCancel, onConfirm }: {
  pending: boolean;
  serverError: string | null;
  onCancel: () => void;
  onConfirm: (rating: number) => void;
}) {
  const L = {
    title: useLabel("daily_work.rating.title"),
    prompt: useLabel("daily_work.rating.prompt"),
    field: useLabel("daily_work.rating.field"),
    placeholder: useLabel("daily_work.rating.placeholder"),
    cancel: useLabel("daily_work.action.cancel"),
    submit: useLabel("daily_work.action.submit_report"),
    submitting: useLabel("daily_work.state.submitting"),
    invalid: useLabel("daily_work.validation.rating_required"),
  };
  // Unset until the SO explicitly chooses. "" = nothing selected yet (never defaults to a business value).
  const [rating, setRating] = useState<number | "">("");
  const valid = typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 10;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{L.prompt}</p>
          <div className="text-center text-2xl font-semibold tabular-nums">
            {valid ? `${rating} / 10` : <span className="text-base font-normal text-muted-foreground">{L.placeholder}</span>}
          </div>
          {/* Slider (1–10). Until a value is chosen it sits at the low end but records no value. */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">1</span>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={typeof rating === "number" ? rating : 1}
              onChange={(e) => setRating(Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              aria-label={L.field}
            />
            <span className="text-xs text-muted-foreground">10</span>
          </div>
          <div className="space-y-1.5">
            <Label>{L.field}</Label>
            <Input
              type="number"
              min={1}
              max={10}
              step={1}
              inputMode="numeric"
              placeholder={L.placeholder}
              value={rating === "" ? "" : String(rating)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") { setRating(""); return; }
                const n = Number(v);
                setRating(Number.isFinite(n) ? n : "");
              }}
              className="w-24"
            />
          </div>
          {serverError && <p className="text-sm text-destructive">{serverError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>{L.cancel}</Button>
          <Button onClick={() => valid && onConfirm(rating as number)} disabled={!valid || pending}>
            <Send className="h-4 w-4" /> {pending ? L.submitting : L.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The active section's No Plan / Undo No Plan button (disabled when the section has data). Logic unchanged. */
function SectionNoPlanButton({ workDate, section }: { workDate: string; section: Section }) {
  const qc = useQueryClient();
  const { data } = useDailyStatus(workDate);
  const L = {
    markNoPlan: useLabel("daily_work.action.no_plan"),
    undoNoPlan: useLabel("daily_work.action.undo_no_plan"),
  };
  const info = data?.sections.find((s) => s.section === section);
  const mut = useMutation({
    mutationFn: (noPlan: boolean) => api.post("/api/daily-work/no-plan", { workDate, section, noPlan }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); },
    onError: (e) => alert((e as Error).message),
  });
  if (!info) return null;
  return info.status === "NO_PLAN" ? (
    <Button size="sm" variant="outline" disabled={mut.isPending} onClick={() => mut.mutate(false)}>{L.undoNoPlan}</Button>
  ) : (
    // No Plan is disabled once the section has real data (invariant: No Plan + data never coexist).
    <Button size="sm" variant="outline" disabled={mut.isPending || info.hasData} onClick={() => mut.mutate(true)}>{L.markNoPlan}</Button>
  );
}

/* ==================================== One section table ==================================== */

function DailyWorkSection({ section, workDate, view, locked }: { section: "SALES" | "RECOVERY"; workDate: string; view: DailyWorkViewType; locked: boolean }) {
  const qc = useQueryClient();
  const isSales = section === "SALES";

  const { data, isLoading } = useQuery<Payload>({
    queryKey: ["daily-work", section, workDate, view],
    queryFn: () => api.get<Payload>(`/api/daily-work?section=${section}&view=${view}`),
  });

  const [rows, setRows] = useState<EditRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [autoTaskDealerId, setAutoTaskDealerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const seedHydrationPendingRef = useRef(false);

  // Seed editable rows from the server payload (the current editable batch's draft).
  useEffect(() => {
    if (!data) return;
    setRows(
      data.dealers.map((d) => ({
        entryId: d.entryId, batchId: d.batchId,
        dealerId: d.dealerId, dealerName: d.dealerName, monthlyPlan: d.monthlyPlan, actual: d.actual, pending: d.pending,
        todaysPlan: d.todaysPlan == null ? "" : String(d.todaysPlan),
        entryType: d.entryType, schemeId: d.schemeId ?? "", paymentMode: d.paymentMode ?? null,
        todaysActual: d.todaysActual == null ? "" : String(d.todaysActual),
        status: d.status,
      })),
    );
    hydratedRef.current = false; // mark for re-hydration of the autosave baseline
    seedHydrationPendingRef.current = true;
  }, [data]);

  const salesSchemes = data?.applicableSchemes ?? [];
  const recoverySchemesByDealer = data?.applicableSchemesByDealer ?? {};
  const canEnterActual = data?.canEnterActual ?? false;

  const L = {
    dealer: useLabel("col.dealer"),
    dealers: useLabel("daily_work.count.dealers"),
    plan: useLabel(isSales ? "daily_work.col.monthly_sales_plan" : "daily_work.col.monthly_recovery_plan"),
    pending: useLabel("col.pending"),
    todaysPlan: useLabel("daily_work.col.todays_plan"),
    type: useLabel(isSales ? "daily_work.col.sales_type" : "daily_work.col.recovery_type"),
    paymentMode: useLabel("daily_work.col.payment_mode"),
    actual: useLabel(isSales ? "daily_work.col.todays_sales" : "daily_work.col.todays_recovery"),
    regular: useLabel("daily_work.type.regular"),
    scheme: useLabel("daily_work.type.scheme"),
    mixed: useLabel("daily_work.type.mixed"),
    none: useLabel("daily_work.combined.none"),
    addDealer: useLabel("daily_work.action.add_dealer"),
    chooseDealer: useLabel("daily_work.add_dealer.choose"),
    cancel: useLabel("daily_work.action.cancel"),
    removeDealer: useLabel("daily_work.action.remove_dealer"),
    saveDraft: useLabel("daily_work.action.save_draft"),
    saveActuals: useLabel("daily_work.action.save_actuals"),
    saving: useLabel("daily_work.state.saving"),
    selectDealer: useLabel("daily_work.placeholder.select_dealer"),
    noMoreDealers: useLabel("daily_work.placeholder.no_more_dealers"),
    selectScheme: useLabel("daily_work.placeholder.select_scheme"),
    noApplicableSchemes: useLabel("daily_work.placeholder.no_applicable_schemes"),
    empty: useLabel(isSales ? "daily_work.empty.sales" : "daily_work.empty.recovery"),
    noSubmittedSection: useLabel("daily_work.report.no_submitted_section"),
    reschedule: useLabel("cn_requests.task.rescheduled"),
    confirmAutoTask: useLabel("daily_work.action.confirm_auto_task"),
    autoTaskConfirmed: useLabel("daily_work.state.auto_task_confirmed"),
    taskType: useLabel("daily_work.col.task_type"),
    taskTypeAuto: useLabel("daily_work.task_type.auto"),
    taskTypeManual: useLabel("daily_work.task_type.manual"),
    taskTypeNone: useLabel("daily_work.combined.none"),
  };

  const showResults = dailyWorkShowsResults(view);
  const visibleRows = useMemo(
    () => visibleDailyWorkRows(rows, view, (row) => row.status !== "DRAFT" && row.status !== "NEW"),
    [rows, view],
  );

  // Dealers available to add = scoped dealers not already in a row.
  const usedIds = new Set(rows.map((r) => r.dealerId));
  const available = (data?.availableDealers ?? []).filter((d) => !usedIds.has(d.id));

  // Combined summary — ALWAYS derived from the current dealer rows.
  const combined = useMemo(() => {
    const src: DailyWorkDealerRow[] = visibleRows.map((r) => ({
      monthlyPlan: r.monthlyPlan, actual: r.actual, pending: r.pending, todaysPlan: numOr0(r.todaysPlan),
      todaysActual: numOr0(r.todaysActual), type: r.entryType,
    }));
    return combineDailyWorkRows(src, { dealer: L.dealer, dealers: L.dealers });
  }, [visibleRows, L.dealer, L.dealers]);

  // Task Type (Daily Plan only) — a row is an Auto Task iff it carries a materialized Auto Task contribution
  // (the existing CN → DailyWorkEntry link exposed as materializedCnTasks). Sales never has an Auto Task source.
  const showTaskType = view === DailyWorkView.PLAN;
  const autoDealerIds = useMemo(() => new Set((data?.materializedCnTasks ?? []).map((t) => t.dealerId)), [data?.materializedCnTasks]);
  const rowTaskTypeOf = (dealerId: string): TaskType => rowTaskType(autoDealerIds.has(dealerId));
  const taskTypeL: TaskTypeLabels = { auto: L.taskTypeAuto, manual: L.taskTypeManual, none: L.taskTypeNone };

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["daily-work", section, workDate] }); qc.invalidateQueries({ queryKey: ["daily-work-status", workDate] }); };
  const payloadRows = () => rows.map((r) => ({ dealerId: r.dealerId, todaysPlan: r.todaysPlan.trim() === "" ? undefined : numOr0(r.todaysPlan), entryType: r.entryType, schemeId: r.entryType === "SCHEME" ? r.schemeId || null : null, ...(!isSales ? { paymentMode: r.paymentMode } : {}) }));

  // AUTOSAVE — persist the current Daily Plan draft through the existing section save endpoint (current editable
  // batch, same authorization). Status is refreshed so the progress bar tracks saved data; section rows are NOT
  // refetched, so in-progress edits are never clobbered mid-typing.
  const draftKey = JSON.stringify(payloadRows());
  const autosave = useDailyAutosave(draftKey, view === DailyWorkView.PLAN && !locked, async () => {
    await api.post("/api/daily-work/save", { section, workDate, rows: payloadRows() });
    setError(null);
    qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) });
  }, { onConflict: () => { qc.invalidateQueries({ queryKey: ["daily-work", section, workDate] }); qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); } });
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    // Wait for the server payload to seed local rows before establishing the persisted baseline. Otherwise the
    // pre-load empty editor is treated as the baseline and loading existing rows looks like a user edit.
    if (seedHydrationPendingRef.current) { seedHydrationPendingRef.current = false; return; }
    autosave.hydrate(draftKey);
    hydratedRef.current = true;
  }, [data, draftKey, autosave]);
  // Publish this section's Save Draft (its own autosave flush/state) to the Plan Type toolbar.
  useRegisterSaveDraft(view === DailyWorkView.PLAN && !locked, { flush: autosave.flush, saving: autosave.saving, failed: autosave.failed, savedAt: autosave.savedAt });

  const actualMut = useMutation({
    mutationFn: () => api.post("/api/daily-work/actual", { section, workDate, entries: visibleRows.filter((r) => r.todaysActual.trim() !== "").map((r) => ({ entryId: r.entryId, todaysActual: numOr0(r.todaysActual) })) }),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  // Explicit Auto Task confirmation. Confirms every still-unconfirmed materialized task for the dealer row in one
  // click; each call is server-idempotent and never completes the underlying payment task.
  const confirmMut = useMutation({
    mutationFn: async (tasks: CnTask[]) => {
      for (const task of tasks) {
        await api.post(`/api/cn-requests/${task.cnRequestId}/confirm-task`, { taskId: task.taskId ?? undefined });
      }
    },
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  const busy = actualMut.isPending || confirmMut.isPending;

  const update = (i: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updateEntry = (entryId: string, patch: Partial<EditRow>) => setRows((rs) => rs.map((r) => (r.entryId === entryId ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const addDealer = (dealerId: string) => {
    const d = available.find((x) => x.id === dealerId);
    if (!d) return;
    setRows((rs) => [...rs, { entryId: `new-${d.id}`, batchId: "", dealerId: d.id, dealerName: d.name, monthlyPlan: d.monthlyPlan, actual: d.actual, pending: d.pending, todaysPlan: "", entryType: "REGULAR", schemeId: "", paymentMode: null, todaysActual: "", status: "NEW" }]);
  };

  const columnCount = 5 + (isSales ? 0 : 1) + (showResults ? 1 : 0) + (showTaskType ? 1 : 0) + (view === DailyWorkView.PLAN ? 1 : 0);
  const compactRecovery = !isSales && view === DailyWorkView.PLAN;

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-4">
      <div className="overflow-auto rounded-lg border bg-background">
        <Table className={cn("table-fixed", compactRecovery
          ? "min-w-[928px] [&_th]:w-auto [&_th]:px-2 [&_input]:ml-auto [&_input]:w-28 [&_select]:w-28"
          : isSales ? (showResults ? "min-w-[1008px]" : "min-w-[928px]") : (showResults ? "min-w-[1152px]" : "min-w-[1072px]"))}>
          {/* Recovery Plan: Dealer absorbs the remaining width; all three row layers share these columns. */}
          {compactRecovery && <colgroup>
            <col />
            <col className="w-[72px]" />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-[120px]" />
            <col className="w-[120px]" />
            <col className="w-[120px]" />
            <col className="w-28" />
          </colgroup>}
          <TableHeader>
            <TableRow>
              <TableHead className="w-60">{L.dealer}</TableHead>
              {showTaskType && <TableHead className="w-32">{L.taskType}</TableHead>}
              <TableHead className="w-44 text-right">{isSales ? L.plan : <MonthlyRecoveryPlanHeader label={L.plan} />}</TableHead>
              <TableHead className="w-32 text-right">{L.pending}</TableHead>
              <TableHead className="w-36 text-right">{L.todaysPlan}</TableHead>
              {!isSales && <TableHead className="w-36">{L.paymentMode}</TableHead>}
              <TableHead className="w-44">{L.type}</TableHead>
              {showResults && <TableHead className="w-36 text-right">{L.actual}</TableHead>}
              {view === DailyWorkView.PLAN && <TableHead className="w-16" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* COMBINED SUMMARY ROW — derived from dealer rows, visually distinct, non-editable. */}
            <TableRow className="border-b-2 bg-muted/40 font-semibold">
              <TableCell>{combined.dealerLabel}</TableCell>
              {showTaskType && <TableCell>{L.none}</TableCell>}
              <TableCell className="text-right tabular-nums">{money(combined.monthlyPlan)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(combined.pending)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(combined.todaysPlan)}</TableCell>
              {!isSales && <TableCell>{L.none}</TableCell>}
              <TableCell>{L.none}</TableCell>
              {showResults && <TableCell className="text-right tabular-nums">{money(combined.todaysActual)}</TableCell>}
              {view === DailyWorkView.PLAN && <TableCell />}
            </TableRow>

            {visibleRows.length === 0 ? (
              <TableRow><TableCell colSpan={columnCount} className="py-8 text-center text-muted-foreground">{showResults ? L.noSubmittedSection : L.empty}</TableCell></TableRow>
            ) : (
              visibleRows.map((r, i) => {
                const submitted = r.status !== "DRAFT" && r.status !== "NEW";
                const schemes = isSales ? salesSchemes : (recoverySchemesByDealer[r.dealerId] ?? []);
                const typeOptions = isSales || schemes.length > 0 || r.entryType === "SCHEME"
                  ? [{ value: "REGULAR", label: L.regular }, { value: "SCHEME", label: L.scheme }]
                  : [{ value: "REGULAR", label: L.regular }];
                const rowAutoTasks = (data?.materializedCnTasks ?? []).filter((task) => task.dealerId === r.dealerId);
                return (
                  <TableRow data-dealer-id={r.dealerId} key={r.entryId}>
                    <TableCell className={cn("font-medium", compactRecovery && "break-words")}><DealerName id={r.dealerId} name={r.dealerName} /></TableCell>
                    {/* Task Type — derived from the authoritative Auto Task contribution link (Daily Plan only). */}
                    {showTaskType && <TableCell>{taskTypeText(rowTaskTypeOf(r.dealerId), taskTypeL)}</TableCell>}
                    {/* Monthly plan + pending are SOURCED and non-editable. */}
                    <TableCell className="text-right tabular-nums">{money(r.monthlyPlan)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.pending)}</TableCell>
                    {/* Today's Plan — editable until submitted. */}
                    <TableCell className="p-1 text-right">
                      <Input type="number" min={0} className="h-8 w-full text-right" placeholder="0" value={r.todaysPlan} disabled={busy || submitted} onChange={(e) => update(i, { todaysPlan: e.target.value })} />
                    </TableCell>
                    {!isSales && <TableCell className="p-1">
                      <RecoveryPaymentModeField
                        value={r.paymentMode}
                        disabled={busy || locked}
                        onChange={submitted ? undefined : (paymentMode) => update(i, { paymentMode })}
                      />
                    </TableCell>}
                    {/* Scheme Recovery uses the dealer's existing enrolled/verified scheme-payment scope. */}
                    <TableCell className="p-1">
                      <div className="flex flex-col gap-1">
                        <NativeSelect
                          className="h-8 w-full"
                          disabled={busy || submitted}
                          value={r.entryType}
                          options={typeOptions}
                          onChange={(e) => update(i, { entryType: e.target.value as DailyWorkType, schemeId: e.target.value === "SCHEME" && schemes.length === 1 ? schemes[0].id : "" })}
                        />
                        {r.entryType === "SCHEME" && (
                          schemes.length === 0 ? (
                            <span className="text-[11px] text-destructive">{L.noApplicableSchemes}</span>
                          ) : (
                            <NativeSelect
                              className="h-8 w-full"
                              disabled={busy || submitted}
                              placeholder={L.selectScheme}
                              value={r.schemeId}
                              options={schemes.map((s) => ({ value: s.id, label: s.name }))}
                              onChange={(e) => update(i, { schemeId: e.target.value })}
                            />
                          )
                        )}
                      </div>
                    </TableCell>
                    {/* Today's Sales/Recovery belongs to Daily Report and remains post-submit only. */}
                    {showResults && <TableCell className="p-1 text-right">
                      <Input type="number" min={0} className="h-8 w-full text-right" placeholder="0" value={r.todaysActual} disabled={busy || locked} onChange={(e) => updateEntry(r.entryId, { todaysActual: e.target.value })} />
                    </TableCell>}
                    {view === DailyWorkView.PLAN && <TableCell className="text-right">
                      {!submitted && (
                        <div className={cn("flex items-center justify-end gap-1", compactRecovery && "flex-wrap")}>
                          {!isSales && rowAutoTasks.length > 0 && (() => {
                            const unconfirmed = rowAutoTasks.filter((task) => !task.confirmed);
                            return unconfirmed.length > 0 ? (
                              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={() => confirmMut.mutate(unconfirmed)}>
                                <Check className="h-3.5 w-3.5" /> {L.confirmAutoTask}
                              </Button>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                                <Check className="h-3.5 w-3.5" /> {L.autoTaskConfirmed}
                              </span>
                            );
                          })()}
                          {!isSales && rowAutoTasks.length > 0 && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAutoTaskDealerId(r.dealerId)} title={L.reschedule} aria-label={L.reschedule}>
                              <CalendarClock className="h-4 w-4" />
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => removeRow(i)} title={L.removeDealer} aria-label={L.removeDealer}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      )}
                    </TableCell>}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        {/* Add Dealer lives INSIDE the dealer container, below the rows, left-aligned (Scheme Planning pattern).
            Dealers are added one at a time through the modal — no permanent dropdown. */}
        {view === DailyWorkView.PLAN && (
          <div className="border-t p-3">
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)} disabled={busy || locked}><Plus className="h-4 w-4" /> {L.addDealer}</Button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Save Draft moved to the Plan Type toolbar (via useRegisterSaveDraft). Today's-actuals stays here (Report). */}
      {view === DailyWorkView.REPORT && canEnterActual && visibleRows.length > 0 && (
        <div className="flex justify-end">
          <Button variant="default" onClick={() => { setError(null); actualMut.mutate(); }} disabled={busy || locked}>
            {actualMut.isPending ? L.saving : L.saveActuals}
          </Button>
        </div>
      )}

      {addOpen && (
        <AddDealerDialog
          available={available}
          labels={{ title: L.addDealer, choose: L.chooseDealer, select: L.selectDealer, noMore: L.noMoreDealers, cancel: L.cancel, add: L.addDealer }}
          onAdd={(id) => { addDealer(id); setAddOpen(false); }}
          onClose={() => setAddOpen(false)}
        />
      )}
      {autoTaskDealerId && (
        <MaterializedTaskRescheduleDialog
          tasks={(data?.materializedCnTasks ?? []).filter((task) => task.dealerId === autoTaskDealerId)}
          onChanged={() => { setAutoTaskDealerId(null); invalidate(); qc.invalidateQueries({ queryKey: ["cn-tasks-pending"] }); }}
          onClose={() => setAutoTaskDealerId(null)}
        />
      )}
    </div>
  );
}

/**
 * Post-materialization reschedule dialog. Selecting a date only updates the PENDING date held in local state —
 * it never mutates the server. The reschedule (which reverses this task's contribution and moves it to the new
 * date) is applied ONLY when the SO clicks "Confirm Reschedule", and only for tasks whose date actually changed.
 * The server (scheduleCnTask) remains authoritative for ownership, expiry, Sunday and finalized-day validation.
 */
function MaterializedTaskRescheduleDialog({ tasks, onChanged, onClose }: { tasks: CnTask[]; onChanged: () => void; onClose: () => void }) {
  const L = {
    title: useLabel("daily_work.container.cn_tasks"),
    dealer: useLabel("cn_requests.task.dealer"),
    amount: useLabel("cn_requests.task.amount"),
    taskDate: useLabel("cn_requests.task.task_date"),
    close: useLabel("daily_work.action.cancel"),
    confirmReschedule: useLabel("daily_work.action.confirm_reschedule"),
    sundayInvalid: useLabel("cn_requests.validation.task_date_sunday"),
  };
  const taskKey = (task: CnTask) => task.taskId ?? task.cnRequestId;
  // Pending (unsaved) date per task, seeded from the current server date. Never written to the server on change.
  const [pendingDates, setPendingDates] = useState<Record<string, string>>(
    () => Object.fromEntries(tasks.map((task) => [taskKey(task), task.taskDate ?? ""])),
  );
  const scheduleMut = useMutation({
    mutationFn: async () => {
      // Apply only the tasks whose pending date differs from their current date, sequentially (each reschedule
      // re-locks the shared Recovery row). Sunday selections are rejected client-side for UX; the server re-checks.
      const changed = tasks.filter((task) => {
        const next = pendingDates[taskKey(task)];
        return next && next !== (task.taskDate ?? "");
      });
      for (const task of changed) {
        const next = pendingDates[taskKey(task)];
        if (isCnSundayDateKey(next)) throw new Error(L.sundayInvalid);
        await api.post(`/api/cn-requests/${task.cnRequestId}/task-date`, { taskId: task.taskId ?? undefined, taskDate: next });
      }
    },
    onSuccess: onChanged,
    onError: (error) => alert((error as Error).message),
  });
  const today = currentBusinessDate();
  // Confirm is enabled only when at least one task has a valid, non-Sunday, changed date (equal dates = no-op).
  const hasValidChange = tasks.some((task) => {
    const next = pendingDates[taskKey(task)];
    return !!next && next !== (task.taskDate ?? "") && !isCnSundayDateKey(next);
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{L.title}</DialogTitle></DialogHeader>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>{L.dealer}</TableHead><TableHead className="text-right">{L.amount}</TableHead><TableHead>{L.taskDate}</TableHead></TableRow></TableHeader>
            <TableBody>{tasks.map((task) => (
              <TableRow data-dealer-id={task.dealerId} key={taskKey(task)}>
                <TableCell><DealerName id={task.dealerId} name={task.partyName} /></TableCell>
                <TableCell className="text-right tabular-nums">{task.recoveryAmount == null ? "—" : money(task.recoveryAmount)}</TableCell>
                <TableCell><Input
                  aria-label={`${L.taskDate} — ${task.partyName}`}
                  type="date" className="h-8 w-40" min={task.acceptanceDate ?? undefined} max={task.expiryDate ?? undefined}
                  value={pendingDates[taskKey(task)] ?? ""} disabled={scheduleMut.isPending || (task.expiryDate != null && today > task.expiryDate)}
                  onChange={(event) => {
                    // Update the pending date only — NO server mutation here.
                    const next = event.target.value;
                    setPendingDates((prev) => ({ ...prev, [taskKey(task)]: next }));
                  }}
                /></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={scheduleMut.isPending}>{L.close}</Button>
          <Button onClick={() => scheduleMut.mutate()} disabled={scheduleMut.isPending || !hasValidChange}>{L.confirmReschedule}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add Dealer modal — mirrors the Scheme Planning "Choose Dealer" interaction. The dealer dropdown lives here,
 * not on the page; dealers are added one at a time and the caller keeps the button available for the next one.
 * Options are the section's existing `available` dealers (scoped, already-added excluded) — no new data source.
 */
function AddDealerDialog({ available, labels, onAdd, onClose }: {
  available: { id: string; name: string }[];
  labels: { title: string; choose: string; select: string; noMore: string; cancel: string; add: string };
  onAdd: (dealerId: string) => void;
  onClose: () => void;
}) {
  const [dealerId, setDealerId] = useState("");
  const chosen = available.find((d) => d.id === dealerId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{labels.title}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label>{labels.choose}</Label>
          <NativeSelect
            placeholder={available.length === 0 ? labels.noMore : labels.select}
            disabled={available.length === 0}
            value={dealerId}
            onChange={(e) => setDealerId(e.target.value)}
            dealerOptions options={available.map((d) => ({ value: d.id, label: d.name }))}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{labels.cancel}</Button>
          <Button disabled={!chosen} onClick={() => chosen && onAdd(chosen.id)}>{labels.add}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ==================================== SECTION 3 — Dealer Appointment ==================================== */

interface ApptRowDto { entryId: string; batchId: string; rowId: string; dealerName: string; marketName: string; monthlyPlan: null; pending: null; status: "APPOINTED" | "NOT_APPOINTED" | null; rowStatus: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" }
interface ApptPayload { section: "APPOINTMENT"; workDate: string; canEnterStatus: boolean; rows: ApptRowDto[] }
interface ApptEditRow { entryId: string; batchId: string; rowId: string; dealerName: string; marketName: string; status: "APPOINTED" | "NOT_APPOINTED" | ""; rowStatus: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" | "NEW" }

let apptSeq = 0;
const newApptRow = (): ApptEditRow => { const rowId = `new-${Date.now()}-${apptSeq++}`; return { entryId: rowId, batchId: "", rowId, dealerName: "", marketName: "", status: "", rowStatus: "NEW" }; };

function AppointmentSection({ workDate, view, locked }: { workDate: string; view: DailyWorkViewType; locked: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ApptPayload>({
    queryKey: ["daily-work", "APPOINTMENT", workDate, view],
    queryFn: () => api.get<ApptPayload>(`/api/daily-work?section=APPOINTMENT&view=${view}`),
  });

  const [rows, setRows] = useState<ApptEditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const seedHydrationPendingRef = useRef(false);
  useEffect(() => {
    if (!data) return;
    setRows(data.rows.length > 0
      ? data.rows.map((r) => ({ entryId: r.entryId, batchId: r.batchId, rowId: r.rowId, dealerName: r.dealerName, marketName: r.marketName, status: r.status ?? "", rowStatus: r.rowStatus }))
      : [newApptRow()]);
    hydratedRef.current = false;
    seedHydrationPendingRef.current = true;
  }, [data]);

  const canEnterStatus = data?.canEnterStatus ?? false;
  const L = {
    dealer: useLabel("col.dealer"), dealers: useLabel("daily_work.count.dealers"),
    market: useLabel("daily_work.col.market"), markets: useLabel("daily_work.count.markets"),
    plan: useLabel("daily_work.col.monthly_dealer_plan"), pending: useLabel("col.pending"),
    work: useLabel("daily_work.col.todays_appointment"), status: useLabel("daily_work.col.appointment_status"),
    appointed: useLabel("daily_work.status.appointed"), notAppointed: useLabel("daily_work.status.not_appointed"),
    addRow: useLabel("daily_work.action.add_row"), saveDraft: useLabel("daily_work.action.save_draft"),
    saveActuals: useLabel("daily_work.action.save_actuals"),
    multiple: useLabel("daily_work.combined.multiple"), none: useLabel("daily_work.combined.none"),
    removeRow: useLabel("daily_work.action.remove_row"), saving: useLabel("daily_work.state.saving"),
    dealerName: useLabel("daily_work.placeholder.dealer_name"),
    marketPlaceholder: useLabel("daily_work.placeholder.market"), selectStatus: useLabel("daily_work.placeholder.select_status"),
    noSubmittedSection: useLabel("daily_work.report.no_submitted_section"),
    taskType: useLabel("daily_work.col.task_type"),
    taskTypeAuto: useLabel("daily_work.task_type.auto"), taskTypeManual: useLabel("daily_work.task_type.manual"),
  };

  const showResults = dailyWorkShowsResults(view);
  const showTaskType = view === DailyWorkView.PLAN;
  const visibleRows = useMemo(
    () => visibleDailyWorkRows(rows, view, (row) => row.rowStatus !== "DRAFT" && row.rowStatus !== "NEW"),
    [rows, view],
  );

  const combined = useMemo(() => {
    const src: AppointmentRow[] = visibleRows.map((r) => ({ marketName: r.marketName, status: r.status === "" ? null : r.status }));
    return combineAppointmentRows(src, { dealer: L.dealer, dealers: L.dealers, market: L.market, markets: L.markets });
  }, [visibleRows, L.dealer, L.dealers, L.market, L.markets]);

  // Dealer Appointment has no Auto Task source, so every row is Manual (derived, not fabricated).
  const taskTypeL: TaskTypeLabels = { auto: L.taskTypeAuto, manual: L.taskTypeManual, none: L.none };

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["daily-work", "APPOINTMENT", workDate] }); qc.invalidateQueries({ queryKey: ["daily-work-status", workDate] }); };
  const payloadRows = () => rows.filter((r) => r.dealerName.trim() !== "").map((r) => ({ rowId: r.rowId, dealerName: r.dealerName, marketName: r.marketName }));

  const draftKey = JSON.stringify(payloadRows());
  const autosave = useDailyAutosave(draftKey, view === DailyWorkView.PLAN && !locked, async () => {
    await api.post("/api/daily-work/save", { section: "APPOINTMENT", workDate, rows: payloadRows() });
    setError(null);
    qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) });
  }, { onConflict: () => { qc.invalidateQueries({ queryKey: ["daily-work", "APPOINTMENT", workDate] }); qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); } });
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    if (seedHydrationPendingRef.current) { seedHydrationPendingRef.current = false; return; }
    autosave.hydrate(draftKey);
    hydratedRef.current = true;
  }, [data, draftKey, autosave]);
  useRegisterSaveDraft(view === DailyWorkView.PLAN && !locked, { flush: autosave.flush, saving: autosave.saving, failed: autosave.failed, savedAt: autosave.savedAt });
  const statusMut = useMutation({
    mutationFn: () => api.post("/api/daily-work/actual", { section: "APPOINTMENT", workDate, entries: visibleRows.filter((r) => r.status !== "").map((r) => ({ entryId: r.entryId, status: r.status })) }),
    onSuccess: () => { setError(null); invalidate(); }, onError: (e) => setError((e as Error).message),
  });
  const busy = statusMut.isPending;

  const update = (i: number, patch: Partial<ApptEditRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updateRow = (entryId: string, patch: Partial<ApptEditRow>) => setRows((rs) => rs.map((r) => (r.entryId === entryId ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, newApptRow()]);
  const removeRow = (i: number) => setRows((rs) => (rs.length <= 1 ? [newApptRow()] : rs.filter((_, j) => j !== i)));
  if (isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-4">
      <div className="overflow-auto rounded-lg border bg-background">
        <Table className={cn("table-fixed", showResults ? "min-w-[1024px]" : "min-w-[912px]")}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-52">{L.dealer}</TableHead>
              {showTaskType && <TableHead className="w-32">{L.taskType}</TableHead>}
              <TableHead className="w-44">{L.market}</TableHead>
              <TableHead className="w-44 text-right">{L.plan}</TableHead>
              <TableHead className="w-32 text-right">{L.pending}</TableHead>
              <TableHead className="w-40">{L.work}</TableHead>
              {showResults && <TableHead className="w-44">{L.status}</TableHead>}
              {view === DailyWorkView.PLAN && <TableHead className="w-16" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Combined summary — dealer count plus numeric aggregates; dealer-level values stay neutral. */}
            <TableRow className="border-b-2 bg-muted/40 font-semibold">
              <TableCell>{combined.dealerLabel}</TableCell>
              {showTaskType && <TableCell>{L.none}</TableCell>}
              <TableCell>{L.none}</TableCell>
              <TableCell className="text-right text-muted-foreground">{L.none}</TableCell>
              <TableCell className="text-right text-muted-foreground">{L.none}</TableCell>
              <TableCell>{L.none}</TableCell>
              {showResults && <TableCell>{L.none}</TableCell>}
              {view === DailyWorkView.PLAN && <TableCell />}
            </TableRow>

            {visibleRows.length === 0 ? (
              <TableRow><TableCell colSpan={5 + (showResults ? 1 : 0) + (showTaskType ? 1 : 0) + (view === DailyWorkView.PLAN ? 1 : 0)} className="py-8 text-center text-muted-foreground">{showResults ? L.noSubmittedSection : L.none}</TableCell></TableRow>
            ) : visibleRows.map((r, i) => {
              const submitted = r.rowStatus !== "DRAFT" && r.rowStatus !== "NEW";
              return (
                <TableRow key={r.entryId}>
                  <TableCell className="p-1"><Input className="h-8 w-full" placeholder={L.dealerName} value={r.dealerName} disabled={busy || submitted} onChange={(e) => update(i, { dealerName: e.target.value })} /></TableCell>
                  {/* Task Type — Dealer Appointment has no Auto Task source, so rows are Manual. */}
                  {showTaskType && <TableCell>{taskTypeText(rowTaskType(false), taskTypeL)}</TableCell>}
                  <TableCell className="p-1"><Input className="h-8 w-full" placeholder={L.marketPlaceholder} value={r.marketName} disabled={busy || submitted} onChange={(e) => update(i, { marketName: e.target.value })} /></TableCell>
                  {/* Monthly Dealer Plan + Pending — placeholders (Dealer Planning not built yet). */}
                  <TableCell className="text-right text-muted-foreground">{L.none}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{L.none}</TableCell>
                  <TableCell className="text-muted-foreground">{L.none}</TableCell>
                  {/* Appointment result belongs to Daily Report and remains post-submit only. */}
                  {showResults && <TableCell className="p-1">
                    <NativeSelect
                      className="h-8 w-full"
                      disabled={busy || locked}
                      placeholder={L.selectStatus}
                      value={r.status}
                      options={[{ value: "APPOINTED", label: L.appointed }, { value: "NOT_APPOINTED", label: L.notAppointed }]}
                      onChange={(e) => updateRow(r.entryId, { status: e.target.value as ApptEditRow["status"] })}
                    />
                  </TableCell>}
                  {view === DailyWorkView.PLAN && <TableCell className="text-right">
                    {!submitted && <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => removeRow(i)} title={L.removeRow} aria-label={L.removeRow}><Trash2 className="h-4 w-4" /></Button>}
                  </TableCell>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Save Draft moved to the Plan Type toolbar; Add Row stays here for PLAN, Save Actuals for Report. */}
      {view === DailyWorkView.PLAN ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={addRow} disabled={busy || locked}><Plus className="h-4 w-4" /> {L.addRow}</Button>
        </div>
      ) : canEnterStatus && visibleRows.length > 0 ? (
        <div className="flex justify-end">
          <Button onClick={() => { setError(null); statusMut.mutate(); }} disabled={busy || locked}>{statusMut.isPending ? L.saving : L.saveActuals}</Button>
        </div>
      ) : null}
    </div>
  );
}

/* ==================================== SECTION 4 — Scheme Conversion ==================================== */

interface PlannedScheme { schemeId: string; schemeName: string; plannedUnits: number; convertedUnits: number; pending: number }
interface ConvRowDto { entryId: string; batchId: string; dealerId: string; dealerName: string; schemeId: string; schemeName: string; plannedUnits: number; convertedUnits: number; pending: number; todaysPlan: number | null; achievability: "YES" | "NO" | null; rowStatus: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" }
interface ConvDealerOption { dealerId: string; dealerName: string; schemes: PlannedScheme[] }
interface ConvPayload { section: "SCHEME_CONVERSION"; workDate: string; canEnterAchievability: boolean; availableDealers: ConvDealerOption[]; rows: ConvRowDto[] }
interface ConvEditRow { entryId: string; batchId: string; dealerId: string; dealerName: string; schemeId: string; schemeName: string; plannedUnits: number; pending: number; todaysPlan: string; achievability: "YES" | "NO" | ""; rowStatus: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" | "NEW"; schemeOptions: PlannedScheme[] }

function ConversionSection({ workDate, view, locked }: { workDate: string; view: DailyWorkViewType; locked: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ConvPayload>({
    queryKey: ["daily-work", "SCHEME_CONVERSION", workDate, view],
    queryFn: () => api.get<ConvPayload>(`/api/daily-work?section=SCHEME_CONVERSION&view=${view}`),
  });

  const [rows, setRows] = useState<ConvEditRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const seedHydrationPendingRef = useRef(false);
  useEffect(() => {
    if (!data) return;
    setRows(data.rows.map((r) => ({
      entryId: r.entryId, batchId: r.batchId,
      dealerId: r.dealerId, dealerName: r.dealerName, schemeId: r.schemeId, schemeName: r.schemeName,
      plannedUnits: r.plannedUnits, pending: r.pending, todaysPlan: r.todaysPlan == null ? "" : String(r.todaysPlan),
      achievability: r.achievability ?? "", rowStatus: r.rowStatus, schemeOptions: [],
    })));
    hydratedRef.current = false;
    seedHydrationPendingRef.current = true;
  }, [data]);

  const available = data?.availableDealers ?? [];
  const canEnterAch = data?.canEnterAchievability ?? false;
  const L = {
    dealer: useLabel("col.dealer"), dealers: useLabel("daily_work.count.dealers"), scheme: useLabel("daily_work.col.scheme"),
    planned: useLabel("daily_work.col.planned_scheme_units"), pending: useLabel("col.pending"),
    todaysPlan: useLabel("daily_work.col.todays_plan"), conversion: useLabel("daily_work.col.todays_conversion"),
    yes: useLabel("daily_work.achievability.yes"), no: useLabel("daily_work.achievability.no"),
    addDealer: useLabel("daily_work.action.add_dealer"), saveDraft: useLabel("daily_work.action.save_draft"),
    chooseDealer: useLabel("daily_work.add_dealer.choose"), cancel: useLabel("daily_work.action.cancel"),
    saveActuals: useLabel("daily_work.action.save_actuals"),
    multiple: useLabel("daily_work.combined.multiple"), none: useLabel("daily_work.combined.none"),
    removeRow: useLabel("daily_work.action.remove_row"), saving: useLabel("daily_work.state.saving"),
    selectScheme: useLabel("daily_work.placeholder.select_scheme"),
    selectAchievability: useLabel("daily_work.placeholder.select_achievability"), selectDealer: useLabel("daily_work.placeholder.select_dealer"),
    noPlannedSchemeDealers: useLabel("daily_work.placeholder.no_planned_scheme_dealers"),
    empty: useLabel("daily_work.empty.scheme_conversion"),
    noSubmittedSection: useLabel("daily_work.report.no_submitted_section"),
    taskType: useLabel("daily_work.col.task_type"),
    taskTypeAuto: useLabel("daily_work.task_type.auto"), taskTypeManual: useLabel("daily_work.task_type.manual"),
  };

  const showResults = dailyWorkShowsResults(view);
  const showTaskType = view === DailyWorkView.PLAN;
  const visibleRows = useMemo(
    () => visibleDailyWorkRows(rows, view, (row) => row.rowStatus !== "DRAFT" && row.rowStatus !== "NEW"),
    [rows, view],
  );

  const combined = useMemo(() => {
    const src: ConversionRow[] = visibleRows.map((r) => ({ schemeId: r.schemeId || null, plannedUnits: r.plannedUnits, pending: r.pending, todaysPlan: numOr0(r.todaysPlan), achievability: r.achievability === "" ? null : r.achievability }));
    return combineConversionRows(src, { dealer: L.dealer, dealers: L.dealers });
  }, [visibleRows, L.dealer, L.dealers]);

  // Scheme Conversion has no Auto Task source, so every row is Manual (derived, not fabricated).
  const taskTypeL: TaskTypeLabels = { auto: L.taskTypeAuto, manual: L.taskTypeManual, none: L.none };

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["daily-work", "SCHEME_CONVERSION", workDate] }); qc.invalidateQueries({ queryKey: ["daily-work-status", workDate] }); };
  const payloadRows = () => rows.map((r) => ({ dealerId: r.dealerId, schemeId: r.schemeId, todaysPlan: numOr0(r.todaysPlan) }));

  const draftKey = JSON.stringify(payloadRows());
  const autosave = useDailyAutosave(draftKey, view === DailyWorkView.PLAN && !locked, async () => {
    await api.post("/api/daily-work/save", { section: "SCHEME_CONVERSION", workDate, rows: payloadRows() });
    setError(null);
    qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) });
  }, { onConflict: () => { qc.invalidateQueries({ queryKey: ["daily-work", "SCHEME_CONVERSION", workDate] }); qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); } });
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    if (seedHydrationPendingRef.current) { seedHydrationPendingRef.current = false; return; }
    autosave.hydrate(draftKey);
    hydratedRef.current = true;
  }, [data, draftKey, autosave]);
  useRegisterSaveDraft(view === DailyWorkView.PLAN && !locked, { flush: autosave.flush, saving: autosave.saving, failed: autosave.failed, savedAt: autosave.savedAt });
  const achMut = useMutation({
    mutationFn: () => api.post("/api/daily-work/actual", { section: "SCHEME_CONVERSION", workDate, entries: visibleRows.filter((r) => r.achievability !== "").map((r) => ({ entryId: r.entryId, achievability: r.achievability })) }),
    onSuccess: () => { setError(null); invalidate(); }, onError: (e) => setError((e as Error).message),
  });
  const busy = achMut.isPending;

  const update = (i: number, patch: Partial<ConvEditRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updateResult = (entryId: string, patch: Partial<ConvEditRow>) => setRows((rs) => rs.map((r) => (r.entryId === entryId ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  // Adding a dealer: CASE 1 (one planned scheme → auto-add that row); CASE 2 (many → add a row per pick via the scheme select).
  const addDealer = (dealerId: string) => {
    const d = available.find((x) => x.dealerId === dealerId);
    if (!d || d.schemes.length === 0) return;
    // Only offer schemes not already added for this dealer in the current editor.
    const usedForDealer = new Set(rows.filter((r) => r.dealerId === d.dealerId).map((r) => r.schemeId));
    const remaining = d.schemes.filter((s) => !usedForDealer.has(s.schemeId));
    if (remaining.length === 0) return;
    const first = remaining[0];
    const preset = remaining.length === 1; // exactly one applicable → preselect it
    setRows((rs) => [...rs, {
      entryId: `new-${crypto.randomUUID()}`, batchId: "",
      dealerId: d.dealerId, dealerName: d.dealerName,
      schemeId: preset ? first.schemeId : "", schemeName: preset ? first.schemeName : "",
      plannedUnits: preset ? first.plannedUnits : 0, pending: preset ? first.pending : 0,
      todaysPlan: "", achievability: "", rowStatus: "NEW", schemeOptions: remaining,
    }]);
  };
  const pickScheme = (i: number, schemeId: string) => {
    setRows((rs) => rs.map((r, j) => {
      if (j !== i) return r;
      const s = r.schemeOptions.find((x) => x.schemeId === schemeId);
      return s ? { ...r, schemeId: s.schemeId, schemeName: s.schemeName, plannedUnits: s.plannedUnits, pending: s.pending, todaysPlan: "" } : { ...r, schemeId: "", plannedUnits: 0, pending: 0 };
    }));
  };
  // Today's Plan options 1..N capped at pending (spec: 1–6, never exceeding Pending).
  const planOptions = (pending: number) => Array.from({ length: Math.min(6, Math.max(0, pending)) }, (_, k) => String(k + 1));

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-4">
      <div className="overflow-auto rounded-lg border bg-background">
        <Table className={cn("table-fixed", showResults ? "min-w-[1024px]" : "min-w-[944px]")}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-52">{L.dealer}</TableHead>
              {showTaskType && <TableHead className="w-32">{L.taskType}</TableHead>}
              <TableHead className="w-56">{L.scheme}</TableHead>
              <TableHead className="w-44 text-right">{L.planned}</TableHead>
              <TableHead className="w-32 text-right">{L.pending}</TableHead>
              <TableHead className="w-36 text-right">{L.todaysPlan}</TableHead>
              {showResults && <TableHead className="w-36">{L.conversion}</TableHead>}
              {view === DailyWorkView.PLAN && <TableHead className="w-16" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Combined summary — dealer count plus numeric aggregates; dealer-level values stay neutral. */}
            <TableRow className="border-b-2 bg-muted/40 font-semibold">
              <TableCell>{combined.dealerLabel}</TableCell>
              {showTaskType && <TableCell>{L.none}</TableCell>}
              <TableCell>{L.none}</TableCell>
              <TableCell className="text-right tabular-nums">{combined.plannedUnits}</TableCell>
              <TableCell className="text-right tabular-nums">{combined.pending}</TableCell>
              <TableCell className="text-right tabular-nums">{combined.todaysPlan}</TableCell>
              {showResults && <TableCell>{L.none}</TableCell>}
              {view === DailyWorkView.PLAN && <TableCell />}
            </TableRow>

            {visibleRows.length === 0 ? (
              <TableRow><TableCell colSpan={5 + (showResults ? 1 : 0) + (showTaskType ? 1 : 0) + (view === DailyWorkView.PLAN ? 1 : 0)} className="py-8 text-center text-muted-foreground">{showResults ? L.noSubmittedSection : L.empty}</TableCell></TableRow>
            ) : visibleRows.map((r, i) => {
              const submitted = r.rowStatus !== "DRAFT" && r.rowStatus !== "NEW";
              return (
                <TableRow data-dealer-id={r.dealerId} key={r.entryId}>
                  <TableCell className="font-medium"><DealerName id={r.dealerId} name={r.dealerName} /></TableCell>
                  {/* Task Type — Scheme Conversion has no Auto Task source, so rows are Manual. */}
                  {showTaskType && <TableCell>{taskTypeText(rowTaskType(false), taskTypeL)}</TableCell>}
                  <TableCell className="p-1">
                    {submitted || r.schemeOptions.length <= 1 ? (
                      <span>{r.schemeName || L.none}</span>
                    ) : (
                      <NativeSelect className="h-8 w-full" placeholder={L.selectScheme} value={r.schemeId} options={r.schemeOptions.map((s) => ({ value: s.schemeId, label: s.schemeName }))} onChange={(e) => pickScheme(i, e.target.value)} />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.plannedUnits}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.pending}</TableCell>
                  <TableCell className="p-1 text-right">
                    <NativeSelect
                      className="h-8 w-full"
                      disabled={busy || submitted || !r.schemeId || r.pending === 0}
                      placeholder={L.none}
                      value={r.todaysPlan}
                      options={planOptions(r.pending).map((v) => ({ value: v, label: v }))}
                      onChange={(e) => update(i, { todaysPlan: e.target.value })}
                    />
                  </TableCell>
                  {/* Achievability belongs to Daily Report and remains Yes/No, post-submit only. */}
                  {showResults && <TableCell className="p-1">
                    <NativeSelect
                      className="h-8 w-full"
                      disabled={busy || locked}
                      placeholder={L.selectAchievability}
                      value={r.achievability}
                      options={[{ value: "YES", label: L.yes }, { value: "NO", label: L.no }]}
                      onChange={(e) => updateResult(r.entryId, { achievability: e.target.value as ConvEditRow["achievability"] })}
                    />
                  </TableCell>}
                  {view === DailyWorkView.PLAN && <TableCell className="text-right">
                    {!submitted && <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => removeRow(i)} title={L.removeRow} aria-label={L.removeRow}><Trash2 className="h-4 w-4" /></Button>}
                  </TableCell>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {view === DailyWorkView.PLAN && (
          <div className="border-t p-3">
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)} disabled={busy || locked}><Plus className="h-4 w-4" /> {L.addDealer}</Button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {view === DailyWorkView.REPORT && canEnterAch && visibleRows.length > 0 ? (
        <div className="flex justify-end">
          <Button onClick={() => { setError(null); achMut.mutate(); }} disabled={busy || locked}>{achMut.isPending ? L.saving : L.saveActuals}</Button>
        </div>
      ) : null}

      {addOpen && (
        <AddDealerDialog
          available={available.map((d) => ({ id: d.dealerId, name: d.dealerName }))}
          labels={{ title: L.addDealer, choose: L.chooseDealer, select: L.selectDealer, noMore: L.noPlannedSchemeDealers, cancel: L.cancel, add: L.addDealer }}
          onAdd={(id) => { addDealer(id); setAddOpen(false); }}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

/* ==================================== SECTIONS 5 + 6 — Visits + Others ==================================== */

interface SummaryBatch {
  entryId: string; batchId: string; dealerVisits: number; newPartyVisits: number;
  actualDealerVisits: number | null; actualNewPartyVisits: number | null; others: string;
  noPlanSections: string | null; status: string;
}
interface SummaryPayload {
  section: "SUMMARY"; workDate: string; dealerVisits: number; newPartyVisits: number; others: string;
  actualDealerVisits: number | null; actualNewPartyVisits: number | null;
  status: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" | "NEW";
  batches: SummaryBatch[];
}

/**
 * Visits (two whole-number plans/actuals) + Others (one free-text note) share each batch's SUMMARY record.
 * `focus` chooses which fields the toggle shows; frozen batches accumulate in Daily Report.
 */
function SummarySection({ workDate, focus, view, locked }: { workDate: string; focus: "VISITS" | "OTHERS"; view: DailyWorkViewType; locked: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<SummaryPayload>({
    queryKey: ["daily-work", "SUMMARY", workDate, view],
    queryFn: () => api.get<SummaryPayload>(`/api/daily-work?section=SUMMARY&view=${view}`),
  });

  const [dealerVisits, setDealerVisits] = useState("");
  const [newPartyVisits, setNewPartyVisits] = useState("");
  const [others, setOthers] = useState("");
  const [visitActuals, setVisitActuals] = useState<Record<string, { dealer: string; newParty: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const seedHydrationPendingRef = useRef(false);
  useEffect(() => {
    if (!data) return;
    setDealerVisits(data.dealerVisits ? String(data.dealerVisits) : "");
    setNewPartyVisits(data.newPartyVisits ? String(data.newPartyVisits) : "");
    setOthers(data.others ?? "");
    setVisitActuals(Object.fromEntries(data.batches.map((batch) => [batch.entryId, {
      dealer: batch.actualDealerVisits == null ? "" : String(batch.actualDealerVisits),
      newParty: batch.actualNewPartyVisits == null ? "" : String(batch.actualNewPartyVisits),
    }])));
    hydratedRef.current = false;
    seedHydrationPendingRef.current = true;
  }, [data]);
  // Re-baseline autosave when the Visits/Others toggle changes so switching tabs never triggers a spurious save.
  useEffect(() => { hydratedRef.current = false; }, [focus]);

  const L = {
    dealerVisits: useLabel("daily_work.visits.dealer_visits"),
    newPartyVisits: useLabel("daily_work.visits.new_party_visits"),
    others: useLabel("daily_work.section.others"),
    othersPlaceholder: useLabel("daily_work.others.placeholder"),
    visits: useLabel("daily_work.section.visits"),
    batch: useLabel("daily_work.col.batch"),
    plannedDealerVisits: useLabel("daily_work.visits.planned_dealer_visits"),
    plannedNewPartyVisits: useLabel("daily_work.visits.planned_new_party_visits"),
    actualDealerVisits: useLabel("daily_work.visits.actual_dealer_visits"),
    actualNewPartyVisits: useLabel("daily_work.visits.actual_new_party_visits"),
    saveDraft: useLabel("daily_work.action.save_draft"),
    saveActuals: useLabel("daily_work.action.save_actuals"),
    saving: useLabel("daily_work.state.saving"),
    noSubmittedSection: useLabel("daily_work.report.no_submitted_section"),
    enterVisits: useLabel("daily_work.validation.enter_visit_actuals"),
  };

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["daily-work", "SUMMARY", workDate] }); qc.invalidateQueries({ queryKey: ["daily-work-status", workDate] }); };
  // Save only the focused tab's fields: VISITS writes the visit columns (so an explicit 0 becomes real data),
  // OTHERS writes only the note — so an Others-only save never marks the Visits section "filled".
  const body = () => ({ section: "SUMMARY", workDate, focus, dealerVisits: numOr0(dealerVisits), newPartyVisits: numOr0(newPartyVisits), others });
  // Autosave only the currently-focused fields (Visits columns OR the Others note), so an Others edit never
  // marks Visits "filled" and vice-versa. Baseline is re-hydrated on focus/data change (see effects above).
  const draftKey = focus === "VISITS" ? `V|${dealerVisits}|${newPartyVisits}` : `O|${others}`;
  const autosave = useDailyAutosave(draftKey, view === DailyWorkView.PLAN && !locked, async () => {
    await api.post("/api/daily-work/save", body());
    setError(null);
    qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) });
  }, { onConflict: () => { qc.invalidateQueries({ queryKey: ["daily-work", "SUMMARY", workDate] }); qc.invalidateQueries({ queryKey: STATUS_KEY(workDate) }); } });
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    if (seedHydrationPendingRef.current) { seedHydrationPendingRef.current = false; return; }
    autosave.hydrate(draftKey);
    hydratedRef.current = true;
  }, [data, draftKey, autosave]);
  useRegisterSaveDraft(view === DailyWorkView.PLAN && !locked, { flush: autosave.flush, saving: autosave.saving, failed: autosave.failed, savedAt: autosave.savedAt });
  const reportVisitBatches = (data?.batches ?? []).filter((batch) => {
    const noPlan = new Set((batch.noPlanSections ?? "").split(",").filter(Boolean));
    return !noPlan.has("VISITS");
  });
  const actualMut = useMutation({
    mutationFn: () => {
      const entries = reportVisitBatches.flatMap((batch) => {
        const actual = visitActuals[batch.entryId];
        return actual?.dealer !== "" && actual?.newParty !== "" ? [{
          entryId: batch.entryId,
          actualDealerVisits: numOr0(actual.dealer),
          actualNewPartyVisits: numOr0(actual.newParty),
        }] : [];
      });
      if (entries.length === 0) throw new Error(L.enterVisits);
      return api.post("/api/daily-work/actual", { section: "VISITS", workDate, entries });
    },
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e) => setError((e as Error).message),
  });
  const busy = actualMut.isPending;
  // Whole-number-only inputs: block decimals/negatives at the field, backed by server validation.
  const onNumber = (set: (s: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { const v = e.target.value; if (v === "" || /^\d+$/.test(v)) set(v); };

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  if (view === DailyWorkView.REPORT && (data?.batches.length ?? 0) === 0) {
    return <div className="rounded-lg border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">{L.noSubmittedSection}</div>;
  }

  return (
    <div className="space-y-5">
      {focus === "VISITS" && view === DailyWorkView.PLAN ? (
        <div className="rounded-lg border bg-background p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{L.visits}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{L.dealerVisits}</Label>
              <Input type="number" min={0} step={1} inputMode="numeric" className="w-full" placeholder="0" value={dealerVisits} disabled={busy || locked} onChange={onNumber(setDealerVisits)} />
            </div>
            <div className="space-y-1.5">
              <Label>{L.newPartyVisits}</Label>
              <Input type="number" min={0} step={1} inputMode="numeric" className="w-full" placeholder="0" value={newPartyVisits} disabled={busy || locked} onChange={onNumber(setNewPartyVisits)} />
            </div>
          </div>
        </div>
      ) : focus === "VISITS" ? (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{L.batch}</TableHead>
              <TableHead className="text-right">{L.plannedDealerVisits}</TableHead>
              <TableHead className="text-right">{L.plannedNewPartyVisits}</TableHead>
              <TableHead>{L.actualDealerVisits}</TableHead>
              <TableHead>{L.actualNewPartyVisits}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {reportVisitBatches.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{L.noSubmittedSection}</TableCell></TableRow>
              ) : reportVisitBatches.map((batch, index) => (
                <TableRow key={batch.entryId}>
                  <TableCell className="font-medium">{index + 1}</TableCell>
                  <TableCell className="text-right tabular-nums">{batch.dealerVisits}</TableCell>
                  <TableCell className="text-right tabular-nums">{batch.newPartyVisits}</TableCell>
                  <TableCell>
                    <Input type="number" min={0} step={1} inputMode="numeric" className="w-28" placeholder="0" value={visitActuals[batch.entryId]?.dealer ?? ""} disabled={busy || locked} onChange={(event) => onNumber((value) => setVisitActuals((current) => ({ ...current, [batch.entryId]: { dealer: value, newParty: current[batch.entryId]?.newParty ?? "" } })))(event)} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" min={0} step={1} inputMode="numeric" className="w-28" placeholder="0" value={visitActuals[batch.entryId]?.newParty ?? ""} disabled={busy || locked} onChange={(event) => onNumber((value) => setVisitActuals((current) => ({ ...current, [batch.entryId]: { dealer: current[batch.entryId]?.dealer ?? "", newParty: value } })))(event)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-lg border bg-background p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{L.others}</h2>
          <Textarea rows={5} maxLength={5000} placeholder={L.othersPlaceholder} value={others} disabled={busy || locked || view === DailyWorkView.REPORT} onChange={(e) => setOthers(e.target.value)} />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Save Draft moved to the Plan Type toolbar. */}
      {view === DailyWorkView.REPORT && focus === "VISITS" && reportVisitBatches.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => { setError(null); actualMut.mutate(); }} disabled={busy || locked}>{actualMut.isPending ? L.saving : L.saveActuals}</Button>
        </div>
      )}
    </div>
  );
}

/* ==================================== CN follow-up tasks (Recovery) ==================================== */

/**
 * Compact CN Working table. The existing task API returns every active task, including future-dated rows;
 * changing the date moves the same task through the existing endpoint and never duplicates it.
 */
function CnTasksPanel({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const { data: tasks } = useQuery<CnTask[]>({ queryKey: ["cn-tasks-pending"], queryFn: () => api.get<CnTask[]>("/api/cn-requests/tasks") });
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const L = {
    dealer: useLabel("cn_requests.task.dealer"),
    taskDate: useLabel("cn_requests.task.task_date"),
    amount: useLabel("cn_requests.task.amount"),
    taskType: useLabel("daily_work.col.task_type"),
    planType: useLabel("daily_work.col.plan_type"),
    selectTaskDate: useLabel("daily_work.col.select_task_date"),
    cnRequest: useLabel("cn_requests.detail.title"),
    recovery: useLabel("daily_work.section.recovery"),
    rescheduleType: useLabel("cn_requests.task.reschedule_type"),
    nextWorkingDay: useLabel("cn_requests.task.next_working_day"),
    rescheduled: useLabel("cn_requests.task.rescheduled"),
    action: useLabel("cn_requests.col.action"),
    cnWorking: useLabel("cn_requests.acceptance.cn_working"),
    viewDetails: useLabel("cn_requests.action.view_details"),
    noActive: useLabel("cn_requests.task.no_active"),
    sundayInvalid: useLabel("cn_requests.validation.task_date_sunday"),
  };
  const scheduleMut = useMutation({
    mutationFn: (v: { id: string; taskId: string | null; taskDate: string }) => api.post(`/api/cn-requests/${v.id}/task-date`, { taskId: v.taskId ?? undefined, taskDate: v.taskDate }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cn-tasks-pending"] }); onChanged(); },
    onError: (e) => alert((e as Error).message),
  });
  const busy = scheduleMut.isPending;
  const today = currentBusinessDate();
  const isExpired = (task: CnTask) => task.expiryDate != null && today > task.expiryDate;
  const activeTasks = tasks ?? [];
  const taskKey = (task: CnTask) => task.taskId ?? task.cnRequestId;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border bg-background">
        <Table className="min-w-[944px] table-fixed">
          <TableHeader><TableRow>
            <TableHead className="w-56">{L.dealer}</TableHead>
            <TableHead className="w-32 text-right">{L.amount}</TableHead>
            <TableHead className="w-36">{L.taskType}</TableHead>
            <TableHead className="w-36">{L.planType}</TableHead>
            <TableHead className="w-52">{L.selectTaskDate}</TableHead>
            <TableHead className="w-16 text-right">{L.action}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {activeTasks.length === 0 ? <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{L.noActive}</TableCell></TableRow> : activeTasks.map((task) => (
              <TableRow data-dealer-id={task.dealerId} key={taskKey(task)}>
                <TableCell className="font-medium"><DealerName id={task.dealerId} name={task.partyName} /></TableCell>
                <TableCell className="text-right tabular-nums">{task.recoveryAmount == null ? "—" : money(task.recoveryAmount)}</TableCell>
                <TableCell>{task.taskType === "CN_REQUEST" ? L.cnRequest : task.taskType}</TableCell>
                <TableCell>{task.planType === "RECOVERY" ? L.recovery : task.planType}</TableCell>
                <TableCell>
                  <Input
                    aria-label={`${L.taskDate} — ${task.partyName}`}
                    type="date"
                    className="h-8 w-40"
                    min={task.acceptanceDate ?? undefined}
                    max={task.expiryDate ?? undefined}
                    value={task.taskDate ?? ""}
                    disabled={busy || isExpired(task)}
                    onChange={(event) => {
                      const taskDate = event.target.value;
                      if (!taskDate) return;
                      if (isCnSundayDateKey(taskDate)) {
                        event.currentTarget.value = task.taskDate ?? "";
                        alert(L.sundayInvalid);
                        return;
                      }
                      if (taskDate !== task.taskDate) scheduleMut.mutate({ id: task.cnRequestId, taskId: task.taskId, taskDate });
                    }}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" title={L.action}><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => window.open(`/api/cn-requests/${task.cnRequestId}/working`, "_blank", "noopener,noreferrer")}><FileText className="h-4 w-4" /> {L.cnWorking}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDetailRequestId(task.cnRequestId)}><Eye className="h-4 w-4" /> {L.viewDetails}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {detailRequestId && <CnRequestDetailDialog requestId={detailRequestId} onClose={() => setDetailRequestId(null)} />}
    </div>
  );
}
