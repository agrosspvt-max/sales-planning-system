import { getTaskActivity } from "@/features/tasks/task-analysis.server";
import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { hasAdminPermission } from "@/features/accounts/permissions";

import { resolveWorkDateMonth } from "@/lib/season-calendar";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getCurrentDealerIds, getCurrentOwnerByDealer, getOfficerScope, assertOfficerInScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { runningSchemes } from "@/features/schemes/scheme-planning.server";
import { billFinancialScope } from "@/lib/scheme-financial-scope";
import { getMonthly } from "@/features/planning/monthly.server";
import { resolveAddableSeasonalPlanId } from "@/features/planning/monthly-plan.server";
import { figuresForMode, type PlanningMode } from "@/lib/calc";
import { effectiveProceedingSchemeUnits } from "@/lib/scheme-plan-quantity";
import { getResolvedLabels } from "@/features/labels/service.server";
import { cnTasksForOfficerDate, materializedCnTasksForEntries, countUnconfirmedMaterializedTasks } from "@/features/cn-requests/service.server";
import { getAutoTasksEnabled, getAppointmentPartyPlanningEnabled } from "@/lib/recovery-config";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { type CnTaskDto } from "@/lib/cn-request";
import { assertDayOpen, lockDailyWorkDay, readBatchContext, type DailyWorkDb as DbClient } from "./day-lock.server";
import { rolloutEffectiveAt, createLateReportRequest, decideLateReportRequest, listLateRequests, myLateRequests, type LateRequestDto, assertPlanWritable, assertReportWritable, completeLateRequest, loadLateRequestFacts, loadPolicyDeadlines, outstandingReport, recordPolicyOnFirstSubmit, reportWindow } from "./report-policy.server";
import { hasCombinedDraftRows, isTaskRowKey, splitCombinedDraftRows, submittedManualDealerIds } from "./task-rows.server";
import { commitTaskOutcomes, readRowUnits, rescheduledEntryIds, writeOutcomeDraftBatch, type EntryFacts, type TaskUnitDto } from "./task-outcome.server";
import { materializeDueDailyWorkTasks, materializeDueDailyWorkTasksInTransaction, autoTasksApplyToRole } from "./auto-task-materialization.server";
import { materializeDueCalendarTasks, calendarLinkedEntryIds } from "./calendar-task-materialization.server";
import { isPartyPlanningEnabled } from "@/lib/feature-flags";
import { ownerSendDocumentsInTx } from "@/features/party-planning/monthly.server";
import { appointmentMonthlyTotals } from "@/lib/monthly-plan";
import { billingTasksForEntries, billingLinkedEntryIds, BILLING_CONTRIBUTION_UNION, type BillingTaskDto } from "./billing-task.server";
import {
  currentBusinessDate, monthNameForDate, performanceSectionTotals, performanceRowValue, isPerformanceMetric, PERFORMANCE_METRIC_INFO, type PerformanceMetric, type PerformanceUnit, type PerformanceEntryRow, type PerformanceSectionTotals, salesPending, recoveryPending, conversionPending, combineDailyWorkRows, round2,
  computeSectionStatuses, sectionStatusCounts, canSubmitDailyWork, parseNoPlanSet, serializeNoPlanSet,
  MANDATORY_SECTIONS, SectionStatus, SCHEME_CONVERSION_ENABLED, isDailyWorkSectionEnabled, RECOVERY_PAYMENT_MODES,
  type RecoveryPaymentMode, recoverySourceOf, type RecoverySource,
  dailyWorkClock, invalidPlanRows, planRequiredMessage, dailyReportDeadline, isStrictDeadlinePassed, isReportDeadlinePassed, previousBusinessDate, previousReportBlocksPlan, previousReportState, type PreviousReportState,
  type DailyWorkSection, type DailyWorkType, type DailyWorkDealerRow,
  type SectionDataPresence, type MandatorySection, type SectionStatusCounts,
} from "@/lib/daily-work";

/**
 * Daily Work Template server service (Sales + Recovery).
 *
 * REUSE, NEVER DUPLICATE. Everything except the officer's daily inputs is derived LIVE from existing sources:
 *   - Monthly Sales Plan + Actual Sales   → getMonthly() (the Monthly Dealer Summary source) + figuresForMode,
 *                                            for the CURRENT SeasonMonth (plan priced from qty×rate in quantity
 *                                            mode, exactly as the Dealer Summary does — never raw planValue)
 *   - Monthly Recovery Plan + Actual      → RecoveryPlanDealer (monthRecoveryPlan + monthRunningRecovery, and
 *                                            actualRunningRecovery = liveRecovery + srCr − (due + overdue))
 *   - Sales schemes                       → runningSchemes(ctx) (OPEN schemes in the officer's group)
 *   - Recovery schemes                    → the existing Scheme Follow-up/payment financial scope, per dealer
 *   - Dealer scope                        → getCurrentDealerIds(officerId) (SO's assigned dealers)
 * Only the daily plan/actual/type/scheme-ref and optional Recovery payment mode live in DailyWorkEntry, accessed via raw SQL (the generated
 * Prisma client does not yet expose DailyWorkEntry in this environment). Pending and the combined row are
 * derived at read time — never stored.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v.toString()));
const SECTIONS = ["SALES", "RECOVERY"] as const;

/* --------------------------------- Input schemas --------------------------------- */

type ResolvedLabels = Awaited<ReturnType<typeof getResolvedLabels>>;

/** Replace documented `{token}` values in configurable validation messages. */
function formatLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
}

/** Request schemas use the current persisted labels for every user-facing validation message. */
function dailyWorkSchemas(L: ResolvedLabels) {
  const invalidOption = { errorMap: () => ({ message: L["daily_work.validation.invalid_option"] }) } as const;
  const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, L["daily_work.validation.valid_date"]);
  const money = z.coerce.number().min(0, L["daily_work.validation.valid_amount"]).max(1e12, L["daily_work.validation.valid_amount"]);
  const rowSchema = z.object({
    dealerId: z.string().min(1, L["daily_work.placeholder.select_dealer"]),
    todaysPlan: money.optional(),
    entryType: z.enum(["REGULAR", "SCHEME"], invalidOption).optional().default("REGULAR"),
    schemeId: z.string().min(1, L["daily_work.placeholder.select_scheme"]).optional().nullable(),
    /** Recovery: the automatic amount the editor was showing for this row — a stale draft (a task was rescheduled meanwhile) is refused. */
    autoAmount: z.coerce.number().min(0).max(1e12).optional(),
    /** A Regional Manager adding a Sales Officer's dealer: that officer's id. Never trusted — it must be the dealer's CURRENT owner and inside the RM's scope (the task stays the RM's own). */
    ownerId: z.string().min(1).max(64).optional(),
  });
  /** The dealer name reported with an Appointed result: trimmed, blank = none. */
  const reportedName = z.string().trim().max(200, L["daily_work.validation.dealer_name_length"]);
  const appointmentRowSchema = z.object({
    rowId: z.string().min(1, L["daily_work.validation.invalid_option"]),
    /** A Monthly Party Planning entry (linked row); the market identity and name are always taken from it on the server. */
    monthlyPlanId: z.string().min(1).optional().nullable(),
    /** Manual mode accepts typed names; connected mode only echoes existing unlinked rows unchanged. */
    dealerName: z.string().trim().max(200, L["daily_work.validation.dealer_name_length"]).optional().default(""),
    marketName: z.string().trim().max(200, L["daily_work.validation.market_length"]).optional().default(""),
  });
  const conversionRowSchema = z.object({
    dealerId: z.string().min(1, L["daily_work.placeholder.select_dealer"]),
    schemeId: z.string().min(1, L["daily_work.placeholder.select_scheme"]),
    todaysPlan: z.coerce.number().int(L["daily_work.validation.plan_units"]).min(0, L["daily_work.validation.plan_units"]).max(6, L["daily_work.validation.plan_units"]).optional().default(0),
  });
  const wholeCount = z.coerce.number().int(L["daily_work.validation.whole_number"]).min(0, L["daily_work.validation.not_negative"]).max(100000, L["daily_work.validation.whole_number"]);
  const maxRows = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).max(500, L["daily_work.validation.too_many_rows"]);
  return {
    save: z.discriminatedUnion("section", [
      z.object({ section: z.literal("SALES"), workDate: dateStr, rows: maxRows(rowSchema) }),
      z.object({ section: z.literal("RECOVERY"), workDate: dateStr, rows: maxRows(rowSchema) }),
    ], invalidOption),
    actual: z.object({ section: z.enum(SECTIONS, invalidOption), workDate: dateStr, entries: maxRows(z.object({
      entryId: z.string().min(1, L["daily_work.validation.invalid_option"]), todaysActual: money,
      // Recovery Daily Report only: HOW the actual recovery was received. Absent = leave the stored value alone.
      paymentMode: z.enum(RECOVERY_PAYMENT_MODES, invalidOption).nullable().optional(),
    })) }),
    // Daily Report → Sales / Recovery task outcomes: one entry per submitted row, one unit per identifiable task inside it. Unknown keys (a stale amount, date or reason of another
    // outcome) are ignored: only the fields of the chosen outcome are ever kept (sanitizeOutcomeFields).
    outcomes: z.object({ section: z.enum(SECTIONS, invalidOption), workDate: dateStr, entries: maxRows(z.object({
      entryId: z.string().min(1, L["daily_work.validation.invalid_option"]),
      paymentMode: z.enum(RECOVERY_PAYMENT_MODES, invalidOption).nullable().optional(),
      units: z.array(z.object({ unitType: z.string().min(1), unitId: z.string().min(1), outcome: z.unknown().optional(), actualAmount: z.unknown().optional(), nextDate: z.unknown().optional(), reason: z.unknown().optional(), reasonCode: z.unknown().optional() })).max(200),
    })) }),
    appointmentSave: z.object({ workDate: dateStr, partyPlanningEnabled: z.boolean().optional(), rows: maxRows(appointmentRowSchema) }),
    appointedResult: z.object({ workDate: dateStr, entryId: z.string().min(1, L["daily_work.validation.invalid_option"]), sent: z.unknown().optional(), dealerName: reportedName.optional() }),
    appointmentStatus: z.object({ workDate: dateStr, entries: maxRows(z.object({ entryId: z.string().min(1, L["daily_work.validation.invalid_option"]), status: z.enum(["APPOINTED", "NOT_APPOINTED"], invalidOption), dealerName: reportedName.optional() })) }),
    conversionSave: z.object({ workDate: dateStr, rows: maxRows(conversionRowSchema) }),
    conversionAchievability: z.object({ workDate: dateStr, entries: maxRows(z.object({ entryId: z.string().min(1, L["daily_work.validation.invalid_option"]), achievability: z.enum(["YES", "NO"], invalidOption) })) }),
    visitsActual: z.object({ workDate: dateStr, entries: maxRows(z.object({
      entryId: z.string().min(1, L["daily_work.validation.invalid_option"]),
      actualDealerVisits: wholeCount,
      actualNewPartyVisits: wholeCount,
    })) }),
    summarySave: z.object({
      workDate: dateStr,
      // Which fields this save touches: VISITS writes the visit columns, OTHERS writes the note, BOTH writes all.
      focus: z.enum(["VISITS", "OTHERS", "BOTH"], invalidOption).optional().default("BOTH"),
      dealerVisits: wholeCount.optional().default(0),
      newPartyVisits: wholeCount.optional().default(0),
      others: z.string().max(5000, L["daily_work.validation.others_length"]).optional().default(""),
    }),
    noPlan: z.object({ workDate: dateStr, section: z.enum(["SALES", "RECOVERY", "APPOINTMENT", "SCHEME_CONVERSION", "VISITS", "OTHERS"], invalidOption), noPlan: z.boolean() }),
    statusDate: z.object({ workDate: dateStr }),
    batchSubmit: z.object({ workDate: dateStr }),
    // Day-level Submit carries the SO's mandatory self-rating. Only an integer 1–10 is valid — empty/null/0/>10/
    // decimals all collapse to the same message. This is the authoritative server gate for the rating.
    submitDay: z.object({
      workDate: dateStr,
      selfRating: z.coerce.number({
        required_error: L["daily_work.validation.rating_required"],
        invalid_type_error: L["daily_work.validation.rating_required"],
      })
        .int(L["daily_work.validation.rating_required"])
        .min(1, L["daily_work.validation.rating_required"])
        .max(10, L["daily_work.validation.rating_required"]),
    }),
    // RM review creation. Rating rules mirror the self-rating (integer 1–10, required).
    reviewCreate: z.object({
      officerId: z.string().min(1, L["daily_work.review.invalid_officer"]),
      workDate: dateStr,
      rating: z.coerce.number({
        required_error: L["daily_work.review.rating_required"],
        invalid_type_error: L["daily_work.review.rating_required"],
      })
        .int(L["daily_work.review.rating_required"])
        .min(1, L["daily_work.review.rating_required"])
        .max(10, L["daily_work.review.rating_required"]),
    }),
  };
}

/* --------------------------------- DTOs --------------------------------- */

export interface DailyWorkSchemeOption { id: string; name: string }
export interface DailyWorkDealerDto {
  entryId: string;
  batchId: string;
  dealerId: string;
  dealerName: string;
  monthlyPlan: number; // Monthly Sales Plan / Monthly Recovery Plan (non-editable, sourced)
  actual: number; // current-month actual sales / actual total recovery (for Pending; non-editable)
  pending: number; // derived
  todaysPlan: number | null; // officer-entered
  todaysActual: number | null; // manual actual (post-submit)
  entryType: DailyWorkType;
  /** Recovery only: the system source of an automatically generated row (its Recovery Type is shown and locked as this). null → a manual row. */
  recoverySource?: RecoverySource | null;
  /** Recovery: Σ of the automatic contributions (Billing Exception + CN) inside this row, and whether the whole amount is automatic (then read-only). */
  autoContribution?: number;
  amountLocked?: boolean;
  /** TASK = the row of ONE scheduled task (Billing Exception / CN / Calendar): its dealer, amount, type and source are fixed and it is never merged with another. MANUAL = the dealer's directly entered task. */
  rowKind: "MANUAL" | "TASK";
  paymentMode?: RecoveryPaymentMode | null; // Recovery Daily REPORT only (the ACTUAL receipt mode); never part of the Daily Plan
  /** Daily REPORT only: the identifiable tasks inside this row, each with its own outcome. Empty for a legacy row (reported before outcomes existed — read-only). */
  tasks?: TaskUnitDto[];
  /** Daily REPORT only: true when this row was reported before the outcome workflow (its Actual — possibly zero — is shown read-only; no outcome was ever collected). */
  legacyOutcome?: boolean;
  schemeId: string | null;
  status: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" | "NEW";
}
/** A scoped dealer not yet added, carrying its sourced figures so a freshly-added row shows plan/pending at once. */
export interface DailyWorkAvailableDealer { id: string; name: string; monthlyPlan: number; actual: number; pending: number }
export interface DailyWorkPayload {
  section: DailyWorkSection;
  workDate: string;
  monthName: string | null; // the resolved current running month (Sales); recovery month for Recovery
  canEnterActual: boolean; // frozen report rows allow Today's Sales/Recovery entry while the day remains open
  availableDealers: DailyWorkAvailableDealer[]; // scoped dealers that may still get their ONE directly entered manual task
  /** Dealers whose directly entered manual task already sits in an earlier SUBMITTED planning batch of this date and section (the limit spans batches). */
  manualDealerIds: string[];
  /** Regional Manager planning their OWN day: the Add Dealer dialog offers the Sales Officer filter (My Dealers by default). */
  canPickDealerOwner: boolean;
  applicableSchemes: DailyWorkSchemeOption[]; // Sales: OPEN schemes for the officer's group (shared by all dealers)
  applicableSchemesByDealer: Record<string, DailyWorkSchemeOption[]>; // Recovery: enrolled/verified dealer schemes
  cnTasks: CnTaskDto[]; // Recovery: CN follow-up tasks (Accepted, Not Posted) the SO scheduled on this date
  materializedCnTasks: CnTaskDto[]; // current editable Recovery-row tasks; exposed only for exact rescheduling
  autoTaskEntryIds: string[]; // historical/current contribution links used only to display each row's Task Type
  calendarEntryIds: string[]; // rows created from a Calendar Daily Task → Task Type "Calendar"
  billingTasks: BillingTaskDto[]; // Recovery (plan): Billing Exception tasks inside the current editable rows (confirm / reschedule / details act on these)
  billingEntryIds: string[]; // rows carrying a Billing Exception contribution → Task Type "Billing Exception" (plan, report and review views)
  rescheduledEntryIds: string[]; // rows whose tasks carry a reschedule history (the Rescheduled badge on the day a moved task arrives)
  dealers: DailyWorkDealerDto[];
}

/* ---- Dealer Appointment DTOs ---- */
export interface AppointmentRowDto {
  entryId: string;
  batchId: string;
  rowId: string;
  /** The approved Monthly Party Planning entry this row plans (stable reference), its market id, and the display snapshot of the market name. Legacy typed rows have no plan link. */
  monthlyPlanId: string | null;
  marketId: string | null;
  marketName: string;
  /** Manually typed dealer name (manual mode, older rows, and calendar-generated rows). Empty for linked rows. */
  dealerName: string;
  legacy: boolean;
  /** The linked entry's CURRENT monthly operational status (NONE / DOC_SENT / …), for the Daily Report; null for legacy rows. */
  monthlyStatus: string | null;
  /** The monthly status event the "Appointed" result initiated (null when none was needed / not Appointed). */
  resultEventId: string | null;
  /** Daily Report: the dealer name reported for an Appointed result ("" when none; always "" for Not Appointed). Report information only. */
  reportedDealerName: string;
  status: "APPOINTED" | "NOT_APPOINTED" | null; // post-submit
  rowStatus: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED";
}
export interface AppointmentPayload {
  section: "APPOINTMENT";
  workDate: string;
  partyPlanningEnabled: boolean;
  canEnterStatus: boolean; // frozen report rows expose the Appointed/Not Appointed selector
  /** The owner's APPROVED Monthly Party Planning markets for the month of the Daily Work date (one per entry), the Daily Plan's selector options. */
  eligibleMarkets: { monthlyPlanId: string; marketId: string; marketName: string; monthlyStatus: string }[];
  /** Monthly Dealer Plan = unique approved markets; Pending = those whose monthly workflow is not finished (see appointmentMonthlyTotals). Not per-row values. */
  monthlyDealerPlan: number;
  pending: number;
  rows: AppointmentRowDto[];
  calendarEntryIds: string[]; // rows created from a Calendar Daily Task → Task Type "Calendar"
}

/* ---- Scheme Conversion DTOs ---- */
export interface PlannedSchemeOption { schemeId: string; schemeName: string; plannedUnits: number; convertedUnits: number; pending: number }
export interface ConversionRowDto {
  entryId: string;
  batchId: string;
  dealerId: string;
  dealerName: string;
  schemeId: string;
  schemeName: string;
  plannedUnits: number; // READ-ONLY, from DealerSchemePlan
  convertedUnits: number; // READ-ONLY, from schemeStatus=CONVERTED
  pending: number; // plannedUnits − convertedUnits (units)
  todaysPlan: number | null; // officer-entered units (1..6, ≤ pending)
  achievability: "YES" | "NO" | null; // post-submit
  rowStatus: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED";
}
/** A scoped dealer that has at least one PLANNED (approved) scheme, with its planned scheme options. */
export interface ConversionDealerOption { dealerId: string; dealerName: string; schemes: PlannedSchemeOption[] }
export interface ConversionPayload {
  section: "SCHEME_CONVERSION";
  workDate: string;
  canEnterAchievability: boolean;
  availableDealers: ConversionDealerOption[]; // scoped dealers with planned schemes not yet fully added
  rows: ConversionRowDto[];
}

/* --------------------------------- Guards --------------------------------- */

/** Only a Sales Officer or Regional Manager owns Daily Work; Admin may read any officer's (view). */
async function assertOwnerRole(ctx: AuthContext, resolved?: ResolvedLabels): Promise<void> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) {
    const L = resolved ?? await getResolvedLabels();
    throw new ApiError(403, L["daily_work.validation.owner_only"]);
  }
}

/**
 * Daily Work section reads normally belong to the SO/RM owner. A Super Admin may use the existing targeted
 * read path to inspect an officer's submitted day, but an untargeted Admin request must not become an owner
 * session. All mutation functions continue to use assertOwnerRole directly.
 */
async function assertReadRole(ctx: AuthContext, targetOfficerId?: string, resolved?: ResolvedLabels): Promise<void> {
  if (isAdministrativeRole(ctx.role) && targetOfficerId) return;
  await assertOwnerRole(ctx, resolved);
}

/** The officer whose Daily Work we operate on. SO/RM → themselves; the frontend never chooses another. */
function ownerId(ctx: AuthContext): string {
  return ctx.userId;
}

/**
 * Resolve which officer a READ targets. No target (or self) → the caller. A different officer is allowed only
 * for a read and only when that officer is within the caller's authorized scope (an RM viewing a team member;
 * Super Admin is scope-wide) — otherwise 403. Writes never use this: they always operate on the caller (ownerId).
 */
async function resolveReadOfficer(ctx: AuthContext, target?: string): Promise<string> {
  if (!target || target === ctx.userId) return ctx.userId;
  await assertOfficerInScope(ctx, target);
  return target;
}

