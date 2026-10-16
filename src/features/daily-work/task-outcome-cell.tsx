"use client";

import { cn, formatSchemeCurrency as formatCurrency } from "@/lib/utils";
import { formatDMY } from "@/lib/date-format";
import { Badge } from "@/components/ui/badge";
import { DateInputDMY } from "@/components/ui/date-input-dmy";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLabel } from "@/features/labels/label-ui";
import { MAX_REASON_LENGTH, checkReason, isTaskOutcome, parseActualAmount, rowActualFromOutcomes, validateOutcome, type OutcomeFields, type TaskOutcome } from "@/lib/task-outcome";
import type { TaskUnitDto } from "./task-outcome.server";

/**
 * Daily Report → Sales / Recovery: the outcome of each task in a reported row. Initially "Select outcome…" (never preselected). Completed shows the Actual Amount;
 * Not Completed — Reschedule shows the next date (a calendar picker, strictly after today); Abandon shows the required reason. The control sits beside the dropdown on a desktop and below
 * it on a phone. Only the fields of the CHOSEN outcome are ever sent, so switching the outcome can never leave a stale value behind that triggers an effect.
 */
export interface UnitEdit {
  unitType: TaskUnitDto["unitType"]; unitId: string; type: "MANUAL" | "AUTO"; source: TaskUnitDto["source"]; plannedAmount: number;
  outcome: "" | TaskOutcome; actualAmount: string; nextDate: string; reason: string; state: "DRAFT" | "COMMITTED";
  rescheduledFrom: string | null; dateRule: TaskUnitDto["dateRule"];
}
export const unitsFromDto = (tasks: readonly TaskUnitDto[]): UnitEdit[] => tasks.map((t) => ({
  unitType: t.unitType, unitId: t.unitId, type: t.type, source: t.source, plannedAmount: t.plannedAmount, outcome: t.outcome ?? "", actualAmount: t.actualAmount == null ? "" : String(t.actualAmount),
  nextDate: t.nextDate ?? "", reason: t.reason ?? "", state: t.state, rescheduledFrom: t.rescheduledFrom, dateRule: t.dateRule,
}));

/** The day after `today` (the earliest allowed next date). */
export const dayAfter = (today: string): string => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** What this task's draft means as validated fields (invalid pieces become null — i.e. incomplete — never guessed). */
export function unitFields(u: UnitEdit): OutcomeFields {
  if (u.outcome === "COMPLETED") { const a = parseActualAmount(u.actualAmount); return { outcome: "COMPLETED", actualAmount: a.ok ? a.value : null, nextDate: null, reason: null }; }
  if (u.outcome === "RESCHEDULED") return { outcome: "RESCHEDULED", actualAmount: null, nextDate: u.nextDate || null, reason: null };
  if (u.outcome === "ABANDONED") return { outcome: "ABANDONED", actualAmount: null, nextDate: null, reason: u.reason.replace(/\s+/g, " ").trim() || null };
  return { outcome: null, actualAmount: null, nextDate: null, reason: null };
}
/** The row's reported total from its tasks (null until every task has a valid outcome) — the same rule the server applies. */
export const rowActualOf = (units: readonly UnitEdit[], today: string): number | null => (units.length === 0 ? null : rowActualFromOutcomes(units.map(unitFields), today));

/** The autosave payload for one row: only DRAFT tasks, and per task only the fields of the chosen outcome (invalid / incomplete values are left out, never sent as 0). */
export function outcomeUnitsPayload(units: readonly UnitEdit[], today: string) {
  return units.filter((u) => u.state === "DRAFT").map((u) => {
    const base = { unitType: u.unitType, unitId: u.unitId, outcome: u.outcome === "" ? null : u.outcome };
    if (u.outcome === "COMPLETED") { const a = parseActualAmount(u.actualAmount); return a.ok && a.value !== null ? { ...base, actualAmount: a.value } : base; }
    if (u.outcome === "RESCHEDULED") return u.nextDate > today ? { ...base, nextDate: u.nextDate } : base;
    if (u.outcome === "ABANDONED") return u.reason.trim() !== "" ? { ...base, reason: u.reason.slice(0, MAX_REASON_LENGTH) } : base;
    return base;
  });
}

