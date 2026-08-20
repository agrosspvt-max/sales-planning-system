import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Role, PlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { loadDealerResolver, type MatchType } from "@/lib/dealer-resolver";
import { tightKey } from "@/lib/match-key";
import { createAndAssignDealer } from "@/features/assignments/service.server";
import { getOfficerScope, assertOfficerInScope, isPlanOwner } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { getRecoveryConfig } from "@/lib/recovery-config";
import { assertLifecycleEditable, officerVisibilityWhere, isHiddenFromOfficer, isHiddenByArchivedParent } from "@/features/planning/lifecycle.server";
import { parseAgingReport, aggregateDealer, type ParsedAgingReport } from "./parser";
import { parseDaybook, isSrCrVoucher, isReceiptVoucher } from "./daybook-parser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const EDITABLE: PlanStatus[] = [PlanStatus.DRAFT, PlanStatus.RETURNED, PlanStatus.REJECTED];

function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only the Super Admin can upload the Aging Report");
}
function num(d: unknown): number {
  return typeof d === "object" && d !== null ? Number(d.toString()) : Number(d);
}

/**
 * Recovery ALWAYS uses four fixed BUSINESS weeks — never calendar/ISO weeks, never a Week 5 —
 * regardless of whether the month has 28, 29, 30 or 31 days:
 *   Week 1 = days 1–7 · Week 2 = 8–14 · Week 3 = 15–22 · Week 4 = 23–end of month.
 */
export const BUSINESS_WEEK_COUNT = 4;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function weekCountForCutoff(_cutoff?: Date): number {
  return BUSINESS_WEEK_COUNT;
}

/** The business week (1–4) a due date falls in, by day-of-month. Days 23+ all belong to Week 4. */
export function businessWeekOfMonth(d: Date): 1 | 2 | 3 | 4 {
  const day = d.getDate();
  if (day <= 7) return 1;
  if (day <= 14) return 2;
  if (day <= 22) return 3;
  return 4;
}

/* ------------------------- Week locking (date-based) ---------------------- */
// Business-week day ranges within the plan's calendar month (matching businessWeekOfMonth):
//   Week 1 = 1–7 · Week 2 = 8–14 · Week 3 = 15–22 · Week 4 = 23–end of month.
const WEEK_START_DAY: Record<number, number> = { 1: 1, 2: 8, 3: 15, 4: 23 };
const weekEndDay = (weekNo: number, year: number, month0: number): number =>
  weekNo === 1 ? 7 : weekNo === 2 ? 14 : weekNo === 3 ? 22 : new Date(year, month0 + 1, 0).getDate();

/**
 * The plan's CALENDAR month as { year, month0 }. Derived from the season start month + the month's order
 * (Season 1st month + order−1), falling back to the cutoff date's month when the season has no start set.
 */
function planCalendar(season: { startMonth: number | null; startYear: number | null }, order: number, cutoff: Date): { year: number; month0: number } {
  if (season.startMonth != null && season.startYear != null) {
    const idx = season.startMonth - 1 + (order - 1); // 0-based month index from Jan of startYear
    return { year: season.startYear + Math.floor(idx / 12), month0: ((idx % 12) + 12) % 12 };
  }
  return { year: cutoff.getFullYear(), month0: cutoff.getMonth() };
}

/** A week is AUTO-locked once it has COMPLETELY ended (today is past its last day). Current + future weeks stay editable. */
function weekAutoLocked(weekNo: number, year: number, month0: number, now: Date): boolean {
  const end = new Date(year, month0, weekEndDay(weekNo, year, month0), 23, 59, 59, 999);
  return now.getTime() > end.getTime();
}

export interface WeekLockInfo {
  weekNo: number;
  startDay: number;
  endDay: number;
  auto: boolean; // date-based lock (week ended)
  overridden: boolean; // admin has set a manual override
  locked: boolean; // EFFECTIVE state: override wins over auto
}

/**
 * Effective lock state for all four business weeks. Priority: an admin manual override (if present) wins
 * over the automatic date-based lock; otherwise the date-based rule applies.
 */
function computeWeekLocks(
  cal: { year: number; month0: number },
  overrides: Map<number, boolean>,
  now: Date,
): WeekLockInfo[] {
  const out: WeekLockInfo[] = [];
  for (let w = 1; w <= BUSINESS_WEEK_COUNT; w++) {
    const auto = weekAutoLocked(w, cal.year, cal.month0, now);
    const overridden = overrides.has(w);
    out.push({
      weekNo: w,
      startDay: WEEK_START_DAY[w],
      endDay: weekEndDay(w, cal.year, cal.month0),
      auto,
      overridden,
      locked: overridden ? (overrides.get(w) as boolean) : auto,
    });
  }
  return out;
}

/* --------------- Row-level lock: Due Recovery Plan ↔ Running Recovery Plan --------------- */
// Per dealer ROW (independent of other rows): Running Recovery Plan may only hold a value once the Due
// Recovery Plan is ≥ Overdue + Due; and the Due Recovery Plan is locked while Running has a value. These
// are enforced on EVERY save (not just the UI) so the API cannot be manipulated.
function assertRowLock(
  newPlan: number,
  newRunning: number,
  storedPlan: number,
  threshold: number,
  dealerLabel: string,
): void {
  const p = Math.round(newPlan);
  const r = Math.round(newRunning);
  const t = Math.round(threshold);
  // (1) Running Recovery Plan requires a sufficient Due Recovery Plan.
  if (r > 0 && p < t) {
    throw new ApiError(422, `Due Recovery Plan must be equal to or greater than Overdue + Due amount (${dealerLabel}).`);
  }
  // (2)/(3) Due Recovery Plan is locked while Running Recovery Plan has a value — clear Running first.
  if (r > 0 && p !== Math.round(storedPlan)) {
    throw new ApiError(409, `Due Recovery Plan is locked while Running Recovery Plan has a value — clear Running Recovery Plan first (${dealerLabel}).`);
  }
}

/** This-week Due per dealer (Map dealerId → { 1..4 }) from the latest snapshot's DUE bills. */
async function dueByWeekForPlan(planId: string): Promise<Map<string, Record<1 | 2 | 3 | 4, number>>> {
  const map = new Map<string, Record<1 | 2 | 3 | 4, number>>();
  const latest = (await prisma.agingSnapshot.findFirst({ where: { recoveryPlanId: planId }, orderBy: [{ weekNo: "desc" }], select: { id: true } })) as { id: string } | null;
  if (!latest) return map;
  const dueBills = (await prisma.agingSnapshotBill.findMany({ where: { snapshotId: latest.id, bucket: "DUE" }, select: { dealerId: true, dueDate: true, amount: true } })) as { dealerId: string; dueDate: Date | null; amount: unknown }[];
  for (const b of dueBills) {
    if (!b.dueDate) continue;
    const wk = businessWeekOfMonth(b.dueDate);
    const rec = map.get(b.dealerId) ?? { 1: 0, 2: 0, 3: 0, 4: 0 };
    rec[wk] += num(b.amount);
    map.set(b.dealerId, rec);
  }
  return map;
}

/** EFFECTIVE lock for one week (admin override wins, else date-based). Used to guard saves + drive toggles. */
async function effectiveWeekLocked(planId: string, weekNo: number): Promise<boolean> {
  const override = (await prisma.recoveryWeekLock.findUnique({
    where: { recoveryPlanId_weekNo: { recoveryPlanId: planId, weekNo } },
    select: { locked: true },
  })) as { locked: boolean } | null;
  if (override) return override.locked;
  const meta = (await prisma.recoveryPlan.findUnique({
    where: { id: planId },
    select: { cutoffDate: true, seasonMonth: { select: { order: true } }, season: { select: { startMonth: true, startYear: true } } },
  })) as { cutoffDate: Date; seasonMonth: { order: number }; season: { startMonth: number | null; startYear: number | null } } | null;
  if (!meta) return false;
  const cal = planCalendar(meta.season, meta.seasonMonth.order, meta.cutoffDate);
  return weekAutoLocked(weekNo, cal.year, cal.month0, new Date());
}

interface ResolvedDealer {
  dealerId: string;
  dealerName: string;
  officerId: string;
  aging: ReturnType<typeof aggregateDealer>;
}

/**
 * One classified row of the Aging Report, produced ONCE by resolveAging and reused by every preview.
 * Scope-neutral: the officer this row's dealer is assigned to (if any) is recorded here; whether that
 * makes it "accepted" or "assigned to another officer" is decided per-scope by buildOfficerSections.
 */
interface ClassifiedAgingRow {
  rawName: string;
  dealerId: string | null; // resolved master dealer, or null when unmatched
  dealerName: string | null;
  officerId: string | null; // active-assignment officer, or null when matched-but-unassigned
  duplicate: boolean; // this dealerId already appeared in an earlier row (rows merged into one)
  matchType: MatchType | null; // how the name resolved (ALIAS/EXACT/LOOSE/FUZZY) — null when unmatched
  score: number | null; // resolver confidence (fuzzy < 1); null when unmatched
  aging: ReturnType<typeof aggregateDealer>;
}
interface Resolution {
  resolved: ResolvedDealer[];
  unknownDealers: string[];
  unassignedDealers: string[]; // matched but no current officer assignment
  byOfficer: Map<string, ResolvedDealer[]>;
  rows: ClassifiedAgingRow[]; // every parsed row, classified (single source for the rich preview)
}

/**
 * Resolve parsed aging dealers → master dealer → current officer. Dealer matching uses the ONE
 * shared resolver (Alias → exact → loose → fuzzy) — the SAME system as Sales Upload.
 */
async function resolveAging(parsed: ParsedAgingReport, cutoff: Date): Promise<Resolution> {
  const [resolver, assignmentRows] = await Promise.all([
    loadDealerResolver(),
    prisma.dealerAssignment.findMany({ where: { effectiveTo: null }, select: { dealerId: true, officerId: true } }),
  ]);
  const officerByDealer = new Map<string, string>((assignmentRows as { dealerId: string; officerId: string }[]).map((a) => [a.dealerId, a.officerId]));

  // Key by SYSTEM dealerId so the same master dealer is represented ONCE, even when it appears
  // under several Tally names/blocks or when distinct names loose/fuzzy-resolve to it. Without
  // this, an officer's group could hold the same dealerId twice and the create loop would insert
  // two AgingSnapshotDealer / RecoveryPlanDealer rows that collide on their (…, dealerId) unique
  // key — a P2002 inside the transaction even with no existing plans. Receivables are merged.
  const byDealer = new Map<string, ResolvedDealer>();
  const unknownDealers: string[] = [];
  const unassignedSet = new Set<string>();
  const rows: ClassifiedAgingRow[] = [];
  const seenDealerIds = new Set<string>();
  for (const d of parsed.dealers) {
    const ag = aggregateDealer(d.bills, cutoff);
    const match = resolver.resolveWithReason(d.rawName);
    if (!match) {
      unknownDealers.push(d.rawName);
      rows.push({ rawName: d.rawName, dealerId: null, dealerName: null, officerId: null, duplicate: false, matchType: null, score: null, aging: ag });
      continue;
    }
    const dealer = match.dealer;
    const officerId = officerByDealer.get(dealer.id) ?? null;
    const duplicate = seenDealerIds.has(dealer.id);
    seenDealerIds.add(dealer.id);
    rows.push({ rawName: d.rawName, dealerId: dealer.id, dealerName: dealer.name, officerId, duplicate, matchType: match.matchType, score: match.score, aging: ag });
    if (!officerId) {
      unassignedSet.add(dealer.name);
      continue;
    }
    const existing = byDealer.get(dealer.id);
    if (existing) {
      existing.aging = {
        outstanding: existing.aging.outstanding + ag.outstanding,
        overdue: existing.aging.overdue + ag.overdue,
        due: existing.aging.due + ag.due,
        running: existing.aging.running + ag.running,
        bills: existing.aging.bills.concat(ag.bills),
      };
    } else {
      byDealer.set(dealer.id, { dealerId: dealer.id, dealerName: dealer.name, officerId, aging: ag });
    }
  }

  const resolved = [...byDealer.values()];
  const byOfficer = new Map<string, ResolvedDealer[]>();
  for (const r of resolved) {
    const arr = byOfficer.get(r.officerId) ?? [];
    arr.push(r);
    byOfficer.set(r.officerId, arr);
  }
  return { resolved, unknownDealers, unassignedDealers: [...unassignedSet], byOfficer, rows };
}

/* ------------------------- Rich preview (shared) -------------------------- */
// ONE preview builder for every scope (All / Selected / Single / Seasonal). It buckets the classified
// rows from resolveAging into per-officer accepted/duplicate sections plus report-level skip sections,
// each skipped dealer carrying an exact reason. No caller recomputes parsing, matching or totals.