type DailyWorkMode = "PLAN" | "REPORT";

/**
 * Calendar Daily Tasks due TODAY enter the owner's current editable batch when the owner opens Daily Work (plan view,
 * own data, today only — never a report/historical/admin read). Idempotent and independent of CN Auto Tasks.
 */
async function materializeCalendarForRead(ctx: AuthContext, officerId: string, workDate: string, mode: DailyWorkMode): Promise<void> {
  if (mode === "PLAN" && officerId === ctx.userId && workDate === currentBusinessDate()) await materializeDueCalendarTasks(ctx);
}
const parseDailyWorkMode = (value?: string): DailyWorkMode => value === "REPORT" ? "REPORT" : "PLAN";

/** Validate every dealerId is within the officer's permitted scope (assigned dealers). */
async function assertDealersInScope(officerId: string, dealerIds: string[], resolved?: ResolvedLabels): Promise<Set<string>> {
  const allowed = new Set(await getCurrentDealerIds(officerId));
  for (const id of dealerIds) if (!allowed.has(id)) {
    const L = resolved ?? await getResolvedLabels();
    throw new ApiError(403, L["daily_work.validation.dealer_not_assigned"]);
  }
  return allowed;
}

/**
 * Who a dealer may be planned FOR. A Sales Officer: their own current dealers. A Regional Manager: their own current dealers PLUS the current dealers of the active Sales Officers of
 * their OWN group (getOfficerScope — the group hierarchy, never the legacy RM assignment). Ownership is the dealer's CURRENT owner (the most recent open assignment). The task
 * still belongs to the caller's own Daily Plan / Report: nothing here reassigns a dealer or touches another officer's report.
 */
async function dealerOwnerScope(ctx: AuthContext, db?: Parameters<typeof getOfficerScope>[1]): Promise<string[]> {
  return (await getOfficerScope(ctx, db)).ids; // SO → [self]; RM → [self, active SOs of the RM's group]
}
/** The Sales Officers an RM may pick in Add Dealer: active, in the RM's group, alphabetical (My Dealers is the caller's own and is not listed here). */
async function dealerOwnerChoices(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  if (ctx.role !== Role.REGIONAL_MANAGER) return [];
  const ids = (await dealerOwnerScope(ctx)).filter((id) => id !== ctx.userId);
  if (ids.length === 0) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids }, role: Role.SALES_OFFICER, isActive: true, deletedAt: null }, select: { id: true, name: true } });
  return users.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}
/**
 * Dealers (of these) in the Daily Work of `officerId` whose CURRENT owner is another officer of the SAME group, when `officerId` is a Regional Manager: owner → dealer ids. One batched
 * query. A Sales Officer's day never has such dealers. Used for the sourced figures of those dealers (and any viewer authorized to read the RM's day sees the same figures).
 */
async function peerOwnedDealers(ctx: AuthContext, officerId: string, dealerIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (dealerIds.length === 0) return out;
  let rm: { userId: string; role: Role; groupId: string | null } | null = null;
  if (officerId === ctx.userId) rm = ctx.role === Role.REGIONAL_MANAGER ? { userId: ctx.userId, role: ctx.role, groupId: ctx.groupId ?? null } : null;
  else if (isAdministrativeRole(ctx.role)) { const u = await prisma.user.findUnique({ where: { id: officerId }, select: { role: true, groupId: true } }); if (u?.role === Role.REGIONAL_MANAGER) rm = { userId: officerId, role: u.role, groupId: u.groupId }; }
  if (!rm) return out;
  const [scope, owners] = await Promise.all([getOfficerScope(rm as unknown as AuthContext), getCurrentOwnerByDealer(dealerIds)]);
  for (const [dealerId, owner] of owners) if (owner !== officerId && scope.ids.includes(owner)) out.set(owner, [...(out.get(owner) ?? []), dealerId]);
  return out;
}
/**
 * Manual-entry eligibility, server side: a dealer that already has a row in the current batch keeps it; a NEW one must currently belong to the caller or (RM) to an authorized Sales
 * Officer, and a supplied owner id must be exactly that current owner. Browser-supplied ids are never trusted.
 */
async function assertDealersEligible(ctx: AuthContext, officerId: string, rows: readonly { dealerId: string; ownerId?: string }[], existing: ReadonlySet<string>, L: ResolvedLabels, db?: Parameters<typeof getOfficerScope>[1]): Promise<void> {
  const fresh = rows.filter((r) => !existing.has(r.dealerId));
  if (fresh.length === 0) return;
  const [scope, owners] = await Promise.all([dealerOwnerScope(ctx, db), getCurrentOwnerByDealer(fresh.map((r) => r.dealerId), db)]);
  for (const r of fresh) {
    const owner = owners.get(r.dealerId);
    if (!owner || !scope.includes(owner) || (r.ownerId !== undefined && (r.ownerId !== owner || !scope.includes(r.ownerId)))) throw new ApiError(403, L["daily_work.validation.dealer_not_assigned"]);
  }
  void officerId;
}

/* --------------------------------- Sourced figures --------------------------------- */

/**
 * Monthly Recovery Plan (Total Recovery Plan) + Actual Total Recovery per dealer, from the officer's most
 * recent active RecoveryPlan. Mirrors the Recovery Month View exactly:
 *   Total Recovery Plan   = monthRecoveryPlan + monthRunningRecovery
 *   Actual Total Recovery = liveRecovery + srCr − (due + overdue)   [= actualRunningRecovery]
 */
async function recoveryFiguresByDealer(officerId: string): Promise<{ map: Map<string, { plan: number; actual: number }>; monthName: string | null }> {
  const out = new Map<string, { plan: number; actual: number }>();
  const plan = await prisma.recoveryPlan.findFirst({
    where: { officerId, lifecycleState: "ACTIVE" },
    orderBy: [{ updatedAt: "desc" }],
    select: { id: true, seasonMonth: { select: { name: true } }, dealers: { select: { dealerId: true, monthRecoveryPlan: true, monthRunningRecovery: true, liveRecovery: true, srCr: true, due: true, overdue: true } } },
  });
  if (!plan) return { map: out, monthName: null };
  for (const d of plan.dealers) {
    const totalPlan = round2(num(d.monthRecoveryPlan) + num(d.monthRunningRecovery));
    const actual = round2(num(d.liveRecovery) + num(d.srCr) - (num(d.due) + num(d.overdue)));
    out.set(d.dealerId, { plan: totalPlan, actual });
  }
  return { map: out, monthName: plan.seasonMonth?.name ?? null };
}

/**
 * Current-month Monthly Sales Plan + Actual Sales per dealer — reuses the EXACT authoritative source the
 * Monthly Dealer Summary consumes (`getMonthly` → `buildMonthlyDealers`) and its calculation (`figuresForMode`),
 * so Daily Work never re-implements the plan/actual math and can never disagree with the Dealer Summary.
 *
 * For each dealer, for the CURRENT running month only:
 *   Monthly Sales Plan = Σ over product lines of figuresForMode(monthlyMode, monthly[cur].plan, rate, nbv%).amount
 *   Actual Sales       = Σ over product lines of monthly[cur].saleAmount   (uploaded sale value; never qty×rate)
 * `monthly[cur].plan` is the officer's monthly input in the active mode — a QUANTITY in PACK_SIZE/TOTAL_QUANTITY
 * mode (priced here at rate) or a VALUE in AMOUNT/NBV mode. The previous version summed the stored `planValue`
 * directly, which is null in quantity mode → it returned ₹0 for quantity-mode plans (the reported bug).
 */
async function salesFiguresByDealer(ctx: AuthContext, officerId: string, workDate: string): Promise<{ map: Map<string, { plan: number; actual: number }>; monthName: string | null }> {
  const map = new Map<string, { plan: number; actual: number }>();
  // Resolve the SAME seasonal plan the Monthly views open, using the app's canonical resolver
  // (APPROVED active-version, or an open-season in-progress plan) rather than a bespoke query.
  const planId = await resolveAddableSeasonalPlanId(prisma, officerId);
  if (!planId) return { map, monthName: monthNameForDate(workDate) };

  // The authoritative Monthly Dealer Summary source: GET /api/planning/season-plans/:id/monthly → getMonthly.
  // getMonthly is available only for the active APPROVED plan; if the resolved plan is a not-yet-approved
  // in-progress plan, there is no monthly data to show yet — return empty rather than surfacing its 409.
  let monthly: Awaited<ReturnType<typeof getMonthly>>;
  try {
    monthly = await getMonthly(ctx, planId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return { map, monthName: monthNameForDate(workDate) };
    throw e;
  }

  // Explicit year/month follows the Daily Work date, never the server clock or a name-only match.
  // This mirrors Monthly Dealer Summary's Aggregate = "Selected Months" with exactly ONE selected month.
  const monthName = monthNameForDate(workDate);
  let selected;
  try { selected = resolveWorkDateMonth(monthly.months, workDate); }
  catch (error) { throw new ApiError(422, (error as Error).message); }
  if (!selected) return { map, monthName };

  const mode = monthly.monthlyMode as PlanningMode;
  for (const d of monthly.dealers) {
    let planAmount = 0, actualAmount = 0;
    for (const p of d.products) {
      const cell = p.monthly[selected.id];
      if (!cell) continue;
      // Monthly Plan amount — the SAME figuresForMode(mode, plan-cell, rate, nbv%) the Dealer Summary uses.
      planAmount += figuresForMode(mode, cell.plan, p.rate, p.nbvPercent).amount ?? 0;
      // Actual Sales — the uploaded sale amount (saleValue), never qty×rate; identical to the Dealer Summary.
      actualAmount += cell.saleAmount ?? 0;
    }
    map.set(d.dealerId, { plan: round2(planAmount), actual: round2(actualAmount) });
  }
  return { map, monthName: selected.name };
}

/** Figures + resolved month name for a section — Sales reuses the Monthly Dealer Summary source + date-month. */
async function sourcedFigures(ctx: AuthContext, officerId: string, section: DailyWorkSection, workDate: string): Promise<{ map: Map<string, { plan: number; actual: number }>; monthName: string | null }> {
  if (section === "RECOVERY") return recoveryFiguresByDealer(officerId);
  return salesFiguresByDealer(ctx, officerId, workDate);
}

/**
 * Dealer-specific schemes that already participate in the application's recovery layer. Scheme Follow-up
 * and Payment Management both use `billFinancialScope`: an enrolled plan, or a plan with an Admin-verified
 * bill schedule. Reusing that scope prevents Daily Work from offering Scheme recovery for an unrelated
 * dealer while preserving partially verified plans that legitimately have recoverable installments.
 */
async function recoverySchemesByDealer(officerId: string): Promise<Map<string, DailyWorkSchemeOption[]>> {
  const rows = (await prisma.dealerSchemePlan.findMany({
    where: { salesOfficerId: officerId, ...billFinancialScope },
    select: { dealerId: true, schemeId: true, scheme: { select: { schemeName: true } } },
    orderBy: [{ scheme: { schemeName: "asc" } }],
  })) as { dealerId: string; schemeId: string; scheme: { schemeName: string } }[];

  const byDealer = new Map<string, DailyWorkSchemeOption[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.dealerId}:${row.schemeId}`;
    if (seen.has(key)) continue; // quantity-split segments still represent one dealer + scheme choice here
    seen.add(key);
    const options = byDealer.get(row.dealerId) ?? [];
    options.push({ id: row.schemeId, name: row.scheme.schemeName });
    byDealer.set(row.dealerId, options);
  }
  return byDealer;
}

/* --------------------------------- Scheme Conversion sourcing --------------------------------- */

/**
 * Planned schemes per (dealer, scheme) for the officer's own APPROVED scheme plans — the authoritative Scheme
 * Planning source. Reuses DealerSchemePlan + its unit accounting exactly as the Scheme-wise summary does:
 *   Planned Units   = Σ numberOfSchemes across the (dealer, scheme) segments (planStatus = APPROVED)
 *   Converted Units = Σ numberOfSchemes among those whose schemeStatus = CONVERTED
 *   Pending         = Planned − Converted (units; floored at 0)
 * No second planned-quantity or converted-quantity store is created; Achievability lives only in Daily Work.
 * Keyed by "dealerId" → list of that dealer's planned schemes.
 */
async function plannedSchemesByDealer(officerId: string): Promise<Map<string, PlannedSchemeOption[]>> {
  const rows = (await prisma.dealerSchemePlan.findMany({
    // Own plans only, and only APPROVED plans (a planned scheme, not a draft/returned/rejected one).
    where: { salesOfficerId: officerId, planStatus: "APPROVED" },
    select: { dealerId: true, schemeId: true, numberOfSchemes: true, schemeStatus: true, scheme: { select: { schemeName: true } } },
  })) as { dealerId: string; schemeId: string; numberOfSchemes: number; schemeStatus: string; scheme: { schemeName: string } }[];

  // Accumulate planned + converted units per (dealer, scheme).
  const acc = new Map<string, { dealerId: string; schemeId: string; schemeName: string; planned: number; converted: number }>();
  for (const r of rows) {
    const key = `${r.dealerId}:${r.schemeId}`;
    const units = effectiveProceedingSchemeUnits(r.numberOfSchemes || 1);
    const cur = acc.get(key) ?? { dealerId: r.dealerId, schemeId: r.schemeId, schemeName: r.scheme.schemeName, planned: 0, converted: 0 };
    cur.planned += units;
    if (r.schemeStatus === "CONVERTED") cur.converted += units;
    acc.set(key, cur);
  }

  const byDealer = new Map<string, PlannedSchemeOption[]>();
  for (const v of acc.values()) {
    const opt: PlannedSchemeOption = { schemeId: v.schemeId, schemeName: v.schemeName, plannedUnits: v.planned, convertedUnits: v.converted, pending: conversionPending(v.planned, v.converted) };
    const list = byDealer.get(v.dealerId) ?? [];
    list.push(opt);
    byDealer.set(v.dealerId, list);
  }
  for (const list of byDealer.values()) list.sort((a, b) => a.schemeName.localeCompare(b.schemeName));
  return byDealer;
}

/* --------------------------------- Existing daily rows (raw SQL) --------------------------------- */

interface DailyRow {
  id: string; batchId: string; dealerId: string | null; rowKey: string; typedDealerName: string | null; marketName: string | null;
  todaysPlan: string | null; todaysActual: string | null; resultStatus: string | null; entryType: string; schemeId: string | null; status: string;
  paymentMode: RecoveryPaymentMode | null;
  monthlyPlanId: string | null; marketId: string | null; resultEventId: string | null; reportedDealerName: string | null;
}
/** Current editable rows for PLAN, or every frozen immutable batch row for REPORT. */
async function loadDailyRows(officerId: string, section: DailyWorkSection, workDate: string, mode: DailyWorkMode): Promise<DailyRow[]> {
  const { day } = await readBatchContext(officerId, workDate);
  const rows = await prisma.$queryRaw<DailyRow[]>(Prisma.sql`
    SELECT "id", "batchId", "dealerId", "rowKey", "typedDealerName", "marketName",
           "todaysPlan"::text AS "todaysPlan", "todaysActual"::text AS "todaysActual", "resultStatus", "entryType", "schemeId", "status", "paymentMode",
           "monthlyPlanId", "marketId", "resultEventId", "reportedDealerName"
    FROM "DailyWorkEntry"
    WHERE "officerId" = ${officerId} AND "section" = ${section} AND "workDate" = ${workDate}::date
      AND ${mode === "PLAN"
        ? Prisma.sql`"batchId" = ${day.currentBatchId} AND "status" = 'DRAFT'`
        : Prisma.sql`"batchId" <> ${day.currentBatchId} AND "status" IN ('PLAN_SUBMITTED','FINALIZED','SUBMITTED')`}
    ORDER BY COALESCE("planSubmittedAt", "createdAt"), "createdAt", "id"`);
  return rows;
}

/** Existing CN contribution links are the authoritative source for the read-only Auto Task label. */
async function autoTaskEntryIdsForReport(officerId: string, entryIds: string[]): Promise<string[]> {
  if (entryIds.length === 0) return [];
  const rows = await prisma.$queryRaw<{ entryId: string }[]>(Prisma.sql`
    SELECT DISTINCT t."entryId"
    FROM (
      SELECT e."dailyWorkEntryId" AS "entryId", c."officerId"
      FROM "CnPaymentEvent" e JOIN "CnRequest" c ON c."id" = e."cnRequestId"
      WHERE e."dailyWorkEntryId" IN (${Prisma.join(entryIds)})
      UNION ALL
      SELECT c."legacyDailyWorkEntryId" AS "entryId", c."officerId"
      FROM "CnRequest" c
      WHERE c."legacyDailyWorkEntryId" IN (${Prisma.join(entryIds)})
    ) t
    WHERE t."officerId" = ${officerId} AND t."entryId" IS NOT NULL`);
  return rows.map((row) => row.entryId);
}

/** Σ of every automatic contribution (CN payment events, legacy CN, Billing Exception tasks) per Daily Work row. */
async function autoContributionByEntry(entryIds: string[]): Promise<Map<string, number>> {
  if (entryIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ entryId: string; contribution: string }>>(Prisma.sql`
    SELECT t."entryId", SUM(t."contribution")::text AS "contribution" FROM (
      SELECT "dailyWorkEntryId" AS "entryId", "dailyWorkContribution" AS "contribution" FROM "CnPaymentEvent" WHERE "dailyWorkEntryId" IS NOT NULL
      UNION ALL
      SELECT "legacyDailyWorkEntryId" AS "entryId", "legacyDailyWorkContribution" AS "contribution" FROM "CnRequest" WHERE "legacyDailyWorkEntryId" IS NOT NULL
      ${BILLING_CONTRIBUTION_UNION}
    ) t WHERE t."entryId" IN (${Prisma.join(entryIds)}) GROUP BY t."entryId"`);
  return new Map((rows ?? []).map((r) => [r.entryId, Number(r.contribution)]));
}

/** Read-path entry: separate any combined legacy draft rows of the officer's editable batch (own plan, under the day lock), exactly from their source links. */
async function splitCombinedDraftRowsForRead(officerId: string, workDate: string): Promise<number> {
  const { day } = await readBatchContext(officerId, workDate);
  if (day.status === "FINALIZED" || !(await hasCombinedDraftRows(officerId, workDate, day.currentBatchId))) return 0;
  return prisma.$transaction(async (tx) => splitCombinedDraftRows(tx, officerId, workDate, await lockDailyWorkDay(tx, officerId, workDate)), { timeout: 15_000 });
}

/* --------------------------------- Read --------------------------------- */

export async function getDailyWork(ctx: AuthContext, rawSection: string, rawDate?: string, targetOfficerId?: string, rawMode?: string): Promise<DailyWorkPayload> {
  await assertReadRole(ctx, targetOfficerId);
  // Only SALES/RECOVERY here; the two new sections have their own dedicated getters (different shapes).
  const section = (rawSection === "RECOVERY" ? "RECOVERY" : "SALES") as DailyWorkSection;
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const officerId = await resolveReadOfficer(ctx, targetOfficerId);
  const mode = parseDailyWorkMode(rawMode);

  // Persist due CN tasks before Recovery reads. Historical/admin report reads remain strictly read-only.
  if (section === "RECOVERY" && mode === "PLAN" && officerId === ctx.userId && workDate === currentBusinessDate()) {
    await materializeDueDailyWorkTasks(ctx);
  }

  await materializeCalendarForRead(ctx, officerId, workDate, mode);
  // Historical combined draft rows (one row for several scheduled tasks of a dealer) are separated into one row per task, exactly from their own source links.
  if (mode === "PLAN" && officerId === ctx.userId) await splitCombinedDraftRowsForRead(officerId, workDate);
  const [{ map: figures, monthName }, dailyRows, assignedIds, schemes, recoverySchemes, cnTasks] = await Promise.all([
    sourcedFigures(ctx, officerId, section, workDate),
    loadDailyRows(officerId, section, workDate, mode),
    getCurrentDealerIds(officerId),
    section === "SALES" ? runningSchemes(ctx) : Promise.resolve([]),
    section === "RECOVERY" ? recoverySchemesByDealer(officerId) : Promise.resolve(new Map<string, DailyWorkSchemeOption[]>()),
    // CN follow-up tasks the SO scheduled on THIS date (Recovery section only). Read-only; never mutates CN.
    section === "RECOVERY" ? cnTasksForOfficerDate(officerId, workDate) : Promise.resolve([] as CnTaskDto[]),
  ]);

  // A Regional Manager's rows may include dealers of their Sales Officers: their sourced figures (and Recovery schemes) come from THAT dealer's current owner — the existing
  // authoritative per-owner sources — one batched pass per owner, never one per dealer. Everything else is unchanged.
  const peers = await peerOwnedDealers(ctx, officerId, dailyRows.map((row) => row.dealerId).filter((id): id is string => !!id));
  await Promise.all([...peers].map(async ([owner, ids]) => {
    const [theirs, theirSchemes] = await Promise.all([sourcedFigures(ctx, owner, section, workDate), section === "RECOVERY" ? recoverySchemesByDealer(owner) : Promise.resolve(new Map<string, DailyWorkSchemeOption[]>())]);
    for (const id of ids) {
      const f = theirs.map.get(id); if (f) figures.set(id, f);
      const sc = theirSchemes.get(id); if (sc) recoverySchemes.set(id, sc);
    }
  }));
  // Names for every dealer we may show (assigned + any already-saved row). DISPLAY-only: prefer the dealer's
  // alias name when one exists (identity stays the dealer id everywhere below).
  const dealerIds = [...new Set([...assignedIds, ...dailyRows.map((row) => row.dealerId).filter((id): id is string => !!id)])];
  const [dealerRowsForNames, aliasNameMap] = await Promise.all([
    prisma.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true } }),
    loadDealerAliasNameMap(dealerIds),
  ]);
  const dealerNames = new Map(
    dealerRowsForNames.map((d) => [d.id, aliasNameMap.get(d.id) ?? d.name]),
  );

  const dealers: DailyWorkDealerDto[] = dailyRows
    .filter((r) => r.dealerId)
    .map((r): DailyWorkDealerDto => {
      const dealerId = r.dealerId!; // loadDailyRows only yields rows with a real dealerId
      const fig = figures.get(dealerId) ?? { plan: 0, actual: 0 };
      const pending = section === "SALES" ? salesPending(fig.plan, fig.actual) : recoveryPending(fig.plan, fig.actual);
      return {
        entryId: r.id,
        batchId: r.batchId,
        dealerId,
        dealerName: dealerNames.get(dealerId) ?? "—",
        monthlyPlan: fig.plan,
        actual: fig.actual,
        pending,
        todaysPlan: r.todaysPlan == null ? null : num(r.todaysPlan),
        todaysActual: r.todaysActual == null ? null : num(r.todaysActual),
        entryType: (r.entryType as DailyWorkType) ?? "REGULAR",
        // Daily Report is the only source of truth: the Daily Plan never reads or shows Payment Mode.
        ...(section === "RECOVERY" && mode === "REPORT" ? { paymentMode: r.paymentMode ?? null } : {}),
        schemeId: r.schemeId,
        rowKind: isTaskRowKey(r.rowKey) ? "TASK" : "MANUAL",
        status: (r.status as DailyWorkDealerDto["status"]) ?? "DRAFT",
      };
    })
    // Same dealer: its scheduled tasks first (in the order they were scheduled), then its one directly entered manual task. Array.sort is stable.
    .sort((a, b) => a.dealerName.localeCompare(b.dealerName) || (a.rowKind === b.rowKind ? 0 : a.rowKind === "TASK" ? -1 : 1));

  // The ONE directly entered manual task per dealer / date / section: only a MANUAL row (or one in an earlier submitted batch) uses the slot — scheduled and rescheduled tasks never do.
  const batchContext = mode === "PLAN" ? await readBatchContext(officerId, workDate) : null;
  const manualDealerIds = batchContext ? await submittedManualDealerIds(prisma, officerId, section, workDate, batchContext.day.currentBatchId) : [];
  // The dropdown lists every dealer whose slot is free in SUBMITTED batches; the editor additionally hides dealers with a manual row it is currently holding (so a removed draft row reappears at once).
  const usedIds = new Set(manualDealerIds);
  const availableDealers = mode === "REPORT" ? [] : assignedIds
    .filter((id) => !usedIds.has(id))
    .map((id) => {
      const fig = figures.get(id) ?? { plan: 0, actual: 0 };
      const pending = section === "SALES" ? salesPending(fig.plan, fig.actual) : recoveryPending(fig.plan, fig.actual);
      return { id, name: dealerNames.get(id) ?? "—", monthlyPlan: fig.plan, actual: fig.actual, pending };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const materializedCnTasks = section === "RECOVERY" && mode === "PLAN"
    ? await materializedCnTasksForEntries(officerId, dailyRows.map((row) => row.id))
    : [];
  const calendarEntryIds = await calendarLinkedEntryIds(dailyRows.map((row) => row.id));
  const [billingTasks, billingLinked] = section === "RECOVERY"
    ? await Promise.all([mode === "PLAN" ? billingTasksForEntries(officerId, dailyRows.map((row) => row.id), workDate) : Promise.resolve([] as BillingTaskDto[]), billingLinkedEntryIds(dailyRows.map((row) => row.id))])
    : [[] as BillingTaskDto[], [] as string[]];
  // Daily REPORT: the identifiable tasks inside each submitted row, each with its own outcome (a legacy row carries none). A task rescheduled by a submitted report is no longer linked
  // to its old row, so the frozen outcome rows keep that row's Billing / CN identity visible.
  const units = new Map<string, Awaited<ReturnType<typeof readRowUnits>> extends Map<string, infer V> ? V : never>();
  if (mode === "REPORT") {
    const facts: EntryFacts[] = dailyRows.filter((r) => r.dealerId).map((r) => ({ id: r.id, officerId, workDate, section, dealerId: r.dealerId, todaysPlan: r.todaysPlan == null ? 0 : num(r.todaysPlan), todaysActual: r.todaysActual == null ? null : num(r.todaysActual), entryType: r.entryType, schemeId: r.schemeId }));
    for (const [id, u] of await readRowUnits(prisma, facts)) units.set(id, u);
    for (const d of dealers) { const u = units.get(d.entryId); d.tasks = u?.units ?? []; d.legacyOutcome = u?.legacy ?? false; }
  }
  const unitsOf = (entryId: string) => units.get(entryId)?.units ?? [];
  const billingEntryIds = [...new Set([...billingLinked, ...dailyRows.filter((r) => unitsOf(r.id).some((u) => u.source === "BILLING_EXCEPTION")).map((r) => r.id)])];
  const reschedIds = await rescheduledEntryIds(prisma, dailyRows.map((r) => ({ id: r.id, workDate })));
  const cnLinkedIds = section === "RECOVERY" ? [...new Set([...(await autoTaskEntryIdsForReport(officerId, dailyRows.map((row) => row.id))), ...dailyRows.filter((r) => unitsOf(r.id).some((u) => u.source === "CN_REQUEST")).map((r) => r.id)])] : [];
  // Task Type "Auto" (Daily Report / review views) = any system-generated contribution: a CN follow-up OR a Billing Exception task.
  const autoTaskEntryIds = section === "RECOVERY" && mode === "REPORT" ? [...new Set([...cnLinkedIds, ...billingEntryIds])] : [];
  for (const d of dealers) if (d.rowKind === "TASK") d.amountLocked = true;
  if (section === "RECOVERY") {
    const billingSet = new Set(billingEntryIds), cnSet = new Set(cnLinkedIds);
    const contributions = await autoContributionByEntry(dealers.map((d) => d.entryId));
    for (const d of dealers) {
      d.recoverySource = recoverySourceOf(billingSet.has(d.entryId), cnSet.has(d.entryId));
      const auto = contributions.get(d.entryId) ?? 0;
      d.autoContribution = auto;
      // A task's own row is fixed (amount, type, source); only a legacy combined row with a manual part on top keeps that part editable.
      d.amountLocked = d.rowKind === "TASK" || (auto > 0 && (d.todaysPlan ?? 0) <= auto + 0.005);
    }
  }

  return {
    section,
    workDate,
    monthName,
    canEnterActual: mode === "REPORT" && dealers.some((d) => d.status !== "DRAFT"),
    availableDealers,
    manualDealerIds,
    canPickDealerOwner: ctx.role === Role.REGIONAL_MANAGER && officerId === ctx.userId && mode === "PLAN",
    applicableSchemes: (schemes as { id: string; schemeName: string }[]).map((s) => ({ id: s.id, name: s.schemeName })),
    applicableSchemesByDealer: Object.fromEntries(recoverySchemes),
    cnTasks,
    materializedCnTasks,
    autoTaskEntryIds,
    calendarEntryIds,
    billingTasks,
    billingEntryIds,
    rescheduledEntryIds: reschedIds,
    dealers,
  };
}

/* --------------------------------- Report date + late-submission requests --------------------------------- */

/**
 * The date a Daily Report read / write targets. Today and yesterday work as before (yesterday keeps its previous-rule window). Any OLDER exact date is honoured only for the caller's own
 * outstanding report (or one they have a late-submission request for) — it is never silently turned into today, and every other older date is refused explicitly.
 */
export async function resolveReportDateForOwner(ctx: AuthContext, requested: unknown): Promise<string> {
  const today = currentBusinessDate(dailyWorkClock.now());
  if (typeof requested !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(requested) || requested >= today || requested === previousBusinessDate(today)) {
    return typeof requested === "string" && requested === previousBusinessDate(today) ? requested : today;
  }
  if (ctx.role === Role.SALES_OFFICER) {
    const o = await outstandingReport(prisma, ctx.userId, today);
    if (o?.date === requested) return requested;
    const asked = await prisma.$queryRaw<{ n: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM "LateReportRequest" WHERE "officerId" = ${ctx.userId} AND "workDate" = ${requested}::date) AS "n"`);
    if (asked[0]?.n) return requested;
  }
  throw new ApiError(403, (await getResolvedLabels())["daily_work.validation.report_date_unavailable"]);
}
export async function requestLateReport(ctx: AuthContext, raw: unknown): Promise<LateRequestDto> { return createLateReportRequest(ctx, raw, await getResolvedLabels()); }
export async function listLateReportRequests(ctx: AuthContext, view: string | null): Promise<LateRequestDto[]> { return listLateRequests(ctx, view === "history" ? "history" : "pending", await getResolvedLabels()); }
export async function decideLateReport(ctx: AuthContext, id: string, raw: unknown): Promise<LateRequestDto> { return decideLateReportRequest(ctx, id, raw, await getResolvedLabels()); }

