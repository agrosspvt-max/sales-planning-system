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
import { acceptReceipts, initializeDealers, missingPermanentPayments, preserveSupersededReceipts } from "@/lib/dealer-last-payment";
import { currentBusinessDate } from "@/lib/daily-work";
import { reconcileBillingExceptionsSafely } from "@/features/reports/billing-exception.server";
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
  const result = await prisma.$transaction(
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
      // Persistent latest payment: accept these receipts into the import-independent ledger (same transaction; idempotent). A row the reviewer explicitly
      // confirmed as DISTINCT although an equal receipt exists keeps its own occurrence; everything else dedupes against what is already accepted.
      const keep = new Map(input.reviews.map((r) => [r.rowKey, r.action]));
      await acceptReceipts(tx, analysis.rows.filter((r) => !r.excluded && !r.duplicate).map((r) => ({
        dealerId: r.dealerId!, date: r.date!, amount: Number(r.amount), sourceOrder: r.sourceOrder, voucherNumber: r.voucherNumber,
        distinct: keep.get(r.rowKey) === "KEEP" && r.reviewReasons.some((reason) => /duplicate|overlap|conflict/i.test(reason)),
      })), { sourceKind: "HISTORICAL", importId: batch.id }, currentBusinessDate());
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
  // Billing Exceptions: re-check every current exception against the (possibly new) effective Last Payment — also for an already-imported file, so
  // a re-upload recovers a reconciliation that failed earlier. Runs AFTER the receipt commit and can only warn.
  const billingExceptionWarning = await reconcileBillingExceptionsSafely({ userId: ctx.userId, designation: ctx.designation });
  return billingExceptionWarning ? { ...result, billingExceptionWarning } : result;
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
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface PaymentReceiptInput { dealerId: string; date: string; amount: number; sourceOrder: number }
export interface JobExpectedState { planId: string; dealerId: string; receipt: number; srCr: number; lastReceiptDate: string | null; lastReceiptAmount: number | null }
/** What a Day Book upload hands to Last Payment: ALL receipts attributed to a Dealer Master id (any status, any month plan) and the Recovery-eligible subset + Recovery's resulting state. */
export interface LastPaymentJobPayload { paymentReceipts: PaymentReceiptInput[]; recoveryReceipts: PaymentReceiptInput[]; expected: JobExpectedState[] }

interface RetainArgs {
  uploadedById: string; sourceFileHash: string; filename: string; scopeKey: string;
  paymentReceipts: PaymentReceiptInput[]; recoveryReceipts: PaymentReceiptInput[]; expected: JobExpectedState[];
  /** A newer upload of the same month was already processed: feed ONLY the permanent ledger (never touch imports). */
  supersededByNewer: boolean;
  /** What to do when Recovery's monthly state no longer equals this upload's: "throw" (direct retention) · "supersede" (background job: a newer monthly upload happened). */
  onStale: "throw" | "supersede";
}
/**
 * ONE retention step, inside a transaction that already holds the receipt-store lock:
 *   1. (unless superseded) make the dealers' CURRENT payments permanent BEFORE their source is replaced — dealers of the new file, of the files being replaced and every dealer whose
 *      old file simply stops mentioning them — then deactivate / create / reactivate the Recovery-side import exactly as before (Recovery's own month-end source);
 *   2. accept every incoming receipt (any Dealer Master id) into the permanent ledger and refresh the latest payments (monotonic, occurrence-aware);
 *   3. PROVE it (strict verification) — otherwise the whole step fails and the job stays retryable.
 */
async function retainInTx(tx: DB, a: RetainArgs): Promise<{ importId: string | null; outcome: "PROCESSED" | "SUPERSEDED" }> {
  const today = currentBusinessDate();
  const incoming = a.paymentReceipts.map((r) => ({ dealerId: r.dealerId, date: r.date, amount: r.amount, sourceOrder: r.sourceOrder }));
  let superseded = a.supersededByNewer;
  let previous: Map<string, { date: string; amount: number }> | undefined;
  if (!superseded) {
    // A newer concurrent monthly upload must not be superseded by this older one. Read/revalidate only.
    const current = await tx.recoveryPlanDealer.findMany({
      where: { recoveryPlan: { seasonMonthId: a.scopeKey } },
      select: { recoveryPlanId: true, dealerId: true, liveRecovery: true, srCr: true, lastReceiptDate: true, lastReceiptAmount: true },
    });
    const wanted = new Map(a.expected.map((r) => [JSON.stringify([r.planId, r.dealerId]), r]));
    const equalAmount = (x: unknown, y: number) => Number(x).toFixed(2) === y.toFixed(2);
    let stale = false;
    for (const row of current) {
      const state = wanted.get(JSON.stringify([row.recoveryPlanId, row.dealerId]));
      if (
        !equalAmount(row.liveRecovery, state?.receipt ?? 0) || !equalAmount(row.srCr, state?.srCr ?? 0) ||
        (row.lastReceiptDate ? isoDay(row.lastReceiptDate) : null) !== (state?.lastReceiptDate ?? null) ||
        (row.lastReceiptAmount == null ? null : Number(row.lastReceiptAmount).toFixed(2)) !== (state?.lastReceiptAmount == null ? null : state.lastReceiptAmount.toFixed(2))
      ) { stale = true; break; }
      wanted.delete(JSON.stringify([row.recoveryPlanId, row.dealerId]));
    }
    if (!stale && wanted.size) stale = true;
    if (stale) {
      if (a.onStale === "throw") throw new Error("A newer monthly upload changed the Day Book values before isolated receipt retention.");
      superseded = true;
    }
  }
  let importId: string | null = null;
  if (!superseded) {
    const valid = a.recoveryReceipts.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.amount) && r.amount > 0 && r.amount < 1e12);
    // Identifies a retention batch/version (never a transaction or voucher across sources); a re-resolution with different aliases/scope is a different batch.
    const fileHash = hash(JSON.stringify({ sourceFileHash: a.sourceFileHash, receipts: valid.map((r) => [r.sourceOrder, r.dealerId, r.date, r.amount]) }));
    const incomingDealers = new Set(a.paymentReceipts.map((r) => r.dealerId));
    const replaced = await tx.lastPaymentReceipt.findMany({ where: { import: { kind: "REGULAR", scopeKey: a.scopeKey, isActive: true } }, select: { dealerId: true }, distinct: ["dealerId"] });
    // Preserve BEFORE the replacement removes any usable source: what the report shows now for every touched dealer (active files + snapshots), then the payments of
    // dealers an older file mentioned and this one does not.
    const touched = [...new Set([...incomingDealers, ...replaced.map((r) => r.dealerId)])];
    previous = (await initializeDealers(tx, touched, today, { snapshots: false })).previous; // snapshots were already preserved BEFORE the monthly commit (they now hold THIS upload)
    await preserveSupersededReceipts(tx, today, { incoming: { scopeKey: a.scopeKey, dealerIds: incomingDealers } });
    await tx.lastPaymentImport.updateMany({ where: { kind: "REGULAR", scopeKey: a.scopeKey, isActive: true, fileHash: { not: fileHash } }, data: { isActive: false } });
    const existing = await tx.lastPaymentImport.findUnique({ where: key(fileHash, "REGULAR", a.scopeKey) });
    if (existing) {
      if (!existing.isActive) await tx.lastPaymentImport.update({ where: { id: existing.id }, data: { isActive: true } });
      importId = existing.id; // idempotent retry: repairs the permanent records below without counting anything twice
    } else {
      const batch = await tx.lastPaymentImport.create({
        data: { kind: "REGULAR", scopeKey: a.scopeKey, fileHash, workbookName: a.filename, uploadedById: a.uploadedById, summary: JSON.stringify({ imported: valid.length, sourceFileHash: a.sourceFileHash }) },
      });
      if (valid.length)
        await tx.lastPaymentReceipt.createMany({
          data: valid.map((r) => ({ importId: batch.id, dealerId: r.dealerId, rowKey: JSON.stringify(["regular", r.sourceOrder]), sourceOrder: r.sourceOrder, receiptDate: new Date(`${r.date}T00:00:00Z`), creditAmount: r.amount })),
        });
      importId = batch.id;
      await writeAudit({ userId: a.uploadedById, action: "CREATE", entity: "lastPaymentImport", entityId: batch.id, summary: `Regular Day Book receipt retention: ${valid.length} receipt rows (${a.filename}); operational calculations unchanged.` }, tx);
    }
  }
  await acceptReceipts(tx, incoming, { sourceKind: "REGULAR", importId }, today);
  const problems = await missingPermanentPayments(tx, incoming, today, previous);
  if (problems.length) throw new Error(`Permanent Last Payment preservation incomplete (${problems.length}): ${problems.slice(0, 3).join("; ")}`);
  return { importId, outcome: superseded ? "SUPERSEDED" : "PROCESSED" };
}

