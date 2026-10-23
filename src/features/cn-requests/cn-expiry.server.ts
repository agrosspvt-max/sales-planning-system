import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { labeledError } from "@/features/labels/labeled-error";
import { writeAudit } from "@/lib/audit";
import { getOfficerScope } from "@/lib/scope";
import { assertAdminPermission, isAdministrativeRole } from "@/features/accounts/permissions";
import { getResolvedLabels } from "@/features/labels/service.server";
import { cnRequestBusinessDateKey } from "@/lib/cn-request";
import {
  addCnDays, parseCnGraceDays, cnExpiryDateProblem, dueCnTransitions, isCnPolicyStage, type CnPolicyStage,
} from "@/lib/cn-expiry";

/**
 * SERVER SIDE OF THE CN EXPIRY POLICY (rules live in @/lib/cn-expiry). Stage changes are applied lazily but ALWAYS before they can matter: every list read, every
 * payment / verification / scheduling mutation and the scheduled sweep call `reconcile…` first, under the CN's row lock, so the history is durable (CnExpiryEvent,
 * unique per cycle + kind → idempotent) and carries the real boundary as effectiveAt even if nobody opened the CN for weeks.
 */
type Db = Prisma.TransactionClient;
const AWAITING_SQL = Prisma.sql`(c."paymentTrackingMode" = 'PAYMENT_V1' AND COALESCE(c."paymentOutstandingAmount", 0) > 0)`;

/** Sweep / read-time reconcile of ONE CN, inside the caller's transaction. Returns the stage after every due transition (null = not governed). */
export async function reconcileCnExpiryTx(tx: Db, id: string, now: Date = new Date()): Promise<CnPolicyStage | null> {
  const [r] = await tx.$queryRaw<Array<{ cnPolicyStage: string | null; cnExpiryDate: string | null; cnGraceDays: number | null; cnPolicyCycle: number; awaiting: boolean }>>(Prisma.sql`
    SELECT c."cnPolicyStage", c."cnExpiryDate"::text AS "cnExpiryDate", c."cnGraceDays", c."cnPolicyCycle", ${AWAITING_SQL} AS "awaiting"
    FROM "CnRequest" c WHERE c."id" = ${id} FOR UPDATE OF c`);
  if (!r) throw labeledError(404, "cn_requests.error.not_found");
  if (!isCnPolicyStage(r.cnPolicyStage)) return null;
  let stage: CnPolicyStage = r.cnPolicyStage;
  const due = dueCnTransitions(r, r.awaiting, now);
  if (due.length === 0) return stage;
  // A first cycle with no recorded settings event is a migrated record: say so instead of implying someone chose it.
  const recorded = await tx.cnExpiryEvent.count({ where: { cnRequestId: id, cycleNo: r.cnPolicyCycle, kind: { in: ["POLICY_SET", "REOPENED", "RETURNED"] } } });
  const note = recorded === 0 ? "Deadline derived from the legacy CN expiry days" : null;
  for (const t of due) {
    const next: CnPolicyStage = t.kind === "EXPIRED" ? "EXPIRED" : "GRACE";
    await tx.cnExpiryEvent.createMany({ data: [{ cnRequestId: id, cycleNo: r.cnPolicyCycle, kind: t.kind, expiryIncludesGrace: true, effectiveAt: t.effectiveAt, expiryDate: r.cnExpiryDate ? new Date(`${r.cnExpiryDate}T00:00:00.000Z`) : null, graceDays: r.cnGraceDays, note }], skipDuplicates: true });
    await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest" SET "cnPolicyStage" = ${next}, "updatedAt" = NOW() WHERE "id" = ${id} AND "cnPolicyStage" = ${stage}`);
    stage = next;
  }
  return stage;
}

/** Reconcile one CN in its own transaction (read paths). */
export async function reconcileCnExpiry(id: string, now: Date = new Date()): Promise<CnPolicyStage | null> {
  return prisma.$transaction((tx) => reconcileCnExpiryTx(tx, id, now), { timeout: 15_000 });
}