/* --------------------------------- Add Dealer choices (Sales / Recovery) --------------------------------- */

export interface DealerChoicesPayload {
  section: DailyWorkSection;
  /** Regional Manager only: the active Sales Officers of the RM's own group (alphabetical). "My Dealers" is the caller's own and is selected by default. Empty for everyone else. */
  owners: { id: string; name: string }[];
  /** The owner whose dealers are listed: the caller (My Dealers) or an authorized Sales Officer. */
  ownerId: string;
  /** That owner's CURRENT dealers (deduplicated by id) that can still get the caller's ONE directly entered manual task for today in this section, with their sourced figures. */
  dealers: DailyWorkAvailableDealer[];
}

/**
 * The Add Dealer list for ONE owner at a time (never everyone's dealers combined). A forged owner id — anyone but the caller or an active Sales Officer of the caller's group — is
 * refused; the dealers are the owner's CURRENT ones (most recent open assignment) and their figures come from that owner's own authoritative sources. The Sales Officer choice only
 * filters this list: the task added later belongs to the caller's own Daily Plan.
 */
export async function getDealerChoices(ctx: AuthContext, rawSection: string, rawOwnerId?: string | null): Promise<DealerChoicesPayload> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const section = (rawSection === "RECOVERY" ? "RECOVERY" : "SALES") as DailyWorkSection;
  const workDate = currentBusinessDate();
  const owners = await dealerOwnerChoices(ctx);
  const requested = (rawOwnerId ?? "").trim();
  const ownerIdChosen = requested === "" ? ctx.userId : requested;
  if (ownerIdChosen !== ctx.userId && !owners.some((o) => o.id === ownerIdChosen)) throw new ApiError(403, L["daily_work.validation.dealer_not_assigned"]);
  const { day } = await readBatchContext(ctx.userId, workDate);
  const [assigned, taken, mine, fig] = await Promise.all([
    getCurrentDealerIds(ownerIdChosen),
    submittedManualDealerIds(prisma, ctx.userId, section, workDate, day.currentBatchId),
    prisma.dailyWorkEntry.findMany({ where: { officerId: ctx.userId, workDate: new Date(`${workDate}T00:00:00.000Z`), batchId: day.currentBatchId, section, dealerId: { not: null }, NOT: { rowKey: { startsWith: "t:" } } }, select: { dealerId: true } }),
    sourcedFigures(ctx, ownerIdChosen, section, workDate),
  ]);
  const used = new Set([...taken, ...mine.map((r) => r.dealerId!)]);
  const ids = [...new Set(assigned)].filter((id) => !used.has(id));
  const [rows, alias] = await Promise.all([ids.length ? prisma.dealer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : Promise.resolve([]), loadDealerAliasNameMap(ids)]);
  const dealers = rows.map((d) => {
    const f = fig.map.get(d.id) ?? { plan: 0, actual: 0 };
    const pending = section === "SALES" ? salesPending(f.plan, f.actual) : recoveryPending(f.plan, f.actual);
    return { id: d.id, name: alias.get(d.id) ?? d.name, monthlyPlan: f.plan, actual: f.actual, pending };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { section, owners, ownerId: ownerIdChosen, dealers };
}

/* --------------------------------- Save Draft --------------------------------- */

/**
 * Persist the officer's daily rows for one section+date as DRAFT — the payload is the complete set for that
 * (officer, section, date): rows not present are removed, so add/remove/edit persist together atomically.
 * Scheme rows must carry a valid applicable scheme id. Monthly plan / pending / actuals are NEVER written.
 */
export async function saveDailyWork(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { section, workDate, rows } = dailyWorkSchemas(L).save.parse(raw);
  const officerId = ownerId(ctx);
  // No duplicate dealer rows within the payload.
  const seen = new Set<string>();
  for (const r of rows) { if (seen.has(r.dealerId)) throw new ApiError(422, L["daily_work.validation.duplicate_dealer"]); seen.add(r.dealerId); }

  // Sales uses OPEN in-group schemes. Recovery uses the existing dealer-specific financial/recovery scope.
  const schemeRows = rows.filter((r) => r.entryType === "SCHEME");
  if (schemeRows.length > 0) {
    const salesApplicable = section === "SALES" ? new Set((await runningSchemes(ctx)).map((s) => s.id)) : null;
    const recoveryApplicable = section === "RECOVERY" ? await recoverySchemesByDealer(officerId) : null;
    // A Sales Officer's dealer added by their RM: its Recovery schemes come from that dealer's owner (batched per owner).
    if (recoveryApplicable) for (const [owner, ids] of await peerOwnedDealers(ctx, officerId, schemeRows.map((r) => r.dealerId))) {
      const theirs = await recoverySchemesByDealer(owner);
      for (const id of ids) { const sc = theirs.get(id); if (sc) recoveryApplicable.set(id, sc); }
    }
    for (const r of schemeRows) {
      if (!r.schemeId) throw new ApiError(422, L["daily_work.validation.select_sales_scheme"]);
      const applicable = salesApplicable?.has(r.schemeId)
        ?? recoveryApplicable?.get(r.dealerId)?.some((s) => s.id === r.schemeId)
        ?? false;
      if (!applicable) throw new ApiError(422, L["daily_work.validation.scheme_not_applicable"]);
    }
  }

  const keepIds = rows.map((r) => r.dealerId);
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertPlanWritable(tx, ctx, workDate, L); // a Sales Officer with an unfinished earlier report cannot create / edit / save / submit a new plan
    // The payload carries ONLY the dealer's directly entered manual rows. Scheduled tasks (Billing Exception, CN, Calendar) own their rows: they are neither written nor removed
    // here, so saving or deleting the manual row can never touch a scheduled task — and a stale editor can never bring a rescheduled task's amount back.
    await splitCombinedDraftRows(tx, officerId, workDate, day);
    // Eligibility (a NEW dealer must currently belong to the caller or — RM — to an authorized Sales Officer of their group; a supplied owner id must be that owner). Dealers
    // already in this batch keep their row. The row itself always belongs to the caller's own Daily Plan.
    const inBatch = new Set((await tx.$queryRaw<Array<{ dealerId: string }>>(Prisma.sql`SELECT "dealerId" FROM "DailyWorkEntry" WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId} AND "section" = ${section} AND "rowKey" NOT LIKE 't:%' AND "dealerId" IS NOT NULL`)).map((r) => r.dealerId));
    await assertDealersEligible(ctx, officerId, rows, inBatch, L, tx);
    // ONE directly entered manual task per dealer / date / section — across every planning batch of the date (the day lock serializes concurrent requests).
    const taken = new Set(await submittedManualDealerIds(tx, officerId, section, workDate, day.currentBatchId));
    for (const r of rows) if (taken.has(r.dealerId)) throw new ApiError(409, L["daily_work.validation.manual_task_exists"]);
    // Replace-set of the manual rows only (task rows are never deleted by a save).
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "section" = ${section} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId} AND "status" = 'DRAFT' AND "rowKey" NOT LIKE 't:%'
      ${keepIds.length > 0 ? Prisma.sql`AND "dealerId" NOT IN (${Prisma.join(keepIds)})` : Prisma.empty}`);

    for (const r of rows) {
      const todaysPlan = r.todaysPlan == null ? Prisma.sql`NULL` : Prisma.sql`${r.todaysPlan}`;
      const schemeId = r.entryType === "SCHEME" ? r.schemeId! : null;
      // Upsert on the unique (officer, workDate, batch, section, rowKey); the manual row's rowKey is the dealer id.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","todaysPlan","entryType","schemeId","status","createdAt","updatedAt")
        VALUES (${randomUUID()}, ${officerId}, ${r.dealerId}, ${r.dealerId}, ${workDate}::date, ${day.currentBatchId}, ${section}, ${todaysPlan}, ${r.entryType}, ${schemeId}, 'DRAFT', NOW(), NOW())
        ON CONFLICT ("officerId","workDate","batchId","section","rowKey")
        DO UPDATE SET "todaysPlan" = EXCLUDED."todaysPlan", "entryType" = EXCLUDED."entryType", "schemeId" = EXCLUDED."schemeId", "updatedAt" = NOW()`);
    }
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `${section}:${workDate}`, summary: `Saved ${rows.length} daily ${section.toLowerCase()} row(s)` }, tx);
    return { count: rows.length };
  });
}

/* --------------------------------- Submit --------------------------------- */

/** Legacy per-section submit boundary. Batches are submitted only through submitDailyWorkDay. */
export async function submitDailyWork(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  dailyWorkSchemas(L).save.parse(raw);
  throw new ApiError(409, L["daily_work.validation.section_submit_removed"]);
}

/* --------------------------------- Today's Actual (post-submit) --------------------------------- */

/**
 * Enter Today's Sales / Today's Recovery on the exact PLAN_SUBMITTED entry. A current DRAFT, finalized row,
 * foreign entry, or missing row is rejected, so duplicate dealers across batches remain independent.
 */
