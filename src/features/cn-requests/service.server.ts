import "server-only";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, type AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { writeAudit } from "@/lib/audit";
import { currentBusinessDate } from "@/lib/daily-work";
import { getResolvedLabels } from "@/features/labels/service.server";
import { lockDailyWorkDay } from "@/features/daily-work/day-lock.server";
import { reverseMaterializedDailyWorkContribution } from "@/features/daily-work/auto-task-materialization.server";
import {
  CN_PAYMENT_STATUS_VALUES,
  CN_ACCEPTANCE_REASON_VALUES,
  CN_ACCEPTANCE_STATUS_VALUES,
  CN_PAYMENT_STATUSES,
  CN_REJECTION_REASON_VALUES,
  CN_REQUEST_STATUSES,
  CN_REQUEST_VIEW_STATUSES,
  CN_TYPE_VALUES,
  CN_WORKING_MAX_BYTES,
  CN_WORKING_PDF_MIME,
  CN_WORKING_XLSX_MIME,
  canonicalCnType,
  cnRequestAgeDays,
  cnRequestBusinessDateKey,
  cnRequestCurrentDisplayStatus,
  cnRequestDisplayStatus,
  cnRequestExpiryDateKey,
  cnTaskKindForReason,
  cnTaskAmount,
  isCnTaskDateWithinExpiry,
  isCnBusinessDateKey,
  isCnSundayDateKey,
  nextCnWorkingDateKey,
  paymentStatusLabel,
  type CnRequestView,
  type CnRequestCurrentDisplayStatus,
  type CnAcceptanceReason,
  type CnTaskDto,
} from "@/lib/cn-request";
import { loadDealerAliasNameMap } from "@/lib/dealer-display-name.server";

/**
 * DISPLAY-only: replace each row's shown party name with the dealer's alias name when one exists. The dealer id
 * (r.dealerId) — the business identity — is never changed; only the human-facing `partyName` string is swapped.
 * Shared by every CN list that shows a dealer (CN Requests, pending/active tasks, Auto Tasks in Daily Work).
 */
async function withDealerDisplayNames<T extends { dealerId: string; partyName: string }>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const aliasMap = await loadDealerAliasNameMap(rows.map((r) => r.dealerId));
  if (aliasMap.size === 0) return rows;
  return rows.map((r) => { const alias = aliasMap.get(r.dealerId); return alias ? { ...r, partyName: alias } : r; });
}

/**
 * CN (Credit Note) Requests. A Sales Officer raises a request for one of their assigned dealers; an RM
 * rejects team requests; the Super Admin accepts with the required CN working document, rejects, and separately
 * marks accepted requests as posted. Status flow: SUBMITTED → ACCEPTED_NOT_POSTED / POSTED_IN_LEDGER, or REJECTED.
 */
export { CN_PAYMENT_STATUSES, CN_TYPE_VALUES as CN_TYPES };

type ResolvedLabels = Awaited<ReturnType<typeof getResolvedLabels>>;

/** Request schemas resolve the current global label overrides for every user-facing validation message. */
function cnSchemas(L: ResolvedLabels) {
  const create = z.object({
    dealerId: z.string({ required_error: L["cn_requests.validation.select_party"], invalid_type_error: L["cn_requests.validation.select_party"] }).min(1, L["cn_requests.validation.select_party"]),
    cnType: z.enum(CN_TYPE_VALUES, { errorMap: () => ({ message: L["cn_requests.validation.valid_type"] }) }),
    officerId: z.string().optional(),
    details: z.string({ required_error: L["cn_requests.validation.details_required"], invalid_type_error: L["cn_requests.validation.details_required"] })
      .trim().min(1, L["cn_requests.validation.details_required"]).max(1000),
  });
  const act = z.object({
    action: z.literal("reject"),
    reason: z.enum(CN_REJECTION_REASON_VALUES, { errorMap: () => ({ message: L["cn_requests.validation.rejection_reason_required"] }) }).optional(),
    rejectionReasonDetails: z.string().max(500).optional(),
  }).superRefine((value, ctx) => {
    if (!value.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: L["cn_requests.validation.rejection_reason_required"] });
    else if (value.reason === "OTHER" && !value.rejectionReasonDetails?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rejectionReasonDetails"], message: L["cn_requests.validation.other_reason_required"] });
  });
  const acceptance = z.object({
    status: z.enum(CN_ACCEPTANCE_STATUS_VALUES, { errorMap: () => ({ message: L["cn_requests.validation.acceptance_status_required"] }) }),
    reason: z.enum(CN_ACCEPTANCE_REASON_VALUES, { errorMap: () => ({ message: L["cn_requests.validation.acceptance_reason_required"] }) }).optional(),
    acceptanceReasonDetails: z.string().max(500).optional(),
    cnExpiryDays: z.preprocess((value) => value === "" || value == null ? undefined : value,
      z.coerce.number({ invalid_type_error: L["cn_requests.validation.expiry_invalid"] }).int(L["cn_requests.validation.expiry_invalid"]).positive(L["cn_requests.validation.expiry_invalid"]).max(2_147_483_647, L["cn_requests.validation.expiry_invalid"]).optional()),
    postedAmount: z.preprocess((value) => value === "" || value == null ? undefined : value,
      z.coerce.number({ invalid_type_error: L["cn_requests.validation.posted_amount_invalid"] }).finite(L["cn_requests.validation.posted_amount_invalid"]).positive(L["cn_requests.validation.posted_amount_invalid"]).optional()),
    outstandingAmount: z.preprocess((value) => value === "" || value == null ? undefined : value,
      z.coerce.number({ invalid_type_error: L["cn_requests.validation.outstanding_invalid"] }).finite(L["cn_requests.validation.outstanding_invalid"]).positive(L["cn_requests.validation.outstanding_invalid"]).optional()),
  }).superRefine((value, ctx) => {
    if (value.status === "ACCEPTED_NOT_POSTED") {
      if (!value.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: L["cn_requests.validation.acceptance_reason_required"] });
      else if (value.reason === "OTHER" && !value.acceptanceReasonDetails?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptanceReasonDetails"], message: L["cn_requests.validation.other_reason_required"] });
      if (value.cnExpiryDays == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cnExpiryDays"], message: L["cn_requests.validation.expiry_required"] });
      if (value.reason === "PAYMENT_PENDING" && value.outstandingAmount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outstandingAmount"], message: L["cn_requests.validation.outstanding_required"] });
    } else if (value.postedAmount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["postedAmount"], message: L["cn_requests.validation.posted_amount_required"] });
  });
  return { create, act, acceptance };
}

export interface CnWorkingUpload {
  name: string;
  type: string;
  buffer: Buffer;
}

function validateCnWorking(upload: CnWorkingUpload | null | undefined, L: ResolvedLabels): CnWorkingUpload {
  if (!upload || upload.buffer.length === 0) throw new ApiError(422, L["cn_requests.validation.working_required"]);
  if (upload.buffer.length > CN_WORKING_MAX_BYTES) throw new ApiError(422, L["cn_requests.validation.working_too_large"]);
  const fileName = upload.name.trim();
  if (!fileName || fileName.length > 255) throw new ApiError(422, L["cn_requests.validation.working_filename_invalid"]);
  const extension = fileName.toLowerCase().match(/(\.[^.]+)$/)?.[1] ?? "";
  const isPdf = extension === ".pdf" && upload.type === CN_WORKING_PDF_MIME;
  const isXlsx = extension === ".xlsx" && upload.type === CN_WORKING_XLSX_MIME;
  if (!isPdf && !isXlsx) throw new ApiError(422, L["cn_requests.validation.working_file_type"]);
  const hasPdfSignature = upload.buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const hasZipSignature = upload.buffer.length >= 4 && upload.buffer[0] === 0x50 && upload.buffer[1] === 0x4b && upload.buffer[2] === 0x03 && upload.buffer[3] === 0x04;
  if ((isPdf && !hasPdfSignature) || (isXlsx && !hasZipSignature)) {
    throw new ApiError(422, L["cn_requests.validation.working_content_type"]);
  }
  return { ...upload, name: fileName };
}

function num(d: unknown): number | null {
  return d == null ? null : Number(d.toString());
}

export interface CnRequestRow {
  id: string;
  dealerId: string;
  partyName: string;
  cnType: string;
  amount: number | null;
  postedAmount: number | null;
  paymentOriginalAmount: number | null;
  paymentOutstandingAmount: number | null;
  paymentTrackingMode: string | null;
  paymentStatus: string | null;
  paymentVerified: boolean; // true = Admin-verified (green pill); false = SO-reported/unverified (gray pill)
  officerId: string;
  employeeName: string;
  state: string | null;
  territory: string | null;
  status: string;
  details: string | null;
  rejectionReason: string | null;
  rejectionReasonDetails: string | null;
  acceptanceReason: string | null;
  acceptanceReasonDetails: string | null;
  cnExpiryDays: number | null;
  expiryDate: string | null;
  cnWorking: { fileName: string; mimeType: string; fileSize: number; uploadedAt: string | null } | null;
  remarks: string | null;
  createdAt: string;
  days: number | null;
}

type RawRow = {
  id: string; dealerId: string; cnType: string; amount: unknown; postedAmount: unknown; paymentStatus: string | null; paymentOriginalAmount: unknown; paymentOutstandingAmount: unknown; paymentTrackingMode: string | null; paymentVerified?: boolean; officerId: string; status: string; details: string | null; rejectionReason: string | null; rejectionReasonDetails: string | null; acceptanceReason: string | null; acceptanceReasonDetails: string | null; cnExpiryDays: number | null; cnWorkingFileName: string | null; cnWorkingMimeType: string | null; cnWorkingFileSize: number | null; cnWorkingUploadedAt: Date | null; remarks: string | null; createdAt: Date;
  acceptedAt: Date | null; rejectedAt: Date | null; postedAt: Date | null;
  dealer: { name: string };
  officer: { name: string; territory: string | null; group: { name: string } | null };
};
function toRow(r: RawRow): CnRequestRow {
  const approximateAmount = num(r.amount);
  const postedAmount = num(r.postedAmount);
  return {
    id: r.id,
    dealerId: r.dealerId,
    partyName: r.dealer.name,
    cnType: canonicalCnType(r.cnType),
    amount: cnRequestDisplayStatus(r.status) === "POSTED_IN_LEDGER" && postedAmount != null ? postedAmount : approximateAmount,
    postedAmount,
    paymentOriginalAmount: num(r.paymentOriginalAmount),
    paymentOutstandingAmount: num(r.paymentOutstandingAmount),
    paymentTrackingMode: r.paymentTrackingMode,
    paymentStatus: r.paymentStatus,
    paymentVerified: r.paymentVerified ?? false,
    officerId: r.officerId,
    employeeName: r.officer.name,
    state: r.officer.group?.name ?? null,
    territory: r.officer.territory ?? null,
    status: r.status,
    details: r.details ?? null,
    rejectionReason: r.rejectionReason ?? null,
    rejectionReasonDetails: r.rejectionReasonDetails ?? null,
    acceptanceReason: r.acceptanceReason ?? null,
    acceptanceReasonDetails: r.acceptanceReasonDetails ?? null,
    cnExpiryDays: r.cnExpiryDays ?? null,
    expiryDate: r.acceptedAt ? cnRequestExpiryDateKey(r.acceptedAt, r.cnExpiryDays) : null,
    cnWorking: r.cnWorkingFileName && r.cnWorkingMimeType && r.cnWorkingFileSize != null ? {
      fileName: r.cnWorkingFileName,
      mimeType: r.cnWorkingMimeType,
      fileSize: r.cnWorkingFileSize,
      uploadedAt: r.cnWorkingUploadedAt?.toISOString() ?? null,
    } : null,
    remarks: r.remarks,
    createdAt: r.createdAt.toISOString(),
    days: cnRequestAgeDays(r),
  };
}
const ROW_SELECT = {
  id: true, dealerId: true, cnType: true, amount: true, postedAmount: true, paymentStatus: true, paymentOriginalAmount: true, paymentOutstandingAmount: true, paymentTrackingMode: true, officerId: true, status: true,
  details: true, rejectionReason: true, rejectionReasonDetails: true, acceptanceReason: true,
  acceptanceReasonDetails: true, cnExpiryDays: true, cnWorkingFileName: true, cnWorkingMimeType: true, cnWorkingFileSize: true,
  cnWorkingUploadedAt: true, remarks: true, createdAt: true, acceptedAt: true, rejectedAt: true, postedAt: true,
  dealer: { select: { name: true } },
  officer: { select: { name: true, territory: true, group: { select: { name: true } } } },
} as const;

/**
 * A Sales Officer or Regional Manager raises a CN Request. The SO always raises for themselves; an RM may
 * raise for themselves ("My Dealer") OR on behalf of a Sales Officer on their team ("Team"). The chosen
 * Party (dealer) must be assigned to the TARGET officer.
 */
export async function createCnRequest(ctx: AuthContext, raw: unknown): Promise<{ id: string }> {
  const L = await getResolvedLabels();
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, L["cn_requests.error.create_role"]);
  const parsed = cnSchemas(L).create.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.validation.invalid_request"]);
  const data = parsed.data;

  // Resolve the target officer the request is raised FOR.
  let targetOfficerId = ctx.userId;
  if (data.officerId && data.officerId !== ctx.userId) {
    if (ctx.role !== Role.REGIONAL_MANAGER) throw new ApiError(403, L["cn_requests.error.manager_team_only"]);
    const scope = await getOfficerScope(ctx);
    if (!scope.ids.includes(data.officerId)) throw new ApiError(403, L["cn_requests.error.officer_not_on_team"]);
    targetOfficerId = data.officerId;
  }

  const assigned = await prisma.dealerAssignment.findFirst({ where: { officerId: targetOfficerId, dealerId: data.dealerId, effectiveTo: null }, select: { id: true } });
  if (!assigned) throw new ApiError(422, L["cn_requests.error.party_not_assigned"]);

  const created = (await prisma.cnRequest.create({
    data: { officerId: targetOfficerId, dealerId: data.dealerId, cnType: data.cnType, amount: null, paymentStatus: null, details: data.details, status: "SUBMITTED" },
    select: { id: true },
  })) as { id: string };
  await writeAudit({ userId: ctx.userId, action: "CREATE", entity: "cnRequest", entityId: created.id, summary: `CN Request (${data.cnType}) raised${targetOfficerId !== ctx.userId ? " for a team member" : ""}` });
  return { id: created.id };
}