export interface DealerLine {
  name: string;
  outstanding: number;
  overdue: number;
  due: number;
  running: number;
  matchType: MatchType | null; // ALIAS / EXACT / LOOSE / FUZZY
  score: number | null; // resolver confidence (surfaced for FUZZY)
}
export interface SkipLine {
  name: string;
  reason: string;
}
export interface OfficerPreviewSection {
  officerId: string;
  officerName: string;
  accepted: DealerLine[];
  duplicates: SkipLine[];
  totals: { outstanding: number; overdue: number; due: number; running: number };
  existingRecovery: { id: string; status: PlanStatus; lifecycleState: string } | null;
  // Reconciliation summary (item 5): Aging Dealers | Existing (already in the plan) | New (to be added).
  agingDealerCount: number;
  existingDealerCount: number;
  newDealerCount: number;
}
export interface RecoveryImportPreview {
  officers: OfficerPreviewSection[];
  skipped: {
    unknown: SkipLine[]; // no Dealer Alias / master match — onboarding candidates
    inactive: SkipLine[]; // matched dealer with no active officer assignment
    otherOfficer: SkipLine[]; // assigned to an officer NOT in the chosen scope
  };
  summary: {
    totalRows: number;
    accepted: number;
    skipped: number;
    unknown: number;
    duplicates: number;
    inactive: number;
    assignedToOther: number;
    newDealers: number;
  };
  newDealerCandidates: string[]; // unknown names offered for onboarding (default unchecked)
}

const zeroTotals = () => ({ outstanding: 0, overdue: 0, due: 0, running: 0 });

/** Build the rich preview for a set of in-scope officers from already-classified rows. */
function buildRecoveryImportPreview(
  rows: ClassifiedAgingRow[],
  scopeOfficerIds: string[],
  officerNameById: Map<string, string>,
  existingByOfficer: Map<string, { id: string; status: PlanStatus; lifecycleState: string }>,
  existingDealerIdsByOfficer: Map<string, Set<string>> = new Map(),
): RecoveryImportPreview {
  const inScope = new Set(scopeOfficerIds);
  const sections = new Map<string, OfficerPreviewSection>();
  const acceptedDealerIds = new Map<string, Set<string>>(); // officerId → aging dealer ids accepted
  for (const oid of scopeOfficerIds) {
    sections.set(oid, {
      officerId: oid,
      officerName: officerNameById.get(oid) ?? "—",
      accepted: [],
      duplicates: [],
      totals: zeroTotals(),
      existingRecovery: existingByOfficer.get(oid) ?? null,
      agingDealerCount: 0,
      existingDealerCount: 0,
      newDealerCount: 0,
    });
    acceptedDealerIds.set(oid, new Set());
  }
  const unknown: SkipLine[] = [];
  const inactive: SkipLine[] = [];
  const otherOfficer: SkipLine[] = [];

  for (const r of rows) {
    if (r.dealerId === null) {
      unknown.push({ name: r.rawName, reason: "Dealer Alias not found" });
      continue;
    }
    if (r.officerId === null) {
      inactive.push({ name: r.dealerName ?? r.rawName, reason: "Matched, but no active officer assignment" });
      continue;
    }
    if (!inScope.has(r.officerId)) {
      otherOfficer.push({ name: r.dealerName ?? r.rawName, reason: `Assigned to ${officerNameById.get(r.officerId) ?? "another officer"}` });
      continue;
    }
    const sec = sections.get(r.officerId);
    if (!sec) continue;
    if (r.duplicate) {
      sec.duplicates.push({ name: r.dealerName ?? r.rawName, reason: "Duplicate row (merged into one dealer)" });
      continue;
    }
    sec.accepted.push({ name: r.dealerName ?? r.rawName, outstanding: r.aging.outstanding, overdue: r.aging.overdue, due: r.aging.due, running: r.aging.running, matchType: r.matchType, score: r.score });
    acceptedDealerIds.get(r.officerId)?.add(r.dealerId);
    sec.totals.outstanding += r.aging.outstanding;
    sec.totals.overdue += r.aging.overdue;
    sec.totals.due += r.aging.due;
    sec.totals.running += r.aging.running;
  }

  // Reconciliation counts (item 5): of the aging dealers for each officer, how many already exist in
  // the recovery plan vs are new and will be inserted on apply.
  for (const sec of sections.values()) {
    const acceptedIds = acceptedDealerIds.get(sec.officerId) ?? new Set<string>();
    const existingIds = existingDealerIdsByOfficer.get(sec.officerId) ?? new Set<string>();
    let existingCount = 0;
    for (const id of acceptedIds) if (existingIds.has(id)) existingCount += 1;
    sec.agingDealerCount = acceptedIds.size;
    sec.existingDealerCount = existingCount;
    sec.newDealerCount = acceptedIds.size - existingCount;
  }

  const officers = [...sections.values()];
  const accepted = officers.reduce((n, s) => n + s.accepted.length, 0);
  const duplicates = officers.reduce((n, s) => n + s.duplicates.length, 0);
  const skipped = unknown.length + inactive.length + otherOfficer.length + duplicates;
  return {
    officers,
    skipped: { unknown, inactive, otherOfficer },
    summary: {
      totalRows: rows.length,
      accepted,
      skipped,
      unknown: unknown.length,
      duplicates,
      inactive: inactive.length,
      assignedToOther: otherOfficer.length,
      newDealers: unknown.length,
    },
    newDealerCandidates: unknown.map((u) => u.name),
  };
}

/* --------------------------------- Analyze -------------------------------- */

const createSchema = z.object({
  seasonMonthId: z.string().min(1, "Select a Month"),
  cutoffDate: z.string().min(1, "Select a Cutoff Date"),
  // Optional scope: restrict creation to a set of officers (Single / Selected / Seasonal flows). When
  // omitted, every matched officer is planned (All). `officerScope` (single id) is kept for callers
  // that still pass one officer; it is folded into `officerIds`.
  officerScope: z.string().optional(),
  officerIds: z.array(z.string()).optional(),
});

/* ---------------------------- Create (week 0) ----------------------------- */

export interface RecoveryCreateResult {
  plansCreated: number;
  dealers: number;
  bills: number;
  unknownDealers: number;
  planIds: string[];
}

/**
 * Commit — creates a Draft RecoveryPlan per officer (split by dealer assignment) from the
 * initial (week 0) Aging Report, storing the normalised snapshot (dealer aggregates + bills)
 * and seeding each RecoveryPlanDealer's read-only aging figures. One transaction, bulk writes.
 */
export async function createRecoveryFromAging(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryCreateResult> {
  assertAdmin(ctx);
  const input = createSchema.parse(raw);
  const cutoff = new Date(input.cutoffDate);
  const month = await prisma.seasonMonth.findUnique({ where: { id: input.seasonMonthId }, select: { id: true, seasonId: true } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const parsed = parseAgingReport(buffer);
  const res = await resolveAging(parsed, cutoff);
  const scopeSet = input.officerIds?.length ? new Set(input.officerIds) : input.officerScope ? new Set([input.officerScope]) : null;
  if (scopeSet) {
    for (const o of [...res.byOfficer.keys()]) if (!scopeSet.has(o)) res.byOfficer.delete(o);
  }
  if (res.byOfficer.size === 0) throw new ApiError(422, "No matched, assigned dealers to plan recovery for");

  // Guard: a recovery plan for this month must not already exist for any affected officer.
  const existing = await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: month.id, officerId: { in: [...res.byOfficer.keys()] } },
    select: { officerId: true },
  });
  if (existing.length > 0) {
    throw new ApiError(409, "A Recovery Plan for this month already exists. Upload a weekly Aging Report to refresh it instead.");
  }

  // --- Build the ENTIRE write set OUTSIDE the transaction (pure construction, no DB). --------
  // Client-generated ids let us wire every FK (snapshot → plan, dealer → snapshot, bill →
  // snapshot+dealer) in memory, so each level is one bulk createMany instead of thousands of
  // sequential per-dealer creates. IDs are opaque; the rows/values are byte-for-byte identical.
  // Recovery MUST belong to a Seasonal plan. Link each officer's recovery plan to their SEASONAL
  // plan for this season (active version preferred). Officers WITHOUT a seasonal plan are skipped
  // so no orphan (null-parent) recovery plan is ever created.
  const seasonalPlans = await prisma.seasonPlan.findMany({
    where: { seasonId: month.seasonId, planningType: "SEASONAL", officerId: { in: [...res.byOfficer.keys()] } },
    select: { id: true, officerId: true, isActiveVersion: true, version: true },
    orderBy: [{ isActiveVersion: "desc" }, { version: "desc" }],
  });
  const seasonPlanByOfficer = new Map<string, string>();
  for (const sp of seasonalPlans as { id: string; officerId: string }[]) {
    if (!seasonPlanByOfficer.has(sp.officerId)) seasonPlanByOfficer.set(sp.officerId, sp.id);
  }
  const officersWithoutSeasonal = [...res.byOfficer.keys()].filter((o) => !seasonPlanByOfficer.has(o));
  for (const o of officersWithoutSeasonal) res.byOfficer.delete(o);
  if (res.byOfficer.size === 0) {
    throw new ApiError(
      422,
      "No matched officer has a Seasonal plan for this season. Create the Seasonal plan(s) first — recovery must belong to a seasonal plan.",
    );
  }

  const recoveryPlanRows: { id: string; seasonId: string; seasonMonthId: string; officerId: string; seasonPlanId: string | null; cutoffDate: Date; status: PlanStatus }[] = [];
  const agingSnapshotRows: { id: string; recoveryPlanId: string; weekNo: number; cutoffDate: Date; workbookName: string; uploadedById: string }[] = [];
  const agingSnapshotDealerRows: { id: string; snapshotId: string; dealerId: string; outstanding: number; overdue: number; due: number; running: number }[] = [];
  const agingSnapshotBillRows: { snapshotId: string; snapshotDealerId: string; dealerId: string; billDate: Date | null; refNo: string | null; amount: number; dueDate: Date | null; bucket: string }[] = [];
  const recoveryPlanDealerRows: { recoveryPlanId: string; dealerId: string; outstanding: number; overdue: number; due: number; running: number; runningTillDate: number }[] = [];

  const planIds: string[] = [];
  let dealerCount = 0;
  let billCount = 0;

  for (const [officerId, dealersFor] of res.byOfficer) {
    const seasonPlanId = seasonPlanByOfficer.get(officerId);
    if (!seasonPlanId) continue; // guaranteed present (officers without a seasonal plan were removed)
    const planId = randomUUID();
    const snapshotId = randomUUID();
    planIds.push(planId);
    recoveryPlanRows.push({ id: planId, seasonId: month.seasonId, seasonMonthId: month.id, officerId, seasonPlanId, cutoffDate: cutoff, status: PlanStatus.DRAFT });
    agingSnapshotRows.push({ id: snapshotId, recoveryPlanId: planId, weekNo: 0, cutoffDate: cutoff, workbookName: filename, uploadedById: ctx.userId });
    for (const d of dealersFor) {
      const snapDealerId = randomUUID();
      agingSnapshotDealerRows.push({ id: snapDealerId, snapshotId, dealerId: d.dealerId, outstanding: d.aging.outstanding, overdue: d.aging.overdue, due: d.aging.due, running: d.aging.running });
      // NORMAL create: seed the live aging + the Running O/S opening (runningTillDate) only. It does NOT
      // set `outstandingTillDate` — the static opening balance is owned exclusively by the Static
      // Outstanding import, so a normal aging upload never affects both data sources.
      recoveryPlanDealerRows.push({ recoveryPlanId: planId, dealerId: d.dealerId, outstanding: d.aging.outstanding, overdue: d.aging.overdue, due: d.aging.due, running: d.aging.running, runningTillDate: d.aging.running });
      for (const b of d.aging.bills) {
        agingSnapshotBillRows.push({ snapshotId, snapshotDealerId: snapDealerId, dealerId: d.dealerId, billDate: b.billDate, refNo: b.refNo, amount: b.amount, dueDate: b.dueDate, bucket: b.bucket });
      }
      billCount += d.aging.bills.length;
      dealerCount += 1;
    }
  }

  // --- Writes ONLY: 5 bulk statements, parent-first for FK integrity. ------------------------
  await prisma.$transaction(
    async (tx: Tx) => {
      await tx.recoveryPlan.createMany({ data: recoveryPlanRows });
      await tx.agingSnapshot.createMany({ data: agingSnapshotRows });
      if (agingSnapshotDealerRows.length > 0) await tx.agingSnapshotDealer.createMany({ data: agingSnapshotDealerRows });
      if (agingSnapshotBillRows.length > 0) await tx.agingSnapshotBill.createMany({ data: agingSnapshotBillRows });
      if (recoveryPlanDealerRows.length > 0) await tx.recoveryPlanDealer.createMany({ data: recoveryPlanDealerRows });
    },
    { timeout: 60000, maxWait: 10000 },
  );

  await writeAudit({
    userId: ctx.userId,
    action: "CREATE",
    entity: "recoveryPlan",
    summary: `Recovery created from ${filename} — ${planIds.length} officer plan(s), ${dealerCount} dealers, ${billCount} bills`,
  });
  return { plansCreated: planIds.length, dealers: dealerCount, bills: billCount, unknownDealers: res.unknownDealers.length, planIds };
}

/* -------------------------------- Lists ----------------------------------- */