export async function enterDailyActual(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { section, workDate, entries } = dailyWorkSchemas(L).actual.parse(raw);
  const officerId = ownerId(ctx);
  if (entries.length === 0) return { count: 0 };

  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertReportWritable(tx, officerId, workDate, L);
    let count = 0;
    for (const e of entries) {
      // Payment Mode describes a RECEIVED amount: no recovery (<= 0) means no mode, whatever the client sent. Otherwise an explicit
      // value (or explicit null) is stored; an absent key (older client / Sales) leaves the stored value untouched.
      const mode = section !== "RECOVERY" ? undefined : e.todaysActual <= 0 ? null : "paymentMode" in e ? e.paymentMode ?? null : undefined;
      const n = await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry" SET "todaysActual" = ${e.todaysActual}${mode !== undefined ? Prisma.sql`, "paymentMode" = ${mode}` : Prisma.empty}, "updatedAt" = NOW()
        WHERE "id" = ${e.entryId} AND "officerId" = ${officerId} AND "section" = ${section}
          AND "workDate" = ${workDate}::date AND "batchId" <> ${day.currentBatchId} AND "status" = 'PLAN_SUBMITTED'`);
      count += Number(n);
    }
    if (count === 0) throw new ApiError(409, L["daily_work.validation.actuals_after_submit"]);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `${section}:${workDate}`, summary: `Entered actuals for ${count} daily ${section.toLowerCase()} row(s)` }, tx);
    return { count };
  });
}

/**
 * Daily Report → Sales / Recovery: record the officer's task OUTCOMES (Completed + positive Actual | Not Completed — Reschedule + future date | Abandon + reason) on the exact
 * PLAN_SUBMITTED rows. This is a DRAFT write: choices are stored (incomplete ones allowed), the row's `todaysActual` is derived from them, and NOTHING is rescheduled, abandoned or
 * paid until the report itself is submitted (commitTaskOutcomes). Replaces entering an Actual amount directly; a forged task id never matches the caller's own rows (409).
 */
export async function enterTaskOutcomes(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { section, workDate, entries } = dailyWorkSchemas(L).outcomes.parse(raw);
  const officerId = ownerId(ctx);
  if (entries.length === 0) return { count: 0 };
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertReportWritable(tx, officerId, workDate, L);
    const today = currentBusinessDate();
    // Lock and authorize all submitted rows together; never perform the task-source lookup per row.
    const rows = await tx.$queryRaw<{ id: string; dealerId: string | null; todaysPlan: string | null; todaysActual: string | null; entryType: string; schemeId: string | null }[]>(Prisma.sql`
      SELECT "id", "dealerId", "todaysPlan"::text AS "todaysPlan", "todaysActual"::text AS "todaysActual", "entryType", "schemeId" FROM "DailyWorkEntry"
      WHERE "id" IN (${Prisma.join([...new Set(entries.map((e) => e.entryId))])}) AND "officerId" = ${officerId} AND "section" = ${section}
        AND "workDate" = ${workDate}::date AND "batchId" <> ${day.currentBatchId} AND "status" = 'PLAN_SUBMITTED'
      ORDER BY "id" FOR UPDATE`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const drafts = entries.flatMap((e) => {
      const row = byId.get(e.entryId);
      if (!row) return []; // not the caller's submitted row (or already finalized): nothing to write
      const entry: EntryFacts = { id: row.id, officerId, workDate, section, dealerId: row.dealerId, todaysPlan: row.todaysPlan == null ? 0 : num(row.todaysPlan), todaysActual: row.todaysActual == null ? null : num(row.todaysActual), entryType: row.entryType, schemeId: row.schemeId };
      return [{ entry, inputs: e.units, ...("paymentMode" in e ? { paymentMode: e.paymentMode } : {}) }];
    });
    const count = await writeOutcomeDraftBatch(tx, drafts, today, L as Record<string, string>);
    if (count === 0 && entries.some((e) => e.units.length > 0)) throw new ApiError(409, L["daily_work.validation.actuals_after_submit"]);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `${section}:${workDate}`, summary: `Saved task outcomes (draft) for ${entries.length} daily ${section.toLowerCase()} row(s)` }, tx);
    return { count };
  });
}

/* --------------------------------- Combined (server-side mirror of the UI summary) --------------------------------- */

/** Derive the combined summary for a payload's dealers — same math the UI uses (exported for reuse/tests). */
export function combineDailyWork(dealers: DailyWorkDealerDto[]) {
  const rows: DailyWorkDealerRow[] = dealers.map((d) => ({
    dealerId: d.dealerId, monthlyPlan: d.monthlyPlan, actual: d.actual, pending: d.pending, todaysPlan: d.todaysPlan ?? 0, todaysActual: d.todaysActual ?? 0, type: d.entryType,
  }));
  return combineDailyWorkRows(rows);
}

/* =====================================================================================
 * SECTION 3 — DEALER APPOINTMENT (connected to the owner's APPROVED Monthly Party Planning)
 *
 * Daily Plan: the officer picks MARKETS from their own approved Monthly Party Planning entries of the calendar month/year of the Daily Work date (entry-level approval
 * APPROVED — not the parent sheet's status —, season open, owner = the officer; never draft / submitted / rejected entries, other officers' plans or other months).
 * Each row stores the stable PartyMonthlyPlan id (+ market id, with the market name as a display snapshot); rowKey = the plan id, so the existing unique key makes a
 * second selection of the same entry in one planning batch impossible.
 * Monthly Dealer Plan / Pending are the monthly COUNTS in appointmentMonthlyTotals (unique markets; Pending excludes terminal Appointed / Rejected). They are payload-level
 * totals shown in the summary row — never repeated and summed per row.
 * Daily Report: the result is Appointed / Not Appointed (no default). Not Appointed only saves the Daily Work result. Appointed runs the owner's monthly "Doc Send By SO"
 * transition and saves the result in ONE transaction (recordAppointedResult) — it never creates a dealer, never bypasses Admin receipt / approval, and a document submission
 * is not a final appointment. Legacy typed rows (and calendar-generated ones) stay readable and keep their old behaviour; they are never matched to a plan by name.
 * ===================================================================================== */

type EligibleMarket = { monthlyPlanId: string; marketId: string; marketName: string; monthlyStatus: string };
/** The officer's approved Monthly Party Planning entries for the calendar month of `workDate` (the ONE eligibility rule for the selector, the totals and the save). */
async function eligibleMonthlyMarkets(officerId: string, workDate: string, db: Pick<typeof prisma, "partyMonthlyPlan"> = prisma): Promise<EligibleMarket[]> {
  if (!isPartyPlanningEnabled()) return []; // Party Planning switched off (PARTY_PLANNING_ENABLED): there is no approved monthly plan to plan from
  const [year, month] = workDate.split("-").map(Number) as [number, number];
  const plans = await db.partyMonthlyPlan.findMany({
    where: { ownerId: officerId, approvalStatus: "APPROVED", season: { status: "OPEN" }, seasonMonth: { calendarYear: year, calendarMonth: month } },
    select: { id: true, marketId: true, marketNameAtPlanning: true, opStatus: true },
    orderBy: [{ marketNameAtPlanning: "asc" }, { id: "asc" }],
  });
  return plans.map((p) => ({ monthlyPlanId: p.id, marketId: p.marketId, marketName: p.marketNameAtPlanning, monthlyStatus: p.opStatus }));
}

/** Read the officer's Dealer Appointment rows for a date (+ the eligible markets and the monthly totals). */
export async function getDailyAppointment(ctx: AuthContext, rawDate?: string, targetOfficerId?: string, rawMode?: string): Promise<AppointmentPayload> {
  await assertReadRole(ctx, targetOfficerId);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const apptOfficerId = await resolveReadOfficer(ctx, targetOfficerId);
  await materializeCalendarForRead(ctx, apptOfficerId, workDate, parseDailyWorkMode(rawMode));
  const entries = (await loadDailyRows(apptOfficerId, "APPOINTMENT", workDate, parseDailyWorkMode(rawMode)))
    // Old submitted placeholders carry no appointment and must never manufacture a required result.
    .filter((r) => parseDailyWorkMode(rawMode) !== "REPORT" || r.monthlyPlanId || (r.typedDealerName ?? "").trim() || (r.marketName ?? "").trim());
  const partyPlanningEnabled = await getAppointmentPartyPlanningEnabled();
  const eligibleMarkets = partyPlanningEnabled ? await eligibleMonthlyMarkets(apptOfficerId, workDate) : [];
  const linkedIds = [...new Set(entries.map((r) => r.monthlyPlanId).filter((id): id is string => !!id))];
  const linked = partyPlanningEnabled && linkedIds.length ? await prisma.partyMonthlyPlan.findMany({ where: { id: { in: linkedIds } }, select: { id: true, opStatus: true } }) : [];
  const monthlyStatus = new Map(linked.map((p) => [p.id, p.opStatus]));
  const totals = appointmentMonthlyTotals(eligibleMarkets.map((m) => ({ marketId: m.marketId, opStatus: m.monthlyStatus })));
  const rows: AppointmentRowDto[] = entries.map((r) => ({
    entryId: r.id,
    batchId: r.batchId,
    rowId: r.rowKey,
    monthlyPlanId: r.monthlyPlanId ?? null,
    marketId: r.marketId ?? null,
    marketName: r.marketName ?? "",
    dealerName: r.typedDealerName ?? "",
    legacy: !r.monthlyPlanId && (!partyPlanningEnabled || !!((r.typedDealerName ?? "").trim() || (r.marketName ?? "").trim())),
    monthlyStatus: r.monthlyPlanId ? monthlyStatus.get(r.monthlyPlanId) ?? null : null,
    resultEventId: r.resultEventId ?? null,
    reportedDealerName: r.resultStatus === "APPOINTED" ? r.reportedDealerName ?? "" : "",
    status: (r.resultStatus as "APPOINTED" | "NOT_APPOINTED" | null) ?? null,
    rowStatus: (r.status as AppointmentRowDto["rowStatus"]) ?? "DRAFT",
  }));
  return {
    section: "APPOINTMENT", workDate, partyPlanningEnabled, canEnterStatus: parseDailyWorkMode(rawMode) === "REPORT" && rows.some((r) => r.rowStatus !== "DRAFT"),
    eligibleMarkets, monthlyDealerPlan: totals.monthlyDealerPlan, pending: totals.pending, rows, calendarEntryIds: await calendarLinkedEntryIds(entries.map((r) => r.id)),
  };
}

/**
 * Persist the officer's Dealer Appointment rows for a date as DRAFT (replace-set, atomic). A new row names a Monthly Party Planning entry (`monthlyPlanId`), which must be one of the
 * officer's own eligible entries for the month of the date; the market identity / name come from that entry, never from the browser. Legacy typed rows (existing drafts and
 * calendar-generated tasks) can only be echoed back unchanged while the connection is ON. OFF restores manual creation/editing without monthly side effects.
 */
export async function saveDailyAppointment(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, rows, partyPlanningEnabled: expectedMode } = dailyWorkSchemas(L).appointmentSave.parse(raw);
  const officerId = ownerId(ctx);

  // One selection per entry (rowKey = the plan id) and unique row ids within the payload.
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.monthlyPlanId || r.rowId;
    if (seen.has(key)) throw new ApiError(422, L["daily_work.validation.duplicate_appointment"]);
    seen.add(key);
  }
  const linkedRows = rows.filter((r) => r.monthlyPlanId);
  const legacyRows = rows.filter((r) => !r.monthlyPlanId);

  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertPlanWritable(tx, ctx, workDate, L); // a Sales Officer with an unfinished earlier report cannot create / edit / save / submit a new plan
    const partyPlanningEnabled = await getAppointmentPartyPlanningEnabled(tx);
    if (expectedMode !== undefined && expectedMode !== partyPlanningEnabled) throw new ApiError(409, L["daily_work.validation.appointment_mode_changed"]);
    // The current server setting controls NEW rows. Stored links never become typed rows (or vice versa).
    const existing = await tx.$queryRaw<{ rowKey: string; typedDealerName: string | null; marketName: string | null; monthlyPlanId: string | null }[]>(Prisma.sql`
      SELECT "rowKey", "typedDealerName", "marketName", "monthlyPlanId" FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "section" = 'APPOINTMENT' AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId} AND "status" = 'DRAFT'`);
    const legacyExisting = new Map(existing.filter((e) => !e.monthlyPlanId).map((e) => [e.rowKey, e]));
    for (const r of legacyRows) {
      const was = legacyExisting.get(r.rowId);
      if (existing.some((e) => e.rowKey === r.rowId && e.monthlyPlanId)) throw new ApiError(409, L["daily_work.validation.appointment_mode_changed"]);
      if (partyPlanningEnabled) {
        // An explicitly added, unselected market may be saved as an empty draft placeholder. It is
        // editable as a selector on reload and can never pass submit. Typed legacy data stays unchanged.
        if (was ? (was.typedDealerName ?? "") !== r.dealerName || (was.marketName ?? "") !== r.marketName : !!(r.dealerName || r.marketName)) throw new ApiError(422, L["daily_work.validation.appointment_market_required"]);
      }
    }
    if (!partyPlanningEnabled) {
      // Previously linked rows can be kept unchanged while OFF, but stale clients cannot create new links.
      for (const r of linkedRows) if (!existing.some((e) => e.monthlyPlanId === r.monthlyPlanId && e.rowKey === r.monthlyPlanId)) throw new ApiError(409, L["daily_work.validation.appointment_connection_disabled"]);
    }
    const keep = [...linkedRows.map((r) => r.monthlyPlanId!), ...legacyRows.map((r) => r.rowId)];
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "section" = 'APPOINTMENT' AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
      ${keep.length > 0 ? Prisma.sql`AND "rowKey" NOT IN (${Prisma.join(keep)})` : Prisma.empty}`);
    if (partyPlanningEnabled && linkedRows.length > 0) {
      const eligible = new Map((await eligibleMonthlyMarkets(officerId, workDate, tx)).map((m) => [m.monthlyPlanId, m]));
      for (const r of linkedRows) {
        const m = eligible.get(r.monthlyPlanId!);
        if (!m) throw new ApiError(422, L["daily_work.validation.appointment_market_not_eligible"]);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","typedDealerName","marketName","monthlyPlanId","marketId","status","createdAt","updatedAt")
          VALUES (${randomUUID()}, ${officerId}, NULL, ${m.monthlyPlanId}, ${workDate}::date, ${day.currentBatchId}, 'APPOINTMENT', NULL, ${m.marketName}, ${m.monthlyPlanId}, ${m.marketId}, 'DRAFT', NOW(), NOW())
          ON CONFLICT ("officerId","workDate","batchId","section","rowKey")
          DO UPDATE SET "marketName" = EXCLUDED."marketName", "marketId" = EXCLUDED."marketId", "monthlyPlanId" = EXCLUDED."monthlyPlanId", "updatedAt" = NOW()`);
      }
    }
    for (const r of legacyRows) {
      if (!partyPlanningEnabled || (!r.dealerName && !r.marketName)) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","typedDealerName","marketName","status","createdAt","updatedAt")
          VALUES (${randomUUID()}, ${officerId}, NULL, ${r.rowId}, ${workDate}::date, ${day.currentBatchId}, 'APPOINTMENT', ${r.dealerName}, ${r.marketName || null}, 'DRAFT', NOW(), NOW())
          ON CONFLICT ("officerId","workDate","batchId","section","rowKey")
          DO UPDATE SET "typedDealerName" = EXCLUDED."typedDealerName", "marketName" = EXCLUDED."marketName", "updatedAt" = NOW()`);
      }
    }
    // In connected mode, legacy rows stay unchanged; names are never used to infer a monthly link.
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `APPOINTMENT:${workDate}`, summary: `Saved ${rows.length} dealer appointment market row(s)` }, tx);
    return { count: rows.length };
  });
}

/** Legacy per-section submit boundary. Batches are submitted only through submitDailyWorkDay. */
export async function submitDailyAppointment(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  dailyWorkSchemas(L).appointmentSave.parse(raw);
  throw new ApiError(409, L["daily_work.validation.section_submit_removed"]);
}

/** Set Appointed / Not Appointed on an exact PLAN_SUBMITTED appointment entry. */
export async function enterAppointmentStatus(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, entries } = dailyWorkSchemas(L).appointmentStatus.parse(raw);
  const officerId = ownerId(ctx);
  if (entries.length === 0) return { count: 0 };
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertReportWritable(tx, officerId, workDate, L);
    const partyPlanningEnabled = await getAppointmentPartyPlanningEnabled(tx);
    let count = 0, matched = 0;
    for (const e of entries) {
      // A LINKED row's result is protected: "Appointed" can only be recorded by recordAppointedResult (it needs the monthly transition), so this generic save (and any stale
      // autosave) can never submit an unverified Appointed, and an Appointed result that initiated a monthly status event can never be silently reversed.
      const row = (await tx.$queryRaw<{ monthlyPlanId: string | null; resultStatus: string | null; resultEventId: string | null }[]>(Prisma.sql`
        SELECT "monthlyPlanId", "resultStatus", "resultEventId" FROM "DailyWorkEntry"
        WHERE "id" = ${e.entryId} AND "officerId" = ${officerId} AND "section" = 'APPOINTMENT' AND "workDate" = ${workDate}::date AND "batchId" <> ${day.currentBatchId} AND "status" = 'PLAN_SUBMITTED'
        FOR UPDATE`))[0];
      if (!row) continue;
      matched++;
      // The reported dealer name belongs to an APPOINTED result only: Not Appointed ALWAYS clears it, whatever the request carries.
      const name = e.status === "APPOINTED" ? (e.dealerName?.trim() || null) : null;
      if (row.monthlyPlanId) {
        if (row.resultStatus === "APPOINTED" && row.resultEventId) {
          if (e.status !== "APPOINTED") throw new ApiError(409, L["daily_work.validation.appointment_result_locked"]);
          // Echo of the recorded result — the only thing that may change is the reported name (no monthly transition, no new event).
          count += Number(await tx.$executeRaw(Prisma.sql`UPDATE "DailyWorkEntry" SET "reportedDealerName" = ${name}, "updatedAt" = NOW() WHERE "id" = ${e.entryId} AND "reportedDealerName" IS DISTINCT FROM ${name}`));
          continue;
        }
        if (e.status === "APPOINTED") {
          if (row.resultStatus === "APPOINTED") { // recorded earlier without a new transition (already progressed): only the name may change
            count += Number(await tx.$executeRaw(Prisma.sql`UPDATE "DailyWorkEntry" SET "reportedDealerName" = ${name}, "updatedAt" = NOW() WHERE "id" = ${e.entryId} AND "reportedDealerName" IS DISTINCT FROM ${name}`));
            continue;
          }
          if (partyPlanningEnabled) throw new ApiError(409, L["daily_work.validation.appointment_use_popup"]);
        }
      }
      const n = await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry" SET "resultStatus" = ${e.status}, "reportedDealerName" = ${name}, "updatedAt" = NOW() WHERE "id" = ${e.entryId}`);
      count += Number(n);
    }
    if (matched === 0) throw new ApiError(409, L["daily_work.validation.appointment_after_submit"]);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `APPOINTMENT:${workDate}`, summary: `Set appointment status for ${count} row(s)` }, tx);
    return { count };
  });
}

/**
 * Daily Report → "Appointed" for a LINKED row: the owner's monthly "Doc Send By SO" transition and the Daily Work result in ONE transaction (nothing partial can persist).
 *  - the day lock serializes the owner's actions; the entry row is locked FOR UPDATE; an already-recorded result is returned as is (a retry / double click replays nothing);
 *  - the monthly step reuses the Monthly Planning rules exactly (owner only, approved entry, open season, row claimed on its status, Conversion Date, append-only status event, audit);
 *  - the daily row then stores Appointed + a reference to that status event;
 *  - an entry that already progressed (Doc Sent / later) gets no second transition: the result is recorded against its latest event; a Rejected entry is refused;
 *  - owner, submitted batch, report window and finalized day are all enforced here. It never creates a dealer and never touches Admin steps.
 */
export async function recordAppointedResult(ctx: AuthContext, raw: unknown): Promise<{ entryId: string; status: "APPOINTED"; eventId: string | null; transitioned: boolean }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, entryId, sent, dealerName } = dailyWorkSchemas(L).appointedResult.parse(raw);
  const officerId = ownerId(ctx);
  return prisma.$transaction(async (tx) => {
    if (!(await getAppointmentPartyPlanningEnabled(tx))) throw new ApiError(409, L["daily_work.validation.appointment_connection_disabled"]);
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertReportWritable(tx, officerId, workDate, L);
    const row = (await tx.$queryRaw<{ monthlyPlanId: string | null; resultStatus: string | null; resultEventId: string | null }[]>(Prisma.sql`
      SELECT "monthlyPlanId", "resultStatus", "resultEventId" FROM "DailyWorkEntry"
      WHERE "id" = ${entryId} AND "officerId" = ${officerId} AND "section" = 'APPOINTMENT' AND "workDate" = ${workDate}::date AND "batchId" <> ${day.currentBatchId} AND "status" = 'PLAN_SUBMITTED'
      FOR UPDATE`))[0];
    if (!row) throw new ApiError(409, L["daily_work.validation.appointment_after_submit"]);
    if (!row.monthlyPlanId) throw new ApiError(422, L["daily_work.validation.appointment_use_popup"]);
    if (row.resultStatus === "APPOINTED") return { entryId, status: "APPOINTED" as const, eventId: row.resultEventId, transitioned: false }; // retry: nothing replayed
    const plan = await tx.partyMonthlyPlan.findUnique({ where: { id: row.monthlyPlanId }, select: { id: true, ownerId: true, opStatus: true, approvalStatus: true } });
    if (!plan || plan.ownerId !== officerId || plan.approvalStatus !== "APPROVED") throw new ApiError(409, L["daily_work.validation.appointment_market_not_eligible"]);
    let eventId: string | null;
    let transitioned = false;
    const documentNotSentAgain = plan.opStatus === "DOC_NOT_SENT" && (sent as { documentNotSent?: unknown } | null | undefined)?.documentNotSent === true;
    let movedTo: string | null = null;
    if ((plan.opStatus === "NONE" || plan.opStatus === "DOC_NOT_SENT") && !documentNotSentAgain) {
      // The SAME owner step as the Monthly Planning dialog: NONE → Doc Send By SO (answers) or Document Not Sent ("Appointed, Document Not Sent"); a row that is already
      // Document Not Sent can later be moved on to Doc Send By SO by submitting the Document / Cheque answers.
      ({ eventId, status: movedTo } = await ownerSendDocumentsInTx(tx, ctx, plan.id, sent));
      transitioned = true;
    } else if (plan.opStatus === "REJECTED") {
      throw new ApiError(409, L["daily_work.validation.appointment_monthly_rejected"]);
    } else {
      // Already progressed (Doc Sent / Received / SD Bounce / Appointed): no second transition; the result references the latest status event.
      eventId = (await tx.partyMonthlyStatusEvent.findFirst({ where: { monthlyPlanId: plan.id }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
    }
    await tx.$executeRaw(Prisma.sql`UPDATE "DailyWorkEntry" SET "resultStatus" = 'APPOINTED', "resultEventId" = ${eventId}, "reportedDealerName" = ${dealerName?.trim() || null}, "updatedAt" = NOW() WHERE "id" = ${entryId}`);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `APPOINTMENT:${workDate}`, summary: `Appointed result recorded for a Monthly Party Planning market${transitioned ? (movedTo === "DOC_NOT_SENT" ? " (document not sent)" : " (documents sent)") : " (monthly status unchanged)"}` }, tx);
    return { entryId, status: "APPOINTED" as const, eventId, transitioned };
  }, { timeout: 20_000 });
}

/* =====================================================================================
 * SECTION 4 — SCHEME CONVERSION (planned schemes per dealer; units, not rupees)
 * ===================================================================================== */

const convKey = (dealerId: string, schemeId: string) => `${dealerId}:${schemeId}`;

