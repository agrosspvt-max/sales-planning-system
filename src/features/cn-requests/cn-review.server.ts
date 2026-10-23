import "server-only";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/http";
import { getOfficerScope } from "@/lib/scope";
import { hasAdminPermission } from "@/features/accounts/permissions";
import { labeledError } from "@/features/labels/labeled-error";
import { accountSnapshotName } from "@/features/accounts/identity";
import { CN_WORKING_MAX_BYTES, CN_WORKING_PDF_MIME, CN_WORKING_XLSX_MIME } from "@/lib/cn-request";
import {
  CN_REVIEW_TYPES,
  validCnReviewPrice,
  type CnReview,
  type CnReviewProduct,
  type CnReviewType,
} from "@/lib/cn-review";

const err = (
  status: number,
  key: "invalid" | "forbidden" | "changed" | "price" | "reason" | "bypass" | "schema",
) => labeledError(status, `cn_requests.processing.error.${key}`);
export function canHandleCnReview(ctx: AuthContext): boolean {
  return ["approve", "reject", "post"].some((action) =>
    hasAdminPermission(ctx, "cnRequests", action),
  );
}
function handler(ctx: AuthContext) {
  if (!canHandleCnReview(ctx)) throw err(403, "forbidden");
}
const accountName = (u: { name: string; username: string; designation?: string | null }) =>
  `${u.name} (@${u.username})${u.designation ? ` (${u.designation})` : ""}`;