export async function listRecoveryPlans(ctx: AuthContext, statuses?: PlanStatus[], mine = false) {
  const scope = await getOfficerScope(ctx);
  // "My Plans" narrows to the caller's own recovery plans (used by RMs).
  const officerWhere = mine ? ctx.userId : scope.all ? undefined : { in: scope.ids };
  const rows = await prisma.recoveryPlan.findMany({
    where: {
      officerId: officerWhere,
      status: statuses ? { in: statuses } : undefined,
      // Deactivated recovery plans — and any under a deactivated SEASONAL plan — are hidden from the
      // Sales Officer; Admin/RM still see them. (seasonPlanId null tolerated for legacy rows.)
      ...officerVisibilityWhere(ctx),
      ...(ctx.role === Role.SALES_OFFICER
        ? { OR: [{ seasonPlanId: null }, { lifecycleFromParent: false }, { seasonPlan: { lifecycleState: { not: "DEACTIVATED" } } }] }
        : {}),
    },
    include: { season: { select: { name: true, year: true } }, seasonMonth: { select: { name: true } }, officer: { select: { name: true, territory: true, group: { select: { name: true } } } } },
    orderBy: [{ updatedAt: "desc" }],
  });
  // TEMP DIAGNOSTIC (approval visibility, prod-only empty). Remove after diagnosis.
  if (ctx.role === Role.SALES_OFFICER) {
    console.log(`[approvals-debug:recovery] sessionUserId=${ctx.userId} username=${ctx.username} mine=${mine} scopeIds=${JSON.stringify(scope.ids)} resultCount=${rows.length}`);
  }
  return rows.map((r) => ({
    id: r.id,
    seasonName: `${r.season.name} ${r.season.year}`,
    monthName: r.seasonMonth.name,
    officerId: r.officerId,
    officerName: r.officer.name,
    groupName: r.officer.group?.name ?? null,
    territory: (r.officer as { territory?: string | null }).territory ?? null,
    status: r.status as PlanStatus,
    lifecycleState: (r as { lifecycleState?: string }).lifecycleState ?? "ACTIVE",
    cutoffDate: r.cutoffDate,
    lastSavedAt: r.lastSavedAt,
    updatedAt: r.updatedAt,
  }));
}

/* ------------------------------- Detail ----------------------------------- */

export async function getRecoveryPlan(ctx: AuthContext, id: string) {
  const plan = await prisma.recoveryPlan.findUnique({
    where: { id },
    include: {
      season: { select: { name: true, year: true, startMonth: true, startYear: true } },
      seasonMonth: { select: { name: true, order: true } },
      officer: { select: { name: true } },
      seasonPlan: { select: { lifecycleState: true } },
      weekLocks: { select: { weekNo: true, locked: true } },
      dealers: {
        // Only ACTIVE dealers appear in Recovery (deactivated/deleted are hidden; history kept).
        where: { dealer: { isActive: true } },
        include: { dealer: { select: { name: true } }, weekPlans: true },
        orderBy: { dealer: { name: "asc" } },
      },
    },
  });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  // Hidden from the SO if the plan itself is deactivated, or it still FOLLOWS a deactivated parent
  // (a directly-restored historical/read-only child stays viewable).
  const parentLifecycle = (plan as { seasonPlan?: { lifecycleState: string } | null }).seasonPlan?.lifecycleState;
  const childFromParent = (plan as { lifecycleFromParent?: boolean }).lifecycleFromParent ?? false;
  if (isHiddenFromOfficer(ctx, (plan as { lifecycleState?: string }).lifecycleState) || isHiddenByArchivedParent(ctx, childFromParent, parentLifecycle)) {
    throw new ApiError(404, "Recovery plan not found");
  }
  await assertOfficerInScope(ctx, plan.officerId);

  // Owner + Super Admin always; an RM may edit a RETURNED plan of a team member (drives editable inputs +
  // Save button). assertOfficerInScope above already confirmed an RM only reaches their own team's plans.
  const canManage = await canManageRecovery(ctx, plan.officerId, plan.status as PlanStatus);
  // A closed/deactivated recovery (or parent seasonal) plan is frozen — no month/week editing.
  const isLive = ((plan as { lifecycleState?: string }).lifecycleState ?? "ACTIVE") === "ACTIVE" && (parentLifecycle ?? "ACTIVE") === "ACTIVE";
  const monthEditable = canManage && EDITABLE.includes(plan.status as PlanStatus) && isLive;
  // Week View may be re-opened by a weekly upload toggle, even after approval; never while pending.
  const pending = plan.status === PlanStatus.PENDING_RM || plan.status === PlanStatus.PENDING_ADMIN;
  const weekEditable = canManage && plan.weeklyEditEnabled && !pending && isLive;
  // Admin Override: a Super Admin may correct an APPROVED, live recovery plan (read-only flag only).
  const canAdminEdit = ctx.role === Role.SUPER_ADMIN && plan.status === PlanStatus.APPROVED && isLive;
  const weekCount = weekCountForCutoff();

  // Per-week "This Week's Due": distribute the month's Due across the four business weeks by each
  // DUE invoice's Due Date (reusing the Due Date already parsed from the Aging Report and stored on
  // the bill). The sum of the four weeks equals the dealer's month Due. Sourced from the LATEST
  // snapshot's bills — a read-only, aging-derived figure; no planning value is touched.
  // The two most recent snapshots drive per-week Due (latest) AND change tracking (latest vs prev).
  const recentSnaps = (await prisma.agingSnapshot.findMany({
    where: { recoveryPlanId: plan.id },
    orderBy: [{ weekNo: "desc" }],
    take: 2,
    select: { id: true, weekNo: true, cutoffDate: true, summary: true, createdAt: true },
  })) as { id: string; weekNo: number; cutoffDate: Date; summary: string | null; createdAt: Date }[];
  const latestSnapshot = recentSnaps[0] ?? null;
  const prevSnapshot = recentSnaps[1] ?? null;

  const dueBills = latestSnapshot
    ? ((await prisma.agingSnapshotBill.findMany({
        where: { snapshotId: latestSnapshot.id, bucket: "DUE" },
        select: { dealerId: true, dueDate: true, amount: true },
      })) as { dealerId: string; dueDate: Date | null; amount: unknown }[])
    : [];
  const dueByWeekByDealer = new Map<string, Record<1 | 2 | 3 | 4, number>>();
  for (const b of dueBills) {
    if (!b.dueDate) continue; // a DUE bill always has a due date (null → Overdue), defensive only
    const wk = businessWeekOfMonth(b.dueDate);
    const rec = dueByWeekByDealer.get(b.dealerId) ?? { 1: 0, 2: 0, 3: 0, 4: 0 };
    rec[wk] += num(b.amount);
    dueByWeekByDealer.set(b.dealerId, rec);
  }

  // Change tracking: the PREVIOUS snapshot's per-dealer aging → deltas + "changed" row flags.
  const prevDealers = prevSnapshot
    ? ((await prisma.agingSnapshotDealer.findMany({ where: { snapshotId: prevSnapshot.id }, select: { dealerId: true, outstanding: true, overdue: true, due: true, running: true } })) as {
        dealerId: string; outstanding: unknown; overdue: unknown; due: unknown; running: unknown;
      }[])
    : [];
  const prevByDealer = new Map(prevDealers.map((d) => [d.dealerId, { outstanding: num(d.outstanding), overdue: num(d.overdue), due: num(d.due), running: num(d.running) }]));

  // "Missing in Latest Aging" (derived, Option C): a dealer kept in the plan but absent from the newest
  // snapshot shows its last-known aging with a stale badge — no value is zeroed, no row is removed.
  const latestDealerIds = latestSnapshot
    ? new Set(((await prisma.agingSnapshotDealer.findMany({ where: { snapshotId: latestSnapshot.id }, select: { dealerId: true } })) as { dealerId: string }[]).map((d) => d.dealerId))
    : new Set<string>();

  // Week locking is DATE-BASED: a week is locked once it has completely ended; the current + future weeks
  // stay editable. An admin manual override (RecoveryWeekLock) takes priority over the date rule. Values
  // are always preserved — locking only disables editing.
  const cal = planCalendar(
    { startMonth: (plan.season as { startMonth: number | null }).startMonth, startYear: (plan.season as { startYear: number | null }).startYear },
    (plan.seasonMonth as { order: number }).order,
    plan.cutoffDate,
  );
  const overrides = new Map<number, boolean>(
    ((plan as { weekLocks?: { weekNo: number; locked: boolean }[] }).weekLocks ?? []).map((w) => [w.weekNo, w.locked]),
  );
  const weekLocks = computeWeekLocks(cal, overrides, new Date());
  // First EDITABLE week (for the default selected week + guidance); if all locked, the last week.
  const currentWeek = (weekLocks.find((w) => !w.locked)?.weekNo ?? BUSINESS_WEEK_COUNT);
  // Global "Enable Due Recovery Validation" setting → drives the Due↔Running row lock in the UI.
  const { dueValidation } = await getRecoveryConfig();
  const lastRefresh =
    latestSnapshot && latestSnapshot.weekNo > 0 && latestSnapshot.summary
      ? { at: latestSnapshot.createdAt, businessWeek: Math.min(((latestSnapshot.weekNo as number) ?? 0) + 1, BUSINESS_WEEK_COUNT), ...(JSON.parse(latestSnapshot.summary) as AgingChangeSummary) }
      : null;

  return {
    id: plan.id,
    status: plan.status as PlanStatus,
    officerId: plan.officerId,
    officerName: plan.officer.name,
    seasonName: `${plan.season.name} ${plan.season.year}`,
    monthName: plan.seasonMonth.name,
    cutoffDate: plan.cutoffDate,
    weeklyEditEnabled: plan.weeklyEditEnabled,
    monthEditable,
    weekEditable,
    canAdminEdit,
    weekCount,
    currentWeek,
    weekLocks,
    dueValidation,
    lastRefresh,
    dealers: plan.dealers.map((d) => {
      const weeks: Record<number, { weekRecoveryPlan: number; weekRunningRecovery: number }> = {};
      for (const w of d.weekPlans) weeks[w.weekNo] = { weekRecoveryPlan: num(w.weekRecoveryPlan ?? 0), weekRunningRecovery: num(w.weekRunningRecovery ?? 0) };
      const monthRecoveryPlan = num(d.monthRecoveryPlan ?? 0);
      const monthRunningRecovery = num(d.monthRunningRecovery ?? 0);
      const prev = prevByDealer.get(d.dealerId) ?? null;
      const cur = { outstanding: num(d.outstanding), overdue: num(d.overdue), due: num(d.due), running: num(d.running) };
      const changed = prev ? prev.outstanding !== cur.outstanding || prev.overdue !== cur.overdue || prev.due !== cur.due || prev.running !== cur.running : false;
      return {
        dealerId: d.dealerId,
        dealerName: d.dealer.name,
        outstanding: cur.outstanding,
        overdue: cur.overdue,
        due: cur.due,
        running: cur.running,
        // Outstanding Till Date is the STATIC opening balance — set ONLY by the Static Outstanding import,
        // independent of the live Current Outstanding. 0 until a static import provides it (no fallback to
        // the live outstanding, which would otherwise make this column track current outstanding).
        outstandingTillDate: num(d.outstandingTillDate ?? 0),
        // Running O/S Till Date keeps its opening seed (falls back to current for legacy rows).
        runningTillDate: num(d.runningTillDate ?? d.running),
        // Day Book-derived business values (populated by the Daybook upload; default 0).
        srCr: num(d.srCr ?? 0),
        liveRecovery: num(d.liveRecovery ?? 0),
        // DERIVED (Part 5): Actual Running Recovery = Live Recovery + SR/CR − (Due + Overdue). Computed
        // at read time so it auto-refreshes from EITHER a Daybook or an Aging change; never stored.
        actualRunningRecovery: num(d.liveRecovery ?? 0) + num(d.srCr ?? 0) - (cur.due + cur.overdue),
        monthRecoveryPlan,
        monthRunningRecovery,
        noPlan: d.noPlan,
        noPlanReason: d.noPlanReason,
        completed: monthRecoveryPlan > 0 || monthRunningRecovery > 0,
        weeks,
        // Month's Due split across the four business weeks by due date (Week View uses the selected
        // week; Month View keeps the aggregate `due`).
        dueByWeek: dueByWeekByDealer.get(d.dealerId) ?? { 1: 0, 2: 0, 3: 0, 4: 0 },
        // Change tracking (vs previous snapshot): previous aging values + a changed flag.
        prevAging: prev,
        changed,
        // Present in the plan but absent from the newest Aging snapshot → last-known values are stale.
        missingInLatestAging: latestSnapshot ? !latestDealerIds.has(d.dealerId) : false,
      };
    }),
  };
}

/* -------------------------------- Saving ---------------------------------- */

