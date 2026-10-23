/**
 * Seasonal Create New Plan = unfinished work. Create-or-resume, list membership (`counts.create`), submission, deletion and closed seasons, on a REAL disposable PostgreSQL database.
 *
 *   createdb seasonal_market_test && DATABASE_URL=postgresql://localhost:5432/seasonal_market_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   SEASONAL_MARKET_TEST_URL=postgresql://localhost:5432/seasonal_market_test npm run test:seasonal-create:db
 */
import assert from "node:assert/strict";
import { PrismaClient, Role, type Prisma } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const url = process.env.SEASONAL_MARKET_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/seasonal_market_test")
  throw new Error("Only a local database named seasonal_market_test is permitted (set SEASONAL_MARKET_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url } } });
const load = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (data: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data }) },
});
const svc = load("src/features/party-planning/seasonal.server.ts") as typeof import("./seasonal.server");
const ctx = (userId: string, role: Role, groupId: string | null) => ({ userId, role, username: userId, groupId, designation: null }) as unknown as AuthContext;
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
/** What the Create New Plan list shows (the page's rule): open season with at least one editable entry. */
const createList = async (c: AuthContext) => (await svc.listSeasonalSheets(c)).filter((s) => s.seasonOpen && s.counts.create > 0).map((s) => s.id);