async function dueCnIds(db: Pick<Db, "$queryRaw">, officerIds: readonly string[] | null, now: Date, limit: number): Promise<string[]> {
  const today = cnRequestBusinessDateKey(now);
  if (!today || (officerIds && officerIds.length === 0)) return [];
  const scope = officerIds ? Prisma.sql`AND c."officerId" IN (${Prisma.join([...officerIds])})` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT c."id" FROM "CnRequest" c
    WHERE c."cnExpiryDate" IS NOT NULL AND ${AWAITING_SQL} ${scope}
      AND ((c."cnPolicyStage" = 'WORKING' AND c."cnExpiryDate" < ${today}::date)
        OR (c."cnPolicyStage" = 'GRACE' AND c."cnExpiryDate" < ${today}::date))
    ORDER BY c."cnExpiryDate" LIMIT ${limit}`);
  return rows.map((r) => r.id);
}

/**
 * Apply every transition that is due, for the given officers (null = everyone) — called before listings and by the scheduled sweep. Only CNs that can possibly be due
 * are touched, one short transaction each, so a failure on one CN never blocks the others.
 */
export async function reconcileDueCnRequests(officerIds: readonly string[] | null, now: Date = new Date(), limit = 200): Promise<number> {
  let done = 0;
  for (const id of await dueCnIds(prisma, officerIds, now, limit)) {
    try { await reconcileCnExpiry(id, now); done++; } catch (error) { console.error("CN expiry reconcile failed", id, error); }
  }
  return done;
}
/** Same, inside a caller's transaction (Daily Work materialization): the persisted stage is then authoritative for the rest of that transaction. */
export async function reconcileDueCnRequestsTx(tx: Db, officerIds: readonly string[], now: Date = new Date(), limit = 200): Promise<number> {
  const ids = await dueCnIds(tx, officerIds, now, limit);
  for (const id of ids) await reconcileCnExpiryTx(tx, id, now);
  return ids.length;
}

/** In a mutation's transaction: reconcile, then refuse when the CN is Expired (the single server-side gate for every CN mutation). */
export async function assertCnNotExpiredTx(tx: Db, id: string, now: Date = new Date()): Promise<CnPolicyStage | null> {
  const stage = await reconcileCnExpiryTx(tx, id, now);
  if (stage === "EXPIRED") throw new ApiError(409, (await getResolvedLabels())["cn_requests.error.cn_expired"]);
  return stage;
}

/** Expired as of `now` (persisted or due), WITHOUT writing — for read-only gates such as confirming a task. */
export async function isCnExpiredNow(db: Pick<Db, "$queryRaw">, id: string, now: Date = new Date()): Promise<boolean> {
  const [r] = await db.$queryRaw<Array<{ cnPolicyStage: string | null; cnExpiryDate: string | null; cnGraceDays: number | null; awaiting: boolean }>>(Prisma.sql`
    SELECT c."cnPolicyStage", c."cnExpiryDate"::text AS "cnExpiryDate", c."cnGraceDays", ${AWAITING_SQL} AS "awaiting" FROM "CnRequest" c WHERE c."id" = ${id}`);
  if (!r || !isCnPolicyStage(r.cnPolicyStage)) return false;
  if (r.cnPolicyStage === "EXPIRED") return true;
  return dueCnTransitions(r, r.awaiting, now).some((t) => t.kind === "EXPIRED");
}

/** Records the chosen expiry at Working Shared acceptance (cycle 1), with no initial grace. */
export async function recordCnPolicySetTx(tx: Db, ctx: AuthContext, id: string, p: { expiryDate: string; graceDays: number; at: Date }): Promise<void> {
  await tx.cnExpiryEvent.createMany({ data: [{ cnRequestId: id, cycleNo: 1, kind: "POLICY_SET", expiryIncludesGrace: true, effectiveAt: p.at, actorId: ctx.userId, actorDesignation: ctx.designation ?? null, expiryDate: new Date(`${p.expiryDate}T00:00:00.000Z`), graceDays: p.graceDays }], skipDuplicates: true });
}

/** A CN returned from the ledger starts a NEW cycle with an Admin-chosen expiry; the a fresh cycle starts without grace. */
export async function startReturnedCycleTx(tx: Db, ctx: AuthContext, id: string, expiryDate: string, at: Date): Promise<void> {
  const [r] = await tx.$queryRaw<Array<{ cnPolicyCycle: number; cnGraceDays: number | null; cnExpiryDate: string | null }>>(Prisma.sql`SELECT c."cnPolicyCycle", c."cnGraceDays", c."cnExpiryDate"::text AS "cnExpiryDate" FROM "CnRequest" c WHERE c."id" = ${id}`);
  const cycle = (r?.cnPolicyCycle ?? 0) + 1, grace = 0;
  await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest" SET "cnPolicyStage" = 'WORKING', "cnPolicyCycle" = ${cycle}, "cnExpiryDate" = ${expiryDate}::date, "cnGraceDays" = ${grace}, "updatedAt" = NOW() WHERE "id" = ${id}`);
  await tx.cnExpiryEvent.create({ data: { cnRequestId: id, cycleNo: cycle, kind: "RETURNED", expiryIncludesGrace: true, effectiveAt: at, actorId: ctx.userId, actorDesignation: ctx.designation ?? null, expiryDate: new Date(`${expiryDate}T00:00:00.000Z`), previousExpiryDate: r?.cnExpiryDate ? new Date(`${r.cnExpiryDate}T00:00:00.000Z`) : null, graceDays: grace } });
}