/** Separate post-financial-commit retention (direct form: Recovery-eligible receipts only; throws when a newer monthly upload changed Recovery's values).
 * Replacements deactivate ONLY prior REGULAR receipt batches. Historical rows are never reset; failures must be surfaced without replaying monthly financial writes. */
export async function retainRegularReceipts(
  ctx: AuthContext,
  buffer: Buffer,
  filename: string,
  scopeKey: string,
  receipts: RegularReceipt[],
  expected: RegularDaybookState[],
) {
  assertAdmin(ctx);
  const valid = receipts.filter((r) => Number.isFinite(r.date.getTime()) && Number.isFinite(r.amount) && r.amount > 0 && r.amount < 1e12);
  const list: PaymentReceiptInput[] = valid.map((r) => ({ dealerId: r.dealerId, date: isoDay(r.date), amount: r.amount, sourceOrder: r.sourceOrder }));
  await prisma.$transaction(
    async (tx) => {
      await receiptLock(tx);
      await retainInTx(tx, {
        uploadedById: ctx.userId, sourceFileHash: hash(buffer), filename, scopeKey, paymentReceipts: list, recoveryReceipts: list,
        expected: expected.map((e) => ({ planId: e.planId, dealerId: e.dealerId, receipt: e.receipt, srCr: e.srCr, lastReceiptDate: e.lastReceiptDate ? isoDay(e.lastReceiptDate) : null, lastReceiptAmount: e.lastReceiptAmount })),
        supersededByNewer: false, onStale: "throw",
      });
    },
    { timeout: 60_000, maxWait: 10_000 }, // same budget as the monthly commit: this transaction also preserves earlier payments, and a remote database adds a round trip per query
  );
}