const monthSchema = z.object({
  entries: z.array(z.object({ dealerId: z.string().min(1), monthRecoveryPlan: z.coerce.number().min(0).optional(), monthRunningRecovery: z.coerce.number().min(0).optional() })),
});
const weekSchema = z.object({
  weekNo: z.coerce.number().int().min(1).max(6),
  entries: z.array(z.object({ dealerId: z.string().min(1), weekRecoveryPlan: z.coerce.number().min(0).optional(), weekRunningRecovery: z.coerce.number().min(0).optional() })),
});

/**
 * Who may EDIT a recovery plan: the owning Sales Officer and the Super Admin always may. A Regional
 * Manager may edit a RETURNED plan of an officer on THEIR team (group scope) — so an RM can correct and
 * resubmit a plan sent back to the team. Any other status keeps the existing owner/admin-only rule.
 */
async function canManageRecovery(ctx: AuthContext, officerId: string, status: PlanStatus): Promise<boolean> {
  if (ctx.role === Role.SUPER_ADMIN || isPlanOwner(ctx, officerId)) return true;
  if (ctx.role === Role.REGIONAL_MANAGER && status === PlanStatus.RETURNED) {
    const scope = await getOfficerScope(ctx);
    return scope.all || scope.ids.includes(officerId);
  }
  return false;
}

async function loadEditablePlan(ctx: AuthContext, id: string) {
  const plan = await prisma.recoveryPlan.findUnique({
    where: { id },
    select: { id: true, officerId: true, status: true, weeklyEditEnabled: true, lifecycleState: true, seasonPlan: { select: { lifecycleState: true } } },
  });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  if (!(await canManageRecovery(ctx, plan.officerId, plan.status as PlanStatus))) throw new ApiError(403, "You cannot edit this recovery plan");
  return plan as typeof plan & { lifecycleState: string; seasonPlan: { lifecycleState: string } | null };
}

/** A recovery plan is editable only when it AND its parent seasonal plan (if linked) are ACTIVE. */
function assertRecoveryLive(plan: { lifecycleState: string; seasonPlan?: { lifecycleState: string } | null }) {
  if (plan.seasonPlan) assertLifecycleEditable(plan.seasonPlan.lifecycleState, "The parent seasonal plan");
  assertLifecycleEditable(plan.lifecycleState, "This recovery plan");
}

export async function saveRecoveryMonth(ctx: AuthContext, id: string, raw: unknown) {
  const { entries } = monthSchema.parse(raw);
  const plan = await loadEditablePlan(ctx, id);
  if (!EDITABLE.includes(plan.status as PlanStatus)) throw new ApiError(409, "Month View is locked in this state");
  assertRecoveryLive(plan);
  // Row-lock inputs: Overdue + Due (threshold) and the currently STORED plan (to detect Due edits).
  const dealerRows = (await prisma.recoveryPlanDealer.findMany({
    where: { recoveryPlanId: id },
    select: { dealerId: true, overdue: true, due: true, monthRecoveryPlan: true, dealer: { select: { name: true } } },
  })) as { dealerId: string; overdue: unknown; due: unknown; monthRecoveryPlan: unknown; dealer: { name: string } }[];
  const rowByDealer = new Map(dealerRows.map((d) => [d.dealerId, d]));
  // Validate the Due↔Running row-lock for every entry BEFORE writing (all-or-nothing) — but ONLY when the
  // admin setting "Enable Due Recovery Validation" is ON (global, DB-backed, default ON).
  if ((await getRecoveryConfig()).dueValidation) {
    for (const e of entries) {
      const row = rowByDealer.get(e.dealerId);
      if (!row) continue;
      const threshold = num(row.overdue) + num(row.due);
      assertRowLock(e.monthRecoveryPlan ?? num(row.monthRecoveryPlan), e.monthRunningRecovery ?? 0, num(row.monthRecoveryPlan), threshold, row.dealer.name);
    }
  }
  const dealerIds = new Set(dealerRows.map((d) => d.dealerId));
  await prisma.$transaction(
    async (tx: Tx) => {
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        await Promise.all(
          entries.slice(i, i + CHUNK).map((e) => {
            if (!dealerIds.has(e.dealerId)) return Promise.resolve();
            return tx.recoveryPlanDealer.update({
              where: { recoveryPlanId_dealerId: { recoveryPlanId: id, dealerId: e.dealerId } },
              data: { monthRecoveryPlan: e.monthRecoveryPlan, monthRunningRecovery: e.monthRunningRecovery },
            });
          }),
        );
      }
    },
    { timeout: 60000, maxWait: 10000 },
  );
  const saved = await prisma.recoveryPlan.update({ where: { id }, data: { lastSavedAt: new Date() }, select: { lastSavedAt: true } });
  return { saved: true, lastSavedAt: saved.lastSavedAt };
}

/**
 * ADMIN manual lock/unlock toggle for one business week. Flips the EFFECTIVE state (override wins, else
 * date-based) and PERSISTS it as an override on the plan — so it holds across refresh/login and for every
 * user until an admin toggles again. Admin (Super Admin) only.
 */
export async function toggleRecoveryWeekLock(ctx: AuthContext, id: string, raw: unknown): Promise<{ weekNo: number; locked: boolean }> {
  assertAdmin(ctx);
  const { weekNo } = z.object({ weekNo: z.coerce.number().int().min(1).max(BUSINESS_WEEK_COUNT) }).parse(raw);
  const plan = (await prisma.recoveryPlan.findUnique({ where: { id }, select: { id: true } })) as { id: string } | null;
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  const next = !(await effectiveWeekLocked(id, weekNo)); // flip whatever the week currently resolves to
  await prisma.recoveryWeekLock.upsert({
    where: { recoveryPlanId_weekNo: { recoveryPlanId: id, weekNo } },
    create: { recoveryPlanId: id, weekNo, locked: next },
    update: { locked: next },
  });
  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "recoveryPlan", entityId: id, summary: `Week ${weekNo} manually ${next ? "locked" : "unlocked"} (admin override)` });
  return { weekNo, locked: next };
}

export async function saveRecoveryWeek(ctx: AuthContext, id: string, raw: unknown) {
  const { weekNo, entries } = weekSchema.parse(raw);
  const plan = await loadEditablePlan(ctx, id);
  const pending = plan.status === PlanStatus.PENDING_RM || plan.status === PlanStatus.PENDING_ADMIN;
  if (pending || !plan.weeklyEditEnabled) throw new ApiError(409, "Week View is locked");
  assertRecoveryLive(plan);
  // Per-week lock (date-based, admin override wins) — a locked week is read-only; an admin must unlock it.
  if (await effectiveWeekLocked(id, weekNo)) throw new ApiError(409, "This week is locked — ask an admin to unlock it before editing.");
  const dealerRows = (await prisma.recoveryPlanDealer.findMany({
    where: { recoveryPlanId: id },
    select: { id: true, dealerId: true, overdue: true, dealer: { select: { name: true } }, weekPlans: { where: { weekNo }, select: { weekRecoveryPlan: true } } },
  })) as { id: string; dealerId: string; overdue: unknown; dealer: { name: string }; weekPlans: { weekRecoveryPlan: unknown }[] }[];
  const byDealer = new Map(dealerRows.map((d) => [d.dealerId, d.id]));
  const rowByDealer = new Map(dealerRows.map((d) => [d.dealerId, d]));
  // Threshold per row = Overdue + THIS WEEK'S Due (same figure the Week View shows). Gated on the global
  // "Enable Due Recovery Validation" setting (default ON).
  if ((await getRecoveryConfig()).dueValidation) {
    const dueByWeek = await dueByWeekForPlan(id);
    for (const e of entries) {
      const row = rowByDealer.get(e.dealerId);
      if (!row) continue;
      const storedPlan = num(row.weekPlans[0]?.weekRecoveryPlan ?? 0);
      const threshold = num(row.overdue) + (dueByWeek.get(e.dealerId)?.[weekNo as 1 | 2 | 3 | 4] ?? 0);
      assertRowLock(e.weekRecoveryPlan ?? storedPlan, e.weekRunningRecovery ?? 0, storedPlan, threshold, row.dealer.name);
    }
  }
  await prisma.$transaction(
    async (tx: Tx) => {
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        await Promise.all(
          entries.slice(i, i + CHUNK).map((e) => {
            const rpdId = byDealer.get(e.dealerId);
            if (!rpdId) return Promise.resolve();
            return tx.recoveryWeekPlan.upsert({
              where: { recoveryPlanDealerId_weekNo: { recoveryPlanDealerId: rpdId, weekNo } },
              create: { recoveryPlanDealerId: rpdId, weekNo, weekRecoveryPlan: e.weekRecoveryPlan, weekRunningRecovery: e.weekRunningRecovery },
              update: { weekRecoveryPlan: e.weekRecoveryPlan, weekRunningRecovery: e.weekRunningRecovery },
            });
          }),
        );
      }
    },
    { timeout: 60000, maxWait: 10000 },
  );
  const saved = await prisma.recoveryPlan.update({ where: { id }, data: { lastSavedAt: new Date() }, select: { lastSavedAt: true } });
  return { saved: true, lastSavedAt: saved.lastSavedAt };
}

export async function setRecoveryDealerNoPlan(ctx: AuthContext, id: string, dealerId: string, noPlan: boolean, reason?: string) {
  const plan = await loadEditablePlan(ctx, id);
  if (!EDITABLE.includes(plan.status as PlanStatus)) throw new ApiError(409, "This recovery plan is not editable");
  assertRecoveryLive(plan);
  const noPlanReason = noPlan ? reason?.trim() || null : null;
  await prisma.recoveryPlanDealer.update({ where: { recoveryPlanId_dealerId: { recoveryPlanId: id, dealerId } }, data: { noPlan, noPlanReason } });
  return { noPlan, noPlanReason };
}

/* ---------------------- Weekly re-upload + change tracking ----------------- */

const weeklySchema = z.object({
  recoveryPlanId: z.string().min(1),
  weekNo: z.coerce.number().int().min(1).max(6),
  cutoffDate: z.string().min(1),
  allowWeeklyEdit: z.coerce.boolean().default(true),
});

export interface WeeklyUploadResult {
  weekNo: number;
  outstandingIncreased: number;
  outstandingDecreased: number;
  newDealers: number;
  removedDealers: number;
}

/**
 * Weekly Aging Report re-upload: creates a NEW snapshot (never overwrites), refreshes ONLY the
 * read-only aging figures on RecoveryPlanDealer, sets the Week-edit toggle, and returns a
 * change-tracking summary vs the previous snapshot. Month plan / weekly plans / history are
 * preserved.
 */
export async function uploadWeeklyAging(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<WeeklyUploadResult> {
  assertAdmin(ctx);
  const input = weeklySchema.parse(raw);
  const cutoff = new Date(input.cutoffDate);
  const plan = await prisma.recoveryPlan.findUnique({
    where: { id: input.recoveryPlanId },
    select: { id: true, officerId: true, lifecycleState: true, seasonPlan: { select: { lifecycleState: true } } },
  });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  // Weekly re-upload obeys the SAME lifecycle guard as manual editing: a closed/deactivated recovery
  // plan (or one under a frozen seasonal plan) accepts no updates.
  assertRecoveryLive(plan as { lifecycleState: string; seasonPlan?: { lifecycleState: string } | null });

  const parsed = parseAgingReport(buffer);
  const res = await resolveAging(parsed, cutoff);
  // Only this plan's officer's dealers are relevant.
  const forOfficer = res.resolved.filter((r) => r.officerId === plan.officerId);
  const newByDealer = new Map<string, ResolvedDealer["aging"]>(forOfficer.map((r) => [r.dealerId, r.aging]));

  const existingDealers = await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: plan.id }, select: { dealerId: true, outstanding: true } });
  const prevByDealer = new Map<string, number>(
    (existingDealers as { dealerId: string; outstanding: unknown }[]).map((d) => [d.dealerId, num(d.outstanding)]),
  );

  let outstandingIncreased = 0, outstandingDecreased = 0, newDealers = 0;
  for (const [dealerId, aging] of newByDealer) {
    const prev = prevByDealer.get(dealerId);
    if (prev === undefined) newDealers += 1;
    else if (aging.outstanding > prev) outstandingIncreased += 1;
    else if (aging.outstanding < prev) outstandingDecreased += 1;
  }
  const removedDealers = [...prevByDealer.keys()].filter((d) => !newByDealer.has(d)).length;
  const summary: WeeklyUploadResult = { weekNo: input.weekNo, outstandingIncreased, outstandingDecreased, newDealers, removedDealers };

  await prisma.$transaction(
    async (tx: Tx) => {
      await writeRefreshSnapshot(tx, plan.id, forOfficer, cutoff, filename, input.weekNo, ctx.userId, summary);
      await tx.recoveryPlan.update({ where: { id: plan.id }, data: { cutoffDate: cutoff, weeklyEditEnabled: input.allowWeeklyEdit } });
    },
    { timeout: 60000, maxWait: 10000 },
  );

  await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "recoveryPlan", entityId: plan.id, summary: `Weekly Aging (week ${input.weekNo}) for ${filename}: +${outstandingIncreased}/-${outstandingDecreased} outstanding, ${newDealers} new, ${removedDealers} removed` });
  return summary;
}

