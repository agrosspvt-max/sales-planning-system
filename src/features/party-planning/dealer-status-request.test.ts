/**
 * Dealer Status Change Requests (Territory Mapping): SO / RM report a dealer in their scope, Admin reviews and resolves. Runs the REAL
 * territory service (and the REAL editDealer service for the "edit never resolves" contracts) against an in-memory database.
 * A request never changes the dealer; resolving only closes the request; history is never overwritten or deleted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Prisma, Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { DEALER_STATUS_REASONS, validateStatusRequest } from "@/lib/dealer-status-request";
import type { AuthContext } from "@/lib/http";

type Row = Record<string, unknown>;
const USERS = [
  { id: "admin", name: "Admin", role: Role.SUPER_ADMIN, groupId: null as string | null, isActive: true },
  { id: "rm1", name: "RM One", role: Role.REGIONAL_MANAGER, groupId: "g1", isActive: true },
  { id: "so1", name: "Officer One", role: Role.SALES_OFFICER, groupId: "g1", isActive: true },
  { id: "so2", name: "Officer Two", role: Role.SALES_OFFICER, groupId: "g1", isActive: true },
  { id: "so3", name: "Officer Three", role: Role.SALES_OFFICER, groupId: "g2", isActive: true },
];
const mkDealers = () => [
  { id: "d1", name: "ABC Traders", status: "ACTIVE", owner: "so1", deletedAt: null as Date | null },
  { id: "d2", name: "Sharma Fertilizers", status: "ACTIVE", owner: "so1", deletedAt: null },
  { id: "d3", name: "Gupta Agency", status: "PENDING", owner: "so2", deletedAt: null },
  { id: "d4", name: "Far Away Agro", status: "ACTIVE", owner: "so3", deletedAt: null },
];

function makeDb() {
  const t = { dealers: mkDealers(), requests: [] as Row[], audit: [] as Row[], dealerWrites: 0, loaderCalls: [] as (string[] | undefined)[], raceNext: false, seq: 0 };
  const matches = (row: Row, where: Row | undefined): boolean => !where || Object.entries(where).every(([k, c]) => {
    if (c && typeof c === "object" && "in" in (c as Row)) return ((c as Row).in as unknown[]).includes(row[k]);
    return (row[k] ?? null) === (c ?? null);
  });
  const pickDealer = (d: (typeof t.dealers)[number]) => ({ id: d.id, name: d.name, status: d.status, isActive: d.status !== "INACTIVE", deletedAt: d.deletedAt });
  const prisma = {
    dealer: {
      findFirst: async ({ where }: { where: Row }) => { const d = t.dealers.find((x) => matches(x as Row, where)); return d ? pickDealer(d) : null; },
      findUnique: async ({ where }: { where: Row }) => { const d = t.dealers.find((x) => matches(x as Row, where)); return d ? pickDealer(d) : null; },
      findMany: async ({ where }: { where: Row }) => t.dealers.filter((x) => matches(x as Row, where)).map(pickDealer),
      update: async ({ where, data }: { where: Row; data: Row }) => { t.dealerWrites++; const d = t.dealers.find((x) => matches(x as Row, where))!; Object.assign(d, data); return pickDealer(d); },
    },
    dealerAssignment: { findFirst: async ({ where }: { where: { dealerId: string } }) => { const d = t.dealers.find((x) => x.id === where.dealerId); return d ? { officerId: d.owner } : null; } },
    dealerAlias: { findMany: async () => [] as Row[], findUnique: async () => null, create: async () => ({}) },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => USERS.filter((u) => where.id.in.includes(u.id)),
      findUnique: async ({ where }: { where: { id: string } }) => USERS.find((u) => u.id === where.id) ?? null,
    },
    dealerStatusRequest: {
      findFirst: async ({ where }: { where: Row }) => { if (t.raceNext) { t.raceNext = false; return null; } const r = t.requests.find((x) => matches(x, where)); return r ? { ...r } : null; },
      findUnique: async ({ where }: { where: Row }) => { const r = t.requests.find((x) => matches(x, where)); return r ? { ...r } : null; },
      findMany: async ({ where }: { where: Row }) => t.requests.filter((x) => matches(x, where)).map((r) => ({ ...r })),
      create: async ({ data }: { data: Row }) => {
        // The partial unique index "one PENDING request per dealer".
        if (t.requests.some((r) => r.dealerId === data.dealerId && r.status === "PENDING")) throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
        const row = { id: `req${++t.seq}`, description: null, resolvedById: null, resolvedAt: null, resolutionNotes: null, createdAt: new Date(Date.UTC(2026, 9, 10, 9, 0, t.seq)), ...data };
        t.requests.push(row); return { ...row };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => { const hit = t.requests.filter((x) => matches(x, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const snap = structuredClone([t.requests, t.audit, t.dealers]);
      try { return await fn(prisma); } catch (e) { [t.requests, t.audit, t.dealers] = snap as [Row[], Row[], typeof t.dealers]; throw e; }
    },
  };
  return { prisma, t };
}

function load() {
  const db = makeDb();
  const owner = (id: string) => db.t.dealers.find((d) => d.id === id)?.owner;
  const getOfficerScope = async (ctx: AuthContext) => {
    if (ctx.role === Role.SUPER_ADMIN || ctx.role === Role.CUSTOM_ADMIN) return { all: true, ids: [] as string[] };
    if (ctx.role === Role.SALES_OFFICER) return { all: false, ids: [ctx.userId] };
    return { all: false, ids: [ctx.userId, ...USERS.filter((u) => u.role === Role.SALES_OFFICER && u.groupId === ctx.groupId).map((u) => u.id)] };
  };
  const loader = testLoader({
    "@/lib/prisma": { prisma: db.prisma },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/audit": { writeAudit: async (p: Row) => { db.t.audit.push({ ...p }); } },
    "@/lib/scope": {
      getOfficerScope, isDealerOwnerRole: (r: Role) => r === Role.SALES_OFFICER || r === Role.REGIONAL_MANAGER,
      getCurrentOwnerByDealer: async (ids: string[]) => new Map(ids.filter((i) => owner(i)).map((i) => [i, owner(i)!])),
      getCurrentManagerId: async () => null,
    },
    // The Dealer Alias page's own list loader (what feeds its Edit dialog) — recorded so we can prove the Request tab reuses it.
    "@/features/sales-upload/alias.server": {
      listDealersForAlias: async (_c: unknown, _f: unknown, _g: unknown, _o: unknown, _s: unknown, ids?: string[]) => {
        db.t.loaderCalls.push(ids);
        return { counts: {}, dealers: db.t.dealers.filter((d) => !ids || ids.includes(d.id)).map((d) => ({ id: d.id, name: d.name, status: d.status, officerId: d.owner, groupId: "g1", town: null, inActivePlan: false, aliases: [] })) };
      },
    },
    "@/features/assignments/service.server": { applyDealerAssignment: async () => undefined },
    "@/features/planning/monthly-plan.server": { addDealerToActiveSeasonalPlan: async () => ({ added: true }) },
  });
  return { service: loader("src/features/party-planning/territory.server.ts") as typeof import("./territory.server"), manage: loader("src/features/dealers/manage.server.ts") as typeof import("@/features/dealers/manage.server"), ...db };
}

const ctxOf = (userId: string): AuthContext => { const u = USERS.find((x) => x.id === userId)!; return { userId, role: u.role, username: userId, groupId: u.groupId, designation: null } as unknown as AuthContext; };
const SO1 = ctxOf("so1"), RM1 = ctxOf("rm1"), ADMIN = ctxOf("admin");
const CUSTOM_NO_PERM = { ...ctxOf("admin"), role: Role.CUSTOM_ADMIN, permissions: { partyPlanning: ["read"] } } as unknown as AuthContext;
const CUSTOM_MANAGE = { ...ctxOf("admin"), role: Role.CUSTOM_ADMIN, permissions: { partyPlanning: ["read", "manage"] } } as unknown as AuthContext;
const status = async (fn: () => Promise<unknown>) => { try { await fn(); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; } };

async function main() {
  /* ---- validation rules ---- */
  for (const r of ["INACTIVE", "LEGAL", "PARTY_IN_PLANNING"]) assert.equal(validateStatusRequest({ reason: r }), null, `${r} needs no reason text`);
  assert.equal(validateStatusRequest({ reason: "LEGAL", description: "x".repeat(900) }), null, "text sent with a non-Other choice is ignored, not validated");
  assert.ok(validateStatusRequest({ reason: "DOES_NOT_EXIST" }) && validateStatusRequest({ reason: "PARTY_CLOSED" }), "legacy values cannot be chosen for a NEW request");
  assert.deepEqual(DEALER_STATUS_REASONS, ["INACTIVE", "LEGAL", "PARTY_IN_PLANNING", "OTHER"], "the four options, in order");
  assert.ok(validateStatusRequest({ reason: "OTHER" }), "Other requires a description");
  assert.ok(validateStatusRequest({ reason: "OTHER", description: "   " }), "whitespace is not a description");
  assert.equal(validateStatusRequest({ reason: "OTHER", description: "Merged with another party" }), null);
  assert.ok(validateStatusRequest({ reason: "BOGUS" }) && validateStatusRequest({}));

  /* ---- SO / RM submit within scope; the dealer is never touched ---- */
  {
    const { service, t } = load();
    const before = JSON.stringify(t.dealers);
    const r = await service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "INACTIVE" });
    assert.deepEqual([r.status, r.reason, r.statusAtRequest, r.requestedByRole, r.requestedByName, r.partyName], ["PENDING", "INACTIVE", "ACTIVE", Role.SALES_OFFICER, "Officer One", "ABC Traders"]);
    const row = t.requests[0]!;
    assert.deepEqual([row.dealerId, row.requestedById, row.requestedByRole, row.status, row.resolvedById], ["d1", "so1", Role.SALES_OFFICER, "PENDING", null], "persisted: dealer, requester + role, state");
    assert.ok(row.createdAt instanceof Date, "request timestamp");
    assert.equal(JSON.stringify(t.dealers), before, "dealer status (and every dealer field) is unchanged by submitting");
    assert.equal(t.dealerWrites, 0, "no Dealer write at all");
    assert.ok(t.audit.some((a) => a.entity === "dealerStatusRequest" && a.action === "CREATE"), "audited");

    const rm = await service.createDealerStatusRequest(RM1, { dealerId: "d3", reason: "OTHER", description: "  Moved   to another town " });
    assert.deepEqual([rm.requestedByRole, rm.statusAtRequest, rm.description], [Role.REGIONAL_MANAGER, "PENDING", "Moved to another town"], "RM may request for a dealer of their group; status at request time is stored; description normalized");
  }

  /* ---- scope, roles, input ---- */
  {
    const { service, t } = load();
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d3", reason: "INACTIVE" })), 403, "SO cannot request for another officer's dealer");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d4", reason: "INACTIVE" })), 403, "nor another group's");
    assert.equal(await status(() => service.createDealerStatusRequest(RM1, { dealerId: "d4", reason: "INACTIVE" })), 403, "RM cannot request outside their group");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "nope", reason: "INACTIVE" })), 404, "unknown dealer id");
    t.dealers.find((d) => d.id === "d2")!.deletedAt = new Date();
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d2", reason: "INACTIVE" })), 404, "deleted dealer");
    assert.equal(await status(() => service.createDealerStatusRequest(ADMIN, { dealerId: "d1", reason: "INACTIVE" })), 403, "Admin does not use the request workflow");
    assert.equal(await status(() => service.createDealerStatusRequest({ ...SO1, role: undefined } as unknown as AuthContext, { dealerId: "d1", reason: "INACTIVE" })), 403, "no role / unauthenticated context");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER" })), 422, "Other without a description");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER", description: "x".repeat(501) })), 422, "description too long");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "BOGUS" })), 422, "unknown reason");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { reason: "INACTIVE" })), 422, "missing dealer id");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, null)), 422, "empty body");
    assert.equal(t.requests.length, 0, "every refused request left nothing behind");
    assert.equal(t.dealerWrites, 0);
  }

  /* ---- duplicates ---- */
  {
    const { service, t } = load();
    await service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "INACTIVE" });
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "INACTIVE" })), 409, "same dealer + reason");
    assert.equal(await status(() => service.createDealerStatusRequest(RM1, { dealerId: "d1", reason: "LEGAL" })), 409, "one open request per dealer, whoever raises it");
    assert.equal(t.requests.length, 1);
    t.raceNext = true; // two submits pass the check at the same moment: the unique index decides, and it surfaces as a conflict, not a 500
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER", description: "x" })), 409, "concurrent duplicate");
    assert.equal(t.requests.length, 1);
    await service.resolveDealerStatusRequest(ADMIN, "req1", {});
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "INACTIVE" })), 0, "after resolution a new request is allowed");
    assert.equal(t.requests.length, 2, "…and the first one is kept");
  }

  /* ---- Admin-only access ---- */
  {
    const { service, t } = load();
    await service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "LEGAL" });
    for (const [who, c] of [["SO", SO1], ["RM", RM1], ["Custom Admin without manage", CUSTOM_NO_PERM]] as const) {
      assert.equal(await status(() => service.listDealerStatusRequests(c, "pending")), 403, `${who} cannot list`);
      assert.equal(await status(() => service.resolveDealerStatusRequest(c, "req1", {})), 403, `${who} cannot resolve`);
    }
    assert.equal(t.requests[0]!.status, "PENDING", "refused attempts changed nothing");
    assert.equal(await status(() => service.listDealerStatusRequests({ ...ADMIN, role: undefined } as unknown as AuthContext, "pending")), 403, "no role");
    assert.equal(await status(() => service.listDealerStatusRequests(CUSTOM_MANAGE, "pending")), 0, "Custom Admin WITH Party Planning manage can");
    const pending = await service.listDealerStatusRequests(ADMIN, "pending");
    assert.deepEqual(pending.map((p) => [p.partyName, p.reason, p.status, p.requestedByName, p.currentStatus]), [["ABC Traders", "LEGAL", "PENDING", "Officer One", "ACTIVE"]]);
    assert.equal(pending[0]!.editDealer?.id, "d1", "carries the Dealer Alias edit-dialog prefill");
    assert.equal(JSON.stringify(t.loaderCalls.at(-1)), JSON.stringify(["d1"]), "fed by the Dealer Alias page's own list loader, narrowed to the requested dealers (no second dealer-data path)");
  }

  /* ---- resolve: explicit, history preserved, dealer untouched ---- */
  {
    const { service, t } = load();
    await service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER", description: "Renamed" });
    const dealerBefore = JSON.stringify(t.dealers);
    assert.equal(await status(() => service.resolveDealerStatusRequest(ADMIN, "nope", {})), 404);
    assert.equal(await status(() => service.resolveDealerStatusRequest(ADMIN, "req1", { notes: "x".repeat(501) })), 422);
    const done = await service.resolveDealerStatusRequest(ADMIN, "req1", { notes: " Renamed in master " });
    assert.deepEqual([done.status, done.resolvedByName, done.resolutionNotes], ["RESOLVED", "Admin", "Renamed in master"]);
    const row = t.requests[0]!;
    assert.ok(row.resolvedAt instanceof Date && row.resolvedById === "admin");
    assert.deepEqual([row.reason, row.description, row.requestedById, row.requestedByRole, row.statusAtRequest, row.dealerId], ["OTHER", "Renamed", "so1", Role.SALES_OFFICER, "ACTIVE", "d1"], "reason, description, requester and status-at-request survive resolution");
    assert.equal(JSON.stringify(t.dealers), dealerBefore, "resolving never touches the dealer");
    assert.equal(t.requests.length, 1, "nothing deleted");
    assert.equal(await status(() => service.resolveDealerStatusRequest(ADMIN, "req1", {})), 409, "cannot resolve twice");
    assert.equal((t.requests[0]!.resolvedAt as Date).getTime(), (row.resolvedAt as Date).getTime(), "the first resolution is not overwritten");
    assert.equal((await service.listDealerStatusRequests(ADMIN, "pending")).length, 0);
    const history = await service.listDealerStatusRequests(ADMIN, "resolved");
    assert.deepEqual(history.map((h) => [h.reason, h.description, h.resolvedByName, h.resolutionNotes]), [["OTHER", "Renamed", "Admin", "Renamed in master"]], "resolved history keeps the full record");
    assert.ok(t.audit.some((a) => a.entity === "dealerStatusRequest" && a.action === "UPDATE"), "resolution audited");
  }

  /* ---- editing the dealer (Dealer Alias save flow) never resolves the request ---- */
  {
    const { service, manage, t } = load();
    await service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "INACTIVE" });
    // Opening / cancelling the dialog makes no call at all, so the request is simply untouched.
    assert.equal(t.requests[0]!.status, "PENDING");
    // Failed updates (unknown dealer, officer outside the group, invalid body) → request still PENDING.
    assert.equal(await status(() => manage.editDealer(ADMIN, "missing", { name: "X" })), 404);
    assert.equal(await status(() => manage.editDealer(ADMIN, "d1", { name: "ABC", officerId: "so3", groupId: "g1" })), 422);
    assert.ok(await status(() => manage.editDealer(ADMIN, "d1", { name: "" })) !== 0);
    assert.equal(t.requests[0]!.status, "PENDING", "failed dealer updates do not resolve the request");
    assert.equal(t.dealers[0]!.status, "ACTIVE");
    // A successful Dealer Alias edit changes the dealer, still leaves the request pending until Admin resolves it explicitly.
    assert.equal(await status(() => manage.editDealer(ADMIN, "d1", { name: "ABC Traders", status: "INACTIVE" })), 0);
    assert.equal(t.dealers[0]!.status, "INACTIVE", "Admin made the actual status decision through the existing edit");
    assert.equal(t.requests[0]!.status, "PENDING", "a successful edit alone does not resolve the request");
    assert.equal((await service.listDealerStatusRequests(ADMIN, "pending"))[0]!.currentStatus, "INACTIVE", "the Request tab shows the live status…");
    assert.equal((await service.listDealerStatusRequests(ADMIN, "pending"))[0]!.statusAtRequest, "ACTIVE", "…and the status at request time");
    assert.equal(await status(() => manage.editDealer(SO1, "d1", { name: "Hack", status: "INACTIVE" })), 403, "SO / RM can never edit dealers (request endpoints included)");
    await service.resolveDealerStatusRequest(ADMIN, "req1", {});
    assert.equal(t.requests[0]!.status, "RESOLVED", "only the explicit Resolve action resolves it");
  }

  /* ---- the four choices: each submits and persists; Other carries a reason; stale text is never stored; legacy history stays readable ---- */
  {
    const { service, t } = load();
    const before = JSON.stringify(t.dealers);
    for (const [i, r] of ["INACTIVE", "LEGAL", "PARTY_IN_PLANNING"].entries()) {
      const dealerId = ["d1", "d2", "d3"][i]!; const ctx = dealerId === "d3" ? RM1 : SO1;
      // A reason text left over from "Other" (the user typed it, then switched) must not be saved with another choice.
      const saved = await service.createDealerStatusRequest(ctx, { dealerId, reason: r, description: "stale text from Other" });
      assert.deepEqual([saved.reason, saved.description, saved.status], [r, null, "PENDING"], `${r}: saved with no reason text`);
      assert.equal(t.requests.at(-1)!.reason, r, `${r} persisted as the stable value`);
    }
    const other = await service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER", description: "x" }).catch((e) => e);
    assert.equal(other.status, 409, "d1 already has an open request (one per dealer)");
    t.requests.length = 0; t.dealers.push({ id: "d9", name: "Nine", status: "ACTIVE", owner: "so1", deletedAt: null });
    const withOther = await service.createDealerStatusRequest(SO1, { dealerId: "d9", reason: "OTHER", description: "  Shifted   to cold storage " });
    assert.deepEqual([withOther.reason, withOther.description], ["OTHER", "Shifted to cold storage"], "Other: the (normalised) reason is stored and returned");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER", description: "   " })), 422, "whitespace-only reason rejected");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER", description: "x".repeat(501) })), 422, "500-character limit kept");
    assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "OTHER", description: "x".repeat(500) })), 0, "exactly 500 is allowed");
    for (const legacy of ["DOES_NOT_EXIST", "PARTY_CLOSED"]) assert.equal(await status(() => service.createDealerStatusRequest(SO1, { dealerId: "d2", reason: legacy })), 422, `${legacy} can no longer be submitted`);
    assert.equal(JSON.stringify(t.dealers.filter((d) => d.id !== "d9")), before, "submitting any choice leaves every dealer's status untouched");
    assert.equal(t.dealerWrites, 0);

    // Historical requests (saved before the change) stay readable under their original meaning, pending or resolved — and can still be resolved.
    const h = load();
    h.t.requests.push(
      { id: "old1", dealerId: "d1", statusAtRequest: "ACTIVE", reason: "DOES_NOT_EXIST", description: null, requestedById: "so1", requestedByRole: Role.SALES_OFFICER, status: "PENDING", resolvedById: null, resolvedAt: null, resolutionNotes: null, createdAt: new Date(1000) },
      { id: "old2", dealerId: "d2", statusAtRequest: "ACTIVE", reason: "PARTY_CLOSED", description: "shop shut", requestedById: "so1", requestedByRole: Role.SALES_OFFICER, status: "RESOLVED", resolvedById: "admin", resolvedAt: new Date(2000), resolutionNotes: null, createdAt: new Date(500) },
    );
    const pend = await h.service.listDealerStatusRequests(ADMIN, "pending");
    assert.deepEqual(pend.map((p) => [p.id, p.reason]), [["old1", "DOES_NOT_EXIST"]], "legacy pending request keeps DOES_NOT_EXIST");
    assert.deepEqual((await h.service.listDealerStatusRequests(ADMIN, "resolved")).map((p) => [p.reason, p.description]), [["PARTY_CLOSED", "shop shut"]], "legacy resolved request keeps PARTY_CLOSED and its text");
    assert.equal(await status(() => h.service.resolveDealerStatusRequest(ADMIN, "old1", {})), 0, "a legacy pending request can still be resolved");
    assert.equal(await status(() => h.service.createDealerStatusRequest(SO1, { dealerId: "d1", reason: "LEGAL" })), 0, "…after which a new-style request is allowed");
  }

  /* ---- wiring: routes, tab, dialog reuse ---- */
  {
    const list = readFileSync("src/app/api/territory-mapping/status-requests/route.ts", "utf8");
    const resolveRoute = readFileSync("src/app/api/territory-mapping/status-requests/[id]/resolve/route.ts", "utf8");
    assert.equal((list.match(/requireAuth\(\)/g) ?? []).length, 2, "both handlers authenticate");
    assert.ok(resolveRoute.includes("requireAuth()") && resolveRoute.includes("resolveDealerStatusRequest"));
    const ui = readFileSync("src/features/party-planning/dealer-status-requests.tsx", "utf8");
    assert.ok(ui.includes('import { DealerDialog } from "@/features/sales-upload/create-dealer-dialog"') && ui.includes("<DealerDialog") && ui.includes("edit={editDealer}"), "the Request tab reuses the Dealer Alias edit dialog");
    assert.ok(!/<DealerDialog[^>]*(onCreated|resolve)/.test(ui), "the edit dialog is not wired to resolve anything");
    assert.equal((ui.match(/\/resolve`/g) ?? []).length, 1, "the resolve endpoint is called from exactly one place (the confirmed Resolve action)");
    assert.ok(!ui.includes("PATCH") && !ui.includes("api.patch") && !ui.includes("/api/dealers"), "no second dealer-update path in the Request tab");
    const page = readFileSync("src/features/party-planning/territory-mapping-page.tsx", "utf8");
    const tabs = page.slice(page.indexOf("<UnderlineTabs"), page.indexOf("<UnderlineTabs") + 600);
    assert.ok(tabs.indexOf('key: "add"') < tabs.indexOf('key: "request"') && tabs.includes("isAdmin ?"), "Request tab sits right after Add Market and only shows for Admin");
    assert.ok(readFileSync("src/features/labels/labels.ts", "utf8").includes('"party_planning.territory.tab_request": "Request"'));
    const alias = readFileSync("src/features/sales-upload/alias.server.ts", "utf8");
    assert.ok(alias.includes("assertAdmin(ctx);\n  const [dealers, aliases, assignments]"), "Dealer Alias list is still Admin-only");
    assert.ok(readFileSync("src/features/sales-upload/create-dealer-dialog.tsx", "utf8").includes("api.patch<CreateResult>(`/api/dealers/${edit.id}`"), "the existing edit save flow (PATCH /api/dealers/[id]) is unchanged");
    assert.ok(Object.keys(DEFAULT_LABELS).filter((k) => k.startsWith("party_planning.territory.sr.")).length > 30, "labels are editable through Edit Labels");
  }
  console.log("dealer-status-request.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