/** Re-evaluate the same effective deadline when verification creates another follow-up. Never add automatic grace. */
export async function enterGraceNowTx(tx: Db, id: string, at: Date): Promise<void> {
  await reconcileCnExpiryTx(tx, id, at);
}

/** Explicit extension, serialized with payment/posting/reopening. A retry key prevents adding days twice. */
export async function grantCnGrace(ctx: AuthContext, id: string, raw: unknown): Promise<{ expiryDate: string; graceDays: number }> {
  const L = await getResolvedLabels();
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, L["cn_requests.error.reopen_admin_only"]);
  assertAdminPermission(ctx, "cnRequests", "approve");
  const input = z.object({ days: z.union([z.string(), z.number()]), requestKey: z.string().min(8).max(120), fromExpiry: z.string(), fromCycle: z.number().int().positive() }).safeParse(raw);
  if (!input.success) throw new ApiError(422, L["cn_requests.grace.invalid"]);
  const data = input.data, days = parseCnGraceDays(data.days);
  if (!days) throw new ApiError(422, L["cn_requests.grace.invalid"]);
  const owner = await prisma.cnRequest.findUnique({ where: { id }, select: { officerId: true } });
  if (!owner) throw new ApiError(404, L["cn_requests.error.not_found"]);
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(owner.officerId)) throw new ApiError(403, L["cn_requests.error.cannot_view"]);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CnRequest" WHERE "id" = ${id} FOR UPDATE`);
    const done = await tx.cnExpiryEvent.findUnique({ where: { requestKey: data.requestKey } });
    if (done) {
      if (done.cnRequestId !== id || done.actorId !== ctx.userId || done.graceDays !== days || done.cycleNo !== data.fromCycle || done.previousExpiryDate?.toISOString().slice(0,10) !== data.fromExpiry) throw new ApiError(409, L["cn_requests.grace.changed"]);
      return { expiryDate: done.expiryDate!.toISOString().slice(0,10), graceDays: days };
    }
    const stage = await assertCnNotExpiredTx(tx, id);
    const r = await tx.cnRequest.findUniqueOrThrow({ where: { id } });
    const expiry = r.cnExpiryDate?.toISOString().slice(0,10);
    if (!stage || !expiry || !["ACCEPTED_NOT_POSTED", "POSTED_IN_LEDGER"].includes(r.status) || (r.paymentStatus === "Paid" && r.paymentVerified) || Number(r.paymentOutstandingAmount) <= 0) throw new ApiError(409, L["cn_requests.grace.unavailable"]);
    if (expiry !== data.fromExpiry || r.cnPolicyCycle !== data.fromCycle) throw new ApiError(409, L["cn_requests.grace.changed"]);
    const next = addCnDays(expiry, days), total = (r.cnGraceDays ?? 0) + days;
    await tx.cnRequest.update({ where: { id }, data: { cnExpiryDate: new Date(`${next}T00:00:00Z`), cnGraceDays: total, cnPolicyStage: "GRACE" } });
    const sequence = await tx.cnExpiryEvent.count({ where: { cnRequestId: id, cycleNo: r.cnPolicyCycle, kind: "GRACE_GRANTED" } }) + 1;
    await tx.cnExpiryEvent.create({ data: { cnRequestId: id, cycleNo: r.cnPolicyCycle, kind: "GRACE_GRANTED", expiryIncludesGrace: true, sequence, requestKey: data.requestKey, effectiveAt: new Date(), actorId: ctx.userId, actorDesignation: ctx.designation ?? null, previousExpiryDate: r.cnExpiryDate, expiryDate: new Date(`${next}T00:00:00Z`), graceDays: days } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "cnRequest", entityId: id, summary: `CN grace +${days} days: expiry ${expiry} → ${next}` }, tx);
    return { expiryDate: next, graceDays: days };
  }, { timeout: 15000 });
}

/* ------------------------------------------------ Admin reopen ------------------------------------------------ */

