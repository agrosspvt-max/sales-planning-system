import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { assertSuper } from "./service.server";
import { approvedTestPreview } from "./sales-rollout";
import { salesMonths } from "./sales-range";
import { tight } from "./billwise";
import { recoveryEvidenceSchema } from "./recovery-evidence";
import {
  explainRecovery,
  type RecoveryDiagnostic,
  type RecoveryDaybookSource,
} from "./recovery-diagnostic";

const input = z
  .object({ jobId: z.string().uuid().optional(), ledgerName: z.string().min(1).max(256) })
  .strict();
const scopeSchema = z.object({
  aliases: z.array(z.object({ name: z.string(), dealerId: z.string() })),
});
const summarySchema = z.object({
  observedAt: z.string().optional(),
  held: z.array(z.object({ name: z.string(), reason: z.string() })),
  _recoveryEvidence: recoveryEvidenceSchema.optional(),
});

export async function getRecoveryDiagnostic(
  ctx: AuthContext,
  raw: unknown,
): Promise<RecoveryDiagnostic> {
  if (!approvedTestPreview())
    throw new ApiError(404, "Recovery diagnostics are available on the test Preview.");
  assertSuper(ctx);
  const params = input.parse(raw);
  const connection = await prisma.tallyConnection.findFirst({
    where: { enabled: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!connection) throw new ApiError(409, "Configure the office connector first.");
  const job = await prisma.tallySyncJob.findFirst({
    where: {
      connectionId: connection.id,
      status: "COMPLETE",
      completedAt: { not: null },
      ...(params.jobId ? { id: params.jobId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, asOf: true, completedAt: true, summary: true, scope: true },
  });
  if (!job)
    throw new ApiError(404, "No completed Recovery read is available. Refresh Recovery first.");
  const scope = scopeSchema.safeParse(job.scope),
    summary = summarySchema.safeParse(job.summary);
  if (!scope.success || !summary.success)
    throw new ApiError(409, "This Recovery read has no usable review details. Refresh Recovery.");
  const alias = scope.data.aliases.find((alias) => tight(alias.name) === tight(params.ledgerName));
  if (!alias) throw new ApiError(404, "This ledger was not included in that Recovery read.");
  const dealer = await prisma.dealer.findUnique({
    where: { id: alias.dealerId },
    select: { name: true },
  });
  const reason =
    summary.data.held.find((row) => tight(row.name) === tight(alias.name))?.reason ?? "VERIFIED";
  const evidence =
    summary.data._recoveryEvidence?.ledgers.find((row) => tight(row.name) === tight(alias.name)) ??
    null;
  const lastMonth = job.asOf.slice(0, 7);
  const months = salesMonths("2026-04", lastMonth, job.asOf);
  const latest = await prisma.$queryRaw<
    {
      id: string;
      monthKey: string;
      fromDate: string;
      throughDate: string;
      completedAt: Date;
      coverage: string | null;
      products: string | null;
    }[]
  >(Prisma.sql`
    SELECT DISTINCT ON ("monthKey") id,"monthKey","fromDate","throughDate","completedAt",
      summary->>'coverage' AS coverage,summary->'_daybookProducts'->'capture'->>'status' AS products
    FROM "TallyDaybookJob"
    WHERE "connectionId"=${connection.id} AND status='SUCCEEDED' AND "completedAt" IS NOT NULL AND "monthKey" IN (${Prisma.join(months)})
    ORDER BY "monthKey","completedAt" DESC,id DESC`);
  const byMonth = new Map(latest.map((row) => [row.monthKey, row]));
  const coverage = months.map((month) => {
    const row = byMonth.get(month);
    const through =
      month === lastMonth
        ? job.asOf
        : new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
    return {
      month,
      throughDate: row?.throughDate ?? null,
      capturedAt: row?.completedAt.toISOString() ?? null,
      complete:
        !!row &&
        row.fromDate === month + "-01" &&
        row.throughDate >= through &&
        row.coverage === "all_vouchers" &&
        row.products === "complete",
    };
  });
  // Extract only this party's vouchers from large company captures. No full
  // company JSON, credentials or other dealers' entries are returned to the UI.
  const rows = latest.length
    ? await prisma.$queryRaw<
        {
          jobId: string;
          monthKey: string;
          completedAt: Date;
          kind: RecoveryDaybookSource["kind"];
          voucher: Prisma.JsonValue;
        }[]
      >(Prisma.sql`
    SELECT j.id AS "jobId",j."monthKey",j."completedAt",s.kind,s.voucher
    FROM "TallyDaybookJob" j
    CROSS JOIN LATERAL (
      SELECT 'product' AS kind,v AS voucher
      FROM jsonb_array_elements(COALESCE(j.summary->'_daybookProducts'->'capture'->'vouchers','[]'::jsonb)) v
      WHERE lower(regexp_replace(v->>'partyName','[^a-zA-Z0-9]','','g'))=${tight(alias.name)}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v->'ledgerEntries','[]'::jsonb)) e
          WHERE lower(regexp_replace(e->>'name','[^a-zA-Z0-9]','','g'))=${tight(alias.name)})
      UNION ALL
      SELECT 'credit',v FROM jsonb_array_elements(COALESCE(j.summary->'dealerRows','[]'::jsonb)) d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d->'creditVouchers','[]'::jsonb)) v
      WHERE lower(regexp_replace(v->>'ledgerName','[^a-zA-Z0-9]','','g'))=${tight(alias.name)}
      UNION ALL
      SELECT 'other',v FROM jsonb_array_elements(COALESCE(j.summary->'excludedVouchers','[]'::jsonb)) v
      WHERE lower(regexp_replace(v->>'ledgerName','[^a-zA-Z0-9]','','g'))=${tight(alias.name)}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v->'details'->'voucher'->'ledgerEntries','[]'::jsonb)) e
          WHERE lower(regexp_replace(e->>'ledgerName','[^a-zA-Z0-9]','','g'))=${tight(alias.name)})
    ) s
    WHERE j.id IN (${Prisma.join(latest.map((row) => row.id))})
    ORDER BY j."completedAt" DESC,j.id DESC LIMIT 10001`)
    : [];
  return explainRecovery(
    {
      jobId: job.id,
      ledgerName: alias.name,
      dealerName: dealer?.name ?? alias.name,
      asOf: job.asOf,
      recoveryCapturedAt: summary.data.observedAt ?? job.completedAt!.toISOString(),
      reason,
      evidence,
      coverage,
    },
    rows
      .slice(0, 10000)
      .map(({ completedAt, ...row }) => ({ ...row, capturedAt: completedAt.toISOString() })),
    rows.length > 10000,
  );
}