/* ============================================================================
 * REUSABLE RECOVERY REFRESH SYSTEM
 * Business Data (aging-derived) is refreshed here; Planning Data (officer-entered
 * month/week values) is NEVER touched. Both the single weekly re-upload above and the batch
 * "Update Recovery" below share the ONE snapshot-writing core, so there is no duplicated logic.
 * ==========================================================================*/

/**
 * The ONE aging-refresh primitive for a single recovery plan: writes a NEW snapshot (+ per-dealer
 * aggregates + per-bill rows) and refreshes ONLY the read-only aging fields on RecoveryPlanDealer.
 * Planning values (month/week Recovery + Running) are never written here.
 */
async function writeRefreshSnapshot(
  tx: Tx,
  planId: string,
  forOfficer: ResolvedDealer[],
  cutoff: Date,
  filename: string,
  weekNo: number,
  uploadedById: string,
  summary: unknown,
): Promise<string> {
  const snapshot = await tx.agingSnapshot.create({
    data: { recoveryPlanId: planId, weekNo, cutoffDate: cutoff, workbookName: filename, uploadedById, summary: JSON.stringify(summary) },
  });
  for (const r of forOfficer) {
    const sd = await tx.agingSnapshotDealer.create({
      data: { snapshotId: snapshot.id, dealerId: r.dealerId, outstanding: r.aging.outstanding, overdue: r.aging.overdue, due: r.aging.due, running: r.aging.running },
    });
    if (r.aging.bills.length > 0) {
      await tx.agingSnapshotBill.createMany({
        data: r.aging.bills.map((b) => ({ snapshotId: snapshot.id, snapshotDealerId: sd.id, dealerId: r.dealerId, billDate: b.billDate, refNo: b.refNo, amount: b.amount, dueDate: b.dueDate, bucket: b.bucket })),
      });
    }
    // UPSERT (not updateMany): an aging dealer that isn't yet in the plan must be INSERTED, not dropped.
    // NORMAL (dynamic) refresh: update ONLY the live aging fields. It NEVER writes `outstandingTillDate`
    // (the static opening) — that column is owned exclusively by the Static Outstanding import, so the two
    // are independent data sources. Manual recovery inputs, weekly plans, approvals and no-plan flags are
    // all preserved untouched. `runningTillDate` (Running O/S opening) is still seeded on first insert.
    await tx.recoveryPlanDealer.upsert({
      where: { recoveryPlanId_dealerId: { recoveryPlanId: planId, dealerId: r.dealerId } },
      update: { outstanding: r.aging.outstanding, overdue: r.aging.overdue, due: r.aging.due, running: r.aging.running },
      create: {
        recoveryPlanId: planId, dealerId: r.dealerId,
        outstanding: r.aging.outstanding, overdue: r.aging.overdue, due: r.aging.due, running: r.aging.running,
        runningTillDate: r.aging.running,
      },
    });
  }
  return snapshot.id;
}

/** The next snapshot sequence for a plan (0 = initial create, then +1 per refresh). Preserves the
 *  (recoveryPlanId, weekNo) uniqueness and keeps EVERY refresh in history. */
async function nextSnapshotWeekNo(planId: string): Promise<number> {
  const agg = await prisma.agingSnapshot.aggregate({ where: { recoveryPlanId: planId }, _max: { weekNo: true } });
  return ((agg._max.weekNo as number | null) ?? -1) + 1;
}

interface AgingChangeSummary {
  outstandingIncreased: number;
  outstandingDecreased: number;
  newDealers: number;
  removedDealers: number;
  outstandingDelta: number; // total outstanding after − before (negative = reduced = good)
}

/** Change tracking: compare the incoming aging with the plan's CURRENT aging (previous snapshot). */
function buildChangeSummary(
  prevByDealer: Map<string, number>,
  newByDealer: Map<string, ResolvedDealer["aging"]>,
): AgingChangeSummary {
  let outstandingIncreased = 0, outstandingDecreased = 0, newDealers = 0;
  let before = 0, after = 0;
  for (const [, prev] of prevByDealer) before += prev;
  const allIds = new Set<string>([...prevByDealer.keys(), ...newByDealer.keys()]);
  for (const id of allIds) {
    const prev = prevByDealer.get(id);
    const next = newByDealer.get(id)?.outstanding;
    after += next ?? prev ?? 0; // dealers absent from the new report keep their current value
    if (next === undefined) continue; // not in this report — unchanged
    if (prev === undefined) newDealers += 1;
    else if (next > prev) outstandingIncreased += 1;
    else if (next < prev) outstandingDecreased += 1;
  }
  const removedDealers = [...prevByDealer.keys()].filter((id) => !newByDealer.has(id)).length;
  return { outstandingIncreased, outstandingDecreased, newDealers, removedDealers, outstandingDelta: after - before };
}

/* ------------------------- Update Recovery (batch) ------------------------ */

const updateSchema = z.object({
  seasonMonthId: z.string().min(1, "Select a Month"),
  cutoffDate: z.string().min(1, "Select a Cutoff Date"),
  allowWeeklyEdit: z.coerce.boolean().default(true),
  // Optional scope: restrict the refresh to a set of officers (Single / Selected / Seasonal flows).
  // `officerScope` (single id) is kept for existing callers and folded into `officerIds`.
  officerScope: z.string().optional(),
  officerIds: z.array(z.string()).optional(),
});

export interface RecoverySkip {
  officerName: string;
  reason: string;
}
/** A plan whose refresh threw (transient/DB error) — retryable, NOT an intentional skip. */
export interface RecoveryFailure {
  officerId: string;
  officerName: string;
  reason: string;
}
export interface RecoveryUpdateResult {
  updatedPlans: number;
  skippedPlans: number;
  skipped: RecoverySkip[];
  failed: RecoveryFailure[];
  officers: number;
  dealersRefreshed: number;
  totalOutstandingDelta: number;
}

// Fail-safe skip reasons — a plan is only refreshed when it matches CONFIDENTLY on
// Season + Month (query) + Sales Officer (present in report) + Dealer (≥1 overlapping dealer).
const SKIP_SEASONAL_INACTIVE = "Seasonal plan not active";
const SKIP_NO_AGING = "No aging data for that officer";
const SKIP_DEALER_MISMATCH = "Dealer mismatch — report dealers don't match this plan";

/**
 * Update Recovery — refresh the aging/business data of active recovery plans for a month from a newly
 * uploaded Aging Report. FAIL-SAFE: a plan is refreshed only when it can be matched confidently on
 * Season + Month + Sales Officer + Dealer; any plan that cannot be matched is SKIPPED (never
 * modified) and reported with a reason. Reuses the exact import pipeline; each refreshed plan gets a
 * NEW snapshot (sequence weekNo) so history is preserved and planning values are untouched.
 */
export async function updateRecoveryFromAging(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryUpdateResult> {
  assertAdmin(ctx);
  // Accept BOTH a plain object (current caller) and a JSON string (legacy entry point). Normalizing here
  // means a string payload never trips the z.object validator with a confusing "Validation failed".
  const normalized = typeof raw === "string" ? JSON.parse(raw) : raw;
  const input = updateSchema.parse(normalized);
  const cutoff = new Date(input.cutoffDate);
  const month = await prisma.seasonMonth.findUnique({ where: { id: input.seasonMonthId }, select: { id: true } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const parsed = parseAgingReport(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealers found — is this a Bills Receivable Aging Report?");
  const res = await resolveAging(parsed, cutoff);

  const updateScopeIds = input.officerIds?.length ? input.officerIds : input.officerScope ? [input.officerScope] : null;
  const plans = (await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: month.id, lifecycleState: "ACTIVE", officerId: updateScopeIds ? { in: updateScopeIds } : undefined },
    select: { id: true, officerId: true, officer: { select: { name: true } }, seasonPlan: { select: { lifecycleState: true } } },
  })) as { id: string; officerId: string; officer: { name: string }; seasonPlan: { lifecycleState: string } | null }[];
  if (plans.length === 0) throw new ApiError(422, "No active recovery plans exist for the selected month.");

  let updatedPlans = 0, dealersRefreshed = 0, totalOutstandingDelta = 0;
  const officers = new Set<string>();
  const skipped: RecoverySkip[] = [];
  const failed: RecoveryFailure[] = [];

  for (const plan of plans) {
    const officerName = plan.officer.name;

    // Match check 1 — parent seasonal must be active.
    if ((plan.seasonPlan?.lifecycleState ?? "ACTIVE") !== "ACTIVE") {
      skipped.push({ officerName, reason: SKIP_SEASONAL_INACTIVE });
      continue;
    }
    // Match check 2 — the report must contain aging for THIS officer (Sales Officer match).
    const forOfficer = res.resolved.filter((r) => r.officerId === plan.officerId);
    if (forOfficer.length === 0) {
      skipped.push({ officerName, reason: SKIP_NO_AGING });
      continue;
    }
    // Match check 3 — at least one of the report's dealers must belong to this plan (Dealer match).
    const existing = (await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: plan.id }, select: { dealerId: true, outstanding: true } })) as { dealerId: string; outstanding: unknown }[];
    const planDealerIds = new Set(existing.map((d) => d.dealerId));
    if (!forOfficer.some((r) => planDealerIds.has(r.dealerId))) {
      skipped.push({ officerName, reason: SKIP_DEALER_MISMATCH });
      continue;
    }

    // Confidently matched → refresh. RESILIENT (D1): a single plan's failure is recorded and the
    // batch continues, so one officer's transient error never aborts the others — and a retry can be
    // scoped to just the failed officers, so already-refreshed officers are NOT snapshotted again.
    const newByDealer = new Map<string, ResolvedDealer["aging"]>(forOfficer.map((r) => [r.dealerId, r.aging]));
    const prevByDealer = new Map<string, number>(existing.map((d) => [d.dealerId, num(d.outstanding)]));
    const summary = buildChangeSummary(prevByDealer, newByDealer);
    try {
      const weekNo = await nextSnapshotWeekNo(plan.id);
      await prisma.$transaction(
        async (tx: Tx) => {
          await writeRefreshSnapshot(tx, plan.id, forOfficer, cutoff, filename, weekNo, ctx.userId, { ...summary, weekNo });
          await tx.recoveryPlan.update({ where: { id: plan.id }, data: { cutoffDate: cutoff, weeklyEditEnabled: input.allowWeeklyEdit } });
        },
        { timeout: 60000, maxWait: 10000 },
      );
    } catch {
      failed.push({ officerId: plan.officerId, officerName, reason: "Refresh did not complete — you can retry this officer." });
      continue;
    }

    updatedPlans += 1;
    dealersRefreshed += forOfficer.length;
    totalOutstandingDelta += summary.outstandingDelta;
    officers.add(plan.officerId);
  }

  // Server-side diagnostics: log the EXACT officer + reason for every skip/failure so an admin report of
  // "nothing happened" can be traced from the logs (dealer detail is carried in the skip reason strings).
  if (skipped.length > 0 || failed.length > 0) {
    console.warn(
      `[recovery:update] ${filename} — ${updatedPlans} updated, ${skipped.length} skipped, ${failed.length} failed`,
      {
        skipped: skipped.map((s) => ({ officer: s.officerName, reason: s.reason })),
        failed: failed.map((f) => ({ officerId: f.officerId, officer: f.officerName, reason: f.reason })),
      },
    );
  }

  // Audit ALWAYS runs now (the batch never aborts mid-way), so partial progress is recorded truthfully.
  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "recoveryPlan",
    summary: `Update Recovery from ${filename}: ${updatedPlans} updated, ${skipped.length} skipped, ${failed.length} failed, ${dealersRefreshed} dealer(s), ₹${Math.round(totalOutstandingDelta)} outstanding change`,
  });
  return { updatedPlans, skippedPlans: skipped.length, skipped, failed, officers: officers.size, dealersRefreshed, totalOutstandingDelta };
}

/* ----------------------------- Timeline + compare ------------------------- */

/** The aging-refresh timeline for one recovery plan (every snapshot, oldest → newest). */
export async function getRecoveryTimeline(ctx: AuthContext, id: string) {
  const plan = await prisma.recoveryPlan.findUnique({ where: { id }, select: { officerId: true } });
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  await assertOfficerInScope(ctx, plan.officerId);
  const snaps = (await prisma.agingSnapshot.findMany({
    where: { recoveryPlanId: id },
    orderBy: [{ weekNo: "asc" }],
    select: { id: true, weekNo: true, cutoffDate: true, workbookName: true, summary: true, createdAt: true, uploadedBy: { select: { name: true } } },
  })) as { id: string; weekNo: number; cutoffDate: Date; workbookName: string; summary: string | null; createdAt: Date; uploadedBy: { name: string } }[];
  return {
    items: snaps.map((s) => ({
      id: s.id,
      weekNo: s.weekNo,
      // Timeline label = refresh SEQUENCE (initial = Week 1, each refresh +1), matching the locking model.
      businessWeek: s.weekNo + 1,
      initial: s.weekNo === 0,
      cutoffDate: s.cutoffDate,
      workbookName: s.workbookName,
      uploadedBy: s.uploadedBy.name,
      createdAt: s.createdAt,
      summary: s.summary ? (JSON.parse(s.summary) as AgingChangeSummary & { weekNo?: number }) : null,
    })),
  };
}

