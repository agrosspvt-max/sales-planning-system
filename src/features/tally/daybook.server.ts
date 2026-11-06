import "server-only";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { cents, decimal, indiaDay } from "./billwise";
import { creditTotals, validateDaybookCapture, type DaybookCredit } from "./daybook-preview";
import { resolveDaybookCapture } from "./daybook-preview.server";
import { hashSales, salesPeriod } from "./sales";
import { approvedTestPreview } from "./sales-rollout";
import { assertSuper, authenticateConnector, lockConnector } from "./service.server";

const REFRESH_INTERVAL = 15 * 60 * 1000;
const LEASE_DURATION = 10 * 60 * 1000;
type Tx = Prisma.TransactionClient;
type Capture = ReturnType<typeof validateDaybookCapture>;

export function assertDaybookEnabled() {
  if (!approvedTestPreview())
    throw new ApiError(404, "Daybook sync is available on the approved test Preview.");
}

function checkedPeriod(month: string, today = indiaDay()) {
  try {
    return salesPeriod(month, today);
  } catch {
    throw new ApiError(
      422,
      "Choose a current or earlier month from April 2026 through March 2027.",
    );
  }
}

function lockMonth(db: Tx, month: string) {
  return db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"tally-daybook:" + month}))`;
}

export async function assertManualDaybookMonthAvailable(db: Tx, seasonMonthId: string) {
  if (!approvedTestPreview()) return;
  const month = await db.seasonMonth.findUnique({
    where: { id: seasonMonthId },
    select: { calendarYear: true, calendarMonth: true },
  });
  if (!month?.calendarYear || !month.calendarMonth) return;
  const key = `${month.calendarYear}-${String(month.calendarMonth).padStart(2, "0")}`;
  await lockMonth(db, key);
  const owned = await db.tallyDaybookDealerMonth.findFirst({
    where: { monthKey: key, recoveryPlanId: { not: null } },
    select: { dealerId: true },
  });
  if (owned)
    throw new ApiError(409, "Tally Daybook manages this month. Refresh it from Tally Connection.");
}

export async function daybookStatus(ctx: AuthContext, month: string) {
  assertDaybookEnabled();
  assertSuper(ctx);
  const period = checkedPeriod(month);
  const connection = await prisma.tallyConnection.findFirst({
    where: { enabled: true },
    select: { id: true },
  });
  const where = { connectionId: connection?.id, monthKey: period.monthKey };
  const [job, published] = connection
    ? await Promise.all([
        prisma.tallyDaybookJob.findFirst({
          where,
          orderBy: { createdAt: "desc" },
          select: {
            status: true,
            completedAt: true,
            leaseExpiresAt: true,
            summary: true,
            error: true,
          },
        }),
        prisma.tallyDaybookJob.findFirst({
          where: { ...where, status: "SUCCEEDED" },
          orderBy: { completedAt: "desc" },
          select: { completedAt: true, throughDate: true, summary: true },
        }),
      ])
    : [null, null];
  const expired =
    job?.status === "RUNNING" && job.leaseExpiresAt && job.leaseExpiresAt <= new Date();
  return {
    configured: Boolean(connection),
    job: expired ? { ...job, status: "FAILED", error: "LEASE_EXPIRED" } : job,
    published,
  };
}

export async function requestDaybookRefresh(ctx: AuthContext, month: string) {
  assertDaybookEnabled();
  assertSuper(ctx);
  const period = checkedPeriod(month);
  return prisma.$transaction(
    async (db) => {
      const connection = await db.tallyConnection.findFirst({
        where: { enabled: true },
        select: { id: true },
      });
      if (!connection) throw new ApiError(409, "Configure the office connector first.");
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${connection.id}))`;
      await db.tallyDaybookJob.updateMany({
        where: {
          connectionId: connection.id,
          status: "RUNNING",
          leaseExpiresAt: { lte: new Date() },
        },
        data: { status: "FAILED", error: "LEASE_EXPIRED", completedAt: new Date() },
      });
      const existing = await db.tallyDaybookJob.findFirst({
        where: {
          connectionId: connection.id,
          monthKey: period.monthKey,
          status: { in: ["QUEUED", "RUNNING"] },
        },
      });
      if (!existing)
        await db.tallyDaybookJob.create({ data: { connectionId: connection.id, ...period } });
      return { queued: true };
    },
    { timeout: 15000 },
  );
}

export function dailyReceipts(credits: readonly DaybookCredit[]) {
  const days = new Map<string, bigint>();
  for (const row of credits) {
    if (row.category === "receipt")
      days.set(row.date, (days.get(row.date) ?? 0n) + cents(row.creditAmount));
  }
  return Object.fromEntries(
    [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, amount]) => [day, decimal(amount)]),
  );
}

