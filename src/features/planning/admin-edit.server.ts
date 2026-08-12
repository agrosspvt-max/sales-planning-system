import "server-only";
import { Role, PlanStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";

/**
 * Admin Override / Edit Mode — a controlled way for a SUPER_ADMIN to correct the INPUT fields of an
 * APPROVED plan without reopening the approval workflow. It:
 *   - is gated to SUPER_ADMIN + APPROVED + ACTIVE (+ latest active version where versions exist);
 *   - writes ONLY the true input stores (pack qty / inputValue, MonthlyEntry.planQty|planValue,
 *     RecoveryPlanDealer.month*, RecoveryWeekPlan.week*) — never derived/imported/system fields;
 *   - requires a non-empty reason;
 *   - records ONE `AdminEditAudit` row per CHANGED field (old, new, difference, reason, who, when);
 *   - does all of the above in a single transaction.
 *
 * These are dedicated endpoints, separate from the officer save paths (which are untouched). No planning
 * calculation is duplicated — derived values are recomputed on read exactly as before.
 */

function assertSuperAdmin(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, "Only a Super Admin can use Admin Edit Mode");
}
function cleanReason(reason: unknown): string {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (!r) throw new ApiError(422, "A reason for the modification is required");
  return r;
}
const changed = (a: number, b: number) => Math.abs(a - b) > 1e-9;

/** One field-level audit record. `tx.adminEditAudit` is created inside the same transaction as the write. */
type AuditRow = {
  adminId: string;
  planType: "SEASONAL" | "MONTHLY" | "RECOVERY";
  planId: string;
  version: number | null;
  seasonId: string | null;
  seasonMonthId: string | null;
  dealerId: string;
  dealerName: string;
  productId: string | null;
  productName: string | null;
  fieldName: string;
  oldValue: number;
  newValue: number;
  reason: string;
};
function auditData(r: AuditRow) {
  return { ...r, difference: r.newValue - r.oldValue };
}

export interface AdminEditResult {
  changedFields: number;
}

/* ------------------------------- Seasonal --------------------------------- */

export interface AdminSeasonalLine {
  dealerId: string;
  productId: string;
  mode?: string;
  packs?: { packSizeId: string; quantity: number }[];
  value?: number;
}

export async function adminEditSeasonal(ctx: AuthContext, planId: string, lines: AdminSeasonalLine[], reasonRaw: unknown): Promise<AdminEditResult> {
  assertSuperAdmin(ctx);
  const reason = cleanReason(reasonRaw);

  const plan = (await prisma.seasonPlan.findUnique({
    where: { id: planId },
    select: { id: true, status: true, isActiveVersion: true, lifecycleState: true, version: true, seasonId: true },
  })) as { id: string; status: string; isActiveVersion: boolean; lifecycleState: string; version: number; seasonId: string } | null;
  if (!plan) throw new ApiError(404, "Seasonal plan not found");
  if (!(plan.status === PlanStatus.APPROVED && plan.isActiveVersion && plan.lifecycleState === "ACTIVE")) {
    throw new ApiError(409, "Admin Edit is only available on the approved, active version of a plan");
  }

  // Current line values + names, for diffing and audit labels.
  const planLines = (await prisma.planLine.findMany({
    where: { planDealer: { seasonPlanId: planId } },
    select: {
      id: true,
      productId: true,
      inputMode: true,
      inputValue: true,
      product: { select: { name: true } },
      planDealer: { select: { dealerId: true, dealer: { select: { name: true } } } },
      packs: { select: { packSizeId: true, quantity: true } },
    },
  })) as {
    id: string; productId: string; inputMode: string | null; inputValue: unknown;
    product: { name: string }; planDealer: { dealerId: string; dealer: { name: string } };
    packs: { packSizeId: string; quantity: number }[];
  }[];
  const byKey = new Map(planLines.map((l) => [`${l.planDealer.dealerId}|${l.productId}`, l] as const));
  const packSizes = (await prisma.packSize.findMany({ select: { id: true, name: true } })) as { id: string; name: string }[];
  const packName = new Map(packSizes.map((p) => [p.id, p.name] as const));

  const audits: ReturnType<typeof auditData>[] = [];
  const writes: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];

  for (const line of lines) {
    const cur = byKey.get(`${line.dealerId}|${line.productId}`);
    if (!cur) continue; // not part of this plan
    const meta = { planType: "SEASONAL" as const, planId, version: plan.version, seasonId: plan.seasonId, seasonMonthId: null, dealerId: line.dealerId, dealerName: cur.planDealer.dealer.name, productId: line.productId, productName: cur.product.name, adminId: ctx.userId, reason };
    const mode = line.mode ?? "PACK_SIZE";

    if (mode === "PACK_SIZE") {
      const curPacks = new Map(cur.packs.map((p) => [p.packSizeId, p.quantity] as const));
      for (const pk of line.packs ?? []) {
        const oldQ = curPacks.get(pk.packSizeId) ?? 0;
        const newQ = Math.max(0, Math.floor(pk.quantity));
        if (!changed(oldQ, newQ)) continue;
        audits.push(auditData({ ...meta, fieldName: `Pack ${packName.get(pk.packSizeId) ?? pk.packSizeId}`, oldValue: oldQ, newValue: newQ }));
        writes.push((tx) =>
          tx.planLinePack.upsert({
            where: { planLineId_packSizeId: { planLineId: cur.id, packSizeId: pk.packSizeId } },
            create: { planLineId: cur.id, packSizeId: pk.packSizeId, quantity: newQ },
            update: { quantity: newQ },
          }),
        );
      }
      if (cur.inputMode !== null || cur.inputValue !== null) writes.push((tx) => tx.planLine.update({ where: { id: cur.id }, data: { inputMode: null, inputValue: null } }));
    } else {
      const oldV = cur.inputValue !== null ? Number((cur.inputValue as { toString(): string }).toString()) : 0;
      const newV = mode === "TOTAL_QUANTITY" ? Math.max(0, Math.floor(line.value ?? 0)) : line.value ?? 0;
      if (changed(oldV, newV) || cur.inputMode !== mode) {
        if (changed(oldV, newV)) audits.push(auditData({ ...meta, fieldName: `Planning Value (${mode})`, oldValue: oldV, newValue: newV }));
        writes.push((tx) => tx.planLine.update({ where: { id: cur.id }, data: { inputMode: mode, inputValue: newV } }));
      }
    }
  }

  return persist(ctx, "seasonPlan", planId, writes, audits);
}

