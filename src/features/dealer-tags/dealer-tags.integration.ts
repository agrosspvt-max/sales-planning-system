/** Run only against an isolated local /tmp socket database with the additive migration already applied. */
import assert from "node:assert/strict";
import { PrismaClient, Role, Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "./test-loader";
import type { AuthContext } from "@/lib/http";
const url = process.env.DEALER_TAG_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  new URL(url).searchParams.get("host") !== "/tmp/dealer-tags-pg" ||
  new URL(url).pathname !== "/dealer_tags_test"
)
  throw new Error(
    "DEALER_TAG_TEST_URL must identify the disposable /tmp/dealer-tags-pg/dealer_tags_test database. Application databases are forbidden.",
  );
const prisma = new PrismaClient({
  datasources: { db: { url: `${url}&connection_limit=1` } },
  log: [{ emit: "event", level: "query" }],
});
let assignmentReads = 0;
prisma.$on("query", (e) => {
  if (
    e.query.startsWith("SELECT") &&
    e.query.includes('"DealerTagAssignment"') &&
    !e.query.includes('"Dealer" d')
  )
    assignmentReads++;
});
let failAudit = false,
  failNotification = false;
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": {
    writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient) => {
      if (failAudit) throw new Error("injected audit failure");
      return tx.auditLog.create({ data });
    },
  },
  "@/features/notifications/service.server": {
    getSuperAdminIds: async () =>
      (
        await prisma.user.findMany({
          where: { role: Role.SUPER_ADMIN, isActive: true },
          select: { id: true },
        })
      ).map((u) => u.id),
    notifyMany: async (ids: string[], data: object, tx: Prisma.TransactionClient) => {
      if (failNotification) throw new Error("injected notification failure");
      return tx.notification.createMany({
        data: [...new Set(ids)].map((userId) => ({
          userId,
          ...data,
        })) as Prisma.NotificationCreateManyInput[],
      });
    },
  },
});
const svc = load<typeof import("./service.server")>("src/features/dealer-tags/service.server.ts");
const resolver = load<typeof import("@/lib/dealer-tags.server")>("src/lib/dealer-tags.server.ts");
const page = load<typeof import("@/lib/dealer-page.server")>("src/lib/dealer-page.server.ts");
const ctx = (userId: string, role: Role, groupId: string | null): AuthContext => ({
  userId,
  username: userId,
  role,
  groupId,
});
const admin = ctx("admin", Role.SUPER_ADMIN, null),
  so = ctx("so", Role.SALES_OFFICER, "team"),
  rm = ctx("rm", Role.REGIONAL_MANAGER, "team"),
  other = ctx("other-rm", Role.REGIONAL_MANAGER, "other"),
  solo = ctx("solo", Role.SALES_OFFICER, null);
const denied = (work: Promise<unknown>, status: number) =>
  assert.rejects(work, (e) => e instanceof TestApiError && e.status === status);
const snapshot = async () =>
  JSON.stringify(
    await Promise.all([
      prisma.dealerTagAssignment.findMany({ orderBy: { id: "asc" } }),
      prisma.dealerTagRequest.findMany({ orderBy: { id: "asc" } }),
      prisma.approvalAction.findMany({ orderBy: { id: "asc" } }),
      prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
      prisma.notification.findMany({ orderBy: { id: "asc" } }),
    ]),
  );