/**
 * Assigned dealers for the Party dropdown. Without `officerId` → the caller's own (SO or RM). With
 * `officerId` → that officer's dealers, allowed only when an RM requests one of THEIR team's Sales
 * Officers (RM "Team" flow). Admins get none.
 */
export async function myAssignedDealers(ctx: AuthContext, officerId?: string): Promise<{ id: string; name: string }[]> {
  if (ctx.role !== Role.SALES_OFFICER && ctx.role !== Role.REGIONAL_MANAGER) return [];
  let targetOfficerId = ctx.userId;
  if (officerId && officerId !== ctx.userId) {
    if (ctx.role !== Role.REGIONAL_MANAGER) return [];
    const scope = await getOfficerScope(ctx);
    if (!scope.ids.includes(officerId)) return []; // not on the RM's team
    targetOfficerId = officerId;
  }
  const assignments = (await prisma.dealerAssignment.findMany({ where: { officerId: targetOfficerId, effectiveTo: null }, select: { dealerId: true } })) as { dealerId: string }[];
  const ids = assignments.map((a) => a.dealerId);
  if (ids.length === 0) return [];
  const dealers = (await prisma.dealer.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } })) as { id: string; name: string }[];
  // DISPLAY-only: alias-preferred label for the Party dropdown; the option VALUE (id) is the dealer identity.
  const aliasNames = await loadDealerAliasNameMap(ids);
  return dealers.map((d) => ({ id: d.id, name: aliasNames.get(d.id) ?? d.name }));
}

/**
 * The Sales Officers on a Regional Manager's team (for the "Team" request flow's officer dropdown).
 * RM only — the RM's own group Sales Officers, excluding the RM. Others get none.
 */