/** Read the officer's Scheme Conversion rows for a date, with planned/converted/pending units + achievability. */
export async function getDailyConversion(ctx: AuthContext, rawDate?: string, targetOfficerId?: string, rawMode?: string): Promise<ConversionPayload> {
  await assertReadRole(ctx, targetOfficerId);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const officerId = await resolveReadOfficer(ctx, targetOfficerId);

  const mode = parseDailyWorkMode(rawMode);
  const [entries, plannedByDealer, assignedIds] = await Promise.all([
    loadDailyRows(officerId, "SCHEME_CONVERSION", workDate, mode),
    plannedSchemesByDealer(officerId),
    getCurrentDealerIds(officerId),
  ]);
  const dealerIds = [...new Set([...plannedByDealer.keys(), ...entries.map((r) => r.dealerId).filter((x): x is string => !!x)])];
  // DISPLAY-only: alias-preferred dealer names; the dealer id remains the identity for every row/option.
  const [convDealerRows, convAliasNames] = await Promise.all([
    prisma.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true } }),
    loadDealerAliasNameMap(dealerIds),
  ]);
  const dealerNames = new Map(convDealerRows.map((d) => [d.id, convAliasNames.get(d.id) ?? d.name]));
  const schemeInfo = (dealerId: string, schemeId: string): PlannedSchemeOption | undefined =>
    (plannedByDealer.get(dealerId) ?? []).find((s) => s.schemeId === schemeId);

  const rows: ConversionRowDto[] = entries
    .filter((r) => r.dealerId && r.schemeId)
    .map((r) => {
      const info = schemeInfo(r.dealerId!, r.schemeId!);
      const plannedUnits = info?.plannedUnits ?? 0;
      const convertedUnits = info?.convertedUnits ?? 0;
      return {
        entryId: r.id,
        batchId: r.batchId,
        dealerId: r.dealerId!,
        dealerName: dealerNames.get(r.dealerId!) ?? "—",
        schemeId: r.schemeId!,
        schemeName: info?.schemeName ?? "—",
        plannedUnits,
        convertedUnits,
        pending: conversionPending(plannedUnits, convertedUnits),
        todaysPlan: r.todaysPlan == null ? null : Math.round(num(r.todaysPlan)),
        achievability: (r.resultStatus as "YES" | "NO" | null) ?? null,
        rowStatus: (r.status as ConversionRowDto["rowStatus"]) ?? "DRAFT",
      };
    })
    .sort((a, b) => a.dealerName.localeCompare(b.dealerName) || a.schemeName.localeCompare(b.schemeName));

  // Available = scoped dealers that HAVE planned schemes and still have at least one (dealer,scheme) not added.
  const usedKeys = new Set(rows.map((r) => convKey(r.dealerId, r.schemeId)));
  const availableDealers: ConversionDealerOption[] = (mode === "REPORT" ? [] : assignedIds)
    .filter((id) => (plannedByDealer.get(id)?.length ?? 0) > 0)
    .map((id) => ({
      dealerId: id,
      dealerName: dealerNames.get(id) ?? "—",
      schemes: (plannedByDealer.get(id) ?? []).filter((s) => !usedKeys.has(convKey(id, s.schemeId))),
    }))
    .filter((d) => d.schemes.length > 0)
    .sort((a, b) => a.dealerName.localeCompare(b.dealerName));

  return { section: "SCHEME_CONVERSION", workDate, canEnterAchievability: mode === "REPORT" && rows.some((r) => r.rowStatus !== "DRAFT"), availableDealers, rows };
}

/** Persist Scheme Conversion rows as DRAFT (replace-set, atomic). Validates scope, planned scheme, today ≤ pending. */
export async function saveDailyConversion(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, rows } = dailyWorkSchemas(L).conversionSave.parse(raw);
  const officerId = ownerId(ctx);

  await assertDealersInScope(officerId, rows.map((r) => r.dealerId), L);
  // No duplicate (dealer, scheme) within the payload.
  const seen = new Set<string>();
  for (const r of rows) { const k = convKey(r.dealerId, r.schemeId); if (seen.has(k)) throw new ApiError(422, L["daily_work.validation.duplicate_dealer_scheme"]); seen.add(k); }

  // Validate each row against the dealer's PLANNED schemes + the pending cap (server-authoritative).
  const plannedByDealer = await plannedSchemesByDealer(officerId);
  for (const r of rows) {
    const info = (plannedByDealer.get(r.dealerId) ?? []).find((s) => s.schemeId === r.schemeId);
    if (!info) throw new ApiError(422, L["daily_work.validation.scheme_not_planned"]);
    if (r.todaysPlan > info.pending) throw new ApiError(422, formatLabel(L["daily_work.validation.plan_exceeds_pending"], { pending: info.pending }));
  }

  const keep = rows.map((r) => convKey(r.dealerId, r.schemeId));
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertPlanWritable(tx, ctx, workDate, L); // a Sales Officer with an unfinished earlier report cannot create / edit / save / submit a new plan
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "section" = 'SCHEME_CONVERSION' AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
      ${keep.length > 0 ? Prisma.sql`AND "rowKey" NOT IN (${Prisma.join(keep)})` : Prisma.empty}`);
    for (const r of rows) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","schemeId","todaysPlan","status","createdAt","updatedAt")
        VALUES (${randomUUID()}, ${officerId}, ${r.dealerId}, ${convKey(r.dealerId, r.schemeId)}, ${workDate}::date, ${day.currentBatchId}, 'SCHEME_CONVERSION', ${r.schemeId}, ${r.todaysPlan}, 'DRAFT', NOW(), NOW())
        ON CONFLICT ("officerId","workDate","batchId","section","rowKey")
        DO UPDATE SET "todaysPlan" = EXCLUDED."todaysPlan", "updatedAt" = NOW()`);
    }
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `SCHEME_CONVERSION:${workDate}`, summary: `Saved ${rows.length} scheme conversion row(s)` }, tx);
    return { count: rows.length };
  });
}

/** Legacy per-section submit boundary. Batches are submitted only through submitDailyWorkDay. */
export async function submitDailyConversion(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  dailyWorkSchemas(L).conversionSave.parse(raw);
  throw new ApiError(409, L["daily_work.validation.section_submit_removed"]);
}

/** Set Yes/No achievability on an exact PLAN_SUBMITTED conversion entry. Never derived from Today's Plan. */
export async function enterConversionAchievability(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, entries } = dailyWorkSchemas(L).conversionAchievability.parse(raw);
  const officerId = ownerId(ctx);
  if (entries.length === 0) return { count: 0 };
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertReportWritable(tx, officerId, workDate, L);
    let count = 0;
    for (const e of entries) {
      const n = await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry" SET "resultStatus" = ${e.achievability}, "updatedAt" = NOW()
        WHERE "id" = ${e.entryId} AND "officerId" = ${officerId} AND "section" = 'SCHEME_CONVERSION'
          AND "workDate" = ${workDate}::date AND "batchId" <> ${day.currentBatchId} AND "status" = 'PLAN_SUBMITTED'`);
      count += Number(n);
    }
    if (count === 0) throw new ApiError(409, L["daily_work.validation.achievability_after_submit"]);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `SCHEME_CONVERSION:${workDate}`, summary: `Set achievability for ${count} row(s)` }, tx);
    return { count };
  });
}

/* =====================================================================================
 * SECTIONS 5 + 6 — VISITS + OTHERS (one per-day SUMMARY row; not dealer/row-scoped)
 * ===================================================================================== */

const SUMMARY_ROWKEY = "SUMMARY";

export interface DailySummaryPayload {
  section: "SUMMARY";
  workDate: string;
  visitsEntered: boolean; // true once the Visits section has been saved (distinguishes untouched from 0)
  dealerVisits: number;
  newPartyVisits: number;
  others: string;
  actualDealerVisits: number | null;
  actualNewPartyVisits: number | null;
  status: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED" | "NEW";
  batches: {
    entryId: string; batchId: string; dealerVisits: number; newPartyVisits: number;
    actualDealerVisits: number | null; actualNewPartyVisits: number | null; others: string;
    noPlanSections: string | null; status: string;
  }[];
}

/** Read the officer's Visits + Others for a date (one SUMMARY row). Empty/zero when nothing saved yet. */
export async function getDailySummary(ctx: AuthContext, rawDate?: string, targetOfficerId?: string, rawMode?: string): Promise<DailySummaryPayload> {
  await assertReadRole(ctx, targetOfficerId);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const officerId = await resolveReadOfficer(ctx, targetOfficerId);
  const mode = parseDailyWorkMode(rawMode);
  await materializeCalendarForRead(ctx, officerId, workDate, mode);
  const { day } = await readBatchContext(officerId, workDate);
  const rows = await prisma.$queryRaw<{ id: string; batchId: string; dealerVisits: number | null; newPartyVisits: number | null; actualDealerVisits: number | null; actualNewPartyVisits: number | null; others: string | null; noPlanSections: string | null; status: string }[]>(Prisma.sql`
    SELECT "id", "batchId", "dealerVisits", "newPartyVisits", "actualDealerVisits", "actualNewPartyVisits", "others", "noPlanSections", "status"
    FROM "DailyWorkEntry"
    WHERE "officerId" = ${officerId} AND "section" = 'SUMMARY' AND "workDate" = ${workDate}::date AND "rowKey" = ${SUMMARY_ROWKEY}
      AND ${mode === "PLAN"
        ? Prisma.sql`"batchId" = ${day.currentBatchId} AND "status" = 'DRAFT'`
        : Prisma.sql`"batchId" <> ${day.currentBatchId} AND "status" IN ('PLAN_SUBMITTED','FINALIZED','SUBMITTED')`}
    ORDER BY COALESCE("planSubmittedAt", "createdAt"), "createdAt"`);
  const r = rows[0];
  const batches = rows.map((row) => ({
    entryId: row.id, batchId: row.batchId, dealerVisits: row.dealerVisits ?? 0, newPartyVisits: row.newPartyVisits ?? 0,
    actualDealerVisits: row.actualDealerVisits, actualNewPartyVisits: row.actualNewPartyVisits,
    others: row.others ?? "", noPlanSections: row.noPlanSections, status: row.status,
  }));
  return {
    section: "SUMMARY",
    workDate,
    // Visits is "entered" once its columns are non-null (a VISITS save happened) — so an explicit 0 counts,
    // but an untouched section (or an Others-only save) does not.
    visitsEntered: r?.dealerVisits != null || r?.newPartyVisits != null,
    dealerVisits: mode === "REPORT" ? batches.reduce((sum, row) => sum + row.dealerVisits, 0) : (r?.dealerVisits ?? 0),
    newPartyVisits: mode === "REPORT" ? batches.reduce((sum, row) => sum + row.newPartyVisits, 0) : (r?.newPartyVisits ?? 0),
    actualDealerVisits: mode === "REPORT" && batches.every((row) => row.actualDealerVisits != null) ? batches.reduce((sum, row) => sum + (row.actualDealerVisits ?? 0), 0) : (r?.actualDealerVisits ?? null),
    actualNewPartyVisits: mode === "REPORT" && batches.every((row) => row.actualNewPartyVisits != null) ? batches.reduce((sum, row) => sum + (row.actualNewPartyVisits ?? 0), 0) : (r?.actualNewPartyVisits ?? null),
    others: mode === "REPORT" ? batches.map((row) => row.others).filter(Boolean).join("\n\n") : (r?.others ?? ""),
    status: (r?.status as DailySummaryPayload["status"]) ?? "NEW",
    batches,
  };
}

/**
 * Persist Visits and/or Others as DRAFT — a single upsert on the day's SUMMARY row. `focus` controls which
 * fields are written: VISITS sets the visit columns (so an explicit 0 becomes real data), OTHERS sets only the
 * note, BOTH sets all. The visit columns stay NULL until a VISITS save happens, so an Others-only save never
 * makes the Visits section look "filled".
 */
export async function saveDailySummary(ctx: AuthContext, raw: unknown): Promise<{ ok: true }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, focus, dealerVisits, newPartyVisits, others } = dailyWorkSchemas(L).summarySave.parse(raw);
  const officerId = ownerId(ctx);
  const note = others.trim() === "" ? null : others.trim();
  const touchVisits = focus === "VISITS" || focus === "BOTH";
  const touchOthers = focus === "OTHERS" || focus === "BOTH";

  // Insert seeds only the touched columns; on conflict, update only the touched columns (leave the rest as-is).
  const dv = touchVisits ? Prisma.sql`${dealerVisits}` : Prisma.sql`NULL`;
  const npv = touchVisits ? Prisma.sql`${newPartyVisits}` : Prisma.sql`NULL`;
  const oth = touchOthers ? Prisma.sql`${note}` : Prisma.sql`NULL`;
  await prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertPlanWritable(tx, ctx, workDate, L); // a Sales Officer with an unfinished earlier report cannot create / edit / save / submit a new plan
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","dealerVisits","newPartyVisits","others","status","createdAt","updatedAt")
      VALUES (${randomUUID()}, ${officerId}, NULL, ${SUMMARY_ROWKEY}, ${workDate}::date, ${day.currentBatchId}, 'SUMMARY', ${dv}, ${npv}, ${oth}, 'DRAFT', NOW(), NOW())
      ON CONFLICT ("officerId","workDate","batchId","section","rowKey")
      DO UPDATE SET
        ${touchVisits ? Prisma.sql`"dealerVisits" = ${dealerVisits}, "newPartyVisits" = ${newPartyVisits},` : Prisma.empty}
        ${touchOthers ? Prisma.sql`"others" = ${note},` : Prisma.empty}
        "updatedAt" = NOW()`);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `SUMMARY:${workDate}`, summary: `Saved daily ${focus.toLowerCase()}` }, tx);
  });
  return { ok: true };
}

/** Save Visits actuals progressively on the exact submitted batch summary row. */
export async function enterVisitsActual(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, entries } = dailyWorkSchemas(L).visitsActual.parse(raw);
  const officerId = ownerId(ctx);
  if (entries.length === 0) return { count: 0 };
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertReportWritable(tx, officerId, workDate, L);
    let count = 0;
    for (const entry of entries) {
      count += Number(await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry"
        SET "actualDealerVisits" = ${entry.actualDealerVisits}, "actualNewPartyVisits" = ${entry.actualNewPartyVisits}, "updatedAt" = NOW()
        WHERE "id" = ${entry.entryId} AND "officerId" = ${officerId} AND "workDate" = ${workDate}::date
          AND "section" = 'SUMMARY' AND "batchId" <> ${day.currentBatchId} AND "status" = 'PLAN_SUBMITTED'
          AND ("dealerVisits" IS NOT NULL OR "newPartyVisits" IS NOT NULL)`));
    }
    if (count === 0) throw new ApiError(409, L["daily_work.validation.actuals_after_submit"]);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `VISITS:${workDate}`, summary: `Saved Visits actuals for ${count} planning batch(es)` }, tx);
    return { count };
  });
}

/** Legacy per-section submit boundary. Batches are submitted only through submitDailyWorkDay. */
export async function submitDailySummary(ctx: AuthContext, raw: unknown): Promise<{ ok: true }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  dailyWorkSchemas(L).summarySave.parse(raw);
  throw new ApiError(409, L["daily_work.validation.section_submit_removed"]);
}
/* =====================================================================================
 * SECTION COMPLETION — one authoritative status calc (progress bar + No Plan + submit gate).
 *
 * FILLED/REMAINING are DERIVED from real persisted section data; NO_PLAN is the only stored decision
 * (SUMMARY row `noPlanSections` CSV). "Others" is optional and never counted.
 * ===================================================================================== */

/**
 * Whether each MANDATORY section has REAL user data for the day — computed straight from persisted rows, so
 * Appointment drafts count as present once explicitly added, but must also pass completeness checks before submission:
 *   SALES / RECOVERY   → ≥1 saved dealer row for that section
 *   APPOINTMENT        → ≥1 saved row (dealer + market, or an approved monthly link, required to submit)
 *   SCHEME_CONVERSION  → ≥1 (dealer, scheme) row
 *   VISITS             → the SUMMARY visit columns are set (an explicit 0 counts; untouched/NULL does not)
 */
async function sectionDataPresence(officerId: string, workDate: string, batchId: string, db: DbClient = prisma): Promise<SectionDataPresence> {
  return (await sectionFacts(officerId, workDate, batchId, db)).presence;
}

/**
 * Data presence of every mandatory section AND the persisted No-Plan set in ONE statement (they all read the same batch of DailyWorkEntry rows). This is what the submit
 * transaction and the status read use: three round trips became one, which matters because every statement of an interactive transaction costs a network round trip.
 */
async function sectionFacts(officerId: string, workDate: string, batchId: string, db: DbClient = prisma): Promise<{ presence: SectionDataPresence; noPlanSet: Set<MandatorySection>; invalidAppointments: boolean }> {
  const rows = await db.$queryRaw<{ sales: bigint; recovery: bigint; appointment: bigint; invalidAppointments: bigint; conversion: bigint; visits: boolean | null; others: boolean | null; noPlanSections: string | null }[]>(Prisma.sql`
    SELECT COUNT(*) FILTER (WHERE "section" = 'SALES')::bigint AS "sales",
           COUNT(*) FILTER (WHERE "section" = 'RECOVERY')::bigint AS "recovery",
           COUNT(*) FILTER (WHERE "section" = 'APPOINTMENT')::bigint AS "appointment",
           COUNT(*) FILTER (WHERE "section" = 'APPOINTMENT' AND "monthlyPlanId" IS NULL AND (COALESCE(TRIM("typedDealerName"), '') = '' OR COALESCE(TRIM("marketName"), '') = ''))::bigint AS "invalidAppointments",
           COUNT(*) FILTER (WHERE "section" = 'SCHEME_CONVERSION')::bigint AS "conversion",
           BOOL_OR("section" = 'SUMMARY' AND "rowKey" = ${SUMMARY_ROWKEY} AND ("dealerVisits" IS NOT NULL OR "newPartyVisits" IS NOT NULL)) AS "visits",
           BOOL_OR("section" = 'SUMMARY' AND "rowKey" = ${SUMMARY_ROWKEY} AND COALESCE(TRIM("others"), '') <> '') AS "others",
           MAX("noPlanSections") FILTER (WHERE "section" = 'SUMMARY' AND "rowKey" = ${SUMMARY_ROWKEY}) AS "noPlanSections"
    FROM "DailyWorkEntry"
    WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${batchId}`);
  const r = rows[0];
  return {
    presence: { SALES: Number(r?.sales ?? 0) > 0, RECOVERY: Number(r?.recovery ?? 0) > 0, APPOINTMENT: Number(r?.appointment ?? 0) > 0, SCHEME_CONVERSION: Number(r?.conversion ?? 0) > 0, VISITS: r?.visits ?? false, OTHERS: r?.others ?? false },
    noPlanSet: parseNoPlanSet(r?.noPlanSections),
    invalidAppointments: Number(r?.invalidAppointments ?? 0) > 0,
  };
}

/**
 * Write guard for a section that is TEMPORARILY disabled (see SCHEME_CONVERSION_ENABLED). Used by the Daily Work write
 * routes so a stale/manipulated client cannot create or change Scheme Conversion data while it is switched off.
 * Reads and the service functions themselves are untouched, so history stays readable and re-enabling is one flag.
 */
export function assertDailyWorkSectionWritable(section: unknown): void {
  if (section === "SCHEME_CONVERSION" && !isDailyWorkSectionEnabled(section)) {
    throw new ApiError(409, "Scheme Conversion is temporarily disabled in Daily Work.");
  }
}

/** The persisted No-Plan set for the day (from the SUMMARY row's CSV). */
async function loadNoPlanSet(officerId: string, workDate: string, batchId: string, db: DbClient = prisma): Promise<Set<MandatorySection>> {
  const rows = await db.$queryRaw<{ noPlanSections: string | null }[]>(Prisma.sql`
    SELECT "noPlanSections" FROM "DailyWorkEntry"
    WHERE "officerId" = ${officerId} AND "section" = 'SUMMARY' AND "workDate" = ${workDate}::date AND "batchId" = ${batchId} AND "rowKey" = ${SUMMARY_ROWKEY}
    LIMIT 1`);
  return parseNoPlanSet(rows[0]?.noPlanSections);
}

/** Persist the No-Plan set onto the SUMMARY row (creating the row if the day has none yet). */
async function persistNoPlanSet(tx: Prisma.TransactionClient, officerId: string, workDate: string, batchId: string, set: ReadonlySet<string>): Promise<void> {
  const csv = serializeNoPlanSet(set);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","noPlanSections","status","createdAt","updatedAt")
    VALUES (${randomUUID()}, ${officerId}, NULL, ${SUMMARY_ROWKEY}, ${workDate}::date, ${batchId}, 'SUMMARY', ${csv || null}, 'DRAFT', NOW(), NOW())
    ON CONFLICT ("officerId","workDate","batchId","section","rowKey")
    DO UPDATE SET "noPlanSections" = ${csv || null}, "updatedAt" = NOW()`);
}

