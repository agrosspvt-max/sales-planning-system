import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";
import { hasAdminPermission } from "@/features/accounts/permissions";

import { resolveWorkDateMonth } from "@/lib/season-calendar";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getCurrentDealerIds, getOfficerScope, assertOfficerInScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { runningSchemes } from "@/features/schemes/scheme-planning.server";
import { billFinancialScope } from "@/lib/scheme-financial-scope";
import { getMonthly } from "@/features/planning/monthly.server";
import { resolveAddableSeasonalPlanId } from "@/features/planning/monthly-plan.server";
import { figuresForMode, type PlanningMode } from "@/lib/calc";
import { effectiveProceedingSchemeUnits } from "@/lib/scheme-plan-quantity";
import { getResolvedLabels } from "@/features/labels/service.server";
import { cnTasksForOfficerDate, materializedCnTasksForEntries, countUnconfirmedMaterializedTasks } from "@/features/cn-requests/service.server";
import { getAutoTasksEnabled } from "@/lib/recovery-config";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { type CnTaskDto } from "@/lib/cn-request";
import { assertDayOpen, lockDailyWorkDay, readBatchContext, type DailyWorkDb as DbClient } from "./day-lock.server";
import { materializeDueDailyWorkTasks, materializeDueDailyWorkTasksInTransaction, autoTasksApplyToRole } from "./auto-task-materialization.server";
import { materializeDueCalendarTasks, calendarLinkedEntryIds } from "./calendar-task-materialization.server";
import {
  currentBusinessDate, monthNameForDate, salesPending, recoveryPending, conversionPending, combineDailyWorkRows, round2,
  computeSectionStatuses, sectionStatusCounts, canSubmitDailyWork, parseNoPlanSet, serializeNoPlanSet,
  MANDATORY_SECTIONS, SectionStatus, SCHEME_CONVERSION_ENABLED, isDailyWorkSectionEnabled, RECOVERY_PAYMENT_MODES,
  type RecoveryPaymentMode,
  dailyWorkClock, invalidPlanRows, planRequiredMessage, dailyReportDeadline, isReportDeadlinePassed, isReportMissed, previousBusinessDate, previousReportBlocksPlan, previousReportState, type PreviousReportState,
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
  });
  const appointmentRowSchema = z.object({
    rowId: z.string().min(1, L["daily_work.validation.invalid_option"]),
    dealerName: z.string().trim().max(200, L["daily_work.validation.dealer_name_length"]),
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
    appointmentSave: z.object({ workDate: dateStr, rows: maxRows(appointmentRowSchema) }),
    appointmentStatus: z.object({ workDate: dateStr, entries: maxRows(z.object({ entryId: z.string().min(1, L["daily_work.validation.invalid_option"]), status: z.enum(["APPOINTED", "NOT_APPOINTED"], invalidOption) })) }),
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
  paymentMode?: RecoveryPaymentMode | null; // Recovery Daily REPORT only (the ACTUAL receipt mode); never part of the Daily Plan
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
  availableDealers: DailyWorkAvailableDealer[]; // scoped dealers not yet added
  applicableSchemes: DailyWorkSchemeOption[]; // Sales: OPEN schemes for the officer's group (shared by all dealers)
  applicableSchemesByDealer: Record<string, DailyWorkSchemeOption[]>; // Recovery: enrolled/verified dealer schemes
  cnTasks: CnTaskDto[]; // Recovery: CN follow-up tasks (Accepted, Not Posted) the SO scheduled on this date
  materializedCnTasks: CnTaskDto[]; // current editable Recovery-row tasks; exposed only for exact rescheduling
  autoTaskEntryIds: string[]; // historical/current contribution links used only to display each row's Task Type
  calendarEntryIds: string[]; // rows created from a Calendar Daily Task → Task Type "Calendar"
  dealers: DailyWorkDealerDto[];
}

/* ---- Dealer Appointment DTOs ---- */
export interface AppointmentRowDto {
  entryId: string;
  batchId: string;
  rowId: string;
  dealerName: string; // typed
  marketName: string; // typed
  monthlyPlan: null; // PLACEHOLDER — Dealer Planning not built yet (never a fabricated value)
  pending: null; // PLACEHOLDER — connected in a later Dealer Planning phase
  status: "APPOINTED" | "NOT_APPOINTED" | null; // post-submit
  rowStatus: "DRAFT" | "PLAN_SUBMITTED" | "FINALIZED" | "SUBMITTED";
}
export interface AppointmentPayload {
  section: "APPOINTMENT";
  workDate: string;
  canEnterStatus: boolean; // frozen report rows expose the Appointed/Not Appointed selector
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
}
/** Current editable rows for PLAN, or every frozen immutable batch row for REPORT. */
async function loadDailyRows(officerId: string, section: DailyWorkSection, workDate: string, mode: DailyWorkMode): Promise<DailyRow[]> {
  const { day } = await readBatchContext(officerId, workDate);
  const rows = await prisma.$queryRaw<DailyRow[]>(Prisma.sql`
    SELECT "id", "batchId", "dealerId", "rowKey", "typedDealerName", "marketName",
           "todaysPlan"::text AS "todaysPlan", "todaysActual"::text AS "todaysActual", "resultStatus", "entryType", "schemeId", "status", "paymentMode"
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
  const [{ map: figures, monthName }, dailyRows, assignedIds, schemes, recoverySchemes, cnTasks] = await Promise.all([
    sourcedFigures(ctx, officerId, section, workDate),
    loadDailyRows(officerId, section, workDate, mode),
    getCurrentDealerIds(officerId),
    section === "SALES" ? runningSchemes(ctx) : Promise.resolve([]),
    section === "RECOVERY" ? recoverySchemesByDealer(officerId) : Promise.resolve(new Map<string, DailyWorkSchemeOption[]>()),
    // CN follow-up tasks the SO scheduled on THIS date (Recovery section only). Read-only; never mutates CN.
    section === "RECOVERY" ? cnTasksForOfficerDate(officerId, workDate) : Promise.resolve([] as CnTaskDto[]),
  ]);

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
        status: (r.status as DailyWorkDealerDto["status"]) ?? "DRAFT",
      };
    })
    .sort((a, b) => a.dealerName.localeCompare(b.dealerName));

  const usedIds = new Set(dealers.map((d) => d.dealerId));
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
  const autoTaskEntryIds = section === "RECOVERY" && mode === "REPORT"
    ? await autoTaskEntryIdsForReport(officerId, dailyRows.map((row) => row.id))
    : [];

  return {
    section,
    workDate,
    monthName,
    canEnterActual: mode === "REPORT" && dealers.some((d) => d.status !== "DRAFT"),
    availableDealers,
    applicableSchemes: (schemes as { id: string; schemeName: string }[]).map((s) => ({ id: s.id, name: s.schemeName })),
    applicableSchemesByDealer: Object.fromEntries(recoverySchemes),
    cnTasks,
    materializedCnTasks,
    autoTaskEntryIds,
    calendarEntryIds,
    dealers,
  };
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
  await assertDealersInScope(officerId, rows.map((r) => r.dealerId), L);

  // No duplicate dealer rows within the payload.
  const seen = new Set<string>();
  for (const r of rows) { if (seen.has(r.dealerId)) throw new ApiError(422, L["daily_work.validation.duplicate_dealer"]); seen.add(r.dealerId); }

  // Sales uses OPEN in-group schemes. Recovery uses the existing dealer-specific financial/recovery scope.
  const schemeRows = rows.filter((r) => r.entryType === "SCHEME");
  if (schemeRows.length > 0) {
    const salesApplicable = section === "SALES" ? new Set((await runningSchemes(ctx)).map((s) => s.id)) : null;
    const recoveryApplicable = section === "RECOVERY" ? await recoverySchemesByDealer(officerId) : null;
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
    if (section === "RECOVERY") {
      const linked = await tx.$queryRaw<Array<{ dealerId: string; contribution: string }>>(Prisma.sql`
        SELECT e."dealerId", SUM(t."contribution")::text AS "contribution"
        FROM (
          SELECT "dailyWorkEntryId" AS "entryId", "dailyWorkContribution" AS "contribution"
          FROM "CnPaymentEvent" WHERE "dailyWorkEntryId" IS NOT NULL
          UNION ALL
          SELECT "legacyDailyWorkEntryId" AS "entryId", "legacyDailyWorkContribution" AS "contribution"
          FROM "CnRequest" WHERE "legacyDailyWorkEntryId" IS NOT NULL
        ) t
        JOIN "DailyWorkEntry" e ON e."id" = t."entryId"
        WHERE e."officerId" = ${officerId} AND e."workDate" = ${workDate}::date
          AND e."batchId" = ${day.currentBatchId} AND e."section" = 'RECOVERY' AND e."status" = 'DRAFT'
        GROUP BY e."dealerId"`);
      for (const item of linked) {
        const row = rows.find((candidate) => candidate.dealerId === item.dealerId);
        if (!row || Number(row.todaysPlan ?? 0) < Number(item.contribution)) {
          throw new ApiError(409, L["daily_work.validation.auto_task_amount"]);
        }
      }
    }
    // Replace-set: delete this officer/section/date rows no longer present (never touch SUBMITTED actuals of
    // rows we keep — those are updated in place below, preserving todaysActual).
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "section" = ${section} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
      ${keepIds.length > 0 ? Prisma.sql`AND "dealerId" NOT IN (${Prisma.join(keepIds)})` : Prisma.empty}`);

    for (const r of rows) {
      const todaysPlan = r.todaysPlan == null ? Prisma.sql`NULL` : Prisma.sql`${r.todaysPlan}`;
      const schemeId = r.entryType === "SCHEME" ? r.schemeId! : null;
      // Upsert on the unique (officer, workDate, section, rowKey). For SALES/RECOVERY rowKey == dealerId, so
      // duplicate protection is unchanged. Keep existing todaysActual + SUBMITTED status on conflict.
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
    assertReportWindowOpen(workDate, L); // a Missed report (past its noon deadline) is read-only
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

/* --------------------------------- Combined (server-side mirror of the UI summary) --------------------------------- */

/** Derive the combined summary for a payload's dealers — same math the UI uses (exported for reuse/tests). */
export function combineDailyWork(dealers: DailyWorkDealerDto[]) {
  const rows: DailyWorkDealerRow[] = dealers.map((d) => ({
    monthlyPlan: d.monthlyPlan, actual: d.actual, pending: d.pending, todaysPlan: d.todaysPlan ?? 0, todaysActual: d.todaysActual ?? 0, type: d.entryType,
  }));
  return combineDailyWorkRows(rows);
}

/* =====================================================================================
 * SECTION 3 — DEALER APPOINTMENT (typed dealer + market; plan/pending are placeholders)
 * ===================================================================================== */

/** Read the officer's Dealer Appointment rows for a date. Monthly Dealer Plan + Pending are placeholders. */
export async function getDailyAppointment(ctx: AuthContext, rawDate?: string, targetOfficerId?: string, rawMode?: string): Promise<AppointmentPayload> {
  await assertReadRole(ctx, targetOfficerId);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const apptOfficerId = await resolveReadOfficer(ctx, targetOfficerId);
  await materializeCalendarForRead(ctx, apptOfficerId, workDate, parseDailyWorkMode(rawMode));
  const entries = await loadDailyRows(apptOfficerId, "APPOINTMENT", workDate, parseDailyWorkMode(rawMode));
  const rows: AppointmentRowDto[] = entries.map((r) => ({
    entryId: r.id,
    batchId: r.batchId,
    rowId: r.rowKey,
    dealerName: r.typedDealerName ?? "",
    marketName: r.marketName ?? "",
    monthlyPlan: null,
    pending: null,
    status: (r.resultStatus as "APPOINTED" | "NOT_APPOINTED" | null) ?? null,
    rowStatus: (r.status as AppointmentRowDto["rowStatus"]) ?? "DRAFT",
  }));
  return { section: "APPOINTMENT", workDate, canEnterStatus: parseDailyWorkMode(rawMode) === "REPORT" && rows.some((r) => r.rowStatus !== "DRAFT"), rows, calendarEntryIds: await calendarLinkedEntryIds(entries.map((r) => r.id)) };
}

/** Persist the officer's Dealer Appointment rows for a date as DRAFT (replace-set, atomic). Dealer is required. */
export async function saveDailyAppointment(ctx: AuthContext, raw: unknown): Promise<{ count: number }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate, rows } = dailyWorkSchemas(L).appointmentSave.parse(raw);
  const officerId = ownerId(ctx);
  const meaningful = rows.filter((r) => r.dealerName.trim().length > 0);

  // Unique client row ids within the payload (the natural key for typed rows).
  const seen = new Set<string>();
  for (const r of meaningful) { if (seen.has(r.rowId)) throw new ApiError(422, L["daily_work.validation.duplicate_appointment"]); seen.add(r.rowId); }

  const keep = meaningful.map((r) => r.rowId);
  return prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "DailyWorkEntry"
      WHERE "officerId" = ${officerId} AND "section" = 'APPOINTMENT' AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId}
      ${keep.length > 0 ? Prisma.sql`AND "rowKey" NOT IN (${Prisma.join(keep)})` : Prisma.empty}`);
    for (const r of meaningful) {
      const market = r.marketName?.trim() || null;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DailyWorkEntry" ("id","officerId","dealerId","rowKey","workDate","batchId","section","typedDealerName","marketName","status","createdAt","updatedAt")
        VALUES (${randomUUID()}, ${officerId}, NULL, ${r.rowId}, ${workDate}::date, ${day.currentBatchId}, 'APPOINTMENT', ${r.dealerName.trim()}, ${market}, 'DRAFT', NOW(), NOW())
        ON CONFLICT ("officerId","workDate","batchId","section","rowKey")
        DO UPDATE SET "typedDealerName" = EXCLUDED."typedDealerName", "marketName" = EXCLUDED."marketName", "updatedAt" = NOW()`);
    }
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `APPOINTMENT:${workDate}`, summary: `Saved ${meaningful.length} dealer appointment row(s)` }, tx);
    return { count: meaningful.length };
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
    assertReportWindowOpen(workDate, L); // a Missed report (past its noon deadline) is read-only
    let count = 0;
    for (const e of entries) {
      const n = await tx.$executeRaw(Prisma.sql`
        UPDATE "DailyWorkEntry" SET "resultStatus" = ${e.status}, "updatedAt" = NOW()
        WHERE "id" = ${e.entryId} AND "officerId" = ${officerId} AND "section" = 'APPOINTMENT'
          AND "workDate" = ${workDate}::date AND "batchId" <> ${day.currentBatchId} AND "status" = 'PLAN_SUBMITTED'`);
      count += Number(n);
    }
    if (count === 0) throw new ApiError(409, L["daily_work.validation.appointment_after_submit"]);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `APPOINTMENT:${workDate}`, summary: `Set appointment status for ${count} row(s)` }, tx);
    return { count };
  });
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
    assertReportWindowOpen(workDate, L); // a Missed report (past its noon deadline) is read-only
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
    assertReportWindowOpen(workDate, L); // a Missed report (past its noon deadline) is read-only
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
 * placeholders/defaults never count:
 *   SALES / RECOVERY   → ≥1 saved dealer row for that section
 *   APPOINTMENT        → ≥1 row with a non-empty typed dealer name
 *   SCHEME_CONVERSION  → ≥1 (dealer, scheme) row
 *   VISITS             → the SUMMARY visit columns are set (an explicit 0 counts; untouched/NULL does not)
 */