/* -------------------------------- Monthly --------------------------------- */

export interface AdminMonthlyEntry {
  planLineId: string;
  seasonMonthId: string;
  planQty?: number;
  mode?: string;
  planValue?: number;
}

export async function adminEditMonthly(ctx: AuthContext, monthlyPlanId: string, entries: AdminMonthlyEntry[], reasonRaw: unknown): Promise<AdminEditResult> {
  assertSuperAdmin(ctx);
  const reason = cleanReason(reasonRaw);

  const mp = (await prisma.monthlyPlan.findUnique({
    where: { id: monthlyPlanId },
    select: { id: true, status: true, lifecycleState: true, seasonPlanId: true, seasonMonthId: true, seasonPlan: { select: { status: true, isActiveVersion: true, lifecycleState: true, version: true, seasonId: true } } },
  })) as { id: string; status: string; lifecycleState: string; seasonPlanId: string; seasonMonthId: string; seasonPlan: { status: string; isActiveVersion: boolean; lifecycleState: string; version: number; seasonId: string } } | null;
  if (!mp) throw new ApiError(404, "Monthly plan not found");
  const sp = mp.seasonPlan;
  if (!(mp.status === PlanStatus.APPROVED && mp.lifecycleState === "ACTIVE" && sp.status === PlanStatus.APPROVED && sp.isActiveVersion && sp.lifecycleState === "ACTIVE")) {
    throw new ApiError(409, "Admin Edit is only available on an approved, active monthly plan of the active seasonal version");
  }

  const planLines = (await prisma.planLine.findMany({
    where: { planDealer: { seasonPlanId: mp.seasonPlanId } },
    select: { id: true, productId: true, product: { select: { name: true } }, planDealer: { select: { dealerId: true, dealer: { select: { name: true } } } } },
  })) as { id: string; productId: string; product: { name: string }; planDealer: { dealerId: string; dealer: { name: string } } }[];
  const lineMeta = new Map(planLines.map((l) => [l.id, l] as const));
  const month = (await prisma.seasonMonth.findUnique({ where: { id: mp.seasonMonthId }, select: { name: true } })) as { name: string } | null;

  const audits: ReturnType<typeof auditData>[] = [];
  const writes: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];

  for (const e of entries) {
    const meta0 = lineMeta.get(e.planLineId);
    if (!meta0) continue;
    const where = { planLineId_seasonMonthId: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId } };
    const existing = (await prisma.monthlyEntry.findUnique({ where, select: { planQty: true, planValue: true } })) as { planQty: number; planValue: unknown } | null;
    const meta = { planType: "MONTHLY" as const, planId: mp.id, version: sp.version, seasonId: sp.seasonId, seasonMonthId: e.seasonMonthId, dealerId: meta0.planDealer.dealerId, dealerName: meta0.planDealer.dealer.name, productId: meta0.productId, productName: meta0.product.name, adminId: ctx.userId, reason };
    const mode = e.mode;

    if (mode === "AMOUNT" || mode === "NBV") {
      const oldV = existing?.planValue != null ? Number((existing.planValue as { toString(): string }).toString()) : 0;
      const newV = e.planValue ?? oldV;
      if (!changed(oldV, newV)) continue;
      audits.push(auditData({ ...meta, fieldName: `This Month Plan${month ? ` (${month.name})` : ""}`, oldValue: oldV, newValue: newV }));
      writes.push((tx) => tx.monthlyEntry.upsert({ where, create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, inputMode: mode, planValue: newV }, update: { inputMode: mode, planValue: newV } }));
    } else {
      const oldQ = existing?.planQty ?? 0;
      const newQ = Math.max(0, Math.floor(e.planQty ?? oldQ));
      if (!changed(oldQ, newQ)) continue;
      audits.push(auditData({ ...meta, fieldName: `This Month Plan${month ? ` (${month.name})` : ""}`, oldValue: oldQ, newValue: newQ }));
      writes.push((tx) => tx.monthlyEntry.upsert({ where, create: { planLineId: e.planLineId, seasonMonthId: e.seasonMonthId, planQty: newQ }, update: { planQty: newQ } }));
    }
  }

  return persist(ctx, "monthlyPlan", monthlyPlanId, writes, audits);
}