export interface SectionStatusDto { section: MandatorySection; status: SectionStatus; hasData: boolean }
export interface DailyStatusPayload {
  workDate: string;
  sections: SectionStatusDto[];
  counts: SectionStatusCounts;
  canSubmit: boolean;
  hasSubmittedWork: boolean;
  canSubmitReport: boolean;
  isFinalized: boolean;
  selfRating: number | null;
  reportSections: { section: MandatorySection; required: boolean; complete: boolean }[];
  // VISIBILITY-only flag for the "Today's Auto Tasks" block (default OFF). Never gates Auto Task behaviour.
  autoTasksEnabled: boolean;
  /** The previous calendar day's Daily Report as it gates THIS day's Daily Plan submission (see previousReportState). */
  previousReport: { date: string; state: PreviousReportState; deadline: string };
  /** This day's own Daily Report deadline: 12:00 noon of the following day (business timezone). */
  reportDeadline: string;
  reportDeadlinePassed: boolean;
  /** Derived (never stored): this day had a submitted plan, its report was not finalized, and the deadline has passed. */
  reportMissed: boolean;
  /** An approved late-submission request keeps THIS report open (editable and submittable) until it is finally submitted. */
  reportApproved: boolean;
  /** Sales Officer only: the most recent submitted plan (before this date) whose report is not finalized. While it exists a NEW plan cannot be created, edited, saved or submitted. */
  outstandingReport: { date: string; deadline: string; requests: LateRequestDto[]; canRequest: boolean } | null;
  /** The caller's own late-submission requests for THIS report date (newest first). */
  lateRequests: LateRequestDto[];
}

/** The previous calendar day's submitted-plan / finalized-report facts for one owner. Keyed on the owner, so nobody can satisfy another's gate. */
async function previousReportGate(db: DbClient, officerId: string, workDate: string, now: Date): Promise<{ date: string; state: PreviousReportState; deadline: Date }> {
  const date = previousBusinessDate(workDate);
  const rows = await db.$queryRaw<{ planned: boolean; finalized: boolean; policyDeadline: Date | null }[]>(Prisma.sql`
    SELECT EXISTS(SELECT 1 FROM "DailyWorkEntry" WHERE "officerId" = ${officerId} AND "workDate" = ${date}::date AND "planSubmittedAt" IS NOT NULL) AS "planned",
           EXISTS(SELECT 1 FROM "DailyWorkDay" WHERE "officerId" = ${officerId} AND "workDate" = ${date}::date AND "status" = 'FINALIZED') AS "finalized",
           (SELECT p."deadline" FROM "DailyReportPolicy" p WHERE p."officerId" = ${officerId} AND p."workDate" = ${date}::date) AS "policyDeadline",
           'previousDayGate' AS "previousDayGate"`);
  const row = rows[0] ?? { planned: false, finalized: false, policyDeadline: null };
  // A covered day (new policy) is judged by ITS persisted deadline; every other day keeps the previous noon rule.
  if (row.policyDeadline) {
    const state: PreviousReportState = row.finalized ? "SUBMITTED" : !row.planned ? "NOT_APPLICABLE" : isStrictDeadlinePassed(row.policyDeadline, now) ? "MISSED" : "PENDING";
    return { date, state, deadline: row.policyDeadline };
  }
  return { date, state: previousReportState(row, date, now), deadline: dailyReportDeadline(date) };
}

interface ReportEntryState {
  section: string; batchId: string; todaysActual: string | null; resultStatus: string | null;
  dealerVisits: number | null; newPartyVisits: number | null;
  actualDealerVisits: number | null; actualNewPartyVisits: number | null; noPlanSections: string | null; paymentMode: string | null;
}

async function reportCompletion(db: DbClient, officerId: string, workDate: string, currentBatchId: string) {
  const rows = await db.$queryRaw<ReportEntryState[]>(Prisma.sql`
    SELECT "section", "batchId", "todaysActual"::text AS "todaysActual", "resultStatus",
      "dealerVisits", "newPartyVisits", "actualDealerVisits", "actualNewPartyVisits", "noPlanSections", "paymentMode"
    FROM "DailyWorkEntry"
    WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date
      AND "batchId" <> ${currentBatchId} AND "status" IN ('PLAN_SUBMITTED','FINALIZED','SUBMITTED')
      AND (${SCHEME_CONVERSION_ENABLED}::boolean OR "section" <> 'SCHEME_CONVERSION')
      AND ("section" <> 'APPOINTMENT' OR "monthlyPlanId" IS NOT NULL OR COALESCE(TRIM("typedDealerName"), '') <> '' OR COALESCE(TRIM("marketName"), '') <> '')`);
  let paymentModeMissing = false;
  const required = new Map<MandatorySection, boolean>(MANDATORY_SECTIONS.map((section) => [section, false]));
  const complete = new Map<MandatorySection, boolean>(MANDATORY_SECTIONS.map((section) => [section, true]));
  for (const row of rows) {
    if (row.section === "SALES" || row.section === "RECOVERY") {
      const section = row.section as MandatorySection;
      required.set(section, true);
      if (row.todaysActual == null) complete.set(section, false);
      // A received recovery amount must say how it was received (a recovery of 0 needs no mode).
      if (section === "RECOVERY" && row.todaysActual != null && Number(row.todaysActual) > 0 && row.paymentMode == null) paymentModeMissing = true;
    } else if (row.section === "APPOINTMENT") {
      required.set("APPOINTMENT", true);
      if (row.resultStatus == null) complete.set("APPOINTMENT", false);
    } else if (row.section === "SCHEME_CONVERSION") {
      required.set("SCHEME_CONVERSION", true);
      if (row.resultStatus == null) complete.set("SCHEME_CONVERSION", false);
    } else if (row.section === "SUMMARY") {
      const noPlan = parseNoPlanSet(row.noPlanSections);
      const plannedVisits = (row.dealerVisits != null || row.newPartyVisits != null) && !noPlan.has("VISITS");
      if (plannedVisits) {
        required.set("VISITS", true);
        if (row.actualDealerVisits == null || row.actualNewPartyVisits == null) complete.set("VISITS", false);
      }
    }
  }
  const sections = MANDATORY_SECTIONS.map((section) => ({ section, required: required.get(section) ?? false, complete: !(required.get(section) ?? false) || (complete.get(section) ?? false) }));
  return { hasBatches: rows.length > 0, paymentModeMissing, sections, complete: rows.length > 0 && sections.every((section) => section.complete) };
}

/**
 * The ONE authoritative status read: derived data presence + persisted No-Plan → each mandatory section's
 * status, the counts for the progress bar, and whether the whole day can be submitted (no REMAINING section).
 * Data present overrides a stale No-Plan flag; incomplete appointment drafts remain REMAINING.
 */
export async function getDailyStatus(ctx: AuthContext, rawDate?: string, targetOfficerId?: string): Promise<DailyStatusPayload> {
  await assertReadRole(ctx, targetOfficerId);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const officerId = await resolveReadOfficer(ctx, targetOfficerId);
  await materializeCalendarForRead(ctx, officerId, workDate, "PLAN"); // the status (progress bar) must see Calendar tasks too
  const { day } = await readBatchContext(officerId, workDate);
  const now = dailyWorkClock.now();
  const [{ presence: data, noPlanSet, invalidAppointments }, report, autoTasksEnabled, previous] = await Promise.all([
    sectionFacts(officerId, workDate, day.currentBatchId),
    reportCompletion(prisma, officerId, workDate, day.currentBatchId),
    getAutoTasksEnabled(),
    previousReportGate(prisma, officerId, workDate, now),
  ]);
  const window = await reportWindow(prisma, officerId, workDate, now);
  const reportDeadlinePassed = !window.open; // closed for writes: past the owner's deadline AND no approved late-submission request
  const own = officerId === ctx.userId && ctx.role === Role.SALES_OFFICER;
  const outstanding = own ? await outstandingReport(prisma, officerId, workDate) : null;
  const [outstandingRequests, lateRequests] = own ? await Promise.all([outstanding ? myLateRequests(prisma, officerId, outstanding.date) : Promise.resolve([] as LateRequestDto[]), myLateRequests(prisma, officerId, workDate)]) : [[], []];
  const statuses = computeSectionStatuses(data, noPlanSet);
  if (invalidAppointments) statuses.APPOINTMENT = SectionStatus.REMAINING;
  return {
    workDate,
    sections: MANDATORY_SECTIONS.map((s) => ({ section: s, status: statuses[s], hasData: data[s] })),
    counts: sectionStatusCounts(statuses),
    canSubmit: day.status === "OPEN" && canSubmitDailyWork(statuses) && !previousReportBlocksPlan(previous.state) && !outstanding,
    hasSubmittedWork: report.hasBatches,
    canSubmitReport: day.status === "OPEN" && report.complete && !reportDeadlinePassed,
    isFinalized: day.status === "FINALIZED",
    selfRating: day.selfRating,
    reportSections: report.sections,
    autoTasksEnabled,
    previousReport: { date: previous.date, state: previous.state, deadline: previous.deadline.toISOString() },
    reportDeadline: window.deadline.toISOString(),
    reportDeadlinePassed,
    reportMissed: report.hasBatches && day.status !== "FINALIZED" && window.passed,
    reportApproved: window.approved,
    outstandingReport: outstanding ? { date: outstanding.date, deadline: outstanding.deadline.toISOString(), requests: outstandingRequests, canRequest: !outstandingRequests.some((r) => r.status === "PENDING" || r.status === "APPROVED") } : null,
    lateRequests,
  };
}

/**
 * Mark / unmark a section "No Plan". Reject marking No Plan when the section actually has data (the invariant
 * "No Plan + data" can never be created). Unmarking is always allowed. Returns the refreshed status payload.
 */
export async function setDailyNoPlan(ctx: AuthContext, raw: unknown): Promise<DailyStatusPayload> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, section, noPlan } = dailyWorkSchemas(L).noPlan.parse(raw);
  const officerId = ownerId(ctx);
  await prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertPlanWritable(tx, ctx, workDate, L); // a Sales Officer with an unfinished earlier report cannot create / edit / save / submit a new plan
    if (noPlan) {
      const data = await sectionDataPresence(officerId, workDate, day.currentBatchId, tx);
      if (data[section]) throw new ApiError(409, L["daily_work.validation.no_plan_has_data"]);
    }
    const set = await loadNoPlanSet(officerId, workDate, day.currentBatchId, tx);
    if (noPlan) set.add(section); else set.delete(section);
    await persistNoPlanSet(tx, officerId, workDate, day.currentBatchId, set);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `NOPLAN:${workDate}`, summary: `${noPlan ? "Marked" : "Cleared"} No Plan for ${section}` }, tx);
  });
  return getDailyStatus(ctx, workDate);
}

/**
 * Day-level Submit — the authoritative server gate. Independently recomputes every mandatory section's status
 * and REJECTS if any is still REMAINING (a manipulated client cannot bypass this). On success, freezes ALL
 * current-batch DRAFT rows as PLAN_SUBMITTED and rotates a fresh current batch in one transaction.
 */
/**
 * The submit transaction's own, BOUNDED limits (not a global change): `timeout` is how long the whole interactive transaction may run, `maxWait` how long it may wait for a
 * pooled connection before starting. Measured: the transaction is ~15 statements plus BEGIN / COMMIT and the database spends ~1–30 ms on all of them; what takes time is the
 * network round trip of EACH statement (and queueing behind other requests), so the default 5 s fails as soon as a round trip reaches ~300 ms. 30 s tolerates ~1.7 s per
 * statement; anything slower is failed with a retryable message instead of hanging.
 */
export const SUBMIT_DAY_TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;
/** A Prisma transaction that closed (P2028), could not get a connection (P2024) or lost a write conflict / deadlock (P2034): nothing was committed, so the request is safely retryable. */
export const isRetryableTransactionError = (e: unknown): boolean => typeof e === "object" && e !== null && ["P2028", "P2024", "P2034"].includes((e as { code?: string }).code ?? "");

export async function submitDailyWorkDay(ctx: AuthContext, raw: unknown): Promise<{ ok: true; batchId: string }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate } = dailyWorkSchemas(L).batchSubmit.parse(raw);
  const officerId = ownerId(ctx);
  let submittedBatchId = "";
  try {
  await prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await assertPlanWritable(tx, ctx, workDate, L); // a Sales Officer with an unfinished earlier report cannot create / edit / save / submit a new plan
    // Strict daily workflow: yesterday's Daily Report must have been submitted before today's Daily Plan can be. Enforced here, in the
    // locked transaction, so no client can bypass it; a rejection writes nothing (the whole transaction rolls back).
    const previous = await previousReportGate(tx, officerId, workDate, dailyWorkClock.now());
    if (previous.state === "PENDING") throw new ApiError(422, L["daily_work.validation.previous_report_required"]);
    // MISSED (deadline passed, report never submitted) deliberately does NOT block: the user moves on and that day shows "Missed".
    // Auto Tasks apply only to users who are shown them (see autoTasksApplyToRole): the SAME rule as the Recovery read path,
    // so the gate can never reject for a task the user cannot see, confirm or reschedule.
    if (autoTasksApplyToRole(ctx.role)) {
      await materializeDueDailyWorkTasksInTransaction(tx, officerId, workDate, day);
      // Submitting Daily Work must NOT implicitly confirm an Auto Task. Every materialized Auto Task in the current
      // editable batch must have been explicitly confirmed first (this never completes the payment task).
      const unconfirmed = await countUnconfirmedMaterializedTasks(tx, officerId, workDate, day.currentBatchId);
      // Billing Exception tasks need no confirmation: a due task is in the plan once, and submitting it is the officer's confirmation.
      if (unconfirmed > 0) throw new ApiError(422, L["daily_work.validation.confirm_auto_tasks"]);
    }
    const { presence: data, noPlanSet, invalidAppointments } = await sectionFacts(officerId, workDate, day.currentBatchId, tx);
    if (invalidAppointments) throw new ApiError(422, L["daily_work.validation.appointment_details_required"]);
    const statuses = computeSectionStatuses(data, noPlanSet);
    if (!canSubmitDailyWork(statuses)) {
      const remaining = MANDATORY_SECTIONS.filter((s) => statuses[s] === SectionStatus.REMAINING);
      const sectionLabels: Record<MandatorySection, string> = {
        SALES: L["daily_work.section.sales"], RECOVERY: L["daily_work.section.recovery"],
        APPOINTMENT: L["daily_work.section.appointment"], SCHEME_CONVERSION: L["daily_work.section.scheme_conversion"],
        VISITS: L["daily_work.section.visits"], OTHERS: L["daily_work.section.others"],
      };
      throw new ApiError(422, formatLabel(L["daily_work.validation.complete_sections"], { sections: remaining.map((section) => sectionLabels[section]).join(", ") }));
    }
    // Every Sales / Recovery dealer row currently in the plan needs a Today's Plan strictly greater than 0 (removed dealers have no
    // row, so they never count). Checked on the rows as stored — after Auto Task / Calendar rows were materialized — so no client can skip it.
    const planRows = await tx.$queryRaw<{ section: "SALES" | "RECOVERY"; dealerId: string; dealerName: string; todaysPlan: string | null }[]>(Prisma.sql`
      SELECT e."section", e."dealerId", d."name" AS "dealerName", e."todaysPlan"::text AS "todaysPlan", 'planValueCheck' AS "planValueCheck"
      FROM "DailyWorkEntry" e JOIN "Dealer" d ON d."id" = e."dealerId"
      WHERE e."officerId" = ${officerId} AND e."workDate" = ${workDate}::date AND e."batchId" = ${day.currentBatchId} AND e."status" = 'DRAFT'
        AND e."section" IN ('SALES','RECOVERY')
      ORDER BY e."section", d."name"`);
    const badPlanRows = invalidPlanRows(planRows);
    if (badPlanRows.length > 0) {
      const aliases = await loadDealerAliasNameMap(badPlanRows.map((row) => row.dealerId));
      const named = badPlanRows.map((row) => ({ ...row, dealerName: aliases.get(row.dealerId) ?? row.dealerName }));
      throw new ApiError(422, planRequiredMessage(L["daily_work.validation.plan_required"], named, { SALES: L["daily_work.section.sales"], RECOVERY: L["daily_work.section.recovery"] }));
    }
    submittedBatchId = day.currentBatchId;
    // The day's report policy is fixed by its FIRST submitted plan (after the rollout, for a Sales Officer) and shared by every later batch of the date.
    await recordPolicyOnFirstSubmit(tx, officerId, ctx.role, workDate, dailyWorkClock.now());
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkEntry" SET "status" = 'PLAN_SUBMITTED', "planSubmittedAt" = NOW(), "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId} AND "status" = 'DRAFT'`);
    if (Number(updated) === 0) throw new ApiError(409, L["daily_work.validation.empty_batch"]);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkDay" SET "currentBatchId" = ${randomUUID()}, "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date`);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `BATCH:${workDate}:${submittedBatchId}`, summary: "Submitted Daily Work planning batch" }, tx);
  }, SUBMIT_DAY_TRANSACTION);
  } catch (e) {
    // Everything (materialization, status change, batch rotation, audit) rolls back together; the draft is untouched, so a retry is safe and cannot duplicate anything.
    if (isRetryableTransactionError(e)) throw new ApiError(503, L["daily_work.validation.submit_timeout"]);
    throw e;
  }
  return { ok: true, batchId: submittedBatchId };
}

/** Finalize the accumulated Daily Report exactly once and atomically lock the day + Self Rating. */
export async function submitDailyReport(ctx: AuthContext, raw: unknown): Promise<{ ok: true }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const parsed = dailyWorkSchemas(L).submitDay.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["daily_work.validation.rating_required"]);
  const { workDate, selfRating } = parsed.data;
  const officerId = ownerId(ctx);
  let newlyMaterialized = 0;
  let outcomeSummary = { completed: 0, rescheduled: 0, abandoned: 0 };
  await prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.report_already_submitted"]);
    // The deadline follows the report OWNER's persisted policy (Sales Officer, covered plan: midnight ending the work date; otherwise noon of the next day). An approved late-submission request
    // for THIS report keeps it open (no expiry) until this submission succeeds.
    await assertReportWritable(tx, officerId, workDate, L);
    // Auto Tasks are materialized only for TODAY's report: submitting yesterday's still-open report must never add tasks to a day that
    // can no longer be planned (that would make it impossible to finalize). Today's behavior is unchanged.
    const materialized = autoTasksApplyToRole(ctx.role) && workDate === currentBusinessDate(dailyWorkClock.now())
      ? await materializeDueDailyWorkTasksInTransaction(tx, officerId, workDate, day)
      : { materializedTasks: 0, affectedDealers: 0, finalized: false };
    if (materialized.materializedTasks > 0) {
      // Commit the new Recovery work, then refuse finalization outside this transaction.
      newlyMaterialized = materialized.materializedTasks;
      return;
    }
    const report = await reportCompletion(tx, officerId, workDate, day.currentBatchId);
    if (!report.complete) {
      const sectionLabels: Record<MandatorySection, string> = {
        SALES: L["daily_work.section.sales"],
        RECOVERY: L["daily_work.section.recovery"],
        APPOINTMENT: L["daily_work.section.appointment"],
        SCHEME_CONVERSION: L["daily_work.section.scheme_conversion"],
        VISITS: L["daily_work.section.visits"],
        OTHERS: L["daily_work.section.others"],
      };
      const incomplete = report.sections
        .filter((section) => section.required && !section.complete)
        .map((section) => sectionLabels[section.section]);
      throw new ApiError(422, formatLabel(L["daily_work.validation.complete_report"], { sections: incomplete.join(", ") }));
    }
    if (report.paymentModeMissing) throw new ApiError(422, L["daily_work.validation.payment_mode_required"]);
    // Commit the task outcomes in THIS transaction: Completed is recorded as reported, Not Completed — Reschedule moves the same task to its next date, Abandon ends it.
    // Any failure (an invalid draft, a changed task) rolls the whole report back — no partial reschedule / abandon is ever left behind.
    outcomeSummary = await commitTaskOutcomes(tx, ctx, officerId, workDate, currentBusinessDate(dailyWorkClock.now()), L as Record<string, string>);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkDay" SET "status" = 'FINALIZED', "selfRating" = ${selfRating}, "finalizedAt" = NOW(), "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "status" = 'OPEN'`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkEntry" SET "status" = 'FINALIZED', "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "status" = 'PLAN_SUBMITTED'`);
    await completeLateRequest(tx, officerId, workDate); // the approval is consumed by the successful final submission (same transaction)
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `REPORT:${workDate}`, summary: `Submitted Daily Report; self-rating ${selfRating}/10${outcomeSummary.completed + outcomeSummary.rescheduled + outcomeSummary.abandoned > 0 ? `; task outcomes: ${outcomeSummary.completed} completed, ${outcomeSummary.rescheduled} rescheduled, ${outcomeSummary.abandoned} abandoned` : ""}` }, tx);
  });
  if (newlyMaterialized > 0) throw new ApiError(409, L["daily_work.validation.complete_current_plan"]);
  return { ok: true };
}

/* =====================================================================================
 * PHASE 2 — RM TEAM PERFORMANCE + IMMUTABLE RM REVIEW
 *
 * Team scope reuses the existing group-based hierarchy (one RM per group): an RM reviews the SALES_OFFICERs in
 * their own group. Server-authoritative throughout — the client never chooses the team. An RM review is stored
 * in DailyWorkReview keyed by (officerId, workDate); the DB @@unique makes it single + immutable (insert-only).
 * ===================================================================================== */

