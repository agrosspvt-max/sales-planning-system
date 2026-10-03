import { Role } from "@prisma/client";
import { ApiError } from "@/lib/api-error";

const READ = ["read"];
const CRUD = ["read", "create", "update", "delete"];
const PLAN = ["read", "update", "approve", "reject", "return", "lifecycle"];
const IMPORT = ["read", "analyze", "import"];
const REVIEW_IMPORT = [...IMPORT, "review"];
/** Real navigation leaves. Owner-only Account Management is deliberately not grantable. */
export const ADMIN_MODULES = [
  { id: "dashboard", label: "Dashboard", group: "Insights", href: "/dashboard", actions: READ },
  { id: "onboarding", label: "Company Onboarding", group: "Setup", href: "/onboarding", actions: IMPORT },
  { id: "onboardingHistory", label: "Onboarding History", group: "Setup", href: "/onboarding/history", actions: READ },
  { id: "salesPlanning", label: "Sales Planning", group: "Planning", href: "/planning/sales", actions: [...PLAN, "create", "delete"] },
  { id: "recoveryPlanning", label: "Recovery Planning", group: "Planning", href: "/planning/recovery", actions: [...PLAN, "delete", "upload", "transfer"] },
  { id: "schemePlanning", label: "Scheme Planning", group: "Planning", href: "/planning/scheme", actions: [...PLAN, "verify", "upload"] },
  { id: "partyPlanning", label: "Dealer Appointment", group: "Planning", href: "/planning/party", actions: ["read", "approve", "reject"] },
  { id: "dailyWork", label: "Daily Work (administrative viewer)", group: "Planning", href: "/daily-work", actions: READ },
  { id: "calendar", label: "Calendar", group: "Planning", href: "/planning/calendar", actions: ["read", "create", "update", "delete"] },
  { id: "planImport", label: "Import Seasonal Plan", group: "Planning", href: "/planning/sales/import", actions: IMPORT },
  { id: "salesUpload", label: "Sales Upload", group: "Planning", href: "/planning/sales-upload", actions: IMPORT },
  { id: "dealerAlias", label: "Dealer Alias", group: "Planning", href: "/planning/dealer-alias", actions: ["read", "update", "delete"] },
  { id: "approvals", label: "Approvals", group: "Planning", href: "/planning/approvals", actions: ["read", "approve", "reject", "return"] },
  { id: "payments", label: "Payments", group: "Planning", href: "/payments", actions: ["read", "payment"] },
  { id: "cnRequests", label: "CN Requests", group: "Requests", href: "/requests/cn", actions: ["read", "approve", "reject", "post", "verifyPayment"] },
  { id: "dealerTags", label: "Dealer Tags", group: "Requests", href: "/dealer-tags", actions: ["read", "assign", "revoke", "approve", "reject"] },
  { id: "performance", label: "Performance", group: "Insights", href: "/performance", actions: ["read", "attendance"] },
  { id: "reports", label: "Reports", group: "Insights", href: "/reports", actions: ["read", "export"] },
  { id: "announcements", label: "Announcements", group: "Insights", href: "/announcements", actions: READ },
  { id: "audit", label: "Audit Logs", group: "Insights", href: "/audit", actions: READ },
  { id: "products", label: "Product Master", group: "Master Data", href: "/masters/products", actions: [...CRUD, "merge"] },
  { id: "productCatalogue", label: "State Catalogue", group: "Master Data", href: "/masters/product-catalogue", actions: ["read", "create", "update", "delete"] },
  { id: "categories", label: "Categories", group: "Master Data", href: "/masters/categories", actions: CRUD },
  { id: "brands", label: "Brands (existing resource)", group: "Master Data", href: "/masters/brands", actions: CRUD },
  { id: "packSizes", label: "Pack Sizes", group: "Master Data", href: "/masters/packSizes", actions: CRUD },
  { id: "dealers", label: "Dealers", group: "Master Data", href: "/masters/dealers", actions: CRUD },
  { id: "tagMaster", label: "Tag Master", group: "Master Data", href: "/masters/dealer-tags", actions: ["read", "create", "update"] },
  { id: "users", label: "Users and States (employees only)", group: "Master Data", href: "/masters/users", actions: CRUD },
  { id: "seasons", label: "Seasons", group: "Master Data", href: "/seasons", actions: ["read", "create", "update", "delete"] },
  { id: "announcementMaster", label: "Announcements", group: "Master Data", href: "/masters/announcements", actions: CRUD },
  { id: "settings", label: "Settings", group: "Master Data", href: "/masters/settings", actions: CRUD },
  { id: "planningConfig", label: "Planning Configuration", group: "Master Data", href: "/masters/planning-config", actions: ["read", "update"] },
  { id: "recoveryConfig", label: "Recovery Settings", group: "Master Data", href: "/masters/recovery-config", actions: ["read", "update"] },
  { id: "schemeMaster", label: "Scheme Master", group: "Master Data", href: "/masters/schemes", actions: [...CRUD, "lifecycle"] },
  { id: "labels", label: "Labels", group: "Master Data", href: "/masters/labels", actions: ["read", "update"] },
  { id: "dealerImport", label: "Dealer Import Wizard", group: "Master Data", href: "/masters/dealer-import", actions: REVIEW_IMPORT },
  { id: "priceImport", label: "Product Price Import", group: "Master Data", href: "/masters/product-price-import", actions: REVIEW_IMPORT },
  { id: "importHistory", label: "Import History", group: "Master Data", href: "/masters/import-history", actions: READ },
  { id: "dealerAssignments", label: "Dealer Assignments", group: "Organization", href: "/assignments/dealers", actions: ["read", "create", "update", "delete"] },
  { id: "rmAssignments", label: "RM Assignments", group: "Organization", href: "/assignments/rm", actions: ["read", "create", "update", "delete"] },
] as const;
export type AdminModule = typeof ADMIN_MODULES[number]["id"];
export type AdminPermissions = Partial<Record<AdminModule, string[]>>;
export interface PermissionIdentity { role: Role; permissions?: AdminPermissions; designation?: string | null }
/** Presentation only; destination pages still enforce current server permissions. */
export function accountLandingPage(role?: Role): "/account" | "/dashboard" {
  return role === Role.CUSTOM_ADMIN ? "/account" : "/dashboard";
}
export function isAdministrativeRole(role: Role): boolean {
  return role === Role.SUPER_ADMIN || role === Role.CUSTOM_ADMIN;
}
export function hasAdminPermission(identity: PermissionIdentity, module: AdminModule, action = "read"): boolean {
  if (identity.role === Role.SUPER_ADMIN) return true;
  if (identity.role !== Role.CUSTOM_ADMIN) return false;
  const actions = identity.permissions?.[module];
  return !!actions?.includes("read") && actions.includes(action);
}
export function assertAdminPermission(identity: PermissionIdentity, module: AdminModule, action: string): void {
  // Legacy role/workflow guards remain authoritative for SO/RM.
  if (identity.role === Role.CUSTOM_ADMIN && !hasAdminPermission(identity, module, action)) {
    throw new ApiError(403, `Permission required: ${module} / ${action}`);
  }
}
/** Existing season selector shared by planning/report screens; it never grants management access. */
export function canReadSeasonOptions(identity: PermissionIdentity): boolean {
  return (["seasons", "salesPlanning", "recoveryPlanning", "reports", "planImport", "users", "calendar"] as AdminModule[])
    .some(module => hasAdminPermission(identity, module));
}
export function moduleForPage(path: string): AdminModule | null {
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/^\/groups\/[^/]+\/catalogue(?:\/|$)/.test(path)) return "productCatalogue";
  if (path.startsWith("/groups/") || path.startsWith("/planning/group/")) return "users";
  if (path.startsWith("/masters/product-groups")) return "productCatalogue";
  const moduleKey = [...ADMIN_MODULES].sort((a, b) => b.href.length - a.href.length)
    .find(m => path === m.href || path.startsWith(`${m.href}/`))?.id ?? null;
  if (moduleKey) return moduleKey;
  // Legacy dynamic sales-plan paths are considered only after named planning modules.
  if (/^\/planning\/(monthly\/|[^/]+$)/.test(path) && path !== "/planning/create" && path !== "/planning/view") return "salesPlanning";
  return null;
}
export function mayEnterPage(identity: PermissionIdentity, path: string): boolean {
  if (identity.role !== Role.CUSTOM_ADMIN) return true;
  if (path === "/account") return true; // Own password, no administrative grant.
  if (["/planning/create", "/planning/view"].includes(path)) {
    return ["salesPlanning", "recoveryPlanning", "schemePlanning", "partyPlanning"].some(m => hasAdminPermission(identity, m as AdminModule));
  }
  const moduleKey = moduleForPage(path);
  return !!moduleKey && hasAdminPermission(identity, moduleKey);
}
