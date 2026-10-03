import { Role } from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import { hasAdminPermission, canReadSeasonOptions, type AdminModule, type PermissionIdentity } from "./permissions";

type Rule = [AdminModule, string];
const writeAction = (method: string) => method === "DELETE" ? "delete" : method === "POST" ? "create" : "update";
/** Closed by default. Multi-action bodies have additional checks in the authoritative services. */
export function apiPermission(path: string, method: string): Rule | "personal" | "lookup" | null {
  try { path = decodeURIComponent(path); } catch { return null; }
  const read = method === "GET" || method === "HEAD";
  const p = path.replace(/^\/api\//, "");
  if (/^(notifications(?:\/|$)|dealer-display-names$)/.test(p) || p === "users/me/password" || p === "users/me/access") return "personal";
  if (p === "labels" && read) return "personal";
  if (p === "search") return null; // Cross-module search has no result-level permission filtering yet.
  if (p === "resources/options" || p === "categories" || p === "assignments/options") return read ? "lookup" : null;
  if (p === "users/officers" || /^dealers\/officer\//.test(p)) return read ? "lookup" : null;
  if (p === "groups" && read) return "lookup";
  if (p.startsWith("resources/")) {
    const resource = p.split("/")[1];
    // Legacy generic Users API permits role changes and returns password hashes. Never delegated.
    if (resource === "users") return null;
    const modules: Record<string, AdminModule> = { products: "products", categories: "categories", brands: "brands", packSizes: "packSizes", dealers: "dealers", announcements: "announcementMaster", settings: "settings" };
    return modules[resource] ? [modules[resource], read ? "read" : p.endsWith("/status") ? "delete" : writeAction(method)] : null;
  }
  if (p === "audit") return ["audit", "read"];
  if (p.startsWith("reports")) return ["reports", p.endsWith("/export") ? "export" : "read"];
  if (p.startsWith("calendar")) return ["calendar", read ? "read" : writeAction(method)];
  if (p === "labels") return ["labels", "update"];
  if (p.startsWith("settings/")) return [p.includes("recovery") ? "recoveryConfig" : "planningConfig", read ? "read" : "update"];
  if (p.startsWith("announcements")) return ["announcements", "read"];
  if (p.startsWith("daily-work")) {
    if (p.endsWith("attendance")) return ["performance", read ? "read" : "attendance"];
    if (/performance$/.test(p)) return ["performance", "read"];
    if (p.endsWith("admin-view") || p.endsWith("review")) return read ? ["dailyWork", "read"] : null;
    return null; // Existing employee plan/actual/submit/rating flows are not administrative actions.
  }
  if (p.startsWith("cn-requests")) {
    if (read) return ["cnRequests", "read"];
    if (p.endsWith("/act")) return ["cnRequests", "reject"];
    if (p.endsWith("/verify")) return ["cnRequests", "verifyPayment"];
    if (p.endsWith("/accept")) return ["cnRequests", "read"]; // approve/post selected in acceptance service
    return null; // SO payment/task/creation operations stay SO/RM-only.
  }
  if (p.startsWith("dealer-tags/requests") || p === "dealer-tags/direct") return ["dealerTags", "read"]; // payload decision checked by service
  if (p === "dealer-tags/dealers") return ["dealerTags", "read"];
  if (p.startsWith("dealer-tags")) return ["tagMaster", read ? "read" : writeAction(method)];
  if (p.startsWith("dealer-alias")) return ["dealerAlias", read ? "read" : method === "DELETE" ? "delete" : "update"];
  if (p.startsWith("onboarding")) return [p.includes("history") ? "onboardingHistory" : "onboarding", read ? "read" : p.endsWith("commit") ? "import" : "analyze"];
  if (p.startsWith("historical-daybook")) return ["salesUpload", read ? "read" : p.endsWith("commit") ? "import" : "analyze"];
  if (p.startsWith("sales-upload")) return ["salesUpload", read ? "read" : p.endsWith("commit") ? "import" : "analyze"];
  if (p.startsWith("import/")) {
    const moduleKey = p.startsWith("import/dealers/history") ? "importHistory" : p.startsWith("import/dealers") ? "dealerImport" : p.startsWith("import/prices") ? "priceImport" : "planImport";
    return [moduleKey, read ? "read" : p.endsWith("commit") ? "import" : p.endsWith("resolve") || p.endsWith("preview") ? "review" : "analyze"];
  }
  if (p.startsWith("scheme-upload")) return ["schemePlanning", read ? "read" : "upload"];
  if (p.startsWith("scheme-payments") || /scheme-plans\/[^/]+\/payments$/.test(p)) return ["payments", read ? "read" : "payment"];
  if (p.startsWith("scheme-installments")) return ["schemePlanning", read ? "read" : "update"];
  if (p.startsWith("scheme-follow-up")) return ["schemePlanning", "read"];
  if (p.startsWith("scheme-plans")) {
    if (!read && (p === "scheme-plans" || /submit|save-draft/.test(p))) return null; // Existing dealer-owner planning only.
    return ["schemePlanning", read ? "read" : /\/(?:admin-act|act)$/.test(p) ? "read" : p.endsWith("/verify") ? "verify" : "update"];
  }
  if (p.startsWith("scheme-instances")) return ["schemePlanning", read ? "read" : "update"];
  if (p.startsWith("schemes")) {
    if (/\/(?:planning|dealers|enrolled)$/.test(p) || ["schemes/eligible", "schemes/running", "schemes/enrolled", "schemes/team-officers"].includes(p)) return ["schemePlanning", "read"];
    return ["schemeMaster", read ? "read" : /\/(close|reopen)$/.test(p) ? "lifecycle" : writeAction(method)];
  }
  if (p.startsWith("party-plans")) return read ? ["partyPlanning", "read"] : p.endsWith("/act") ? ["partyPlanning", "read"] : null;
  if (p === "planning/approvals") return ["approvals", "read"];
  if (/^planning\/month-extensions\/[^/]+\/decide$/.test(p)) return ["approvals", "read"]; // approve/reject body checked by service
  if (/^(planning\/(season-plans|monthly-plans|lifecycle|month-extensions)|recovery\/plans)/.test(p)) {
    if (!read && p.endsWith("/submit")) return null; // Existing SO/RM ownership is mandatory, even for Super Admin.
    const moduleKey = p.startsWith("recovery") ? "recoveryPlanning" : "salesPlanning";
    const suffix = p.split("/").at(-1);
    return [moduleKey, read ? "read" : method === "DELETE" ? "delete" : ["approve", "reject", "return", "submit"].includes(suffix!) ? suffix! : ["lifecycle", "restore", "replace", "authorize-revision"].includes(suffix!) ? "lifecycle" : suffix === "transfer" ? "transfer" : method === "POST" && (p === "planning/season-plans" || p === "planning/monthly-plans") ? "create" : "update"];
  }
  if (p.startsWith("recovery/")) return ["recoveryPlanning", read ? "read" : "upload"];
  if (p.startsWith("planning/groups/")) return [p.endsWith("/recovery") ? "recoveryPlanning" : "salesPlanning", "read"];
  if (p.startsWith("products/merge") || p === "products/unmerge") return ["products", "merge"];
  if (p.startsWith("products")) return ["products", read ? "read" : "update"];
  if (/^groups\/[^/]+\/catalogue/.test(p)) return ["productCatalogue", read ? "read" : writeAction(method)];
  if (p.startsWith("groups") || p.startsWith("users")) return ["users", read ? "read" : p.endsWith("/status") ? "delete" : /\/(password|role)$/.test(p) ? "update" : writeAction(method)];
  if (p.startsWith("dealer-assignments") || p === "dealers/assign") return ["dealerAssignments", read ? "read" : writeAction(method)];
  if (p === "rm-assignments") return ["rmAssignments", read ? "read" : writeAction(method)];
  if (p.startsWith("dealers")) return ["dealers", read ? "read" : p.endsWith("/status") ? "update" : writeAction(method)];
  if (p.startsWith("seasons") || p.startsWith("season-months")) return ["seasons", read ? "read" : p.endsWith("/status") ? "update" : writeAction(method)];
  if (p.startsWith("profiles")) return [p.startsWith("profiles/dealer/") ? "dealers" : "users", "read"];
  if (p.startsWith("officers")) return ["users", "read"];
  return null;
}
export function assertApiAccess(identity: PermissionIdentity, path: string, method: string): void {
  if (identity.role !== Role.CUSTOM_ADMIN) return;
  const rule = apiPermission(path, method);
  try { path = decodeURIComponent(path); } catch { throw new ApiError(403, "Invalid request path."); }
  // These exact read endpoints are already reused as selectors by other modules.
  // Their master pages and all mutation endpoints retain separate grants.
  if (method === "GET") {
    if (path === "/api/seasons" && canReadSeasonOptions(identity)) return;
    if (path === "/api/import/dealers/options" && (["salesPlanning", "planImport", "dealerImport"] as AdminModule[]).some(m => hasAdminPermission(identity, m))) return;
    if (path === "/api/dealer-tags" && hasAdminPermission(identity, "dealerTags")) return;
  }
  if (rule === "personal") return;
  if (rule === "lookup" && Object.values(identity.permissions ?? {}).some(a => a?.includes("read"))) return;
  if (Array.isArray(rule) && hasAdminPermission(identity, rule[0], rule[1])) return;
  throw new ApiError(403, "You do not have permission to perform this operation.");
}
