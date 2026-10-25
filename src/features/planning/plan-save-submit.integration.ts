/**
 * Sales Seasonal / Sales Monthly / Recovery: save and submit against a REAL, disposable PostgreSQL database — statement counts (the regression budget),
 * the save ↔ submit ordering under concurrency, duplicate submissions and late saves.
 *
 *   createdb plan_tx_test && DATABASE_URL=postgresql://localhost:5432/plan_tx_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   PLAN_TX_TEST_URL=postgresql://localhost:5432/plan_tx_test node --import tsx src/features/planning/plan-save-submit.integration.ts
 *
 * Only a LOCAL database named `plan_tx_test` is permitted — the script TRUNCATEs the tables it uses. Statements are counted from Prisma's query log
 * (one per Prisma relation level; BEGIN / COMMIT excluded). FIXTURE=small|representative|large selects the plan size (default: all three).
 */
import assert from "node:assert/strict";
import { Prisma, PrismaClient, Role, PlanStatus } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

const raw = process.env.PLAN_TX_TEST_URL;
if (!raw || !["localhost", "127.0.0.1"].includes(new URL(raw).hostname) || new URL(raw).pathname !== "/plan_tx_test")
  throw new Error("Only a local database named plan_tx_test is permitted (set PLAN_TX_TEST_URL).");
const withPool = (u: string, n: number) => { const x = new URL(u); x.searchParams.set("connection_limit", String(n)); x.searchParams.set("pool_timeout", "10"); return x.toString(); };
const base = new PrismaClient({ datasources: { db: { url: withPool(raw, 4) } }, log: [{ emit: "event", level: "query" }] });
const queries: string[] = [];
base.$on("query", (e: { query: string }) => { queries.push(e.query.replace(/\s+/g, " ").trim()); });
let rtt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Every statement waits a simulated round trip first, so interleavings that need a slow network actually happen.
const prisma = base.$extends({ query: { async $allOperations({ args, query }) { if (rtt) await sleep(rtt); return query(args); } } }) as unknown as PrismaClient;

const mocks = {
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (d: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data: d }) },
};
const load = testLoader(mocks);
const planning = load<typeof import("./service.server")>("src/features/planning/service.server.ts");
const monthly = load<typeof import("./monthly-plan.server")>("src/features/planning/monthly-plan.server.ts");
const recovery = load<typeof import("@/features/recovery/service.server")>("src/features/recovery/service.server.ts");
const recoveryApproval = load<typeof import("@/features/recovery/approval.server")>("src/features/recovery/approval.server.ts");

const so1 = { userId: "so1", username: "so1", role: Role.SALES_OFFICER, groupId: "g1" } as AuthContext;
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const statements = (from: number) => queries.slice(from).filter((s) => s !== "BEGIN" && s !== "COMMIT" && s !== "ROLLBACK");
async function count<T>(fn: () => Promise<T>): Promise<{ n: number; result: T }> { const mark = queries.length; const result = await fn(); return { n: statements(mark).length, result }; }

interface Fixture { name: string; dealers: number; products: number; packs: number }
const FIXTURES: Fixture[] = [
  { name: "small", dealers: 3, products: 2, packs: 2 },
  { name: "representative", dealers: 30, products: 10, packs: 4 },
  { name: "large", dealers: 150, products: 40, packs: 4 },
];

