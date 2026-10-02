import assert from "node:assert/strict";
import { Role, PlanStatus } from "@prisma/client";
import { taggedDealersFirst, groupDealerSlots, type DealerMarkerMap } from "@/lib/dealer-tags";
import { TestApiError, testLoader } from "./test-loader";
import { navForRole } from "@/features/navigation/nav";
import { can } from "@/lib/rbac";
import type { AuthContext } from "@/lib/http";
const so: AuthContext = { userId: "so", username: "so", role: Role.SALES_OFFICER, groupId: "team" };
const rm: AuthContext = { ...so, userId: "rm", role: Role.REGIONAL_MANAGER };
const admin: AuthContext = { ...so, userId: "admin", role: Role.SUPER_ADMIN };
const outsider: AuthContext = { ...rm, userId: "other-rm", groupId: "other" };
type Tag = {
  id: string;
  name: string;
  nameKey: string;
  markerType: string;
  marker: string;
  isActive: boolean;
};
type Assignment = { id: string; dealerId: string; tagId: string; isActive: boolean };
type Request = {
  id: string;
  dealerId: string;
  tagId: string;
  requestedById: string;
  operation: string;
  status: string;
  createdAt: Date;
};
type Args = { where?: Record<string, any>; data?: any; include?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function harness() {
  let state = {
    tags: [] as Tag[],
    assignments: [] as Assignment[],
    requests: [] as Request[],
    actions: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    notices: [] as Record<string, unknown>[],
  };
  let fail: "audit" | "notification" | undefined;
  let sequence = 0;
  let tail = Promise.resolve();
  let manager: string | null = "rm";
  const owners = new Map([
    ["dealer", "so"],
    ["rm-dealer", "rm"],
    ["other-dealer", "other-so"],
  ]);
  function client(s: typeof state) {
    const assignment = (w: Args["where"]) =>
      s.assignments.find(
        (a) => a.dealerId === w?.dealerId_tagId.dealerId && a.tagId === w?.dealerId_tagId.tagId,
      );
    return {
      $queryRaw: async () => [],
      dealer: {
        findUnique: async ({ where }: Args) =>
          owners.has(where!.id) ? { id: where!.id, deletedAt: null } : null,
      },
      dealerTag: {
        findUnique: async ({ where }: Args) => s.tags.find((t) => t.id === where!.id) ?? null,
        findMany: async () => s.tags,
        create: async ({ data }: Args) => {
          if (s.tags.some((t) => t.nameKey === data.nameKey)) throw new Error("unique nameKey");
          const t = { id: `tag-${++sequence}`, ...data };
          s.tags.push(t);
          return t;
        },
        update: async ({ where, data }: Args) => {
          const t = s.tags.find((t) => t.id === where!.id)!;
          Object.assign(t, data);
          return t;
        },
      },
      dealerTagAssignment: {
        findUnique: async ({ where }: Args) => assignment(where) ?? null,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: Args["where"];
          create: Assignment;
          update: Partial<Assignment>;
        }) => {
          let a = assignment(where);
          if (a) Object.assign(a, update);
          else {
            a = { ...create, id: `assign-${++sequence}` };
            s.assignments.push(a);
          }
          return a;
        },
      },
      dealerTagRequest: {
        findFirst: async ({ where }: Args) =>
          s.requests.find(
            (r) =>
              r.dealerId === where!.dealerId &&
              r.tagId === where!.tagId &&
              where!.status.in.includes(r.status),
          ) ?? null,
        findUnique: async ({ where }: Args) => s.requests.find((r) => r.id === where!.id) ?? null,
        findUniqueOrThrow: async ({ where }: Args) => s.requests.find((r) => r.id === where!.id)!,
        create: async ({ data }: Args) => {
          const r = { id: `request-${++sequence}`, createdAt: new Date(), ...data };
          s.requests.push(r);
          return r;
        },
        update: async ({ where, data }: Args) =>
          Object.assign(s.requests.find((r) => r.id === where!.id)!, data),
      },
      approvalAction: {
        create: async ({ data }: Args) => {
          const row = { id: `approval-${++sequence}`, ...data };
          s.actions.push(row);
          return row;
        },
      },
      auditLog: {
        create: async ({ data }: Args) => {
          if (fail === "audit") throw new Error("audit failed");
          s.audits.push(data);
        },
      },
      notification: {
        createMany: async ({ data }: Args) => {
          if (fail === "notification") throw new Error("notification failed");
          s.notices.push(...data);
        },
      },
    };
  }
  const prisma = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "$transaction"
          ? async (work: (tx: unknown) => Promise<unknown>) => {
              let release!: () => void;
              const previous = tail;
              tail = new Promise<void>((r) => {
                release = r;
              });
              await previous;
              const draft = structuredClone(state);
              try {
                const result = await work(client(draft));
                state = draft;
                return result;
              } finally {
                release();
              }
            }
          : client(state)[key as keyof ReturnType<typeof client>],
    },
  );
  const load = testLoader({
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError: TestApiError },
    "@/lib/scope": {
      getOfficerScope: async (ctx: AuthContext) => ({
        all: ctx.role === Role.SUPER_ADMIN,
        ids:
          ctx.role === Role.REGIONAL_MANAGER
            ? ctx.userId === "rm"
              ? ["rm", "so"]
              : ["other-rm", "other-so"]
            : [ctx.userId],
      }),
      getCurrentOwnerByDealer: async () => owners,
      getCurrentManagerId: async () => manager,
    },
    "@/features/notifications/service.server": {
      getSuperAdminIds: async () => ["admin"],
      notifyMany: async (ids: string[], input: object, tx: ReturnType<typeof client>) =>
        tx.notification.createMany({ data: ids.map((userId) => ({ userId, ...input })) }),
    },
  });
  return {
    svc: load<typeof import("./service.server")>("src/features/dealer-tags/service.server.ts"),
    state: () => state,
    fail: (v: typeof fail) => {
      fail = v;
    },
    manager: (v: string | null) => {
      manager = v;
    },
  };
}
const def = { name: "Focused Product", markerType: "TEXT", marker: "FP", isActive: true };
const denied = (work: Promise<unknown>, status: number) =>
  assert.rejects(work, (e) => e instanceof TestApiError && e.status === status);
