import "server-only";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { ApiError, type AuthContext } from "@/lib/http";
import { outstandingChanges, savedOutstandingChanges, type OutstandingHistory } from "./changes";
import {
  digest,
  indiaDay,
  resolveAliases,
  scopeHash,
  scopeAliasSchema,
  validateResult,
  bucket,
  tight,
  cents,
  decimal,
} from "./billwise";

export function assertEnabled() {
  if (process.env.TALLY_SYNC_ENABLED !== "true")
    throw new ApiError(503, "Tally synchronization is not enabled");
  const norm = (s: string) => s.replace("-pooler.", ".").toLowerCase();
  const expected = process.env.TALLY_EXPECTED_DB_HOST;
  try {
    if (!expected || norm(new URL(process.env.DATABASE_URL ?? "").hostname) !== norm(expected))
      throw new Error();
  } catch {
    throw new ApiError(503, "Tally database endpoint has not been verified");
  }
}
const tokenHash = (s: string) => digest(s);
export function assertSuper(ctx: AuthContext) {
  if (ctx.role !== Role.SUPER_ADMIN)
    throw new ApiError(403, "Only the Super Admin can configure Tally");
}
const nonce = () => randomBytes(32).toString("base64url");
const MAX_BODY = 128 * 1024,
  MAX_PAYLOAD = 8 * 1024 * 1024;
export async function readBody(req: Request) {
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    throw new ApiError(415, "JSON required");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY)
    throw new ApiError(413, "Request too large");
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "Empty request");
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new ApiError(413, "Request too large");
      }
      buffers.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString("utf8"));
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
}
export function sameOrigin(req: Request) {
  if (req.headers.get("origin") !== new URL(req.url).origin)
    throw new ApiError(403, "Same-origin request required");
}
const payloadScope = z
  .object({ aliases: z.array(scopeAliasSchema).max(1000), planIds: z.array(z.string()).max(1000) })
  .strict();