export function TaskOutcomeCell({ units, rowLabel, today, disabled, onChange }: {
  units: UnitEdit[]; rowLabel: string; today: string; disabled: boolean; onChange: (unitId: string, patch: Partial<UnitEdit>) => void;
}) {
  const L = {
    select: useLabel("daily_work.outcome.select"), completed: useLabel("daily_work.outcome.completed"), rescheduled: useLabel("daily_work.outcome.rescheduled"), abandon: useLabel("daily_work.outcome.abandon"),
    aria: useLabel("daily_work.outcome.aria"), amount: useLabel("daily_work.outcome.actual_amount"), amountPlaceholder: useLabel("daily_work.outcome.amount_placeholder"), nextDate: useLabel("daily_work.outcome.next_date"), reason: useLabel("daily_work.outcome.reason"),
    reasonPlaceholder: useLabel("daily_work.outcome.reason_placeholder"), reasonHelp: useLabel("daily_work.outcome.reason_help"), dateHelp: useLabel("daily_work.outcome.date_help"), dateCnHelp: useLabel("daily_work.outcome.date_cn_help"),
    manual: useLabel("daily_work.outcome.type_manual"), auto: useLabel("daily_work.outcome.type_auto"), planned: useLabel("daily_work.outcome.task_planned"), tasksTitle: useLabel("daily_work.outcome.tasks_title"),
    badgeFrom: useLabel("daily_work.outcome.badge_rescheduled_from"), resRescheduled: useLabel("daily_work.outcome.result_rescheduled"), resAbandoned: useLabel("daily_work.outcome.result_abandoned"), resCompleted: useLabel("daily_work.outcome.result_completed"),
    badgeAbandoned: useLabel("daily_work.outcome.badge_abandoned"), badgeCompleted: useLabel("daily_work.outcome.badge_completed"),
    sourceBilling: useLabel("daily_work.recovery_source.billing_exception"), sourceCn: useLabel("daily_work.recovery_source.cn_request"),
    errAmount: useLabel("daily_work.outcome.error.amount_invalid"), errShort: useLabel("daily_work.outcome.error.reason_short"), errMeaningless: useLabel("daily_work.outcome.error.reason_meaningless"),
  };
  const many = units.length > 1;
  return (
    <div className="space-y-3" data-testid="task-outcomes">
      {many && <div className="text-xs font-medium text-muted-foreground">{L.tasksTitle}</div>}
      {units.map((u) => {
        const committed = u.state === "COMMITTED";
        const taskName = many ? `${rowLabel} · ${u.type === "AUTO" ? L.auto : L.manual}${u.source ? ` · ${u.source === "BILLING_EXCEPTION" ? L.sourceBilling : L.sourceCn}` : ""} · ${formatCurrency(u.plannedAmount)}` : rowLabel;
        const amount = parseActualAmount(u.actualAmount);
        const reasonCheck = u.reason.trim() === "" ? null : checkReason(u.reason);
        const minDate = dayAfter(today);
        const err = validateOutcome(unitFields(u), today);
        return (
          <div key={`${u.unitType}:${u.unitId}`} className={cn("space-y-1.5", many && "rounded-md border p-2")} data-testid="task-outcome" data-unit={`${u.unitType}:${u.unitId}`}>
            {many && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge variant={u.type === "AUTO" ? "secondary" : "muted"}>{u.type === "AUTO" ? L.auto : L.manual}</Badge>
                {u.source && <span className="text-muted-foreground">{u.source === "BILLING_EXCEPTION" ? L.sourceBilling : L.sourceCn}</span>}
                <span className="font-medium tabular-nums">{L.planned.replace("{amount}", formatCurrency(u.plannedAmount))}</span>
                {u.rescheduledFrom && <Badge variant="warning" data-testid="rescheduled-badge">{L.badgeFrom.replace("{date}", formatDMY(u.rescheduledFrom))}</Badge>}
              </div>
            )}
            {!many && u.rescheduledFrom && <Badge variant="warning" data-testid="rescheduled-badge">{L.badgeFrom.replace("{date}", formatDMY(u.rescheduledFrom))}</Badge>}
            {/* Row 1: the outcome and the Actual Amount side by side (stacked on a phone) — the amount is ALWAYS shown; only Completed enables it. Row 2: the date or the reason. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start" data-testid="outcome-controls">
              <NativeSelect
                className={cn("h-8 w-full sm:w-56 sm:shrink-0", u.outcome === "ABANDONED" && "border-destructive font-medium text-destructive")}
                aria-label={L.aria.replace("{task}", taskName)} disabled={disabled || committed} value={u.outcome} placeholder={L.select}
                options={[{ value: "COMPLETED", label: L.completed }, { value: "RESCHEDULED", label: L.rescheduled }, { value: "ABANDONED", label: L.abandon, className: "text-destructive" }]}
                onChange={(e) => {
                  const outcome = isTaskOutcome(e.target.value) ? e.target.value : "";
                  // Leaving Completed clears the amount (it is never kept, sent or replaced by 0).
                  onChange(u.unitId, outcome === "COMPLETED" ? { outcome } : { outcome, actualAmount: "" });
                }}
              />
              <div className="w-full min-w-[160px] sm:w-44 sm:shrink-0" data-testid="outcome-amount">
                <Input type="number" min={0} step="0.01" inputMode="decimal"
                  className={cn("h-8 min-w-[160px] text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-100", u.outcome === "COMPLETED" && !committed && !amount.ok && "border-destructive")}
                  aria-label={`${L.amount} — ${taskName}`} placeholder={L.amountPlaceholder} value={u.outcome === "COMPLETED" ? u.actualAmount : ""}
                  disabled={disabled || committed || u.outcome !== "COMPLETED"} onChange={(e) => onChange(u.unitId, { actualAmount: e.target.value })} />
                {u.outcome === "COMPLETED" && !committed && (!amount.ok || (u.actualAmount.trim() !== "" && amount.ok && amount.value === null)) && <p className="mt-0.5 text-[11px] text-destructive">{L.errAmount}</p>}
              </div>
            </div>
            {committed ? (
              <p className={cn("text-sm", u.outcome === "ABANDONED" && "font-medium text-destructive")} data-testid="outcome-result">
                {u.outcome === "COMPLETED" ? L.resCompleted.replace("{amount}", formatCurrency(Number(u.actualAmount)))
                  : u.outcome === "RESCHEDULED" ? L.resRescheduled.replace("{date}", formatDMY(u.nextDate))
                    : L.resAbandoned.replace("{reason}", u.reason)}
              </p>
            ) : (
              <>
                {u.outcome === "RESCHEDULED" && (
                  <div className="w-full sm:w-56" data-testid="outcome-date">
                    <DateInputDMY value={u.nextDate} min={minDate} max={u.dateRule?.maxDate ?? undefined} disabled={disabled} aria-label={`${L.nextDate} — ${taskName}`} onChange={(v) => onChange(u.unitId, { nextDate: v })} />
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{u.dateRule?.maxDate ? L.dateCnHelp.replace("{date}", formatDMY(u.dateRule.maxDate)) : L.dateHelp}</p>
                  </div>
                )}
                {u.outcome === "ABANDONED" && (
                  <div className="w-full" data-testid="outcome-reason">
                    <Textarea rows={3} maxLength={MAX_REASON_LENGTH} className={cn("text-sm", (reasonCheck === "reason_short" || reasonCheck === "reason_meaningless") && "border-destructive")} aria-label={`${L.reason} — ${taskName}`} placeholder={L.reasonPlaceholder}
                      value={u.reason} disabled={disabled} onChange={(e) => onChange(u.unitId, { reason: e.target.value })} />
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{L.reasonHelp}</p>
                    {reasonCheck === "reason_short" && <p className="text-[11px] text-destructive">{L.errShort}</p>}
                    {reasonCheck === "reason_meaningless" && <p className="text-[11px] text-destructive">{L.errMeaningless}</p>}
                  </div>
                )}
              </>
            )}
            {u.outcome === "ABANDONED" && !committed && !err && <Badge variant="destructive">{L.badgeAbandoned}</Badge>}
          </div>
        );
      })}
    </div>
  );
}