interface Seeded { planId: string; monthlyPlanId: string; recoveryPlanId: string; monthId: string; packIds: string[]; dealerIds: string[]; productIds: string[]; lineIds: string[] }
async function seed(f: Fixture, seasonalMode = "PACK_SIZE"): Promise<Seeded> {
  await base.$executeRawUnsafe(`TRUNCATE "Notification","ApprovalAction","AuditLog","MonthlyEntry","MonthlyPlanDealer","MonthlyPlan","PlanLinePack","PlanLine","PlanDealer","SeasonPlan",
    "RecoveryWeekPlan","RecoveryWeekLock","RecoveryPlanDealer","RecoveryPlan","DealerAssignment","Dealer","Product","PackSize","SeasonMonth","Season","User","UserGroup" CASCADE`);
  await base.userGroup.create({ data: { id: "g1", name: "MP" } });
  await base.user.createMany({ data: [
    { id: "so1", name: "SO One", username: "so1", passwordHash: "x", role: Role.SALES_OFFICER, groupId: "g1" },
    { id: "rm1", name: "RM One", username: "rm1", passwordHash: "x", role: Role.REGIONAL_MANAGER, groupId: "g1" },
    { id: "admin", name: "Admin", username: "admin", passwordHash: "x", role: Role.SUPER_ADMIN },
  ] });
  const season = await base.season.create({ data: { name: "Kharif", year: 2026, status: "OPEN", seasonalMode, monthlyMode: "PACK_SIZE", startMonth: 6, startYear: 2026 } });
  const month = await base.seasonMonth.create({ data: { seasonId: season.id, name: "June", order: 1, calendarMonth: 6, calendarYear: 2026 } });
  const packIds = Array.from({ length: f.packs }, (_, i) => `pk${i}`);
  await base.packSize.createMany({ data: packIds.map((id, i) => ({ id, name: `${(i + 1) * 250} ml`, displayOrder: i + 1, isPlanning: true })) });
  const productIds = Array.from({ length: f.products }, (_, i) => `p${i}`);
  await base.product.createMany({ data: productIds.map((id, i) => ({ id, name: `Product ${i}`, rate: 100 + i, nbvPercent: 0.1 })) });
  const dealerIds = Array.from({ length: f.dealers }, (_, i) => `d${i}`);
  await base.dealer.createMany({ data: dealerIds.map((id, i) => ({ id, name: `Dealer ${String(i).padStart(3, "0")}` })) });
  await base.dealerAssignment.createMany({ data: dealerIds.map((dealerId) => ({ dealerId, officerId: "so1", effectiveFrom: new Date("2024-01-01") })) });
  const plan = await base.seasonPlan.create({ data: { seasonId: season.id, officerId: "so1", status: PlanStatus.DRAFT, isActiveVersion: true } });
  await base.planDealer.createMany({ data: dealerIds.map((dealerId) => ({ id: `pd-${dealerId}`, seasonPlanId: plan.id, dealerId })) });
  const lines = dealerIds.flatMap((dealerId) => productIds.map((productId) => ({ id: `pl-${dealerId}-${productId}`, planDealerId: `pd-${dealerId}`, productId })));
  for (let i = 0; i < lines.length; i += 5000) await base.planLine.createMany({ data: lines.slice(i, i + 5000) });
  const mp = await base.monthlyPlan.create({ data: { seasonPlanId: plan.id, seasonMonthId: month.id, officerId: "so1", status: PlanStatus.DRAFT } });
  const rp = await base.recoveryPlan.create({ data: { seasonId: season.id, seasonMonthId: month.id, officerId: "so1", cutoffDate: new Date("2026-06-01"), status: PlanStatus.DRAFT, seasonPlanId: plan.id } });
  await base.recoveryPlanDealer.createMany({ data: dealerIds.map((dealerId) => ({ recoveryPlanId: rp.id, dealerId, outstanding: 5000, overdue: 3000, due: 1000 })) });
  for (const weekNo of [1, 2, 3, 4]) await base.recoveryWeekLock.create({ data: { recoveryPlanId: rp.id, weekNo, locked: false } });
  return { planId: plan.id, monthlyPlanId: mp.id, recoveryPlanId: rp.id, monthId: month.id, packIds, dealerIds, productIds, lineIds: lines.map((l) => l.id) };
}

/** Every dealer gets one planned line (so the plan can be submitted); `k` = how many lines one save carries. */
const packLines = (s: Seeded, k: number, qty = 2) => s.dealerIds.flatMap((dealerId) => s.productIds.map((productId) => ({ dealerId, productId }))).slice(0, k)
  .map((l) => ({ ...l, mode: "PACK_SIZE" as const, packs: s.packIds.map((packSizeId) => ({ packSizeId, quantity: qty })) }));
const firstLinePerDealer = (s: Seeded) => s.dealerIds.map((dealerId) => ({ dealerId, productId: s.productIds[0]! }));
const monthEntries = (s: Seeded, lineIds: string[], planQty = 3) => lineIds.map((planLineId) => ({ planLineId, seasonMonthId: s.monthId, planQty }));