async function sectionDataPresence(officerId: string, workDate: string, batchId: string, db: DbClient = prisma): Promise<SectionDataPresence> {
  const rows = await db.$queryRaw<{ section: string; n: bigint }[]>(Prisma.sql`
    SELECT "section", COUNT(*)::bigint AS n
    FROM "DailyWorkEntry"
    WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${batchId}
      AND (
        ("section" IN ('SALES','RECOVERY','SCHEME_CONVERSION'))
        OR ("section" = 'APPOINTMENT' AND COALESCE(TRIM("typedDealerName"), '') <> '')
      )
    GROUP BY "section"`);
  const count = new Map(rows.map((r) => [r.section, Number(r.n)]));

  // Visits: entered when its columns are non-null (a VISITS save happened). Others: entered when the free-text
  // note is non-empty. Both live on the day's SUMMARY row.
  const summary = await db.$queryRaw<{ visits: boolean; others: boolean }[]>(Prisma.sql`
    SELECT ("dealerVisits" IS NOT NULL OR "newPartyVisits" IS NOT NULL) AS visits,
           (COALESCE(TRIM("others"), '') <> '') AS others
    FROM "DailyWorkEntry"
    WHERE "officerId" = ${officerId} AND "section" = 'SUMMARY' AND "workDate" = ${workDate}::date AND "batchId" = ${batchId} AND "rowKey" = ${SUMMARY_ROWKEY}
    LIMIT 1`);

  return {
    SALES: (count.get("SALES") ?? 0) > 0,
    RECOVERY: (count.get("RECOVERY") ?? 0) > 0,
    APPOINTMENT: (count.get("APPOINTMENT") ?? 0) > 0,
    SCHEME_CONVERSION: (count.get("SCHEME_CONVERSION") ?? 0) > 0,
    VISITS: summary[0]?.visits ?? false,
    OTHERS: summary[0]?.others ?? false,
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
}

/** Report actuals/results of day D can only be entered until D+1 12:00 (business timezone); after that the report is Missed and read-only. */
function assertReportWindowOpen(workDate: string, L: ResolvedLabels): void {
  if (isReportDeadlinePassed(workDate, dailyWorkClock.now())) throw new ApiError(422, L["daily_work.validation.report_deadline_passed"]);
}

/** The previous calendar day's submitted-plan / finalized-report facts for one owner. Keyed on the owner, so nobody can satisfy another's gate. */
async function previousReportGate(db: DbClient, officerId: string, workDate: string, now: Date): Promise<{ date: string; state: PreviousReportState; deadline: Date }> {
  const date = previousBusinessDate(workDate);
  const rows = await db.$queryRaw<{ planned: boolean; finalized: boolean }[]>(Prisma.sql`
    SELECT EXISTS(SELECT 1 FROM "DailyWorkEntry" WHERE "officerId" = ${officerId} AND "workDate" = ${date}::date AND "planSubmittedAt" IS NOT NULL) AS "planned",
           EXISTS(SELECT 1 FROM "DailyWorkDay" WHERE "officerId" = ${officerId} AND "workDate" = ${date}::date AND "status" = 'FINALIZED') AS "finalized",
           'previousDayGate' AS "previousDayGate"`);
  const row = rows[0] ?? { planned: false, finalized: false };
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
      AND (${SCHEME_CONVERSION_ENABLED}::boolean OR "section" <> 'SCHEME_CONVERSION')`);
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
 * Data present ⇒ FILLED, so a stale No-Plan flag never coexists with data (it is simply ignored here).
 */
export async function getDailyStatus(ctx: AuthContext, rawDate?: string, targetOfficerId?: string): Promise<DailyStatusPayload> {
  await assertReadRole(ctx, targetOfficerId);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "") ? rawDate! : currentBusinessDate();
  const officerId = await resolveReadOfficer(ctx, targetOfficerId);
  await materializeCalendarForRead(ctx, officerId, workDate, "PLAN"); // the status (progress bar) must see Calendar tasks too
  const { day } = await readBatchContext(officerId, workDate);
  const now = dailyWorkClock.now();
  const [data, noPlanSet, report, autoTasksEnabled, previous] = await Promise.all([
    sectionDataPresence(officerId, workDate, day.currentBatchId),
    loadNoPlanSet(officerId, workDate, day.currentBatchId),
    reportCompletion(prisma, officerId, workDate, day.currentBatchId),
    getAutoTasksEnabled(),
    previousReportGate(prisma, officerId, workDate, now),
  ]);
  const reportDeadlinePassed = isReportDeadlinePassed(workDate, now);
  const statuses = computeSectionStatuses(data, noPlanSet);
  return {
    workDate,
    sections: MANDATORY_SECTIONS.map((s) => ({ section: s, status: statuses[s], hasData: data[s] })),
    counts: sectionStatusCounts(statuses),
    canSubmit: day.status === "OPEN" && canSubmitDailyWork(statuses) && !previousReportBlocksPlan(previous.state),
    hasSubmittedWork: report.hasBatches,
    canSubmitReport: day.status === "OPEN" && report.complete && !reportDeadlinePassed,
    isFinalized: day.status === "FINALIZED",
    selfRating: day.selfRating,
    reportSections: report.sections,
    autoTasksEnabled,
    previousReport: { date: previous.date, state: previous.state, deadline: previous.deadline.toISOString() },
    reportDeadline: dailyReportDeadline(workDate).toISOString(),
    reportDeadlinePassed,
    reportMissed: isReportMissed(workDate, report.hasBatches, day.status === "FINALIZED", now),
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
export async function submitDailyWorkDay(ctx: AuthContext, raw: unknown): Promise<{ ok: true; batchId: string }> {
  const L = await getResolvedLabels();
  await assertOwnerRole(ctx, L);
  const { workDate } = dailyWorkSchemas(L).batchSubmit.parse(raw);
  const officerId = ownerId(ctx);
  let submittedBatchId = "";
  await prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.day_finalized"]);
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
      if (unconfirmed > 0) throw new ApiError(422, L["daily_work.validation.confirm_auto_tasks"]);
    }
    const [data, noPlanSet] = await Promise.all([
      sectionDataPresence(officerId, workDate, day.currentBatchId, tx),
      loadNoPlanSet(officerId, workDate, day.currentBatchId, tx),
    ]);
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
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkEntry" SET "status" = 'PLAN_SUBMITTED', "planSubmittedAt" = NOW(), "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "batchId" = ${day.currentBatchId} AND "status" = 'DRAFT'`);
    if (Number(updated) === 0) throw new ApiError(409, L["daily_work.validation.empty_batch"]);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkDay" SET "currentBatchId" = ${randomUUID()}, "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date`);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `BATCH:${workDate}:${submittedBatchId}`, summary: "Submitted Daily Work planning batch" }, tx);
  });
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
  await prisma.$transaction(async (tx) => {
    const day = await lockDailyWorkDay(tx, officerId, workDate);
    assertDayOpen(day, L["daily_work.validation.report_already_submitted"]);
    // The report for day D closes at 12:00 noon on D+1 (business timezone). An already-finalized report was handled above and is unaffected.
    if (isReportDeadlinePassed(workDate, dailyWorkClock.now())) throw new ApiError(422, L["daily_work.validation.report_deadline_passed"]);
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
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkDay" SET "status" = 'FINALIZED', "selfRating" = ${selfRating}, "finalizedAt" = NOW(), "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "status" = 'OPEN'`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "DailyWorkEntry" SET "status" = 'FINALIZED', "updatedAt" = NOW()
      WHERE "officerId" = ${officerId} AND "workDate" = ${workDate}::date AND "status" = 'PLAN_SUBMITTED'`);
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWork", entityId: `REPORT:${workDate}`, summary: `Submitted Daily Report; self-rating ${selfRating}/10` }, tx);
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
    prisma.user.findUnique({ where: { id: officerId }, select: { name: true } }),
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
 * DailyWorkReview, State = the officer's UserGroup (region). Attendance is the only new source (default Present).
 * Server-authoritative population + filters. Batched: a FIXED set of queries independent of #officers × #days.
 * ===================================================================================== */

export const ATTENDANCE_VALUES = ["PRESENT", "ABSENT", "LEAVE", "HOLIDAY"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_VALUES)[number];
const MAX_PERFORMANCE_RANGE_DAYS = 92; // guardrail: a bounded report keeps the row set (and query cost) sane

export interface PerformanceRow {
  officerId: string;
  officerName: string;
  groupId: string | null;
  stateName: string | null; // the officer's UserGroup (region) — shown as "State" for Admin
  date: string; // YYYY-MM-DD business date
  attendance: AttendanceStatus;
  planSubmittedAt: string | null; // ISO; null → "—"
  reportSubmittedAt: string | null; // ISO; null → "—"
  selfRating: number | null;
  rmRating: number | null;
  submitted: boolean; // plan submitted that day → detail is openable
  /** Derived, never stored: plan submitted, report not finalized and the report's noon deadline has passed → shown as "Missed". */
  reportMissed: boolean;
}
export interface PerformanceSummary {
  salesOfficers: number;
  presentDays: number;
  totalDays: number; // denominator = officers × dates in range
  submittedPlans: number;
  submittedReports: number;
  averageSelfRating: number | null; // excludes missing (never 0)
  averageRmRating: number | null; // excludes missing (never 0)
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
  canEditAttendance: boolean; // Super Admin only
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
  officerId: z.string().optional(),
  groupId: z.string().optional(), // State (region) filter — Admin only
});

/** Roles that own Daily Work (and therefore appear in Performance). */
const DAILY_WORK_OWNER_ROLES = [Role.SALES_OFFICER, Role.REGIONAL_MANAGER] as const;

/** The authoritative Daily Work performer population for the caller (server-side scope), with group/state names. */
async function performancePopulation(ctx: AuthContext): Promise<{ id: string; name: string; groupId: string | null; groupName: string | null }[]> {
  const select = { id: true, name: true, groupId: true, group: { select: { id: true, name: true } } } as const;
  if (ctx.role === Role.SALES_OFFICER) {
    const self = await prisma.user.findUnique({ where: { id: ctx.userId }, select });
    return self ? [{ id: self.id, name: self.name, groupId: self.groupId, groupName: self.group?.name ?? null }] : [];
  }
  if (ctx.role === Role.REGIONAL_MANAGER) {
    const scope = await getOfficerScope(ctx);
    const ids = scope.ids.filter((id) => id !== ctx.userId);
    if (ids.length === 0) return [];
    const officers = await prisma.user.findMany({ where: { role: Role.SALES_OFFICER, isActive: true, deletedAt: null, id: { in: ids } }, select, orderBy: { name: "asc" } });
    return officers.map((o) => ({ id: o.id, name: o.name, groupId: o.groupId, groupName: o.group?.name ?? null }));
  }
  // Super Admin — company-wide. Daily Work owners are Sales Officers AND Regional Managers (an RM submits Daily Work too),
  // so both appear. Each user is one row source (unique id), so nobody is double-counted. The RM caller's own scope above is unchanged.
  const officers = await prisma.user.findMany({ where: { role: { in: [...DAILY_WORK_OWNER_ROLES] }, isActive: true, deletedAt: null }, select, orderBy: { name: "asc" } });
  return officers.map((o) => ({ id: o.id, name: o.name, groupId: o.groupId, groupName: o.group?.name ?? null }));
}

/**
 * Role-aware date-range performance. SO → own rows only (no SO/State columns); RM → authorized team (+SO filter);
 * Admin → all SOs (+SO and State filters). Filters are validated against the authoritative population server-side.
 */
export async function getDailyPerformance(ctx: AuthContext, raw: unknown = {}): Promise<PerformancePayload> {
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

  // State establishes the Admin's authoritative SO scope first. The officer filter is then validated against
  // that narrowed population, so State=MP + an UP officer cannot bypass the State filter.
  if (isAdministrativeRole(ctx.role) && filters.groupId) {
    population = population.filter((p) => p.groupId === filters.groupId);
  }
  if (ctx.role !== Role.SALES_OFFICER && filters.officerId) {
    if (!population.some((p) => p.id === filters.officerId)) throw new ApiError(403, L["daily_work.performance.forbidden"]);
    population = population.filter((p) => p.id === filters.officerId);
  }

  const ids = population.map((p) => p.id);
  const [planRows, dayRows, rmRows, attRows] = ids.length === 0
    ? [[], [], [], []] as [
        { officerId: string; workDate: Date; planSubmittedAt: Date | null }[],
        { officerId: string; workDate: Date; finalizedAt: Date | null; selfRating: number | null; status: string }[],
        { officerId: string; workDate: Date; rating: number }[],
        { officerId: string; workDate: Date; status: string }[],
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
        prisma.$queryRaw<{ officerId: string; workDate: Date; status: string }[]>(Prisma.sql`
          SELECT "officerId", "workDate", "status"
          FROM "DailyWorkAttendance"
          WHERE "officerId" IN (${Prisma.join(ids)}) AND "workDate" BETWEEN ${from}::date AND ${to}::date`),
      ]);

  const dk = (d: Date): string => d.toISOString().slice(0, 10);
  const cell = (officerId: string, date: string) => `${officerId}|${date}`;
  const planMap = new Map(planRows.map((r) => [cell(r.officerId, dk(r.workDate)), r.planSubmittedAt]));
  const dayMap = new Map(dayRows.map((r) => [cell(r.officerId, dk(r.workDate)), r]));
  const rmMap = new Map(rmRows.map((r) => [cell(r.officerId, dk(r.workDate)), r.rating]));
  const attMap = new Map(attRows.map((r) => [cell(r.officerId, dk(r.workDate)), r.status as AttendanceStatus]));

  const now = dailyWorkClock.now();
  const rows: PerformanceRow[] = [];
  for (const officer of population) {
    for (const date of dates) {
      const key = cell(officer.id, date);
      const day = dayMap.get(key);
      const plan = planMap.get(key) ?? null;
      const finalized = day?.finalizedAt ?? null;
      rows.push({
        officerId: officer.id,
        officerName: officer.name,
        groupId: officer.groupId,
        stateName: officer.groupName,
        date,
        attendance: (attMap.get(key) as AttendanceStatus | undefined) ?? "PRESENT", // default Present when no override
        planSubmittedAt: plan ? plan.toISOString() : null,
        reportSubmittedAt: finalized ? finalized.toISOString() : null,
        // A self-rating is committed only at report finalization; surface it only then (never as 0).
        selfRating: finalized && day?.selfRating != null ? day.selfRating : null,
        rmRating: rmMap.get(key) ?? null,
        submitted: plan != null,
        reportMissed: isReportMissed(date, plan != null, day?.status === "FINALIZED" || finalized != null, now),
      });
    }
  }

  const summary: PerformanceSummary = {
    salesOfficers: population.length,
    presentDays: rows.filter((r) => r.attendance === "PRESENT").length,
    totalDays: rows.length,
    submittedPlans: rows.filter((r) => r.planSubmittedAt != null).length,
    submittedReports: rows.filter((r) => r.reportSubmittedAt != null).length,
    averageSelfRating: average(rows.map((r) => r.selfRating).filter((v): v is number => v != null)),
    averageRmRating: average(rows.map((r) => r.rmRating).filter((v): v is number => v != null)),
  };

  // State options always span the full authoritative population. Admin officer options follow the selected State;
  // with All States they span the company. RM options retain their existing team scope.
  const fullPopulation = await performancePopulation(ctx);
  const officerOptions = isAdministrativeRole(ctx.role) && filters.groupId
    ? fullPopulation.filter((p) => p.groupId === filters.groupId)
    : fullPopulation;
  const officers = officerOptions.map((p) => ({ id: p.id, name: p.name }));
  const states = isAdministrativeRole(ctx.role)
    ? [...new Map(fullPopulation.filter((p) => p.groupId).map((p) => [p.groupId!, { id: p.groupId!, name: p.groupName ?? p.groupId! }])).values()].sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    role: ctx.role,
    from, to, rows, summary, officers, states,
    canEditAttendance: isAdministrativeRole(ctx.role) && (ctx.role !== Role.CUSTOM_ADMIN || hasAdminPermission(ctx, "performance", "attendance")),
  };
}

const attendanceSchema = z.object({
  officerId: z.string().min(1),
  workDate: z.string().refine(isDateKey, "A valid date is required"),
  status: z.enum(ATTENDANCE_VALUES),
});

/** Set attendance for one officer/date. SUPER_ADMIN only; persisted so it survives refresh/navigation. */
export async function setDailyWorkAttendance(ctx: AuthContext, raw: unknown): Promise<{ officerId: string; workDate: string; status: AttendanceStatus }> {
  const L = await getResolvedLabels();
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, L["daily_work.performance.attendance_admin_only"]);
  const parsed = attendanceSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid attendance");
  const { officerId, workDate, status } = parsed.data;
  const officer = await prisma.user.findUnique({ where: { id: officerId }, select: { role: true } });
  if (!officer || !(DAILY_WORK_OWNER_ROLES as readonly Role[]).includes(officer.role)) throw new ApiError(422, L["daily_work.performance.invalid_officer"]);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "DailyWorkAttendance" ("id","officerId","workDate","status","createdAt","updatedAt")
    VALUES (${randomUUID()}, ${officerId}, ${workDate}::date, ${status}, NOW(), NOW())
    ON CONFLICT ("officerId","workDate") DO UPDATE SET "status" = ${status}, "updatedAt" = NOW()`);
  await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "dailyWorkAttendance", entityId: `${officerId}:${workDate}`, summary: `Set attendance ${status}` });
  return { officerId, workDate, status };
}