async function run() {
  for (const role of [Role.SALES_OFFICER, Role.REGIONAL_MANAGER, Role.SUPER_ADMIN]) {
    assert(navForRole(role).some((n) => n.href === "/dealer-tags"));
    assert.equal(
      navForRole(role).some((n) => n.href === "/masters/dealer-tags"),
      role === Role.SUPER_ADMIN,
    );
    assert.equal(can(role, "dealerTags", "update"), role === Role.SUPER_ADMIN);
  }
  const h = harness(),
    svc = h.svc;
  await denied(svc.saveTag(so, def), 403);
  await denied(svc.saveTag(rm, def), 403);
  for (const value of [
    { ...def, name: " " },
    { ...def, marker: "bad marker" },
    { ...def, marker: "TOOLONGTEXT" },
    { ...def, markerType: "SYMBOL", marker: "word" },
  ])
    await assert.rejects(svc.saveTag(admin, value));
  const tag = await svc.saveTag(admin, def);
  const star = await svc.saveTag(admin, {
    ...def,
    name: "Priority",
    markerType: "SYMBOL",
    marker: "⭐",
  });
  assert.equal((await svc.listTags()).length, 2);
  await assert.rejects(svc.saveTag(admin, { ...def, name: " focused product " }), /unique/);
  assert.equal(h.state().audits.length, 2);
  const pair = { dealerId: "dealer", tagId: tag.id, operation: "ADD" };
  await denied(svc.requestTag(so, { ...pair, dealerId: "other-dealer" }), 403);
  await denied(svc.requestTag(admin, pair), 403);
  await denied(svc.directTag(so, pair), 403);
  await denied(svc.directTag(rm, pair), 403);
  const request = await svc.requestTag(so, pair);
  assert.equal(request.status, PlanStatus.PENDING_RM);
  assert.equal(h.state().assignments.length, 0);
  await denied(svc.requestTag(so, pair), 409);
  await denied(svc.decideTagRequest(outsider, request.id, { action: "approve" }), 403);
  await denied(svc.decideTagRequest(admin, request.id, { action: "approve" }), 403);
  await denied(svc.decideTagRequest(so, request.id, { action: "approve" }), 403);
  await svc.decideTagRequest(rm, request.id, { action: "approve" });
  assert.equal(h.state().requests[0].status, "PENDING_ADMIN");
  assert.equal(h.state().assignments.length, 0);
  await svc.decideTagRequest(admin, request.id, { action: "approve" });
  assert.equal(h.state().assignments[0].isActive, true);
  await denied(svc.decideTagRequest(admin, request.id, { action: "approve" }), 409);
  assert.equal(h.state().actions.length, 3);
  assert.equal(h.state().notices[0].userId, "rm");
  assert.equal(h.state().notices[1].userId, "admin");
  const revoke = { ...pair, operation: "REVOKE" };
  const rev = await svc.requestTag(so, revoke);
  assert.equal(h.state().assignments[0].isActive, true);
  await svc.decideTagRequest(rm, rev.id, { action: "approve" });
  assert.equal(h.state().assignments[0].isActive, true);
  await svc.decideTagRequest(admin, rev.id, { action: "approve" });
  assert.equal(h.state().assignments[0].isActive, false);
  const before = h.state().audits.length;
  assert.equal((await svc.directTag(admin, pair)).changed, true);
  assert.equal((await svc.directTag(admin, pair)).changed, false);
  assert.equal(h.state().audits.length, before + 1);
  assert.equal(h.state().audits.at(-1)!.entityId, h.state().assignments[0].id);
  await svc.directTag(admin, { ...pair, tagId: star.id });
  assert.equal(h.state().assignments.filter((a) => a.isActive).length, 2);
  await svc.saveTag(admin, { ...def, isActive: false }, tag.id);
  assert.equal(h.state().assignments[0].isActive, true);
  await denied(svc.directTag(admin, pair), 422);
  await svc.directTag(admin, revoke);
  await denied(svc.requestTag(so, pair), 422);
  await svc.saveTag(admin, def, tag.id);
  h.manager(null);
  const noRm = await svc.requestTag(so, pair);
  assert.equal(noRm.status, "PENDING_ADMIN");
  await denied(svc.decideTagRequest(rm, noRm.id, { action: "approve" }), 403);
  await denied(svc.decideTagRequest(admin, noRm.id, { action: "reject", remarks: " " }), 422);
  await svc.decideTagRequest(admin, noRm.id, { action: "reject", remarks: "Not applicable" });
  assert.equal(h.state().assignments[0].isActive, false);
  const own = await svc.requestTag(rm, { ...pair, dealerId: "rm-dealer" });
  assert.equal(own.status, "PENDING_ADMIN");
  await denied(svc.decideTagRequest(rm, own.id, { action: "approve" }), 403);
  await svc.decideTagRequest(admin, own.id, { action: "approve" });
  // Re-request preserves rejected history; injected audit/notification failures roll back every write.
  h.fail("notification");
  const snapshot = JSON.stringify(h.state());
  await assert.rejects(svc.requestTag(so, pair), /notification/);
  assert.equal(JSON.stringify(h.state()), snapshot);
  h.fail(undefined);
  const again = await svc.requestTag(so, pair);
  h.fail("audit");
  const beforeFinal = JSON.stringify(h.state());
  await assert.rejects(svc.decideTagRequest(admin, again.id, { action: "approve" }), /audit/);
  assert.equal(JSON.stringify(h.state()), beforeFinal);
  h.fail(undefined);
  await svc.decideTagRequest(admin, again.id, { action: "approve" });
  const c = harness();
  const t = await c.svc.saveTag(admin, def);
  const race = await Promise.allSettled([
    c.svc.requestTag(so, { ...pair, tagId: t.id }),
    c.svc.requestTag(so, { ...pair, tagId: t.id }),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(c.state().requests.length, 1);
  assert.equal(c.state().audits.length, 2);

  const tags: DealerMarkerMap = {
    B: [{ id: "t", name: "Focus", markerType: "TEXT", marker: "FP" }],
    D: [{ id: "t2", name: "Priority", markerType: "SYMBOL", marker: "⭐" }],
  };
  assert.deepEqual(
    taggedDealersFirst(["A", "B", "C", "D"], (id) => id, tags),
    ["B", "D", "A", "C"],
  );
  assert.deepEqual(
    taggedDealersFirst(["D", "C", "B", "A"], (id) => id, tags),
    ["D", "B", "C", "A"],
  ); // business rank/request date/user-selected descending unchanged within group
  const slots = [
    { summary: true },
    { id: "A", amount: 10 },
    { id: "B", amount: 7 },
    { note: true },
    { id: "C", amount: 4 },
    { id: "D", amount: 2 },
    { total: 23 },
  ];
  assert.deepEqual(
    groupDealerSlots(slots, (r) => r.id, tags),
    [slots[0], slots[2], slots[5], slots[3], slots[1], slots[4], slots[6]],
  );
  assert.deepEqual(slots.map((r) => r.amount).filter(Boolean), [10, 7, 4, 2]);
  let calls = 0;
  const resolver = testLoader({
    "@/lib/prisma": {
      prisma: {
        dealerTagAssignment: {
          findMany: async (args: Args) => {
            calls++;
            assert.equal(args.where!.tag.isActive, true);
            assert.equal(args.where!.isActive, true);
            return [
              { dealerId: "B", tag: tags.B[0] },
              { dealerId: "B", tag: tags.D[0] },
            ];
          },
        },
      },
    },
  })("src/lib/dealer-tags.server.ts") as typeof import("@/lib/dealer-tags.server");
  assert.equal(
    (await resolver.loadDealerMarkerMap(Array.from({ length: 1000 }, (_, i) => `${i}`))).B.length,
    2,
  );
  assert.equal(calls, 1);
  assert.equal(Object.keys(await resolver.loadDealerMarkerMap([])).length, 0);
  assert.equal(calls, 1);
  console.log(
    "Dealer Tag tests passed: master, scoped routing, approvals, revoke, retries, rollback, stable ordering and batched resolution.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