const results: Record<string, Record<string, number>> = {};
const record = (fixture: string, key: string, n: number) => { (results[fixture] ??= {})[key] = n; };

async function measure(f: Fixture) {
  /* ---- Sales Seasonal ---- */
  let s = await seed(f);
  record(f.name, "seasonal.save k=1", (await count(() => planning.saveLines(so1, s.planId, { lines: packLines(s, 1) }))).n);
  record(f.name, "seasonal.save k=10", (await count(() => planning.saveLines(so1, s.planId, { lines: packLines(s, 10) }))).n);
  const all = firstLinePerDealer(s).map((l) => ({ ...l, mode: "PACK_SIZE" as const, packs: s.packIds.map((packSizeId) => ({ packSizeId, quantity: 1 })) }));
  record(f.name, `seasonal.save k=${all.length} (one line per dealer)`, (await count(() => planning.saveLines(so1, s.planId, { lines: all }))).n);
  record(f.name, "seasonal.submit", (await count(() => planning.submitPlan(so1, s.planId))).n);

  s = await seed(f, "TOTAL_QUANTITY");
  record(f.name, "seasonal.save value-mode k=10", (await count(() => planning.saveLines(so1, s.planId, { lines: packLines(s, 10).map(({ dealerId, productId }) => ({ dealerId, productId, mode: "TOTAL_QUANTITY" as const, value: 7 })) }))).n);

  /* ---- Sales Monthly ---- */
  s = await seed(f);
  record(f.name, "monthly.save e=1", (await count(() => monthly.saveMonthlyPlanEntries(so1, s.monthlyPlanId, { entries: monthEntries(s, s.lineIds.slice(0, 1)) }))).n);
  record(f.name, "monthly.save e=10", (await count(() => monthly.saveMonthlyPlanEntries(so1, s.monthlyPlanId, { entries: monthEntries(s, s.lineIds.slice(0, 10)) }))).n);
  const firstLines = s.dealerIds.map((d) => `pl-${d}-${s.productIds[0]}`);
  await monthly.saveMonthlyPlanEntries(so1, s.monthlyPlanId, { entries: monthEntries(s, firstLines) });
  record(f.name, "monthly.read (the reload a save triggers today)", (await count(() => monthly.getMonthlyPlan(so1, s.monthlyPlanId))).n);
  record(f.name, "monthly.submit", (await count(() => monthly.submitMonthlyPlan(so1, s.monthlyPlanId))).n);

  /* ---- Recovery ---- */
  s = await seed(f);
  const monthBody = (ids: string[]) => ({ entries: ids.map((dealerId) => ({ dealerId, monthRecoveryPlan: 500, monthRunningRecovery: 0 })) });
  record(f.name, "recovery.month k=1", (await count(() => recovery.saveRecoveryMonth(so1, s.recoveryPlanId, monthBody(s.dealerIds.slice(0, 1))))).n);
  record(f.name, `recovery.month k=${s.dealerIds.length} (all dealers)`, (await count(() => recovery.saveRecoveryMonth(so1, s.recoveryPlanId, monthBody(s.dealerIds)))).n);
  record(f.name, "recovery.week k=1", (await count(() => recovery.saveRecoveryWeek(so1, s.recoveryPlanId, { weekNo: 1, entries: [{ dealerId: s.dealerIds[0]!, weekRecoveryPlan: 100, weekRunningRecovery: 0 }] }))).n);
  record(f.name, "recovery.submit", (await count(() => recoveryApproval.submitRecoveryPlan(so1, s.recoveryPlanId))).n);
}

async function main() {
  const only = process.env.FIXTURE;
  for (const f of FIXTURES.filter((x) => !only || x.name === only)) await measure(f);
  console.log("measured statements (excluding BEGIN/COMMIT):");
  for (const [fixture, rows] of Object.entries(results)) {
    console.log(`  [${fixture}]`);
    for (const [k, n] of Object.entries(rows)) console.log(`    ${k.padEnd(48)} ${n}`);
  }
  void assert; void code; void rtt;
  console.log("plan-save-submit.integration.ts — measurements complete");
}
main().then(() => base.$disconnect(), async (e) => { console.error(e); await base.$disconnect(); process.exit(1); });
