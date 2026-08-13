import { Role } from "@prisma/client";

/**
 * Master data and administrative resources managed in Phase 1.
 * Planning resources (seasonal/monthly plans, actual sales) arrive in Phase 2.
 */
export type Resource =
  | "users"
  | "products"
  | "categories"
  | "brands"
  | "packSizes"
  | "dealers"
  | "seasons"
  | "announcements"
  | "settings"
  | "dealerAssignments"
  | "rmAssignments"
  | "audit"
  // Modular planning (Planning parent → sub-modules). Sales Planning is functional;
  // the others are navigation/permission placeholders for future phases.
  | "salesPlanning"
  | "recoveryPlanning"
  | "schemePlanning"
  | "partyPlanning"
  | "planImport"
  | "onboarding";

export type Action = "read" | "create" | "update" | "delete";

/**
 * Permission matrix (Phase 1). Per the specification, ALL master data is
 * managed exclusively by the Super Admin. Regional Managers and Sales Officers
 * are read-only consumers (their scoped read screens are enabled here so the
 * hierarchy is visible; write access is Super-Admin-only).
 */
const MATRIX: Record<Role, Partial<Record<Resource, Action[]>>> = {
  [Role.SUPER_ADMIN]: {
    users: ["read", "create", "update", "delete"],
    products: ["read", "create", "update", "delete"],
    categories: ["read", "create", "update", "delete"],
    brands: ["read", "create", "update", "delete"],
    packSizes: ["read", "create", "update", "delete"],
    dealers: ["read", "create", "update", "delete"],
    seasons: ["read", "create", "update", "delete"],
    announcements: ["read", "create", "update", "delete"],
    settings: ["read", "create", "update", "delete"],
    dealerAssignments: ["read", "create", "update", "delete"],
    rmAssignments: ["read", "create", "update", "delete"],
    audit: ["read"],
    salesPlanning: ["read", "create", "update"],
    recoveryPlanning: ["read"],
    schemePlanning: ["read"],
    partyPlanning: ["read"],
    planImport: ["read", "create"],
    onboarding: ["read", "create"],
  },
  // Regional Manager — planning/recovery WRITE within their own group (scope enforced separately in
  // getOfficerScope / group checks), plus scoped reads of master data. NOT master-data writes, user
  // management, Sales Upload or Dealer Alias (those stay Super-Admin-only).
  [Role.REGIONAL_MANAGER]: {
    products: ["read"],
    categories: ["read"],
    brands: ["read"],
    packSizes: ["read"],
    dealers: ["read"],
    seasons: ["read"],
    announcements: ["read"],
    dealerAssignments: ["read"],
    rmAssignments: ["read"],
    salesPlanning: ["read", "create", "update"],
    recoveryPlanning: ["read", "create", "update"],
    schemePlanning: ["read"],
    partyPlanning: ["read"],
  },
  [Role.SALES_OFFICER]: {
    products: ["read"],
    categories: ["read"],
    brands: ["read"],
    packSizes: ["read"],
    dealers: ["read"],
    seasons: ["read"],
    announcements: ["read"],
    dealerAssignments: ["read"],
    salesPlanning: ["read", "create", "update"],
    recoveryPlanning: ["read"],
    schemePlanning: ["read"],
    partyPlanning: ["read"],
  },
};

export function can(role: Role, resource: Resource, action: Action): boolean {
  return MATRIX[role]?.[resource]?.includes(action) ?? false;
}

export function isSuperAdmin(role: Role): boolean {
  return role === Role.SUPER_ADMIN;
}

export const ROLE_LABELS: Record<Role, string> = {
  [Role.SUPER_ADMIN]: "Super Admin",
  [Role.REGIONAL_MANAGER]: "Regional Manager",
  [Role.SALES_OFFICER]: "Sales Officer",
};