export async function publishDaybook(db: Tx, capture: Capture) {
  await lockMonth(db, capture.month);
  const scope = await resolveDaybookCapture(db, capture);
  const prior = await db.tallyDaybookDealerMonth.findMany({ where: { monthKey: capture.month } });
  const priorById = new Map(prior.map((row) => [row.dealerId, row]));
  const holds = new Set(scope.unmatched.flatMap((row) => row.candidateIds));
  const heldPrevious: string[] = [];
  for (const row of prior) {
    // A former ledger that no longer resolves could still contain this dealer's payments.
    if (row.ledgerNames.some((name) => !scope.uniqueDealer(name))) holds.add(row.dealerId);
  }
  const recoveryRows: Prisma.Sql[] = [];
  const coverageRows: Prisma.Sql[] = [];
  const recoveryIssues: { dealerName: string; issue: string }[] = [];
  let changedRows = 0;
  let matchedDealers = 0;
  for (const dealerId of new Set([...scope.matches.keys(), ...priorById.keys()])) {
    const match = scope.matches.get(dealerId);
    const previous = priorById.get(dealerId);
    if (holds.has(dealerId)) {
      if (previous) heldPrevious.push(...previous.ledgerNames);
      continue;
    }
    const ledgerNames = [
      ...new Set([
        ...(match?.ledgers ?? []),
        ...(previous?.ledgerNames.filter((name) => scope.uniqueDealer(name)?.id === dealerId) ??
          []),
      ]),
    ].sort();
    const credits = match?.credits ?? [];
    const totals = creditTotals(credits);
    const days = dailyReceipts(credits);
    const { plan, saved, issue } = scope.recoveryFor(dealerId);
    const recoveryPlanId = plan?.id ?? previous?.recoveryPlanId ?? null;
    coverageRows.push(Prisma.sql`(${capture.month}, ${dealerId}, ${capture.throughDate},
      ARRAY[${Prisma.join(ledgerNames.length ? ledgerNames : [null])}]::text[],
      ${JSON.stringify(days)}::jsonb, ${recoveryPlanId})`);
    if (match) matchedDealers++;
    if (!plan) {
      if (match) recoveryIssues.push({ dealerName: match.dealerName, issue });
      continue;
    }
    if (
      saved &&
      saved.liveRecovery.toFixed(2) === totals.liveRecovery &&
      saved.srCr.toFixed(2) === totals.srCr
    )
      continue;
    if (!saved && !credits.length) continue;
    recoveryRows.push(Prisma.sql`(${randomUUID()}, ${plan.id}, ${dealerId},
      ${totals.liveRecovery}::decimal, ${totals.srCr}::decimal)`);
  }
  for (let i = 0; i < coverageRows.length; i += 250) {
    await db.$executeRaw`
      INSERT INTO "TallyDaybookDealerMonth" ("monthKey", "dealerId", "throughDate", "ledgerNames", "receiptDays", "recoveryPlanId")
      SELECT m, d, t, array_remove(l, NULL), r, p FROM (VALUES ${Prisma.join(coverageRows.slice(i, i + 250))}) AS src(m,d,t,l,r,p)
      ON CONFLICT ("monthKey", "dealerId") DO UPDATE SET
        "throughDate" = EXCLUDED."throughDate", "ledgerNames" = EXCLUDED."ledgerNames",
        "receiptDays" = EXCLUDED."receiptDays", "recoveryPlanId" = EXCLUDED."recoveryPlanId"
      WHERE ("TallyDaybookDealerMonth"."throughDate", "TallyDaybookDealerMonth"."ledgerNames",
             "TallyDaybookDealerMonth"."receiptDays", "TallyDaybookDealerMonth"."recoveryPlanId")
        IS DISTINCT FROM (EXCLUDED."throughDate", EXCLUDED."ledgerNames", EXCLUDED."receiptDays", EXCLUDED."recoveryPlanId")`;
  }
  for (let i = 0; i < recoveryRows.length; i += 250) {
    changedRows += await db.$executeRaw`
      INSERT INTO "RecoveryPlanDealer" ("id", "recoveryPlanId", "dealerId", "liveRecovery", "srCr")
      VALUES ${Prisma.join(recoveryRows.slice(i, i + 250))}
      ON CONFLICT ("recoveryPlanId", "dealerId") DO UPDATE
      SET "liveRecovery" = EXCLUDED."liveRecovery", "srCr" = EXCLUDED."srCr"
      WHERE ("RecoveryPlanDealer"."liveRecovery", "RecoveryPlanDealer"."srCr")
        IS DISTINCT FROM (EXCLUDED."liveRecovery", EXCLUDED."srCr")`;
  }
  return {
    ...creditTotals(capture.credits),
    changedRows,
    matchedDealers,
    unmatched: scope.unmatched.map(({ candidateIds: _ids, ...row }) => row),
    excludedAccounts: scope.excludedAccounts,
    recoveryIssues,
    heldPrevious: [...new Set(heldPrevious)],
  };
}

const identity = {
  jobId: z.string().uuid(),
  leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};
const agentInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("complete"), ...identity, capture: z.unknown() }).strict(),
  z
    .object({ action: z.literal("fail"), ...identity, code: z.string().regex(/^[A-Z_]{1,80}$/) })
    .strict(),
]);

