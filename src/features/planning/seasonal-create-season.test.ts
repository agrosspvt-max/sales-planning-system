/**
 * Create Seasonal Plan — the Seasons master is authoritative.
 *   npx tsx src/features/planning/seasonal-create-season.test.ts
 * Runs the REAL planning + seasons services over a DB-free fake Prisma that counts every Season write.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Role } from "@prisma/client";
import type { AuthContext } from "@/lib/http";
import { TestApiError, testLoader } from "@/features/dealer-tags/test-loader";
import { createSeasonalPlanSchema } from "@/lib/validations/planning";

const mo = (name: string, order: number, m: number, y: number) => ({ id: `${name}${y}`, name, order, calendarMonth: m, calendarYear: y });
interface Season { id: string; name: string; year: number; status: "OPEN" | "CLOSED"; startMonth: number | null; startYear: number | null; endMonth: number | null; endYear: number | null; months: ReturnType<typeof mo>[] }
const seasons: Season[] = [
  { id: "kharif-open", name: "Kharif", year: 2026, status: "OPEN", startMonth: 4, startYear: 2026, endMonth: 11, endYear: 2026,
    months: [["April", 4], ["May", 5], ["June", 6], ["July", 7], ["August", 8], ["September", 9], ["October", 10], ["November", 11]].map(([n, m], i) => mo(n as string, i + 1, m as number, 2026)) },
  { id: "rabi-cross", name: "Rabi", year: 2026, status: "OPEN", startMonth: 11, startYear: 2026, endMonth: 3, endYear: 2027,
    months: [mo("November", 1, 11, 2026), mo("December", 2, 12, 2026), mo("January", 3, 1, 2027), mo("February", 4, 2, 2027), mo("March", 5, 3, 2027)] },
  { id: "kharif-2027", name: "Kharif", year: 2027, status: "OPEN", startMonth: 6, startYear: 2027, endMonth: 10, endYear: 2027, months: [mo("June", 1, 6, 2027)] },
  { id: "closed-KHARIF", name: "KHARIF", year: 2026, status: "CLOSED", startMonth: 6, startYear: 2026, endMonth: 11, endYear: 2026, months: [mo("June", 1, 6, 2026)] },
  { id: "closed-rabi", name: "Rabi", year: 2025, status: "CLOSED", startMonth: 11, startYear: 2025, endMonth: 3, endYear: 2026, months: [mo("November", 1, 11, 2025)] },
  { id: "closed-season", name: "Season", year: 2026, status: "CLOSED", startMonth: 1, startYear: 2026, endMonth: 3, endYear: 2026, months: [mo("January", 1, 1, 2026)] },
  { id: "closed-zaid", name: "Zaid", year: 2026, status: "CLOSED", startMonth: 3, startYear: 2026, endMonth: 6, endYear: 2026, months: [mo("March", 1, 3, 2026)] },
];
interface Plan { id: string; seasonId: string; officerId: string; planningType: string; version: number; status: string; lifecycleState: string; isActiveVersion: boolean }
let plans: Plan[] = [];
let writes: string[] = [];
const seasonWrite = (op: string) => async () => { writes.push(op); throw new Error(`Season write attempted: ${op}`); };
const prisma = {
  season: {
    findMany: async ({ where }: { where: { status?: string } }) => seasons.filter((s) => !where.status || s.status === where.status).map((s) => ({ ...s, _count: { plans: 0 } })),
    findUnique: async ({ where }: { where: { id: string } }) => seasons.find((s) => s.id === where.id) ?? null,
    create: seasonWrite("create"), upsert: seasonWrite("upsert"), update: seasonWrite("update"), delete: seasonWrite("delete"), updateMany: seasonWrite("updateMany"),
  },
  seasonMonth: { create: seasonWrite("month.create"), update: seasonWrite("month.update"), deleteMany: seasonWrite("month.deleteMany") },
  auditLog: { findMany: async () => [] },
  user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, isActive: true, role: where.id.startsWith("rm") ? Role.REGIONAL_MANAGER : Role.SALES_OFFICER }), findMany: async () => [] },
  seasonPlan: {
    findMany: async ({ where }: { where: { seasonId: string; officerId: string; planningType: string } }) =>
      plans.filter((p) => p.seasonId === where.seasonId && p.officerId === where.officerId && p.planningType === where.planningType).sort((a, b) => b.version - a.version),
    create: async ({ data }: { data: { seasonId: string; officerId: string; planningType: string; version: number } }) => {
      const p: Plan = { id: `plan-${plans.length + 1}`, seasonId: data.seasonId, officerId: data.officerId, planningType: data.planningType, version: data.version, status: "DRAFT", lifecycleState: "ACTIVE", isActiveVersion: false };
      plans.push(p); return p;
    },
  },
  dealer: { findMany: async () => [] }, packSize: { findMany: async () => [] },
};
const noop = async () => ({});
const stubs = (names: string[]) => Object.fromEntries(names.map((n) => [n, noop]));
const load = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: noop },
  "@/lib/scope": { getCurrentDealerIds: async () => [], assertOfficerInScope: noop, getCurrentManagerId: noop, getOfficerScope: noop, isPlanOwner: () => true },
  "@/features/notifications/service.server": stubs(["createNotification", "notifyMany", "getSuperAdminIds"]),
  "@/features/users/catalogue.server": { planningProductsForOfficer: async () => [], clearanceMapForGroup: async () => new Map() },
  "@/features/products/merge.server": stubs(["loadEffectiveProduct"]),
  "@/lib/dealer-display-name.server": stubs(["loadDealerAliasNameMap"]),
  "@/lib/planning-config": { getPlanningConfig: async () => ({ seasonalMode: "PACK_SIZE", monthlyMode: "PACK_SIZE" }) },
  "./lifecycle.server": { assertLifecycleEditable: () => {}, officerVisibilityWhere: () => ({}), isHiddenFromOfficer: () => false, isHiddenByArchivedParent: () => false },
});
const svc = load<typeof import("./service.server")>("src/features/planning/service.server.ts");
const ctx = (userId: string, role: Role): AuthContext => ({ userId, role, username: userId, groupId: "g1" }) as AuthContext;
const SO = ctx("so-1", Role.SALES_OFFICER), RM = ctx("rm-1", Role.REGIONAL_MANAGER), ADMIN = ctx("admin", Role.SUPER_ADMIN);
const reset = () => { plans = []; writes = []; for (const s of seasons) s.status = s.id.startsWith("closed") ? "CLOSED" : "OPEN"; };
const rejects = async (p: Promise<unknown>, status: number) => { try { await p; } catch (e) { assert.equal((e as TestApiError).status, status, (e as Error).message); return (e as Error).message; } assert.fail("expected rejection"); };

let n = 0; const ok = (m: string) => { n++; console.log(`  ok - ${m}`); };
async function main() {
  // 1. Only OPEN seasons, exact configured period and ordered months; same-name seasons stay distinct by id.
  reset();
  const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const opts = plain(await svc.listOpenSeasonOptions());
  assert.deepEqual(opts.map((o) => o.id).sort(), ["kharif-2027", "kharif-open", "rabi-cross"]);
  for (const closed of ["closed-KHARIF", "closed-rabi", "closed-season", "closed-zaid"]) assert.ok(!opts.some((o) => o.id === closed));
  const kharif = opts.find((o) => o.id === "kharif-open")!;
  assert.deepEqual(kharif.period, { startMonth: 4, startYear: 2026, endMonth: 11, endYear: 2026 });
  assert.deepEqual(kharif.months, ["April", "May", "June", "July", "August", "September", "October", "November"]);
  const rabi = opts.find((o) => o.id === "rabi-cross")!;
  assert.deepEqual(rabi.period, { startMonth: 11, startYear: 2026, endMonth: 3, endYear: 2027 });
  assert.deepEqual(rabi.months, ["November", "December", "January", "February", "March"]);
  assert.equal(opts.filter((o) => o.name === "Kharif").length, 2);
  ok("only OPEN seasons are offered, with the exact period / ordered months (incl. a cross-year season)");

  // 2. SO and RM create an own plan inside the chosen season, by id.
  for (const c of [SO, RM]) {
    reset();
    const { ids } = await svc.createSeasonalPlans(c, { seasonId: "rabi-cross" });
    assert.equal(ids.length, 1);
    assert.equal(plans[0].seasonId, "rabi-cross"); assert.equal(plans[0].officerId, c.userId);
    assert.deepEqual(writes, []);
  }
  ok("SO and RM plans are created for the selected season id and write no Season data");

  // 3. Closed / unknown ids are rejected; nothing is created.
  reset();
  assert.match(await rejects(svc.createSeasonalPlans(SO, { seasonId: "closed-KHARIF" }), 422), /closed/i);
  await rejects(svc.createSeasonalPlans(RM, { seasonId: "closed-zaid" }), 422);
  await rejects(svc.createSeasonalPlans(SO, { seasonId: "no-such-season" }), 404);
  assert.equal(plans.length, 0); assert.deepEqual(writes, []);
  ok("closed and invalid season ids are rejected without creating anything");

  // 4. Closing the season after the popup opened blocks creation.
  reset();
  assert.ok((await svc.listOpenSeasonOptions()).some((o) => o.id === "kharif-open")); // popup opened: season listed
  seasons.find((s) => s.id === "kharif-open")!.status = "CLOSED"; // admin closes it
  await rejects(svc.createSeasonalPlans(SO, { seasonId: "kharif-open" }), 422);
  assert.equal(plans.length, 0);
  assert.ok(!(await svc.listOpenSeasonOptions()).some((o) => o.id === "kharif-open"));
  ok("a season closed while the popup is open prevents creation (and leaves the list)");

  // 5. Client-supplied year / period are never trusted: SO/RM cannot send a descriptor.
  reset();
  for (const c of [SO, RM]) await rejects(svc.createSeasonalPlans(c, { season: { name: "Kharif", year: 2030, startMonth: 1, endMonth: 12 } }), 403);
  await rejects(svc.createSeasonalPlans(SO, {}), 403);
  assert.equal(plans.length, 0); assert.deepEqual(writes, []);
  const parsed = createSeasonalPlanSchema.safeParse({ officerScope: "all" });
  assert.equal(parsed.success, false);
  assert.equal(createSeasonalPlanSchema.safeParse({ seasonId: "kharif-open", season: { name: "x", year: 2030, startMonth: 1, endMonth: 2 } }).success, true); // extra descriptor parses but is ignored for SO/RM (above)
  ok("SO/RM cannot create or define a season through planning; the schema needs a season id or admin descriptor");

  // 5b. a descriptor accompanying an id is ignored: the id's season wins.
  reset();
  await svc.createSeasonalPlans(SO, { seasonId: "kharif-open", season: { name: "Zaid", year: 2031, startMonth: 1, endMonth: 2 } });
  assert.equal(plans[0].seasonId, "kharif-open"); assert.deepEqual(writes, []);
  ok("a client-supplied descriptor never overrides the selected season");

  // 6. Existing drafts are reopened, never duplicated; pending/approved plans are returned as before.
  reset();
  plans.push({ id: "draft-1", seasonId: "kharif-open", officerId: "so-1", planningType: "SEASONAL", version: 1, status: "DRAFT", lifecycleState: "ACTIVE", isActiveVersion: false });
  const again = await svc.createSeasonalPlans(SO, { seasonId: "kharif-open" });
  assert.deepEqual([...again.ids], ["draft-1"]); assert.equal(plans.length, 1);
  await svc.createSeasonalPlans(SO, { seasonId: "kharif-open" }); assert.equal(plans.length, 1);
  plans[0].status = "PENDING_RM"; assert.deepEqual([...(await svc.createSeasonalPlans(SO, { seasonId: "kharif-open" })).ids], ["draft-1"]);
  plans[0].status = "APPROVED"; plans[0].isActiveVersion = true; assert.deepEqual([...(await svc.createSeasonalPlans(SO, { seasonId: "kharif-open" })).ids], ["draft-1"]);
  assert.equal(plans.length, 1);
  // The same season name in another year is a different plan.
  const other = await svc.createSeasonalPlans(SO, { seasonId: "kharif-2027" });
  assert.notDeepEqual([...other.ids], ["draft-1"]); assert.equal(plans.length, 2); assert.equal(plans[1].seasonId, "kharif-2027");
  ok("existing drafts are reused (no duplicates), pending/approved keep their rules, same-name seasons resolve by id");

  // 7. A closed season's existing draft cannot be reopened through Create; history stays readable (no deletion/relink).
  reset();
  plans.push({ id: "old", seasonId: "closed-rabi", officerId: "so-1", planningType: "SEASONAL", version: 1, status: "APPROVED", lifecycleState: "ACTIVE", isActiveVersion: true });
  await rejects(svc.createSeasonalPlans(SO, { seasonId: "closed-rabi" }), 422);
  await rejects(svc.createSalesPlan(SO, { seasonId: "closed-rabi", planningType: "SEASONAL" }), 422); // legacy typed payload too
  assert.equal(plans.length, 1); assert.equal(plans[0].seasonId, "closed-rabi");
  ok("closed-season plans are untouched and cannot be re-entered through Create");

  // 8. Administrators: season-id path enforces OPEN; the legacy descriptor path is unchanged (not available to SO/RM).
  reset();
  await rejects(svc.createSeasonalPlans(ADMIN, { seasonId: "closed-zaid", officerIds: ["so-1"] }), 422);
  const a = await svc.createSeasonalPlans(ADMIN, { seasonId: "kharif-open", officerIds: ["so-1"] });
  assert.equal(a.ids.length, 1);
  await rejects(svc.createSeasonalPlans(ADMIN, { seasonId: "kharif-open" }), 422); // officer still required
  ok("admin keeps officer selection; closed seasons are refused for admin creation too");

  // 9. UI + route source rules.
  const ui = readFileSync("src/features/planning/sales-planning.tsx", "utf8");
  assert.ok(!/SEASON_NAMES|MONTH_OPTIONS|setStartMonth|setEndMonth|setYear/.test(ui), "no hard-coded season names or editable period state");
  assert.ok(ui.includes("/api/planning/season-plans/open-seasons") && ui.includes("seasonId,"));
  assert.ok(ui.includes('data-testid="season-year"') && ui.includes('data-testid="season-start"') && ui.includes('data-testid="season-end"'));
  const { DEFAULT_LABELS } = await import("@/features/labels/labels");
  for (const k of ["season", "select_season", "year", "start_month", "end_month", "months", "no_open_seasons", "loading", "season_required", "season_closed", "period_note"]) {
    assert.ok(`sales_planning.create_seasonal.${k}` in DEFAULT_LABELS, k);
    assert.ok(ui.includes(`sales_planning.create_seasonal.${k}`), `UI uses label ${k}`);
  }
  ok("dialog has no editable period / hard-coded names and every new text is an Edit Labels key");
  console.log(`seasonal-create-season.test.ts — ${n} groups passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