export async function compareSnapshots(ctx: AuthContext, id: string, fromId: string, toId: string) {
  assertAdmin(ctx); // admin analysis tool only
  const plan = await prisma.recoveryPlan.findUnique({ where: { id }, select: { officerId: true } });
  if (!plan) throw new ApiError(404, "Recovery plan not found");

  // AgingSnapshotDealer has scalar `dealerId` + relations `snapshot`/`bills` — there is NO `dealer`
  // relation. Select the scalars only; dealer NAMES are resolved from the Dealer master by id below.
  // The cast is the file's standard Decimal→unknown widening for `num()` — it matches the selected
  // scalars exactly and no longer fabricates a `dealer` relation.
  const load = async (snapshotId: string) =>
    (await prisma.agingSnapshotDealer.findMany({
      where: { snapshotId, snapshot: { recoveryPlanId: id } },
      select: { dealerId: true, outstanding: true, overdue: true, due: true, running: true },
    })) as { dealerId: string; outstanding: unknown; overdue: unknown; due: unknown; running: unknown }[];
  const [from, to] = await Promise.all([load(fromId), load(toId)]);

  const dealerIds = [...new Set([...from, ...to].map((d) => d.dealerId))];
  const dealerRows = await prisma.dealer.findMany({ where: { id: { in: dealerIds } }, select: { id: true, name: true } });
  const nameById = new Map(dealerRows.map((d) => [d.id, d.name]));
  const nameOf = (dealerId: string) => nameById.get(dealerId) ?? "—";

  const asMetrics = (d: { outstanding: unknown; overdue: unknown; due: unknown; running: unknown }) => ({
    outstanding: num(d.outstanding), overdue: num(d.overdue), due: num(d.due), running: num(d.running),
  });
  const fromByDealer = new Map(from.map((d) => [d.dealerId, { name: nameOf(d.dealerId), ...asMetrics(d) }]));
  const toByDealer = new Map(to.map((d) => [d.dealerId, { name: nameOf(d.dealerId), ...asMetrics(d) }]));
  const ids = [...new Set([...fromByDealer.keys(), ...toByDealer.keys()])];
  const zero = { outstanding: 0, overdue: 0, due: 0, running: 0 };
  const sum = (rows: Map<string, { outstanding: number; overdue: number; due: number; running: number }>) =>
    [...rows.values()].reduce((t, r) => ({ outstanding: t.outstanding + r.outstanding, overdue: t.overdue + r.overdue, due: t.due + r.due, running: t.running + r.running }), { ...zero });

  return {
    totals: { from: sum(fromByDealer), to: sum(toByDealer) },
    dealers: ids
      .map((did) => {
        const f = fromByDealer.get(did) ?? { name: toByDealer.get(did)?.name ?? "—", ...zero };
        const t = toByDealer.get(did) ?? { name: f.name, ...zero };
        return { dealerId: did, dealerName: t.name ?? f.name, from: { outstanding: f.outstanding, overdue: f.overdue, due: f.due, running: f.running }, to: { outstanding: t.outstanding, overdue: t.overdue, due: t.due, running: t.running } };
      })
      .filter((d) => d.from.outstanding !== d.to.outstanding || d.from.overdue !== d.to.overdue || d.from.due !== d.to.due || d.from.running !== d.to.running)
      .sort((a, b) => Math.abs(b.to.outstanding - b.from.outstanding) - Math.abs(a.to.outstanding - a.from.outstanding)),
  };
}

/* ===================== Unified Recovery Import (any scope) =====================
 * ONE analyze + ONE commit for every entry point (All / Selected / Single / Seasonal Replace). The
 * ONLY thing that varies is scope. Everything downstream is reused: parseAgingReport + resolveAging
 * (Dealer Alias resolution), buildRecoveryImportPreview, createAndAssignDealer (onboarding), and the
 * existing createRecoveryFromAging / updateRecoveryFromAging services (now officer-set scoped).
 * ============================================================================= */

const importScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ALL") }),
  z.object({ kind: z.literal("SELECTED"), officerIds: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("SINGLE"), officerId: z.string().min(1) }),
  z.object({ kind: z.literal("SINGLE_FROM_SEASONAL"), seasonPlanId: z.string().min(1) }),
]);
export type RecoveryImportScope = z.infer<typeof importScopeSchema>;

const recoveryImportSchema = z
  .object({
    scope: importScopeSchema,
    seasonMonthId: z.string().min(1, "Select a Month"),
    // Cutoff is OPTIONAL: Static Outstanding Mode ignores it (the opening balance is cutoff-independent),
    // so the modal disables it. Normal mode still requires it (enforced by the refine below).
    cutoffDate: z.string().optional(),
    // Static Outstanding Mode: the aging upload fills ONLY the static Outstanding Till Date and protects it.
    staticOutstanding: z.coerce.boolean().default(false),
  })
  .refine((v) => v.staticOutstanding || (v.cutoffDate != null && v.cutoffDate.length > 0), {
    message: "Select a Cutoff Date",
    path: ["cutoffDate"],
  });
const recoveryImportCommitSchema = z
  .object({
    scope: importScopeSchema,
    seasonMonthId: z.string().min(1, "Select a Month"),
    cutoffDate: z.string().optional(),
    staticOutstanding: z.coerce.boolean().default(false),
    mode: z.enum(["CREATE", "UPDATE", "REPLACE"]),
    // Onboarding candidates the admin selected (single-officer scopes only). Ignored for All/Selected,
    // where an unknown name has no officer to attribute it to.
    newDealerNames: z.array(z.string()).default([]),
    allowWeeklyEdit: z.coerce.boolean().default(true),
  })
  .refine((v) => v.staticOutstanding || (v.cutoffDate != null && v.cutoffDate.length > 0), {
    message: "Select a Cutoff Date",
    path: ["cutoffDate"],
  });

export interface RecoveryImportAnalysis extends RecoveryImportPreview {
  context: { seasonName: string; monthName: string; scopeKind: RecoveryImportScope["kind"]; static: boolean };
}
export interface RecoveryImportResult {
  mode: "CREATE" | "UPDATE" | "REPLACE";
  officersAffected: number;
  recoveryPlanIds: string[];
  createdDealers: number;
  // Officers whose refresh threw (retryable). Retrying scoped to ONLY these never re-snapshots the
  // officers that already succeeded, so their Recovery week is not silently advanced (D1).
  failedOfficers: RecoveryFailure[];
  // UPDATE only: officers intentionally NOT refreshed (e.g. no aging for them, dealer mismatch, inactive
  // parent) with the exact reason — surfaced so "skipped" is explained per-officer, not left generic.
  skippedOfficers: RecoverySkip[];
}

/** Load the officer + month for a Seasonal-Replace scope, validating the month belongs to the plan. */
async function loadSeasonalRecoveryContext(input: { seasonPlanId: string; seasonMonthId: string }) {
  const plan = (await prisma.seasonPlan.findUnique({
    where: { id: input.seasonPlanId },
    select: { officerId: true, seasonId: true, officer: { select: { name: true } }, season: { select: { name: true, year: true } } },
  })) as { officerId: string; seasonId: string; officer: { name: string }; season: { name: string; year: number } } | null;
  if (!plan) throw new ApiError(404, "Seasonal plan not found");
  const month = (await prisma.seasonMonth.findUnique({ where: { id: input.seasonMonthId }, select: { id: true, name: true, seasonId: true } })) as { id: string; name: string; seasonId: string } | null;
  if (!month || month.seasonId !== plan.seasonId) throw new ApiError(422, "That month does not belong to this plan's season");
  return { plan, month };
}

/** The officer's active seasonal plan id for the month's season (recovery must belong to one). */
async function activeSeasonalPlanIdForOfficer(officerId: string, seasonMonthId: string): Promise<string> {
  const month = await prisma.seasonMonth.findUnique({ where: { id: seasonMonthId }, select: { seasonId: true } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const sp = (await prisma.seasonPlan.findFirst({
    where: { seasonId: month.seasonId, planningType: "SEASONAL", officerId },
    select: { id: true },
    orderBy: [{ isActiveVersion: "desc" }, { version: "desc" }],
  })) as { id: string } | null;
  if (!sp) throw new ApiError(422, "This officer has no Seasonal plan for the season — create it first; recovery must belong to a seasonal plan.");
  return sp.id;
}

/** Resolve a scope to its concrete officer id set (null = ALL). */
function scopeOfficerIdList(scope: RecoveryImportScope, singleOfficerId: string | null): string[] | null {
  if (scope.kind === "ALL") return null;
  if (scope.kind === "SELECTED") return scope.officerIds;
  return singleOfficerId ? [singleOfficerId] : null;
}

/**
 * Onboard admin-selected NEW dealers to ONE officer inside a transaction: create-if-new + assign +
 * add to the officer's seasonal plan. Reuses createAndAssignDealer (the single onboarding primitive).
 * Returns the count of freshly created dealers; fills `onboardedIds` with every added dealer id.
 */
async function onboardDealersForOfficer(
  ctx: AuthContext,
  names: string[],
  officerId: string,
  seasonPlanId: string,
  onboardedIds: Set<string>,
): Promise<number> {
  const resolver = await loadDealerResolver();
  const created = new Map<string, string>(); // tightKey → new dealer id
  const effectiveFrom = new Date();
  let createdDealers = 0;
  await prisma.$transaction(
    async (tx: Tx) => {
      for (const name of names) {
        const cls = resolver.classify(name);
        let dealerId: string | null = null;
        if (cls.outcome === "EXISTING") {
          dealerId = cls.dealer.id;
        } else if (cls.outcome === "NEW") {
          const key = tightKey(cls.rawName);
          dealerId = created.get(key) ?? null;
          if (!dealerId) {
            dealerId = randomUUID();
            created.set(key, dealerId);
            await createAndAssignDealer(tx, { id: dealerId, name: cls.rawName, officerId, createdByUserId: ctx.userId, effectiveFrom });
            createdDealers += 1;
          }
        }
        if (!dealerId) continue;
        onboardedIds.add(dealerId);
        await tx.planDealer.upsert({
          where: { seasonPlanId_dealerId: { seasonPlanId, dealerId } },
          create: { seasonPlanId, dealerId, fromMonthlyPlan: true },
          update: {},
        });
      }
    },
    { timeout: 60000, maxWait: 10000 },
  );
  return createdDealers;
}

/**
 * Add newly-onboarded dealers to an EXISTING recovery plan. A weekly refresh only UPDATEs existing
 * RecoveryPlanDealer rows, so dealers onboarded during an UPDATE/REPLACE would be missing. We read
 * their aging from the latest snapshot (written by that same refresh) and upsert one row per dealer —
 * idempotent, and a no-op for any dealer already present.
 */
async function reconcileRecoveryDealers(recoveryPlanId: string, dealerIds: Set<string>): Promise<void> {
  const latest = await prisma.agingSnapshot.findFirst({ where: { recoveryPlanId }, orderBy: { weekNo: "desc" }, select: { id: true } });
  if (!latest) return;
  const snapDealers = await prisma.agingSnapshotDealer.findMany({
    where: { snapshotId: latest.id, dealerId: { in: [...dealerIds] } },
    select: { dealerId: true, outstanding: true, overdue: true, due: true, running: true },
  });
  for (const sd of snapDealers) {
    const vals = { outstanding: num(sd.outstanding), overdue: num(sd.overdue), due: num(sd.due), running: num(sd.running) };
    await prisma.recoveryPlanDealer.upsert({
      where: { recoveryPlanId_dealerId: { recoveryPlanId, dealerId: sd.dealerId } },
      // First appearance of an onboarded dealer → seed live aging + Running O/S opening only. The static
      // Outstanding Till Date is NOT set here (it is owned solely by the Static Outstanding import).
      create: { recoveryPlanId, dealerId: sd.dealerId, ...vals, runningTillDate: vals.running },
      update: {}, // present already → refresh left its aging correct; don't touch officer inputs or Till Date.
    });
  }
}

/**
 * REPLACE one recovery plan ATOMICALLY: reset the officer's planning inputs AND write the replacement
 * aging snapshot in the SAME transaction. This is the critical safety boundary — officer planning is
 * NEVER cleared unless the replacement snapshot is written in the same commit. Reuses writeRefreshSnapshot
 * (the shared snapshot primitive) rather than the separate updateRecoveryFromAging path.
 * Returns false (and touches NOTHING) when the report has no aging for this officer, so we never reset
 * planning without a replacement to write. Idempotent on retry: re-running clears already-clear planning
 * and appends the next sequential snapshot — no duplicate plan, no double-effect on officer inputs.
 */
async function replaceRecoveryPlanAtomic(
  ctx: AuthContext,
  planId: string,
  officerId: string,
  res: Resolution,
  cutoff: Date,
  filename: string,
  allowWeeklyEdit: boolean,
): Promise<boolean> {
  const forOfficer = res.resolved.filter((r) => r.officerId === officerId);
  if (forOfficer.length === 0) return false; // never reset without a replacement snapshot to write

  const existing = (await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: planId }, select: { dealerId: true, outstanding: true } })) as { dealerId: string; outstanding: unknown }[];
  const prevByDealer = new Map<string, number>(existing.map((d) => [d.dealerId, num(d.outstanding)]));
  const newByDealer = new Map<string, ResolvedDealer["aging"]>(forOfficer.map((r) => [r.dealerId, r.aging]));
  const summary = buildChangeSummary(prevByDealer, newByDealer);
  const weekNo = await nextSnapshotWeekNo(planId);

  await prisma.$transaction(
    async (tx: Tx) => {
      // (a) reset the officer's planning inputs …
      await tx.recoveryWeekPlan.deleteMany({ where: { recoveryPlanDealer: { recoveryPlanId: planId } } });
      await tx.recoveryPlanDealer.updateMany({ where: { recoveryPlanId: planId }, data: { monthRecoveryPlan: null, monthRunningRecovery: null, noPlan: false, noPlanReason: null } });
      // (b) … and write the replacement snapshot + refresh aging, in the SAME commit.
      await writeRefreshSnapshot(tx, planId, forOfficer, cutoff, filename, weekNo, ctx.userId, { ...summary, weekNo });
      await tx.recoveryPlan.update({ where: { id: planId }, data: { status: PlanStatus.DRAFT, cutoffDate: cutoff, weeklyEditEnabled: allowWeeklyEdit } });
    },
    { timeout: 60000, maxWait: 10000 },
  );
  return true;
}