/* ---------------------------------------------- durable Last Payment jobs ---------------------------------------------- */

export interface JobOutcome { jobId: string; status: "DONE" | "FAILED"; outcome?: "PROCESSED" | "SUPERSEDED"; error?: string; uploadedById?: string }
/** A short, credential-free diagnostic: the error class and the first line of its message (connection strings never appear in application errors). */
const diagnostic = (e: unknown) => {
  const name = e instanceof Error ? e.name : "Error", msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  const line = msg.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return `${name}${typeof code === "string" ? ` ${code}` : ""}: ${line.replace(/postgres(ql)?:\/\/\S+/gi, "[redacted]").slice(0, 300)}`;
};

/**
 * Process ONE durable job (idempotent, safe to call any number of times, concurrently or late):
 *   • serialized with every other receipt writer by the receipt-store lock; a job that is already DONE is a no-op;
 *   • a job older than a DONE job of the same month only feeds the permanent ledger (newest-date / occurrence rules) — it never reactivates its obsolete import nor re-evaluates
 *     Recovery's state; a job whose Recovery state has since been replaced by a newer monthly upload is treated the same way;
 *   • it never writes any Recovery value. A failure rolls the attempt back whole, then records status FAILED + a diagnostic so the next trigger retries it.
 */
export async function processLastPaymentJob(jobId: string): Promise<JobOutcome> {
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        await receiptLock(tx);
        const job = await tx.lastPaymentJob.findUnique({ where: { id: jobId } });
        if (!job) throw new Error("Last Payment job not found");
        if (job.status === "DONE") return { importId: job.importId, outcome: (job.outcome as "PROCESSED" | "SUPERSEDED" | null) ?? "PROCESSED", uploadedById: job.uploadedById };
        const payload = job.payload as unknown as LastPaymentJobPayload;
        const newer = await tx.lastPaymentJob.findFirst({ where: { scopeKey: job.scopeKey, status: "DONE", createdAt: { gt: job.createdAt } }, select: { id: true } });
        const done = await retainInTx(tx, {
          uploadedById: job.uploadedById, sourceFileHash: job.sourceFileHash, filename: job.workbookName, scopeKey: job.scopeKey,
          paymentReceipts: payload.paymentReceipts, recoveryReceipts: payload.recoveryReceipts, expected: payload.expected, supersededByNewer: !!newer, onStale: "supersede",
        });
        await tx.lastPaymentJob.update({ where: { id: jobId }, data: { status: "DONE", outcome: done.outcome, importId: done.importId, attempts: { increment: 1 }, lastAttemptAt: new Date(), completedAt: new Date(), lastError: null } });
        return { ...done, uploadedById: job.uploadedById };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    return { jobId, status: "DONE", outcome: result.outcome, uploadedById: result.uploadedById };
  } catch (error) {
    const message = diagnostic(error);
    console.error("[daybook] Last Payment processing failed", message);
    await prisma.lastPaymentJob.updateMany({ where: { id: jobId, status: { not: "DONE" } }, data: { status: "FAILED", attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: message } }).catch(() => undefined);
    return { jobId, status: "FAILED", error: message };
  }
}

/** Retry every PENDING / FAILED job (oldest first, bounded) — called by each Day Book upload, so a failure (or a restart) is recovered by the next upload without any manual step. */
export async function processPendingLastPaymentJobs(opts: { exceptJobId?: string; limit?: number } = {}): Promise<JobOutcome[]> {
  const jobs = await prisma.lastPaymentJob.findMany({ where: { status: { in: ["PENDING", "FAILED"] }, ...(opts.exceptJobId ? { id: { not: opts.exceptJobId } } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: opts.limit ?? 10, select: { id: true } });
  const out: JobOutcome[] = [];
  for (const j of jobs) out.push(await processLastPaymentJob(j.id));
  return out;
}

/**
 * BEFORE a regular Day Book's monthly commit (which resets the month's per-plan "Last Payment" snapshot columns): make what the report shows now permanent for every dealer the
 * month's plans or the incoming receipts touch. Own short transaction under the receipt-store lock; touches no Recovery value. If it fails the upload stops BEFORE anything changed.
 */
export async function preserveBeforeDaybookCommit(monthRpdIds: readonly string[], incomingDealerIds: readonly string[]): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await receiptLock(tx);
      const rows = monthRpdIds.length ? await tx.recoveryPlanDealer.findMany({ where: { id: { in: [...monthRpdIds] } }, select: { dealerId: true } }) : [];
      await initializeDealers(tx, [...new Set([...rows.map((r) => r.dealerId), ...incomingDealerIds])], currentBusinessDate());
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