type Tx = Prisma.TransactionClient;
async function currentScope(db: Tx, connectionId: string, asOf: string) {
  const [year, month] = asOf.split("-").map(Number);
  const plans = await db.recoveryPlan.findMany({
    where: {
      lifecycleState: "ACTIVE",
      seasonMonth: { calendarYear: year, calendarMonth: month },
      OR: [{ seasonPlanId: null }, { seasonPlan: { lifecycleState: "ACTIVE" } }],
    },
    select: {
      id: true,
      dealers: { where: { dealer: { isActive: true } }, select: { dealerId: true } },
    },
  });
  const dealerIds = new Set(plans.flatMap((p) => p.dealers.map((d) => d.dealerId)));
  const [rows, bindings] = await Promise.all([
    db.dealerAlias.findMany({ select: { tallyName: true, systemDealerId: true } }),
    db.tallyLedgerBinding.findMany({ where: { connectionId } }),
  ]);
  const aliases = resolveAliases(
    rows,
    dealerIds,
    new Map(bindings.map((b) => [b.aliasKey, b.guid])),
  );
  if (aliases.length > 1000 || plans.length > 1000)
    throw new ApiError(422, "Tally scope requires a larger reviewed batch size");
  return { aliases, planIds: plans.map((p) => p.id) };
}
export async function setup(ctx: AuthContext) {
  assertEnabled();
  assertSuper(ctx);
  const token = nonce();
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"tally-setup"}))`;
    const existing = await tx.tallyConnection.findUnique({
      where: { companyName: "Agromaxx Industry (2026-27)" },
    });
    if (existing?.enabled)
      throw new ApiError(409, "Disable the existing connection before replacing access");
    const row = await tx.tallyConnection.upsert({
      where: { companyName: "Agromaxx Industry (2026-27)" },
      update: {
        credentialHash: tokenHash(token),
        authorizedById: ctx.userId,
        enabled: true,
        lastAttemptAt: null,
        lastError: null,
      },
      create: {
        companyName: "Agromaxx Industry (2026-27)",
        anchorName: "NEW MAURYA BEEJ BHANDAR-SIKRIGANJ UP",
        anchorGuid: "cb293b57-f31b-464e-b2e1-42d4edb59b7d-00002385",
        credentialHash: tokenHash(token),
        authorizedById: ctx.userId,
      },
    });
    await writeAudit(
      {
        userId: ctx.userId,
        action: "CREATE",
        entity: "TallyConnection",
        entityId: row.id,
        summary: "Connector access issued; credential withheld from audit",
      },
      tx,
    );
    return row;
  });
  return { agentId: row.id, token, companyName: row.companyName };
}
export async function disable(ctx: AuthContext) {
  assertEnabled();
  assertSuper(ctx);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.tallyConnection.findMany({ where: { enabled: true } });
    for (const row of rows) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.id}))`;
      await tx.tallyConnection.update({
        where: { id: row.id },
        data: { enabled: false, credentialHash: tokenHash(nonce()) },
      });
      await tx.tallySyncJob.updateMany({
        where: { connectionId: row.id, status: "RUNNING" },
        data: { status: "FAILED", error: "CONNECTION_DISABLED" },
      });
      await writeAudit(
        {
          userId: ctx.userId,
          action: "DEACTIVATE",
          entity: "TallyConnection",
          entityId: row.id,
          summary: "Connector access revoked",
        },
        tx,
      );
    }
  });
  return { ok: true };
}
export async function status() {
  assertEnabled();
  const c = await prisma.tallyConnection.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      enabled: true,
      lastSeenAt: true,
      lastPublishedAt: true,
      lastError: true,
      refreshRequestedAt: true,
    },
  });
  if (!c) return { configured: false };
  const job = await prisma.tallySyncJob.findFirst({
    where: { connectionId: c.id },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      createdAt: true,
      completedAt: true,
      leaseExpiresAt: true,
      error: true,
      summary: true,
    },
  });
  return { configured: true, ...c, job };
}
export async function syncProgress(): Promise<import("./progress").SyncProgress> {
  try {
    assertEnabled();
  } catch {
    return { configured: false };
  }
  const c = await prisma.tallyConnection.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      enabled: true,
      lastSeenAt: true,
      lastPublishedAt: true,
      refreshRequestedAt: true,
      jobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          createdAt: true,
          completedAt: true,
          leaseExpiresAt: true,
          summary: true,
        },
      },
    },
  });
  if (!c) return { configured: false };
  const job = c.jobs[0];
  const summary = job?.summary as { held?: unknown[] } | null;
  return {
    configured: true,
    enabled: c.enabled,
    lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
    lastPublishedAt: c.lastPublishedAt?.toISOString() ?? null,
    refreshRequestedAt: c.refreshRequestedAt?.toISOString() ?? null,
    job: job
      ? {
          status: job.status,
          createdAt: job.createdAt.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
          leaseExpiresAt: job.leaseExpiresAt.toISOString(),
          heldCount: Array.isArray(summary?.held) ? summary.held.length : 0,
        }
      : null,
  };
}
export async function requestRefresh() {
  assertEnabled();
  const c = await prisma.tallyConnection.findFirst({ where: { enabled: true } });
  if (!c) throw new ApiError(409, "Configure the office connector first");
  // A refresh request queues work; the browser never reaches the Windows PC directly.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${c.id}))`;
    const current = await tx.tallyConnection.findUnique({ where: { id: c.id } });
    if (!current?.enabled) throw new ApiError(409, "Office connector is not enabled");
    const requestedAt = current.refreshRequestedAt ?? new Date();
    if (!current.refreshRequestedAt)
      await tx.tallyConnection.update({
        where: { id: c.id },
        data: { refreshRequestedAt: requestedAt },
      });
    return { queued: true, requestedAt: requestedAt.toISOString() };
  });
}
// Call only after the route has authorized access to this Recovery plan.
export async function outstandingHistory(planId: string): Promise<OutstandingHistory> {
  assertEnabled();
  const [latest, snapshots] = await Promise.all([
    prisma.agingSnapshot.findFirst({
      where: { recoveryPlanId: planId, source: "TALLY" },
      orderBy: { weekNo: "desc" },
      select: { summary: true, createdAt: true, sourceObservedAt: true },
    }),
    prisma.agingSnapshot.findMany({
      where: {
        recoveryPlanId: planId,
        source: "TALLY",
        summary: { contains: '"outstandingChanges":[{' },
      },
      orderBy: { weekNo: "desc" },
      take: 50,
      select: { id: true, summary: true, createdAt: true, sourceObservedAt: true },
    }),
  ]);
  const latestChanges = latest ? savedOutstandingChanges(latest.summary) : null;
  return {
    limit: 50,
    latestRefresh: latest
      ? {
          observedAt: latest.sourceObservedAt?.toISOString() ?? null,
          publishedAt: latest.createdAt.toISOString(),
          changedCount: latestChanges?.recorded ? latestChanges.changes.length : null,
        }
      : null,
    records: snapshots
      .flatMap((snapshot) =>
        savedOutstandingChanges(snapshot.summary).changes.map((row) => ({
          ...row,
          id: snapshot.id + ":" + row.dealerId,
          observedAt: snapshot.sourceObservedAt?.toISOString() ?? null,
          publishedAt: snapshot.createdAt.toISOString(),
        })),
      )
      .slice(0, 50),
  };
}
const identity = { jobId: z.string().uuid(), leaseToken: z.string().min(40).max(100) };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("heartbeat") }).strict(),
  z.object({ action: z.literal("claim") }).strict(),
  z
    .object({
      action: z.literal("begin"),
      ...identity,
      manifest: z
        .object({
          chunks: z.number().int().min(1).max(256),
          bytes: z.number().int().min(1).max(MAX_PAYLOAD),
          sha256: hash,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("chunk"),
      ...identity,
      sequence: z.number().int().min(0).max(255),
      hash,
      data: z.string().min(1).max(32768),
    })
    .strict(),
  z.object({ action: z.literal("complete"), ...identity }).strict(),
  z
    .object({ action: z.literal("fail"), ...identity, code: z.string().regex(/^[A-Z_]{1,80}$/) })
    .strict(),
]);
const manifestSchema = z
  .object({ chunks: z.number().int(), bytes: z.number().int(), sha256: hash })
  .strict();