/** Preview a Recovery import for any scope: rich per-officer accepted/skip sections + summary card. */
export async function analyzeRecoveryImport(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryImportAnalysis> {
  assertAdmin(ctx);
  const input = recoveryImportSchema.parse(raw);
  // Static mode is cutoff-independent (Outstanding is the sum of all bills). Default the cutoff so the
  // shared resolver/preview still runs; the overdue/due split it produces is unused by the static commit.
  const cutoff = input.cutoffDate ? new Date(input.cutoffDate) : new Date();

  const month = (await prisma.seasonMonth.findUnique({
    where: { id: input.seasonMonthId },
    select: { id: true, name: true, seasonId: true, season: { select: { name: true, year: true } } },
  })) as { id: string; name: string; seasonId: string; season: { name: string; year: number } } | null;
  if (!month) throw new ApiError(422, "The selected Month does not exist");

  // Resolve scope → officer id set (null until parsed for ALL).
  let singleOfficerId: string | null = null;
  if (input.scope.kind === "SINGLE") singleOfficerId = input.scope.officerId;
  else if (input.scope.kind === "SINGLE_FROM_SEASONAL") singleOfficerId = (await loadSeasonalRecoveryContext({ seasonPlanId: input.scope.seasonPlanId, seasonMonthId: input.seasonMonthId })).plan.officerId;
  let scopeOfficerIds = scopeOfficerIdList(input.scope, singleOfficerId);

  const parsed = parseAgingReport(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealers found — is this a Bills Receivable Aging Report?");
  const res = await resolveAging(parsed, cutoff);

  // ALL → every officer that has at least one assigned dealer in this report.
  if (scopeOfficerIds === null) scopeOfficerIds = [...new Set(res.rows.map((r) => r.officerId).filter((o): o is string => o !== null))];

  // Officer names for scope officers AND any 'other officer' referenced by a skipped row.
  const referenced = new Set<string>(scopeOfficerIds);
  for (const r of res.rows) if (r.officerId) referenced.add(r.officerId);
  const users = (await prisma.user.findMany({ where: { id: { in: [...referenced] } }, select: { id: true, name: true } })) as { id: string; name: string }[];
  const officerNameById = new Map(users.map((u) => [u.id, u.name]));

  const existingRows = (await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: input.seasonMonthId, officerId: { in: scopeOfficerIds } },
    select: { id: true, officerId: true, status: true, lifecycleState: true },
  })) as { id: string; officerId: string; status: PlanStatus; lifecycleState: string }[];
  const existingByOfficer = new Map(existingRows.map((e) => [e.officerId, { id: e.id, status: e.status, lifecycleState: e.lifecycleState }]));

  // Existing recovery-plan dealers per officer → lets the preview split aging dealers into
  // "already in the plan" vs "new (to be added)" for the reconciliation summary (item 5).
  const planIdToOfficer = new Map(existingRows.map((e) => [e.id, e.officerId]));
  const existingDealerIdsByOfficer = new Map<string, Set<string>>();
  if (existingRows.length > 0) {
    const planDealers = (await prisma.recoveryPlanDealer.findMany({
      where: { recoveryPlanId: { in: existingRows.map((e) => e.id) } },
      select: { recoveryPlanId: true, dealerId: true },
    })) as { recoveryPlanId: string; dealerId: string }[];
    for (const pd of planDealers) {
      const officerId = planIdToOfficer.get(pd.recoveryPlanId);
      if (!officerId) continue;
      const set = existingDealerIdsByOfficer.get(officerId) ?? new Set<string>();
      set.add(pd.dealerId);
      existingDealerIdsByOfficer.set(officerId, set);
    }
  }

  const preview = buildRecoveryImportPreview(res.rows, scopeOfficerIds, officerNameById, existingByOfficer, existingDealerIdsByOfficer);
  return { ...preview, context: { seasonName: `${month.season.name} ${month.season.year}`, monthName: month.name, scopeKind: input.scope.kind, static: input.staticOutstanding } };
}

/**
 * STATIC OUTSTANDING IMPORT (Mode 1) — freeze the opening balance ONLY. For every EXISTING in-scope
 * recovery-plan dealer matched in the report, set ONLY `outstandingTillDate` (the month-opening snapshot)
 * and mark it `outstandingStatic`. It deliberately writes NOTHING else: no aging snapshot, no live
 * outstanding/overdue/due/running, no Recovery Plan / weekly / actual values, and no cutoff change. This is
 * the structural guarantee that a static upload can never modify normal aging fields. Cutoff-independent
 * (Outstanding = sum of all bills), so no cutoff is needed. Officers with no aging / no matching dealer are
 * skipped with a reason. New dealers are NOT created here — static freezing applies to existing plans.
 */
async function applyStaticOutstanding(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  seasonMonthId: string,
  officerIds: string[] | null,
): Promise<{ updatedOfficers: number; recoveryPlanIds: string[]; skipped: RecoverySkip[] }> {
  const month = await prisma.seasonMonth.findUnique({ where: { id: seasonMonthId }, select: { id: true } });
  if (!month) throw new ApiError(422, "The selected Month does not exist");
  const parsed = parseAgingReport(buffer);
  if (parsed.dealers.length === 0) throw new ApiError(422, "No dealers found — is this a Bills Receivable Aging Report?");
  // Cutoff is irrelevant to the total Outstanding; use a placeholder so the shared resolver runs.
  const res = await resolveAging(parsed, new Date());

  const plans = (await prisma.recoveryPlan.findMany({
    where: { seasonMonthId: month.id, lifecycleState: "ACTIVE", officerId: officerIds ? { in: officerIds } : undefined },
    select: { id: true, officerId: true, officer: { select: { name: true } } },
  })) as { id: string; officerId: string; officer: { name: string } }[];
  if (plans.length === 0) throw new ApiError(422, "No active recovery plans exist for the selected month.");

  const recoveryPlanIds: string[] = [];
  const skipped: RecoverySkip[] = [];
  const officers = new Set<string>();
  let updatedDealers = 0;

  for (const plan of plans) {
    const forOfficer = res.resolved.filter((r) => r.officerId === plan.officerId);
    if (forOfficer.length === 0) { skipped.push({ officerName: plan.officer.name, reason: SKIP_NO_AGING }); continue; }
    const existing = (await prisma.recoveryPlanDealer.findMany({ where: { recoveryPlanId: plan.id }, select: { dealerId: true } })) as { dealerId: string }[];
    const planDealerIds = new Set(existing.map((d) => d.dealerId));
    const matches = forOfficer.filter((r) => planDealerIds.has(r.dealerId));
    if (matches.length === 0) { skipped.push({ officerName: plan.officer.name, reason: SKIP_DEALER_MISMATCH }); continue; }

    // ONLY outstandingTillDate + flag — never any live business/planning column.
    await prisma.$transaction(
      async (tx: Tx) => {
        for (const m of matches) {
          await tx.recoveryPlanDealer.update({
            where: { recoveryPlanId_dealerId: { recoveryPlanId: plan.id, dealerId: m.dealerId } },
            data: { outstandingTillDate: m.aging.outstanding, outstandingStatic: true },
          });
        }
      },
      { timeout: 60000, maxWait: 10000 },
    );
    updatedDealers += matches.length;
    officers.add(plan.officerId);
    recoveryPlanIds.push(plan.id);
  }

  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "recoveryPlan",
    summary: `Static Outstanding from ${filename}: ${officers.size} officer(s), ${updatedDealers} dealer(s) — Outstanding Till Date only (live aging untouched)`,
  });
  if (skipped.length > 0) {
    console.warn(`[recovery:static] ${filename} — ${officers.size} updated, ${skipped.length} skipped`, { skipped: skipped.map((s) => ({ officer: s.officerName, reason: s.reason })) });
  }
  return { updatedOfficers: officers.size, recoveryPlanIds, skipped };
}

/**
 * Commit a Recovery import for any scope: (1) onboard selected NEW dealers (single-officer scopes),
 * then (2) CREATE / UPDATE / REPLACE recovery for the in-scope officers by delegating to the existing
 * scoped services, (3) reconcile onboarded dealers, and (4) relink seasonal-scope recovery to v2.
 */