/* -------------------------------- Recovery -------------------------------- */

export interface AdminRecoveryMonthEntry { dealerId: string; monthRecoveryPlan?: number; monthRunningRecovery?: number }
export interface AdminRecoveryWeekEntry { dealerId: string; weekRecoveryPlan?: number; weekRunningRecovery?: number }

async function loadRecoveryEligible(ctx: AuthContext, id: string) {
  assertSuperAdmin(ctx);
  const plan = (await prisma.recoveryPlan.findUnique({
    where: { id },
    select: { id: true, status: true, lifecycleState: true, seasonId: true, seasonMonthId: true },
  })) as { id: string; status: string; lifecycleState: string; seasonId: string; seasonMonthId: string } | null;
  if (!plan) throw new ApiError(404, "Recovery plan not found");
  if (!(plan.status === PlanStatus.APPROVED && plan.lifecycleState === "ACTIVE")) {
    throw new ApiError(409, "Admin Edit is only available on an approved, active recovery plan");
  }
  return plan;
}

export async function adminEditRecoveryMonth(ctx: AuthContext, id: string, entries: AdminRecoveryMonthEntry[], reasonRaw: unknown): Promise<AdminEditResult> {
  const reason = cleanReason(reasonRaw);
  const plan = await loadRecoveryEligible(ctx, id);
  const dealers = (await prisma.recoveryPlanDealer.findMany({
    where: { recoveryPlanId: id },
    select: { dealerId: true, monthRecoveryPlan: true, monthRunningRecovery: true, dealer: { select: { name: true } } },
  })) as { dealerId: string; monthRecoveryPlan: unknown; monthRunningRecovery: unknown; dealer: { name: string } }[];
  const cur = new Map(dealers.map((d) => [d.dealerId, d] as const));
  const numOf = (v: unknown) => (v != null ? Number((v as { toString(): string }).toString()) : 0);

  const audits: ReturnType<typeof auditData>[] = [];
  const writes: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];
  for (const e of entries) {
    const d = cur.get(e.dealerId);
    if (!d) continue;
    const meta = { planType: "RECOVERY" as const, planId: id, version: null, seasonId: plan.seasonId, seasonMonthId: plan.seasonMonthId, dealerId: e.dealerId, dealerName: d.dealer.name, productId: null, productName: null, adminId: ctx.userId, reason };
    const oldPlan = numOf(d.monthRecoveryPlan);
    const oldRun = numOf(d.monthRunningRecovery);
    const newPlan = e.monthRecoveryPlan ?? oldPlan;
    const newRun = e.monthRunningRecovery ?? oldRun;
    if (!changed(oldPlan, newPlan) && !changed(oldRun, newRun)) continue;
    if (changed(oldPlan, newPlan)) audits.push(auditData({ ...meta, fieldName: "Month Recovery Plan", oldValue: oldPlan, newValue: newPlan }));
    if (changed(oldRun, newRun)) audits.push(auditData({ ...meta, fieldName: "Month Running Recovery", oldValue: oldRun, newValue: newRun }));
    writes.push((tx) => tx.recoveryPlanDealer.update({ where: { recoveryPlanId_dealerId: { recoveryPlanId: id, dealerId: e.dealerId } }, data: { monthRecoveryPlan: newPlan, monthRunningRecovery: newRun } }));
  }
  return persist(ctx, "recoveryPlan", id, writes, audits);
}