export async function agent(req: Request, raw: unknown) {
  assertEnabled();
  const input = schema.parse(raw);
  const agentId = req.headers.get("x-agent-id") ?? "",
    bearer = req.headers.get("authorization") ?? "";
  if (!/^[a-f0-9-]{36}$/.test(agentId) || !/^Bearer [A-Za-z0-9_-]{40,100}$/.test(bearer))
    throw new ApiError(401, "Connector credential rejected");
  const presented = tokenHash(bearer.slice(7));
  // Commit the rate gate independently, so rejected uploads also consume the request budget.
  const gate = await prisma.$queryRaw<
    { requestCount: number }[]
  >`UPDATE "TallyConnection" SET "requestCount"=CASE WHEN "requestWindowAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '60 seconds' THEN "requestCount"+1 ELSE 1 END,"requestWindowAt"=CASE WHEN "requestWindowAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '60 seconds' THEN "requestWindowAt" ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') END WHERE "id"=${agentId} AND "enabled"=true AND "credentialHash"=${presented} RETURNING "requestCount"`;
  if (!gate.length) throw new ApiError(401, "Connector credential rejected");
  if (gate[0].requestCount > 300) throw new ApiError(429, "Connector request limit reached");
  const transact = () =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`;
        const c = await tx.tallyConnection.findUnique({ where: { id: agentId } });
        if (
          !c ||
          !c.enabled ||
          !timingSafeEqual(Buffer.from(c.credentialHash), Buffer.from(presented))
        )
          throw new ApiError(401, "Connector credential rejected");
        const owner = await tx.user.findUnique({
          where: { id: c.authorizedById },
          select: { role: true, isActive: true, deletedAt: true },
        });
        if (!owner || owner.role !== Role.SUPER_ADMIN || !owner.isActive || owner.deletedAt)
          throw new ApiError(403, "Connector authorization revoked");
        const now = new Date();
        await tx.tallyConnection.update({ where: { id: c.id }, data: { lastSeenAt: now } });
        if (input.action === "heartbeat") return { ok: true };
        if (input.action === "claim") {
          await tx.tallySyncJob.updateMany({
            where: { connectionId: c.id, status: "RUNNING", leaseExpiresAt: { lte: now } },
            data: { status: "FAILED", error: "LEASE_EXPIRED" },
          });
          await tx.tallySyncChunk.deleteMany({
            where: {
              job: {
                connectionId: c.id,
                status: "FAILED",
                createdAt: { lt: new Date(+now - 86400000) },
              },
            },
          });
          const running = await tx.tallySyncJob.findFirst({
            where: { connectionId: c.id, status: "RUNNING" },
          });
          if (running) return { job: null };
          const due =
            !c.lastAttemptAt ||
            +now - +c.lastAttemptAt >= 15 * 60000 ||
            (c.refreshRequestedAt && (!c.lastAttemptAt || c.refreshRequestedAt > c.lastAttemptAt));
          if (!due) return { job: null };
          const asOf = indiaDay(now),
            scope = await currentScope(tx, c.id, asOf);
          await tx.tallyConnection.update({
            where: { id: c.id },
            data: { lastAttemptAt: now, refreshRequestedAt: null },
          });
          if (!scope.aliases.length) {
            await tx.tallyConnection.update({
              where: { id: c.id },
              data: { lastError: "NO_CURRENT_PLAN_ALIASES" },
            });
            return { job: null };
          }
          if (Buffer.byteLength(JSON.stringify(scope.aliases)) > 110000)
            throw new ApiError(422, "Alias scope exceeds claim response limit");
          const lease = nonce();
          const job = await tx.tallySyncJob.create({
            data: {
              connectionId: c.id,
              asOf,
              scopeHash: scopeHash(scope.aliases, scope.planIds),
              scope,
              leaseHash: tokenHash(lease),
              leaseExpiresAt: new Date(+now + 20 * 60000),
            },
          });
          return {
            job: {
              id: job.id,
              leaseToken: lease,
              operation: "billwise.sync.v1",
              companyName: c.companyName,
              asOf,
              anchorName: c.anchorName,
              anchorGuid: c.anchorGuid,
              aliases: scope.aliases,
            },
          };
        }
        const job = await tx.tallySyncJob.findUnique({ where: { id: input.jobId } });
        if (
          !job ||
          job.connectionId !== c.id ||
          !timingSafeEqual(Buffer.from(job.leaseHash), Buffer.from(tokenHash(input.leaseToken)))
        )
          throw new ApiError(409, "Unknown or superseded sync attempt");
        // Replays of an already committed, checksum-pinned upload remain acknowledged.
        if (job.status === "COMPLETE") {
          const old = manifestSchema.parse(job.manifest);
          if (input.action === "complete") return { ok: true, duplicate: true };
          if (
            input.action === "begin" &&
            input.manifest.sha256 === old.sha256 &&
            input.manifest.bytes === old.bytes &&
            input.manifest.chunks === old.chunks
          )
            return { ok: true, duplicate: true };
          if (
            input.action === "chunk" &&
            input.sequence < old.chunks &&
            digest(input.data) === input.hash
          )
            return { ok: true, duplicate: true };
          throw new ApiError(409, "Conflicting replay");
        }
        if (job.status !== "RUNNING" || job.leaseExpiresAt <= now)
          throw new ApiError(409, "Sync attempt expired");
        if (input.action === "fail") {
          await tx.tallySyncJob.update({
            where: { id: job.id },
            data: { status: "FAILED", error: input.code },
          });
          await tx.tallyConnection.update({ where: { id: c.id }, data: { lastError: input.code } });
          return { ok: true };
        }
        if (input.action === "begin") {
          if (job.manifest) {
            const old = manifestSchema.parse(job.manifest);
            if (
              old.sha256 !== input.manifest.sha256 ||
              old.bytes !== input.manifest.bytes ||
              old.chunks !== input.manifest.chunks
            )
              throw new ApiError(409, "Conflicting manifest");
          }
          await tx.tallySyncJob.update({
            where: { id: job.id },
            data: { manifest: input.manifest },
          });
          return { ok: true };
        }
        if (!job.manifest) throw new ApiError(409, "Manifest required");
        const manifest = manifestSchema.parse(job.manifest);
        if (input.action === "chunk") {
          if (
            input.sequence >= manifest.chunks ||
            Buffer.byteLength(input.data) > 32768 ||
            digest(input.data) !== input.hash
          )
            throw new ApiError(422, "Invalid chunk");
          const old = await tx.tallySyncChunk.findUnique({
            where: { jobId_sequence: { jobId: job.id, sequence: input.sequence } },
          });
          if (old && (old.hash !== input.hash || old.data !== input.data))
            throw new ApiError(409, "Conflicting chunk");
          if (!old)
            await tx.tallySyncChunk.create({
              data: { jobId: job.id, sequence: input.sequence, hash: input.hash, data: input.data },
            });
          return { ok: true, ...(old ? { duplicate: true } : {}) };
        }
        const chunks = await tx.tallySyncChunk.findMany({
          where: { jobId: job.id },
          orderBy: { sequence: "asc" },
        });
        if (
          chunks.length !== manifest.chunks ||
          chunks.some((x, i) => x.sequence !== i || digest(x.data) !== x.hash)
        )
          throw new ApiError(422, "Incomplete upload");
        const body = chunks.map((x) => x.data).join("");
        if (Buffer.byteLength(body) !== manifest.bytes || digest(body) !== manifest.sha256)
          throw new ApiError(422, "Snapshot checksum mismatch");
        const scope = payloadScope.parse(job.scope),
          current = await currentScope(tx, c.id, job.asOf);
        if (scopeHash(current.aliases, current.planIds) !== job.scopeHash)
          throw new ApiError(
            409,
            "Dealer mapping or current plan scope changed; retry a fresh sync",
          );
        let verified: ReturnType<typeof validateResult>;
        try {
          verified = validateResult(
            JSON.parse(body),
            scope.aliases,
            c.companyName,
            c.anchorGuid,
            job.asOf,
            now,
          );
        } catch {
          throw new ApiError(422, "Bill data validation failed");
        }
        if (verified.report.anchor.name !== c.anchorName)
          throw new ApiError(422, "Wrong company anchor");
        const accepted = new Map(verified.accepted.map((x) => [x.alias.dealerId, x]));
        let updatedPlans = 0,
          updatedDealers = 0;
        for (const planId of scope.planIds) {
          const plan = await tx.recoveryPlan.findUnique({
            where: { id: planId },
            select: {
              id: true,
              dealers: {
                where: { dealer: { isActive: true } },
                select: { dealerId: true, outstanding: true },
              },
            },
          });
          if (!plan) continue;
          const rows = plan.dealers.flatMap((d) => {
            const v = accepted.get(d.dealerId);
            return v ? [v] : [];
          });
          if (!rows.length) continue;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"tally-plan:" + plan.id}))`;
          const max = await tx.agingSnapshot.aggregate({
            where: { recoveryPlanId: plan.id },
            _max: { weekNo: true },
          });
          const previous = new Map(
            plan.dealers.map((d) => [d.dealerId, cents(d.outstanding.toFixed(2))]),
          );
          const delta = rows.reduce(
            (sum, x) => sum + cents(x.amounts.outstanding) - (previous.get(x.alias.dealerId) ?? 0n),
            0n,
          );
          const changeSummary = {
            source: "TALLY",
            dealersRefreshed: rows.length,
            heldDealers: verified.held.length,
            zeroedUnavailableDealerIds: rows.filter((x) => !x.ledger).map((x) => x.alias.dealerId),
            outstandingIncreased: rows.filter(
              (x) => cents(x.amounts.outstanding) > (previous.get(x.alias.dealerId) ?? 0n),
            ).length,
            outstandingDecreased: rows.filter(
              (x) => cents(x.amounts.outstanding) < (previous.get(x.alias.dealerId) ?? 0n),
            ).length,
            newDealers: 0,
            removedDealers: plan.dealers.length - rows.length,
            outstandingDelta: Number(decimal(delta)),
            outstandingChanges: outstandingChanges(rows, previous),
          };
          const snapshot = await tx.agingSnapshot.create({
            data: {
              recoveryPlanId: plan.id,
              weekNo: (max._max.weekNo ?? -1) + 1,
              cutoffDate: new Date(job.asOf + "T12:00:00Z"),
              workbookName: "Tally bill-wise sync",
              uploadedById: c.authorizedById,
              source: "TALLY",
              sourceObservedAt: new Date(verified.report.observedAt),
              tallyJobId: job.id,
              summary: JSON.stringify(changeSummary),
            },
          });
          const aggregates = rows.map((x) => ({
            id: randomUUID(),
            snapshotId: snapshot.id,
            dealerId: x.alias.dealerId,
            ...x.amounts,
          }));
          await tx.agingSnapshotDealer.createMany({ data: aggregates });
          const billRows = rows.flatMap((x, i) =>
            x.bills.map((b) => ({
              snapshotId: snapshot.id,
              snapshotDealerId: aggregates[i].id,
              dealerId: x.alias.dealerId,
              billDate: new Date(b.billDate + "T12:00:00Z"),
              dueDate: new Date(b.dueDate + "T12:00:00Z"),
              refNo: b.reference,
              amount: b.pendingAmount,
              bucket: bucket(b.dueDate, job.asOf),
            })),
          );
          for (let i = 0; i < billRows.length; i += 1000)
            await tx.agingSnapshotBill.createMany({ data: billRows.slice(i, i + 1000) });
          const updates = JSON.stringify(
            rows.map((x) => ({ dealerId: x.alias.dealerId, ...x.amounts })),
          );
          // Only existing current-plan rows and these four read-only aging columns can change.
          await tx.$executeRaw`UPDATE "RecoveryPlanDealer" r SET "outstanding"=v.outstanding::numeric,"overdue"=v.overdue::numeric,"due"=v.due::numeric,"running"=v.running::numeric FROM jsonb_to_recordset(${updates}::jsonb) AS v("dealerId" text,outstanding text,overdue text,due text,running text) WHERE r."recoveryPlanId"=${plan.id} AND r."dealerId"=v."dealerId"`;
          updatedPlans++;
          updatedDealers += rows.length;
        }
        for (const x of verified.accepted) {
          if (!x.ledger) continue;
          await tx.tallyLedgerBinding.upsert({
            where: { connectionId_aliasKey: { connectionId: c.id, aliasKey: tight(x.alias.name) } },
            update: {},
            create: { connectionId: c.id, aliasKey: tight(x.alias.name), guid: x.ledger.guid },
          });
        }
        const summary = {
          updatedPlans,
          updatedDealers,
          matchedLedgers: verified.accepted.filter((x) => x.ledger).length,
          zeroedUnavailable: verified.zeroedUnavailable,
          creditAdvances: verified.creditAdvances,
          held: verified.held,
          asOf: job.asOf,
          observedAt: verified.report.observedAt,
          sourceSha256: verified.report.sourceSha256,
        };
        await tx.tallySyncJob.update({
          where: { id: job.id },
          data: { status: "COMPLETE", resultHash: manifest.sha256, summary, completedAt: now },
        });
        await tx.tallySyncChunk.deleteMany({ where: { jobId: job.id } });
        await tx.tallyConnection.update({
          where: { id: c.id },
          data: {
            lastPublishedAt: updatedPlans ? now : c.lastPublishedAt,
            lastError: verified.held.length ? "SOME_DEALERS_HELD_FOR_REVIEW" : null,
          },
        });
        await writeAudit(
          {
            userId: c.authorizedById,
            action: "UPDATE",
            entity: "TallySyncJob",
            entityId: job.id,
            summary: JSON.stringify({
              updatedPlans,
              updatedDealers,
              held: verified.held.length,
              asOf: job.asOf,
            }),
          },
          tx,
        );
        return { ok: true };
      },
      {
        timeout: 60000,
        maxWait: 10000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  for (let attempt = 0; ; attempt++) {
    try {
      return await transact();
    } catch (error) {
      if (
        attempt < 2 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      )
        continue;
      throw error;
    }
  }
}