export async function myTeamOfficers(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  if (ctx.role !== Role.REGIONAL_MANAGER || !ctx.groupId) return [];
  const officers = (await prisma.user.findMany({
    where: { role: Role.SALES_OFFICER, groupId: ctx.groupId, isActive: true, deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })) as { id: string; name: string }[];
  return officers;
}

/**
 * Dealer-level latest/current CN state for read-only integrations such as Recovery Planning.
 * One batched query serves every displayed dealer. Ordering is deterministic and the status itself is resolved
 * through the same current-display helper used by the CN Requests screen, including returned-from-ledger rows.
 */
export async function latestCnRequestStatusByDealer(
  dealerIds: string[],
): Promise<Map<string, CnRequestCurrentDisplayStatus>> {
  const uniqueDealerIds = [...new Set(dealerIds.filter(Boolean))];
  if (uniqueDealerIds.length === 0) return new Map();
  const rows = await prisma.cnRequest.findMany({
    where: { dealerId: { in: uniqueDealerIds } },
    select: { id: true, dealerId: true, status: true, paymentStatus: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latest = new Map<string, CnRequestCurrentDisplayStatus>();
  for (const row of rows) {
    if (!latest.has(row.dealerId)) {
      latest.set(row.dealerId, cnRequestCurrentDisplayStatus(row.status, row.paymentStatus));
    }
  }
  return latest;
}

/** Scoped list: SO → own; RM → their team (own + group officers); Admin → all. Newest first. */
/** paymentVerified (green vs gray) is loaded separately to preserve the existing row DTO query shape. */
async function paymentVerifiedMap(ids: string[]): Promise<Map<string, boolean>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ id: string; paymentVerified: boolean }[]>(
    Prisma.sql`SELECT "id", "paymentVerified" FROM "CnRequest" WHERE "id" IN (${Prisma.join(ids)})`,
  );
  return new Map(rows.map((r) => [r.id, r.paymentVerified]));
}

export async function listCnRequests(ctx: AuthContext, view?: CnRequestView): Promise<CnRequestRow[]> {
  const scope = await getOfficerScope(ctx);
  let viewWhere: Prisma.CnRequestWhereInput = {};
  if (view === "submitted" || view === "rejected") {
    viewWhere = { status: { in: [...CN_REQUEST_VIEW_STATUSES[view]] } };
  } else if (view === "accepted-not-posted" || view === "posted-in-ledger") {
    const acceptedStatuses = [
      ...CN_REQUEST_VIEW_STATUSES["accepted-not-posted"],
      ...CN_REQUEST_VIEW_STATUSES["posted-in-ledger"],
    ];
    viewWhere = {
      status: { in: acceptedStatuses },
      ...(view === "posted-in-ledger"
        ? { paymentStatus: "Paid", paymentVerified: true }
        : { OR: [{ paymentStatus: null }, { paymentStatus: { not: "Paid" } }, { paymentVerified: false }] }),
    };
  }
  const rows = (await prisma.cnRequest.findMany({
    where: { ...(scope.all ? {} : { officerId: { in: scope.ids } }), ...viewWhere },
    select: ROW_SELECT,
    orderBy: { createdAt: "desc" },
  })) as unknown as RawRow[];
  const verified = await paymentVerifiedMap(rows.map((r) => r.id));
  return withDealerDisplayNames(rows.map((r) => toRow({ ...r, paymentVerified: verified.get(r.id) ?? false })));
}

export async function getCnRequest(ctx: AuthContext, id: string): Promise<CnRequestRow> {
  const L = await getResolvedLabels();
  const r = (await prisma.cnRequest.findUnique({ where: { id }, select: ROW_SELECT })) as unknown as RawRow | null;
  if (!r) throw new ApiError(404, L["cn_requests.error.not_found"]);
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(r.officerId)) throw new ApiError(403, L["cn_requests.error.cannot_view"]);
  const row = toRow({ ...r, paymentVerified: (await paymentVerifiedMap([id])).get(id) ?? false });
  return (await withDealerDisplayNames([row]))[0];
}

/**
 * Reject a request. Acceptance and posting are handled by acceptCnRequest because both require the controlled
 * multipart flow and posting requires an Admin-entered actual ledger amount.
 */
export async function actOnCnRequest(ctx: AuthContext, id: string, raw: unknown): Promise<{ status: string }> {
  const L = await getResolvedLabels();
  const parsed = cnSchemas(L).act.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.validation.invalid_action"]);
  const { reason, rejectionReasonDetails } = parsed.data;
  const rejectionData = {
    rejectionReason: reason!,
    rejectionReasonDetails: reason === "OTHER" ? rejectionReasonDetails!.trim() : null,
  };
  const r = (await prisma.cnRequest.findUnique({ where: { id }, select: { id: true, officerId: true, status: true } })) as { id: string; officerId: string; status: string } | null;
  if (!r) throw new ApiError(404, L["cn_requests.error.not_found"]);

  if (ctx.role === Role.REGIONAL_MANAGER) {
    // An RM may also raise requests, but cannot act on their OWN — only on a team member's.
    if (r.officerId === ctx.userId) throw new ApiError(403, L["cn_requests.error.cannot_reject_own"]);
    const scope = await getOfficerScope(ctx);
    if (!scope.ids.includes(r.officerId)) throw new ApiError(403, L["cn_requests.error.not_from_team"]);
    if (r.status !== "SUBMITTED") throw new ApiError(409, L["cn_requests.error.submitted_reject_only"]);
    const transitionAt = new Date();
    await prisma.cnRequest.update({ where: { id }, data: { status: CN_REQUEST_STATUSES.REJECTED, actedByRmId: ctx.userId, rejectedAt: transitionAt, ...rejectionData } });
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnRequest", entityId: id, summary: `CN Request rejected by RM (Reason: ${reason})` });
    return { status: CN_REQUEST_STATUSES.REJECTED };
  }

  if (ctx.role === Role.SUPER_ADMIN) {
    if (r.status !== CN_REQUEST_STATUSES.SUBMITTED) throw new ApiError(409, L["cn_requests.error.submitted_reject_only"]);
    const transitionAt = new Date();
    await prisma.cnRequest.update({ where: { id }, data: { status: CN_REQUEST_STATUSES.REJECTED, actedByAdminId: ctx.userId, rejectedAt: transitionAt, ...rejectionData } });
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnRequest", entityId: id, summary: `CN Request rejected by Super Admin (Reason: ${reason})` });
    return { status: CN_REQUEST_STATUSES.REJECTED };
  }

  throw new ApiError(403, L["cn_requests.error.cannot_act"]);
}

function businessDateValue(value: Date, errorMessage: string): Date {
  const key = cnRequestBusinessDateKey(value);
  if (!key) throw new ApiError(500, errorMessage);
  return new Date(`${key}T00:00:00.000Z`);
}

function isOpenCnTaskDate(taskDate: string, acceptedAt: Date, expiryDays: number): boolean {
  const today = currentBusinessDate();
  const expiryDate = cnRequestExpiryDateKey(acceptedAt, expiryDays);
  return !!today && !!expiryDate && today <= expiryDate && isCnTaskDateWithinExpiry(taskDate, acceptedAt, expiryDays);
}

type CnPostingRequest = {
  id: string;
  status: string;
  cnWorkingDocument: string | null;
  cnWorkingFileName: string | null;
  cnWorkingMimeType: string | null;
};

type CnWorkingDocumentData = {
  cnWorkingDocument?: string;
  cnWorkingFileName?: string;
  cnWorkingMimeType?: string;
  cnWorkingFileSize?: number;
  cnWorkingUploadedById?: string;
  cnWorkingUploadedAt?: Date;
};

/** The single Accepted → Posted in Ledger transition, shared by manual posting and Paid verification. */
async function postAcceptedCnRequestInTransaction(
  tx: Prisma.TransactionClient,
  request: CnPostingRequest,
  postedAmount: number,
  transitionAt: Date,
  adminId: string,
  L: ResolvedLabels,
  documentData: CnWorkingDocumentData = {},
): Promise<{ posted: boolean; documentName: string | null }> {
  if (request.status === CN_REQUEST_STATUSES.POSTED_IN_LEDGER) {
    return { posted: false, documentName: request.cnWorkingFileName };
  }
  if (request.status !== CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED) {
    throw new ApiError(409, L["cn_requests.error.process_state"]);
  }
  if (!Number.isFinite(postedAmount) || postedAmount <= 0) {
    throw new ApiError(422, L["cn_requests.validation.posted_amount_invalid"]);
  }
  const hasExistingDocument = !!request.cnWorkingDocument && !!request.cnWorkingFileName && !!request.cnWorkingMimeType;
  const hasReplacementDocument = !!documentData.cnWorkingDocument && !!documentData.cnWorkingFileName && !!documentData.cnWorkingMimeType;
  if (!hasExistingDocument && !hasReplacementDocument) {
    throw new ApiError(422, L["cn_requests.validation.working_required"]);
  }

  const transition = await tx.cnRequest.updateMany({
    where: { id: request.id, status: CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED },
    data: {
      status: CN_REQUEST_STATUSES.POSTED_IN_LEDGER,
      postedAmount,
      postedAt: transitionAt,
      actedByAdminId: adminId,
      ...documentData,
    },
  });
  if (transition.count === 0) throw new ApiError(409, L["cn_requests.error.request_changed"]);
  return { posted: true, documentName: documentData.cnWorkingFileName ?? request.cnWorkingFileName };
}

/** Admin acceptance/posting stores its authoritative amount, payment start/task, document and status atomically. */
export async function acceptCnRequest(
  ctx: AuthContext,
  id: string,
  raw: unknown,
  rawUpload: CnWorkingUpload | null | undefined,
): Promise<{ status: string }> {
  const L = await getResolvedLabels();
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, L["cn_requests.error.admin_accept_only"]);
  const parsed = cnSchemas(L).acceptance.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.validation.invalid_acceptance"]);
  const transitionAt = new Date();
  const upload = rawUpload ? validateCnWorking(rawUpload, L) : null;
  const isNotPosted = parsed.data.status === CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED;
  const acceptanceReason = isNotPosted ? parsed.data.reason! : null;
  const acceptanceReasonDetails = isNotPosted && acceptanceReason === "OTHER"
    ? parsed.data.acceptanceReasonDetails!.trim()
    : null;
  const documentData = upload ? {
    cnWorkingDocument: `data:${upload.type};base64,${upload.buffer.toString("base64")}`,
    cnWorkingFileName: upload.name,
    cnWorkingMimeType: upload.type,
    cnWorkingFileSize: upload.buffer.length,
    cnWorkingUploadedById: ctx.userId,
    cnWorkingUploadedAt: transitionAt,
  } : {};
  const paymentPending = isNotPosted && acceptanceReason === "PAYMENT_PENDING";
  const defaultTaskDate = paymentPending ? nextCnWorkingDateKey(transitionAt) : null;
  if (paymentPending && (!defaultTaskDate || !isCnTaskDateWithinExpiry(defaultTaskDate, transitionAt, parsed.data.cnExpiryDays!))) {
    throw new ApiError(422, L["cn_requests.validation.default_task_date_unavailable"]);
  }
  const documentName = await prisma.$transaction(async (tx) => {
    const request = await tx.cnRequest.findUnique({
      where: { id },
      select: { id: true, status: true, cnWorkingDocument: true, cnWorkingFileName: true, cnWorkingMimeType: true },
    });
    if (!request) throw new ApiError(404, L["cn_requests.error.not_found"]);
    const postingExisting = request.status === CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED && !isNotPosted;
    const acceptingSubmitted = request.status === CN_REQUEST_STATUSES.SUBMITTED;
    if (!acceptingSubmitted && !postingExisting) {
      throw new ApiError(409, L["cn_requests.error.process_state"]);
    }
    const hasExistingDocument = !!request.cnWorkingDocument && !!request.cnWorkingFileName && !!request.cnWorkingMimeType;
    if ((!postingExisting || !hasExistingDocument) && !upload) throw new ApiError(422, L["cn_requests.validation.working_required"]);

    if (postingExisting) {
      const result = await postAcceptedCnRequestInTransaction(
        tx,
        request,
        parsed.data.postedAmount!,
        transitionAt,
        ctx.userId,
        L,
        documentData,
      );
      return result.documentName;
    }

    const transitionData = {
      status: parsed.data.status,
      acceptanceReason,
      acceptanceReasonDetails,
      cnExpiryDays: isNotPosted ? parsed.data.cnExpiryDays! : null,
      postedAmount: isNotPosted ? null : parsed.data.postedAmount!,
      paymentStatus: paymentPending ? "Pending" : undefined,
      paymentOriginalAmount: paymentPending ? parsed.data.outstandingAmount! : undefined,
      paymentOutstandingAmount: paymentPending ? parsed.data.outstandingAmount! : undefined,
      paymentTrackingMode: isNotPosted ? (paymentPending ? "PAYMENT_V1" : "NONE") : undefined,
      actedByAdminId: ctx.userId,
      acceptedAt: transitionAt,
      postedAt: isNotPosted ? null : transitionAt,
      ...documentData,
    };
    const transition = await tx.cnRequest.updateMany({ where: { id, status: request.status }, data: transitionData });
    if (transition.count === 0) throw new ApiError(409, L["cn_requests.error.request_changed"]);

    if (paymentPending) {
      await tx.cnPaymentEvent.create({
        data: {
          cnRequestId: id,
          status: "PENDING",
          eventDate: businessDateValue(transitionAt, L["cn_requests.error.business_date"]),
          outstandingBefore: parsed.data.outstandingAmount!,
          outstandingAfter: parsed.data.outstandingAmount!,
          taskAmount: parsed.data.outstandingAmount!,
          taskDate: businessDateValue(new Date(`${defaultTaskDate}T00:00:00.000Z`), L["cn_requests.error.business_date"]),
          taskStatus: "SCHEDULED",
          taskRescheduled: false,
          source: "ACCEPTANCE",
          requestKey: `acceptance:${id}`,
          recordedById: ctx.userId,
        },
      });
    }
    return upload?.name ?? request.cnWorkingFileName;
  });

  const reasonSummary = isNotPosted
    ? `; Reason: ${acceptanceReason}${acceptanceReason === "OTHER" ? `; Details: ${acceptanceReasonDetails}` : ""}`
    : "";
  await writeAudit({
    userId: ctx.userId,
    action: "UPDATE",
    entity: "cnRequest",
    entityId: id,
    summary: `CN Request ${isNotPosted ? "accepted, not posted" : "accepted, posted in ledger"}${reasonSummary}${paymentPending ? `; Outstanding Amount: ${parsed.data.outstandingAmount}` : ""}${isNotPosted ? `; CN Expiry: ${parsed.data.cnExpiryDays} days` : `; Posted Amount: ${parsed.data.postedAmount}`}; CN working: ${documentName}`,
  });
  return { status: parsed.data.status };
}