export async function adminEditRecoveryWeek(ctx: AuthContext, id: string, weekNo: number, entries: AdminRecoveryWeekEntry[], reasonRaw: unknown): Promise<AdminEditResult> {
  const reason = cleanReason(reasonRaw);
  const plan = await loadRecoveryEligible(ctx, id);
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > 6) throw new ApiError(422, "Invalid week");
  const dealers = (await prisma.recoveryPlanDealer.findMany({
    where: { recoveryPlanId: id },
    select: { id: true, dealerId: true, dealer: { select: { name: true } }, weekPlans: { where: { weekNo }, select: { weekRecoveryPlan: true, weekRunningRecovery: true } } },
  })) as { id: string; dealerId: string; dealer: { name: string }; weekPlans: { weekRecoveryPlan: unknown; weekRunningRecovery: unknown }[] }[];
  const cur = new Map(dealers.map((d) => [d.dealerId, d] as const));
  const numOf = (v: unknown) => (v != null ? Number((v as { toString(): string }).toString()) : 0);

  const audits: ReturnType<typeof auditData>[] = [];
  const writes: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];
  for (const e of entries) {
    const d = cur.get(e.dealerId);
    if (!d) continue;
    const wk = d.weekPlans[0];
    const meta = { planType: "RECOVERY" as const, planId: id, version: null, seasonId: plan.seasonId, seasonMonthId: plan.seasonMonthId, dealerId: e.dealerId, dealerName: d.dealer.name, productId: null, productName: null, adminId: ctx.userId, reason };
    const oldPlan = numOf(wk?.weekRecoveryPlan);
    const oldRun = numOf(wk?.weekRunningRecovery);
    const newPlan = e.weekRecoveryPlan ?? oldPlan;
    const newRun = e.weekRunningRecovery ?? oldRun;
    if (!changed(oldPlan, newPlan) && !changed(oldRun, newRun)) continue;
    if (changed(oldPlan, newPlan)) audits.push(auditData({ ...meta, fieldName: `Week ${weekNo} Recovery Plan`, oldValue: oldPlan, newValue: newPlan }));
    if (changed(oldRun, newRun)) audits.push(auditData({ ...meta, fieldName: `Week ${weekNo} Running Recovery`, oldValue: oldRun, newValue: newRun }));
    writes.push((tx) =>
      tx.recoveryWeekPlan.upsert({
        where: { recoveryPlanDealerId_weekNo: { recoveryPlanDealerId: d.id, weekNo } },
        create: { recoveryPlanDealerId: d.id, weekNo, weekRecoveryPlan: newPlan, weekRunningRecovery: newRun },
        update: { weekRecoveryPlan: newPlan, weekRunningRecovery: newRun },
      }),
    );
  }
  return persist(ctx, "recoveryPlan", id, writes, audits);
}

/* -------------------------------- Persist --------------------------------- */

/** Apply the input writes, touch lastSavedAt, and record the field-level audit — all atomically. */
async function persist(
  _ctx: AuthContext,
  planModel: "seasonPlan" | "monthlyPlan" | "recoveryPlan",
  planId: string,
  writes: ((tx: Prisma.TransactionClient) => Promise<unknown>)[],
  audits: ReturnType<typeof auditData>[],
): Promise<AdminEditResult> {
  if (audits.length === 0) return { changedFields: 0 };
  await prisma.$transaction(
    async (tx) => {
      for (const w of writes) await w(tx);
      await tx.adminEditAudit.createMany({ data: audits });
      // The model accessor differs per plan; touch lastSavedAt so completion/read caches refresh.
      const model = tx[planModel] as { update: (a: { where: { id: string }; data: { lastSavedAt: Date } }) => Promise<unknown> };
      await model.update({ where: { id: planId }, data: { lastSavedAt: new Date() } });
    },
    { timeout: 60000, maxWait: 10000 },
  );
  return { changedFields: audits.length };
}
