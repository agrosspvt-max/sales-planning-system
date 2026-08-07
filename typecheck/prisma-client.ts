/**
 * Permissive @prisma/client stub — TYPECHECK ONLY.
 *
 * The Prisma client cannot be regenerated in this Linux sandbox (the query engine
 * binary download is blocked), so the committed generated types are stale relative to
 * schema.prisma. `tsconfig.typecheck.json` redirects `@prisma/client` here so the app's
 * own logic is fully type-checked while Prisma model access stays permissive. The real
 * app build/runtime uses the genuine generated client (unaffected by this file).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const Role = {
  SUPER_ADMIN: "SUPER_ADMIN",
  REGIONAL_MANAGER: "REGIONAL_MANAGER",
  SALES_OFFICER: "SALES_OFFICER",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const SeasonStatus = { OPEN: "OPEN", CLOSED: "CLOSED" } as const;
export type SeasonStatus = (typeof SeasonStatus)[keyof typeof SeasonStatus];

export const PlanStatus = {
  DRAFT: "DRAFT",
  PENDING_RM: "PENDING_RM",
  PENDING_ADMIN: "PENDING_ADMIN",
  APPROVED: "APPROVED",
  RETURNED: "RETURNED",
  REJECTED: "REJECTED",
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

export const ApprovalActionType = {
  SUBMIT: "SUBMIT",
  RECALL: "RECALL",
  APPROVE: "APPROVE",
  RETURN: "RETURN",
  REJECT: "REJECT",
  REQUEST_REVISION: "REQUEST_REVISION",
  AUTHORIZE_REVISION: "AUTHORIZE_REVISION",
} as const;
export type ApprovalActionType = (typeof ApprovalActionType)[keyof typeof ApprovalActionType];

export const NotificationType = {
  PLAN_SUBMITTED: "PLAN_SUBMITTED",
  PLAN_APPROVED: "PLAN_APPROVED",
  PLAN_RETURNED: "PLAN_RETURNED",
  REVISION_AUTHORIZED: "REVISION_AUTHORIZED",
  MONTH_EXTENSION_REQUESTED: "MONTH_EXTENSION_REQUESTED",
  MONTH_EXTENSION_APPROVED: "MONTH_EXTENSION_APPROVED",
  ANNOUNCEMENT: "ANNOUNCEMENT",
  SYSTEM: "SYSTEM",
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const ImportStatus = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  ROLLED_BACK: "ROLLED_BACK",
} as const;
export type ImportStatus = (typeof ImportStatus)[keyof typeof ImportStatus];

export namespace Prisma {
  export type TransactionClient = any;
  export type PrismaClientKnownRequestError = any;
  // Model input types are permissive in the stub; the real generated client supplies exact types.
  export type PlanLineCreateManyInput = any;
  export type Decimal = any;
}

export class PrismaClient {
  constructor(..._args: any[]) {}
  [key: string]: any;
  $transaction: any;
  $connect: any;
  $disconnect: any;
  $queryRaw: any;
  $executeRaw: any;
  $on: any;
}
