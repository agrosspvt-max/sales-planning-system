import "server-only";
import { isAdministrativeRole } from "@/features/accounts/permissions";

import { createHash } from "node:crypto";
import { z } from "zod";
import { type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { writeAudit } from "@/lib/audit";
import { loadDealerResolver } from "@/lib/dealer-resolver";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";
import { loadLastPaymentPoints } from "@/lib/last-payment.server";
import { lastPaymentMonthEnd, latestReceiptAsOf } from "@/lib/last-payment";
import { parseHistoricalDaybook } from "./parser";
import type { HistoricalAnalysis, HistoricalRow, HistoricalResult, ReceiptReview } from "./types";

const reviewSchema = z.object({
  reviews: z
    .array(
      z.object({
        rowKey: z.string().max(400),
        action: z.enum(["KEEP", "EXCLUDE"]),
        dealerId: z.string().optional(),
      }),
    )
    .max(20_000)
    .default([]),
  previewToken: z.string().optional(),
  confirmed: z.boolean().optional(),
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const assertAdmin = (ctx: AuthContext) => {
  if (!isAdministrativeRole(ctx.role))
    throw new ApiError(403, "Only the Super Admin can import historical Day Book receipts.");
};
type DB = Prisma.TransactionClient;
const key = (fileHash: string, kind = "HISTORICAL", scopeKey = "") => ({
  kind_scopeKey_fileHash: { kind, scopeKey, fileHash },
});
/** Serializes only isolated receipt-store writers, never locks/re-writes operational records. */
async function receiptLock(db: DB) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(79241362)`;
}
function parse(buffer: Buffer) {
  try {
    return parseHistoricalDaybook(buffer);
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
}

async function buildAnalysis(
  buffer: Buffer,
  filename: string,
  reviews: ReceiptReview[],
  db: DB,
): Promise<HistoricalAnalysis> {
  const parsed = parse(buffer),
    fileHash = hash(buffer);
  const existing = await db.lastPaymentImport.findUnique({ where: key(fileHash) });
  const previouslyExcluded = new Set<string>(
    existing
      ? ((JSON.parse(existing.summary).reviews as ReceiptReview[]) ?? [])
          .filter((r) => r.action === "EXCLUDE")
          .map((r) => r.rowKey)
      : [],
  );
  const resolver = await loadDealerResolver(db);
  const dealersById = new Map(resolver.dealers.map((d) => [d.id, d]));
  const choices = new Map(reviews.map((r) => [r.rowKey, r]));
  const sourceKeys = new Set(parsed.rows.map((r) => r.rowKey));
  if (choices.size !== reviews.length || reviews.some((r) => !sourceKeys.has(r.rowKey)))
    throw new ApiError(422, "Review contains duplicate or unknown source rows.");
  const matching = new Map<string, ReturnType<typeof resolver.candidates>>();
  const rows: HistoricalRow[] = parsed.rows.map((source) => {
    let candidates = matching.get(source.party);
    if (!candidates) {
      candidates = resolver
        .candidates(source.party)
        .sort((a, b) => b.score - a.score || a.dealer.id.localeCompare(b.dealer.id));
      matching.set(source.party, candidates);
    }
    const choice = choices.get(source.rowKey);
    if (choice?.dealerId && !dealersById.has(choice.dealerId))
      throw new ApiError(
        422,
        "The selected dealer is not an active existing Dealer Master record.",
      );
    const confident =
      candidates.length === 1 && ["ALIAS", "EXACT"].includes(candidates[0].matchType);
    const dealerId = choice?.dealerId ?? (confident ? candidates[0].dealer.id : null);
    const reviewReasons =
      confident || choice?.dealerId
        ? []
        : [
            candidates.length
              ? "Confirm the dealer match; more than one candidate or a loose/fuzzy match."
              : "Unmatched dealer: select an existing dealer or exclude this row.",
          ];
    return {
      ...source,
      dealerId,
      candidates: candidates
        .slice(0, 10)
        .map((c) => ({ id: c.dealer.id, name: c.dealer.name, matchType: c.matchType })),
      reviewReasons,
      duplicate: !!existing && !previouslyExcluded.has(source.rowKey),
      excluded: previouslyExcluded.has(source.rowKey) || choice?.action === "EXCLUDE",
      ready: false,
    };
  });
  const dealerIds = [...new Set(rows.flatMap((r) => (r.dealerId ? [r.dealerId] : [])))];
  const stored = dealerIds.length
    ? await db.lastPaymentReceipt.findMany({
        where: { dealerId: { in: dealerIds }, import: { isActive: true } },
        orderBy: { id: "asc" },
        select: {
          dealerId: true,
          receiptDate: true,
          creditAmount: true,
          voucherNumber: true,
          rowKey: true,
          import: { select: { fileHash: true } },
        },
      })
    : [];
  const storedByDay = new Map<string, typeof stored>();
  for (const s of stored) {
    const day = JSON.stringify([s.dealerId, s.receiptDate.toISOString().slice(0, 10)]);
    storedByDay.set(day, [...(storedByDay.get(day) ?? []), s]);
  }
  const seen = new Map<string, HistoricalRow>();
  for (const r of rows) {
    if (r.errors.length || !r.dealerId || r.excluded || r.duplicate) continue;
    const same = (storedByDay.get(JSON.stringify([r.dealerId, r.date])) ?? []).filter(
      (s) =>
        Number(s.creditAmount) === Number(r.amount) ||
        (!!r.voucherNumber && s.voucherNumber === r.voucherNumber),
    );
    // Exact same bytes + source position + values is confirmed. Voucher number by itself is not.
    r.duplicate = same.some(
      (s) =>
        s.import.fileHash === fileHash &&
        s.rowKey === r.rowKey &&
        Number(s.creditAmount) === Number(r.amount),
    );
    if (!r.duplicate && same.length)
      r.reviewReasons.push(
        "Potential duplicate/conflict with stored receipt: explicitly keep as distinct or exclude. Voucher numbers are not globally unique.",
      );
    const tuple = JSON.stringify([r.dealerId, r.date, r.amount]);
    const voucher = r.voucherNumber
      ? JSON.stringify([r.dealerId, r.date, "voucher", r.voucherNumber])
      : null;
    const previous = [seen.get(tuple), voucher ? seen.get(voucher) : undefined].filter(
      (p): p is HistoricalRow => !!p,
    );
    if (previous.length) {
      r.reviewReasons.push(
        "Potential duplicate/conflict within this file: confirm this is a distinct receipt or exclude.",
      );
      for (const p of previous)
        if (!p.reviewReasons.includes("Same-day duplicate candidate in this file."))
          p.reviewReasons.push("Same-day duplicate candidate in this file.");
    }
    if (!seen.has(tuple)) seen.set(tuple, r);
    if (voucher && !seen.has(voucher)) seen.set(voucher, r);
  }
  for (const r of rows) {
    const choice = choices.get(r.rowKey);
    r.ready =
      r.excluded ||
      r.duplicate ||
      (!r.errors.length && !!r.dealerId && (!r.reviewReasons.length || choice?.action === "KEEP"));
  }
  const plans = dealerIds.length
    ? await db.recoveryPlanDealer.findMany({
        where: { dealerId: { in: dealerIds } },
        select: {
          dealerId: true,
          recoveryPlan: {
            select: {
              id: true,
              seasonMonthId: true,
              seasonMonth: { select: { name: true, calendarMonth: true, calendarYear: true } },
            },
          },
        },
      })
    : [];
  const maxMonthEnd = plans.reduce(
    (max, p) => {
      const end = lastPaymentMonthEnd(p.recoveryPlan.seasonMonth);
      return end && end > max ? end : max;
    },
    new Date("1900-01-01T00:00:00Z"),
  );
  const points = await loadLastPaymentPoints(dealerIds, maxMonthEnd, db);
  // Legacy monthly pairs have no voucher identity. Their same-day overlaps also require review.
  for (const r of rows) {
    if (r.duplicate || r.excluded || r.errors.length || !r.dealerId) continue;
    if (
      (points.get(r.dealerId) ?? []).some(
        (p) => p.date === r.date && p.amount === Number(r.amount),
      ) &&
      !r.reviewReasons.length
    ) {
      r.reviewReasons.push(
        "Potential overlap with existing Last Payment history: confirm a distinct receipt or exclude.",
      );
      r.ready = choices.get(r.rowKey)?.action === "KEEP";
    }
  }
  const selectedImports = rows.filter((r) => r.ready && !r.excluded && !r.duplicate);
  const importsByDealer = new Map<string, { date: string; amount: number }[]>();
  for (const r of selectedImports)
    importsByDealer.set(r.dealerId!, [
      ...(importsByDealer.get(r.dealerId!) ?? []),
      { date: r.date!, amount: Number(r.amount) },
    ]);
  const names = await loadDealerAliasNameMap(dealerIds, db);
  const periods = new Map<string, {
    dealerId: string; calendarMonth: number; calendarYear: number; monthEnd: string; plans: number;
  }>();
  const unresolved = new Map<string, HistoricalAnalysis["unresolvedPeriods"][number]>();
  for (const p of plans) {
    const plan = p.recoveryPlan;
    const end = lastPaymentMonthEnd(plan.seasonMonth);
    if (!end) {
      unresolved.set(plan.id, { planId: plan.id, seasonMonthId: plan.seasonMonthId, monthName: plan.seasonMonth.name });
      continue;
    }
    const calendarMonth = plan.seasonMonth.calendarMonth!, calendarYear = plan.seasonMonth.calendarYear!;
    const k = JSON.stringify([p.dealerId, calendarYear, calendarMonth]);
    periods.set(k, { dealerId: p.dealerId, calendarMonth, calendarYear, monthEnd: end.toISOString().slice(0, 10), plans: (periods.get(k)?.plans ?? 0) + 1 });
  }
  const changes: HistoricalAnalysis["changes"] = [];
  for (const { dealerId, calendarMonth, calendarYear, monthEnd, plans: count } of periods.values()) {
    const current = points.get(dealerId) ?? [];
    const before = latestReceiptAsOf(current, monthEnd);
    const after = latestReceiptAsOf([...current, ...(importsByDealer.get(dealerId) ?? [])], monthEnd);
    if (JSON.stringify(before) !== JSON.stringify(after))
      changes.push({
        dealerId,
        dealerName: names.get(dealerId) ?? dealersById.get(dealerId)?.name ?? dealerId,
        calendarMonth,
        calendarYear,
        monthEnd,
        plans: count,
        before,
        after,
      });
  }
  const analysis: HistoricalAnalysis = {
    fileHash,
    previewToken: "",
    workbookName: filename,
    sheet: parsed.sheet,
    ignoredSheets: parsed.ignoredSheets,
    totalRows: parsed.totalRows,
    ignoredRows: parsed.ignoredRows,
    rows,
    summary: {
      receipts: rows.length,
      valid: rows.filter((r) => !r.errors.length).length,
      dealers: new Set(selectedImports.map((r) => r.dealerId)).size,
      invalid: rows.filter((r) => r.errors.length).length,
      unmatched: rows.filter((r) => !r.dealerId && !r.errors.length).length,
      review: rows.filter((r) => !r.ready).length,
      duplicates: rows.filter((r) => r.duplicate).length,
      excluded: rows.filter((r) => r.excluded).length,
      importing: selectedImports.length,
    },
    changes: changes.sort(
      (a, b) => a.dealerName.localeCompare(b.dealerName) || a.monthEnd.localeCompare(b.monthEnd),
    ),
    unresolvedPeriods: [...unresolved.values()].sort((a, b) => a.planId.localeCompare(b.planId)),
    canCommit: !existing && rows.every((r) => r.ready) && selectedImports.length > 0,
    alreadyImported: !!existing,
  };
  // Pin workbook, choices, matching, receipts and explicit plan periods. Re-analysis on commit.
  analysis.previewToken = hash(JSON.stringify({
    analysis, reviews, stored,
    periods: [...plans].sort((a, b) => a.dealerId.localeCompare(b.dealerId) || a.recoveryPlan.id.localeCompare(b.recoveryPlan.id)),
  }));
  return analysis;
}

export async function analyzeHistoricalDaybook(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  raw: unknown,
) {
  assertAdmin(ctx);
  const input = reviewSchema.parse(raw);
  return buildAnalysis(buffer, filename, input.reviews, prisma);
}
export async function commitHistoricalDaybook(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  raw: unknown,
): Promise<HistoricalResult> {
  assertAdmin(ctx);
  const input = reviewSchema.parse(raw);
  if (!input.confirmed || !input.previewToken)
    throw new ApiError(422, "Analyze and explicitly confirm the historical receipt import first.");
  return prisma.$transaction(
    async (tx) => {
      await receiptLock(tx);
      const existing = await tx.lastPaymentImport.findUnique({ where: key(hash(buffer)) });
      if (existing)
        return {
          ...(JSON.parse(existing.summary) as Omit<
            HistoricalResult,
            "importId" | "alreadyImported"
          >),
          importId: existing.id,
          alreadyImported: true,
        };
      const analysis = await buildAnalysis(buffer, filename, input.reviews, tx);
      if (analysis.previewToken !== input.previewToken)
        throw new ApiError(
          409,
          "Receipt history, dealer matching or recovery periods changed. Analyze again before importing.",
        );
      if (!analysis.canCommit)
        throw new ApiError(
          422,
          "Resolve or explicitly exclude every invalid, unmatched and duplicate-candidate row before importing.",
        );
      const result = {
        imported: analysis.summary.importing,
        excluded: analysis.summary.excluded,
        duplicates: analysis.summary.duplicates,
      };
      const batch = await tx.lastPaymentImport.create({
        data: {
          kind: "HISTORICAL",
          fileHash: analysis.fileHash,
          workbookName: filename,
          uploadedById: ctx.userId,
          summary: JSON.stringify({
            ...result,
            reviews: input.reviews,
            sheet: analysis.sheet,
            totalRows: analysis.totalRows,
          }),
        },
      });
      await tx.lastPaymentReceipt.createMany({
        data: analysis.rows
          .filter((r) => !r.excluded && !r.duplicate)
          .map((r) => ({
            importId: batch.id,
            dealerId: r.dealerId!,
            rowKey: r.rowKey,
            sourceOrder: r.sourceOrder,
            receiptDate: new Date(`${r.date}T00:00:00Z`),
            creditAmount: r.amount!,
            voucherNumber: r.voucherNumber,
          })),
      });
      await writeAudit(
        {
          userId: ctx.userId,
          action: "CREATE",
          entity: "lastPaymentImport",
          entityId: batch.id,
          summary: `Historical Day Book ${filename}: ${result.imported} receipts, ${result.excluded} explicitly excluded, ${result.duplicates} confirmed duplicates. Last Payment only.`,
        },
        tx,
      );
      return { ...result, importId: batch.id, alreadyImported: false };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

export interface RegularReceipt {
  dealerId: string;
  date: Date;
  amount: number;
  sourceOrder: number;
}
export interface RegularDaybookState {
  planId: string;
  dealerId: string;
  receipt: number;
  srCr: number;
  lastReceiptDate: Date | null;
  lastReceiptAmount: number | null;
}
/** Separate post-financial-commit retention. Replacements deactivate ONLY prior REGULAR receipt batches.
 * Historical rows are never reset; failures must be surfaced without replaying monthly financial writes. */
export async function retainRegularReceipts(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  scopeKey: string,
  receipts: RegularReceipt[],
  expected: RegularDaybookState[],
) {
  assertAdmin(ctx);
  const sourceFileHash = hash(buffer);
  const valid = receipts.filter(
    (r) =>
      Number.isFinite(r.date.getTime()) &&
      Number.isFinite(r.amount) &&
      r.amount > 0 &&
      r.amount < 1e12,
  );
  // A regular re-upload re-resolves dealers using current aliases/assignment scope. Its retained
  // batch must match that resolution, not reactivate a stale mapping solely because bytes match.
  // This identifies a retention batch/version, never a transaction or voucher across sources.
  const fileHash = hash(
    JSON.stringify({
      sourceFileHash,
      receipts: valid.map((r) => [
        r.sourceOrder,
        r.dealerId,
        r.date.toISOString().slice(0, 10),
        r.amount,
      ]),
    }),
  );
  await prisma.$transaction(
    async (tx) => {
      await receiptLock(tx);
      // An older concurrent upload must not supersede the history of the current financial upload.
      // Read/revalidate only; historical and retention services never write RecoveryPlanDealer.
      const current = await tx.recoveryPlanDealer.findMany({
        where: { recoveryPlan: { seasonMonthId: scopeKey } },
        select: {
          recoveryPlanId: true,
          dealerId: true,
          liveRecovery: true,
          srCr: true,
          lastReceiptDate: true,
          lastReceiptAmount: true,
        },
      });
      const wanted = new Map(expected.map((r) => [JSON.stringify([r.planId, r.dealerId]), r]));
      const equalAmount = (a: unknown, b: number) => Number(a).toFixed(2) === b.toFixed(2);
      for (const row of current) {
        const state = wanted.get(JSON.stringify([row.recoveryPlanId, row.dealerId]));
        if (
          !equalAmount(row.liveRecovery, state?.receipt ?? 0) ||
          !equalAmount(row.srCr, state?.srCr ?? 0) ||
          (row.lastReceiptDate?.toISOString().slice(0, 10) ?? null) !==
            (state?.lastReceiptDate?.toISOString().slice(0, 10) ?? null) ||
          (row.lastReceiptAmount == null ? null : Number(row.lastReceiptAmount).toFixed(2)) !==
            (state?.lastReceiptAmount == null ? null : state.lastReceiptAmount.toFixed(2))
        )
          throw new Error(
            "A newer monthly upload changed the Day Book values before isolated receipt retention.",
          );
        wanted.delete(JSON.stringify([row.recoveryPlanId, row.dealerId]));
      }
      if (wanted.size) throw new Error("A monthly dealer row changed before receipt retention.");
      await tx.lastPaymentImport.updateMany({
        where: { kind: "REGULAR", scopeKey, isActive: true, fileHash: { not: fileHash } },
        data: { isActive: false },
      });
      const existing = await tx.lastPaymentImport.findUnique({
        where: key(fileHash, "REGULAR", scopeKey),
      });
      if (existing) {
        if (!existing.isActive)
          await tx.lastPaymentImport.update({
            where: { id: existing.id },
            data: { isActive: true },
          });
        return;
      }
      const batch = await tx.lastPaymentImport.create({
        data: {
          kind: "REGULAR",
          scopeKey,
          fileHash,
          workbookName: filename,
          uploadedById: ctx.userId,
          summary: JSON.stringify({ imported: valid.length, sourceFileHash }),
        },
      });
      if (valid.length)
        await tx.lastPaymentReceipt.createMany({
          data: valid.map((r) => ({
            importId: batch.id,
            dealerId: r.dealerId,
            rowKey: JSON.stringify(["regular", r.sourceOrder]),
            sourceOrder: r.sourceOrder,
            receiptDate: new Date(`${r.date.toISOString().slice(0, 10)}T00:00:00Z`),
            creditAmount: r.amount,
          })),
        });
      await writeAudit(
        {
          userId: ctx.userId,
          action: "CREATE",
          entity: "lastPaymentImport",
          entityId: batch.id,
          summary: `Regular Day Book receipt retention: ${valid.length} receipt rows (${filename}); operational calculations unchanged.`,
        },
        tx,
      );
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}