async function actor(tx: Prisma.TransactionClient, ctx: AuthContext) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { name: true, username: true, designation: true },
  });
  return accountName(user);
}
const reviewSelect = {
  id: true,
  cnRequestId: true,
  kind: true,
  status: true,
  assignedToId: true,
  assignedToName: true,
  sentByName: true,
  createdAt: true,
  respondedAt: true,
  note: true,
  products: true,
  fileName: true,
  mimeType: true,
} as const;
type ReviewRow = Prisma.CnReviewAttemptGetPayload<{ select: typeof reviewSelect }>;
function dto(r: ReviewRow): CnReview {
  return {
    ...r,
    assignedToName: accountSnapshotName(r.assignedToName),
    sentByName: accountSnapshotName(r.sentByName),
    kind: r.kind as CnReviewType,
    status: r.status as CnReview["status"],
    products: r.products as unknown as CnReviewProduct[],
    createdAt: r.createdAt.toISOString(),
    respondedAt: r.respondedAt?.toISOString() ?? null,
  };
}
export async function cnReviewChoices(ctx: AuthContext) {
  handler(ctx);
  const [users, products] = await Promise.all([
    prisma.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        id: { not: ctx.userId },
        role: {
          in: [Role.SALES_OFFICER, Role.REGIONAL_MANAGER, Role.CUSTOM_ADMIN, Role.SUPER_ADMIN],
        },
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.product.findMany({
      where: { isActive: true, mergedIntoId: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return {
    people: users.map((u) => ({
      id: u.id,
      name: u.name,
      administrative: u.role === Role.SUPER_ADMIN || u.role === Role.CUSTOM_ADMIN,
    })),
    products,
  };
}
export async function lockCnReviewTx(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>(
    Prisma.sql`SELECT "id", "status" FROM "CnRequest" WHERE "id" = ${id} FOR UPDATE`,
  );
  if (!rows[0]) throw err(404, "changed");
  return rows[0];
}
async function event(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  cnRequestId: string,
  attemptId: string | null,
  kind: string,
  details: Prisma.InputJsonObject,
  at = new Date(),
) {
  await tx.cnProcessingEvent.create({
    data: {
      cnRequestId,
      attemptId,
      kind,
      actorId: ctx.userId,
      actorName: await actor(tx, ctx),
      createdAt: at,
      details,
    },
  });
}
function text(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
export interface ReviewUpload {
  name: string;
  type: string;
  buffer: Buffer;
}
function documentData(upload?: ReviewUpload | null) {
  if (
    !upload ||
    !upload.buffer.length ||
    upload.buffer.length > CN_WORKING_MAX_BYTES ||
    upload.name.length > 255
  )
    throw err(422, "invalid");
  const pdf =
    upload.type === CN_WORKING_PDF_MIME &&
    upload.name.toLowerCase().endsWith(".pdf") &&
    upload.buffer.subarray(0, 5).toString() === "%PDF-";
  const xlsx =
    upload.type === CN_WORKING_XLSX_MIME &&
    upload.name.toLowerCase().endsWith(".xlsx") &&
    upload.buffer.subarray(0, 2).toString() === "PK";
  if (!pdf && !xlsx) throw err(422, "invalid");
  return {
    document: `data:${upload.type};base64,${upload.buffer.toString("base64")}`,
    fileName: upload.name,
    mimeType: upload.type,
  };
}

/** CN row lock serializes replacement, response and final decision. The caller sends the attempt it saw. */
export async function sendCnReview(
  ctx: AuthContext,
  id: string,
  raw: unknown,
  upload?: ReviewUpload | null,
) {
  handler(ctx);
  const input = raw as Record<string, unknown>;
  if (
    !input ||
    !CN_REVIEW_TYPES.includes(input.kind as CnReviewType) ||
    typeof input.assignedToId !== "string" ||
    !text(input.requestKey, 120)
  )
    throw err(422, "invalid");
  const kind = input.kind as CnReviewType;
  const assignedToId = input.assignedToId as string;
  const key = text(input.requestKey, 120);
  const ids = Array.isArray(input.productIds)
    ? [...new Set(input.productIds.filter((p): p is string => typeof p === "string"))]
    : [];
  if (kind === "RATE_CONFIRMATION" && (!ids.length || ids.length > 500)) throw err(422, "invalid");
  const document = kind === "CN_APPROVAL" ? documentData(upload) : {};
  return prisma
    .$transaction(
      async (tx) => {
        const cn = await lockCnReviewTx(tx, id);
        const prior = await tx.cnReviewAttempt.findUnique({ where: { requestKey: key } });
        if (prior) {
          if (prior.cnRequestId !== id || prior.sentById !== ctx.userId) throw err(409, "changed");
          return { id: prior.id };
        }
        if (!["SUBMITTED", "UNDER_PROCESS"].includes(cn.status)) throw err(409, "changed");
        const last = await tx.cnReviewAttempt.findFirst({
          where: { cnRequestId: id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        if (cn.status === "UNDER_PROCESS" && (!last || input.expectedReviewId !== last.id))
          throw err(409, "changed");
        const recipient = await tx.user.findFirst({
          where: { id: assignedToId, isActive: true, deletedAt: null },
          select: { id: true, name: true, username: true, designation: true, role: true },
        });
        if (
          !recipient ||
          recipient.id === ctx.userId ||
          ![
            Role.SALES_OFFICER,
            Role.REGIONAL_MANAGER,
            Role.CUSTOM_ADMIN,
            Role.SUPER_ADMIN,
          ].includes(recipient.role) ||
          (kind === "CN_APPROVAL" &&
            recipient.role !== Role.CUSTOM_ADMIN &&
            recipient.role !== Role.SUPER_ADMIN)
        )
          throw err(422, "invalid");
        const products =
          kind === "RATE_CONFIRMATION"
            ? await tx.product.findMany({
                where: { id: { in: ids }, isActive: true, mergedIntoId: null },
                select: { id: true, name: true },
              })
            : [];
        if (kind === "RATE_CONFIRMATION" && products.length !== ids.length)
          throw err(422, "invalid");
        // Strictly increasing attempt creation times make the latest attempt deterministic even within one millisecond.
        const now = new Date(Math.max(Date.now(), last ? last.createdAt.getTime() + 1 : 0));
        if (last?.status === "PENDING") {
          await tx.cnReviewAttempt.update({ where: { id: last.id }, data: { status: "REPLACED" } });
          await event(
            tx,
            ctx,
            id,
            last.id,
            "REVIEW_CANCELLED",
            { assignedToName: last.assignedToName, replacement: true },
            now,
          );
        }
        const created = await tx.cnReviewAttempt.create({
          data: {
            cnRequestId: id,
            requestKey: key,
            kind,
            assignedToId: recipient.id,
            assignedToName: accountName(recipient),
            sentById: ctx.userId,
            sentByName: await actor(tx, ctx),
            createdAt: now,
            products: products.map((p) => ({ ...p, price: null })),
            ...document,
          },
        });
        await tx.cnRequest.update({ where: { id }, data: { status: "UNDER_PROCESS" } });
        await event(
          tx,
          ctx,
          id,
          created.id,
          "REVIEW_SENT",
          {
            kind,
            assignedToName: created.assignedToName,
            products: products.map((p) => ({ ...p, price: null })),
            fileName: created.fileName,
          },
          now,
        );
        return { id: created.id };
      },
      { timeout: 15000 },
    )
    .catch((error) => {
      if (error.code === "P2021") throw err(503, "schema");
      throw error;
    });
}

/** Assignment is a narrow capability: it never grants the assignee general CN or company-wide access. */
export async function cnReviewInbox(ctx: AuthContext): Promise<CnReview[]> {
  const rows = await prisma.cnReviewAttempt
    .findMany({
      where: {
        assignedToId: ctx.userId,
        status: "PENDING",
        cnRequest: { status: "UNDER_PROCESS" },
      },
      select: {
        ...reviewSelect,
        cnRequest: { select: { cnType: true, details: true, dealer: { select: { name: true } } } },
      },
      orderBy: { createdAt: "asc" },
    })
    .catch((error) => {
      if (error.code === "P2021") return [];
      throw error;
    });
  return rows.map((r) => ({
    ...dto(r),
    partyName: r.cnRequest.dealer.name,
    cnType: r.cnRequest.cnType,
    details: r.cnRequest.details,
  }));
}
async function assertHistoryAccess(ctx: AuthContext, cnRequestId: string) {
  const cn = await prisma.cnRequest.findUnique({
    where: { id: cnRequestId },
    select: { officerId: true },
  });
  if (!cn) throw err(404, "changed");
  if (ctx.role === Role.CUSTOM_ADMIN && !hasAdminPermission(ctx, "cnRequests", "read"))
    throw err(403, "forbidden");
  const scope = await getOfficerScope(ctx);
  if (!scope.all && !scope.ids.includes(cn.officerId)) throw err(403, "forbidden");
}
export async function cnReviewHistory(ctx: AuthContext, id: string): Promise<CnReview[]> {
  await assertHistoryAccess(ctx, id);
  return (
    await prisma.cnReviewAttempt
      .findMany({
        where: { cnRequestId: id },
        select: reviewSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
      .catch((error) => {
        if (error.code === "P2021") return [];
        throw error;
      })
  ).map(dto);
}
/** Existing CN details remain readable during a rolling deployment before the additive migration. */
export async function cnProcessingEvents(id: string) {
  try {
    return await prisma.cnProcessingEvent.findMany({
      where: { cnRequestId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2021") return [];
    throw error;
  }
}
export async function respondCnReview(ctx: AuthContext, attemptId: string, raw: unknown) {
  const input = raw as {
    action?: string;
    note?: unknown;
    prices?: Array<{ id: string; price: unknown }>;
  };
  if (!input || !["approve", "reject"].includes(input.action ?? "")) throw err(422, "invalid");
  const note = text(input.note);
  if (input.action === "reject" && !note) throw err(422, "reason");
  const target = await prisma.cnReviewAttempt.findUnique({
    where: { id: attemptId },
    select: { cnRequestId: true },
  });
  if (!target) throw err(404, "changed");
  return prisma.$transaction(
    async (tx) => {
      const cn = await lockCnReviewTx(tx, target.cnRequestId);
      const review = await tx.cnReviewAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (review.assignedToId !== ctx.userId) throw err(403, "forbidden");
      if (review.status !== "PENDING" || cn.status !== "UNDER_PROCESS") throw err(409, "changed");
      const last = await tx.cnReviewAttempt.findFirst({
        where: { cnRequestId: cn.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (last?.id !== review.id) throw err(409, "changed");
      const products = review.products as unknown as CnReviewProduct[];
      if (input.action === "approve" && review.kind === "RATE_CONFIRMATION") {
        const prices = input.prices;
        if (
          !Array.isArray(prices) ||
          prices.length !== products.length ||
          prices.some((p) => !p || typeof p !== "object" || typeof p.id !== "string") ||
          new Set(prices.map((p) => p.id)).size !== products.length
        )
          throw err(422, "price");
        for (const p of products) {
          const value = prices.find((v) => v.id === p.id)?.price;
          if (!validCnReviewPrice(value)) throw err(422, "price");
          p.price = value;
        }
      }
      const now = new Date();
      const status = input.action === "approve" ? "CONFIRMED" : "REJECTED";
      await tx.cnReviewAttempt.update({
        where: { id: attemptId },
        data: {
          status,
          note: note || null,
          products: products as unknown as Prisma.InputJsonValue,
          respondedAt: now,
        },
      });
      await event(
        tx,
        ctx,
        cn.id,
        attemptId,
        "REVIEW_RESPONDED",
        {
          kind: review.kind,
          status,
          note: note || null,
          products: products as unknown as Prisma.InputJsonValue,
          fileName: review.fileName,
        },
        now,
      );
      return { status };
    },
    { timeout: 15000 },
  );
}

/** Called inside the existing final-decision transaction, after a locked-state check and before commit. */
export async function finishCnReviewTx(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  id: string,
  expectedReviewId: unknown,
  bypassReason: unknown,
  destination: string,
) {
  await lockCnReviewTx(tx, id);
  const last = await tx.cnReviewAttempt.findFirst({
    where: { cnRequestId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!last || expectedReviewId !== last.id) throw err(409, "changed");
  const reason = text(bypassReason);
  if (last.status !== "CONFIRMED" && !reason) throw err(422, "bypass");
  if (last.status === "PENDING")
    await tx.cnReviewAttempt.update({ where: { id: last.id }, data: { status: "CLOSED" } });
  await event(tx, ctx, id, last.id, "REVIEW_FINALIZED", {
    destination,
    bypassReason: last.status === "CONFIRMED" ? null : reason,
    previousReviewStatus: last.status,
  });
}
export async function cnReviewDocument(ctx: AuthContext, attemptId: string) {
  const review = await prisma.cnReviewAttempt.findUnique({
    where: { id: attemptId },
    select: {
      cnRequestId: true,
      assignedToId: true,
      status: true,
      document: true,
      fileName: true,
      mimeType: true,
      cnRequest: { select: { status: true } },
    },
  });
  if (!review) throw err(404, "changed");
  if (
    !(
      review.assignedToId === ctx.userId &&
      review.status === "PENDING" &&
      review.cnRequest.status === "UNDER_PROCESS"
    )
  )
    await assertHistoryAccess(ctx, review.cnRequestId);
  // A replaced assignee cannot regain access through history unless independently authorized for that CN.
  if (!review.document || !review.fileName || !review.mimeType) throw err(404, "changed");
  return {
    buffer: Buffer.from(review.document.slice(review.document.indexOf(",") + 1), "base64"),
    fileName: review.fileName,
    mimeType: review.mimeType,
  };
}
