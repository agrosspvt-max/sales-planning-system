/** Focused contracts for Create CN Request payload, validation, API response, and persistence. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import {
  buildCreateCnRequestPayload,
  CN_ACCEPTANCE_DETAILS_REQUIRED_MESSAGE,
  CN_ACCEPTANCE_REASON_REQUIRED_MESSAGE,
  CN_ACCEPTANCE_REASON_VALUES,
  CN_ACCEPTANCE_STATUS_REQUIRED_MESSAGE,
  CN_ACCEPTANCE_STATUS_VALUES,
  CN_EXPIRY_DAYS_INVALID_MESSAGE,
  CN_EXPIRY_DAYS_REQUIRED_MESSAGE,
  CN_POSTED_AMOUNT_INVALID_MESSAGE,
  CN_POSTED_AMOUNT_REQUIRED_MESSAGE,
  CN_OUTSTANDING_AMOUNT_INVALID_MESSAGE,
  CN_OUTSTANDING_AMOUNT_REQUIRED_MESSAGE,
  CN_PAYMENT_AMOUNT_INVALID_MESSAGE,
  CN_PAYMENT_AMOUNT_REQUIRED_MESSAGE,
  CN_PAYMENT_DATE_INVALID_MESSAGE,
  CN_PAYMENT_DATE_REQUIRED_MESSAGE,
  CN_PAYMENT_STATUS_REQUIRED_MESSAGE,
  CN_FOLLOW_UP_DATE_REQUIRED_MESSAGE,
  CN_REMAINING_AMOUNT_INVALID_MESSAGE,
  CN_REMAINING_AMOUNT_REQUIRED_MESSAGE,
  CN_PAYMENT_STATUS_VALUES,
  CN_PAYMENT_STATUSES,
  CN_REJECTION_DETAILS_REQUIRED_MESSAGE,
  CN_REJECTION_REASON_REQUIRED_MESSAGE,
  CN_REJECTION_REASON_VALUES,
  CN_REQUEST_DETAILS_REQUIRED_MESSAGE,
  CN_REQUEST_STATUSES,
  CN_REQUEST_VIEW_STATUSES,
  CN_TASK_DATE_OUTSIDE_EXPIRY_MESSAGE,
  CN_TASK_DATE_SUNDAY_MESSAGE,
  CN_TASK_DEFAULT_DATE_UNAVAILABLE_MESSAGE,
  CN_TYPE_OPTIONS,
  CN_TYPE_VALUES,
  CN_WORKING_MAX_BYTES,
  CN_WORKING_PDF_MIME,
  CN_WORKING_REQUIRED_MESSAGE,
  CN_WORKING_XLSX_MIME,
  canonicalCnType,
  cnActionMenuItems,
  cnRequestCurrentDisplayStatus,
  cnRequestAgeDays,
  cnRequestBusinessDateKey,
  cnRequestDisplayStatus,
  cnRequestExpiryDateKey,
  formatCnRequestDays,
  inclusiveCnRequestDays,
  isCnTaskDateWithinExpiry,
  isCnBusinessDateKey,
  isCnSundayDateKey,
  nextCnWorkingDateKey,
  paymentStatusLabel,
  validateCnAcceptance,
  validateCnRejection,
  validateCnRequestDetails,
} from "@/lib/cn-request";
import { DEFAULT_LABELS, labelMeta } from "@/features/labels/labels";

interface StoredRequest {
  id: string;
  officerId: string;
  dealerId: string;
  cnType: string;
  amount: number | null;
  postedAmount?: number | null;
  paymentStatus: string | null;
  paymentOriginalAmount?: number | null;
  paymentOutstandingAmount?: number | null;
  paymentTrackingMode?: string | null;
  paymentVerified?: boolean;
  details: string | null;
  status: string;
  rejectionReason?: string | null;
  rejectionReasonDetails?: string | null;
  acceptanceReason?: string | null;
  acceptanceReasonDetails?: string | null;
  cnExpiryDays?: number | null;
  cnWorkingDocument?: string | null;
  cnWorkingFileName?: string | null;
  cnWorkingMimeType?: string | null;
  cnWorkingFileSize?: number | null;
  cnWorkingUploadedById?: string | null;
  cnWorkingUploadedAt?: Date | null;
  remarks?: string | null;
  actedByRmId?: string | null;
  actedByAdminId?: string | null;
  acceptedAt?: Date | null;
  rejectedAt?: Date | null;
  postedAt?: Date | null;
  taskDate?: string | null; // "YYYY-MM-DD" | null
  legacyDailyWorkEntryId?: string | null;
  legacyDailyWorkContribution?: number | null;
  legacyDailyWorkConfirmed?: boolean;
  createdAt?: Date;
}

interface StoredPaymentEvent {
  id: string; cnRequestId: string; status: string; amountPaid: number | null; eventDate: Date;
  outstandingBefore: number; outstandingAfter: number; taskAmount: number | null; taskDate: Date | null;
  taskStatus: string | null; taskRescheduled: boolean; taskCompletedAt: Date | null; source: string; requestKey: string;
  dailyWorkEntryId?: string | null; dailyWorkContribution?: number | null; dailyWorkConfirmed?: boolean;
  recordedById: string; createdAt: Date;
}

class TestApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function makeStore() {
  const rows: StoredRequest[] = [];
  const paymentEvents: StoredPaymentEvent[] = [];
  const transactionTimeouts: Array<number | undefined> = [];
  let failLedgerPosting = false;
  const seed = (status: string, id = `cn-${rows.length + 1}`, officerId = "so-1", timestamps: Pick<StoredRequest, "createdAt" | "acceptedAt" | "rejectedAt" | "postedAt"> = {}, cnType = "CD") => {
    rows.push({ id, officerId, dealerId: "dealer-1", cnType, amount: 10000, postedAmount: null, paymentStatus: "Bill Paid", paymentOriginalAmount: null, paymentOutstandingAmount: null, paymentTrackingMode: null, details: "kept", status, rejectionReason: null, rejectionReasonDetails: null, acceptanceReason: null, acceptanceReasonDetails: null, cnExpiryDays: null, cnWorkingDocument: null, cnWorkingFileName: null, cnWorkingMimeType: null, cnWorkingFileSize: null, cnWorkingUploadedById: null, cnWorkingUploadedAt: null, remarks: null, acceptedAt: null, rejectedAt: null, postedAt: null, createdAt: new Date("2026-09-22T06:00:00.000Z"), ...timestamps });
    return id;
  };
  const related = (row: StoredRequest) => ({
    ...row,
    createdAt: row.createdAt ?? new Date("2026-09-22T06:00:00.000Z"),
    dealer: { name: "Dealer One" },
    officer: { name: "Officer One", territory: "North", group: { name: "State One" } },
    paymentEvents: paymentEvents.filter((event) => event.cnRequestId === row.id).map((event) => ({ ...event, recordedBy: { name: event.recordedById === "admin-1" ? "Admin One" : "Officer One" } })),
  });
  // Raw-SQL fake for the CN task queries (SELECT pending/by-date/by-id; UPDATE taskDate).
  const flat = (row: StoredRequest) => ({ id: row.id, dealerId: row.dealerId, amount: row.amount == null ? null : String(row.amount), acceptanceReason: row.acceptanceReason ?? null, acceptedAt: row.acceptedAt ?? null, cnExpiryDays: row.cnExpiryDays ?? null, taskDate: row.taskDate ?? null, partyName: "Dealer One", cnType: row.cnType, details: row.details, paymentStatus: row.paymentStatus, legacyDailyWorkConfirmed: row.legacyDailyWorkConfirmed ?? false });
  const runRaw = (sql: { sql: string; values: unknown[] }) => {
    const text = sql.sql.replace(/\s+/g, " ").trim();
    const v = sql.values;
    if (text.includes('FROM "CnRequest" c') && text.includes('FOR UPDATE OF c')) {
      const row = rows.find((r) => r.id === v[0]);
      return row ? [{ ...row }] : [];
    }
    if (text.startsWith('SELECT e."id" FROM "CnPaymentEvent" e') && text.includes("FOR UPDATE")) {
      return paymentEvents.some((event) => event.id === v[0]) ? [{ id: v[0] }] : [];
    }
    if (text.startsWith('SELECT c."id" FROM "CnRequest" c') && text.includes("FOR UPDATE")) {
      return rows.some((row) => row.id === v[0]) ? [{ id: v[0] }] : [];
    }
    // Auto Task confirmation state (new column, raw SQL only — the generated client predates it).
    if (text.startsWith('UPDATE "CnPaymentEvent" SET "dailyWorkConfirmed" = true')) {
      const event = paymentEvents.find((e) => e.id === v[0] && e.taskStatus === "SCHEDULED" && e.dailyWorkEntryId != null);
      if (!event) return 0; event.dailyWorkConfirmed = true; return 1;
    }
    if (text.startsWith('UPDATE "CnPaymentEvent" SET "dailyWorkConfirmed" = false')) {
      const event = paymentEvents.find((e) => e.id === v[0]);
      if (!event) return 0; event.dailyWorkConfirmed = false; return 1;
    }
    if (text.startsWith('UPDATE "CnRequest" SET "legacyDailyWorkConfirmed" = true')) {
      const row = rows.find((r) => r.id === v[0] && r.paymentTrackingMode == null && r.status === v[1] && r.legacyDailyWorkEntryId != null);
      if (!row) return 0; row.legacyDailyWorkConfirmed = true; return 1;
    }
    // entryInEditableRecovery: the given DailyWorkEntry id is a current-batch DRAFT Recovery row iff a live task
    // is materialized into it (this harness models the link on the task rows, not a DailyWorkEntry table).
    if (text.startsWith('SELECT "id" FROM "DailyWorkEntry"')) {
      const entryId = v[0] as string;
      const linked = paymentEvents.some((e) => e.dailyWorkEntryId === entryId) || rows.some((r) => r.legacyDailyWorkEntryId === entryId);
      return linked ? [{ id: entryId }] : [];
    }
    // Confirmation flags for a set of payment-event ids (materializedCnTasksForEntries).
    if (text.startsWith('SELECT "id", "dailyWorkConfirmed" AS "confirmed" FROM "CnPaymentEvent"')) {
      return paymentEvents.filter((e) => v.includes(e.id)).map((e) => ({ id: e.id, confirmed: e.dailyWorkConfirmed ?? false }));
    }
    // Unconfirmed-materialized-task counters used by the day-submit gate.
    if (text.includes('FROM "CnPaymentEvent" e') && text.includes('COUNT(*)') && text.includes('"dailyWorkConfirmed" = false')) {
      const [officerId, workDate, batchId] = v as string[];
      void workDate; void batchId;
      const n = paymentEvents.filter((e) => e.taskStatus === "SCHEDULED" && e.dailyWorkEntryId != null && (e.dailyWorkConfirmed ?? false) === false
        && rows.some((r) => r.id === e.cnRequestId && r.officerId === officerId)).length;
      return [{ n }];
    }
    if (text.includes('FROM "CnRequest" c') && text.includes('COUNT(*)') && text.includes('"legacyDailyWorkConfirmed" = false')) {
      const [officerId] = v as string[];
      const n = rows.filter((r) => r.officerId === officerId && r.paymentTrackingMode == null && r.legacyDailyWorkEntryId != null && (r.legacyDailyWorkConfirmed ?? false) === false).length;
      return [{ n }];
    }
    if (text.includes('AS "requestKeyCnRequestId"') && text.includes('AS "latestOutstandingBefore"')) {
      const existing = paymentEvents.find((event) => event.requestKey === v[0]);
      const latest = paymentEvents
        .filter((event) => event.cnRequestId === v[1])
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return [{
        requestKeyCnRequestId: existing?.cnRequestId ?? null,
        latestOutstandingBefore: latest?.outstandingBefore ?? null,
      }];
    }
    // paymentVerified is read/written via raw SQL (the generated client predates the column).
    if (text.startsWith("UPDATE \"CnRequest\" SET \"paymentVerified\" = true")) {
      const row = rows.find((r) => r.id === v[0]); if (!row) return 0; row.paymentVerified = true; return 1;
    }
    if (text.startsWith("UPDATE \"CnRequest\" SET \"paymentVerified\" = false")) {
      const row = rows.find((r) => r.id === v[0]); if (!row) return 0; row.paymentVerified = false; return 1;
    }
    if (text.startsWith("SELECT \"id\", \"paymentVerified\" FROM \"CnRequest\"")) {
      return rows.filter((r) => v.includes(r.id)).map((r) => ({ id: r.id, paymentVerified: r.paymentVerified ?? false }));
    }
    if (text.startsWith("SELECT \"paymentVerified\" FROM \"CnRequest\"")) {
      return rows.filter((r) => r.id === v[0]).map((r) => ({ paymentVerified: r.paymentVerified ?? false }));
    }
    if (text.startsWith("UPDATE \"CnRequest\" SET \"taskDate\"")) {
      // values: [taskDate, id, officerId, status]
      const row = rows.find((r) => r.id === v[1] && r.officerId === v[2] && r.paymentTrackingMode == null && r.status === v[3]);
      if (!row) return 0;
      row.taskDate = v[0] as string;
      return 1;
    }
    // SELECT ... FROM "CnRequest" c JOIN "Dealer" d ...
    if (text.includes('FROM "CnRequest" c JOIN "Dealer" d')) {
      if (text.includes('c."legacyDailyWorkEntryId" IN')) {
        // values: [officerId, status, ...entryIds]
        const officerId = v[0] as string, status = v[1] as string, entryIds = v.slice(2) as string[];
        return rows.filter((r) => r.officerId === officerId && r.paymentTrackingMode == null && r.status === status && r.legacyDailyWorkEntryId != null && entryIds.includes(r.legacyDailyWorkEntryId)).map(flat);
      }
      if (text.includes('c."id" =')) return rows.filter((r) => r.id === v[0]).map(flat);
      if (text.includes('c."taskDate" IS NULL')) {
        // values: [status, ...scopeIds?]
        const status = v[0] as string;
        const scopeIds = v.slice(1) as string[];
        const scoped = text.includes("AND FALSE") ? [] : rows.filter((r) => (scopeIds.length === 0 || scopeIds.includes(r.officerId)));
        return scoped.filter((r) => r.paymentTrackingMode == null && r.status === status && !r.taskDate).map(flat);
      }
      if (text.includes('c."taskDate" = ')) {
        // values: [officerId, status, workDate]
        const officerId = v[0] as string, status = v[1] as string, date = v[2] as string;
        return rows.filter((r) => r.paymentTrackingMode == null && r.officerId === officerId && r.status === status && r.taskDate === date).map(flat);
      }
      if (text.includes('ORDER BY c."taskDate" ASC')) {
        const status = v[0] as string;
        const scopeIds = v.slice(1) as string[];
        return rows.filter((r) => r.paymentTrackingMode == null && r.status === status && (scopeIds.length === 0 || scopeIds.includes(r.officerId))).map(flat);
      }
    }
    throw new Error("Unhandled raw SQL: " + text);
  };
  const normSql = (a: unknown, rest: unknown[]) => (Array.isArray(a) ? { sql: (a as string[]).join("?"), values: rest } : (a as { sql: string; values: unknown[] }));
  const prisma = {
    $queryRaw: async (a: unknown, ...rest: unknown[]) => runRaw(normSql(a, rest)),
    $executeRaw: async (a: unknown, ...rest: unknown[]) => runRaw(normSql(a, rest)),
    dealerAssignment: {
      findFirst: async ({ where }: { where: { officerId: string; dealerId: string; effectiveTo: null } }) =>
        where.officerId === "so-1" && where.dealerId === "dealer-1" && where.effectiveTo === null
          ? { id: "assignment-1" }
          : null,
    },
    cnRequest: {
      create: async ({ data }: { data: Omit<StoredRequest, "id"> }) => {
        const row = { id: `cn-${rows.length + 1}`, createdAt: new Date("2026-09-22T06:00:00.000Z"), ...data };
        rows.push(row);
        return { id: row.id };
      },
      findMany: async ({ where }: { where: { officerId?: { in: string[] }; status?: { in: string[] }; paymentStatus?: string; paymentVerified?: boolean; OR?: Array<{ paymentStatus?: null | { not: string }; paymentVerified?: boolean }> } }) => rows
        .filter((row) => !where.officerId || where.officerId.in.includes(row.officerId))
        .filter((row) => !where.status || where.status.in.includes(row.status))
        .filter((row) => where.paymentStatus === undefined || row.paymentStatus === where.paymentStatus)
        .filter((row) => where.paymentVerified === undefined || (row.paymentVerified ?? false) === where.paymentVerified)
        .filter((row) => !where.OR || where.OR.some((condition) => condition.paymentVerified !== undefined
          ? (row.paymentVerified ?? false) === condition.paymentVerified
          : condition.paymentStatus === null
            ? row.paymentStatus == null
            : row.paymentStatus !== condition.paymentStatus?.not))
        .map(related),
      findUnique: async ({ where, select }: { where: { id: string }; select?: { paymentEvents?: { where?: { taskStatus?: { in: string[] } }; take?: number } } }) => {
        const row = rows.find((item) => item.id === where.id);
        if (!row) return null;
        const result = related(row);
        const activeStatuses = select?.paymentEvents?.where?.taskStatus?.in;
        const paymentEventTake = select?.paymentEvents?.take;
        if (activeStatuses) {
          result.paymentEvents = result.paymentEvents
            .filter((event) => event.taskStatus != null && activeStatuses.includes(event.taskStatus))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, paymentEventTake ?? undefined);
        }
        return result;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredRequest> }) => {
        const row = rows.find((item) => item.id === where.id);
        if (!row) throw new Error("missing test row");
        Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
        return related(row);
      },
      updateMany: async ({ where, data }: { where: { id: string; status?: string; paymentStatus?: string | null; paymentOutstandingAmount?: unknown }; data: Partial<StoredRequest> }) => {
        if (failLedgerPosting && data.status === "POSTED_IN_LEDGER") throw new Error("simulated ledger write failure");
        const row = rows.find((item) => item.id === where.id && (!where.status || item.status === where.status) && (where.paymentStatus === undefined || item.paymentStatus === where.paymentStatus) && (where.paymentOutstandingAmount === undefined || Number(item.paymentOutstandingAmount) === Number(where.paymentOutstandingAmount)));
        if (!row) return { count: 0 };
        Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
        return { count: 1 };
      },
    },
    cnPaymentEvent: {
      create: async ({ data }: { data: Omit<StoredPaymentEvent, "id" | "createdAt" | "amountPaid" | "taskDate" | "taskRescheduled" | "taskCompletedAt"> & Partial<Pick<StoredPaymentEvent, "amountPaid" | "taskDate" | "taskRescheduled" | "taskCompletedAt">> }) => {
        if (paymentEvents.some((event) => event.requestKey === data.requestKey)) {
          throw Object.assign(new Error("duplicate request key"), { code: "P2002" });
        }
        // Monotonic createdAt so orderBy createdAt desc reliably picks the most recent event (real Date() can tie).
        const event: StoredPaymentEvent = { id: `pay-${paymentEvents.length + 1}`, createdAt: new Date(Date.now() + paymentEvents.length), amountPaid: null, taskDate: null, taskRescheduled: false, taskCompletedAt: null, ...data };
        paymentEvents.push(event); return { ...event };
      },
      findUnique: async ({ where }: { where: { id?: string; requestKey?: string } }) => {
        const event = paymentEvents.find((item) => where.id ? item.id === where.id : item.requestKey === where.requestKey);
        if (!event) return null;
        const request = rows.find((row) => row.id === event.cnRequestId)!;
        return { ...event, cnRequest: { ...related(request), dealer: { name: "Dealer One" } }, recordedBy: { name: event.recordedById === "admin-1" ? "Admin One" : "Officer One" } };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const event = paymentEvents.find((item) => item.id === where.id);
        if (!event) throw new Error("missing payment event");
        const request = rows.find((row) => row.id === event.cnRequestId)!;
        return { ...event, cnRequest: { ...related(request), dealer: { name: "Dealer One" } } };
      },
      findMany: async ({ where }: { where: { taskStatus?: string | { in: string[] }; dailyWorkEntryId?: null; taskDate?: Date; cnRequest?: { paymentTrackingMode?: string; officerId?: string | { in: string[] } } } }) => paymentEvents.filter((event) => {
        if (typeof where.taskStatus === "string" && event.taskStatus !== where.taskStatus) return false;
        if (where.taskStatus && typeof where.taskStatus !== "string" && !(event.taskStatus != null && where.taskStatus.in.includes(event.taskStatus))) return false;
        if (where.taskDate && event.taskDate?.toISOString().slice(0, 10) !== where.taskDate.toISOString().slice(0, 10)) return false;
        if (where.dailyWorkEntryId === null && event.dailyWorkEntryId != null) return false;
        const request = rows.find((row) => row.id === event.cnRequestId)!;
        if (where.cnRequest?.paymentTrackingMode && request.paymentTrackingMode !== where.cnRequest.paymentTrackingMode) return false;
        const officer = where.cnRequest?.officerId;
        if (typeof officer === "string" && request.officerId !== officer) return false;
        if (officer && typeof officer !== "string" && !officer.in.includes(request.officerId)) return false;
        return true;
      }).map((event) => { const request = rows.find((row) => row.id === event.cnRequestId)!; return { ...event, cnRequest: { ...related(request), dealer: { name: "Dealer One" } } }; }),
      findFirst: async ({ where, orderBy }: { where: { cnRequestId?: string; taskStatus?: { in: string[] } }; orderBy?: { createdAt?: "asc" | "desc" } }) => {
        const matches = paymentEvents.filter((event) => {
          if (where.cnRequestId && event.cnRequestId !== where.cnRequestId) return false;
          if (where.taskStatus?.in && !(event.taskStatus != null && where.taskStatus.in.includes(event.taskStatus))) return false;
          return true;
        });
        const dir = orderBy?.createdAt === "desc" ? -1 : 1;
        matches.sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
        const event = matches[0];
        if (!event) return null;
        const request = rows.find((row) => row.id === event.cnRequestId)!;
        return { ...event, cnRequest: { ...related(request), dealer: { name: "Dealer One" } }, recordedBy: { name: event.recordedById === "admin-1" ? "Admin One" : "Officer One" } };
      },
      updateMany: async ({ where, data }: { where: { id?: string; cnRequestId?: string; taskStatus?: string | null | { in: string[] } }; data: Partial<StoredPaymentEvent> }) => {
        const matches = paymentEvents.filter((item) => {
          if (where.id && item.id !== where.id) return false;
          if (where.cnRequestId && item.cnRequestId !== where.cnRequestId) return false;
          if (typeof where.taskStatus === "string" && item.taskStatus !== where.taskStatus) return false;
          if (where.taskStatus && typeof where.taskStatus !== "string" && !(item.taskStatus != null && where.taskStatus.in.includes(item.taskStatus))) return false;
          return true;
        });
        matches.forEach((event) => Object.assign(event, data));
        return { count: matches.length };
      },
    },
  };
  let transactionTail = Promise.resolve();
  const prismaWithTransaction = Object.assign(prisma, {
    $transaction: async <T>(fn: (tx: typeof prisma) => Promise<T>, options?: { timeout?: number }) => {
      transactionTimeouts.push(options?.timeout);
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const rowRefs = [...rows];
      const eventRefs = [...paymentEvents];
      const rowsBefore = structuredClone(rows);
      const eventsBefore = structuredClone(paymentEvents);
      try {
        return await fn(prisma);
      } catch (error) {
        rowsBefore.forEach((snapshot, index) => Object.assign(rowRefs[index]!, snapshot));
        eventsBefore.forEach((snapshot, index) => Object.assign(eventRefs[index]!, snapshot));
        rows.splice(0, rows.length, ...rowRefs.slice(0, rowsBefore.length));
        paymentEvents.splice(0, paymentEvents.length, ...eventRefs.slice(0, eventsBefore.length));
        throw error;
      } finally {
        release();
      }
    },
  });
  return {
    prisma: prismaWithTransaction,
    rows,
    paymentEvents,
    seed,
    transactionTimeouts,
    setFailLedgerPosting: (value: boolean) => { failLedgerPosting = value; },
  };
}

const localRequire = createRequire(import.meta.url);

function loadService(
  prisma: object,
  audits: Array<{ summary?: string | null }> = [],
  labelOverrides: Partial<Record<keyof typeof DEFAULT_LABELS, string>> = {},
  reversals: Array<{ entryId: string; contribution: number }> = [],
): typeof import("./service.server") {
  const filename = resolve("src/features/cn-requests/service.server.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const mocks: Record<string, unknown> = {
    "server-only": {},
    "@/lib/prisma": { prisma },
    "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (rows: unknown[]) => rows, dealerDisplayName: (n: string) => n },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/scope": { getOfficerScope: async (ctx: AuthContext) => ctx.role === Role.SUPER_ADMIN ? ({ all: true, ids: [] }) : ctx.role === Role.REGIONAL_MANAGER ? ({ all: false, ids: [ctx.userId, "so-1", "so-2"] }) : ({ all: false, ids: [ctx.userId] }) },
    "@/lib/audit": { writeAudit: async (entry: { summary?: string | null }) => { audits.push(entry); } },
    "@/lib/daily-work": { currentBusinessDate: () => cnRequestBusinessDateKey(new Date())! },
    "@/features/daily-work/day-lock.server": { lockDailyWorkDay: async () => ({ currentBatchId: "test-batch", status: "OPEN", selfRating: null, finalizedAt: null }) },
    "@/features/daily-work/auto-task-materialization.server": {
      reverseMaterializedDailyWorkContribution: async (_tx: unknown, input: { entryId: string; contribution: number }) => { reversals.push(input); },
    },
    "@/features/labels/service.server": { getResolvedLabels: async () => ({ ...DEFAULT_LABELS, ...labelOverrides }) },
    "@/lib/cn-request": {
      CN_PAYMENT_STATUSES,
      CN_ACCEPTANCE_DETAILS_REQUIRED_MESSAGE,
      CN_ACCEPTANCE_REASON_REQUIRED_MESSAGE,
      CN_ACCEPTANCE_REASON_VALUES,
      CN_ACCEPTANCE_STATUS_REQUIRED_MESSAGE,
      CN_ACCEPTANCE_STATUS_VALUES,
      CN_EXPIRY_DAYS_INVALID_MESSAGE,
      CN_EXPIRY_DAYS_REQUIRED_MESSAGE,
      CN_POSTED_AMOUNT_INVALID_MESSAGE,
      CN_POSTED_AMOUNT_REQUIRED_MESSAGE,
      CN_OUTSTANDING_AMOUNT_INVALID_MESSAGE,
      CN_OUTSTANDING_AMOUNT_REQUIRED_MESSAGE,
      CN_PAYMENT_AMOUNT_INVALID_MESSAGE,
      CN_PAYMENT_AMOUNT_REQUIRED_MESSAGE,
      CN_PAYMENT_DATE_INVALID_MESSAGE,
      CN_PAYMENT_DATE_REQUIRED_MESSAGE,
      CN_PAYMENT_STATUS_REQUIRED_MESSAGE,
      CN_FOLLOW_UP_DATE_REQUIRED_MESSAGE,
      CN_REMAINING_AMOUNT_INVALID_MESSAGE,
      CN_REMAINING_AMOUNT_REQUIRED_MESSAGE,
      CN_PAYMENT_STATUS_VALUES,
      CN_REJECTION_DETAILS_REQUIRED_MESSAGE,
      CN_REJECTION_REASON_REQUIRED_MESSAGE,
      CN_REJECTION_REASON_VALUES,
      CN_REQUEST_DETAILS_REQUIRED_MESSAGE,
      CN_REQUEST_STATUSES,
      CN_REQUEST_VIEW_STATUSES,
      CN_TASK_DATE_OUTSIDE_EXPIRY_MESSAGE,
      CN_TASK_DATE_SUNDAY_MESSAGE,
      CN_TASK_DEFAULT_DATE_UNAVAILABLE_MESSAGE,
      CN_TYPE_VALUES,
      CN_WORKING_MAX_BYTES,
      CN_WORKING_PDF_MIME,
      CN_WORKING_REQUIRED_MESSAGE,
      CN_WORKING_XLSX_MIME,
      canonicalCnType,
      cnRequestAgeDays,
      cnRequestBusinessDateKey,
      cnRequestDisplayStatus,
      cnRequestExpiryDateKey,
      cnTaskKindForReason: (reason: string | null | undefined) => (reason === "PAYMENT_PENDING" ? "CN_RECOVERY" : "CN_TASK"),
      cnTaskAmount: (reason: string | null | undefined, amount: number | null) => (reason === "PAYMENT_PENDING" ? amount : null),
      isCnTaskDateWithinExpiry,
      isCnBusinessDateKey,
      isCnSundayDateKey,
      nextCnWorkingDateKey,
      paymentStatusLabel,
    },
  };
  runInNewContext(code, {
    exports,
    Buffer,
    console,
    require: (id: string) =>
      id in mocks ? mocks[id] : localRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id),
  }, { filename });
  return exports as typeof import("./service.server");
}

function loadPost(createCnRequest: typeof import("./service.server").createCnRequest, ctx: AuthContext) {
  const filename = resolve("src/app/api/cn-requests/route.ts");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const handle = (fn: () => Promise<Response>) => fn().catch((error: unknown) => {
    const e = error as { status?: number; message?: string };
    return Response.json({ error: e.message ?? "Internal server error" }, { status: e.status ?? 500 });
  });
  const mocks: Record<string, unknown> = {
    "@/lib/http": {
      handle,
      ok: (data: unknown, status = 200) => Response.json(data, { status }),
      requireAuth: async () => ctx,
    },
    "@/features/cn-requests/service.server": { createCnRequest, listCnRequests: async () => [] },
  };
  runInNewContext(code, {
    exports,
    Request,
    Response,
    require: (id: string) => (id in mocks ? mocks[id] : localRequire(id)),
  }, { filename });
  return (exports as { POST: (req: Request) => Promise<Response> }).POST;
}

const SO: AuthContext = {
  userId: "so-1",
  role: Role.SALES_OFFICER,
  username: "officer",
  groupId: null,
};
const ADMIN: AuthContext = { userId: "admin-1", role: Role.SUPER_ADMIN, username: "admin", groupId: null };
const OTHER_SO: AuthContext = { userId: "so-other", role: Role.SALES_OFFICER, username: "other", groupId: null };
const PDF_UPLOAD = {
  name: "CN Working.pdf",
  type: CN_WORKING_PDF_MIME,
  buffer: Buffer.from("%PDF-1.7\nCN working test"),
};
const XLSX_UPLOAD = {
  name: "CN Working.xlsx",
  type: CN_WORKING_XLSX_MIME,
  buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x43, 0x4e]),
};

async function expect422(
  call: () => Promise<unknown>,
  message: string,
) {
  try {
    await call();
    assert.fail(`Expected 422: ${message}`);
  } catch (error) {
    assert.equal((error as TestApiError).status, 422);
    assert.equal((error as Error).message, message);
  }
}

async function expectStatus(call: () => Promise<unknown>, status: number) {
  await assert.rejects(call, (error: unknown) => (error as TestApiError).status === status);
}

async function main() {
  assert.deepEqual(CN_TYPE_OPTIONS.map((option) => option.label), [
    "Price diff",
    "Freight",
    "Scheme",
    "Demo",
    "Damage",
  ]);
  assert.ok(!CN_TYPE_OPTIONS.some((option) => option.label === "DD-Price difference"));
  assert.deepEqual([...CN_TYPE_VALUES], ["CD", "Freight", "Scheme", "Demo", "Damage"]);
  const priceDifference = CN_TYPE_OPTIONS.find((option) => option.label === "Price diff");
  assert.ok(priceDifference);
  assert.equal(priceDifference.value, "CD", "Price diff must retain its existing domain meaning (CD)");
  const freight = CN_TYPE_OPTIONS.find((option) => option.label === "Freight");
  assert.ok(freight);
  assert.equal(freight.value, "Freight", "Freight must use the same canonical value as its label");

  const browserPayload = buildCreateCnRequestPayload({
    dealerId: "dealer-1",
    cnType: priceDifference.value,
    details: "  test\n",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(browserPayload)), {
    dealerId: "dealer-1",
    cnType: "CD",
    details: "test",
  }, "the browser sends only Party, CN Type, and required Details");

  assert.equal(validateCnRequestDetails(""), CN_REQUEST_DETAILS_REQUIRED_MESSAGE);
  assert.equal(validateCnRequestDetails("   \n\t"), CN_REQUEST_DETAILS_REQUIRED_MESSAGE);
  assert.equal(validateCnRequestDetails("Valid request details"), null);
  const createPageSource = readFileSync(resolve("src/features/cn-requests/cn-requests-page.tsx"), "utf8");
  assert.match(createPageSource, /<Label>\{L\.details\} \*<\/Label>/);
  assert.match(createPageSource, /validateCnRequestDetails\(details, L\.detailsRequired\)/);
  assert.match(createPageSource, /<Textarea\s+required/);
  assert.doesNotMatch(createPageSource, /<Label>Approx Amount<\/Label>/);
  assert.doesNotMatch(createPageSource, /<Label>Payment Status \*<\/Label>/);
  assert.match(createPageSource, /<TableHead>\{labels\.paymentStatus\}<\/TableHead>/, "Payment Status remains visible and label-driven in the table");

  assert.deepEqual([...CN_REJECTION_REASON_VALUES], [
    "BILLING_CONDITION_NOT_MET",
    "PAYMENT_CONDITION_NOT_MET",
    "OTHER",
  ]);
  assert.equal(DEFAULT_LABELS["cn_requests.rejection.billing_condition_not_met"], "Billing Condition not met");
  assert.equal(DEFAULT_LABELS["cn_requests.rejection.payment_condition_not_met"], "Payment condition not met");
  assert.equal(DEFAULT_LABELS["cn_requests.rejection.other"], "Other");
  assert.equal(validateCnRejection("", ""), CN_REJECTION_REASON_REQUIRED_MESSAGE);
  assert.equal(validateCnRejection("OTHER", ""), CN_REJECTION_DETAILS_REQUIRED_MESSAGE);
  assert.equal(validateCnRejection("OTHER", " \n\t "), CN_REJECTION_DETAILS_REQUIRED_MESSAGE);
  assert.equal(validateCnRejection("OTHER", "Incorrect ledger condition"), null);
  assert.equal(validateCnRejection("BILLING_CONDITION_NOT_MET", ""), null);
  assert.ok(createPageSource.includes("setRejectTarget(r)"), "Reject opens the structured rejection dialog");
  assert.ok(createPageSource.includes('useState<CnRejectionReason | "">("")'), "the rejection reason starts unselected");
  assert.ok(createPageSource.includes('reason === "OTHER"'), "Other Reason is conditionally rendered");
  assert.match(createPageSource, /<Button variant="outline" onClick=\{onClose\} disabled=\{pending\}>\{labels\.cancel\}<\/Button>/);

  assert.deepEqual([...CN_ACCEPTANCE_STATUS_VALUES], ["ACCEPTED_NOT_POSTED", "POSTED_IN_LEDGER"]);
  assert.deepEqual([...CN_ACCEPTANCE_REASON_VALUES], ["PAYMENT_PENDING", "OTHER"]);
  assert.equal(DEFAULT_LABELS["cn_requests.acceptance.not_posted"], "Accepted, Not Posted");
  assert.equal(DEFAULT_LABELS["cn_requests.acceptance.posted"], "Accepted, Posted in Ledger");
  assert.equal(DEFAULT_LABELS["cn_requests.acceptance.payment_pending"], "Payment Pending");
  assert.equal(DEFAULT_LABELS["cn_requests.acceptance.cn_working"], "CN Working");
  assert.equal(DEFAULT_LABELS["cn_requests.acceptance.expiry_days"], "CN Expiry Date");
  assert.equal(DEFAULT_LABELS["cn_requests.col.expires"], "Expires");
  assert.equal(DEFAULT_LABELS["cn_requests.acceptance.posted_amount"], "Posted Amount");
  assert.equal(DEFAULT_LABELS["cn_requests.field.approval"], "Approval");
  assert.equal(DEFAULT_LABELS["cn_requests.field.payment_status"], "Payment Status");
  assert.equal(DEFAULT_LABELS["cn_requests.status.returned_from_ledger"], "Returned from Ledger");
  assert.deepEqual(labelMeta("cn_requests.status.returned_from_ledger"), { module: "CN Requests", group: "View Buttons" });
  assert.equal(DEFAULT_LABELS["cn_requests.payment.verify"], "Verify Payment");
  assert.equal(DEFAULT_LABELS["cn_requests.payment.partial_paid"], "Partial Paid");
  assert.equal(DEFAULT_LABELS["cn_requests.action.view_details"], "View Details");
  assert.equal(DEFAULT_LABELS["cn_requests.task.reschedule_type"], "Reschedule Type");
  assert.equal(DEFAULT_LABELS["cn_requests.task.next_working_day"], "Next Working Day");
  assert.equal(DEFAULT_LABELS["cn_requests.task.rescheduled"], "Rescheduled");
  assert.equal(DEFAULT_LABELS["daily_work.col.task_type"], "Task Type");
  assert.equal(DEFAULT_LABELS["daily_work.col.plan_type"], "Plan Type");
  assert.equal(DEFAULT_LABELS["daily_work.col.select_task_date"], "Select Task Date");
  assert.ok(createPageSource.includes('useLabel("cn_requests.field.approval")'));
  assert.ok(createPageSource.includes('useLabel("cn_requests.status.returned_from_ledger")'), "Returned from Ledger resolves through the configurable label system");
  assert.match(createPageSource, /RETURNED_FROM_LEDGER: "destructive"/, "Returned from Ledger reuses the red destructive badge variant");
  assert.ok(createPageSource.includes('useLabel("cn_requests.action.create_new_request")'));
  assert.equal(validateCnAcceptance({ status: "", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "", hasFile: false }), CN_ACCEPTANCE_STATUS_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "", hasFile: true }), CN_ACCEPTANCE_REASON_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "OTHER", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "", hasFile: true }), CN_ACCEPTANCE_DETAILS_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "OTHER", acceptanceReasonDetails: " \n\t ", expiryDays: "", postedAmount: "", hasFile: true }), CN_ACCEPTANCE_DETAILS_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "", hasFile: true }), CN_EXPIRY_DAYS_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", acceptanceReasonDetails: "", expiryDays: "0", postedAmount: "", hasFile: true }), CN_EXPIRY_DAYS_INVALID_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", acceptanceReasonDetails: "", expiryDays: "3", postedAmount: "", outstandingAmount: "", hasFile: true }), CN_OUTSTANDING_AMOUNT_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", acceptanceReasonDetails: "", expiryDays: "3", postedAmount: "", outstandingAmount: "0", hasFile: true }), CN_OUTSTANDING_AMOUNT_INVALID_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", acceptanceReasonDetails: "", expiryDays: "3", postedAmount: "", outstandingAmount: "12000", hasFile: false }), CN_WORKING_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "POSTED_IN_LEDGER", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "", hasFile: true }), CN_POSTED_AMOUNT_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "POSTED_IN_LEDGER", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "0", hasFile: true }), CN_POSTED_AMOUNT_INVALID_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "POSTED_IN_LEDGER", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "-1", hasFile: true }), CN_POSTED_AMOUNT_INVALID_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "POSTED_IN_LEDGER", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "abc", hasFile: true }), CN_POSTED_AMOUNT_INVALID_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "POSTED_IN_LEDGER", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "12000", hasFile: false }), CN_WORKING_REQUIRED_MESSAGE);
  assert.equal(validateCnAcceptance({ status: "POSTED_IN_LEDGER", reason: "", acceptanceReasonDetails: "", expiryDays: "", postedAmount: "12000", hasFile: true }), null);
  assert.equal(cnRequestExpiryDateKey("2026-09-23T10:00:00.000+05:30", 3), "2026-09-25");
  assert.equal(isCnTaskDateWithinExpiry("2026-09-23", "2026-09-23T10:00:00.000+05:30", 3), true);
  assert.equal(isCnTaskDateWithinExpiry("2026-09-25", "2026-09-23T10:00:00.000+05:30", 3), true);
  assert.equal(isCnTaskDateWithinExpiry("2026-09-26", "2026-09-23T10:00:00.000+05:30", 3), false);
  assert.equal(nextCnWorkingDateKey("2026-09-21"), "2026-09-22", "Monday defaults to Tuesday");
  assert.equal(nextCnWorkingDateKey("2026-09-25"), "2026-09-26", "Friday defaults to Saturday");
  assert.equal(nextCnWorkingDateKey("2026-09-26"), "2026-09-28", "Saturday skips Sunday and defaults to Monday");
  assert.equal(nextCnWorkingDateKey("2026-09-27"), "2026-09-28", "Sunday defaults to Monday");
  assert.equal(isCnSundayDateKey("2026-09-27"), true);
  assert.equal(isCnTaskDateWithinExpiry("2026-09-27", "2026-09-26T10:00:00.000+05:30", 3), false, "Sunday is rejected inside an otherwise valid expiry window");
  assert.equal(isCnBusinessDateKey("2026-02-31"), false);
  assert.ok(createPageSource.includes("<AcceptanceStatusAction"), "Submitted Admin actions use the acceptance-status selector");
  assert.ok(createPageSource.includes('value=""'), "the acceptance action has no default selection");
  assert.ok(createPageSource.includes('status === "ACCEPTED_NOT_POSTED"'), "reason fields are limited to Accepted, Not Posted");
  assert.ok(createPageSource.includes("labels.cnExpiryDays"), "Accepted, Not Posted shows the required expiry input");
  assert.ok(createPageSource.includes("labels.postedAmount"), "Posted in Ledger shows the required Posted Amount input");
  assert.ok(createPageSource.includes("labels.outstandingAmount"), "Payment Pending shows the required Outstanding Amount input");
  assert.ok(createPageSource.includes("showExpires && <TableHead>{labels.expires}</TableHead>"), "only the Accepted / Not Posted table adds Expires");
  assert.ok(createPageSource.includes('const showApproval = !isOfficer && section === "submitted-rejected"'), "Approval is limited to Submitted / Rejected");
  assert.ok(createPageSource.includes('{showApproval && <TableHead className="text-right">{labels.approval}</TableHead>}'), "Accepted tables do not render the Approval header");
  assert.ok(createPageSource.includes("onPostInLedger={canPost(r)"), "manual Post in Ledger remains available through the Accepted row Action menu");
  const acceptRouteSource = readFileSync(resolve("src/app/api/cn-requests/[id]/accept/route.ts"), "utf8");
  assert.ok(acceptRouteSource.includes('form.get("cnExpiryDays")'), "the multipart acceptance route forwards expiry days to the server");
  assert.ok(acceptRouteSource.includes('form.get("postedAmount")'), "the multipart acceptance route forwards Posted Amount to the server");
  assert.ok(acceptRouteSource.includes('form.get("outstandingAmount")'), "the multipart acceptance route forwards Outstanding Amount to the server");
  const dailyWorkSource = readFileSync(resolve("src/features/daily-work/daily-work-page.tsx"), "utf8");
  assert.ok(dailyWorkSource.includes("min={task.acceptanceDate ?? undefined}"), "Daily Work date inputs start at the acceptance date");
  assert.ok(dailyWorkSource.includes("max={task.expiryDate ?? undefined}"), "Daily Work date inputs end at the inclusive expiry date");
  assert.ok(dailyWorkSource.includes("isCnSundayDateKey(taskDate)"), "Daily Work rejects Sunday before saving");
  assert.ok(dailyWorkSource.includes('task.taskType === "CN_REQUEST" ? L.cnRequest'), "CN_REQUEST is displayed as CN Request");
  assert.ok(dailyWorkSource.includes('task.planType === "RECOVERY" ? L.recovery'), "RECOVERY is displayed as Recovery");
  assert.ok(dailyWorkSource.includes("<TableHead className=\"w-36\">{L.taskType}</TableHead>"), "Today's Auto Tasks renders Task Type");
  assert.ok(dailyWorkSource.includes("<TableHead className=\"w-36\">{L.planType}</TableHead>"), "Today's Auto Tasks renders Plan Type");
  assert.ok(!dailyWorkSource.includes("<TableHead>{L.rescheduleType}</TableHead>"), "CN Working table no longer shows the Reschedule Type column (removed by request; reschedule logic unchanged)");
  assert.ok(dailyWorkSource.includes("setDetailRequestId(task.cnRequestId)"), "View Details reuses the shared CN Request dialog");
  assert.match(createPageSource, /accept="\.pdf,\.xlsx,application\/pdf,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/);
  assert.ok(!createPageSource.includes('action: "accept"'), "the old direct JSON Accept action is removed from the UI");

  const store = makeStore();
  const service = loadService(store.prisma);
  const POST = loadPost(service.createCnRequest, SO);

  const customLabelService = loadService(store.prisma, [], {
    "cn_requests.validation.details_required": "Explain the CN request.",
  });
  await expect422(
    () => customLabelService.createCnRequest(SO, { dealerId: "dealer-1", cnType: "CD", details: "   " }),
    "Explain the CN request.",
  );

  // Exact reproduced form: successful API response and database persistence.
  const response = await POST(new Request("http://localhost/api/cn-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(browserPayload),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "cn-1" });
  assert.deepEqual(store.rows[0], {
    id: "cn-1",
    officerId: "so-1",
    dealerId: "dealer-1",
    cnType: "CD",
    amount: null,
    paymentStatus: null,
    details: "test",
    status: "SUBMITTED",
    createdAt: new Date("2026-09-22T06:00:00.000Z"),
  });

  const missingDetailsResponse = await POST(new Request("http://localhost/api/cn-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...browserPayload, details: undefined }),
  }));
  assert.equal(missingDetailsResponse.status, 422);
  assert.deepEqual(await missingDetailsResponse.json(), { error: CN_REQUEST_DETAILS_REQUIRED_MESSAGE });

  const valid = { ...browserPayload };
  await expect422(() => service.createCnRequest(SO, { ...valid, cnType: "not-a-type" }), "Select a valid CN type");
  await expect422(() => service.createCnRequest(SO, { ...valid, cnType: undefined }), "Select a valid CN type");
  // The neutral CN Type placeholder ("") is not a valid business value and must be rejected server-side.
  await expect422(() => service.createCnRequest(SO, { ...valid, cnType: "" }), "Select a valid CN type");
  await expect422(() => service.createCnRequest(SO, { ...valid, dealerId: "" }), "Select a party");
  await expect422(() => service.createCnRequest(SO, { ...valid, dealerId: "not-assigned" }), "That party is not assigned to the selected Sales Officer");
  await expect422(() => service.createCnRequest(SO, { ...valid, details: "" }), CN_REQUEST_DETAILS_REQUIRED_MESSAGE);
  await expect422(() => service.createCnRequest(SO, { ...valid, details: " \n\t " }), CN_REQUEST_DETAILS_REQUIRED_MESSAGE);

  assert.equal(store.rows.length, 1, "rejected requests must not be persisted");

  const unusedCreateFieldsStore = makeStore();
  await loadService(unusedCreateFieldsStore.prisma).createCnRequest(SO, {
    ...browserPayload,
    amount: 99999,
    paymentStatus: "Bill Paid",
  });
  assert.equal(unusedCreateFieldsStore.rows[0]?.amount, null, "the create API no longer accepts Approx Amount");
  assert.equal(unusedCreateFieldsStore.rows[0]?.paymentStatus, null, "the create API no longer accepts Payment Status");

  // Freight is canonical through form payload, service validation, and persistence; legacy FRAT is rejected.
  const freightPayload = buildCreateCnRequestPayload({
    dealerId: "dealer-1",
    cnType: freight.value,
    details: "freight claim",
  });
  assert.equal(freightPayload.cnType, "Freight");
  const freightStore = makeStore();
  const freightService = loadService(freightStore.prisma);
  const freightPost = loadPost(freightService.createCnRequest, SO);
  const freightResponse = await freightPost(new Request("http://localhost/api/cn-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(freightPayload),
  }));
  assert.equal(freightResponse.status, 200);
  assert.equal(freightStore.rows[0]?.cnType, "Freight");
  assert.equal(freightStore.rows[0]?.amount, null, "new requests do not collect Approx Amount");
  assert.equal(freightStore.rows[0]?.paymentStatus, null, "new requests do not collect or derive Payment Status");
  await expect422(
    () => freightService.createCnRequest(SO, { ...freightPayload, cnType: "FRAT" }),
    "Select a valid CN type",
  );
  assert.ok(freightStore.rows.every((row) => row.cnType !== "FRAT"), "new requests must never persist FRAT");

  // Historical FRAT rows remain readable as Freight until the exact-value migration is deployed.
  const historyStore = makeStore();
  historyStore.seed("SUBMITTED", "cn-historical-frat", "so-1", {}, "FRAT");
  historyStore.rows[0]!.details = null;
  const historyService = loadService(historyStore.prisma);
  const historicalRow = (await historyService.listCnRequests(ADMIN, "submitted"))[0];
  assert.equal(historicalRow?.cnType, "Freight");
  assert.equal(historicalRow?.details, null, "historical requests without Details remain readable");
  assert.equal(canonicalCnType("Scheme"), "Scheme", "other CN types remain unchanged");
  const freightMigration = readFileSync(resolve("prisma/migrations/20260922010000_cn_request_freight_canonical/migration.sql"), "utf8");
  assert.match(freightMigration, /SET "cnType" = 'Freight'/);
  assert.match(freightMigration, /WHERE "cnType" = 'FRAT'/);
  const rejectionMigration = readFileSync(resolve("prisma/migrations/20260922020000_cn_request_rejection_reason/migration.sql"), "utf8");
  assert.match(rejectionMigration, /ADD COLUMN "rejectionReason" TEXT/);
  assert.match(rejectionMigration, /ADD COLUMN "rejectionReasonDetails" TEXT/);
  assert.doesNotMatch(rejectionMigration, /UPDATE "CnRequest"/, "historical reasons must never be invented");

  const acceptanceMigration = readFileSync(resolve("prisma/migrations/20260922030000_cn_request_acceptance/migration.sql"), "utf8");
  for (const column of [
    "acceptanceReason", "acceptanceReasonDetails", "cnWorkingDocument", "cnWorkingFileName",
    "cnWorkingMimeType", "cnWorkingFileSize", "cnWorkingUploadedById", "cnWorkingUploadedAt",
  ]) assert.match(acceptanceMigration, new RegExp(`ADD COLUMN "${column}"`));
  assert.doesNotMatch(acceptanceMigration, /UPDATE "CnRequest"/, "historical acceptance records must not be rewritten");
  const expiryMigration = readFileSync(resolve("prisma/migrations/20260923000000_cn_request_expiry/migration.sql"), "utf8");
  assert.match(expiryMigration, /ADD COLUMN "cnExpiryDays" INTEGER/);
  assert.doesNotMatch(expiryMigration, /UPDATE "CnRequest"/, "historical accepted rows must not receive invented expiry values");
  const postedAmountMigration = readFileSync(resolve("prisma/migrations/20260923010000_cn_request_posted_amount/migration.sql"), "utf8");
  assert.match(postedAmountMigration, /ALTER COLUMN "paymentStatus" DROP NOT NULL/);
  assert.match(postedAmountMigration, /ADD COLUMN "postedAmount" DECIMAL\(14,2\)/);
  assert.doesNotMatch(postedAmountMigration, /DROP COLUMN|UPDATE "CnRequest"/, "historical Amount and Payment Status data must remain untouched");
  const paymentMigration = readFileSync(resolve("prisma/migrations/20260923020000_cn_payment_tracking/migration.sql"), "utf8");
  assert.match(paymentMigration, /ADD COLUMN "paymentOriginalAmount" DECIMAL\(14,2\)/);
  assert.match(paymentMigration, /CREATE TABLE "CnPaymentEvent"/);
  assert.match(paymentMigration, /CREATE UNIQUE INDEX "CnPaymentEvent_requestKey_key"/);
  assert.doesNotMatch(paymentMigration, /UPDATE "CnRequest"/, "legacy requests and task dates must not be backfilled");

  // New Admin workflow: Submitted → Accepted / Not Posted → Posted in Ledger.
  const initiallySubmitted = await service.listCnRequests(ADMIN, "submitted");
  assert.equal(initiallySubmitted.length, 1);
  assert.equal(initiallySubmitted[0]?.id, "cn-1");
  assert.equal(initiallySubmitted[0]?.status, "SUBMITTED");
  assert.equal(initiallySubmitted[0]?.details, "test");
  await expectStatus(() => service.actOnCnRequest(ADMIN, "cn-1", { action: "accept" }), 422);
  await expect422(
    () => service.acceptCnRequest(ADMIN, "cn-1", { status: "ACCEPTED_NOT_POSTED" }, PDF_UPLOAD),
    CN_ACCEPTANCE_REASON_REQUIRED_MESSAGE,
  );
  await expect422(
    () => service.acceptCnRequest(ADMIN, "cn-1", { status: "ACCEPTED_NOT_POSTED", reason: "OTHER", acceptanceReasonDetails: " \n\t " }, PDF_UPLOAD),
    CN_ACCEPTANCE_DETAILS_REQUIRED_MESSAGE,
  );
  await expect422(
    () => service.acceptCnRequest(ADMIN, "cn-1", { status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING" }, null),
    CN_EXPIRY_DAYS_REQUIRED_MESSAGE,
  );
  await expect422(
    () => service.acceptCnRequest(ADMIN, "cn-1", { status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 0 }, PDF_UPLOAD),
    CN_EXPIRY_DAYS_INVALID_MESSAGE,
  );
  await expect422(
    () => service.acceptCnRequest(ADMIN, "cn-1", { status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 3, outstandingAmount: 12000 }, null),
    CN_WORKING_REQUIRED_MESSAGE,
  );
  await expect422(
    () => service.acceptCnRequest(ADMIN, "cn-1", { status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 1, outstandingAmount: 12000 }, PDF_UPLOAD),
    CN_TASK_DEFAULT_DATE_UNAVAILABLE_MESSAGE,
  );
  assert.equal(store.rows.find((row) => row.id === "cn-1")?.status, "SUBMITTED", "invalid acceptance attempts leave the request unchanged");

  const acceptanceAudits: Array<{ summary?: string | null }> = [];
  const acceptanceService = loadService(store.prisma, acceptanceAudits);
  assert.equal((await acceptanceService.acceptCnRequest(
    ADMIN,
    "cn-1",
    { status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 3, outstandingAmount: 12000 },
    PDF_UPLOAD,
  )).status, "ACCEPTED_NOT_POSTED");
  const accepted = store.rows.find((row) => row.id === "cn-1")!;
  assert.equal(accepted.acceptanceReason, "PAYMENT_PENDING");
  assert.equal(accepted.acceptanceReasonDetails, null);
  assert.equal(accepted.cnExpiryDays, 3);
  assert.equal(accepted.paymentStatus, "Pending");
  assert.equal(accepted.paymentOriginalAmount, 12000);
  assert.equal(accepted.paymentOutstandingAmount, 12000);
  assert.equal(accepted.paymentTrackingMode, "PAYMENT_V1");
  assert.equal(store.paymentEvents.length, 1, "Payment Pending creates exactly one initial Recovery task event");
  assert.equal(store.paymentEvents[0]?.taskStatus, "SCHEDULED");
  assert.equal(store.paymentEvents[0]?.taskDate?.toISOString().slice(0, 10), nextCnWorkingDateKey(accepted.acceptedAt!));
  assert.equal(store.paymentEvents[0]?.taskRescheduled, false, "automatic scheduling starts as Next Working Day");
  assert.equal(accepted.cnWorkingFileName, PDF_UPLOAD.name);
  assert.equal(accepted.cnWorkingMimeType, PDF_UPLOAD.type);
  assert.equal(accepted.cnWorkingFileSize, PDF_UPLOAD.buffer.length);
  assert.equal(accepted.cnWorkingUploadedById, ADMIN.userId);
  assert.ok(accepted.cnWorkingDocument?.startsWith(`data:${CN_WORKING_PDF_MIME};base64,`));
  assert.ok(accepted.cnWorkingUploadedAt);
  assert.ok(accepted.acceptedAt, "accept persists its authoritative timestamp");
  assert.equal(accepted.postedAt, null);
  assert.match(acceptanceAudits.at(-1)?.summary ?? "", /accepted, not posted/);
  assert.match(acceptanceAudits.at(-1)?.summary ?? "", /Reason: PAYMENT_PENDING/);
  assert.match(acceptanceAudits.at(-1)?.summary ?? "", /CN Expiry: 3 days/);
  assert.match(acceptanceAudits.at(-1)?.summary ?? "", /CN working: CN Working\.pdf/);
  assert.equal((await service.listCnRequests(ADMIN, "submitted")).length, 0);
  const notPostedRows = await service.listCnRequests(ADMIN, "accepted-not-posted");
  assert.equal(notPostedRows.map((r) => r.id).join(","), "cn-1");
  assert.equal(notPostedRows[0]?.acceptanceReason, "PAYMENT_PENDING");
  assert.equal(notPostedRows[0]?.cnExpiryDays, 3);
  assert.equal(notPostedRows[0]?.expiryDate, cnRequestExpiryDateKey(accepted.acceptedAt!, 3));
  assert.equal(JSON.stringify(notPostedRows[0]?.cnWorking), JSON.stringify({
    fileName: PDF_UPLOAD.name,
    mimeType: PDF_UPLOAD.type,
    fileSize: PDF_UPLOAD.buffer.length,
    uploadedAt: accepted.cnWorkingUploadedAt!.toISOString(),
  }));
  assert.equal(
    notPostedRows[0]?.days,
    inclusiveCnRequestDays(accepted.createdAt!, accepted.acceptedAt!),
    "Accepted / Not Posted Days use submission through acceptance",
  );

  const ownerDocument = await service.getCnWorkingDocument(SO, "cn-1");
  assert.equal(ownerDocument.fileName, PDF_UPLOAD.name);
  assert.equal(ownerDocument.mimeType, PDF_UPLOAD.type);
  assert.deepEqual(ownerDocument.buffer, PDF_UPLOAD.buffer, "the owner can retrieve the persisted document bytes");
  await expectStatus(() => service.getCnWorkingDocument(OTHER_SO, "cn-1"), 403);
  assert.deepEqual((await service.getCnWorkingDocument(ADMIN, "cn-1")).buffer, PDF_UPLOAD.buffer);

  accepted.taskDate = "2099-09-25";
  await expect422(
    () => acceptanceService.acceptCnRequest(ADMIN, "cn-1", { status: "POSTED_IN_LEDGER" }, null),
    CN_POSTED_AMOUNT_REQUIRED_MESSAGE,
  );
  await expect422(
    () => acceptanceService.acceptCnRequest(ADMIN, "cn-1", { status: "POSTED_IN_LEDGER", postedAmount: 0 }, null),
    CN_POSTED_AMOUNT_INVALID_MESSAGE,
  );
  assert.equal((await acceptanceService.acceptCnRequest(
    ADMIN,
    "cn-1",
    { status: "POSTED_IN_LEDGER", postedAmount: 12000 },
    null,
  )).status, "POSTED_IN_LEDGER");
  assert.ok(store.rows.find((row) => row.id === "cn-1")?.postedAt, "posting persists its authoritative timestamp");
  assert.equal(store.rows.find((row) => row.id === "cn-1")?.postedAmount, 12000);
  assert.equal(store.rows.find((row) => row.id === "cn-1")?.taskDate, "2099-09-25", "posting preserves the previously scheduled task date");
  assert.equal(store.rows.find((row) => row.id === "cn-1")?.acceptanceReason, "PAYMENT_PENDING", "posting preserves the prior reason");
  assert.equal(store.rows.find((row) => row.id === "cn-1")?.cnExpiryDays, 3, "posting preserves the prior expiry");
  assert.equal(store.rows.find((row) => row.id === "cn-1")?.cnWorkingFileName, PDF_UPLOAD.name, "later posting preserves the acceptance document");
  const workingAfterSecondStep = await service.listCnRequests(ADMIN, "accepted-not-posted");
  assert.equal(workingAfterSecondStep.map((r) => r.id).join(","), "cn-1", "non-Paid remains in CN Working Shared even after ledger posting");
  assert.equal((await service.listCnRequests(ADMIN, "posted-in-ledger")).length, 0, "Pending never qualifies for the payment-driven Posted section");
  assert.equal(workingAfterSecondStep[0]?.amount, 12000, "the Amount column uses the actual Posted Amount");
  assert.equal(workingAfterSecondStep[0]?.postedAmount, 12000);
  assert.equal(workingAfterSecondStep[0]?.paymentStatus, "Pending", "posting does not change the independent Payment Status");
  assert.equal(
    workingAfterSecondStep[0]?.days,
    inclusiveCnRequestDays(accepted.createdAt!, accepted.postedAt!),
    "Posted Days use submission through posting",
  );

  // Direct Accepted, Posted in Ledger requires no reason, persists an XLSX, and sets both timestamps.
  const directPostedStore = makeStore();
  const directPostedId = directPostedStore.seed("SUBMITTED", "cn-direct-posted");
  const directPostedService = loadService(directPostedStore.prisma);
  await expect422(
    () => directPostedService.acceptCnRequest(ADMIN, directPostedId, { status: "POSTED_IN_LEDGER" }, XLSX_UPLOAD),
    CN_POSTED_AMOUNT_REQUIRED_MESSAGE,
  );
  await expect422(
    () => directPostedService.acceptCnRequest(ADMIN, directPostedId, { status: "POSTED_IN_LEDGER", postedAmount: -1 }, XLSX_UPLOAD),
    CN_POSTED_AMOUNT_INVALID_MESSAGE,
  );
  await expect422(
    () => directPostedService.acceptCnRequest(ADMIN, directPostedId, { status: "POSTED_IN_LEDGER", postedAmount: "not-a-number" }, XLSX_UPLOAD),
    CN_POSTED_AMOUNT_INVALID_MESSAGE,
  );
  assert.equal((await directPostedService.acceptCnRequest(
    ADMIN,
    directPostedId,
    { status: "POSTED_IN_LEDGER", postedAmount: 15000 },
    XLSX_UPLOAD,
  )).status, "POSTED_IN_LEDGER");
  const directPosted = directPostedStore.rows[0]!;
  assert.equal(directPosted.acceptanceReason, null);
  assert.equal(directPosted.acceptanceReasonDetails, null);
  assert.equal(directPosted.cnExpiryDays, null, "direct Posted in Ledger does not create a scheduling expiry");
  assert.equal(directPosted.postedAmount, 15000);
  assert.equal(directPosted.amount, 10000, "historical Approx Amount data remains intact");
  assert.equal(directPosted.paymentStatus, "Bill Paid", "existing Payment Status remains intact");
  assert.equal(directPosted.cnWorkingFileName, XLSX_UPLOAD.name);
  assert.equal(directPosted.cnWorkingMimeType, XLSX_UPLOAD.type);
  assert.equal(directPosted.acceptedAt?.toISOString(), directPosted.postedAt?.toISOString());
  const directPostedRow = (await directPostedService.listCnRequests(ADMIN, "accepted-not-posted"))[0]!;
  assert.equal((await directPostedService.listCnRequests(ADMIN, "posted-in-ledger")).length, 0, "legacy Bill Paid is not the canonical Paid status");
  assert.equal(directPostedRow.amount, 15000, "Posted in Ledger displays the actual posted amount");
  assert.equal(directPostedRow.postedAmount, 15000);
  assert.equal(directPostedRow.days, inclusiveCnRequestDays(directPosted.createdAt!, directPosted.postedAt!));
  assert.deepEqual((await directPostedService.getCnWorkingDocument(SO, directPostedId)).buffer, XLSX_UPLOAD.buffer);

  // Other acceptance reason is trimmed and persisted only for Accepted / Not Posted.
  const otherAcceptanceStore = makeStore();
  const otherAcceptanceId = otherAcceptanceStore.seed("SUBMITTED", "cn-other-acceptance");
  const otherAcceptanceService = loadService(otherAcceptanceStore.prisma);
  await otherAcceptanceService.acceptCnRequest(
    ADMIN,
    otherAcceptanceId,
    { status: "ACCEPTED_NOT_POSTED", reason: "OTHER", acceptanceReasonDetails: "  Dealer payment expected next week.  ", cnExpiryDays: 3 },
    XLSX_UPLOAD,
  );
  assert.equal(otherAcceptanceStore.rows[0]?.acceptanceReason, "OTHER");
  assert.equal(otherAcceptanceStore.rows[0]?.acceptanceReasonDetails, "Dealer payment expected next week.");
  assert.equal(otherAcceptanceStore.rows[0]?.paymentTrackingMode, "NONE");
  assert.equal(otherAcceptanceStore.rows[0]?.paymentStatus, "Bill Paid", "Other does not change an existing Payment Status");
  assert.equal(otherAcceptanceStore.paymentEvents.length, 0, "Other creates no Recovery task or payment history");

  // File type, content, and size validation are authoritative and do not transition the request.
  const invalidFileStore = makeStore();
  const invalidFileId = invalidFileStore.seed("SUBMITTED", "cn-invalid-file");
  const invalidFileService = loadService(invalidFileStore.prisma);
  await expect422(
    () => invalidFileService.acceptCnRequest(ADMIN, invalidFileId, { status: "POSTED_IN_LEDGER", postedAmount: 100 }, { name: "working.png", type: "image/png", buffer: Buffer.from("image") }),
    "CN Working document must be a PDF or XLSX file.",
  );
  await expect422(
    () => invalidFileService.acceptCnRequest(ADMIN, invalidFileId, { status: "POSTED_IN_LEDGER", postedAmount: 100 }, { name: "working.pdf", type: CN_WORKING_PDF_MIME, buffer: Buffer.from("not a PDF") }),
    "CN Working document content does not match its file type.",
  );
  await expect422(
    () => invalidFileService.acceptCnRequest(ADMIN, invalidFileId, { status: "POSTED_IN_LEDGER", postedAmount: 100 }, { name: "working.xlsx", type: CN_WORKING_XLSX_MIME, buffer: Buffer.alloc(CN_WORKING_MAX_BYTES + 1) }),
    "CN Working document must be smaller than 3.5 MB.",
  );
  assert.equal(invalidFileStore.rows[0]?.status, "SUBMITTED");

  // Structured rejection validation is authoritative on the server.
  const rejectedId = store.seed("SUBMITTED", "cn-rejected");
  const rejectionAudits: Array<{ summary?: string | null }> = [];
  const rejectionService = loadService(store.prisma, rejectionAudits);
  await expect422(() => rejectionService.actOnCnRequest(ADMIN, rejectedId, { action: "reject" }), CN_REJECTION_REASON_REQUIRED_MESSAGE);
  await expect422(() => rejectionService.actOnCnRequest(ADMIN, rejectedId, { action: "reject", reason: "UNKNOWN" }), CN_REJECTION_REASON_REQUIRED_MESSAGE);
  await expect422(() => rejectionService.actOnCnRequest(ADMIN, rejectedId, { action: "reject", reason: "OTHER" }), CN_REJECTION_DETAILS_REQUIRED_MESSAGE);
  await expect422(() => rejectionService.actOnCnRequest(ADMIN, rejectedId, { action: "reject", reason: "OTHER", rejectionReasonDetails: " \n\t " }), CN_REJECTION_DETAILS_REQUIRED_MESSAGE);
  assert.equal(store.rows.find((row) => row.id === rejectedId)?.status, "SUBMITTED", "invalid rejection payloads do not change the request");

  assert.equal((await rejectionService.actOnCnRequest(ADMIN, rejectedId, { action: "reject", reason: "BILLING_CONDITION_NOT_MET" })).status, "REJECTED");
  const billingRejected = store.rows.find((row) => row.id === rejectedId)!;
  assert.equal(billingRejected.rejectionReason, "BILLING_CONDITION_NOT_MET");
  assert.equal(billingRejected.rejectionReasonDetails, null);
  assert.ok(billingRejected.rejectedAt, "rejection persists its authoritative timestamp");
  assert.match(rejectionAudits.at(-1)?.summary ?? "", /Reason: BILLING_CONDITION_NOT_MET/);
  assert.equal(
    cnRequestAgeDays({ status: billingRejected.status, createdAt: billingRejected.createdAt!, rejectedAt: billingRejected.rejectedAt! }, new Date("2026-10-01T00:00:00.000Z")),
    inclusiveCnRequestDays(billingRejected.createdAt!, billingRejected.rejectedAt!),
    "rejected Days freezes at the authoritative rejection timestamp",
  );
  assert.equal((await service.listCnRequests(ADMIN, "rejected")).map((r) => r.id).join(","), rejectedId);
  await assert.rejects(() => service.actOnCnRequest(ADMIN, rejectedId, { action: "post" }), (error: unknown) => (error as TestApiError).status === 422);

  const paymentStore = makeStore();
  const paymentId = paymentStore.seed("SUBMITTED", "cn-payment-reason");
  const paymentService = loadService(paymentStore.prisma);
  await paymentService.actOnCnRequest(ADMIN, paymentId, { action: "reject", reason: "PAYMENT_CONDITION_NOT_MET" });
  assert.equal(paymentStore.rows[0]?.rejectionReason, "PAYMENT_CONDITION_NOT_MET");
  assert.equal(paymentStore.rows[0]?.rejectionReasonDetails, null);

  const otherStore = makeStore();
  const otherId = otherStore.seed("SUBMITTED", "cn-other-reason");
  const otherService = loadService(otherStore.prisma);
  await otherService.actOnCnRequest(ADMIN, otherId, { action: "reject", reason: "OTHER", rejectionReasonDetails: "  Supporting invoice is incorrect.  " });
  assert.equal(otherStore.rows[0]?.rejectionReason, "OTHER");
  assert.equal(otherStore.rows[0]?.rejectionReasonDetails, "Supporting invoice is incorrect.");

  // Historical rejected rows have no invented structured reason and remain readable with legacy remarks.
  const legacyRejectionStore = makeStore();
  legacyRejectionStore.seed("REJECTED", "cn-legacy-rejected", "so-1", { rejectedAt: new Date("2026-09-22T08:00:00.000Z") });
  legacyRejectionStore.rows[0]!.remarks = "Legacy free-text reason";
  const legacyRejectedRow = (await loadService(legacyRejectionStore.prisma).listCnRequests(ADMIN, "rejected"))[0];
  assert.equal(legacyRejectedRow?.rejectionReason, null);
  assert.equal(legacyRejectedRow?.rejectionReasonDetails, null);
  assert.equal(legacyRejectedRow?.remarks, "Legacy free-text reason");

  // The old JSON post action is blocked; posting must use the controlled Admin multipart flow.
  const submittedId = store.seed("SUBMITTED", "cn-submitted");
  await assert.rejects(() => service.actOnCnRequest(ADMIN, submittedId, { action: "post" }), (error: unknown) => (error as TestApiError).status === 422);
  await expectStatus(
    () => service.acceptCnRequest(SO, submittedId, { status: "POSTED_IN_LEDGER" }, PDF_UPLOAD),
    403,
  );
  await expectStatus(
    () => service.acceptCnRequest(ADMIN, rejectedId, { status: "POSTED_IN_LEDGER", postedAmount: 100 }, PDF_UPLOAD),
    409,
  );
  await expectStatus(
    () => service.acceptCnRequest(ADMIN, "cn-1", { status: "POSTED_IN_LEDGER", postedAmount: 100 }, PDF_UPLOAD),
    409,
  );
  await assert.rejects(
    () => service.actOnCnRequest(ADMIN, rejectedId, { action: "reject", reason: "BILLING_CONDITION_NOT_MET" }),
    (error: unknown) => (error as TestApiError).status === 409,
  );
  await assert.rejects(
    () => service.actOnCnRequest(ADMIN, "cn-1", { action: "reject", reason: "BILLING_CONDITION_NOT_MET" }),
    (error: unknown) => (error as TestApiError).status === 409,
  );
  const acceptedStore = makeStore();
  const acceptedId = acceptedStore.seed("ACCEPTED_NOT_POSTED", "cn-accepted-not-posted");
  const acceptedService = loadService(acceptedStore.prisma);
  const historicalNotPosted = (await acceptedService.listCnRequests(ADMIN, "accepted-not-posted"))[0];
  assert.equal(historicalNotPosted?.cnWorking, null, "pre-feature accepted rows remain readable without an invented document");
  await expectStatus(() => acceptedService.getCnWorkingDocument(SO, acceptedId), 404);
  await assert.rejects(
    () => acceptedService.actOnCnRequest(ADMIN, acceptedId, { action: "reject", reason: "BILLING_CONDITION_NOT_MET" }),
    (error: unknown) => (error as TestApiError).status === 409,
  );

  // Historical accepted lifecycle values also follow the current payment-status section rule.
  const legacyAccepted = store.seed("ACCEPTED", "cn-legacy-accepted");
  const legacyApproved = store.seed("APPROVED", "cn-legacy-approved");
  store.rows.find((row) => row.id === legacyAccepted)!.paymentStatus = "Paid";
  store.rows.find((row) => row.id === legacyAccepted)!.paymentVerified = true;
  const notPostedIds = (await service.listCnRequests(ADMIN, "accepted-not-posted")).map((r) => r.id);
  assert.ok(!notPostedIds.includes(legacyAccepted), "Paid legacy accepted row belongs in Posted in Ledger");
  assert.ok(notPostedIds.includes(legacyApproved), "every non-Paid accepted row belongs in CN Working Shared");
  assert.ok(notPostedIds.includes("cn-1"), "lifecycle POSTED_IN_LEDGER does not override a current non-Paid status");
  const postedRows = await service.listCnRequests(ADMIN, "posted-in-ledger");
  assert.equal(postedRows.map((r) => r.id).join(","), legacyAccepted);
  assert.equal(postedRows.find((r) => r.id === legacyAccepted)?.details, "kept", "historical table data remains intact");
  assert.equal(cnRequestDisplayStatus("ACCEPTED"), "POSTED_IN_LEDGER");
  assert.equal(cnRequestDisplayStatus("APPROVED"), "POSTED_IN_LEDGER");

  // All four server filters are mutually correct.
  assert.equal((await service.listCnRequests(ADMIN, "submitted")).map((r) => r.id).join(","), submittedId);
  assert.equal((await service.listCnRequests(ADMIN, "rejected")).map((r) => r.id).join(","), rejectedId);
  assert.equal((await service.listCnRequests(ADMIN, "accepted-not-posted")).map((r) => r.id).sort().join(","), ["cn-1", legacyApproved].sort().join(","));
  assert.equal((await service.listCnRequests(ADMIN, "posted-in-ledger")).map((r) => r.id).join(","), legacyAccepted);

  // Inclusive India-calendar-day age: time-of-day and elapsed 24-hour periods are irrelevant.
  const sep20 = new Date("2026-09-20T04:30:00.000Z"); // 20 Sep, 10:00 IST
  const sep21 = new Date("2026-09-21T04:30:00.000Z");
  const sep22 = new Date("2026-09-22T04:30:00.000Z");
  const sep23 = new Date("2026-09-23T04:30:00.000Z");
  const sep24 = new Date("2026-09-24T04:30:00.000Z");
  assert.equal(cnRequestAgeDays({ status: "SUBMITTED", createdAt: sep22 }, sep22), 1, "submitted today is Day 1");
  assert.equal(cnRequestAgeDays({ status: "SUBMITTED", createdAt: sep21 }, sep22), 2, "submitted yesterday is Day 2");
  assert.equal(cnRequestAgeDays({ status: "SUBMITTED", createdAt: new Date("2026-09-19T04:30:00.000Z") }, sep22), 4, "three calendar days ago is Day 4");
  assert.equal(cnRequestAgeDays({ status: "REJECTED", createdAt: sep20, rejectedAt: sep21 }, sep24), 2, "rejected age freezes at rejection");
  assert.equal(cnRequestAgeDays({ status: "ACCEPTED_NOT_POSTED", createdAt: sep20, acceptedAt: sep22 }, sep24), 3, "accepted age freezes at acceptance");
  assert.equal(cnRequestAgeDays({ status: "POSTED_IN_LEDGER", createdAt: sep20, acceptedAt: sep22, postedAt: sep24 }, new Date("2026-10-01T04:30:00.000Z")), 5, "posted age freezes at posting");
  assert.equal(cnRequestAgeDays({ status: "SUBMITTED", createdAt: sep20 }, sep22), 3);
  assert.equal(cnRequestAgeDays({ status: "SUBMITTED", createdAt: sep20 }, sep23), 4, "submitted age continues increasing with the business date");
  assert.equal(inclusiveCnRequestDays("2026-09-21T18:29:00.000Z", "2026-09-21T18:31:00.000Z"), 2, "India-midnight boundary counts two calendar dates even two minutes apart");
  assert.equal(cnRequestBusinessDateKey("2026-09-21T18:31:00.000Z"), "2026-09-22", "UTC timestamp resolves to the India business date");
  assert.equal(cnRequestAgeDays({ status: "ACCEPTED", createdAt: sep20, postedAt: sep22 }), 3, "legacy Accepted uses a verified compatibility postedAt");
  assert.equal(cnRequestAgeDays({ status: "ACCEPTED", createdAt: sep20, postedAt: null }), null, "legacy Accepted without evidence does not invent a posting date");
  assert.equal(formatCnRequestDays(1), "1 Day");
  assert.equal(formatCnRequestDays(2), "2 Days");

  /* ---------- CN follow-up task (Daily Work → Recovery) ---------- */
  {
    const taskStore = makeStore();
    // Seed acceptance states. Accepted, Not Posted → tasks; Posted / Rejected → no task.
    const payPendingId = taskStore.seed("ACCEPTED_NOT_POSTED", "cn-pp", "so-1");
    const otherId = taskStore.seed("ACCEPTED_NOT_POSTED", "cn-other", "so-1");
    taskStore.seed("POSTED_IN_LEDGER", "cn-posted", "so-1");
    taskStore.seed("REJECTED", "cn-rejected", "so-1");
    taskStore.seed("ACCEPTED_NOT_POSTED", "cn-otherso", "so-other"); // belongs to a different SO
    const byId = (id: string) => taskStore.rows.find((r) => r.id === id)!;
    byId("cn-pp").acceptanceReason = "PAYMENT_PENDING"; byId("cn-pp").amount = 12000;
    byId("cn-other").acceptanceReason = "OTHER"; byId("cn-other").amount = 5000;
    byId("cn-otherso").acceptanceReason = "PAYMENT_PENDING"; byId("cn-otherso").amount = 9000;
    for (const id of ["cn-pp", "cn-other", "cn-otherso"]) {
      byId(id).acceptedAt = new Date("2099-09-23T04:30:00.000Z");
      byId(id).cnExpiryDays = 3;
    }
    const svc = loadService(taskStore.prisma);

    // 1–4) Pending list has ONLY this SO's Accepted-Not-Posted tasks (both reasons); not Posted/Rejected/other SO.
    const pending = await svc.listPendingCnTasks(SO);
    assert.equal(pending.map((t) => t.cnRequestId).sort().join(","), "cn-other,cn-pp", "only own legacy Accepted-Not-Posted tasks remain readable");

    // 5) belongs to the original SO — OTHER_SO cannot see so-1's tasks.
    const otherPending = await svc.listPendingCnTasks(OTHER_SO);
    assert.equal(otherPending.map((t) => t.cnRequestId).join(","), "cn-otherso", "each SO sees only their own tasks");

    // 6) initially unscheduled (no taskDate).
    assert.ok(pending.every((t) => t.taskDate === null), "tasks start pending/unscheduled");

    // 11) Payment Pending carries the CN amount; 12) Other does NOT carry a recovery amount.
    const pp = pending.find((t) => t.cnRequestId === "cn-pp")!;
    const oth = pending.find((t) => t.cnRequestId === "cn-other")!;
    // Today's Auto Tasks currently contains CN tasks only. Scheme-originated auto tasks are outside this flow.
    assert.ok(pending.every((task) => task.taskType === "CN_REQUEST"), "legacy CN tasks expose their authoritative origin");
    assert.ok(pending.every((task) => task.planType === "RECOVERY"), "legacy CN tasks expose their Daily Work destination");
    assert.equal(pp.kind, "CN_RECOVERY"); assert.equal(pp.recoveryAmount, 12000, "Payment Pending carries amount");
    assert.equal(oth.kind, "CN_TASK"); assert.equal(oth.recoveryAmount, null, "Other has no recovery amount");
    assert.equal(oth.amount, 5000, "the raw CN amount is still available as context");
    assert.equal(pp.acceptanceDate, "2099-09-23");
    assert.equal(pp.expiryDate, "2099-09-25", "three inclusive days expire on the 25th");
    const allActive = await svc.listActiveCnTasks(SO);
    assert.equal(allActive.map((task) => task.cnRequestId).sort().join(","), "cn-other,cn-pp", "all active legacy tasks are visible before their scheduled date");

    // The acceptance date, an inside date, and the inclusive final expiry date are all accepted.
    await svc.scheduleCnTask(SO, payPendingId, { taskDate: "2099-09-23" });
    await svc.scheduleCnTask(SO, payPendingId, { taskDate: "2099-09-24" });
    await svc.scheduleCnTask(SO, payPendingId, { taskDate: "2099-09-25" });
    assert.equal(byId("cn-pp").taskDate, "2099-09-25");
    const onDate = await svc.cnTasksForOfficerDate("so-1", "2099-09-25");
    assert.equal(onDate.map((t) => t.cnRequestId).join(","), "cn-pp", "scheduled task appears on its date");
    assert.equal((await svc.cnTasksForOfficerDate("so-1", "2099-09-26")).length, 0, "not on another date");
    // scheduling removes it from the pending list.
    assert.ok(!(await svc.listPendingCnTasks(SO)).some((t) => t.cnRequestId === "cn-pp"), "scheduled task leaves pending");

    // Before acceptance and after expiry are rejected server-side; an invalid reschedule keeps the valid date.
    await expect422(() => svc.scheduleCnTask(SO, payPendingId, { taskDate: "2099-02-31" }), "A valid date is required");
    await expect422(() => svc.scheduleCnTask(SO, payPendingId, { taskDate: "2099-09-22" }), CN_TASK_DATE_OUTSIDE_EXPIRY_MESSAGE);
    await expect422(() => svc.scheduleCnTask(SO, payPendingId, { taskDate: "2099-09-26" }), CN_TASK_DATE_OUTSIDE_EXPIRY_MESSAGE);
    assert.equal(byId("cn-pp").taskDate, "2099-09-25");
    assert.equal((await svc.cnTasksForOfficerDate("so-1", "2099-09-25")).map((t) => t.cnRequestId).join(","), "cn-pp", "same task remains on its valid date");
    assert.equal(taskStore.rows.filter((r) => r.id === "cn-pp").length, 1, "still exactly one task row");

    const sundayId = taskStore.seed("ACCEPTED_NOT_POSTED", "cn-sunday", "so-1", { acceptedAt: new Date("2099-09-26T04:30:00.000Z") });
    byId(sundayId).acceptanceReason = "PAYMENT_PENDING";
    byId(sundayId).cnExpiryDays = 3;
    await expect422(() => svc.scheduleCnTask(SO, sundayId, { taskDate: "2099-09-27" }), CN_TASK_DATE_SUNDAY_MESSAGE);
    assert.equal(byId(sundayId).taskDate ?? null, null, "server-side Sunday rejection leaves the task unchanged");

    // 15) authorization — another SO cannot schedule so-1's task.
    await expectStatus(() => svc.scheduleCnTask(OTHER_SO, otherId, { taskDate: "2099-09-25" }), 403);
    // A Posted-in-Ledger request has no follow-up task to schedule.
    await expectStatus(() => svc.scheduleCnTask(SO, "cn-posted", { taskDate: "2099-09-25" }), 409);
    // 13/14) The task never carries a way to change CN status/amount/reason — scheduleCnTask only sets taskDate.
    assert.equal(byId("cn-pp").status, "ACCEPTED_NOT_POSTED", "CN status unchanged by scheduling");
    assert.equal(byId("cn-pp").acceptanceReason, "PAYMENT_PENDING", "CN reason unchanged by scheduling");
    assert.equal(byId("cn-pp").amount, 12000, "CN amount unchanged by scheduling");

    // A task scheduled before expiry remains in Daily Work history after expiry and cannot be moved later.
    const expiredId = taskStore.seed("ACCEPTED_NOT_POSTED", "cn-expired", "so-1", { acceptedAt: new Date("2020-09-23T04:30:00.000Z") });
    byId(expiredId).acceptanceReason = "PAYMENT_PENDING";
    byId(expiredId).cnExpiryDays = 1;
    byId(expiredId).taskDate = "2020-09-23";
    assert.equal((await svc.cnTasksForOfficerDate("so-1", "2020-09-23")).map((t) => t.cnRequestId).join(","), expiredId);
    await expect422(() => svc.scheduleCnTask(SO, expiredId, { taskDate: "2020-09-23" }), CN_TASK_DATE_OUTSIDE_EXPIRY_MESSAGE);
    assert.equal(byId(expiredId).taskDate, "2020-09-23", "expiry never removes an already scheduled historical task");
  }

  // Historical Accepted / Not Posted rows have no invented expiry and preserve their prior scheduling behavior.
  {
    const paymentStore = makeStore();
    const paymentId = paymentStore.seed("SUBMITTED", "cn-payment", "so-1");
    const paymentService = loadService(paymentStore.prisma);
    await paymentService.acceptCnRequest(ADMIN, paymentId, {
      status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 5, outstandingAmount: 120000,
    }, PDF_UPLOAD);
    const request = paymentStore.rows[0]!;
    const taskDate = paymentStore.paymentEvents[0]!.taskDate!.toISOString().slice(0, 10);
    assert.equal(request.paymentStatus, "Pending");
    assert.equal(request.paymentOriginalAmount, 120000);
    assert.equal(request.paymentOutstandingAmount, 120000);
    assert.equal(paymentStore.paymentEvents.length, 1, "initial Payment Pending creates one task event");
    const initialTaskId = paymentStore.paymentEvents[0]!.id;
    const initialPending = await paymentService.listPendingCnTasks(SO);
    assert.equal(initialPending.length, 0, "automatic tasks are no longer left unscheduled");
    const initialActive = await paymentService.listActiveCnTasks(SO);
    assert.equal(initialActive.length, 1);
    assert.equal(initialActive[0]?.taskId, initialTaskId);
    assert.equal(initialActive[0]?.taskType, "CN_REQUEST");
    assert.equal(initialActive[0]?.planType, "RECOVERY");
    assert.equal(initialActive[0]?.recoveryAmount, 120000);
    assert.equal(initialActive[0]?.taskRescheduled, false);
    assert.equal(paymentStore.paymentEvents[0]?.taskStatus, "SCHEDULED");
    const manuallySelectedDate = nextCnWorkingDateKey(taskDate)!;
    await paymentService.scheduleCnTask(SO, paymentId, { taskId: initialTaskId, taskDate: manuallySelectedDate });
    assert.equal(paymentStore.paymentEvents[0]?.taskDate?.toISOString().slice(0, 10), manuallySelectedDate);
    assert.equal(paymentStore.paymentEvents[0]?.taskRescheduled, true, "an actual SO date change becomes Rescheduled");
    await paymentService.scheduleCnTask(SO, paymentId, { taskId: initialTaskId, taskDate });
    assert.equal(paymentStore.paymentEvents[0]?.taskRescheduled, true, "returning to the original date does not reset Rescheduled");

    await expect422(() => paymentService.updateCnPayment(SO, paymentId, {
      status: "PARTIAL_PAID", amountPaid: 0, paymentDate: taskDate, followUpDate: taskDate,
      taskId: initialTaskId, requestKey: "partial-zero",
    }), CN_PAYMENT_AMOUNT_INVALID_MESSAGE);
    await expect422(() => paymentService.updateCnPayment(SO, paymentId, {
      status: "PARTIAL_PAID", amountPaid: 120000, paymentDate: taskDate, followUpDate: taskDate,
      taskId: initialTaskId, requestKey: "partial-full",
    }), CN_PAYMENT_AMOUNT_INVALID_MESSAGE);
    const afterExpiryDate = new Date(`${cnRequestExpiryDateKey(request.acceptedAt!, 5)}T00:00:00.000Z`);
    afterExpiryDate.setUTCDate(afterExpiryDate.getUTCDate() + 1);
    // Skip Sunday so this case deterministically exercises the EXPIRY guard (Sunday is validated first).
    while (afterExpiryDate.getUTCDay() === 0) afterExpiryDate.setUTCDate(afterExpiryDate.getUTCDate() + 1);
    await expect422(() => paymentService.updateCnPayment(SO, paymentId, {
      status: "NOT_PAID", followUpDate: afterExpiryDate.toISOString().slice(0, 10),
      taskId: initialTaskId, requestKey: "outside-expiry",
    }), CN_TASK_DATE_OUTSIDE_EXPIRY_MESSAGE);
    assert.equal(request.paymentOutstandingAmount, 120000, "invalid payment leaves the balance unchanged");

    await paymentService.updateCnPayment(SO, paymentId, {
      status: "PARTIAL_PAID", amountPaid: 40000, paymentDate: taskDate, followUpDate: taskDate,
      taskId: initialTaskId, requestKey: "partial-40000",
    });
    assert.equal(request.paymentStatus, "Partial Paid");
    assert.equal(request.paymentOriginalAmount, 120000, "original amount is immutable");
    assert.equal(request.paymentOutstandingAmount, 80000);
    assert.equal(paymentStore.paymentEvents[0]?.taskStatus, "COMPLETED");
    assert.equal(paymentStore.paymentEvents[1]?.amountPaid, 40000);
    assert.equal(paymentStore.paymentEvents[1]?.taskAmount, 80000);
    assert.equal(paymentStore.paymentEvents[1]?.taskStatus, "SCHEDULED");
    assert.equal(paymentStore.paymentEvents[1]?.taskRescheduled, true, "SO-selected follow-up dates are recorded as rescheduled");
    await paymentService.updateCnPayment(SO, paymentId, {
      status: "PARTIAL_PAID", amountPaid: 40000, paymentDate: taskDate, followUpDate: taskDate,
      taskId: initialTaskId, requestKey: "partial-40000",
    });
    assert.equal(paymentStore.paymentEvents.length, 2, "replaying the same request key cannot duplicate an event/task");

    const partialTaskId = paymentStore.paymentEvents[1]!.id;
    await paymentService.updateCnPayment(SO, paymentId, {
      status: "NOT_PAID", followUpDate: taskDate, taskId: partialTaskId, requestKey: "not-paid-1",
    });
    assert.equal(request.paymentStatus, "Not Paid");
    assert.equal(request.paymentOutstandingAmount, 80000, "Not Paid preserves the outstanding amount");
    assert.equal(paymentStore.paymentEvents[2]?.amountPaid, null, "Not Paid creates no fake zero payment");
    assert.equal(paymentStore.paymentEvents[2]?.taskAmount, 80000);

    const notPaidTaskId = paymentStore.paymentEvents[2]!.id;
    await paymentService.updateCnPayment(SO, paymentId, {
      status: "PAID", paymentDate: taskDate, taskId: notPaidTaskId, requestKey: "paid-0001",
    });
    assert.equal(request.paymentStatus, "Paid");
    assert.equal(request.paymentOutstandingAmount, 0);
    assert.equal(request.status, "ACCEPTED_NOT_POSTED", "Paid never changes the CN lifecycle status");
    assert.equal(paymentStore.paymentEvents[3]?.amountPaid, 80000);
    assert.equal(paymentStore.paymentEvents[3]?.taskStatus, null, "Paid creates no follow-up task");
    assert.equal((await paymentService.listCnRequests(ADMIN, "accepted-not-posted")).map((row) => row.id).join(","), paymentId, "SO-reported Paid remains in CN Working Shared until Admin verifies it");
    assert.equal((await paymentService.listCnRequests(ADMIN, "posted-in-ledger")).length, 0, "provisional Paid is not authoritative");

    // Admin override: SO reported Paid; Admin verifies Partial (₹60,000 of the ₹80,000 that existed BEFORE the
    // current status), so remaining recomputes to ₹20,000 — the authoritative (green) outcome. The SO's Paid
    // event stays immutable; a separate ADMIN_VERIFY event records the Admin decision and opens a default-dated task.
    const soReported = await paymentService.getCnPaymentDetail(SO, paymentId);
    assert.equal(soReported.paymentVerified, false, "SO report is unverified (gray) before Admin verifies");
    const adminBefore = await paymentService.getCnPaymentDetail(ADMIN, paymentId);
    assert.equal(adminBefore.canVerify, true, "Admin may verify a reported status");
    assert.equal(adminBefore.canUpdate, false, "Admin never uses the SO report form");
    await paymentService.verifyCnPayment(ADMIN, paymentId, {
      status: "PARTIAL_PAID", amountPaid: 60000, requestKey: "admin-verify-1",
    });
    assert.equal(request.paymentStatus, "Partial Paid");
    assert.equal(request.paymentOutstandingAmount, 20000);
    assert.equal(request.paymentVerified, true, "Admin verification is authoritative (green)");
    assert.equal(paymentStore.paymentEvents[3]?.status, "PAID", "the historical Paid event remains immutable");
    assert.equal(paymentStore.paymentEvents[4]?.source, "ADMIN_VERIFY");
    assert.equal(paymentStore.paymentEvents[4]?.amountPaid, 60000);
    assert.equal(paymentStore.paymentEvents[4]?.outstandingBefore, 80000, "recomputed from the pre-report outstanding");
    assert.equal(paymentStore.paymentEvents[4]?.outstandingAfter, 20000);
    assert.equal(paymentStore.paymentEvents[4]?.taskStatus, "SCHEDULED");
    assert.equal(paymentStore.paymentEvents[4]?.taskDate?.toISOString().slice(0, 10), nextCnWorkingDateKey(paymentStore.paymentEvents[4]!.createdAt));
    assert.equal(paymentStore.paymentEvents[4]?.taskRescheduled, false);
    assert.equal(request.status, "ACCEPTED_NOT_POSTED", "Admin-verified Partial Paid does not post to ledger");
    assert.equal((await paymentService.listActiveCnTasks(SO)).filter((task) => task.taskId === paymentStore.paymentEvents[4]?.id).length, 1, "the default-dated remainder is immediately visible");
    // Replaying the same verification key is idempotent.
    await paymentService.verifyCnPayment(ADMIN, paymentId, {
      status: "PARTIAL_PAID", amountPaid: 60000, requestKey: "admin-verify-1",
    });
    assert.equal(paymentStore.paymentEvents.length, 5, "replaying the verification key cannot duplicate an event/task");
    const adminDetail = await paymentService.getCnPaymentDetail(ADMIN, paymentId);
    assert.equal(adminDetail.events.length, 5);
    assert.equal(adminDetail.tasks.length, 4);
    assert.equal(adminDetail.currentOutstandingAmount, 20000);
    assert.equal(adminDetail.paymentVerified, true);
    // A Sales Officer can never verify a payment.
    await expectStatus(() => paymentService.verifyCnPayment(SO, paymentId, {
      status: "PAID", requestKey: "so-cannot-verify",
    }), 403);
    await expectStatus(() => paymentService.getCnPaymentDetail(OTHER_SO, paymentId), 403);
  }

  // Dual-actor separation on a fresh CN: SO report stays gray, then Admin agree-verify turns it green with no
  // duplicate task, and Admin-verified Paid settles the balance and creates no further task.
  {
    const verifyStore = makeStore();
    const verifyId = verifyStore.seed("SUBMITTED", "cn-verify", "so-1");
    const verifyAudits: Array<{ summary?: string | null }> = [];
    const verifyService = loadService(verifyStore.prisma, verifyAudits);
    await verifyService.acceptCnRequest(ADMIN, verifyId, {
      status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 5, outstandingAmount: 50000,
    }, PDF_UPLOAD);
    const vRequest = verifyStore.rows[0]!;
    const vTaskDate = verifyStore.paymentEvents[0]!.taskDate!.toISOString().slice(0, 10);
    const vInitialTaskId = verifyStore.paymentEvents[0]!.id;

    // SO reports Partial ₹20,000 → provisional gray, outstanding 30,000, new SCHEDULED task.
    await verifyService.updateCnPayment(SO, verifyId, {
      status: "PARTIAL_PAID", amountPaid: 20000, paymentDate: vTaskDate, followUpDate: vTaskDate,
      taskId: vInitialTaskId, requestKey: "v-partial-1",
    });
    assert.equal(vRequest.paymentStatus, "Partial Paid");
    assert.equal(vRequest.paymentOutstandingAmount, 30000);
    assert.equal(vRequest.paymentVerified, false, "SO report is gray");
    const soTaskId = verifyStore.paymentEvents[1]!.id;
    assert.equal(verifyStore.paymentEvents[1]?.taskStatus, "SCHEDULED");

    // Admin AGREES (same status + same outstanding) → green, keeps the SO's task, no duplicate.
    await verifyService.verifyCnPayment(ADMIN, verifyId, {
      status: "PARTIAL_PAID", amountPaid: 20000, requestKey: "v-agree-1",
    });
    assert.equal(vRequest.paymentStatus, "Partial Paid");
    assert.equal(vRequest.paymentOutstandingAmount, 30000, "agree does not move the outstanding");
    assert.equal(vRequest.paymentVerified, true, "agree turns the pill green");
    assert.equal(verifyStore.paymentEvents[2]?.source, "ADMIN_VERIFY");
    assert.equal(verifyStore.paymentEvents[2]?.taskStatus, null, "agree creates no duplicate task");
    assert.equal(verifyStore.paymentEvents[1]?.taskStatus, "SCHEDULED", "the SO's task is left intact");
    assert.equal(vRequest.status, "ACCEPTED_NOT_POSTED", "Admin-verified Partial Paid is not posted to ledger");
    assert.equal(cnRequestCurrentDisplayStatus(vRequest.status, vRequest.paymentStatus), "ACCEPTED_NOT_POSTED", "never-posted Partial Paid is not Returned from Ledger");
    assert.equal((await verifyService.listCnRequests(ADMIN, "accepted-not-posted")).map((row) => row.id).join(","), verifyId);
    assert.equal((await verifyService.listCnRequests(ADMIN, "posted-in-ledger")).length, 0);

    // A later SO report resets the pill to gray again (provisional until re-verified).
    await verifyService.updateCnPayment(SO, verifyId, {
      status: "NOT_PAID", followUpDate: vTaskDate, taskId: soTaskId, requestKey: "v-notpaid-1",
    });
    assert.equal(vRequest.paymentVerified, false, "a new SO report resets verification to gray");

    // Admin-verified Not Paid remains in CN Working Shared and preserves the existing follow-up task.
    await verifyService.verifyCnPayment(ADMIN, verifyId, {
      status: "NOT_PAID", requestKey: "v-notpaid-verify-1",
    });
    assert.equal(vRequest.paymentStatus, "Not Paid");
    assert.equal(vRequest.status, "ACCEPTED_NOT_POSTED", "Admin-verified Not Paid is not posted to ledger");
    assert.equal(cnRequestCurrentDisplayStatus(vRequest.status, vRequest.paymentStatus), "ACCEPTED_NOT_POSTED", "never-posted Not Paid is not Returned from Ledger");
    assert.equal(verifyStore.paymentEvents[3]?.taskStatus, "SCHEDULED", "Not Paid follow-up remains unchanged");
    assert.equal((await verifyService.listCnRequests(ADMIN, "accepted-not-posted")).map((row) => row.id).join(","), verifyId);
    assert.equal((await verifyService.listCnRequests(ADMIN, "posted-in-ledger")).length, 0);

    // Admin-verified Paid settles the balance and atomically performs the existing Post in Ledger transition.
    await verifyService.verifyCnPayment(ADMIN, verifyId, {
      status: "PAID", requestKey: "v-paid-1",
    });
    assert.equal(vRequest.paymentStatus, "Paid");
    assert.equal(vRequest.paymentOutstandingAmount, 0);
    assert.equal(vRequest.paymentVerified, true);
    assert.equal(vRequest.status, "POSTED_IN_LEDGER");
    assert.equal(cnRequestCurrentDisplayStatus(vRequest.status, vRequest.paymentStatus), "POSTED_IN_LEDGER", "currently Paid remains Posted in Ledger");
    assert.equal(vRequest.postedAmount, 50000, "posting uses the authoritative original outstanding amount");
    assert.ok(vRequest.postedAt, "Paid verification records the ledger posting timestamp");
    assert.equal(vRequest.actedByAdminId, ADMIN.userId);
    assert.equal(vRequest.cnWorkingFileName, PDF_UPLOAD.name, "posting preserves the existing CN Working document");
    assert.equal((await verifyService.listCnRequests(ADMIN, "accepted-not-posted")).length, 0, "Paid leaves CN Working Shared");
    assert.equal((await verifyService.listCnRequests(ADMIN, "posted-in-ledger")).map((row) => row.id).join(","), verifyId, "Paid enters Posted in Ledger");
    const lastEvent = verifyStore.paymentEvents[verifyStore.paymentEvents.length - 1]!;
    assert.equal(lastEvent.source, "ADMIN_VERIFY");
    assert.equal(lastEvent.taskStatus, null, "Admin-verified Paid creates no follow-up task");
    const eventIds = new Set(verifyStore.paymentEvents.map((e) => e.id));
    assert.equal((await verifyService.listPendingCnTasks(SO)).filter((t) => t.taskId != null && eventIds.has(t.taskId)).length, 0, "no open Recovery task remains after Admin Paid");
    assert.equal((await verifyService.listActiveCnTasks(SO)).filter((t) => t.taskId != null && eventIds.has(t.taskId)).length, 0, "Paid removes the completed CN Working task from the active table");
    const postedAt = vRequest.postedAt;
    const eventCount = verifyStore.paymentEvents.length;
    await verifyService.verifyCnPayment(ADMIN, verifyId, {
      status: "PAID", requestKey: "v-paid-1",
    });
    assert.equal(verifyStore.paymentEvents.length, eventCount, "retry cannot duplicate payment history");
    assert.equal(vRequest.postedAt, postedAt, "retry cannot duplicate or replace the ledger posting");
    assert.equal(verifyAudits.filter((entry) => entry.summary?.includes("posted in ledger")).length, 1, "retry creates no duplicate posting audit");

    // A later authoritative Partial Paid moves the already-posted CN back to CN Working Shared. The immutable
    // ledger timestamp remains as history and the existing verification logic creates exactly one remainder task.
    await verifyService.verifyCnPayment(ADMIN, verifyId, {
      status: "PARTIAL_PAID", amountPaid: 10000, requestKey: "v-paid-to-partial-1",
    });
    assert.equal(vRequest.paymentStatus, "Partial Paid");
    assert.equal(vRequest.paymentOutstandingAmount, 20000);
    assert.equal(vRequest.status, "POSTED_IN_LEDGER", "historical ledger state is preserved; tab membership is payment-driven");
    assert.equal(cnRequestCurrentDisplayStatus(vRequest.status, vRequest.paymentStatus), "RETURNED_FROM_LEDGER", "previously posted Partial Paid displays Returned from Ledger");
    assert.equal(vRequest.postedAt, postedAt, "moving sections never rewrites the original posting timestamp");
    assert.equal((await verifyService.listCnRequests(ADMIN, "accepted-not-posted")).map((row) => row.id).join(","), verifyId);
    assert.equal((await verifyService.listCnRequests(ADMIN, "posted-in-ledger")).length, 0);
    const partialOverride = verifyStore.paymentEvents.at(-1)!;
    assert.equal(partialOverride.source, "ADMIN_VERIFY");
    assert.equal(partialOverride.outstandingAfter, 20000);
    assert.equal(partialOverride.taskStatus, "SCHEDULED", "Partial Paid creates one default-dated remainder task");
    assert.equal(partialOverride.taskRescheduled, false);

    // Returning to Paid moves the CN forward again without repeating the historical ledger transition.
    await verifyService.verifyCnPayment(ADMIN, verifyId, {
      status: "PAID", requestKey: "v-partial-back-to-paid-1",
    });
    assert.equal(vRequest.paymentStatus, "Paid");
    assert.equal(cnRequestCurrentDisplayStatus(vRequest.status, vRequest.paymentStatus), "POSTED_IN_LEDGER", "Returned from Ledger becomes Posted in Ledger when Paid again");
    assert.equal(vRequest.paymentOutstandingAmount, 0);
    assert.equal((await verifyService.listCnRequests(ADMIN, "accepted-not-posted")).length, 0);
    assert.equal((await verifyService.listCnRequests(ADMIN, "posted-in-ledger")).map((row) => row.id).join(","), verifyId);
    assert.equal(vRequest.postedAt, postedAt, "Paid again does not duplicate ledger posting");
    assert.equal(verifyAudits.filter((entry) => entry.summary?.includes("posted in ledger")).length, 1);

    // Paid → Not Paid follows the same current-status classification and creates only the existing follow-up.
    const beforeNotPaidEvents = verifyStore.paymentEvents.length;
    await verifyService.verifyCnPayment(ADMIN, verifyId, {
      status: "NOT_PAID", requestKey: "v-paid-to-not-paid-1",
    });
    assert.equal(vRequest.paymentStatus, "Not Paid");
    assert.equal(cnRequestCurrentDisplayStatus(vRequest.status, vRequest.paymentStatus), "RETURNED_FROM_LEDGER", "previously posted Not Paid displays Returned from Ledger");
    assert.equal(vRequest.paymentOutstandingAmount, 30000, "existing authoritative outstanding calculation remains unchanged");
    assert.equal(verifyStore.paymentEvents.length, beforeNotPaidEvents + 1, "Not Paid creates one verification event");
    assert.equal(verifyStore.paymentEvents.at(-1)?.taskStatus, "SCHEDULED", "Not Paid creates one default-dated follow-up task");
    assert.equal((await verifyService.listCnRequests(ADMIN, "accepted-not-posted")).map((row) => row.id).join(","), verifyId);
    assert.equal((await verifyService.listCnRequests(ADMIN, "posted-in-ledger")).length, 0);

    // Verifying a Pending / unreported CN is rejected.
    const pendingStore = makeStore();
    const pendingId = pendingStore.seed("SUBMITTED", "cn-pending-verify", "so-1");
    const pendingService = loadService(pendingStore.prisma);
    await pendingService.acceptCnRequest(ADMIN, pendingId, {
      status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 5, outstandingAmount: 10000,
    }, PDF_UPLOAD);
    await expectStatus(() => pendingService.verifyCnPayment(ADMIN, pendingId, {
      status: "PAID", requestKey: "verify-pending-1",
    }), 409);
    const pendingDetail = await pendingService.getCnPaymentDetail(ADMIN, pendingId);
    assert.equal(pendingDetail.canVerify, false, "Pending has nothing to verify yet");
    assert.equal(verifyStore.transactionTimeouts.at(-1), 15_000, "Admin verification uses only its scoped 15-second transaction timeout");
  }

  // Concurrent identical Admin verification is serialized by the CN row lock. Both callers receive the same
  // committed result while only one payment event, one ledger transition and one posting audit are produced.
  {
    const concurrentStore = makeStore();
    const concurrentId = concurrentStore.seed("SUBMITTED", "cn-concurrent-verify", "so-1");
    const concurrentAudits: Array<{ summary?: string | null }> = [];
    const concurrentService = loadService(concurrentStore.prisma, concurrentAudits);
    await concurrentService.acceptCnRequest(ADMIN, concurrentId, {
      status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 5, outstandingAmount: 25000,
    }, PDF_UPLOAD);
    const concurrentDate = concurrentStore.paymentEvents[0]!.taskDate!.toISOString().slice(0, 10);
    const concurrentTaskId = concurrentStore.paymentEvents[0]!.id;
    await concurrentService.updateCnPayment(SO, concurrentId, {
      status: "PAID", paymentDate: concurrentDate, taskId: concurrentTaskId, requestKey: "concurrent-so-paid",
    });
    const eventsBefore = concurrentStore.paymentEvents.length;
    await Promise.all([
      concurrentService.verifyCnPayment(ADMIN, concurrentId, { status: "PAID", requestKey: "concurrent-admin-paid-a" }),
      concurrentService.verifyCnPayment(ADMIN, concurrentId, { status: "PAID", requestKey: "concurrent-admin-paid-b" }),
    ]);
    assert.equal(concurrentStore.rows[0]?.paymentStatus, "Paid");
    assert.equal(concurrentStore.rows[0]?.status, "POSTED_IN_LEDGER");
    assert.equal(concurrentStore.paymentEvents.length, eventsBefore + 1, "concurrent replay creates one verification event");
    assert.equal(concurrentStore.paymentEvents.filter((event) => event.requestKey.startsWith("concurrent-admin-paid-")).length, 1);
    assert.equal(concurrentAudits.filter((entry) => entry.summary?.includes("posted in ledger")).length, 1, "concurrent replay posts once");
    assert.deepEqual(concurrentStore.transactionTimeouts.slice(-2), [15_000, 15_000]);
  }

  // Paid verification and ledger posting remain one atomic transaction. If the existing ledger transition
  // fails, neither the authoritative payment update nor its history event is retained.
  {
    const rollbackStore = makeStore();
    const rollbackId = rollbackStore.seed("SUBMITTED", "cn-verify-rollback", "so-1");
    const rollbackService = loadService(rollbackStore.prisma);
    await rollbackService.acceptCnRequest(ADMIN, rollbackId, {
      status: "ACCEPTED_NOT_POSTED", reason: "PAYMENT_PENDING", cnExpiryDays: 5, outstandingAmount: 15000,
    }, PDF_UPLOAD);
    const rollbackDate = rollbackStore.paymentEvents[0]!.taskDate!.toISOString().slice(0, 10);
    const rollbackTaskId = rollbackStore.paymentEvents[0]!.id;
    await rollbackService.updateCnPayment(SO, rollbackId, {
      status: "PAID", paymentDate: rollbackDate, taskId: rollbackTaskId, requestKey: "rollback-so-paid",
    });
    const eventsBefore = rollbackStore.paymentEvents.length;
    rollbackStore.setFailLedgerPosting(true);
    await assert.rejects(() => rollbackService.verifyCnPayment(ADMIN, rollbackId, {
      status: "PAID", requestKey: "rollback-admin-paid",
    }), /simulated ledger write failure/);
    assert.equal(rollbackStore.rows[0]?.paymentStatus, "Paid", "the SO report remains unchanged after rollback");
    assert.equal(rollbackStore.rows[0]?.paymentVerified, false, "the failed Admin verification is rolled back");
    assert.equal(rollbackStore.rows[0]?.status, "ACCEPTED_NOT_POSTED", "the failed ledger transition is rolled back");
    assert.equal(rollbackStore.paymentEvents.length, eventsBefore, "the failed verification event is rolled back");
  }

  // Historical Accepted / Not Posted rows have no invented expiry and preserve their prior scheduling behavior.
  {
    const historicalTaskStore = makeStore();
    const historicalId = historicalTaskStore.seed("ACCEPTED_NOT_POSTED", "cn-historical-task", "so-1", { acceptedAt: new Date("2020-01-01T04:30:00.000Z") });
    historicalTaskStore.rows[0]!.acceptanceReason = "OTHER";
    const historicalService = loadService(historicalTaskStore.prisma);
    const historicalTask = (await historicalService.listPendingCnTasks(SO))[0]!;
    assert.equal(historicalTask.expiryDate, null);
    await historicalService.scheduleCnTask(SO, historicalId, { taskDate: "2099-10-01" });
    assert.equal(historicalTaskStore.rows[0]?.taskDate, "2099-10-01");
  }

  // Rescheduling a materialized PAYMENT_V1 task reuses its identity, reverses its exact frozen contribution,
  // clears the durable link, and makes the same future task visible again.
  {
    const taskStore = makeStore();
    const requestId = taskStore.seed("ACCEPTED_NOT_POSTED", "cn-materialized", "so-1", { acceptedAt: new Date("2026-09-29T04:30:00.000Z") });
    Object.assign(taskStore.rows[0]!, { paymentTrackingMode: "PAYMENT_V1", cnExpiryDays: 10, acceptanceReason: "PAYMENT_PENDING" });
    taskStore.paymentEvents.push({
      id: "task-materialized", cnRequestId: requestId, status: "PENDING", amountPaid: null,
      eventDate: new Date("2026-09-29T00:00:00.000Z"), outstandingBefore: 24_000, outstandingAfter: 24_000,
      taskAmount: 24_000, taskDate: new Date("2026-09-29T00:00:00.000Z"), taskStatus: "SCHEDULED",
      taskRescheduled: false, taskCompletedAt: null, dailyWorkEntryId: "recovery-entry", dailyWorkContribution: 24_000,
      source: "ACCEPTANCE", requestKey: "materialized-1", recordedById: "admin-1", createdAt: new Date("2026-09-29T04:30:00.000Z"),
    });
    const reversals: Array<{ entryId: string; contribution: number }> = [];
    const taskService = loadService(taskStore.prisma, [], {}, reversals);
    assert.equal((await taskService.listActiveCnTasks(SO)).length, 0, "materialized task is absent from Today's Auto Tasks");
    const rescheduled = await taskService.scheduleCnTask(SO, requestId, { taskId: "task-materialized", taskDate: "2026-10-01" });
    assert.equal(rescheduled.taskId, "task-materialized", "rescheduling reuses the same underlying task");
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0]?.entryId, "recovery-entry");
    assert.equal(reversals[0]?.contribution, 24_000);
    assert.equal(taskStore.paymentEvents[0]?.dailyWorkEntryId, null);
    assert.equal(taskStore.paymentEvents[0]?.dailyWorkContribution, null);
    assert.equal(taskStore.paymentEvents[0]?.taskStatus, "SCHEDULED");
    assert.equal((await taskService.listActiveCnTasks(SO))[0]?.taskId, "task-materialized", "future task returns to Today's Auto Tasks");
  }

  // Explicit Auto Task confirmation — a state SEPARATE from materialization, payment and taskStatus.
  {
    const store = makeStore();
    const requestId = store.seed("ACCEPTED_NOT_POSTED", "cn-confirm", "so-1", { acceptedAt: new Date("2026-09-29T04:30:00.000Z") });
    Object.assign(store.rows[0]!, { paymentTrackingMode: "PAYMENT_V1", cnExpiryDays: 10, acceptanceReason: "PAYMENT_PENDING" });
    store.paymentEvents.push({
      id: "task-confirm", cnRequestId: requestId, status: "PENDING", amountPaid: null,
      eventDate: new Date("2026-09-29T00:00:00.000Z"), outstandingBefore: 24_000, outstandingAfter: 24_000,
      taskAmount: 24_000, taskDate: new Date("2026-09-29T00:00:00.000Z"), taskStatus: "SCHEDULED",
      taskRescheduled: false, taskCompletedAt: null, dailyWorkEntryId: "recovery-entry", dailyWorkContribution: 24_000,
      dailyWorkConfirmed: false, source: "ACCEPTANCE", requestKey: "confirm-1", recordedById: "admin-1", createdAt: new Date("2026-09-29T04:30:00.000Z"),
    });
    const reversals: Array<{ entryId: string; contribution: number }> = [];
    const svc = loadService(store.prisma, [], {}, reversals);

    // 2) A materialized task starts UNCONFIRMED and thus counts toward the day-submit gate.
    const before = await svc.materializedCnTasksForEntries("so-1", ["recovery-entry"]);
    assert.equal(before[0]?.confirmed, false, "materialized task begins unconfirmed");
    assert.equal(await svc.countUnconfirmedMaterializedTasks(store.prisma as never, "so-1", "2026-09-29", "test-batch"), 1);

    // 3/5) Confirm persists the state; it never completes the payment task (taskStatus/taskCompletedAt unchanged).
    const confirmed = await svc.confirmMaterializedAutoTask(SO, requestId, { taskId: "task-confirm" });
    assert.equal(confirmed.confirmed, true, "confirm returns the confirmed state");
    assert.equal(store.paymentEvents[0]?.dailyWorkConfirmed, true, "confirmation persists server-side");
    assert.equal(store.paymentEvents[0]?.taskStatus, "SCHEDULED", "confirm never completes the payment task");
    assert.equal(store.paymentEvents[0]?.taskCompletedAt, null, "confirm never sets a completion timestamp");
    assert.equal(store.paymentEvents[0]?.dailyWorkEntryId, "recovery-entry", "confirm never moves the contribution");
    assert.equal(store.paymentEvents[0]?.dailyWorkContribution, 24_000);

    // 4) Reload preserves confirmation; 19) repeated confirmation is idempotent (no double state).
    const after = await svc.materializedCnTasksForEntries("so-1", ["recovery-entry"]);
    assert.equal(after[0]?.confirmed, true, "reload preserves confirmation");
    await svc.confirmMaterializedAutoTask(SO, requestId, { taskId: "task-confirm" });
    assert.equal(store.paymentEvents[0]?.dailyWorkConfirmed, true, "double confirm stays confirmed");
    assert.equal(await svc.countUnconfirmedMaterializedTasks(store.prisma as never, "so-1", "2026-09-29", "test-batch"), 0, "confirmed task clears the submit gate");

    // 6/7/8) Reschedule requires the explicit call, reverses only this task's contribution, and RESETS confirmation.
    const rescheduled = await svc.scheduleCnTask(SO, requestId, { taskId: "task-confirm", taskDate: "2026-10-01" });
    assert.equal(rescheduled.taskId, "task-confirm");
    assert.equal(reversals.length, 1, "exactly one contribution reversed");
    assert.equal(reversals[0]?.contribution, 24_000);
    assert.equal(store.paymentEvents[0]?.dailyWorkConfirmed, false, "reschedule resets confirmation");
    assert.equal(store.paymentEvents[0]?.dailyWorkEntryId, null, "reschedule un-materializes the task");
    assert.equal(store.paymentEvents[0]?.taskStatus, "SCHEDULED", "reschedule never completes the payment task");

    // 15/16) On the new date it rematerializes UNCONFIRMED and must be confirmed again.
    store.paymentEvents[0]!.dailyWorkEntryId = "recovery-entry-2";
    const remat = await svc.materializedCnTasksForEntries("so-1", ["recovery-entry-2"]);
    assert.equal(remat[0]?.confirmed, false, "rematerialized task requires confirmation again");
  }

  // Confirmation guards: only a MATERIALIZED task in the officer's editable plan can be confirmed.
  {
    const store = makeStore();
    const requestId = store.seed("ACCEPTED_NOT_POSTED", "cn-guard", "so-1", { acceptedAt: new Date("2026-09-29T04:30:00.000Z") });
    Object.assign(store.rows[0]!, { paymentTrackingMode: "PAYMENT_V1", cnExpiryDays: 10, acceptanceReason: "PAYMENT_PENDING" });
    store.paymentEvents.push({
      id: "task-unmaterialized", cnRequestId: requestId, status: "PENDING", amountPaid: null,
      eventDate: new Date("2026-09-29T00:00:00.000Z"), outstandingBefore: 5_000, outstandingAfter: 5_000,
      taskAmount: 5_000, taskDate: new Date("2026-09-29T00:00:00.000Z"), taskStatus: "SCHEDULED",
      taskRescheduled: false, taskCompletedAt: null, dailyWorkEntryId: null, dailyWorkContribution: null,
      dailyWorkConfirmed: false, source: "ACCEPTANCE", requestKey: "guard-1", recordedById: "admin-1", createdAt: new Date("2026-09-29T04:30:00.000Z"),
    });
    const svc = loadService(store.prisma);
    // A task that is not materialized into today's editable Recovery row cannot be confirmed.
    await expectStatus(() => svc.confirmMaterializedAutoTask(SO, requestId, { taskId: "task-unmaterialized" }), 409);
    // Another officer cannot confirm this officer's task.
    await expectStatus(() => svc.confirmMaterializedAutoTask(OTHER_SO, requestId, { taskId: "task-unmaterialized" }), 403);
    assert.equal(store.paymentEvents[0]?.dailyWorkConfirmed, false, "guarded task stays unconfirmed");
  }

  // Legacy CnRequest.taskDate tasks confirm through the same explicit path.
  {
    const store = makeStore();
    const legacyId = store.seed("ACCEPTED_NOT_POSTED", "cn-legacy-confirm", "so-1", { acceptedAt: new Date("2026-09-29T04:30:00.000Z") });
    Object.assign(store.rows[0]!, { paymentTrackingMode: null, acceptanceReason: "PAYMENT_PENDING", taskDate: "2026-09-29", legacyDailyWorkEntryId: "recovery-entry", legacyDailyWorkContribution: 7_500, legacyDailyWorkConfirmed: false });
    const svc = loadService(store.prisma);
    assert.equal(await svc.countUnconfirmedMaterializedTasks(store.prisma as never, "so-1", "2026-09-29", "test-batch"), 1, "legacy task counts as unconfirmed");
    const confirmed = await svc.confirmMaterializedAutoTask(SO, legacyId, {});
    assert.equal(confirmed.confirmed, true);
    assert.equal(store.rows[0]?.legacyDailyWorkConfirmed, true, "legacy confirmation persists");
    assert.equal(store.rows[0]?.status, "ACCEPTED_NOT_POSTED", "legacy confirm never changes the CN status");
    assert.equal(await svc.countUnconfirmedMaterializedTasks(store.prisma as never, "so-1", "2026-09-29", "test-batch"), 0);
  }

  // Row action menu ("⋮") composition — replaces the former "Open" button.
  {
    // Submitted / Rejected: View Details only, no download exposed.
    for (const view of ["submitted", "rejected"] as const) {
      const items = cnActionMenuItems({ section: "submitted-rejected", view, hasWorking: true });
      assert.deepEqual(items.map((i) => i.id), ["VIEW_DETAILS"], `${view} exposes only View Details`);
      assert.equal(items[0]?.labelKey, "cn_requests.action.view_details");
    }

    // Accepted / Not Posted: View Details + Download CN Workaround (enabled when an attachment exists).
    const notPosted = cnActionMenuItems({ section: "accepted", view: "accepted-not-posted", hasWorking: true });
    assert.deepEqual(notPosted.map((i) => i.id), ["VIEW_DETAILS", "DOWNLOAD_CN_WORKING"]);
    assert.equal(notPosted[1]?.labelKey, "cn_requests.action.download_cn_workaround");
    assert.equal(notPosted[1]?.enabled, true, "download enabled when the CN Working attachment exists");

    // Posted in Ledger: View Details + Download CN (same attachment, only the label differs).
    const posted = cnActionMenuItems({ section: "accepted", view: "posted-in-ledger", hasWorking: true });
    assert.deepEqual(posted.map((i) => i.id), ["VIEW_DETAILS", "DOWNLOAD_CN_WORKING"]);
    assert.equal(posted[1]?.labelKey, "cn_requests.action.download_cn");

    // Missing attachment: the download stays present but disabled (safe unavailable behaviour, not a silent fail).
    const missing = cnActionMenuItems({ section: "accepted", view: "accepted-not-posted", hasWorking: false });
    assert.equal(missing[1]?.id, "DOWNLOAD_CN_WORKING");
    assert.equal(missing[1]?.enabled, false, "download disabled when no attachment exists");
  }

  console.log("CN Request tests passed");
}

void main();
