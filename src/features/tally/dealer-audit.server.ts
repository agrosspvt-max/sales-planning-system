import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { loadDealerResolver, type DealerResolver } from "@/lib/dealer-resolver";
import { digest, indiaDay } from "./billwise";
import type { DealerAuditSummary } from "./dealer-audit";
import { approvedTestPreview } from "./sales-rollout";
import { assertSuper, authenticateConnector, lockConnector } from "./service.server";

export const DEALER_AUDIT_BYTES = 2 * 1024 * 1024;
const LEASE_MS = 10 * 60_000;
const RETRY_MS = 5 * 60_000;
const indiaHour = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  hourCycle: "h23",
});
const excludedGroups = new Set(["field promotion", "sundry debtors-emp"]);
const normalized = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const ledgerText = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((text) => !/[\p{Cc}]/u.test(text));
const ledgerSchema = z
  .object({
    name: ledgerText,
    group: ledgerText,
    guid: z
      .string()
      .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[a-f0-9]{8}$/i)
      .transform((guid) => guid.toLowerCase()),
  })
  .strict();
type Ledger = z.infer<typeof ledgerSchema>;
const identity = { jobId: z.string().uuid(), leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) };
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), requestId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("complete"),
      ...identity,
      ledgers: z.array(ledgerSchema).min(1).max(5_000),
    })
    .strict(),
  z
    .object({ action: z.literal("fail"), ...identity, code: z.string().regex(/^[A-Z_]{1,80}$/) })
    .strict(),
]);

export function reconcileDealerLedgers(
  ledgers: Ledger[],
  resolver: Pick<DealerResolver, "candidates">,
  bindings: ReadonlyMap<string, string>,
): DealerAuditSummary {
  const byName = new Map<
    string,
    { name: string; groups: Set<string>; names: Set<string>; guids: Set<string> }
  >();
  for (const ledger of ledgers) {
    if (excludedGroups.has(normalized(ledger.group))) continue;
    const key = normalized(ledger.name);
    const row = byName.get(key) ?? {
      name: ledger.name,
      groups: new Set(),
      names: new Set(),
      guids: new Set(),
    };
    row.groups.add(ledger.group);
    row.names.add(ledger.name);
    row.guids.add(ledger.guid);
    byName.set(key, row);
  }

  const unmatched: DealerAuditSummary["unmatched"] = [];
  for (const { name, groups, names, guids } of byName.values()) {
    const ids = new Set<string>();
    for (const ledgerName of names) {
      for (const match of resolver.candidates(ledgerName, { confirmedOnly: true }))
        ids.add(match.dealer.id);
    }
    for (const guid of guids) {
      const aliasKey = bindings.get(guid);
      if (!aliasKey) continue;
      for (const match of resolver.candidates(aliasKey, { confirmedOnly: true })) {
        if (match.matchType === "ALIAS") ids.add(match.dealer.id);
      }
    }
    if (ids.size !== 1) unmatched.push({ name, groups: [...groups].sort() });
  }
  unmatched.sort((a, b) => a.name.localeCompare(b.name));
  return { scanned: byName.size, matched: byName.size - unmatched.length, unmatched };
}

function assertTestPreview() {
  if (!approvedTestPreview())
    throw new ApiError(404, "Dealer reconciliation is available on the test Preview.");
}

export async function dealerAuditStatus(ctx: AuthContext) {
  assertTestPreview();
  assertSuper(ctx);
  const connection = await prisma.tallyConnection.findFirst({
    where: { enabled: true },
    select: { dealerAudit: { select: { completedAt: true, summary: true, error: true } } },
  });
  return {
    configured: Boolean(connection),
    completedAt: connection?.dealerAudit?.completedAt?.toISOString() ?? null,
    summary: (connection?.dealerAudit?.summary as DealerAuditSummary | null | undefined) ?? null,
    failed: Boolean(connection?.dealerAudit?.error),
  };
}

export async function dealerAuditAgent(req: Request, raw: unknown, now = new Date()) {
  assertTestPreview();
  const input = inputSchema.parse(raw);
  const auth = await authenticateConnector(req);
  return prisma.$transaction(
    async (db) => {
      const connection = await lockConnector(db, auth.agentId, auth.presented);
      const where = { connectionId: connection.id };
      const previous = await db.tallyDealerAudit.findUnique({ where });
      if (input.action === "claim") {
        const dayKey = indiaDay(now);
        if (+indiaHour.format(now) < 14 || previous?.publishedDay === dayKey) return { job: null };
        const active = previous?.leaseExpiresAt && previous.leaseExpiresAt > now;
        if (active && (previous.error || previous.claimRequestId !== input.requestId))
          return { job: null };
        const leaseToken = randomBytes(32).toString("base64url");
        const data = {
          jobId: active ? previous.jobId : randomUUID(),
          dayKey: active ? previous.dayKey : dayKey,
          claimRequestId: input.requestId,
          leaseHash: digest(leaseToken),
          leaseExpiresAt: active ? previous.leaseExpiresAt : new Date(+now + LEASE_MS),
          error: null,
          resultHash: null,
        };
        await db.tallyDealerAudit.upsert({ where, create: { ...where, ...data }, update: data });
        return {
          job: {
            id: data.jobId,
            leaseToken,
            operation: "dealer.audit.v1",
            companyName: connection.companyName,
            anchorName: connection.anchorName,
            anchorGuid: connection.anchorGuid,
            dayKey: data.dayKey,
          },
        };
      }
      if (
        !previous ||
        previous.jobId !== input.jobId ||
        previous.leaseHash !== digest(input.leaseToken)
      )
        throw new ApiError(409, "Dealer reconciliation attempt is no longer active.");
      const resultHash = input.action === "complete" ? digest(JSON.stringify(input.ledgers)) : null;
      if (resultHash && resultHash === previous.resultHash)
        return previous.error ? { ok: true, rejected: true } : { ok: true, duplicate: true };
      if (input.action === "fail" && previous.error === input.code)
        return { ok: true, duplicate: true };
      if (
        previous.error ||
        previous.publishedDay === previous.dayKey ||
        previous.leaseExpiresAt <= now
      )
        throw new ApiError(409, "Dealer reconciliation lease expired.");

      const fail = (code: string) =>
        db.tallyDealerAudit.update({
          where,
          data: { error: code, resultHash, leaseExpiresAt: new Date(+now + RETRY_MS) },
        });
      if (input.action === "fail") {
        await fail(input.code);
        return { ok: true };
      }
      const anchor = connection.anchorGuid.toLowerCase();
      if (
        !input.ledgers.some((row) => row.guid === anchor && row.name === connection.anchorName) ||
        input.ledgers.some((row) => row.guid.slice(0, 36) !== anchor.slice(0, 36))
      ) {
        await fail("DEALER_AUDIT_COMPANY_MISMATCH");
        return { ok: true, rejected: true };
      }

      const [resolver, bindings] = await Promise.all([
        loadDealerResolver(db, { includeInactive: true }),
        db.tallyLedgerBinding.findMany({ where, select: { guid: true, aliasKey: true } }),
      ]);
      const summary = reconcileDealerLedgers(
        input.ledgers,
        resolver,
        new Map(bindings.map((row) => [row.guid.toLowerCase(), row.aliasKey])),
      );
      await db.tallyDealerAudit.update({
        where,
        data: { publishedDay: previous.dayKey, completedAt: now, resultHash, summary, error: null },
      });
      return { ok: true };
    },
    { timeout: 30_000 },
  );
}