async function main() {
  await prisma.$executeRawUnsafe(`TRUNCATE "SeasonalPlan","SeasonalPlanSheet","DealerMarketMapping","DealerAssignment","Dealer","Market","MarketRequest","AuditLog","Season","User","UserGroup" CASCADE`);
  const g = await prisma.userGroup.create({ data: { name: "State A" } });
  const mk = (u: string, role: Role) => prisma.user.create({ data: { passwordHash: "x", name: u, username: u, role, groupId: g.id } });
  const so1 = await mk("so1", Role.SALES_OFFICER), so2 = await mk("so2", Role.SALES_OFFICER), admin = await mk("admin", Role.SUPER_ADMIN);
  const A = ctx(so1.id, Role.SALES_OFFICER, g.id), B = ctx(so2.id, Role.SALES_OFFICER, g.id), ADMIN = ctx(admin.id, Role.SUPER_ADMIN, null);
  const open = await prisma.season.create({ data: { name: "Kharif", year: 2026, status: "OPEN" } });
  const closed = await prisma.season.create({ data: { name: "Rabi", year: 2025, status: "CLOSED" } });
  const markets = await Promise.all(["M1", "M2", "M3", "M4"].map((n) => prisma.market.create({ data: { name: n, nameKey: n.toLowerCase() } })));
  const entry = (sheetId: string, i: number, approvalStatus: string, ownerId = so1.id) => prisma.seasonalPlan.create({ data: { sheetId, seasonId: open.id, ownerId, marketId: markets[i]!.id, approvalStatus } });

  // 1. No drafts: nothing in Create. Create returns a sheet id to open at once; an empty editor does not put the season in the list.
  assert.deepEqual(await createList(A), [], "no drafts → empty Create list");
  const first = await svc.createSeasonalSheet(A, { seasonId: open.id });
  assert.ok(first.id && first.counts.create === 0);
  assert.deepEqual(await createList(A), [], "an empty editor (cancelled / left without saving) never shows an empty season row");
  assert.equal((await svc.getSeasonalSheet(A, first.id, "", "create")).plans.length, 0, "blank editor opens");

  // 2. Resume, never duplicate or reject; repeated and concurrent creation converge on one sheet.
  const again = await svc.createSeasonalSheet(A, { seasonId: open.id });
  assert.equal(again.id, first.id, "the existing sheet is resumed");
  const racers = await Promise.all(Array.from({ length: 8 }, () => svc.createSeasonalSheet(A, { seasonId: open.id }).then((s) => s.id, () => "failed")));
  assert.ok(racers.every((id) => id === first.id), `concurrent creation converges: ${racers.join()}`);
  assert.equal(await prisma.seasonalPlanSheet.count({ where: { ownerId: so1.id, seasonId: open.id } }), 1, "one logical sheet per owner and season");
  const fresh = await Promise.all([svc.createSeasonalSheet(B, { seasonId: open.id }), svc.createSeasonalSheet(B, { seasonId: open.id }), svc.createSeasonalSheet(B, { seasonId: open.id })]);
  assert.equal(new Set(fresh.map((s) => s.id)).size, 1, "concurrent FIRST creation produces exactly one sheet");
  assert.equal(await prisma.auditLog.count({ where: { entity: "seasonalPlanSheet", action: "CREATE" } }), 2, "one audit row per real creation (two owners)");
  assert.equal(fresh[0]!.ownerId, so2.id);

  // 3. Saved drafts appear in Create (reopen shows them); rejected entries awaiting correction stay editable and keep the season listed.
  await entry(first.id, 0, "DRAFT"); const rejected = await entry(first.id, 1, "REJECTED");
  assert.deepEqual(await createList(A), [first.id]);
  const detail = await svc.getSeasonalSheet(A, first.id, "", "create");
  assert.equal(detail.plans.length, 2, "the editor lists only editable entries");
  assert.ok(detail.sheet.counts.create === 2);
  // 4. Partial submission keeps the season in Create while editable entries remain; submitted entries stay under Submitted.
  await prisma.seasonalPlan.update({ where: { id: rejected.id }, data: { approvalStatus: "PENDING_RM" } });
  assert.deepEqual(await createList(A), [first.id], "partial submission: still editable work");
  assert.equal((await svc.getSeasonalSheet(A, first.id, "", "submitted")).plans.length, 1);
  // 5. Delete the last editable entry → hidden from Create (sheet and the submitted entry are kept).
  const draft = (await prisma.seasonalPlan.findFirst({ where: { sheetId: first.id, approvalStatus: "DRAFT" } }))!;
  await svc.deleteSeasonalPlan(A, draft.id);
  assert.deepEqual(await createList(A), [], "deleting the last editable entry hides the season");
  assert.ok(await prisma.seasonalPlanSheet.findUnique({ where: { id: first.id } }), "the sheet itself is never deleted");
  const listed = (await svc.listSeasonalSheets(A)).find((s) => s.id === first.id)!;
  assert.equal(listed.counts.submitted, 1, "…and it remains under View Plans → Submitted");

  // 6. Submit all (existing route) removes the season from Create; creating again for the same season resumes it with a blank create-stage editor.
  await entry(first.id, 2, "DRAFT"); await entry(first.id, 3, "REJECTED");
  assert.deepEqual(await createList(A), [first.id]);
  const sub = await svc.submitSeasonalSheet(A, first.id);
  assert.equal(sub.submitted, 2);
  assert.deepEqual(await createList(A), [], "after Submit All the season leaves Create");
  assert.equal((await svc.listSeasonalSheets(A)).find((s) => s.id === first.id)!.counts.submitted, 3);
  const resumed = await svc.createSeasonalSheet(A, { seasonId: open.id });
  assert.equal(resumed.id, first.id);
  assert.equal((await svc.getSeasonalSheet(A, resumed.id, "", "create")).plans.length, 0, "earlier submitted entries are kept; the create-stage editor is blank");
  assert.equal(await prisma.seasonalPlan.count({ where: { sheetId: first.id } }), 3, "nothing was deleted");
  assert.equal(await code(svc.submitSeasonalSheet(A, first.id)), 409, "nothing new to submit");

  // 7. Ownership and closed seasons.
  assert.equal(await code(svc.getSeasonalSheet(B, first.id, "", "create")), 404, "another owner's sheet is not reachable");
  assert.equal(await code(svc.createSeasonalSheet(A, { seasonId: closed.id })), 409, "closed season: no new sheet");
  assert.equal(await code(svc.createSeasonalSheet(A, { seasonId: "nope" })), 422);
  const closedSheet = await prisma.seasonalPlanSheet.create({ data: { seasonId: closed.id, ownerId: so1.id } });
  await prisma.seasonalPlan.create({ data: { sheetId: closedSheet.id, seasonId: closed.id, ownerId: so1.id, marketId: markets[0]!.id, approvalStatus: "DRAFT" } });
  assert.deepEqual(await createList(A), [], "a closed season's draft never appears in Create (it is under Older Plans)");
  assert.equal(await code(svc.createSeasonalSheet(ADMIN, { seasonId: closed.id })), 409);
  console.log("seasonal-create-resume.integration.ts — all scenarios passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