export async function daybookAgent(req: Request, raw: unknown) {
  assertDaybookEnabled();
  const input = agentInput.parse(raw);
  const auth = await authenticateConnector(req);
  return prisma.$transaction(
    async (db) => {
      const connection = await lockConnector(db, auth.agentId, auth.presented);
      const connectionId = connection.id;
      const now = new Date();
      const today = indiaDay(now);
      if (input.action === "claim") {
        await db.tallyDaybookJob.updateMany({
          where: { connectionId, status: "RUNNING", leaseExpiresAt: { lte: now } },
          data: { status: "FAILED", error: "LEASE_EXPIRED", completedAt: now },
        });
        let job = await db.tallyDaybookJob.findUnique({
          where: { connectionId_claimRequestId: { connectionId, claimRequestId: input.requestId } },
        });
        if (job && job.status !== "RUNNING") return { job: null };
        if (!job) {
          if (await db.tallyDaybookJob.findFirst({ where: { connectionId, status: "RUNNING" } }))
            return { job: null };
          const month = today.slice(0, 7);
          const current = await db.tallyDaybookJob.findFirst({
            where: { connectionId, monthKey: month },
            orderBy: { createdAt: "desc" },
          });
          if (
            month >= "2026-04" &&
            month <= "2027-03" &&
            current?.status !== "QUEUED" &&
            (!current || +now - +(current.startedAt ?? current.createdAt) >= REFRESH_INTERVAL)
          ) {
            job = await db.tallyDaybookJob.create({
              data: { connectionId, ...salesPeriod(month, today) },
            });
          } else {
            job = await db.tallyDaybookJob.findFirst({
              where: { connectionId, status: "QUEUED" },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            });
          }
          if (!job) return { job: null };
        }
        const leaseToken = randomBytes(32).toString("base64url");
        if (job.status === "QUEUED") {
          job = await db.tallyDaybookJob.update({
            where: { id: job.id },
            data: {
              ...salesPeriod(job.monthKey, today),
              status: "RUNNING",
              startedAt: now,
              claimRequestId: input.requestId,
              leaseHash: hashSales(leaseToken),
              leaseExpiresAt: new Date(+now + LEASE_DURATION),
            },
          });
        } else {
          await db.tallyDaybookJob.update({
            where: { id: job.id },
            data: { leaseHash: hashSales(leaseToken) },
          });
        }
        return {
          job: {
            id: job.id,
            leaseToken,
            operation: "daybook.sync.v1",
            companyName: connection.companyName,
            anchorName: connection.anchorName,
            anchorGuid: connection.anchorGuid,
            monthKey: job.monthKey,
            fromDate: job.fromDate,
            throughDate: job.throughDate,
          },
        };
      }
      const job = await db.tallyDaybookJob.findUnique({ where: { id: input.jobId } });
      if (
        !job ||
        job.connectionId !== connectionId ||
        !job.leaseHash ||
        !timingSafeEqual(Buffer.from(job.leaseHash), Buffer.from(hashSales(input.leaseToken)))
      )
        throw new ApiError(409, "Daybook attempt is no longer active.");
      const resultHash =
        input.action === "complete" ? hashSales(JSON.stringify(input.capture ?? null)) : null;
      if (input.action === "complete" && job.resultHash === resultHash) {
        if (job.status === "SUCCEEDED") return { ok: true, duplicate: true };
        if (job.status === "FAILED") return { ok: true, rejected: true };
      }
      if (job.status !== "RUNNING" || !job.leaseExpiresAt || job.leaseExpiresAt <= now)
        throw new ApiError(409, "Daybook lease expired.");
      const fail = async (error: string, summary?: Prisma.InputJsonValue) => {
        await db.tallyDaybookJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            error,
            resultHash,
            ...(summary ? { summary } : {}),
          },
        });
        return input.action === "complete" ? { ok: true, rejected: true } : { ok: true };
      };
      if (input.action === "fail") return fail(input.code);
      let capture: Capture;
      try {
        capture = validateDaybookCapture(input.capture, connection, today);
        const observed = Date.parse(capture.observedAt);
        if (
          !capture.completeMonth ||
          capture.month !== job.monthKey ||
          capture.throughDate !== job.throughDate ||
          !job.startedAt ||
          observed < +job.startedAt - 120000 ||
          observed > +now + 120000
        ) {
          return fail("DAYBOOK_SCOPE_CHANGED");
        }
      } catch {
        return fail("DAYBOOK_CAPTURE_REJECTED");
      }
      if (capture.review.length)
        return fail("DAYBOOK_VOUCHERS_NEED_REVIEW", { review: capture.review });
      const summary = await publishDaybook(db, capture);
      await db.tallyDaybookJob.update({
        where: { id: job.id },
        data: { status: "SUCCEEDED", resultHash, summary, completedAt: new Date() },
      });
      return { ok: true };
    },
    { timeout: 45000, maxWait: 10000 },
  );
}