export interface DailyWorkReviewDto {
  rating: number;
  reviewerId: string;
  reviewerName: string;
  reviewedAt: string;
}
export interface TeamPerformanceRow {
  officerId: string;
  officerName: string;
  submitted: boolean;
  selfRating: number | null; // SO's self-rating (only when submitted); null → "—"
  rmRating: number | null; // this RM's review rating; null → not yet rated ("—")
}
export interface TeamPerformanceSummary {
  salesOfficers: number;
  submitted: number;
  notSubmitted: number;
  averageSelfRating: number | null; // average of AVAILABLE self-ratings only; null when none
  averageRmRating: number | null; // average of AVAILABLE RM ratings only; null when none
}
export interface TeamPerformancePayload {
  workDate: string;
  summary: TeamPerformanceSummary;
  rows: TeamPerformanceRow[];
}

/** Only a Regional Manager (or Super Admin) may review a team; a Sales Officer never can. */
async function assertReviewerRole(ctx: AuthContext, resolved?: ResolvedLabels): Promise<void> {
  if (ctx.role !== Role.REGIONAL_MANAGER && !isAdministrativeRole(ctx.role)) {
    const L = resolved ?? await getResolvedLabels();
    throw new ApiError(403, L["daily_work.review.reviewer_only"]);
  }
}

/** The Sales Officers in the reviewer's authorized team (group-based; excludes the RM themselves). */
async function teamOfficers(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  const scope = await getOfficerScope(ctx);
  const where = scope.all
    ? { role: Role.SALES_OFFICER, isActive: true, deletedAt: null }
    : { role: Role.SALES_OFFICER, isActive: true, deletedAt: null, id: { in: scope.ids.filter((id) => id !== ctx.userId) } };
  const officers = await prisma.user.findMany({ where, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return officers.map((o) => ({ id: o.id, name: o.name }));
}

const average = (values: number[]): number | null =>
  values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;

/**
 * RM Team Performance for a business date: the reviewer's team, each SO's submission state, self-rating and this
 * RM's review, plus a summary. Batched (no N+1): one query each for submitted set, self-ratings and RM ratings.
 */
export async function getTeamPerformance(ctx: AuthContext, rawDate?: string): Promise<TeamPerformancePayload> {
  await assertReviewerRole(ctx);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const officers = await teamOfficers(ctx);
  const ids = officers.map((o) => o.id);

  if (ids.length === 0) {
    return { workDate, summary: { salesOfficers: 0, submitted: 0, notSubmitted: 0, averageSelfRating: null, averageRmRating: null }, rows: [] };
  }

  const [submittedRows, selfRows, rmRows] = await Promise.all([
    prisma.$queryRaw<{ officerId: string }[]>(Prisma.sql`
      SELECT "officerId" FROM "DailyWorkDay"
      WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" = ${workDate}::date AND "status" = 'FINALIZED'`),
    prisma.$queryRaw<{ officerId: string; selfRating: number | null }[]>(Prisma.sql`
      SELECT "officerId", "selfRating" FROM "DailyWorkDay"
      WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" = ${workDate}::date AND "status" = 'FINALIZED'`),
    prisma.$queryRaw<{ officerId: string; rating: number }[]>(Prisma.sql`
      SELECT "officerId", "rating" FROM "DailyWorkReview"
      WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" = ${workDate}::date`),
  ]);

  const submittedSet = new Set(submittedRows.map((r) => r.officerId));
  const selfMap = new Map(selfRows.map((r) => [r.officerId, r.selfRating]));
  const rmMap = new Map(rmRows.map((r) => [r.officerId, r.rating]));

  const rows: TeamPerformanceRow[] = officers.map((o) => {
    const submitted = submittedSet.has(o.id);
    return {
      officerId: o.id,
      officerName: o.name,
      // A self-rating only exists on a submitted day; never surface a rating for an unsubmitted officer.
      selfRating: submitted ? (selfMap.get(o.id) ?? null) : null,
      rmRating: rmMap.get(o.id) ?? null,
      submitted,
    };
  });

  const submitted = rows.filter((r) => r.submitted).length;
  const summary: TeamPerformanceSummary = {
    salesOfficers: rows.length,
    submitted,
    notSubmitted: rows.length - submitted,
    averageSelfRating: average(rows.map((r) => r.selfRating).filter((v): v is number => v != null)),
    averageRmRating: average(rows.map((r) => r.rmRating).filter((v): v is number => v != null)),
  };
  return { workDate, summary, rows };
}

/** Raw read of the single RM review for a submission (with reviewer name), or null. */
async function loadDailyWorkReview(officerId: string, workDate: string): Promise<DailyWorkReviewDto | null> {
  const rows = await prisma.$queryRaw<{ rating: number; reviewerId: string; reviewerName: string; reviewedAt: Date }[]>(Prisma.sql`
    SELECT r."rating", r."reviewerId", u."name" AS "reviewerName", r."reviewedAt"
    FROM "DailyWorkReview" r JOIN "User" u ON u."id" = r."reviewerId"
    WHERE r."officerId" = ${officerId} AND r."workDate" = ${workDate}::date
    LIMIT 1`);
  const r = rows[0];
  return r ? { rating: r.rating, reviewerId: r.reviewerId, reviewerName: r.reviewerName, reviewedAt: r.reviewedAt.toISOString() } : null;
}

async function isDailyWorkSubmitted(officerId: string, workDate: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ submitted: boolean }[]>(Prisma.sql`
    SELECT EXISTS(
      SELECT 1 FROM "DailyWorkDay"
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "status" = 'FINALIZED'
    ) AS "submitted"`);
  return rows[0]?.submitted ?? false;
}

/** Plan Submission milestone: Submit Daily Work stamps `planSubmittedAt` on the day's frozen entries (the same source Performance shows). */
async function isDailyWorkPlanSubmitted(officerId: string, workDate: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ submitted: boolean }[]>(Prisma.sql`
    SELECT EXISTS(
      SELECT 1 FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "planSubmittedAt" IS NOT NULL
    ) AS "submitted"`);
  return rows[0]?.submitted ?? false;
}

export interface DailyWorkReviewDetailPayload {
  officerId: string;
  officerName: string;
  /** The reviewed person's role (decides whether an RM rating applies: it never does for a Regional Manager). */
  officerRole: Role;
  workDate: string;
  sales: DailyWorkPayload;
  recovery: DailyWorkPayload;
  appointment: AppointmentPayload;
  conversion: ConversionPayload;
  summary: DailySummaryPayload;
  selfRating: number | null;
  review: DailyWorkReviewDto | null;
  /** false → only the Daily Plan has been submitted: no actuals, self-rating or RM rating exist, and rating is not allowed. */
  reportSubmitted: boolean;
  reportSections: { section: MandatorySection; required: boolean; complete: boolean }[];
}

/**
 * Consolidated READ-ONLY detail of one team member's submitted Daily Work, for the RM review view. Reuses the
 * existing section getters (scope-checked via resolveReadOfficer) — no duplicate data logic — plus the SO's
 * self-rating and any existing RM review. Read-only: no editing/submission is possible through this path.
 */
export async function getDailyWorkReviewDetail(ctx: AuthContext, rawOfficerId: string, rawDate?: string, opts: { allowPlanOnly?: boolean } = {}): Promise<DailyWorkReviewDetailPayload> {
  const L = await getResolvedLabels();
  const officerId = (rawOfficerId ?? "").trim();
  if (!officerId) throw new ApiError(422, L["daily_work.review.invalid_officer"]);
  // A Sales Officer may open their OWN detail (read-only); an RM/Admin may open any officer within their scope.
  if (officerId !== ctx.userId) {
    await assertReviewerRole(ctx, L);
    await assertOfficerInScope(ctx, officerId); // RM's team / Admin scope; else 403
  }
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  // The Daily Report (finalized day) gives the full review. With `allowPlanOnly` (Performance → View) a day whose Daily Plan
  // was submitted but whose report was not is also viewable — as the submitted plan only. Rating is still report-only.
  const reportSubmitted = await isDailyWorkSubmitted(officerId, workDate);
  if (!reportSubmitted && !(opts.allowPlanOnly && await isDailyWorkPlanSubmitted(officerId, workDate))) throw new ApiError(409, L["daily_work.review.not_submitted"]);

  const [officer, sales, recovery, appointment, conversion, summary, status, review] = await Promise.all([
    prisma.user.findUnique({ where: { id: officerId }, select: { name: true, role: true } }),
    getDailyWork(ctx, "SALES", workDate, officerId, "REPORT"),
    getDailyWork(ctx, "RECOVERY", workDate, officerId, "REPORT"),
    getDailyAppointment(ctx, workDate, officerId, "REPORT"),
    getDailyConversion(ctx, workDate, officerId, "REPORT"),
    getDailySummary(ctx, workDate, officerId, "REPORT"),
    getDailyStatus(ctx, workDate, officerId),
    loadDailyWorkReview(officerId, workDate),
  ]);
  return {
    officerId,
    officerName: officer?.name ?? "—",
    officerRole: officer?.role ?? Role.SALES_OFFICER,
    workDate,
    sales,
    // Payment Mode is a Daily REPORT value: a plan-only day must never present a (legacy) planned mode as an actual receipt.
    recovery: reportSubmitted ? recovery : { ...recovery, dealers: recovery.dealers.map(({ paymentMode: _paymentMode, ...dealer }) => dealer) },
    appointment, conversion, summary,
    // Never invent report-only values for a plan-only day.
    selfRating: reportSubmitted ? status.selfRating : null, reportSections: status.reportSections,
    review: reportSubmitted ? review : null,
    reportSubmitted,
  };
}

const adminDailyWorkViewSchema = z.object({
  workDate: z.string().refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }, "A valid date is required"),
  groupId: z.string().min(1),
  officerId: z.string().min(1),
});

/**
 * Admin-only Daily Report viewer. State is User.groupId and is validated together with the selected active SO
 * before delegating to the existing consolidated submitted-report reader. This endpoint never exposes writes.
 */
export async function getAdminDailyWorkView(ctx: AuthContext, raw: unknown): Promise<DailyWorkReviewDetailPayload> {
  const L = await getResolvedLabels();
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, L["daily_work.performance.forbidden"]);
  const parsed = adminDailyWorkViewSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["daily_work.validation.valid_date"]);
  const { workDate, groupId, officerId } = parsed.data;
  const officer = await prisma.user.findUnique({ where: { id: officerId }, select: { role: true, groupId: true, isActive: true, deletedAt: true } });
  if (!officer || officer.role !== Role.SALES_OFFICER || !officer.isActive || officer.deletedAt || officer.groupId !== groupId) {
    throw new ApiError(403, L["daily_work.performance.forbidden"]);
  }
  return getDailyWorkReviewDetail(ctx, officerId, workDate);
}

/**
 * Create the RM's IMMUTABLE review of a team member's submitted Daily Work. Server-authoritative:
 * reviewer must be an RM; officer must be within the RM's team and be a Sales Officer (not the RM themselves);
 * the Daily Work must be SUBMITTED; rating is an integer 1–10. The DB @@unique(officerId, workDate) guarantees
 * exactly one review — a duplicate/concurrent attempt inserts 0 rows and is rejected (409). There is no update
 * or delete path, so an existing review can never be modified or replaced.
 */
