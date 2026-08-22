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

export const SchemeStatus = { OPEN: "OPEN", CLOSED: "CLOSED" } as const;
export type SchemeStatus = (typeof SchemeStatus)[keyof typeof SchemeStatus];

export const SchemeBenefit = {
  DOMESTIC_TOUR: "DOMESTIC_TOUR",
  DOMESTIC_COUPLE_TOUR: "DOMESTIC_COUPLE_TOUR",
  FOREIGN_TOUR: "FOREIGN_TOUR",
  CREDIT_NOTE: "CREDIT_NOTE",
  OTHER: "OTHER",
} as const;
export type SchemeBenefit = (typeof SchemeBenefit)[keyof typeof SchemeBenefit];

export const SchemeCalcType = { PERCENTAGE: "PERCENTAGE", FIXED_AMOUNT: "FIXED_AMOUNT" } as const;
export type SchemeCalcType = (typeof SchemeCalcType)[keyof typeof SchemeCalcType];

export const SchemePlanStatus = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  RM_APPROVED: "RM_APPROVED",
  RM_REJECTED: "RM_REJECTED",
  RETURNED: "RETURNED",
} as const;
export type SchemePlanStatus = (typeof SchemePlanStatus)[keyof typeof SchemePlanStatus];

export const SchemeEnrollmentStatus = { PENDING_DOCUMENT: "PENDING_DOCUMENT", ENROLLED: "ENROLLED" } as const;
export type SchemeEnrollmentStatus = (typeof SchemeEnrollmentStatus)[keyof typeof SchemeEnrollmentStatus];

export const SchemeDocType = { SOFT_COPY: "SOFT_COPY", HARD_COPY: "HARD_COPY" } as const;
export type SchemeDocType = (typeof SchemeDocType)[keyof typeof SchemeDocType];

export namespace Prisma {
  export type TransactionClient = any;
  export type PrismaClientKnownRequestError = any;
  // Model input types are permissive in the stub; the real generated client supplies exact types.
  export type PlanLineCreateManyInput = any;
  export type SeasonPlanWhereInput = any;
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
