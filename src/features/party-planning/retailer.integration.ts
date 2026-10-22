/** Complete Retailer Mapping flow against a disposable LOCAL database. Never points at the application database. */
import assert from "node:assert/strict";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import { validateRetailerInput, isValidPhone } from "@/lib/retailer";

const url = process.env.RETAILER_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/retailer_test") throw new Error("Only a local retailer_test database is allowed.");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const svc = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data }) },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() },
})<typeof import("./retailer.server")>("src/features/party-planning/retailer.server.ts");
const ctx = (id: string, role: Role, groupId: string | null = "g1", permissions?: Record<string, string[]>) => ({ userId: id, username: id, role, groupId, permissions }) as AuthContext;
const so = ctx("so", Role.SALES_OFFICER), other = ctx("other", Role.SALES_OFFICER, "g2"), rm = ctx("rm", Role.REGIONAL_MANAGER), admin = ctx("admin", Role.SUPER_ADMIN, null);
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const same = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const input = (key: string, dealerIds = ["d1", "d2"]) => ({ retailerName: "  Ram  Kumar ", firmName: " Retail Firm ", phone: "0123456789", dealerIds, submissionKey: key });
async function main() {
  await prisma.$executeRawUnsafe('TRUNCATE "RetailerDealerLink", "RetailerRequestDealer", "Retailer", "RetailerRequest", "DealerAssignment", "Dealer", "AuditLog", "User", "UserGroup" CASCADE');
  await prisma.userGroup.createMany({ data: [{ id: "g1", name: "State One" }, { id: "g2", name: "State Two" }] });
  for (const c of [so, other, rm, admin, ctx("custom", Role.CUSTOM_ADMIN, null)]) await prisma.user.create({ data: { id: c.userId, name: c.userId, username: c.userId, passwordHash: "x", role: c.role, groupId: c.groupId } });
  for (const [id, owner] of [["d1", "so"], ["d2", "so"], ["d3", "other"], ["d4", "rm"]]) { await prisma.dealer.create({ data: { id, name: `Dealer ${id}` } }); await prisma.dealerAssignment.create({ data: { dealerId: id, officerId: owner, effectiveFrom: new Date("2024-01-01") } }); }
  same((await svc.listRetailerDealerChoices(so)).map((d) => d.id), ["d1", "d2"]);
  same((await svc.listRetailerDealerChoices(rm)).map((d) => d.id), ["d4"]); // never the RM's team dealers
  for (const phone of ["123", "12345678901", "+911234567890", "12345abcde", "12345 6789"]) { assert.equal(isValidPhone(phone), false); assert.equal(await code(svc.createRetailerRequest(so, { ...input("bad-phone-"+phone.length), phone })), 422); }
  assert.equal(validateRetailerInput({ ...input("blank-name"), retailerName: "  " }), "name_required");
  assert.equal(await code(svc.createRetailerRequest(so, input("forged-one", ["d1", "d3"]))), 403);
  assert.equal(await prisma.retailerRequest.count(), 0, "one forged dealer refuses the entire request");
  assert.equal(await code(svc.createRetailerRequest(so, { ...input("bad-array"), dealerIds: ["d1", 3] })), 422);
  const r = await svc.createRetailerRequest(so, input("first-submit", ["d1", "d2", "d1"]));
  same([r.retailerName, r.firmName, r.phone, r.status, r.dealers.length], ["Ram Kumar", "Retail Firm", "0123456789", "PENDING", 2]);
  same((await svc.createRetailerRequest(so, input("first-submit"))).id, r.id);
  assert.equal(await code(svc.createRetailerRequest(so, { ...input("first-submit"), firmName: "Different Firm" })), 409);
  assert.equal((await svc.listMyRetailerRequests(other)).length, 0);
  assert.equal(await code(svc.listRetailerRequestsForReview(rm, "pending")), 403);
  assert.equal(await code(svc.listRetailerRequestsForReview(ctx("custom", Role.CUSTOM_ADMIN, null, { partyPlanning: ["read"] }), "pending")), 403);
  assert.equal(await code(svc.listRetailers(ctx("custom", Role.CUSTOM_ADMIN, null))), 403);
  const approver = ctx("custom", Role.CUSTOM_ADMIN, null, { partyPlanning: ["read", "manage"] });
  const race = await Promise.all([admin, approver, admin].map((c, i) => code(svc.decideRetailerRequest(c, r.id, { action: i === 2 ? "reject" : "approve", reason: "Valid rejection reason" }))));
  assert.equal(race.filter((x) => x === 0).length, 1, "exactly one concurrent decision wins");
  // If the rejection won the race, approve a fresh request to exercise the full creation path.
  let approvedRequest = (await svc.listMyRetailerRequests(so))[0]!;
  if (approvedRequest.status !== "APPROVED") approvedRequest = await svc.decideRetailerRequest(admin, (await svc.createRetailerRequest(so, input("approved-fresh"))).id, { action: "approve" });
  assert.equal(await prisma.retailer.count(), 1, "one approved retailer, not one per linked dealer");
  assert.equal(await prisma.retailerDealerLink.count(), 2);
  assert.equal((await svc.listRetailers(so)).length, 1);
  assert.equal((await svc.listRetailers(other)).length, 0);
  // Reassign one linked dealer: the SO sees only their remaining link; the new owner sees only their link; RM cannot see outside-team links.
  await prisma.dealerAssignment.updateMany({ where: { dealerId: "d2", effectiveTo: null }, data: { effectiveTo: new Date() } });
  await prisma.dealerAssignment.create({ data: { dealerId: "d2", officerId: "other", effectiveFrom: new Date() } });
  same((await svc.listRetailers(so))[0]!.dealers.map((d) => d.id), ["d1"]);
  same((await svc.listRetailers(other))[0]!.dealers.map((d) => d.id), ["d2"]);
  same((await svc.listRetailers(rm))[0]!.dealers.map((d) => d.id), ["d1"]);
  assert.equal((await svc.listMyRetailerRequests(so)).find((x) => x.id === approvedRequest.id)!.dealers.length, 2, "request history retains both original links");
  const stale = await svc.createRetailerRequest(so, input("stale-submit", ["d1"]));
  await prisma.dealerAssignment.updateMany({ where: { dealerId: "d1", effectiveTo: null }, data: { effectiveTo: new Date() } });
  await prisma.dealerAssignment.create({ data: { dealerId: "d1", officerId: "other", effectiveFrom: new Date() } });
  assert.equal(await code(svc.decideRetailerRequest(admin, stale.id, { action: "approve" })), 409);
  assert.equal((await prisma.retailerRequest.findUniqueOrThrow({ where: { id: stale.id } })).status, "PENDING");
  assert.equal((await svc.createRetailerRequest(so, input("stale-submit", ["d1"]))).id, stale.id, "retry returns the saved request even after assignment changes");
  assert.equal(await code(svc.decideRetailerRequest(admin, stale.id, { action: "reject", reason: " " })), 422);
  await svc.decideRetailerRequest(admin, stale.id, { action: "reject", reason: "Dealer ownership changed" });
  assert.equal((await svc.listRetailerRequestsForReview(admin, "resolved")).find((x) => x.id === stale.id)!.rejectionReason, "Dealer ownership changed");
  // An audit failure rolls back retailer creation and the approval, preserving the Pending request.
  const rmRequest = await svc.createRetailerRequest(rm, input("rm-rollback", ["d4"]));
  const failing = testLoader({ "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => { throw new Error("audit unavailable"); } }, "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map() } })<typeof import("./retailer.server")>("src/features/party-planning/retailer.server.ts");
  const before = await prisma.retailer.count();
  assert.equal(await code(failing.decideRetailerRequest(admin, rmRequest.id, { action: "approve" })), -1);
  assert.equal(await prisma.retailer.count(), before);
  assert.equal((await prisma.retailerRequest.findUniqueOrThrow({ where: { id: rmRequest.id } })).status, "PENDING");
  await svc.decideRetailerRequest(admin, rmRequest.id, { action: "approve" });
  console.log("retailer.integration.ts — complete request, approval/rejection, permissions, scope, concurrent decisions and rollback passed");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