export async function createDailyWorkReview(ctx: AuthContext, raw: unknown): Promise<DailyWorkReviewDto> {
  const L = await getResolvedLabels();
  // Reviewing is RM-only. Admin observes performance read-only and can never create/modify a review (Phase 3),
  // so a Super Admin is rejected here even though they may READ team/detail data.
  if (ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, L["daily_work.review.reviewer_only"]);
  const parsed = dailyWorkSchemas(L).reviewCreate.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["daily_work.review.rating_required"]);
  const { officerId, workDate, rating } = parsed.data;

  if (officerId === ctx.userId) throw new ApiError(422, L["daily_work.review.invalid_officer"]);
  await assertOfficerInScope(ctx, officerId); // must be in the RM's team; else 403
  const officer = await prisma.user.findUnique({ where: { id: officerId }, select: { role: true } });
  if (!officer || officer.role !== Role.SALES_OFFICER) throw new ApiError(422, L["daily_work.review.invalid_officer"]);
  if (!(await isDailyWorkSubmitted(officerId, workDate))) throw new ApiError(409, L["daily_work.review.not_submitted"]);

  // Insert-only. ON CONFLICT DO NOTHING + affected-count makes create idempotent-safe and blocks duplicate/
  // concurrent reviews atomically (the unique index picks a single winner).
  const inserted = await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "DailyWorkReview" ("id","officerId","workDate","reviewerId","rating","reviewedAt","createdAt")
    VALUES (${randomUUID()}, ${officerId}, ${workDate}::date, ${ctx.userId}, ${rating}, NOW(), NOW())
    ON CONFLICT ("officerId","workDate") DO NOTHING`);
  if (inserted === 0) throw new ApiError(409, L["daily_work.review.already_reviewed"]);

  await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "CREATE", entity: "dailyWorkReview", entityId: `${officerId}:${workDate}`, summary: `Reviewed daily work ${rating}/10` });
  const review = await loadDailyWorkReview(officerId, workDate);
  if (!review) throw new ApiError(500, L["daily_work.review.already_reviewed"]);
  return review;
}

/* =====================================================================================
 * PHASE 3 — ADMIN COMPANY-WIDE PERFORMANCE DASHBOARD (read-only)
 *
 * Derived entirely from the existing sources — DailyWorkEntry (submission + self-rating), DailyWorkReview
 * (RM rating) and the User/UserGroup hierarchy — no new performance table or score. Server-authoritative:
 * the eligible SO population and the RM/group mapping are computed here; browser filter values are only
 * applied on top of that authoritative set. Batched (no N+1): a fixed number of queries regardless of team size.
 * ===================================================================================== */

export interface AdminPerformanceRow {
  officerId: string;
  officerName: string;
  groupId: string | null;
  groupName: string | null;
  rmId: string | null;
  rmName: string | null;
  submitted: boolean;
  selfRating: number | null;
  rmRating: number | null;
}
export interface AdminPerformanceFilterOption { id: string; name: string }
export interface AdminPerformancePayload {
  workDate: string;
  summary: TeamPerformanceSummary;
  rows: AdminPerformanceRow[];
  rms: AdminPerformanceFilterOption[]; // RM filter options (authoritative)
  groups: AdminPerformanceFilterOption[]; // group filter options (authoritative)
}

/** Only a Super Admin may see company-wide performance. */
async function assertAdmin(ctx: AuthContext, resolved?: ResolvedLabels): Promise<void> {
  if (!isAdministrativeRole(ctx.role)) {
    const L = resolved ?? await getResolvedLabels();
    throw new ApiError(403, L["daily_work.performance.admin_only"]);
  }
}

const adminPerformanceFilterSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rmId: z.string().optional(),
  groupId: z.string().optional(),
  submission: z.enum(["ALL", "SUBMITTED", "NOT_SUBMITTED"]).optional().default("ALL"),
});

/**
 * Company-wide daily performance for the Admin dashboard. Eligible SOs = active, non-deleted SALES_OFFICERs
 * (matching the app's user-status convention). Each row carries the SO's group and that group's RM. Filters
 * (rm/group/submission) are applied server-side; the summary reflects the filtered set. Missing ratings are
 * excluded from averages (never counted as 0).
 */
export async function getAdminPerformance(ctx: AuthContext, raw: unknown = {}): Promise<AdminPerformancePayload> {
  const L = await getResolvedLabels();
  await assertAdmin(ctx, L);
  const filters = adminPerformanceFilterSchema.parse(raw ?? {});
  const workDate = filters.date ?? currentBusinessDate();

  // Authoritative population + hierarchy (2 user queries; independent of team size).
  const [officers, managers] = await Promise.all([
    prisma.user.findMany({
      where: { role: Role.SALES_OFFICER, isActive: true, deletedAt: null },
      select: { id: true, name: true, groupId: true, group: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      where: { role: Role.REGIONAL_MANAGER, isActive: true, deletedAt: null },
      select: { id: true, name: true, groupId: true },
    }),
  ]);
  // One RM per group (existing hierarchy).
  const rmByGroup = new Map<string, { id: string; name: string }>();
  for (const m of managers) if (m.groupId && !rmByGroup.has(m.groupId)) rmByGroup.set(m.groupId, { id: m.id, name: m.name });

  const ids = officers.map((o) => o.id);
  const [submittedRows, selfRows, rmRows] = ids.length === 0
    ? [[], [], []] as [{ officerId: string }[], { officerId: string; selfRating: number | null }[], { officerId: string; rating: number }[]]
    : await Promise.all([
        prisma.$queryRaw<{ officerId: string }[]>(Prisma.sql`
          SELECT "officerId" FROM "DailyWorkDay"
          WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" = ${workDate}::date AND "status" = 'FINALIZED'`),
        prisma.$queryRaw<{ officerId: string; selfRating: number | null }[]>(Prisma.sql`
          SELECT "officerId", "selfRating" FROM "DailyWorkDay"
          WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" = ${workDate}::date AND "status" = 'FINALIZED'`),
        prisma.$queryRaw<{ officerId: string; rating: number }[]>(Prisma.sql`
          SELECT "officerId", "rating" FROM "DailyWorkReview"
          WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" = ${workDate}::date`),
      ]);
  const submittedSet = new Set(submittedRows.map((r) => r.officerId));
  const selfMap = new Map(selfRows.map((r) => [r.officerId, r.selfRating]));
  const rmMap = new Map(rmRows.map((r) => [r.officerId, r.rating]));

  let rows: AdminPerformanceRow[] = officers.map((o) => {
    const submitted = submittedSet.has(o.id);
    const rm = o.groupId ? rmByGroup.get(o.groupId) ?? null : null;
    return {
      officerId: o.id,
      officerName: o.name,
      groupId: o.groupId,
      groupName: o.group?.name ?? null,
      rmId: rm?.id ?? null,
      rmName: rm?.name ?? null,
      submitted,
      selfRating: submitted ? (selfMap.get(o.id) ?? null) : null,
      rmRating: rmMap.get(o.id) ?? null,
    };
  });

  // Server-side filters (validated against the authoritative set).
  if (filters.groupId) rows = rows.filter((r) => r.groupId === filters.groupId);
  if (filters.rmId) rows = rows.filter((r) => r.rmId === filters.rmId);
  if (filters.submission === "SUBMITTED") rows = rows.filter((r) => r.submitted);
  else if (filters.submission === "NOT_SUBMITTED") rows = rows.filter((r) => !r.submitted);

  const submitted = rows.filter((r) => r.submitted).length;
  const summary: TeamPerformanceSummary = {
    salesOfficers: rows.length,
    submitted,
    notSubmitted: rows.length - submitted,
    averageSelfRating: average(rows.map((r) => r.selfRating).filter((v): v is number => v != null)),
    averageRmRating: average(rows.map((r) => r.rmRating).filter((v): v is number => v != null)),
  };

  // Filter options come from the whole population (not the filtered rows), so the Admin can always switch.
  const groups = [...new Map(officers.filter((o) => o.group).map((o) => [o.group!.id, { id: o.group!.id, name: o.group!.name }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const rms = [...rmByGroup.values()].map((m) => ({ id: m.id, name: m.name })).sort((a, b) => a.name.localeCompare(b.name));

  return { workDate, summary, rows, rms, groups };
}

/* =====================================================================================
 * PHASE 4 — ROLE-AWARE, DATE-RANGE PERFORMANCE (SO / RM / Admin)
 *
 * One role-aware report over a business-date range. Scope, columns and filters differ by role but the data
 * sources are the SAME as Phases 1–3: plan submission = DailyWorkEntry.planSubmittedAt (earliest per day),
 * report submission = DailyWorkDay.finalizedAt, self-rating = DailyWorkDay.selfRating, RM rating =
 * DailyWorkReview, State = the officer's UserGroup (region).
 * Server-authoritative population + filters. Batched: a FIXED set of queries independent of #officers × #days.
 * ===================================================================================== */

const MAX_PERFORMANCE_RANGE_DAYS = 92; // guardrail: a bounded report keeps the row set (and query cost) sane

export interface PerformanceRow {
  officerId: string;
  officerName: string;
  /** The role of the person this row represents (not of the viewer): an RM row never carries an RM rating. */
  officerRole: Role;
  groupId: string | null;
  stateName: string | null; // the officer's UserGroup (region) — shown as "State" for Admin
  date: string; // YYYY-MM-DD business date
  planSubmittedAt: string | null; // ISO; null → "—"
  reportSubmittedAt: string | null; // ISO; null → "—"
  selfRating: number | null;
  rmRating: number | null;
  submitted: boolean; // plan submitted that day → detail is openable
  /** Compact Task Activity of this employee / date (see getTaskActivity); null only when it could not be computed — the rest of the row is unaffected. */
  taskActivity: { tasks: number; completed: number; reschedules: number; abandoned: number; sections: Record<string, number> } | null;
  /** Derived, never stored: plan submitted, report not finalized and the OWNER's deadline has passed → shown as "Missed". A skipped date (no plan, after the rollout) is Missed in both columns. */
  reportMissed: boolean;
  /** Derived: a Sales Officer submitted no plan on a past date after the rollout → "Missed" under Plan Submission too (display only: no plan, report, task or request exists for it). */
  planMissed: boolean;
  /** Late-submission state of this report: an open request ("Pending Approval" / "Reopened") and `late` = the report was finally submitted after its deadline with approval. */
  lateReport: { open: "PENDING" | "APPROVED" | null; late: boolean };
}
export interface PerformanceSummary {
  salesOfficers: number; // Sales Officers only — a Regional Manager's own row is never counted here
  employeeDays: number; // eligible employee-days = officers × dates in range (the denominator of "not submitted")
  submittedPlans: number;
  submittedReports: number;
  averageSelfRating: number | null; // excludes missing (never 0)
  averageRmRating: number | null; // excludes missing (never 0) and Regional Manager rows (an RM rating does not apply to them)
  /** Σ Planned / Actual per section over the SAME filtered population and dates as the rows (see performanceSectionTotals for units). */
  sections: PerformanceSectionTotals;
}
export interface PerformanceOption { id: string; name: string }
export interface PerformancePayload {
  role: Role;
  from: string;
  to: string;
  rows: PerformanceRow[];
  summary: PerformanceSummary;
  officers: PerformanceOption[]; // Sales Officer filter options (the authoritative population)
  states: PerformanceOption[]; // State (group) filter options — Admin only, else []
}

const isDateKey = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00.000Z`).getTime());
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cur.getTime() <= end.getTime()) { out.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}

const performanceFilterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  officerId: z.string().optional(), // legacy single-person callers
  officerIds: z.array(z.string().min(1)).optional(),
  groupId: z.string().optional(), // legacy single-State callers — Admin only
  groupIds: z.array(z.string().min(1)).optional(), // State column multiselect — Admin only
});

/** Roles that own Daily Work (and therefore appear in Performance). */
const DAILY_WORK_OWNER_ROLES = [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] as const;

/** The authoritative Daily Work performer population for the caller (server-side scope), with group/state names. */
type PerformancePerson = { id: string; name: string; role: Role; groupId: string | null; groupName: string | null };
async function performancePopulation(ctx: AuthContext): Promise<PerformancePerson[]> {
  const select = { id: true, name: true, role: true, groupId: true, group: { select: { id: true, name: true } } } as const;
  if (ctx.role === Role.SALES_OFFICER) {
    const self = await prisma.user.findUnique({ where: { id: ctx.userId }, select });
    return self ? [{ id: self.id, name: self.name, role: self.role, groupId: self.groupId, groupName: self.group?.name ?? null }] : [];
  }
  if (ctx.role === Role.REGIONAL_MANAGER) {
    // The RM's own row first, then their authorized Sales Officers. Each user is one row source (unique id), so the RM is never counted twice.
    const scope = await getOfficerScope(ctx);
    const ids = scope.ids.filter((id) => id !== ctx.userId);
    const [self, officers] = await Promise.all([
      prisma.user.findUnique({ where: { id: ctx.userId }, select }),
      ids.length === 0 ? [] : prisma.user.findMany({ where: { role: Role.SALES_OFFICER, isActive: true, deletedAt: null, id: { in: ids } }, select, orderBy: { name: "asc" } }),
    ]);
    return [...(self ? [self] : []), ...officers].map((o) => ({ id: o.id, name: o.name, role: o.role, groupId: o.groupId, groupName: o.group?.name ?? null }));
  }
  // Super Admin — company-wide. Daily Work owners are Sales Officers AND Regional Managers (an RM submits Daily Work too),
  // so both appear. Each user is one row source (unique id), so nobody is double-counted. The RM caller's own scope above is unchanged.
  const officers = await prisma.user.findMany({ where: { role: { in: [...DAILY_WORK_OWNER_ROLES] }, isActive: true, deletedAt: null }, select, orderBy: { name: "asc" } });
  return officers.map((o) => ({ id: o.id, name: o.name, role: o.role, groupId: o.groupId, groupName: o.group?.name ?? null }));
}

/**
 * Role-aware date-range performance. SO → own rows only (no SO/State columns); RM → authorized team (+SO filter);
 * Admin → all SOs (+SO and State filters). Filters are validated against the authoritative population server-side.
 */
/**
 * The SUBMITTED plan rows (planSubmittedAt set — the "Submitted Plans" rule) of the given officers and dates, with whether that day's report is
 * finalized. Drafts never appear. The summary cards total these rows (performanceSectionTotals) and the card drill-down lists them — the same
 * rows and the same per-row rule (performanceRowValue), so the two always reconcile. Nothing here is loaded into the browser.
 */
async function loadPerformanceEntryRows(ids: string[], from: string, to: string): Promise<PerformanceEntryRow[]> {
  if (ids.length === 0) return [];
  return prisma.$queryRaw<PerformanceEntryRow[]>(Prisma.sql`
    SELECT e."id", e."officerId", e."workDate", e."dealerId", e."schemeId", e."marketName", e."entryType", e."batchId",
           e."section", e."typedDealerName", e."todaysPlan"::text AS "todaysPlan", e."todaysActual"::text AS "todaysActual", e."resultStatus",
           e."dealerVisits", e."newPartyVisits", e."actualDealerVisits", e."actualNewPartyVisits", e."monthlyPlanId", e."reportedDealerName",
           (d."finalizedAt" IS NOT NULL OR d."status" = 'FINALIZED') AS "reportFinalized"
    FROM "DailyWorkEntry" e
    LEFT JOIN "DailyWorkDay" d ON d."officerId" = e."officerId" AND d."workDate" = e."workDate"
    WHERE e."officerId" IN (${Prisma.join(ids)}) AND e."workDate" BETWEEN ${from}::date AND ${to}::date
      AND e."planSubmittedAt" IS NOT NULL AND e."status" IN ('PLAN_SUBMITTED','FINALIZED','SUBMITTED')
      AND e."section" IN ('SALES','RECOVERY','APPOINTMENT','SCHEME_CONVERSION','SUMMARY')
      AND (e."section" <> 'SUMMARY' OR e."rowKey" = ${SUMMARY_ROWKEY})`);
}

/**
 * The ONE filter resolution behind the Performance table, its summary cards and the card drill-down: role gate, date range, State and officer
 * validated against the caller's authoritative population. Anything outside the caller's scope is refused (403), never silently widened.
 */
async function resolvePerformanceFilters(ctx: AuthContext, raw: unknown) {
  const L = await getResolvedLabels();
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER && !isAdministrativeRole(ctx.role)) {
    throw new ApiError(403, L["daily_work.performance.forbidden"]);
  }
  const filters = performanceFilterSchema.parse(raw ?? {});
  const today = currentBusinessDate();
  const to = filters.to && isDateKey(filters.to) ? filters.to : today;
  const from = filters.from && isDateKey(filters.from) ? filters.from : to;
  if (from > to) throw new ApiError(422, L["daily_work.performance.invalid_range"]);
  const dates = enumerateDates(from, to);
  if (dates.length > MAX_PERFORMANCE_RANGE_DAYS) throw new ApiError(422, L["daily_work.performance.range_too_large"]);

  let population = await performancePopulation(ctx);

  // OR within selected States, then AND with employee choices. State never widens role scope.
  const selectedGroupIds = new Set([...(filters.groupIds ?? []), ...(filters.groupId ? [filters.groupId] : [])]);
  if (isAdministrativeRole(ctx.role) && selectedGroupIds.size > 0) {
    population = population.filter((p) => p.groupId != null && selectedGroupIds.has(p.groupId));
  }
  const selectedIds = new Set([...(filters.officerIds ?? []), ...(filters.officerId ? [filters.officerId] : [])]);
  if (ctx.role !== Role.SALES_OFFICER && selectedIds.size > 0) {
    const allowed = new Set(population.map((p) => p.id));
    if ([...selectedIds].some((id) => !allowed.has(id))) throw new ApiError(403, L["daily_work.performance.forbidden"]);
    population = population.filter((p) => selectedIds.has(p.id));
  }
  return { L, filters, from, to, dates, population, selectedGroupIds };
}

/**
 * The caller's authorized population for Performance → Tasks (the SAME role scope, State and employee narrowing as the Performance table — anything outside it is refused),
 * plus the State / employee options. Date ranges are not validated here: the task filters own their dates.
 */
export async function taskAnalysisScope(ctx: AuthContext, raw: { officerId?: string; groupId?: string } = {}) {
  const today = currentBusinessDate();
  const { population } = await resolvePerformanceFilters(ctx, { from: today, to: today, officerId: raw.officerId || undefined, groupId: raw.groupId || undefined });
  const full = await performancePopulation(ctx);
  const groupId = isAdministrativeRole(ctx.role) ? raw.groupId : undefined;
  return {
    population: population.map((p) => ({ id: p.id, name: p.name, role: p.role as string, groupId: p.groupId, groupName: p.groupName })),
    officers: (groupId ? full.filter((p) => p.groupId === groupId) : full).map((p) => ({ id: p.id, name: p.name })),
    states: isAdministrativeRole(ctx.role) ? [...new Map(full.filter((p) => p.groupId).map((p) => [p.groupId!, { id: p.groupId!, name: p.groupName ?? p.groupId! }])).values()].sort((a, b) => a.name.localeCompare(b.name)) : [],
  };
}

export async function getDailyPerformance(ctx: AuthContext, raw: unknown = {}): Promise<PerformancePayload> {
  const { from, to, dates, population, selectedGroupIds } = await resolvePerformanceFilters(ctx, raw);

  const ids = population.map((p) => p.id);
  const [planRows, dayRows, rmRows, entryRows] = ids.length === 0
    ? [[], [], [], []] as [
        { officerId: string; workDate: Date; planSubmittedAt: Date | null }[],
        { officerId: string; workDate: Date; finalizedAt: Date | null; selfRating: number | null; status: string }[],
        { officerId: string; workDate: Date; rating: number }[],
        PerformanceEntryRow[],
      ]
    : await Promise.all([
        prisma.$queryRaw<{ officerId: string; workDate: Date; planSubmittedAt: Date | null }[]>(Prisma.sql`
          SELECT "officerId", "workDate", MIN("planSubmittedAt") AS "planSubmittedAt"
          FROM "DailyWorkEntry"
          WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" BETWEEN ${from}::date AND ${to}::date AND "planSubmittedAt" IS NOT NULL
          GROUP BY "officerId", "workDate"`),
        prisma.$queryRaw<{ officerId: string; workDate: Date; finalizedAt: Date | null; selfRating: number | null; status: string }[]>(Prisma.sql`
          SELECT "officerId", "workDate", "finalizedAt", "selfRating", "status"
          FROM "DailyWorkDay"
          WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" BETWEEN ${from}::date AND ${to}::date`),
        prisma.$queryRaw<{ officerId: string; workDate: Date; rating: number }[]>(Prisma.sql`
          SELECT "officerId", "workDate", "rating"
          FROM "DailyWorkReview"
          WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" BETWEEN ${from}::date AND ${to}::date`),
        // ONE query for every section total (and for the card drill-down — loadPerformanceEntryRows): the SUBMITTED plan rows of the filtered officers and dates.
        loadPerformanceEntryRows(ids, from, to),
      ]);

  const dk = (d: Date): string => d.toISOString().slice(0, 10);
  const cell = (officerId: string, date: string) => `${officerId}|${date}`;
  const planMap = new Map(planRows.map((r) => [cell(r.officerId, dk(r.workDate)), r.planSubmittedAt]));
  const dayMap = new Map(dayRows.map((r) => [cell(r.officerId, dk(r.workDate)), r]));
  const rmMap = new Map(rmRows.map((r) => [cell(r.officerId, dk(r.workDate)), r.rating]));

  const now = dailyWorkClock.now();
  // Task Activity: two batch queries for the WHOLE table (never one per row). A failure here must never take the existing Performance view down.
  let activity: Awaited<ReturnType<typeof getTaskActivity>> | null = null;
  if (ids.length > 0) {
    try { activity = await getTaskActivity({ population: population.map((p) => ({ id: p.id, name: p.name, role: p.role as string, groupId: p.groupId, groupName: p.groupName })), officers: [], states: [] }, from, to); }
    catch (error) { console.error("[performance] task activity unavailable", error instanceof Error ? error.name : "Unknown error"); }
  }
  // Deadline policy + late-submission facts for the whole table: three batched reads, never one per employee / date.
  const [policies, lateFacts, rolloutAt] = ids.length > 0 ? await Promise.all([loadPolicyDeadlines(prisma, ids, from, to), loadLateRequestFacts(prisma, ids, from, to), rolloutEffectiveAt(prisma)]) : [new Map<string, Date>(), new Map<string, { open: "PENDING" | "APPROVED" | null; completed: boolean }>(), null];
  const rolloutDate = rolloutAt ? currentBusinessDate(rolloutAt) : null;
  const todayDate = currentBusinessDate(now);
  const rows: PerformanceRow[] = [];
  for (const officer of population) {
    for (const date of dates) {
      const key = cell(officer.id, date);
      const day = dayMap.get(key);
      const plan = planMap.get(key) ?? null;
      const finalized = day?.finalizedAt ?? null;
      const isFinal = day?.status === "FINALIZED" || finalized != null;
      const policy = policies.get(key);
      const passed = policy ? isStrictDeadlinePassed(policy, now) : isReportDeadlinePassed(date, now);
      const facts = lateFacts.get(key);
      // A skipped date (Sales Officer, after the rollout, before today, no submitted plan): Missed in both columns — display only.
      const planMissed = officer.role === Role.SALES_OFFICER && plan == null && rolloutDate !== null && date > rolloutDate && date < todayDate;
      rows.push({
        officerId: officer.id,
        officerName: officer.name,
        officerRole: officer.role,
        groupId: officer.groupId,
        stateName: officer.groupName,
        date,
        planSubmittedAt: plan ? plan.toISOString() : null,
        reportSubmittedAt: finalized ? finalized.toISOString() : null,
        // A self-rating is committed only at report finalization; surface it only then (never as 0).
        selfRating: finalized && day?.selfRating != null ? day.selfRating : null,
        // An RM rating does not apply to a Regional Manager: that row never carries one.
        rmRating: officer.role === Role.REGIONAL_MANAGER ? null : rmMap.get(key) ?? null,
        submitted: plan != null,
        taskActivity: activity ? { ...(activity.get(key) ?? { tasks: 0, completed: 0, reschedules: 0, abandoned: 0, sections: {} }) } : null,
        reportMissed: planMissed || (plan != null && !isFinal && passed),
        planMissed,
        lateReport: { open: isFinal ? null : facts?.open ?? null, late: isFinal && (facts?.completed ?? false) },
      });
    }
  }

  const summary: PerformanceSummary = {
    salesOfficers: population.filter((p) => p.role === Role.SALES_OFFICER).length,
    employeeDays: rows.length,
    submittedPlans: rows.filter((r) => r.planSubmittedAt != null).length,
    submittedReports: rows.filter((r) => r.reportSubmittedAt != null).length,
    averageSelfRating: average(rows.map((r) => r.selfRating).filter((v): v is number => v != null)),
    averageRmRating: average(rows.filter((r) => r.officerRole === Role.SALES_OFFICER).map((r) => r.rmRating).filter((v): v is number => v != null)),
    sections: performanceSectionTotals(entryRows),
  };

  // State options always span the full authoritative population. Admin officer options follow the selected State;
  // with All States they span the company. RM options retain their existing team scope.
  const fullPopulation = await performancePopulation(ctx);
  const officerOptions = isAdministrativeRole(ctx.role) && selectedGroupIds.size > 0
    ? fullPopulation.filter((p) => p.groupId != null && selectedGroupIds.has(p.groupId))
    : fullPopulation;
  const officers = officerOptions.map((p) => ({ id: p.id, name: p.name }));
  const states = isAdministrativeRole(ctx.role)
    ? [...new Map(fullPopulation.filter((p) => p.groupId).map((p) => [p.groupId!, { id: p.groupId!, name: p.groupName ?? p.groupId! }])).values()].sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    role: ctx.role,
    from, to, rows, summary, officers, states,
  };
}

/* ---------- Summary card drill-down: which records make up a Planned / Actual total ---------- */

export interface PerformanceDetailRow {
  entryId: string; date: string; officerId: string; employeeName: string; role: Role; stateName: string | null;
  section: string; value: number; record: string | null; recordDetail: string | null;
  visitParts: { dealer: number; newParty: number } | null; reportFinalized: boolean;
}
export interface PerformanceDetailPayload {
  metric: PerformanceMetric; unit: PerformanceUnit; kind: "planned" | "actual"; from: string; to: string;
  stateName: string | null; officerName: string | null;
  total: number; recordCount: number; employeeCount: number; // over ALL matching records, not the page
  rows: PerformanceDetailRow[]; page: number; pageSize: number; totalPages: number;
  sort: "date" | "employee" | "value"; dir: "asc" | "desc";
}
const DETAIL_MAX_PAGE_SIZE = 100;

/**
 * The records behind ONE summary metric, under the SAME role scope, Date From/To, State and officer filters as the Performance page
 * (resolvePerformanceFilters), from the SAME rows and per-row rule as the summary total (loadPerformanceEntryRows / performanceRowValue).
 * total / recordCount / employeeCount cover every contributing record; only `rows` is paged.
 */
export async function getPerformanceMetricDetail(ctx: AuthContext, raw: unknown = {}): Promise<PerformanceDetailPayload> {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { L, filters, from, to, population, selectedGroupIds } = await resolvePerformanceFilters(ctx, input);
  if (!isPerformanceMetric(input.metric)) throw new ApiError(422, L["daily_work.performance.invalid_metric"]);
  const metric = input.metric;
  const info = PERFORMANCE_METRIC_INFO[metric];
  const sort = input.sort === "employee" || input.sort === "value" ? input.sort : "date";
  const dir = input.dir === "desc" ? "desc" : input.dir === "asc" ? "asc" : sort === "date" ? "desc" : "asc";
  const pageSize = Math.min(DETAIL_MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(input.pageSize)) || 25));

  const people = new Map(population.map((p) => [p.id, p]));
  const entries = await loadPerformanceEntryRows(population.map((p) => p.id), from, to);
  const contributions = entries.flatMap((r) => {
    const value = performanceRowValue(r, metric);
    const person = r.officerId ? people.get(r.officerId) : undefined;
    return value == null || !person ? [] : [{ r, value, person, date: r.workDate instanceof Date ? r.workDate.toISOString().slice(0, 10) : String(r.workDate).slice(0, 10) }];
  });
  const total = round2(contributions.reduce((sum, c) => sum + c.value, 0));
  const employeeCount = new Set(contributions.map((c) => c.person.id)).size;

  const sign = dir === "asc" ? 1 : -1;
  contributions.sort((a, b) => {
    const byDate = a.date.localeCompare(b.date), byName = a.person.name.localeCompare(b.person.name), byValue = a.value - b.value;
    const primary = sort === "date" ? byDate : sort === "employee" ? byName : byValue;
    return sign * primary || byDate * -1 || byName || String(a.r.id).localeCompare(String(b.r.id));
  });
  const totalPages = Math.max(1, Math.ceil(contributions.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(input.page)) || 1));
  const pageRows = contributions.slice((page - 1) * pageSize, page * pageSize);

  // Record names for the visible page only: two batched lookups, never one per row.
  const dealerIds = [...new Set(pageRows.map((c) => c.r.dealerId).filter((x): x is string => !!x))];
  const schemeIds = [...new Set(pageRows.map((c) => c.r.schemeId).filter((x): x is string => !!x))];
  const [dealerRows, aliasNames, schemeRows] = await Promise.all([
    dealerIds.length ? prisma.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true } }) : [],
    dealerIds.length ? loadDealerAliasNameMap(dealerIds) : new Map<string, string>(),
    schemeIds.length ? prisma.scheme.findMany({ where: { id: { in: schemeIds } }, select: { id: true, schemeName: true } }) : [],
  ]);
  const dealerName = new Map(dealerRows.map((d) => [d.id, aliasNames.get(d.id) ?? d.name]));
  const schemeName = new Map(schemeRows.map((x) => [x.id, x.schemeName]));

  const rows: PerformanceDetailRow[] = pageRows.map(({ r, value, person, date }) => {
    const dealer = r.dealerId ? dealerName.get(r.dealerId) ?? null : null;
    const scheme = r.schemeId ? schemeName.get(r.schemeId) ?? null : null;
    const appointment = info.section === "APPOINTMENT";
    return {
      entryId: String(r.id), date, officerId: person.id, employeeName: person.name, role: person.role, stateName: person.groupName,
      section: info.section, value,
      record: appointment ? (r.typedDealerName ?? "").trim() || r.marketName || null : dealer,
      recordDetail: appointment ? ((r.typedDealerName ?? "").trim() ? r.marketName ?? null : (r.reportedDealerName ?? "").trim() || null) : scheme,
      visitParts: info.section === "SUMMARY"
        ? (info.kind === "planned" ? { dealer: r.dealerVisits ?? 0, newParty: r.newPartyVisits ?? 0 } : { dealer: r.actualDealerVisits ?? 0, newParty: r.actualNewPartyVisits ?? 0 })
        : null,
      reportFinalized: r.reportFinalized,
    };
  });

  const stateName = isAdministrativeRole(ctx.role) && selectedGroupIds.size > 0
    ? [...new Set((await performancePopulation(ctx)).filter((p) => p.groupId != null && selectedGroupIds.has(p.groupId)).map((p) => p.groupName).filter((name): name is string => name != null))].sort((a, b) => a.localeCompare(b)).join(", ") || null
    : null;
  return {
    metric, unit: info.unit, kind: info.kind, from, to, stateName, officerName: filters.officerId || filters.officerIds?.length ? population.map((p) => p.name).join(", ") || null : null,
    total, recordCount: contributions.length, employeeCount, rows, page, pageSize, totalPages, sort, dir,
  };
}