async function run() {
  assert.equal(
    await prisma.user.count(),
    0,
    "Use a fresh disposable DB, not any installation containing users.",
  );
  await prisma.userGroup.createMany({
    data: [
      { id: "team", name: "Tag Team" },
      { id: "other", name: "Other Team" },
    ],
  });
  for (const c of [admin, so, rm, other, solo, ctx("other-so", Role.SALES_OFFICER, "other")])
    await prisma.user.create({
      data: {
        id: c.userId,
        username: c.username,
        name: c.userId,
        passwordHash: "test-only",
        role: c.role,
        groupId: c.groupId,
      },
    });
  await prisma.dealer.createMany({
    data: [
      { id: "alpha", name: "Alpha" },
      { id: "zeta", name: "Zeta" },
      { id: "rm-dealer", name: "RM Dealer", isActive: false },
      { id: "solo-dealer", name: "Solo Dealer" },
      { id: "outside", name: "Outside" },
    ],
  });
  for (const [dealerId, officerId] of [
    ["alpha", "so"],
    ["zeta", "so"],
    ["rm-dealer", "rm"],
    ["solo-dealer", "solo"],
    ["outside", "other-so"],
  ])
    await prisma.dealerAssignment.create({
      data: { dealerId, officerId, effectiveFrom: new Date("2026-01-01") },
    });
  await prisma.dealerAlias.create({
    data: { systemDealerId: "zeta", tallyName: "Beta Alias", tallyKey: "beta alias" },
  });
  const ownership = JSON.stringify(await prisma.dealerAssignment.findMany());
  const dealerRows = JSON.stringify(await prisma.dealer.findMany());
  const def = { name: "Focused Product", markerType: "TEXT", marker: "FP", isActive: true };
  const tag = await svc.saveTag(admin, def),
    hp = await svc.saveTag(admin, { ...def, name: "High Potential", marker: "HP" });
  await assert.rejects(
    svc.saveTag(admin, { ...def, name: " FOCUSED PRODUCT " }),
    (e) => (e as Prisma.PrismaClientKnownRequestError).code === "P2002",
  );
  assert.equal((await svc.listTagDealers(so)).length, 2);
  assert.equal((await svc.listTagDealers(rm)).length, 3);
  assert.equal((await svc.listTagDealers(admin)).length, 5);
  await denied(svc.requestTag(so, { dealerId: "outside", tagId: tag.id, operation: "ADD" }), 403);
  const pair = { dealerId: "zeta", tagId: tag.id, operation: "ADD" };
  const request = await svc.requestTag(so, pair);
  assert.equal(request.status, "PENDING_RM");
  assert.equal(Object.keys(await resolver.loadDealerMarkerMap(["zeta"])).length, 0);
  assert((await svc.listTagRequests(rm)).some((r) => r.id === request.id && r.canAct));
  assert(!(await svc.listTagRequests(other)).some((r) => r.id === request.id));
  await denied(svc.decideTagRequest(admin, request.id, { action: "approve" }), 403);
  await denied(svc.decideTagRequest(other, request.id, { action: "approve" }), 403);
  await svc.decideTagRequest(rm, request.id, { action: "approve" });
  assert.equal(Object.keys(await resolver.loadDealerMarkerMap(["zeta"])).length, 0);
  await svc.decideTagRequest(admin, request.id, { action: "approve" });
  assert.equal((await resolver.loadDealerMarkerMap(["zeta"])).zeta[0].marker, "FP");
  const first = await page.listDealerResourcePage({ page: 1, pageSize: 1, search: "" });
  assert.equal(first.items[0].id, "zeta");
  assert.equal(first.total, 5);
  const second = await page.listDealerResourcePage({ page: 2, pageSize: 1, search: "" });
  assert.equal(second.items[0].id, "alpha");
  assert.equal(
    (await page.listDealerResourcePage({ page: 1, pageSize: 10, search: "Zeta" })).items[0].name,
    "Zeta",
  );
  await svc.directTag(admin, { ...pair, tagId: hp.id });
  assert.equal((await resolver.loadDealerMarkerMap(["zeta"])).zeta.length, 2);
  const auditCount = await prisma.auditLog.count();
  await svc.directTag(admin, pair);
  assert.equal(await prisma.auditLog.count(), auditCount);
  assert.equal(
    await prisma.dealerTagAssignment.count({ where: { dealerId: "zeta", tagId: tag.id } }),
    1,
  );
  const revoke = await svc.requestTag(so, { ...pair, operation: "REVOKE" });
  assert.equal((await resolver.loadDealerMarkerMap(["zeta"])).zeta.length, 2);
  await svc.decideTagRequest(rm, revoke.id, { action: "approve" });
  assert.equal((await resolver.loadDealerMarkerMap(["zeta"])).zeta.length, 2);
  await svc.decideTagRequest(admin, revoke.id, { action: "approve" });
  assert.equal((await resolver.loadDealerMarkerMap(["zeta"])).zeta.length, 1);
  await svc.saveTag(
    admin,
    { ...def, name: "High Potential", marker: "HP", isActive: false },
    hp.id,
  );
  assert.equal(Object.keys(await resolver.loadDealerMarkerMap(["zeta"])).length, 0);
  assert.equal(
    (await page.listDealerResourcePage({ page: 1, pageSize: 1, search: "" })).items[0].id,
    "alpha",
  );
  assert.equal(
    await prisma.dealerTagAssignment.count({ where: { tagId: hp.id, isActive: true } }),
    1,
  );
  await svc.saveTag(admin, { ...def, name: "High Potential", marker: "HP" }, hp.id);
  assert.equal((await resolver.loadDealerMarkerMap(["zeta"])).zeta[0].marker, "HP");
  const own = await svc.requestTag(rm, { ...pair, dealerId: "rm-dealer" });
  assert.equal(own.status, "PENDING_ADMIN");
  await denied(svc.decideTagRequest(rm, own.id, { action: "approve" }), 403);
  await svc.decideTagRequest(admin, own.id, { action: "approve" });
  const soloRequest = await svc.requestTag(solo, { ...pair, dealerId: "solo-dealer" });
  assert.equal(soloRequest.status, "PENDING_ADMIN");
  await svc.decideTagRequest(admin, soloRequest.id, {
    action: "reject",
    remarks: "Not applicable",
  });
  const again = await svc.requestTag(solo, { ...pair, dealerId: "solo-dealer" });
  let before = await snapshot();
  failAudit = true;
  await assert.rejects(svc.decideTagRequest(admin, again.id, { action: "approve" }), /injected/);
  failAudit = false;
  assert.equal(await snapshot(), before);
  before = await snapshot();
  failNotification = true;
  await assert.rejects(svc.requestTag(so, { ...pair, dealerId: "alpha" }), /injected/);
  failNotification = false;
  assert.equal(await snapshot(), before);
  await svc.decideTagRequest(admin, again.id, { action: "approve" });
  const race = await Promise.allSettled([
    svc.requestTag(so, { ...pair, dealerId: "alpha" }),
    svc.requestTag(so, { ...pair, dealerId: "alpha" }),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  const alphaRequest = await prisma.dealerTagRequest.findFirstOrThrow({
    where: { dealerId: "alpha", status: "PENDING_RM" },
  });
  // Real partial unique constraint rejects a direct duplicate unresolved request as well.
  await assert.rejects(
    prisma.dealerTagRequest.create({
      data: {
        dealerId: "alpha",
        tagId: tag.id,
        requestedById: "so",
        operation: "REVOKE",
        status: "PENDING_ADMIN",
      },
    }),
    (e) => (e as Prisma.PrismaClientKnownRequestError).code === "P2002",
  );
  await svc.decideTagRequest(rm, alphaRequest.id, { action: "reject", remarks: "Rejected by RM" });
  assignmentReads = 0;
  await resolver.loadDealerMarkerMap(
    Array.from({ length: 1000 }, (_, i) => `id-${i}`).concat("zeta"),
  );
  assert.equal(assignmentReads, 1);
  const scoped = await resolver.loadScopedDealerMarkerMap(so);
  assert(!scoped["rm-dealer"]);
  assert(!scoped["solo-dealer"]);
  assert(scoped.zeta);
  assert.equal(JSON.stringify(await prisma.dealerAssignment.findMany()), ownership);
  assert.equal(JSON.stringify(await prisma.dealer.findMany()), dealerRows);
  assert.equal(await prisma.approvalAction.count({ where: { dealerTagRequestId: request.id } }), 3);
  console.log(
    "Dealer Tag PostgreSQL integration passed: actual migration/constraints, current scope, routing, alias pagination, inactive restoration, concurrency, idempotence, atomic rollback, 1,000-ID batch, ownership unchanged.",
  );
}
run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