export async function reopenCnRequest(ctx: AuthContext, id: string, raw: unknown): Promise<{ status: string; cycleNo: number; expiryDate: string }> {
  const L = await getResolvedLabels();
  if (!isAdministrativeRole(ctx.role)) throw new ApiError(403, L["cn_requests.error.reopen_admin_only"]);
  assertAdminPermission(ctx, "cnRequests", "approve");
  const parsed = z.object({
    expiryDate: z.string({ required_error: L["cn_requests.validation.expiry_required"] }),
    reason: z.string({ required_error: L["cn_requests.validation.reopen_reason_required"] }).trim().min(1, L["cn_requests.validation.reopen_reason_required"]).max(500),
    authorizedBy: z.string({ required_error: L["cn_requests.validation.reopen_authorizer_required"] }).trim().min(1, L["cn_requests.validation.reopen_authorizer_required"]).max(120),
    fromCycle: z.coerce.number().int().positive().optional(),
  }).safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.validation.reopen_invalid"]);
  const data = parsed.data, now = new Date(), today = cnRequestBusinessDateKey(now)!;
  const problem = cnExpiryDateProblem(data.expiryDate, today);
  if (problem) throw new ApiError(422, problem === "past" ? L["cn_requests.validation.expiry_past"] : L["cn_requests.validation.expiry_invalid"]);

  const owner = await prisma.cnRequest.findUnique({ where: { id }, select: { officerId: true } });
  if (!owner) throw new ApiError(404, L["cn_requests.error.not_found"]);
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(owner.officerId)) throw new ApiError(403, L["cn_requests.error.cannot_view"]);

  const result = await prisma.$transaction(async (tx) => {
    const stage = await reconcileCnExpiryTx(tx, id, now); // also takes the row lock: concurrent reopen / report / expiry serialize here
    const [r] = await tx.$queryRaw<Array<{ cnPolicyCycle: number; cnExpiryDate: string | null; cnGraceDays: number | null }>>(Prisma.sql`SELECT c."cnPolicyCycle", c."cnExpiryDate"::text AS "cnExpiryDate", c."cnGraceDays" FROM "CnRequest" c WHERE c."id" = ${id}`);
    if (stage !== "EXPIRED") {
      // A retry of a reopen that already committed returns that cycle instead of creating another one.
      if (data.fromCycle && r && r.cnPolicyCycle === data.fromCycle + 1) {
        const done = await tx.cnExpiryEvent.findUnique({ where: { cnRequestId_cycleNo_kind_sequence: { cnRequestId: id, cycleNo: r.cnPolicyCycle, kind: "REOPENED", sequence: 0 } } });
        if (done && done.reason === data.reason && done.authorizedBy === data.authorizedBy && done.expiryDate?.toISOString().slice(0, 10) === data.expiryDate) return { cycleNo: r.cnPolicyCycle, expiryDate: data.expiryDate, created: false };
      }
      throw new ApiError(409, L["cn_requests.error.reopen_not_expired"]);
    }
    if (!r || (data.fromCycle && data.fromCycle !== r.cnPolicyCycle)) throw new ApiError(409, L["cn_requests.error.reopen_changed"]);
    const cycle = r.cnPolicyCycle + 1, grace = 0;
    const moved = await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest" SET "cnPolicyStage" = 'WORKING', "cnPolicyCycle" = ${cycle}, "cnExpiryDate" = ${data.expiryDate}::date, "cnGraceDays" = ${grace}, "updatedAt" = NOW()
      WHERE "id" = ${id} AND "cnPolicyStage" = 'EXPIRED' AND "cnPolicyCycle" = ${r.cnPolicyCycle}`);
    if (Number(moved) !== 1) throw new ApiError(409, L["cn_requests.error.reopen_changed"]);
    await tx.cnExpiryEvent.create({ data: { cnRequestId: id, cycleNo: cycle, kind: "REOPENED", expiryIncludesGrace: true, effectiveAt: now, actorId: ctx.userId, actorDesignation: ctx.designation ?? null,
      expiryDate: new Date(`${data.expiryDate}T00:00:00.000Z`), previousExpiryDate: r.cnExpiryDate ? new Date(`${r.cnExpiryDate}T00:00:00.000Z`) : null, graceDays: grace, reason: data.reason, authorizedBy: data.authorizedBy } });
    await writeAudit({ userId: ctx.userId, actorDesignation: ctx.designation, action: "UPDATE", entity: "cnRequest", entityId: id, summary: `CN reopened (cycle ${cycle}); new expiry ${data.expiryDate}; grace ${grace} days; authorized by ${data.authorizedBy}; reason: ${data.reason}` }, tx);
    return { cycleNo: cycle, expiryDate: data.expiryDate, created: true };
  }, { timeout: 15_000 });
  return { status: "CN_WORKING_SHARED", cycleNo: result.cycleNo, expiryDate: result.expiryDate };
}
