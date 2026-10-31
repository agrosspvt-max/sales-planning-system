import "server-only";
import { salesSyncEnabled } from "./sales-rollout";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { cleanProductName } from "@/features/sales-upload/parser";
import { buildProductResolver } from "@/lib/product-resolver";
import { terminalSurvivor } from "@/lib/product-merge";
import { indiaDay } from "./billwise";
import { assertEnabled, assertSuper, authenticateConnector, lockConnector } from "./service.server";
import { hashSales, salesPeriod, validateSales, type SalesResult } from "./sales";

import { salesMonths } from "./sales-range";

type Tx = Prisma.TransactionClient;
const D = Prisma.Decimal;
const token = () => randomBytes(32).toString("base64url");
const LIMIT = 8 * 1024 * 1024;
export function assertSalesEnabled() {
  assertEnabled();
  if (!salesSyncEnabled()) throw new ApiError(503, "Tally sales synchronization is not enabled");
}
async function scope(db: Tx, monthKey: string) {
  const months = await db.seasonMonth.findMany({
    where: { calendarYear: +monthKey.slice(0, 4), calendarMonth: +monthKey.slice(5, 7) },
    select: { id: true, seasonId: true },
  });
  const plans = await db.seasonPlan.findMany({
    where: {
      seasonId: { in: months.map((m) => m.seasonId) },
      status: "APPROVED",
      isActiveVersion: true,
      lifecycleState: "ACTIVE",
      planningType: "SEASONAL",
    },
    select: {
      id: true,
      seasonId: true,
      dealers: {
        where: { dealer: { isActive: true, status: "ACTIVE" } },
        select: {
          id: true,
          dealerId: true,
          dealer: { select: { name: true } },
          lines: { select: { id: true, productId: true } },
        },
      },
    },
  });
  const [aliases, products] = await Promise.all([
    db.dealerAlias.findMany({
      select: { tallyName: true, systemDealerId: true },
      orderBy: { tallyName: "asc" },
    }),
    db.product.findMany({
      where: { OR: [{ isActive: true }, { mergedIntoId: { not: null } }] },
      select: {
        id: true,
        name: true,
        canonicalName: true,
        mergedIntoId: true,
        isActive: true,
        rate: true,
        nbvPercent: true,
      },
      orderBy: { id: "asc" },
    }),
  ]);
  const dealers = plans
    .flatMap((p) =>
      p.dealers.map((d) => ({
        planDealerId: d.id,
        dealerId: d.dealerId,
        name: d.dealer.name,
        monthId: months.find((m) => m.seasonId === p.seasonId)!.id,
        lines: d.lines
          .map((l) => ({ id: l.id, productId: l.productId }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      })),
    )
    .sort((a, b) => a.planDealerId.localeCompare(b.planDealerId));
  const needed = new Set(dealers.map((d) => d.dealerId));
  // All aliases participate in collision detection, including dealers outside this month's plans.
  const candidates = new Map<string, Set<string>>();
  const add = (name: string, id: string) => {
    const set = candidates.get(name) ?? new Set<string>();
    set.add(id);
    candidates.set(name, set);
  };
  for (const a of aliases) add(a.tallyName.trim(), a.systemDealerId);
  for (const d of dealers)
    if (!aliases.some((a) => a.systemDealerId === d.dealerId)) add(d.name.trim(), d.dealerId);
  const names = [...candidates]
    .filter(([, ids]) => [...ids].some((id) => needed.has(id)))
    .map(([name, ids]) => ({ name, dealerIds: [...ids].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (names.length > 2000 || dealers.length > 2000)
    throw new ApiError(422, "Sales scope is too large");
  const fingerprint = hashSales(
    JSON.stringify({
      dealers,
      names,
      products: products.map((p) => ({
        ...p,
        rate: String(p.rate),
        nbvPercent: String(p.nbvPercent),
      })),
    }),
  );
  return { dealers, names, products, fingerprint };
}
type Scope = Awaited<ReturnType<typeof scope>>;
function productMap(s: Scope) {
  const resolver = buildProductResolver(s.products);
  return (name: string) => resolver.resolveProductUnique(cleanProductName(name))?.id ?? null;
}

export function projectSales(result: SalesResult, s: Scope) {
  const ledgerNames = new Set(result.ledgers.map((l) => l.name)),
    needed = new Set(s.dealers.map((d) => d.dealerId));
  const byName = new Map(s.names.map((n) => [n.name, n.dealerIds]));
  const held = new Map<
    string,
    { dealerId: string; name: string; reason: string; details: string[] }
  >();
  function hold(id: string, reason: string, detail: string) {
    if (!needed.has(id)) return;
    const h = held.get(id) ?? {
      dealerId: id,
      name: s.dealers.find((d) => d.dealerId === id)!.name,
      reason,
      details: [],
    };
    if (h.details.length < 50 && !h.details.includes(detail)) h.details.push(detail);
    held.set(id, h);
  }
  for (const n of s.names)
    for (const id of n.dealerIds) {
      if (n.dealerIds.length !== 1) hold(id, "ALIAS_AMBIGUOUS", n.name);
      else if (!ledgerNames.has(n.name)) hold(id, "LEDGER_NOT_VERIFIED", n.name);
    }
  const resolve = productMap(s),
    totals = new Map<
      string,
      Map<string, { qty: Prisma.Decimal; amount: Prisma.Decimal; units: Set<string> }>
    >();
  let unallocated = 0,
    unmappedVouchers = 0;
  for (const v of result.vouchers) {
    if (v.cancelled || v.optional) continue;
    if (!v.items.length && v.family === "Credit Note") unallocated++;
    const ids = byName.get(v.partyName);
    if (!ids || ids.length !== 1) {
      unmappedVouchers++;
      continue;
    }
    const id = ids[0];
    if (!needed.has(id)) continue;
    const rows = totals.get(id) ?? new Map();
    totals.set(id, rows);
    for (const line of v.items) {
      const productId = resolve(line.stockItemName);
      if (!productId) {
        hold(id, "PRODUCT_NOT_UNIQUELY_MAPPED", line.stockItemName);
        continue;
      }
      const row = rows.get(productId) ?? {
        qty: new D(0),
        amount: new D(0),
        units: new Set<string>(),
      };
      row.qty = row.qty.add(line.quantity);
      row.amount = row.amount.add(line.amount);
      if (line.unit && +line.quantity !== 0) row.units.add(line.unit.toLowerCase());
      rows.set(productId, row);
      if (row.units.size > 1)
        hold(id, "PRODUCT_UNIT_CONFLICT", line.stockItemName + ": " + [...row.units].join(", "));
      if (row.qty.abs().gte("1000000000000") || row.amount.abs().gte("10000000000"))
        hold(id, "PRODUCT_TOTAL_TOO_LARGE", line.stockItemName);
    }
  }
  return { held: [...held.values()], totals, unallocated, unmappedVouchers };
}
async function publish(
  db: Tx,
  c: { id: string; companyName: string; anchorGuid: string },
  job: {
    id: string;
    monthKey: string;
    fromDate: string;
    throughDate: string;
    createdAt: Date;
    manual: boolean;
    scopeHash: string | null;
  },
  result: SalesResult,
  s: Scope,
) {
  if (s.fingerprint !== job.scopeHash)
    throw new ApiError(409, "Sales mappings or plans changed; request a new refresh");
  if (!job.manual && (job.monthKey !== indiaDay().slice(0, 7) || job.throughDate !== indiaDay()))
    throw new ApiError(409, "Sales date changed; request a new refresh");
  const began = Date.now();
  const progress = (stage: string, rows: number) =>
    console.info(
      "tally_sales_publish",
      JSON.stringify({
        jobId: job.id,
        month: job.monthKey,
        stage,
        rows,
        elapsedMs: Date.now() - began,
      }),
    );
  const projection = projectSales(result, s),
    heldIds = new Set(projection.held.map((h) => h.dealerId));
  const writes: {
    planLineId: string;
    monthId: string;
    qty: Prisma.Decimal;
    amount: Prisma.Decimal;
  }[] = [];
  // Add all missing dealer/product lines in batches. One upsert per product held
  // the publication transaction open for hundreds of network round trips.
  const products = new Map(s.products.map((p) => [p.id, p]));
  const additions: Prisma.PlanLineCreateManyInput[] = [];
  for (const d of s.dealers) {
    if (heldIds.has(d.dealerId)) continue;
    const existing = new Set(d.lines.map((l) => l.productId));
    for (const [productId] of projection.totals.get(d.dealerId) ?? []) {
      if (existing.has(productId)) continue;
      const p = products.get(productId)!;
      additions.push({
        id: randomUUID(),
        planDealerId: d.planDealerId,
        productId,
        isAutoAdded: true,
        rateSnapshot: p.rate,
        nbvPercentSnapshot: p.nbvPercent,
      });
    }
  }
  if (additions.length) {
    for (let offset = 0; offset < additions.length; offset += 500)
      await db.planLine.createMany({
        data: additions.slice(offset, offset + 500),
        skipDuplicates: true,
      });
    const lines = await db.planLine.findMany({
      where: { planDealerId: { in: [...new Set(additions.map((l) => l.planDealerId))] } },
      select: { id: true, productId: true, planDealerId: true },
    });
    const byDealer = new Map<string, typeof lines>();
    for (const line of lines) {
      const bucket = byDealer.get(line.planDealerId) ?? [];
      bucket.push(line);
      byDealer.set(line.planDealerId, bucket);
    }
    for (const d of s.dealers)
      if (byDealer.has(d.planDealerId)) d.lines = byDealer.get(d.planDealerId)!;
  }
  progress("plan_lines_ready", additions.length);
  const merges = new Map(s.products.map((p) => [p.id, p.mergedIntoId]));
  for (const d of s.dealers) {
    if (heldIds.has(d.dealerId)) continue;
    const totals = projection.totals.get(d.dealerId) ?? new Map();
    // Merge source rows into their existing survivor line, and zero any old merged source actuals.
    for (const l of d.lines) {
      const t =
        terminalSurvivor(l.productId, merges) === l.productId ? totals.get(l.productId) : undefined;
      writes.push({
        planLineId: l.id,
        monthId: d.monthId,
        qty: t?.qty ?? new D(0),
        amount: t?.amount ?? new D(0),
      });
    }
  }
  let changedRows = 0;
  const changes: {
    dealer: string;
    product: string;
    beforeQty: string;
    quantity: string;
    beforeAmount: string;
    amount: string;
  }[] = [];
  const lineMeta = new Map(
    s.dealers.flatMap((d) =>
      d.lines.map(
        (l) =>
          [
            l.id,
            {
              dealer: d.name,
              product: products.get(l.productId)?.name ?? "Product",
            },
          ] as const,
      ),
    ),
  );
  const previous = await db.monthlyEntry.findMany({
    where: {
      planLineId: { in: writes.map((w) => w.planLineId) },
      seasonMonthId: { in: [...new Set(writes.map((w) => w.monthId))] },
    },
    select: { planLineId: true, seasonMonthId: true, saleQty: true, saleValue: true },
  });
  const old = new Map(previous.map((p) => [p.planLineId + ":" + p.seasonMonthId, p]));
  const changedWrites: typeof writes = [];
  for (const w of writes) {
    const p = old.get(w.planLineId + ":" + w.monthId);
    if (!new D(p?.saleQty ?? 0).eq(w.qty) || !new D(p?.saleValue ?? 0).eq(w.amount)) {
      changedRows++;
      changedWrites.push(w);
      if (changes.length < 100)
        changes.push({
          ...lineMeta.get(w.planLineId)!,
          beforeQty: new D(p?.saleQty ?? 0).toString(),
          quantity: w.qty.toString(),
          beforeAmount: new D(p?.saleValue ?? 0).toFixed(2),
          amount: w.amount.toFixed(2),
        });
    } else if (p?.saleValue === null) changedWrites.push(w);
  }
  progress("actuals_compared", changedWrites.length);
  for (let offset = 0; offset < changedWrites.length; offset += 250) {
    const batch = changedWrites.slice(offset, offset + 250);
    if (!batch.length) continue;
    await db.$executeRaw(
      Prisma.sql`INSERT INTO "MonthlyEntry" ("id","planLineId","seasonMonthId","planQty","saleQty","saleValue","createdAt","updatedAt") VALUES ${Prisma.join(batch.map((w) => Prisma.sql`(${randomUUID()},${w.planLineId},${w.monthId},0,${w.qty.toString()}::numeric,${w.amount.toString()}::numeric,NOW(),NOW())`))} ON CONFLICT ("planLineId","seasonMonthId") DO UPDATE SET "saleQty"=EXCLUDED."saleQty","saleValue"=EXCLUDED."saleValue","updatedAt"=NOW()`,
    );
  }
  progress("actuals_saved", changedWrites.length);
  const summary = {
    voucherCount: result.vouchers.length,
    productLines: result.vouchers.reduce((n, v) => n + v.items.length, 0),
    updatedRows: writes.length,
    changedRows,
    changes,
    held: projection.held,
    unallocatedCredits: projection.unallocated,
    unmappedVouchers: projection.unmappedVouchers,
    controlMarkerCount: result.controlMarkerCount,
  };
  const snap = await db.tallySalesSnapshot.upsert({
    where: { connectionId_monthKey: { connectionId: c.id, monthKey: job.monthKey } },
    create: {
      connectionId: c.id,
      monthKey: job.monthKey,
      fromDate: job.fromDate,
      throughDate: job.throughDate,
      observedAt: new Date(result.observedAt),
      sourceHash: result.sourceHash,
      jobId: job.id,
      summary,
    },
    update: {
      fromDate: job.fromDate,
      throughDate: job.throughDate,
      observedAt: new Date(result.observedAt),
      sourceHash: result.sourceHash,
      jobId: job.id,
      summary,
    },
  });
  await db.tallySalesVoucher.deleteMany({ where: { snapshotId: snap.id } });
  const vouchers = result.vouchers.map(({ items, ledgerEntries, ...v }) => ({
    id: randomUUID(),
    snapshotId: snap.id,
    ...v,
    ledgerEntries,
  }));
  for (let i = 0; i < vouchers.length; i += 250)
    await db.tallySalesVoucher.createMany({ data: vouchers.slice(i, i + 250) });
  const items = result.vouchers.flatMap((v, index) =>
    v.items.map((item) => ({ ...item, voucherId: vouchers[index].id })),
  );
  for (let i = 0; i < items.length; i += 500)
    await db.tallySalesItem.createMany({ data: items.slice(i, i + 500) });
  progress("bill_details_saved", items.length);
  return summary;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  identity = { jobId: z.string().uuid(), leaseToken: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/) };
const manifest = z
  .object({
    chunks: z.number().int().min(1).max(256),
    bytes: z.number().int().min(1).max(LIMIT),
    sha256: hash,
  })
  .strict();
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("heartbeat") }).strict(),
  z.object({ action: z.literal("begin"), ...identity, manifest }).strict(),
  z
    .object({
      action: z.literal("chunk"),
      ...identity,
      sequence: z.number().int().min(0).max(255),
      hash,
      data: z
        .string()
        .min(1)
        .max(32768)
        .regex(/^[\x20-\x7e]+$/),
    })
    .strict(),
  z.object({ action: z.literal("complete"), ...identity }).strict(),
  z
    .object({ action: z.literal("fail"), ...identity, code: z.string().regex(/^[A-Z_]{1,80}$/) })
    .strict(),
]);
export async function salesAgent(req: Request, raw: unknown) {
  assertSalesEnabled();
  const input = inputSchema.parse(raw),
    auth = await authenticateConnector(req);
  const reply = await prisma.$transaction(
    async (db) => {
      const c = await lockConnector(db, auth.agentId, auth.presented),
        now = new Date(),
        today = indiaDay(now);
      await db.tallyConnection.update({ where: { id: c.id }, data: { lastSeenAt: now } });
      if (input.action === "heartbeat") return { ok: true };
      const jobReply = async (
        j: {
          id: string;
          monthKey: string;
          fromDate: string;
          throughDate: string;
          leaseExpiresAt: Date | null;
          manifest: unknown;
          scopeHash: string | null;
        },
        cachedScope?: Scope,
      ) => {
        if (j.manifest) throw new ApiError(409, "Replay the saved sales upload before claiming");
        const current = cachedScope ?? (await scope(db, j.monthKey));
        if (current.fingerprint !== j.scopeHash) {
          await db.tallySalesJob.update({
            where: { id: j.id },
            data: { status: "FAILED", error: "SCOPE_CHANGED" },
          });
          return { job: null };
        }
        if (Buffer.byteLength(JSON.stringify(current.names.map((n) => n.name)), "utf8") > 100000)
          throw new ApiError(422, "Sales dealer scope requires a smaller reviewed batch");
        const leaseToken = token();
        await db.tallySalesJob.update({
          where: { id: j.id },
          data: { leaseHash: hashSales(leaseToken) },
        });
        return {
          job: {
            id: j.id,
            leaseToken,
            operation: "sales.sync.v1",
            companyName: c.companyName,
            anchorName: c.anchorName,
            anchorGuid: c.anchorGuid,
            monthKey: j.monthKey,
            fromDate: j.fromDate,
            throughDate: j.throughDate,
            aliases: current.names.map((n) => n.name),
          },
        };
      };
      if (input.action === "claim") {
        await db.tallySalesJob.updateMany({
          where: { connectionId: c.id, status: "RUNNING", leaseExpiresAt: { lte: now } },
          data: { status: "FAILED", error: "LEASE_EXPIRED", completedAt: now },
        });
        const prior = await db.tallySalesJob.findUnique({
          where: {
            connectionId_claimRequestId: { connectionId: c.id, claimRequestId: input.requestId },
          },
        });
        if (prior) return prior.status === "RUNNING" ? jobReply(prior) : { job: null };
        if (await db.tallySalesJob.findFirst({ where: { connectionId: c.id, status: "RUNNING" } }))
          return { job: null };
        let job = await db.tallySalesJob.findFirst({
          where: { connectionId: c.id, status: "QUEUED" },
          orderBy: [{ createdAt: "asc" }, { monthKey: "asc" }, { id: "asc" }],
        });
        {
          const current = today.slice(0, 7),
            last = await db.tallySalesJob.findFirst({
              where: { connectionId: c.id, monthKey: current, manual: false },
              orderBy: { createdAt: "desc" },
            });
          const due =
            current >= "2026-04" &&
            current <= "2027-03" &&
            (!last || +now - +last.createdAt >= 15 * 60 * 1000);
          if (!job && !due) return { job: null };
          if (!job || (job.monthKey !== current && due)) {
            let period;
            try {
              period = salesPeriod(current, today);
            } catch {
              return { job: null };
            }
            job = await db.tallySalesJob.create({ data: { connectionId: c.id, ...period } });
          }
        }
        // A current-month request queued yesterday must read through today, rather than publish a stale end date.
        const period = salesPeriod(job.monthKey, today),
          current = await scope(db, job.monthKey);
        if (!current.dealers.length) {
          await db.tallySalesJob.update({
            where: { id: job.id },
            data: {
              status: "SUCCEEDED",
              completedAt: now,
              summary: { updatedRows: 0, changedRows: 0, held: [], noEligiblePlans: true },
            },
          });
          return { job: null };
        }
        job = await db.tallySalesJob.update({
          where: { id: job.id },
          data: {
            ...period,
            status: "RUNNING",
            claimRequestId: input.requestId,
            scope: { fingerprint: current.fingerprint },
            scopeHash: current.fingerprint,
            leaseExpiresAt: new Date(+now + 20 * 60 * 1000),
          },
        });
        return jobReply(job, current);
      }
      const job = await db.tallySalesJob.findUnique({ where: { id: input.jobId } });
      if (
        !job ||
        job.connectionId !== c.id ||
        !job.leaseHash ||
        !timingSafeEqual(Buffer.from(job.leaseHash), Buffer.from(hashSales(input.leaseToken)))
      )
        throw new ApiError(409, "Sales attempt is no longer active");
      if (job.status === "SUCCEEDED" && input.action === "complete")
        return { ok: true, duplicate: true };
      if (job.status !== "RUNNING" || !job.leaseExpiresAt || job.leaseExpiresAt <= now)
        throw new ApiError(409, "Sales lease expired");
      if (input.action === "fail") {
        await db.tallySalesJob.update({
          where: { id: job.id },
          data: { status: "FAILED", completedAt: now, error: input.code },
        });
        await db.tallySalesChunk.deleteMany({ where: { jobId: job.id } });
        return { ok: true };
      }
      if (input.action === "begin") {
        if (job.manifest && JSON.stringify(job.manifest) !== JSON.stringify(input.manifest)) {
          const old = manifest.parse(job.manifest);
          if (
            old.bytes !== input.manifest.bytes ||
            old.chunks !== input.manifest.chunks ||
            old.sha256 !== input.manifest.sha256
          )
            throw new ApiError(409, "Sales manifest changed");
        }
        await db.tallySalesJob.update({
          where: { id: job.id },
          data: { manifest: input.manifest },
        });
        return { ok: true };
      }
      const m = manifest.parse(job.manifest);
      if (input.action === "chunk") {
        if (input.sequence >= m.chunks || hashSales(input.data) !== input.hash)
          throw new ApiError(422, "Sales chunk rejected");
        const old = await db.tallySalesChunk.findUnique({
          where: { jobId_sequence: { jobId: job.id, sequence: input.sequence } },
        });
        if (old && old.hash !== input.hash) throw new ApiError(409, "Sales chunk changed");
        await db.tallySalesChunk.upsert({
          where: { jobId_sequence: { jobId: job.id, sequence: input.sequence } },
          create: { jobId: job.id, sequence: input.sequence, hash: input.hash, data: input.data },
          update: {},
        });
        return { ok: true };
      }
      const chunks = await db.tallySalesChunk.findMany({
          where: { jobId: job.id },
          orderBy: { sequence: "asc" },
        }),
        payload = chunks.map((c) => c.data).join("");
      if (
        chunks.length !== m.chunks ||
        chunks.some((c, i) => c.sequence !== i) ||
        payload.length !== m.bytes ||
        hashSales(payload) !== m.sha256
      )
        throw new ApiError(422, "Incomplete sales snapshot");
      const current = await scope(db, job.monthKey);
      let rejection: string | null = current.fingerprint !== job.scopeHash ? "SCOPE_CHANGED" : null;
      if (
        (!job.manual && job.monthKey !== today.slice(0, 7)) ||
        job.throughDate !== salesPeriod(job.monthKey, today).throughDate
      )
        rejection = "SALES_DATE_CHANGED";
      let result: SalesResult | null = null;
      if (!rejection) {
        try {
          result = validateSales(
            JSON.parse(payload),
            { ...job, companyName: c.companyName, anchorGuid: c.anchorGuid },
            now,
          );
        } catch {
          rejection = "SALES_DATA_REJECTED";
        }
      }
      if (rejection || !result) {
        await db.tallySalesJob.update({
          where: { id: job.id },
          data: { status: "FAILED", error: rejection ?? "SALES_DATA_REJECTED", completedAt: now },
        });
        await db.tallySalesChunk.deleteMany({ where: { jobId: job.id } });
        // Commit the failed state before returning a stale-attempt response. Values remain untouched.
        return { rejected: true };
      }
      const summary = await publish(db, c, job, result, current);
      await db.tallySalesJob.update({
        where: { id: job.id },
        data: { status: "SUCCEEDED", completedAt: now, resultHash: m.sha256, summary },
      });
      await db.tallySalesChunk.deleteMany({ where: { jobId: job.id } });
      return { ok: true };
    },
    {
      timeout: 55000,
      maxWait: 10000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
  if ("rejected" in reply)
    throw new ApiError(409, "Sales attempt ended without changing actuals; request a fresh read");
  return reply;
}
function checkedPeriod(monthKey: string) {
  try {
    return salesPeriod(monthKey, indiaDay());
  } catch {
    throw new ApiError(
      422,
      "Choose a current or earlier month in the approved financial year (April 2026–March 2027)",
    );
  }
}
export async function requestSalesRefresh(ctx: AuthContext, monthKey: string, toMonth = monthKey) {
  assertSalesEnabled();
  assertSuper(ctx);
  let months: string[];
  try {
    months = salesMonths(monthKey, toMonth, indiaDay());
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
  return prisma.$transaction(
    async (db) => {
      const c = await db.tallyConnection.findFirst({ where: { enabled: true } });
      if (!c) throw new ApiError(409, "Configure the office connector first");
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${c.id}))`;
      const jobs = [];
      for (const key of months) {
        const existing = await db.tallySalesJob.findFirst({
          where: { connectionId: c.id, monthKey: key, status: { in: ["QUEUED", "RUNNING"] } },
        });
        const row =
          existing ??
          (await db.tallySalesJob.create({
            data: { connectionId: c.id, ...checkedPeriod(key), manual: true },
          }));
        jobs.push({ monthKey: key, jobId: row.id, status: row.status });
      }
      return { jobId: jobs[0].jobId, jobs };
    },
    { timeout: 20000 },
  );
}
export async function salesRangeStatus(ctx: AuthContext, fromMonth: string, toMonth: string) {
  assertSalesEnabled();
  assertSuper(ctx);
  let months: string[];
  try {
    months = salesMonths(fromMonth, toMonth, indiaDay());
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
  const c = await prisma.tallyConnection.findFirst({
    where: { enabled: true },
    select: { id: true, lastSeenAt: true },
  });
  if (!c) return { configured: false, months: [] };
  const [jobs, snapshots] = await Promise.all([
    prisma.tallySalesJob.findMany({
      where: { connectionId: c.id, monthKey: { in: months } },
      orderBy: { createdAt: "desc" },
      distinct: ["monthKey"],
      select: {
        id: true,
        monthKey: true,
        status: true,
        error: true,
        leaseExpiresAt: true,
        summary: true,
      },
    }),
    prisma.tallySalesSnapshot.findMany({
      where: { connectionId: c.id, monthKey: { in: months } },
      select: { monthKey: true, observedAt: true },
    }),
  ]);
  return {
    configured: true,
    lastSeenAt: c.lastSeenAt,
    months: months.map((monthKey) => ({
      monthKey,
      job: (() => {
        const job = jobs.find((j) => j.monthKey === monthKey);
        if (!job) return null;
        const { summary, ...info } = job;
        return {
          ...info,
          noEligiblePlans: !!(
            summary &&
            typeof summary === "object" &&
            !Array.isArray(summary) &&
            summary.noEligiblePlans
          ),
        };
      })(),
      observedAt: snapshots.find((s) => s.monthKey === monthKey)?.observedAt ?? null,
    })),
  };
}

export async function salesStatus(ctx: AuthContext, monthKey: string) {
  assertSalesEnabled();
  assertSuper(ctx);
  checkedPeriod(monthKey);
  const c = await prisma.tallyConnection.findFirst({
    where: { enabled: true },
    select: { id: true },
  });
  if (!c) return { configured: false };
  const [job, snapshot] = await Promise.all([
    prisma.tallySalesJob.findFirst({
      where: { connectionId: c.id, monthKey },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
        leaseExpiresAt: true,
        error: true,
        summary: true,
      },
    }),
    prisma.tallySalesSnapshot.findUnique({
      where: { connectionId_monthKey: { connectionId: c.id, monthKey } },
      select: { observedAt: true, fromDate: true, throughDate: true, summary: true },
    }),
  ]);
  return { configured: true, job, snapshot };
}