export async function getCnWorkingDocument(ctx: AuthContext, id: string): Promise<{
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}> {
  const L = await getResolvedLabels();
  const request = await prisma.cnRequest.findUnique({
    where: { id },
    select: { officerId: true, cnWorkingDocument: true, cnWorkingFileName: true, cnWorkingMimeType: true },
  });
  if (!request) throw new ApiError(404, L["cn_requests.error.not_found"]);
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(request.officerId)) throw new ApiError(403, L["cn_requests.error.cannot_access_working"]);
  if (!request.cnWorkingDocument || !request.cnWorkingFileName || !request.cnWorkingMimeType) {
    throw new ApiError(404, L["cn_requests.error.working_unavailable"]);
  }
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(request.cnWorkingDocument);
  if (!match || match[1] !== request.cnWorkingMimeType) throw new ApiError(500, L["cn_requests.error.working_unavailable"]);
  return {
    buffer: Buffer.from(match[2], "base64"),
    fileName: request.cnWorkingFileName,
    mimeType: request.cnWorkingMimeType,
  };
}

/* =====================================================================================
 * CN PAYMENT HISTORY + RECOVERY FOLLOW-UPS. CnPaymentEvent is immutable financial history and may own
 * one task. The task remains rendered/scheduled through Daily Work → Recovery. CnRequest.taskDate is read
 * only for legacy rows (paymentTrackingMode IS NULL), so no historical backfill or invented amount occurs.
 * ===================================================================================== */

export interface CnPaymentDetailDto {
  cnRequestId: string;
  dealerId: string;
  partyName: string;
  cnType: string;
  details: string | null;
  cnStatus: string;
  paymentStatus: string | null;
  originalOutstandingAmount: number | null;
  currentOutstandingAmount: number | null;
  expiryDate: string | null;
  canUpdate: boolean; // SO may report a payment on the active SCHEDULED task
  canVerify: boolean; // Admin may verify/override the current payment status
  paymentVerified: boolean; // true = Admin-verified (green); false = SO-reported/unverified (gray)
  isAdmin: boolean;
  activeTaskId: string | null;
  events: Array<{
    id: string; status: string; amountPaid: number | null; eventDate: string;
    outstandingBefore: number; outstandingAfter: number; source: string; recordedBy: string; createdAt: string;
  }>;
  tasks: Array<{
    id: string; eventId: string; amount: number; date: string | null; status: string; createdAt: string;
  }>;
}

async function assertCnPaymentAccess(ctx: AuthContext, officerId: string, L: ResolvedLabels): Promise<void> {
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(officerId)) throw new ApiError(403, L["cn_requests.error.cannot_access_payment"]);
}

export async function getCnPaymentDetail(ctx: AuthContext, id: string): Promise<CnPaymentDetailDto> {
  const L = await getResolvedLabels();
  const request = await prisma.cnRequest.findUnique({
    where: { id },
    select: {
      id: true, dealerId: true, officerId: true, status: true, cnType: true, details: true, paymentStatus: true,
      paymentOriginalAmount: true, paymentOutstandingAmount: true, paymentTrackingMode: true,
      acceptedAt: true, cnExpiryDays: true, dealer: { select: { name: true } },
      paymentEvents: { orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }], include: { recordedBy: { select: { name: true } } } },
    },
  });
  if (!request) throw new ApiError(404, L["cn_requests.error.not_found"]);
  await assertCnPaymentAccess(ctx, request.officerId, L);
  if (request.paymentTrackingMode !== "PAYMENT_V1") throw new ApiError(404, L["cn_requests.error.payment_tracking_unavailable"]);
  const events = request.paymentEvents.map((event) => ({
    id: event.id,
    status: event.status,
    amountPaid: num(event.amountPaid),
    eventDate: event.eventDate.toISOString().slice(0, 10),
    outstandingBefore: Number(event.outstandingBefore),
    outstandingAfter: Number(event.outstandingAfter),
    source: event.source,
    recordedBy: event.recordedBy.name,
    createdAt: event.createdAt.toISOString(),
  }));
  const tasks = request.paymentEvents.filter((event) => event.taskStatus && event.taskAmount != null).map((event) => ({
    id: event.id,
    eventId: event.id,
    amount: Number(event.taskAmount),
    date: event.taskDate?.toISOString().slice(0, 10) ?? null,
    status: event.taskStatus!,
    createdAt: event.createdAt.toISOString(),
  }));
  const activeTask = [...request.paymentEvents].reverse().find((event) => event.taskStatus === "UNSCHEDULED" || event.taskStatus === "SCHEDULED");
  const isAdmin = ctx.role === Role.SUPER_ADMIN;
  const outstanding = num(request.paymentOutstandingAmount);
  const [verifiedRow] = await prisma.$queryRaw<{ paymentVerified: boolean }[]>(
    Prisma.sql`SELECT "paymentVerified" FROM "CnRequest" WHERE "id" = ${id}`,
  );
  return {
    cnRequestId: request.id,
    dealerId: request.dealerId,
    partyName: request.dealer.name,
    cnType: canonicalCnType(request.cnType),
    details: request.details,
    cnStatus: request.status,
    paymentStatus: request.paymentStatus,
    originalOutstandingAmount: num(request.paymentOriginalAmount),
    currentOutstandingAmount: outstanding,
    expiryDate: request.acceptedAt ? cnRequestExpiryDateKey(request.acceptedAt, request.cnExpiryDays) : null,
    // SO reports a payment on the active SCHEDULED task; Admin verifies once the SO has reported a status.
    canUpdate: ctx.role === Role.SALES_OFFICER && ctx.userId === request.officerId && activeTask?.taskStatus === "SCHEDULED",
    canVerify: isAdmin && request.paymentStatus != null && request.paymentStatus !== "Pending",
    paymentVerified: verifiedRow?.paymentVerified ?? false,
    isAdmin,
    activeTaskId: activeTask?.id ?? null,
    events,
    tasks,
  };
}

function paymentSchemas(L: ResolvedLabels) {
  const amountPaid = z.preprocess((v) => v === "" || v == null ? undefined : v,
    z.coerce.number({ invalid_type_error: L["cn_requests.validation.payment_amount_invalid"] }).finite(L["cn_requests.validation.payment_amount_invalid"]).positive(L["cn_requests.validation.payment_amount_invalid"]).optional());
  return {
    update: z.object({
      status: z.enum(CN_PAYMENT_STATUS_VALUES, { errorMap: () => ({ message: L["cn_requests.validation.payment_status_required"] }) }),
      amountPaid, paymentDate: z.string().optional(), followUpDate: z.string().optional(), taskId: z.string().optional(), requestKey: z.string().min(8).max(200),
    }),
    verify: z.object({
      status: z.enum(CN_PAYMENT_STATUS_VALUES, { errorMap: () => ({ message: L["cn_requests.validation.payment_status_required"] }) }),
      amountPaid, requestKey: z.string().min(8).max(200),
    }),
    schedule: z.object({ taskId: z.string().optional(), taskDate: z.string().refine(isCnBusinessDateKey, L["cn_requests.validation.valid_task_date"]) }),
    confirmTask: z.object({ taskId: z.string().optional() }),
  };
}