export async function commitRecoveryImport(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<RecoveryImportResult> {
  assertAdmin(ctx);
  const input = recoveryImportCommitSchema.parse(raw);

  let singleOfficerId: string | null = null;
  let seasonPlanIdForRelink: string | null = null;
  if (input.scope.kind === "SINGLE") singleOfficerId = input.scope.officerId;
  else if (input.scope.kind === "SINGLE_FROM_SEASONAL") {
    singleOfficerId = (await loadSeasonalRecoveryContext({ seasonPlanId: input.scope.seasonPlanId, seasonMonthId: input.seasonMonthId })).plan.officerId;
    seasonPlanIdForRelink = input.scope.seasonPlanId;
  }
  const officerIds = scopeOfficerIdList(input.scope, singleOfficerId); // null = ALL

  // STATIC OUTSTANDING MODE — a completely separate, isolated commit. It writes ONLY the static
  // Outstanding Till Date (+ flag) on existing in-scope plan dealers and NOTHING else: no aging snapshot,
  // no live outstanding/overdue/due/running, no cutoff change, no planning. This guarantees a static
  // upload can never touch the normal aging fields (Mode-1 backend validation, by construction).
  if (input.staticOutstanding) {
    const stat = await applyStaticOutstanding(ctx, buffer, filename, input.seasonMonthId, officerIds);
    return {
      mode: input.mode,
      officersAffected: stat.updatedOfficers,
      recoveryPlanIds: stat.recoveryPlanIds,
      createdDealers: 0,
      failedOfficers: [],
      skippedOfficers: stat.skipped,
    };
  }

  // 1) Onboarding — only meaningful for a single officer (unknown names have no officer otherwise).
  let createdDealers = 0;
  const onboardedIds = new Set<string>();
  if (singleOfficerId && input.newDealerNames.length > 0) {
    const seasonPlanId = seasonPlanIdForRelink ?? (await activeSeasonalPlanIdForOfficer(singleOfficerId, input.seasonMonthId));
    createdDealers = await onboardDealersForOfficer(ctx, input.newDealerNames, singleOfficerId, seasonPlanId, onboardedIds);
  }

  // 2) CREATE / UPDATE / REPLACE via the scoped services (officerIds omitted = ALL).
  const scoped = officerIds ? { officerIds } : {};
  const recoveryPlanIds: string[] = [];
  const failedOfficers: RecoveryFailure[] = [];
  const skippedOfficers: RecoverySkip[] = [];
  if (input.mode === "CREATE") {
    // CREATE is one atomic transaction (all-or-nothing), so there is no partial-batch retry hazard.
    // createRecoveryFromAging validates its input as an object. UPDATE uses a legacy JSON-string
    // entry point, but passing that format here made every CREATE fail Zod validation before any
    // report data could be processed.
    const res = await createRecoveryFromAging(ctx, buffer, filename, { seasonMonthId: input.seasonMonthId, cutoffDate: input.cutoffDate, ...scoped });
    recoveryPlanIds.push(...res.planIds);
  } else if (input.mode === "REPLACE") {
    // REPLACE: reset + refresh are done ATOMICALLY per plan (replaceRecoveryPlanAtomic), so officer
    // planning is never cleared unless the replacement snapshot is written in the same commit. Each
    // in-scope plan is independent and RESILIENT (D1): one officer's failure is recorded, not thrown,
    // so the others still complete and a retry can be scoped to only the failed officers.
    const targetPlans = (await prisma.recoveryPlan.findMany({
      where: { seasonMonthId: input.seasonMonthId, lifecycleState: "ACTIVE", ...(officerIds ? { officerId: { in: officerIds } } : {}) },
      select: { id: true, officerId: true, officer: { select: { name: true } }, seasonPlan: { select: { lifecycleState: true } } },
    })) as { id: string; officerId: string; officer: { name: string }; seasonPlan: { lifecycleState: string } | null }[];
    const cutoff = new Date(input.cutoffDate ?? new Date()); // normal mode guarantees a cutoff (schema refine)
    const parsed = parseAgingReport(buffer);
    if (parsed.dealers.length === 0) throw new ApiError(422, "No dealers found — is this a Bills Receivable Aging Report?");
    const res = await resolveAging(parsed, cutoff);
    let replaced = 0;
    for (const p of targetPlans) {
      // Never replace a plan under a frozen (deactivated) parent seasonal plan — same guard as refresh.
      if ((p.seasonPlan?.lifecycleState ?? "ACTIVE") !== "ACTIVE") continue;
      try {
        const didReplace = await replaceRecoveryPlanAtomic(ctx, p.id, p.officerId, res, cutoff, filename, input.allowWeeklyEdit);
        if (didReplace) {
          replaced += 1;
          recoveryPlanIds.push(p.id);
        }
      } catch {
        failedOfficers.push({ officerId: p.officerId, officerName: p.officer.name, reason: "Replace did not complete — you can retry this officer." });
      }
    }
    await writeAudit({ userId: ctx.userId, action: "REPLACE", entity: "recoveryPlan", summary: `Recovery reset & refreshed from ${filename} (${replaced} plan(s), ${failedOfficers.length} failed)` });
  } else {
    // UPDATE: refresh aging only (officer planning preserved) via the shared batch service, which is
    // itself resilient and returns per-officer failures.
    const targetPlans = (await prisma.recoveryPlan.findMany({
      where: { seasonMonthId: input.seasonMonthId, lifecycleState: "ACTIVE", ...(officerIds ? { officerId: { in: officerIds } } : {}) },
      select: { id: true, officerId: true, officer: { select: { name: true } } },
    })) as { id: string; officerId: string; officer: { name: string } }[];
    // Pass a PLAIN OBJECT — updateRecoveryFromAging validates with a z.object schema, so a JSON string
    // (the legacy shape) fails Zod with "Validation failed" before any refresh runs. This was the cause
    // of Update Recovery silently doing nothing; CREATE was already migrated to the object form.
    const upd = await updateRecoveryFromAging(ctx, buffer, filename, { seasonMonthId: input.seasonMonthId, cutoffDate: input.cutoffDate, allowWeeklyEdit: input.allowWeeklyEdit, ...scoped });
    failedOfficers.push(...upd.failed);
    skippedOfficers.push(...upd.skipped);
    // Only officers that were actually refreshed count as affected plans (exclude both failed AND skipped,
    // so a skipped officer is never mis-reported as updated).
    const failedIds = new Set(upd.failed.map((f) => f.officerId));
    const skippedNames = new Set(upd.skipped.map((s) => s.officerName));
    recoveryPlanIds.push(
      ...targetPlans
        .filter((p) => !failedIds.has(p.officerId) && !skippedNames.has(p.officer.name))
        .map((p) => p.id),
    );
  }

  // 3) Reconcile onboarded dealers into the single officer's plan; 4) relink seasonal-scope recovery.
  if (singleOfficerId) {
    const rp = (await prisma.recoveryPlan.findFirst({ where: { seasonMonthId: input.seasonMonthId, officerId: singleOfficerId }, select: { id: true } })) as { id: string } | null;
    if (rp) {
      if (input.mode !== "CREATE" && onboardedIds.size > 0) await reconcileRecoveryDealers(rp.id, onboardedIds);
      if (seasonPlanIdForRelink) await prisma.recoveryPlan.update({ where: { id: rp.id }, data: { seasonPlanId: seasonPlanIdForRelink } });
      if (!recoveryPlanIds.includes(rp.id)) recoveryPlanIds.push(rp.id);
    }
  }

  const officersAffected = officerIds ? officerIds.length - failedOfficers.length - skippedOfficers.length : new Set(recoveryPlanIds).size;
  return { mode: input.mode, officersAffected, recoveryPlanIds, createdDealers, failedOfficers, skippedOfficers };
}

/* ========================= Daybook Upload → SR/CR + Live Recovery =========================
 * A SEPARATE business document from Sales Upload. Scoped to ONE Recovery month, it resolves each
 * Day Book row's dealer through the SAME Dealer Alias resolver (Alias→exact→loose→fuzzy) and writes
 * ONLY srCr + liveRecovery on that month's RecoveryPlanDealer rows. It NEVER touches any aging-derived
 * or officer-planning field. Reupload for the month RESETS then re-sets those two columns (no
 * accumulation). Actual Running Recovery is DERIVED at read time (getRecoveryPlan), so it refreshes
 * automatically from either a Daybook or an Aging change.
 * ======================================================================================== */

const daybookSchema = z.object({
  seasonMonthId: z.string().min(1, "Select a Recovery Month"),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

export interface DaybookMatchedLine { dealerName: string; officerName: string; receipt: number; srCr: number }
export interface DaybookSkippedLine { dealerName: string; reason: string }
export interface DaybookAnalysis {
  workbookName: string;
  monthName: string;
  seasonName: string;
  summary: { totalRows: number; dealersMatched: number; dealersSkipped: number; receiptTotal: number; srCrTotal: number };
  matched: DaybookMatchedLine[];
  skipped: DaybookSkippedLine[];
}
export interface DaybookResult { monthName: string; dealersUpdated: number; receiptTotal: number; srCrTotal: number; dealersCleared: number }

interface DaybookResolution {
  monthName: string;
  seasonName: string;
  totalRows: number;
  // dealerId → aggregated Day Book totals + the month's RecoveryPlanDealer row it maps to.
  matched: Map<string, { rpdId: string; dealerName: string; officerName: string; receipt: number; srCr: number }>;
  skippedUnknown: string[]; // raw names with no Dealer Alias / master match
  skippedNoPlan: { dealerName: string }[]; // resolved, but no Recovery Plan for this month
  monthRpdIds: string[]; // ALL RecoveryPlanDealer ids in the month (for the reupload reset)
}

/** Resolve a parsed Day Book against the month's Recovery Plans (NO writes). Shared by analyze+commit. */
async function resolveDaybook(parsed: ReturnType<typeof parseDaybook>, seasonMonthId: string): Promise<DaybookResolution> {
  const month = (await prisma.seasonMonth.findUnique({
    where: { id: seasonMonthId },
    select: { name: true, season: { select: { name: true, year: true } } },
  })) as { name: string; season: { name: string; year: number } } | null;
  if (!month) throw new ApiError(422, "The selected Recovery Month does not exist");

  const [resolver, plans] = await Promise.all([
    loadDealerResolver(),
    prisma.recoveryPlan.findMany({
      where: { seasonMonthId },
      select: { officer: { select: { name: true } }, dealers: { select: { id: true, dealerId: true, dealer: { select: { name: true } } } } },
    }),
  ]);
  // dealerId → its RecoveryPlanDealer row for this month (a dealer belongs to exactly one officer).
  const rpdByDealer = new Map<string, { rpdId: string; dealerName: string; officerName: string }>();
  const monthRpdIds: string[] = [];
  for (const p of plans as { officer: { name: string }; dealers: { id: string; dealerId: string; dealer: { name: string } }[] }[]) {
    for (const d of p.dealers) {
      monthRpdIds.push(d.id);
      rpdByDealer.set(d.dealerId, { rpdId: d.id, dealerName: d.dealer.name, officerName: p.officer.name });
    }
  }

  // Aggregate Day Book totals per resolved dealerId; collect unresolved raw names once.
  const byDealer = new Map<string, { receipt: number; srCr: number }>();
  const unknownSet = new Set<string>();
  for (const row of parsed.rows) {
    const isSr = isSrCrVoucher(row.vchType);
    const isRcpt = isReceiptVoucher(row.vchType);
    if (!isSr && !isRcpt) continue; // other voucher types don't contribute to SR/CR or Live Recovery
    const match = resolver.resolveWithReason(row.particulars);
    if (!match) {
      unknownSet.add(row.particulars);
      continue;
    }
    const acc = byDealer.get(match.dealer.id) ?? { receipt: 0, srCr: 0 };
    if (isSr) acc.srCr += row.creditAmount;
    if (isRcpt) acc.receipt += row.creditAmount;
    byDealer.set(match.dealer.id, acc);
  }

  const matched = new Map<string, { rpdId: string; dealerName: string; officerName: string; receipt: number; srCr: number }>();
  const skippedNoPlan: { dealerName: string }[] = [];
  for (const [dealerId, totals] of byDealer) {
    const rpd = rpdByDealer.get(dealerId);
    if (!rpd) {
      // Resolved to a master dealer, but that dealer has no Recovery Plan for this month.
      const name = resolver.dealers.find((x) => x.id === dealerId)?.name ?? dealerId;
      skippedNoPlan.push({ dealerName: name });
      continue;
    }
    matched.set(dealerId, { rpdId: rpd.rpdId, dealerName: rpd.dealerName, officerName: rpd.officerName, ...totals });
  }

  return {
    monthName: month.name,
    seasonName: `${month.season.name} ${month.season.year}`,
    totalRows: parsed.totalRows,
    matched,
    skippedUnknown: [...unknownSet],
    skippedNoPlan,
    monthRpdIds,
  };
}

/** Preview a Day Book upload (NO writes) — summary + matched/skipped sections. */
export async function analyzeDaybook(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<DaybookAnalysis> {
  assertAdmin(ctx);
  const input = daybookSchema.parse(raw);
  const parsed = parseDaybook(buffer);
  if (parsed.rows.length === 0) throw new ApiError(422, "No voucher rows were found — is this a Tally Day Book export?");
  const res = await resolveDaybook(parsed, input.seasonMonthId);

  const matched = [...res.matched.values()].map((m) => ({ dealerName: m.dealerName, officerName: m.officerName, receipt: m.receipt, srCr: m.srCr }));
  const skipped: DaybookSkippedLine[] = [
    ...res.skippedUnknown.map((name) => ({ dealerName: name, reason: "Unknown Alias — no Dealer Master match" })),
    ...res.skippedNoPlan.map((s) => ({ dealerName: s.dealerName, reason: "Not in a Recovery Plan for this month" })),
  ];
  const receiptTotal = matched.reduce((t, m) => t + m.receipt, 0);
  const srCrTotal = matched.reduce((t, m) => t + m.srCr, 0);

  return {
    workbookName: filename,
    monthName: res.monthName,
    seasonName: res.seasonName,
    summary: { totalRows: res.totalRows, dealersMatched: matched.length, dealersSkipped: skipped.length, receiptTotal, srCrTotal },
    matched: matched.sort((a, b) => b.receipt + b.srCr - (a.receipt + a.srCr)),
    skipped,
  };
}

/**
 * Commit a Day Book upload: RESET srCr + liveRecovery to 0 for every RecoveryPlanDealer of the month,
 * then set the newly-computed totals for the matched dealers — all in ONE transaction. Reupload-safe
 * (no accumulation). Writes ONLY srCr + liveRecovery; no aging/planning field is ever touched.
 */
export async function commitDaybook(ctx: AuthContext, buffer: Buffer, filename: string, raw: unknown): Promise<DaybookResult> {
  assertAdmin(ctx);
  const input = daybookSchema.parse(raw);
  const parsed = parseDaybook(buffer);
  if (parsed.rows.length === 0) throw new ApiError(422, "No voucher rows were found in the Day Book");
  const res = await resolveDaybook(parsed, input.seasonMonthId);

  const matched = [...res.matched.values()];
  await prisma.$transaction(
    async (tx: Tx) => {
      // Reset the two Daybook-owned columns for the WHOLE month first (clears any prior upload).
      if (res.monthRpdIds.length > 0) {
        await tx.recoveryPlanDealer.updateMany({ where: { id: { in: res.monthRpdIds } }, data: { srCr: 0, liveRecovery: 0 } });
      }
      // Then set the matched dealers' totals (ONLY srCr + liveRecovery).
      for (const m of matched) {
        await tx.recoveryPlanDealer.update({ where: { id: m.rpdId }, data: { srCr: m.srCr, liveRecovery: m.receipt } });
      }
    },
    { timeout: 60000, maxWait: 10000 },
  );

  const receiptTotal = matched.reduce((t, m) => t + m.receipt, 0);
  const srCrTotal = matched.reduce((t, m) => t + m.srCr, 0);
  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "recoveryPlan",
    summary: `Day Book upload for ${res.seasonName} · ${res.monthName} (${filename}): ${matched.length} dealer(s) updated — Receipts ₹${Math.round(receiptTotal)}, SR/CR ₹${Math.round(srCrTotal)}`,
  });

  return { monthName: res.monthName, dealersUpdated: matched.length, receiptTotal, srCrTotal, dealersCleared: res.monthRpdIds.length };
}
