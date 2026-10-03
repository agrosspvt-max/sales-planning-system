import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Role } from "@prisma/client";
import { testLoader } from "@/features/dealer-tags/test-loader";
import { ADMIN_MODULES, hasAdminPermission, mayEnterPage, isAdministrativeRole, accountLandingPage, type AdminPermissions } from "./permissions";
import { assertApiAccess, apiPermission } from "./route-permissions";
import { NAV_ITEMS, navForRole } from "@/features/navigation/nav";
import { can, ROLE_LABELS } from "@/lib/rbac";
import { ApiError } from "@/lib/api-error";

const custom = (permissions: AdminPermissions = {}) => ({ role: Role.CUSTOM_ADMIN, permissions, designation: "Super Admin" });
const deny = (fn: () => unknown) => assert.throws(fn, e => (e as { status: number }).status === 403);
async function main() {
  assert.equal(accountLandingPage(Role.CUSTOM_ADMIN), "/account");
  for (const role of [Role.SUPER_ADMIN, Role.SALES_OFFICER, Role.REGIONAL_MANAGER]) assert.equal(accountLandingPage(role), "/dashboard");
  assert.equal(hasAdminPermission(custom(), "cnRequests", "approve"), false, "Designation never grants authority");
  assert.equal(hasAdminPermission(custom({ cnRequests: ["approve"] }), "cnRequests", "approve"), false, "Action without module access is denied");
  const viewer = custom({ cnRequests: ["read"] });
  assertApiAccess(viewer, "/api/cn-requests", "GET");
  assertApiAccess(viewer, "/api/%63n-requests", "GET");
  deny(() => assertApiAccess(viewer, "/api/%61ccounts", "GET"));
  deny(() => assertApiAccess(custom({ products: ["read", "create"] }), "/api/resources/products/id/status", "POST"));
  assertApiAccess(custom({ products: ["read", "delete"] }), "/api/resources/products/id/status", "POST");
  assert.equal(can(Role.CUSTOM_ADMIN, "announcements", "create", { announcementMaster: ["read", "create"] }), true);
  deny(() => assertApiAccess(viewer, "/api/cn-requests/1/act", "POST"));
  deny(() => assertApiAccess(viewer, "/api/cn-requests/1/verify", "POST"));
  deny(() => assertApiAccess(custom({ dailyWork: ["read"] }), "/api/daily-work/review", "POST"));
  deny(() => assertApiAccess(custom({ performance: ["read"] }), "/api/daily-work/attendance", "POST"));
  assertApiAccess(custom({ reports: ["read"] }), "/api/seasons", "GET");
  deny(() => assertApiAccess(custom({ reports: ["read"] }), "/api/seasons", "POST"));
  deny(() => assertApiAccess(custom({ reports: ["read"] }), "/api/seasons/fixture/months", "GET"));
  assert.equal(mayEnterPage(custom({ reports: ["read"] }), "/seasons"), false);
  assertApiAccess(custom({ salesPlanning: ["read"] }), "/api/import/dealers/options", "GET");
  deny(() => assertApiAccess(custom({ salesPlanning: ["read"] }), "/api/import/dealers/commit", "POST"));
  assertApiAccess(custom({ dealerTags: ["read"] }), "/api/dealer-tags", "GET");
  deny(() => assertApiAccess(custom({ dealerTags: ["read"] }), "/api/dealer-tags", "POST"));
  deny(() => assertApiAccess(viewer, "/api/sales-upload/commit", "POST"));
  deny(() => assertApiAccess(custom({ salesUpload: ["read", "analyze"] }), "/api/sales-upload/commit", "POST"));
  assertApiAccess(custom({ salesUpload: ["read", "import"] }), "/api/sales-upload/commit", "POST");
  deny(() => assertApiAccess(custom({ salesPlanning: ["read", "approve"] }), "/api/planning/season-plans/1/return", "POST"));
  assertApiAccess(custom({ salesPlanning: ["read", "return"] }), "/api/planning/season-plans/1/return", "POST");
  deny(() => assertApiAccess(custom({ users: ["read", "update"] }), "/api/resources/users/1", "PATCH"));
  deny(() => assertApiAccess(custom(Object.fromEntries(ADMIN_MODULES.map(m => [m.id, [...m.actions]]))), "/api/accounts", "POST"));
  deny(() => assertApiAccess(custom(), "/api/future-unclassified-module", "GET"));
  assert.equal(mayEnterPage(viewer, "/requests/cn"), true);
  assert.equal(mayEnterPage(viewer, "/planning/sales-upload"), false);
  assert.equal(mayEnterPage(viewer, "/account-management"), false);
  assert.equal(mayEnterPage(custom(), "/planning/create"), false);
  assert.equal(mayEnterPage(custom({ schemePlanning: ["read"] }), "/planning/create"), true);
  for (const m of ADMIN_MODULES) {
    assert.equal(mayEnterPage(custom({ [m.id]: ["read"] }), m.href), true, `Each module is independently grantable: ${m.href}`);
  }
  assert.equal(mayEnterPage(custom({ calendar: ["read"] }), "/planning/calendar"), true);
  assert.equal(mayEnterPage(custom({ salesPlanning: ["read"] }), "/planning/scheme"), false);
  assert.equal(mayEnterPage(custom({ productCatalogue: ["read"] }), "/groups/state/catalogue"), true);
  const nav = navForRole(Role.CUSTOM_ADMIN, true, viewer.permissions, true);
  assert.deepEqual(nav.map(n => n.href).sort(), ["/account", "/requests/cn"].sort());
  assert.equal(navForRole(Role.SUPER_ADMIN, true, undefined, true).some(n => n.href === "/account-management"), true);
  assert.equal(navForRole(Role.SUPER_ADMIN).some(n => n.href === "/account-management"), false);
  assert.equal(navForRole(Role.CUSTOM_ADMIN, false, { calendar: ["read"] }).some(n => n.href === "/planning/calendar"), false);
  assert.equal(ROLE_LABELS[Role.CUSTOM_ADMIN], "Administrative Account");
  assert.equal(isAdministrativeRole(Role.CUSTOM_ADMIN), true);
  assert.equal(isAdministrativeRole(Role.REGIONAL_MANAGER), false);
  assert.equal(can(Role.SUPER_ADMIN, "users", "delete"), true);
  assert.equal(can(Role.REGIONAL_MANAGER, "users", "delete"), false);
  assert.equal(can(Role.SALES_OFFICER, "schemePlanning", "read"), true);
  assert.equal(can(Role.CUSTOM_ADMIN, "users", "update"), false);
  assert.equal(can(Role.CUSTOM_ADMIN, "users", "update", { users: ["read", "update"] }), true);
  for (const item of NAV_ITEMS.flatMap(i => i.children ?? [i])) {
    if (item.href === "/account-management" || item.href === "/account" || item.href === "/team-performance") continue;
    const all = custom(Object.fromEntries(ADMIN_MODULES.map(m => [m.id, [...m.actions]])));
    assert.equal(mayEnterPage(all, item.href), true, `Catalogue covers real navigation: ${item.href}`);
  }
  // Every real endpoint/method is classified or explicitly closed to delegated accounts.
  let routes = 0;
  function scan(dir: string) {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const f = `${dir}/${d.name}`;
      if (d.isDirectory()) { scan(f); continue; }
      if (d.name !== "route.ts") continue;
      const p = f.replace(/^src\/app/, "").replace(/\/route.ts$/, "").replace(/\[[^\]]+\]/g, "fixture");
      for (const match of readFileSync(f, "utf8").matchAll(/export async function (GET|POST|PATCH|DELETE|PUT)/g)) {
        const rule = apiPermission(p, match[1]);
        if (Array.isArray(rule)) {
          const def = ADMIN_MODULES.find(m => m.id === rule[0]);
          assert.ok(def && (def.actions as readonly string[]).includes(rule[1]), `${p}: actual action must be in permission catalogue`);
        }
        routes++;
      }
    }
  }
  scan("src/app/api");

  let ownerId = "verified-owner";
  const ownerDb = { accountManagementOwner: { findUnique: async () => ({ userId: ownerId }) }, user: { findUnique: async () => ({ role: Role.SUPER_ADMIN, isActive: true, deletedAt: null }) } };
  const account = testLoader({ "@/lib/prisma": { prisma: ownerDb }, "@/lib/http": { ApiError, invalidateAuthCache() {} } })<typeof import("./service.server")>("src/features/accounts/service.server.ts");
  const root = { userId: ownerId, role: Role.SUPER_ADMIN, username: "renamed-owner", groupId: null, authenticationMethod: "credentials" };
  await account.requireAccountOwner(root);
  await assert.rejects(account.requireAccountOwner({ ...root, authenticationMethod: "admin-bypass" }), e => (e as { status: number }).status === 403);
  await assert.rejects(account.requireAccountOwner({ ...root, authenticationMethod: undefined }), e => (e as { status: number }).status === 403);
  await assert.rejects(account.requireAccountOwner({ ...root, userId: "another-admin" }), e => (e as { status: number }).status === 403);
  await assert.rejects(account.requireAccountOwner({ ...root, role: Role.CUSTOM_ADMIN }), e => (e as { status: number }).status === 403);
  ownerId = "different-stable-id";
  await assert.rejects(account.requireAccountOwner(root), e => (e as { status: number }).status === 403);
  const input = { name: "  Rahul  ", username: "Controller", password: "local-test-only", designation: "Operations Head", isActive: true, permissions: { cnRequests: ["read", "approve"] } };
  assert.equal(account.createAccountSchema.parse(input).username, "controller");
  for (const bad of [{ ...input, designation: " " }, { ...input, password: "" }, { ...input, role: "SUPER_ADMIN" }, { ...input, permissions: { accountManagement: ["read"] } }, { ...input, permissions: { cnRequests: ["approve"] } }]) {
    assert.equal(account.createAccountSchema.safeParse(bad).success, false);
  }

  let current = { id: "custom", role: Role.CUSTOM_ADMIN, name: "Operator", username: "operator", isActive: true, deletedAt: null as Date | null, sessionValidAfter: null as Date | null, designation: "Operations Head", adminPermissions: { cnRequests: ["read"] } as AdminPermissions };
  let path = "/api/cn-requests", method = "GET", reads = 0;
  const auth = testLoader({
    "next-auth": () => ({ auth: async () => ({ user: { id: current.id, role: Role.CUSTOM_ADMIN, iat: 1 } }), handlers: {}, signIn() {}, signOut() {} }),
    "next-auth/providers/credentials": () => ({}),
    "next/headers": { headers: async () => new Headers({ "x-account-request-path": path, "x-account-request-method": method }) },
    "next/navigation": { redirect: (to: string) => { throw new Error(`redirect:${to}`); } },
    "@/lib/prisma": { prisma: { user: { findUnique: async () => { reads++; return current; } } } },
  })<typeof import("@/auth")>("src/auth.ts");
  assert.equal((await auth.auth())?.user.designation, "Operations Head");
  current = { ...current, adminPermissions: {} };
  await assert.rejects(auth.auth(), e => (e as { status: number }).status === 403);
  current = { ...current, adminPermissions: { cnRequests: ["read"] }, isActive: false };
  await assert.rejects(auth.auth(), e => (e as { status: number }).status === 401);
  current = { ...current, isActive: true, sessionValidAfter: new Date(2000) };
  await assert.rejects(auth.auth(), e => (e as { status: number }).status === 401);
  current = { ...current, sessionValidAfter: null };
  path = "/api/cn-requests/id/act"; method = "POST";
  await assert.rejects(auth.auth(), e => (e as { status: number }).status === 403);
  assert.equal(reads, 5, "Custom authorization is reloaded on every request, never cached in a JWT/TTL");
  // Next.js can load the named middleware export. Both exports must use the wrapper,
  // not the raw NextAuth handler, or trusted authorization context is never forwarded.
  const middlewareModule = { exports: {} as Record<string, (req: unknown) => { request: { headers: Headers } }> };
  runInNewContext(ts.transpileModule(readFileSync("src/middleware.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, { module: middlewareModule, exports: middlewareModule.exports, Headers,
    require: (name: string) => name === "next-auth" ? () => ({ auth: (handler: unknown) => handler }) :
      name === "next/server" ? { NextResponse: { next: (init: unknown) => init } } : { authConfig: {} } });
  assert.equal(middlewareModule.exports.default, middlewareModule.exports.middleware);
  const forwarded = middlewareModule.exports.middleware({ headers: new Headers({ "x-account-request-path": "/api/users/me/access", "x-account-request-method": "GET" }), nextUrl: { pathname: "/api/accounts" }, method: "POST" });
  assert.equal(forwarded.request.headers.get("x-account-request-path"), "/api/accounts");
  assert.equal(forwarded.request.headers.get("x-account-request-method"), "POST");
  console.log(`Account authorization tests passed; ${routes} actual route/method combinations audited.`);
}
void main();