/**
 * SO PAYMENT REPORT (provisional). The Sales Officer reports what happened on the active SCHEDULED Recovery
 * task: Paid / Partial Paid / Not Paid, with the payment/follow-up dates. This records an immutable SO_UPDATE
 * event, moves the provisional outstanding, and (for Partial/Not Paid) opens the next SCHEDULED task on the
 * SO-chosen date within the CN expiry window. The result is UNVERIFIED (gray) until an Admin verifies it.
 */
export async function updateCnPayment(ctx: AuthContext, id: string, raw: unknown): Promise<CnPaymentDetailDto> {
  const L = await getResolvedLabels();
  const parsed = paymentSchemas(L).update.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.validation.invalid_payment_update"]);
  const data = parsed.data;
  const existingKey = await prisma.cnPaymentEvent.findUnique({ where: { requestKey: data.requestKey }, select: { cnRequestId: true } });
  if (existingKey) {
    if (existingKey.cnRequestId !== id) throw new ApiError(409, L["cn_requests.error.payment_key_used"]);
    return getCnPaymentDetail(ctx, id);
  }

  await prisma.$transaction(async (tx) => {
    const request = await tx.cnRequest.findUnique({
      where: { id },
      select: {
        id: true, officerId: true, paymentTrackingMode: true, paymentStatus: true,
        paymentOriginalAmount: true, paymentOutstandingAmount: true, acceptedAt: true, cnExpiryDays: true,
        paymentEvents: { where: { taskStatus: { in: ["UNSCHEDULED", "SCHEDULED"] } }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!request) throw new ApiError(404, L["cn_requests.error.not_found"]);
    // SO report is Sales-Officer-only; Admin uses verifyCnPayment (a separate, authoritative action).
    if (!(ctx.role === Role.SALES_OFFICER && ctx.userId === request.officerId)) {
      throw new ApiError(403, L["cn_requests.error.owning_officer_payment"]);
    }
    if (request.paymentTrackingMode !== "PAYMENT_V1" || request.paymentOriginalAmount == null || request.paymentOutstandingAmount == null) {
      throw new ApiError(409, L["cn_requests.error.payment_tracking_inactive"]);
    }
    const before = Number(request.paymentOutstandingAmount);
    const currentStatus = request.paymentStatus;
    const activeTask = request.paymentEvents[0] ?? null;
    if (data.taskId && activeTask?.id !== data.taskId) throw new ApiError(409, L["cn_requests.error.recovery_task_inactive"]);
    if (!activeTask || activeTask.taskStatus !== "SCHEDULED") {
      throw new ApiError(409, L["cn_requests.error.schedule_task_first"]);
    }

    let amountPaid: number | null = null;
    let after = before;
    let taskAmount: number | null = null;
    let taskDate: Date | null = null;
    let taskStatus: string | null = null;

    if (data.status === "PAID") {
      if (before <= 0) throw new ApiError(409, L["cn_requests.error.payment_settled"]);
      if (!data.paymentDate) throw new ApiError(422, L["cn_requests.validation.payment_date_required"]);
      if (!isCnBusinessDateKey(data.paymentDate)) throw new ApiError(422, L["cn_requests.validation.payment_date_invalid"]);
      amountPaid = before;
      after = 0;
    } else if (data.status === "NOT_PAID") {
      if (before <= 0) throw new ApiError(409, L["cn_requests.error.settled_not_paid"]);
      if (!data.followUpDate) throw new ApiError(422, L["cn_requests.validation.follow_up_date_required"]);
      if (isCnSundayDateKey(data.followUpDate)) throw new ApiError(422, L["cn_requests.validation.task_date_sunday"]);
      if (!request.acceptedAt || request.cnExpiryDays == null || !isOpenCnTaskDate(data.followUpDate, request.acceptedAt, request.cnExpiryDays)) {
        throw new ApiError(422, L["cn_requests.validation.task_date_outside_expiry"]);
      }
      taskAmount = before;
      taskDate = new Date(`${data.followUpDate}T00:00:00.000Z`);
      taskStatus = "SCHEDULED";
    } else if (data.status === "PARTIAL_PAID") {
      if (!data.paymentDate) throw new ApiError(422, L["cn_requests.validation.payment_date_required"]);
      if (!isCnBusinessDateKey(data.paymentDate)) throw new ApiError(422, L["cn_requests.validation.payment_date_invalid"]);
      if (before <= 0 || data.amountPaid == null) throw new ApiError(422, L["cn_requests.validation.payment_amount_required"]);
      if (data.amountPaid <= 0 || data.amountPaid >= before) throw new ApiError(422, L["cn_requests.validation.payment_amount_invalid"]);
      if (!data.followUpDate) throw new ApiError(422, L["cn_requests.validation.follow_up_date_required"]);
      if (isCnSundayDateKey(data.followUpDate)) throw new ApiError(422, L["cn_requests.validation.task_date_sunday"]);
      if (!request.acceptedAt || request.cnExpiryDays == null || !isOpenCnTaskDate(data.followUpDate, request.acceptedAt, request.cnExpiryDays)) {
        throw new ApiError(422, L["cn_requests.validation.task_date_outside_expiry"]);
      }
      amountPaid = data.amountPaid;
      after = before - data.amountPaid;
      taskAmount = after;
      taskDate = new Date(`${data.followUpDate}T00:00:00.000Z`);
      taskStatus = "SCHEDULED";
    } else {
      throw new ApiError(422, L["cn_requests.error.pending_update"]);
    }

    const updated = await tx.cnRequest.updateMany({
      where: { id, paymentStatus: currentStatus, paymentOutstandingAmount: request.paymentOutstandingAmount },
      data: { paymentStatus: paymentStatusLabel(data.status), paymentOutstandingAmount: after },
    });
    if (updated.count === 0) throw new ApiError(409, L["cn_requests.error.payment_changed"]);
    // An SO report is provisional: the status returns to UNVERIFIED (gray) until an Admin verifies it.
    await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest" SET "paymentVerified" = false WHERE "id" = ${id}`);
    if (activeTask) {
      await tx.cnPaymentEvent.updateMany({
        where: { id: activeTask.id, taskStatus: activeTask.taskStatus },
        data: { taskStatus: "COMPLETED", taskCompletedAt: new Date() },
      });
    }
    await tx.cnPaymentEvent.create({
      data: {
        cnRequestId: id,
        status: data.status,
        amountPaid,
        eventDate: data.paymentDate ? new Date(`${data.paymentDate}T00:00:00.000Z`) : businessDateValue(new Date(), L["cn_requests.error.business_date"]),
        outstandingBefore: before,
        outstandingAfter: after,
        taskAmount,
        taskDate,
        taskStatus,
        taskRescheduled: taskStatus === "SCHEDULED",
        source: "SO_UPDATE",
        requestKey: data.requestKey,
        recordedById: ctx.userId,
      },
    });
  });
  await writeAudit({
    userId: ctx.userId, action: "UPDATE", entity: "cnRequestPayment", entityId: id,
    summary: `CN payment reported as ${data.status} (awaiting Admin verification)`,
  });
  return getCnPaymentDetail(ctx, id);
}

/**
 * ADMIN PAYMENT VERIFICATION (authoritative). The Admin verifies — and may override — the SO's reported
 * payment status. Admin picks only the status (+ Amount Paid for Partial); Admin NEVER selects dates. The
 * outcome is recomputed from the outstanding that existed BEFORE the current status (the latest event's
 * `outstandingBefore`), so an override like "SO said Paid → Admin says Partial ₹5,000" yields the correct
 * remaining. On override the previous active task is closed and a new task is scheduled for the next working
 * day within the CN expiry window. Verifying marks the status
 * GREEN. Admin-verified Paid settles the balance, creates no further task, and posts the accepted CN to the
 * ledger through the same transition used by manual posting. The SO's original report stays immutable in
 * history; a separate ADMIN_VERIFY event records the Admin decision.
 */
export async function verifyCnPayment(ctx: AuthContext, id: string, raw: unknown): Promise<CnPaymentDetailDto> {
  const L = await getResolvedLabels();
  if (ctx.role !== Role.SUPER_ADMIN) throw new ApiError(403, L["cn_requests.error.admin_verify_only"]);
  const parsed = paymentSchemas(L).verify.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.validation.invalid_payment_verification"]);
  const data = parsed.data;
  const existingKey = await prisma.cnPaymentEvent.findUnique({ where: { requestKey: data.requestKey }, select: { cnRequestId: true } });
  if (existingKey) {
    if (existingKey.cnRequestId !== id) throw new ApiError(409, L["cn_requests.error.verification_key_used"]);
    return getCnPaymentDetail(ctx, id);
  }

  let postingResult: { idempotent: boolean; posted: boolean; postedAmount: number | null; documentName: string | null };
  try {
    postingResult = await prisma.$transaction(async (tx) => {
      // Serialize verification for one CN. This also lets a concurrent duplicate recheck its request key only
      // after the first transaction commits, without retrying or applying the business operation twice.
      const [request] = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        paymentTrackingMode: string | null;
        paymentStatus: string | null;
        paymentOriginalAmount: Prisma.Decimal | null;
        paymentOutstandingAmount: Prisma.Decimal | null;
        paymentVerified: boolean;
        acceptedAt: Date | null;
        cnExpiryDays: number | null;
        cnWorkingDocument: string | null;
        cnWorkingFileName: string | null;
        cnWorkingMimeType: string | null;
      }>>(Prisma.sql`
        SELECT c."id", c."status", c."paymentTrackingMode", c."paymentStatus",
          c."paymentOriginalAmount", c."paymentOutstandingAmount", c."paymentVerified", c."acceptedAt",
          c."cnExpiryDays", c."cnWorkingDocument",
          c."cnWorkingFileName", c."cnWorkingMimeType"
        FROM "CnRequest" c
        WHERE c."id" = ${id}
        FOR UPDATE OF c
      `);
      if (!request) throw new ApiError(404, L["cn_requests.error.not_found"]);
      const [eventState] = await tx.$queryRaw<Array<{
        requestKeyCnRequestId: string | null;
        latestOutstandingBefore: Prisma.Decimal | null;
      }>>(Prisma.sql`
        SELECT
          (SELECT e."cnRequestId" FROM "CnPaymentEvent" e WHERE e."requestKey" = ${data.requestKey}) AS "requestKeyCnRequestId",
          (SELECT e."outstandingBefore" FROM "CnPaymentEvent" e WHERE e."cnRequestId" = ${id} ORDER BY e."createdAt" DESC LIMIT 1) AS "latestOutstandingBefore"
      `);
      if (eventState?.requestKeyCnRequestId) {
        if (eventState.requestKeyCnRequestId !== id) throw new ApiError(409, L["cn_requests.error.verification_key_used"]);
        return { idempotent: true, posted: false, postedAmount: null, documentName: null };
      }
      if (request.paymentTrackingMode !== "PAYMENT_V1" || request.paymentOutstandingAmount == null) {
        throw new ApiError(409, L["cn_requests.error.payment_tracking_inactive"]);
      }
      if (request.paymentStatus == null || request.paymentStatus === "Pending") {
        throw new ApiError(409, L["cn_requests.error.no_report_to_verify"]);
      }
      // Authoritative base = the outstanding BEFORE the current status was applied.
      const base = eventState?.latestOutstandingBefore != null
        ? Number(eventState.latestOutstandingBefore)
        : Number(request.paymentOutstandingAmount);
      const currentStatus = request.paymentStatus;
      const currentOutstanding = Number(request.paymentOutstandingAmount);

      let amountPaid: number | null = null;
      let after = base;
      if (data.status === "PAID") {
        after = 0;
      } else if (data.status === "NOT_PAID") {
        after = base;
      } else if (data.status === "PARTIAL_PAID") {
        if (data.amountPaid == null) throw new ApiError(422, L["cn_requests.validation.payment_amount_required"]);
        if (data.amountPaid <= 0 || data.amountPaid >= base) throw new ApiError(422, L["cn_requests.validation.payment_amount_invalid"]);
        amountPaid = data.amountPaid;
        after = base - data.amountPaid;
      } else {
        throw new ApiError(422, L["cn_requests.error.pending_verify"]);
      }

      const verifiedLabel = paymentStatusLabel(data.status);
      // AGREE: Admin confirms the current SO state unchanged → just mark verified, keep the SO's active task.
      const agree = verifiedLabel === currentStatus && after === currentOutstanding;
      // A second request may carry a different key (another tab/client). Once the same authoritative decision
      // has committed, treat it as the same operation rather than creating duplicate history or posting work.
      if (request.paymentVerified && agree) {
        return { idempotent: true, posted: false, postedAmount: null, documentName: null };
      }

      const transitionAt = new Date();
      const nextTaskDate = !agree && after > 0 ? nextCnWorkingDateKey(transitionAt) : null;
      if (nextTaskDate && (!request.acceptedAt || request.cnExpiryDays == null
        || !isCnTaskDateWithinExpiry(nextTaskDate, request.acceptedAt, request.cnExpiryDays))) {
        throw new ApiError(422, L["cn_requests.validation.default_task_date_unavailable"]);
      }
      if (!agree) {
        await tx.cnPaymentEvent.updateMany({
          where: { cnRequestId: id, taskStatus: { in: ["UNSCHEDULED", "SCHEDULED"] } },
          data: { taskStatus: "COMPLETED", taskCompletedAt: transitionAt },
        });
      }
      const updated = await tx.cnRequest.updateMany({
        where: { id, paymentStatus: currentStatus, paymentOutstandingAmount: request.paymentOutstandingAmount },
        data: agree
          ? { paymentVerified: true }
          : { paymentStatus: verifiedLabel, paymentOutstandingAmount: after, paymentVerified: true },
      });
      if (updated.count === 0) throw new ApiError(409, L["cn_requests.error.payment_verify_changed"]);

      await tx.cnPaymentEvent.create({
        data: {
          cnRequestId: id,
          status: data.status,
          amountPaid,
          eventDate: businessDateValue(transitionAt, L["cn_requests.error.business_date"]),
          outstandingBefore: base,
          outstandingAfter: after,
          // An override with a remaining balance opens a new task on the next non-Sunday working date.
          taskAmount: !agree && after > 0 ? after : null,
          taskDate: nextTaskDate ? businessDateValue(new Date(`${nextTaskDate}T00:00:00.000Z`), L["cn_requests.error.business_date"]) : null,
          taskStatus: nextTaskDate ? "SCHEDULED" : null,
          taskRescheduled: false,
          source: "ADMIN_VERIFY",
          requestKey: data.requestKey,
          recordedById: ctx.userId,
        },
      });
      if (data.status !== "PAID") return { idempotent: false, posted: false, postedAmount: null, documentName: null };

      const postedAmount = Number(request.paymentOriginalAmount);
      const posting = await postAcceptedCnRequestInTransaction(
        tx,
        request,
        postedAmount,
        transitionAt,
        ctx.userId,
        L,
      );
      return { idempotent: false, ...posting, postedAmount };
    }, { timeout: 15_000 });
  } catch (error) {
    // A request key is globally unique. If two different CNs race with the same key, or the database detects
    // the unique conflict before the row-lock recheck sees it, resolve only the already-committed identical
    // operation. This is state-aware idempotency, not a retry of the transaction.
    if ((error as { code?: string } | null)?.code === "P2002") {
      const committed = await prisma.cnPaymentEvent.findUnique({
        where: { requestKey: data.requestKey },
        select: { cnRequestId: true },
      });
      if (committed?.cnRequestId === id) return getCnPaymentDetail(ctx, id);
      if (committed) throw new ApiError(409, L["cn_requests.error.verification_key_used"]);
    }
    throw error;
  }
  if (postingResult.idempotent) return getCnPaymentDetail(ctx, id);
  await writeAudit({
    userId: ctx.userId, action: "UPDATE", entity: "cnRequestPayment", entityId: id,
    summary: `CN payment verified as ${data.status}`,
  });
  if (postingResult.posted) {
    await writeAudit({
      userId: ctx.userId,
      action: "UPDATE",
      entity: "cnRequest",
      entityId: id,
      summary: `CN Request accepted, posted in ledger; Posted Amount: ${postingResult.postedAmount}; CN working: ${postingResult.documentName}`,
    });
  }
  return getCnPaymentDetail(ctx, id);
}

type LegacyCnTaskRawRow = {
  id: string; dealerId: string; amount: string | null; acceptanceReason: string | null; acceptedAt: Date | null;
  cnExpiryDays: number | null; taskDate: string | null; partyName: string; cnType: string;
  details: string | null; paymentStatus: string | null; legacyDailyWorkConfirmed: boolean | null;
};
function toLegacyTaskDto(r: LegacyCnTaskRawRow): CnTaskDto {
  const reason = (r.acceptanceReason as CnAcceptanceReason | null) ?? null;
  const amount = r.amount == null ? null : Number(r.amount);
  return {
    taskId: null, cnRequestId: r.id, dealerId: r.dealerId, taskType: "CN_REQUEST", planType: "RECOVERY",
    partyName: r.partyName, cnType: canonicalCnType(r.cnType), details: r.details,
    amount, reason, kind: cnTaskKindForReason(reason), recoveryAmount: cnTaskAmount(reason, amount), taskDate: r.taskDate,
    taskRescheduled: true,
    confirmed: r.legacyDailyWorkConfirmed === true,
    acceptanceDate: r.acceptedAt ? cnRequestBusinessDateKey(r.acceptedAt) : null,
    expiryDate: r.acceptedAt ? cnRequestExpiryDateKey(r.acceptedAt, r.cnExpiryDays) : null,
    paymentStatus: r.paymentStatus,
  };
}
const LEGACY_TASK_SELECT = Prisma.sql`
  SELECT c."id", c."dealerId", c."amount"::text AS "amount", c."acceptanceReason", c."acceptedAt", c."cnExpiryDays",
    c."taskDate"::text AS "taskDate", c."cnType", c."details", c."paymentStatus", c."legacyDailyWorkConfirmed",
    d."name" AS "partyName"
  FROM "CnRequest" c JOIN "Dealer" d ON d."id" = c."dealerId"`;

type NewTaskRow = Prisma.CnPaymentEventGetPayload<{ include: { cnRequest: { include: { dealer: true } } } }>;
// `confirmed` is sourced separately (raw SQL) because the new column is not part of the generated client type.
function toNewTaskDto(event: NewTaskRow, confirmed = false): CnTaskDto {
  const request = event.cnRequest;
  const amount = Number(event.taskAmount);
  return {
    taskId: event.id, cnRequestId: request.id, dealerId: request.dealerId, taskType: "CN_REQUEST", planType: "RECOVERY",
    partyName: request.dealer.name,
    cnType: canonicalCnType(request.cnType), details: request.details, amount, reason: "PAYMENT_PENDING",
    kind: "CN_RECOVERY", recoveryAmount: amount, taskDate: event.taskDate?.toISOString().slice(0, 10) ?? null,
    taskRescheduled: event.taskRescheduled,
    confirmed,
    acceptanceDate: request.acceptedAt ? cnRequestBusinessDateKey(request.acceptedAt) : null,
    expiryDate: request.acceptedAt ? cnRequestExpiryDateKey(request.acceptedAt, request.cnExpiryDays) : null,
    paymentStatus: request.paymentStatus,
  };
}

export async function listPendingCnTasks(ctx: AuthContext): Promise<CnTaskDto[]> {
  const scope = await getOfficerScope(ctx);
  const officerWhere = scope.all ? {} : { officerId: { in: scope.ids } };
  const events = await prisma.cnPaymentEvent.findMany({
    where: { taskStatus: "UNSCHEDULED", dailyWorkEntryId: null, cnRequest: { paymentTrackingMode: "PAYMENT_V1", ...officerWhere } },
    include: { cnRequest: { include: { dealer: true } } }, orderBy: { createdAt: "desc" },
  });
  const scopeClause = scope.all ? Prisma.empty : scope.ids.length ? Prisma.sql`AND c."officerId" IN (${Prisma.join(scope.ids)})` : Prisma.sql`AND FALSE`;
  const legacy = await prisma.$queryRaw<LegacyCnTaskRawRow[]>(Prisma.sql`
    ${LEGACY_TASK_SELECT} WHERE c."paymentTrackingMode" IS NULL
    AND c."status" = ${CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED} AND c."taskDate" IS NULL
    AND c."legacyDailyWorkEntryId" IS NULL ${scopeClause}
    ORDER BY c."acceptedAt" DESC NULLS LAST`);
  return withDealerDisplayNames([...events.map((event) => toNewTaskDto(event)), ...legacy.map(toLegacyTaskDto)]);
}

/** All active CN Working tasks, irrespective of their actual scheduled date, for the compact Daily Work table. */
export async function listActiveCnTasks(ctx: AuthContext): Promise<CnTaskDto[]> {
  const scope = await getOfficerScope(ctx);
  const officerWhere = scope.all ? {} : { officerId: { in: scope.ids } };
  const events = await prisma.cnPaymentEvent.findMany({
    where: { taskStatus: { in: ["UNSCHEDULED", "SCHEDULED"] }, dailyWorkEntryId: null, cnRequest: { paymentTrackingMode: "PAYMENT_V1", ...officerWhere } },
    include: { cnRequest: { include: { dealer: true } } },
    orderBy: [{ taskDate: "asc" }, { createdAt: "desc" }],
  });
  const scopeClause = scope.all ? Prisma.empty : scope.ids.length ? Prisma.sql`AND c."officerId" IN (${Prisma.join(scope.ids)})` : Prisma.sql`AND FALSE`;
  const legacy = await prisma.$queryRaw<LegacyCnTaskRawRow[]>(Prisma.sql`
    ${LEGACY_TASK_SELECT} WHERE c."paymentTrackingMode" IS NULL
    AND c."status" = ${CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED}
    AND c."legacyDailyWorkEntryId" IS NULL ${scopeClause}
    ORDER BY c."taskDate" ASC NULLS LAST, c."acceptedAt" DESC NULLS LAST`);
  return withDealerDisplayNames([...events.map((event) => toNewTaskDto(event)), ...legacy.map(toLegacyTaskDto)]);
}

/** Active tasks already consumed by the current editable Recovery rows, used only by their reschedule action. */
export async function materializedCnTasksForEntries(officerId: string, entryIds: string[]): Promise<CnTaskDto[]> {
  if (entryIds.length === 0) return [];
  const events = await prisma.cnPaymentEvent.findMany({
    where: {
      dailyWorkEntryId: { in: entryIds },
      taskStatus: { in: ["UNSCHEDULED", "SCHEDULED"] },
      cnRequest: { officerId, paymentTrackingMode: "PAYMENT_V1" },
    },
    include: { cnRequest: { include: { dealer: true } } },
    orderBy: [{ taskDate: "asc" }, { createdAt: "asc" }],
  });
  // The confirmation flag is a new column not present in the generated client type; read it via raw SQL and map
  // it onto each event DTO by id (default false when a row somehow has no flag row).
  const confirmedByEventId = new Map<string, boolean>();
  if (events.length > 0) {
    const flags = await prisma.$queryRaw<Array<{ id: string; confirmed: boolean }>>(Prisma.sql`
      SELECT "id", "dailyWorkConfirmed" AS "confirmed" FROM "CnPaymentEvent"
      WHERE "id" IN (${Prisma.join(events.map((event) => event.id))})`);
    for (const flag of flags) confirmedByEventId.set(flag.id, flag.confirmed === true);
  }
  const legacy = await prisma.$queryRaw<LegacyCnTaskRawRow[]>(Prisma.sql`
    ${LEGACY_TASK_SELECT}
    WHERE c."officerId" = ${officerId} AND c."paymentTrackingMode" IS NULL
      AND c."status" = ${CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED}
      AND c."legacyDailyWorkEntryId" IN (${Prisma.join(entryIds)})
    ORDER BY c."taskDate", c."acceptedAt" NULLS LAST`);
  return withDealerDisplayNames([...events.map((event) => toNewTaskDto(event, confirmedByEventId.get(event.id) ?? false)), ...legacy.map(toLegacyTaskDto)]);
}

export async function scheduleCnTask(ctx: AuthContext, id: string, raw: unknown): Promise<CnTaskDto> {
  const L = await getResolvedLabels();
  const parsed = paymentSchemas(L).schedule.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.validation.valid_task_date"]);
  const { taskDate, taskId } = parsed.data;
  if (isCnSundayDateKey(taskDate)) throw new ApiError(422, L["cn_requests.validation.task_date_sunday"]);
  const workDate = currentBusinessDate();
  return prisma.$transaction(async (tx) => {
    // Daily Work day is always locked before the task row. Materialization uses the same order.
    const day = await lockDailyWorkDay(tx, ctx.userId, workDate);
    if (taskId) {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT e."id" FROM "CnPaymentEvent" e WHERE e."id" = ${taskId} FOR UPDATE`);
      if (locked.length === 0) throw new ApiError(404, L["cn_requests.error.task_not_found"]);
      const event = await tx.cnPaymentEvent.findUnique({ where: { id: taskId }, include: { cnRequest: { include: { dealer: true } } } });
      if (!event || event.cnRequestId !== id) throw new ApiError(404, L["cn_requests.error.task_not_found"]);
      if (ctx.role !== Role.SALES_OFFICER || event.cnRequest.officerId !== ctx.userId) throw new ApiError(403, L["cn_requests.error.cannot_schedule_task"]);
      if (event.taskStatus !== "UNSCHEDULED" && event.taskStatus !== "SCHEDULED") throw new ApiError(409, L["cn_requests.error.cn_task_inactive"]);
      if (!event.cnRequest.acceptedAt || event.cnRequest.cnExpiryDays == null || !isOpenCnTaskDate(taskDate, event.cnRequest.acceptedAt, event.cnRequest.cnExpiryDays)) {
        throw new ApiError(422, L["cn_requests.validation.task_date_outside_expiry"]);
      }
      if (event.dailyWorkEntryId) {
        await reverseMaterializedDailyWorkContribution(tx, {
          entryId: event.dailyWorkEntryId,
          contribution: Number(event.dailyWorkContribution),
          officerId: ctx.userId,
          workDate,
          day,
        });
      }
      const updated = await tx.cnPaymentEvent.updateMany({
        where: { id: taskId, taskStatus: event.taskStatus, dailyWorkEntryId: event.dailyWorkEntryId },
        data: {
          taskDate: businessDateValue(new Date(`${taskDate}T00:00:00.000Z`), L["cn_requests.error.business_date"]),
          taskStatus: "SCHEDULED",
          dailyWorkEntryId: null,
          dailyWorkContribution: null,
          ...(event.taskDate?.toISOString().slice(0, 10) !== taskDate ? { taskRescheduled: true } : {}),
        },
      });
      if (updated.count === 0) throw new ApiError(409, L["cn_requests.error.task_changed"]);
      // Rescheduling returns the task to a future date, so its "confirmed for today" acknowledgement is cleared.
      // (Raw SQL — the column is not part of the generated client type.)
      await tx.$executeRaw(Prisma.sql`UPDATE "CnPaymentEvent" SET "dailyWorkConfirmed" = false WHERE "id" = ${taskId}`);
      const refreshed = await tx.cnPaymentEvent.findUniqueOrThrow({ where: { id: taskId }, include: { cnRequest: { include: { dealer: true } } } });
      await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnPaymentTask", entityId: taskId, summary: `CN Recovery task scheduled for ${taskDate}` }, tx);
      return toNewTaskDto(refreshed);
    }

    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c."id" FROM "CnRequest" c WHERE c."id" = ${id} FOR UPDATE`);
    if (locked.length === 0) throw new ApiError(404, L["cn_requests.error.not_found"]);
    const existing = await tx.cnRequest.findUnique({
      where: { id },
      select: { id: true, officerId: true, status: true, paymentTrackingMode: true, acceptedAt: true, cnExpiryDays: true,
        legacyDailyWorkEntryId: true, legacyDailyWorkContribution: true },
    });
    if (!existing) throw new ApiError(404, L["cn_requests.error.not_found"]);
    if (ctx.role !== Role.SALES_OFFICER || existing.officerId !== ctx.userId) throw new ApiError(403, L["cn_requests.error.cannot_schedule_task"]);
    if (existing.paymentTrackingMode !== null || existing.status !== CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED) throw new ApiError(409, L["cn_requests.error.not_legacy_task"]);
    if (existing.acceptedAt && existing.cnExpiryDays != null && !isOpenCnTaskDate(taskDate, existing.acceptedAt, existing.cnExpiryDays)) throw new ApiError(422, L["cn_requests.validation.task_date_outside_expiry"]);
    if (existing.legacyDailyWorkEntryId) {
      await reverseMaterializedDailyWorkContribution(tx, {
        entryId: existing.legacyDailyWorkEntryId,
        contribution: Number(existing.legacyDailyWorkContribution),
        officerId: ctx.userId,
        workDate,
        day,
      });
    }
    const updated = await tx.$executeRaw(Prisma.sql`UPDATE "CnRequest"
      SET "taskDate" = ${taskDate}::date, "legacyDailyWorkEntryId" = NULL,
          "legacyDailyWorkContribution" = NULL, "legacyDailyWorkConfirmed" = false, "updatedAt" = NOW()
      WHERE "id" = ${id} AND "officerId" = ${ctx.userId} AND "paymentTrackingMode" IS NULL
        AND "status" = ${CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED}
        AND "legacyDailyWorkEntryId" IS NOT DISTINCT FROM ${existing.legacyDailyWorkEntryId}`);
    if (updated === 0) throw new ApiError(409, L["cn_requests.error.legacy_task_inactive"]);
    const rows = await tx.$queryRaw<LegacyCnTaskRawRow[]>(Prisma.sql`${LEGACY_TASK_SELECT} WHERE c."id" = ${id}`);
    if (!rows[0]) throw new ApiError(409, L["cn_requests.error.legacy_task_inactive"]);
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnRequest", entityId: id, summary: `Legacy CN follow-up task scheduled for ${taskDate}` }, tx);
    return toLegacyTaskDto(rows[0]);
  }, { timeout: 15_000 });
}

/**
 * Explicitly confirm a MATERIALIZED CN Auto Task for today's Daily Work. This is a state distinct from
 * materialization, payment and taskStatus: it only records that the SO acknowledged the task for today's Daily
 * Plan. It NEVER completes the payment task, never changes taskStatus/amount, and never moves the contribution.
 * The task must currently be materialized into the officer's current editable (DRAFT) Recovery row. Idempotent:
 * confirming an already-confirmed task is a no-op that returns the same confirmed state.
 */
export async function confirmMaterializedAutoTask(ctx: AuthContext, id: string, raw: unknown): Promise<CnTaskDto> {
  const L = await getResolvedLabels();
  if (ctx.role !== Role.SALES_OFFICER) throw new ApiError(403, L["cn_requests.error.cannot_schedule_task"]);
  const parsed = paymentSchemas(L).confirmTask.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? L["cn_requests.error.task_not_found"]);
  const { taskId } = parsed.data;
  const workDate = currentBusinessDate();
  // Verify the given entry id is one of THIS officer's current-batch DRAFT Recovery rows on today's date.
  const entryInEditableRecovery = async (tx: Prisma.TransactionClient, entryId: string | null, batchId: string): Promise<boolean> => {
    if (!entryId) return false;
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "DailyWorkEntry"
      WHERE "id" = ${entryId} AND "officerId" = ${ctx.userId} AND "workDate" = ${workDate}::date
        AND "batchId" = ${batchId} AND "section" = 'RECOVERY' AND "status" = 'DRAFT'
      LIMIT 1`);
    return rows.length > 0;
  };

  return prisma.$transaction(async (tx) => {
    // Same lock order as materialization/reschedule: Daily Work day first, then the task row.
    const day = await lockDailyWorkDay(tx, ctx.userId, workDate);
    if (day.status === "FINALIZED") throw new ApiError(409, L["cn_requests.error.task_confirm_finalized"]);

    if (taskId) {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT e."id" FROM "CnPaymentEvent" e WHERE e."id" = ${taskId} FOR UPDATE`);
      if (locked.length === 0) throw new ApiError(404, L["cn_requests.error.task_not_found"]);
      const event = await tx.cnPaymentEvent.findUnique({ where: { id: taskId }, include: { cnRequest: { include: { dealer: true } } } });
      if (!event || event.cnRequestId !== id) throw new ApiError(404, L["cn_requests.error.task_not_found"]);
      if (event.cnRequest.officerId !== ctx.userId) throw new ApiError(403, L["cn_requests.error.cannot_schedule_task"]);
      if (event.taskStatus !== "SCHEDULED") throw new ApiError(409, L["cn_requests.error.cn_task_inactive"]);
      if (!(await entryInEditableRecovery(tx, event.dailyWorkEntryId, day.currentBatchId))) {
        throw new ApiError(409, L["cn_requests.error.task_not_materialized"]);
      }
      // Idempotent: set the flag only while the task is still SCHEDULED and materialized; re-running is harmless.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "CnPaymentEvent" SET "dailyWorkConfirmed" = true
        WHERE "id" = ${taskId} AND "taskStatus" = 'SCHEDULED' AND "dailyWorkEntryId" IS NOT NULL`);
      const refreshed = await tx.cnPaymentEvent.findUniqueOrThrow({ where: { id: taskId }, include: { cnRequest: { include: { dealer: true } } } });
      await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnPaymentTask", entityId: taskId, summary: "CN Auto Task confirmed for today's Daily Work" }, tx);
      return toNewTaskDto(refreshed, true);
    }

    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT c."id" FROM "CnRequest" c WHERE c."id" = ${id} FOR UPDATE`);
    if (locked.length === 0) throw new ApiError(404, L["cn_requests.error.not_found"]);
    const existing = await tx.cnRequest.findUnique({
      where: { id },
      select: { id: true, officerId: true, status: true, paymentTrackingMode: true, legacyDailyWorkEntryId: true },
    });
    if (!existing) throw new ApiError(404, L["cn_requests.error.not_found"]);
    if (existing.officerId !== ctx.userId) throw new ApiError(403, L["cn_requests.error.cannot_schedule_task"]);
    if (existing.paymentTrackingMode !== null || existing.status !== CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED) throw new ApiError(409, L["cn_requests.error.not_legacy_task"]);
    if (!(await entryInEditableRecovery(tx, existing.legacyDailyWorkEntryId, day.currentBatchId))) {
      throw new ApiError(409, L["cn_requests.error.task_not_materialized"]);
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "CnRequest" SET "legacyDailyWorkConfirmed" = true, "updatedAt" = NOW()
      WHERE "id" = ${id} AND "paymentTrackingMode" IS NULL AND "status" = ${CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED}
        AND "legacyDailyWorkEntryId" IS NOT NULL`);
    const rows = await tx.$queryRaw<LegacyCnTaskRawRow[]>(Prisma.sql`${LEGACY_TASK_SELECT} WHERE c."id" = ${id}`);
    if (!rows[0]) throw new ApiError(409, L["cn_requests.error.legacy_task_inactive"]);
    await writeAudit({ userId: ctx.userId, action: "UPDATE", entity: "cnRequest", entityId: id, summary: "Legacy CN Auto Task confirmed for today's Daily Work" }, tx);
    return toLegacyTaskDto(rows[0]);
  }, { timeout: 15_000 });
}

/**
 * Count materialized CN Auto Tasks in the officer's given editable batch that have NOT been explicitly confirmed
 * for today's Daily Work. Used by the day-submit gate so submission never implicitly confirms an Auto Task.
 */
export async function countUnconfirmedMaterializedTasks(
  tx: Prisma.TransactionClient,
  officerId: string,
  workDate: string,
  batchId: string,
): Promise<number> {
  const events = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM "CnPaymentEvent" e
    JOIN "DailyWorkEntry" d ON d."id" = e."dailyWorkEntryId"
    WHERE d."officerId" = ${officerId} AND d."workDate" = ${workDate}::date AND d."batchId" = ${batchId}
      AND d."section" = 'RECOVERY' AND d."status" = 'DRAFT'
      AND e."taskStatus" = 'SCHEDULED' AND e."dailyWorkConfirmed" = false`);
  const legacy = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM "CnRequest" c
    JOIN "DailyWorkEntry" d ON d."id" = c."legacyDailyWorkEntryId"
    WHERE d."officerId" = ${officerId} AND d."workDate" = ${workDate}::date AND d."batchId" = ${batchId}
      AND d."section" = 'RECOVERY' AND d."status" = 'DRAFT'
      AND c."paymentTrackingMode" IS NULL AND c."status" = ${CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED}
      AND c."legacyDailyWorkConfirmed" = false`);
  return (events[0]?.n ?? 0) + (legacy[0]?.n ?? 0);
}

export async function cnTasksForOfficerDate(officerId: string, workDate: string): Promise<CnTaskDto[]> {
  if (!isCnBusinessDateKey(workDate)) return [];
  const L = await getResolvedLabels();
  const events = await prisma.cnPaymentEvent.findMany({
    where: { taskStatus: "SCHEDULED", dailyWorkEntryId: null, taskDate: businessDateValue(new Date(`${workDate}T00:00:00.000Z`), L["cn_requests.error.business_date"]), cnRequest: { officerId, paymentTrackingMode: "PAYMENT_V1" } },
    include: { cnRequest: { include: { dealer: true } } }, orderBy: { createdAt: "desc" },
  });
  const legacy = await prisma.$queryRaw<LegacyCnTaskRawRow[]>(Prisma.sql`
    ${LEGACY_TASK_SELECT} WHERE c."paymentTrackingMode" IS NULL AND c."officerId" = ${officerId}
    AND c."status" = ${CN_REQUEST_STATUSES.ACCEPTED_NOT_POSTED} AND c."taskDate" = ${workDate}::date
    AND c."legacyDailyWorkEntryId" IS NULL
    ORDER BY c."acceptedAt" DESC NULLS LAST`);
  return withDealerDisplayNames([...events.map((event) => toNewTaskDto(event)), ...legacy.map(toLegacyTaskDto)]);
}
