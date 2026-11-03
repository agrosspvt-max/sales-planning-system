/**
 * Seasonal Plan Excel export against a REAL, disposable PostgreSQL database: authorization, version choice, closed periods, the state price list
 * vs saved plan prices, dealer eligibility / display names / No Plan, merged products, months, read-only behaviour and statement counts.
 * The workbook's opening figures are compared with the system's own plan read (getPlanDetail) through the seasonal workspace's rule.
 *
 *   createdb seasonal_export_test && DATABASE_URL=postgresql://localhost:5432/seasonal_export_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
 *   SEASONAL_EXPORT_TEST_URL=postgresql://localhost:5432/seasonal_export_test node --import tsx src/features/planning/seasonal-export.integration.ts
 *
 * Only a LOCAL database named `seasonal_export_test` is permitted — the script TRUNCATEs the tables it uses.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { Prisma, PrismaClient, Role, PlanStatus } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { figuresForMode, amount as calcAmount, nbv as calcNbv, type PlanningMode } from "@/lib/calc";
import { seasonalSeedValue } from "@/lib/seasonal-line";
import type { AuthContext } from "@/lib/http";

const raw = process.env.SEASONAL_EXPORT_TEST_URL;
if (!raw || !["localhost", "127.0.0.1"].includes(new URL(raw).hostname) || new URL(raw).pathname !== "/seasonal_export_test")
  throw new Error("Only a local database named seasonal_export_test is permitted (set SEASONAL_EXPORT_TEST_URL).");
const prisma = new PrismaClient({ datasources: { db: { url: raw } }, log: [{ emit: "event", level: "query" }] });
const queries: string[] = [];
prisma.$on("query", (e: { query: string }) => { queries.push(e.query); });
const load = testLoader({
  "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError },
  "@/lib/audit": { writeAudit: async (d: Prisma.AuditLogUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) => tx.auditLog.create({ data: d }) },
});
const svc = load<typeof import("./seasonal-export.server")>("src/features/planning/seasonal-export.server.ts");
const planning = load<typeof import("./service.server")>("src/features/planning/service.server.ts");

const admin = { userId: "admin", username: "admin", role: Role.SUPER_ADMIN, groupId: null } as AuthContext;
const so1 = { userId: "so1", username: "so1", role: Role.SALES_OFFICER, groupId: "wb" } as AuthContext;
const rm1 = { userId: "rm1", username: "rm1", role: Role.REGIONAL_MANAGER, groupId: "wb" } as AuthContext;
const customWith = { userId: "ca1", username: "ca1", role: Role.CUSTOM_ADMIN, groupId: null, permissions: { salesPlanning: ["read", "export"] } } as unknown as AuthContext;
const customImportOnly = { userId: "ca2", username: "ca2", role: Role.CUSTOM_ADMIN, groupId: null, permissions: { planImport: ["read", "analyze", "import"], salesPlanning: ["read"] } } as unknown as AuthContext;
const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const eq = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m); // services run in their own VM realm
const near = (a: number, b: number, m: string) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${m}: ${a} ≠ ${b}`);

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "ApprovalAction","AuditLog","Notification","MonthlyEntry","MonthlyPlan","PlanLinePack","PlanLine","PlanDealer","SeasonPlan","DealerAlias",
    "GroupProductCatalogue","DealerAssignment","Dealer","Product","PackSize","SeasonMonth","Season","User","UserGroup" CASCADE`);
  await prisma.userGroup.createMany({ data: [{ id: "wb", name: "WB" }, { id: "od", name: "OD" }] });
  await prisma.user.createMany({ data: [
    { id: "admin", name: "Admin", username: "admin", passwordHash: "x", role: Role.SUPER_ADMIN },
    { id: "ca1", name: "Custom With", username: "ca1", passwordHash: "x", role: Role.CUSTOM_ADMIN },
    { id: "ca2", name: "Custom Import", username: "ca2", passwordHash: "x", role: Role.CUSTOM_ADMIN },
    { id: "so1", name: "Chhitranjan", username: "so1", passwordHash: "x", role: Role.SALES_OFFICER, groupId: "wb" },
    { id: "so2", name: "Rajesh Kundu", username: "so2", passwordHash: "x", role: Role.SALES_OFFICER, groupId: "od" },
    { id: "so3", name: "No Plan Officer", username: "so3", passwordHash: "x", role: Role.SALES_OFFICER, groupId: "wb" },
    { id: "so4", name: "Gone Officer", username: "so4", passwordHash: "x", role: Role.SALES_OFFICER, groupId: "wb", isActive: false },
    { id: "rm1", name: "RM WB", username: "rm1", passwordHash: "x", role: Role.REGIONAL_MANAGER, groupId: "wb" },
  ] });
  await prisma.season.create({ data: { id: "kharif", name: "Kharif", year: 2026, status: "OPEN", seasonalMode: "PACK_SIZE", startMonth: 6, startYear: 2026 } });
  await prisma.season.create({ data: { id: "old", name: "Rabi", year: 2025, status: "CLOSED", seasonalMode: "PACK_SIZE" } });
  await prisma.seasonMonth.createMany({ data: [
    { id: "jul", seasonId: "kharif", name: "July", order: 2, calendarMonth: 7, calendarYear: 2026 },
    { id: "jun", seasonId: "kharif", name: "June", order: 1, calendarMonth: 6, calendarYear: 2026 },
    { id: "aug", seasonId: "kharif", name: "August", order: 3, calendarMonth: 8, calendarYear: 2026, status: "CLOSED" },
  ] });
  await prisma.packSize.createMany({ data: [
    { id: "pk1", name: "1 LTR", displayOrder: 1, isPlanning: true }, { id: "pk5", name: "500 ML", displayOrder: 2, isPlanning: true },
    { id: "pkx", name: "5 LTR (retired)", displayOrder: 9, isPlanning: false },
  ] });
  await prisma.product.createMany({ data: [
    { id: "tandab", name: "TANDAB", technicalName: "NOVALURON", rate: 2000, nbvPercent: 0.25 },
    { id: "taandab", name: "TAANDAB", technicalName: "NOVALURON (old)", rate: 1900, nbvPercent: 0.2 },
    { id: "agora", name: "AGORA", technicalName: "BIFENTHRIN", rate: 500, nbvPercent: 0.25 },
    { id: "neon", name: "NEON", technicalName: "ETHION", rate: 600, nbvPercent: 0.3 },
  ] });
  await prisma.product.update({ where: { id: "taandab" }, data: { mergedIntoId: "tandab", mergedAt: new Date() } });
  // WB state catalogue: prices differ from the Master (AGORA 514.15 here, 500 on the Master).
  await prisma.groupProductCatalogue.createMany({ data: [
    { groupId: "wb", productId: "agora", price: 514.15, isActive: true }, { groupId: "wb", productId: "tandab", price: 1970.15, isActive: true }, { groupId: "wb", productId: "neon", price: 605.15, isActive: true },
  ] });
  await prisma.dealer.createMany({ data: [
    { id: "d-z", name: "ZEBRA AGRO" }, { id: "d-a", name: "rakshit" }, { id: "d-np", name: "BABA SABBIR" }, { id: "d-blank", name: "GREENLIGHT" },
    { id: "d-off", name: "INACTIVE DEALER", isActive: false }, { id: "d-def", name: "DEFAULTER DEALER", status: "DEFAULTER" }, { id: "d-mon", name: "MONTHLY ONLY" },
  ] });
  await prisma.dealerAlias.create({ data: { systemDealerId: "d-a", tallyName: "RAKSHIT TRADERS", tallyKey: "rakshittraders" } });
  const line = (id: string, planDealerId: string, productId: string, rateSnapshot: number | null, nbvSnapshot: number | null) => ({ id, planDealerId, productId, rateSnapshot, nbvPercentSnapshot: nbvSnapshot });
  // so1: version 1 (Approved, superseded) and version 2 (Draft, the active version).
  for (const [id, version, status, active] of [["v1", 1, PlanStatus.APPROVED, false], ["v2", 2, PlanStatus.DRAFT, true]] as const) {
    await prisma.seasonPlan.create({ data: { id, seasonId: "kharif", officerId: "so1", version, status, isActiveVersion: active } });
    await prisma.planDealer.createMany({ data: [
      { id: `${id}-z`, seasonPlanId: id, dealerId: "d-z" }, { id: `${id}-a`, seasonPlanId: id, dealerId: "d-a" },
      { id: `${id}-np`, seasonPlanId: id, dealerId: "d-np", noPlan: true, noPlanReason: "Shop closed" }, { id: `${id}-blank`, seasonPlanId: id, dealerId: "d-blank" },
      { id: `${id}-off`, seasonPlanId: id, dealerId: "d-off" }, { id: `${id}-def`, seasonPlanId: id, dealerId: "d-def" }, { id: `${id}-mon`, seasonPlanId: id, dealerId: "d-mon", fromMonthlyPlan: true },
    ] });
    await prisma.planLine.createMany({ data: [
      line(`${id}-z-tandab`, `${id}-z`, "tandab", 1970.15, 0.25), line(`${id}-z-taandab`, `${id}-z`, "taandab", 1800, 0.2), line(`${id}-z-agora`, `${id}-z`, "agora", 514.15, 0.25),
      line(`${id}-a-tandab`, `${id}-a`, "tandab", 1950, 0.25), // saved earlier at an older WB price
      line(`${id}-a-neon`, `${id}-a`, "neon", null, null), // legacy line: Master fallback
      line(`${id}-blank-agora`, `${id}-blank`, "agora", 514.15, 0.25), line(`${id}-np-agora`, `${id}-np`, "agora", 514.15, 0.25),
      line(`${id}-off-agora`, `${id}-off`, "agora", 514.15, 0.25), line(`${id}-def-agora`, `${id}-def`, "agora", 514.15, 0.25), line(`${id}-mon-agora`, `${id}-mon`, "agora", 514.15, 0.25),
    ] });
    const q = version === 2 ? 1 : 10; // the two versions hold different quantities — they must never be combined
    await prisma.planLinePack.createMany({ data: [
      { planLineId: `${id}-z-tandab`, packSizeId: "pk1", quantity: 4 * q }, { planLineId: `${id}-z-tandab`, packSizeId: "pk5", quantity: 2 * q },
      { planLineId: `${id}-z-taandab`, packSizeId: "pk1", quantity: q }, { planLineId: `${id}-z-taandab`, packSizeId: "pkx", quantity: 3 },
      { planLineId: `${id}-a-tandab`, packSizeId: "pk5", quantity: 5 * q }, { planLineId: `${id}-a-neon`, packSizeId: "pk1", quantity: 2 * q },
      { planLineId: `${id}-off-agora`, packSizeId: "pk1", quantity: 99 },
    ] });
    await prisma.monthlyEntry.createMany({ data: [
      { planLineId: `${id}-z-tandab`, seasonMonthId: "jun", planQty: 3, saleQty: 2, saleValue: 3900.5 },
      { planLineId: `${id}-z-tandab`, seasonMonthId: "aug", planQty: 1, saleQty: 1, saleValue: -150 }, // closed month: totals only
      { planLineId: `${id}-z-agora`, seasonMonthId: "jul", planQty: 0, saleQty: 0, saleValue: -42.25 }, // a return
    ] });
  }
  await prisma.seasonPlan.create({ data: { id: "so2-v1", seasonId: "kharif", officerId: "so2", version: 1, status: PlanStatus.PENDING_RM, isActiveVersion: true } });
  await prisma.planDealer.create({ data: { id: "so2-z", seasonPlanId: "so2-v1", dealerId: "d-z" } });
  await prisma.planLine.create({ data: line("so2-z-agora", "so2-z", "agora", 480, 0.25) });
  await prisma.planLinePack.create({ data: { planLineId: "so2-z-agora", packSizeId: "pk1", quantity: 7 } });
  await prisma.seasonPlan.create({ data: { id: "old-plan", seasonId: "old", officerId: "so1", version: 1, status: PlanStatus.APPROVED } });
  // so4 (inactive) has two versions and no active one: no default — the administrator must choose.
  for (const v of [1, 2]) await prisma.seasonPlan.create({ data: { id: `so4-v${v}`, seasonId: "kharif", officerId: "so4", version: v, status: PlanStatus.REJECTED } });
}

const snapshotDb = async () => JSON.stringify(await Promise.all([
  prisma.seasonPlan.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true, lastSavedAt: true } }),
  prisma.planLine.findMany({ orderBy: { id: "asc" }, select: { id: true, rateSnapshot: true, nbvPercentSnapshot: true, inputValue: true } }),
  prisma.planLinePack.findMany({ orderBy: { id: "asc" }, select: { id: true, quantity: true } }),
  prisma.dealerAssignment.count(), prisma.auditLog.count(), prisma.approvalAction.count(), prisma.notification.count(), prisma.seasonPlan.count(),
]));

async function readXlsx(buf: Buffer) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer); return wb; }
const result = (v: ExcelJS.CellValue): number => (typeof v === "number" ? v : v && typeof v === "object" && "result" in v && typeof v.result === "number" ? v.result : 0);

async function main() {
  await seed();

  /* ---- authorization: administrators only; a Custom Admin needs Sales Planning → Export (Import is not enough) ---- */
  for (const [ctx, label] of [[so1, "Sales Officer"], [rm1, "Regional Manager"], [customImportOnly, "Custom Admin with Import only"]] as const) {
    assert.equal(await code(svc.listSeasonalExportOptions(ctx, "kharif")), 403, `${label}: options refused`);
    assert.equal(await code(svc.exportSeasonalPlans(ctx, { seasonId: "kharif", plans: [{ officerId: "so1", planId: "v2" }] })), 403, `${label}: export refused`);
  }
  assert.equal(await code(svc.listSeasonalExportOptions(customWith, "kharif")), 0, "Custom Admin with the export grant");
  assert.equal(await code(svc.listSeasonalExportOptions(admin, "old")), 404, "a closed season is not offered");
  assert.equal(await code(svc.exportSeasonalPlans(admin, { seasonId: "old", plans: [{ officerId: "so1", planId: "old-plan" }] })), 404, "…nor exportable");

  /* ---- options: every version labelled, the active one pre-selected, no default when it is ambiguous ---- */
  const { officers } = await svc.listSeasonalExportOptions(admin, "kharif");
  const by = new Map(officers.map((o) => [o.officerId, o]));
  eq(by.get("so1")!.plans.map((p) => [p.version, p.statusLabel, p.isActiveVersion]), [[2, "Draft", true], [1, "Approved", false]]);
  assert.equal(by.get("so1")!.defaultPlanId, "v2", "the active version is pre-selected (and shown)");
  assert.equal(by.get("so2")!.plans[0]!.statusLabel, "Pending RM", "submitted plans are exportable");
  eq([by.get("so3")!.plans.length, by.get("so3")!.defaultPlanId], [0, null], "an officer without a plan is listed with nothing to export");
  eq([by.get("so4")!.plans.length, by.get("so4")!.defaultPlanId], [2, null], "two versions, none active → explicit choice required");
  assert.ok(by.has("rm1"), "Regional Managers own seasonal plans too");
  assert.ok(!by.get("so1")!.plans.some((p) => p.planId === "old-plan"), "plans of closed seasons are not offered");

  /* ---- invalid selections fail loudly, nothing is created ---- */
  const before = await snapshotDb();
  assert.equal(await code(svc.exportSeasonalPlans(admin, { seasonId: "kharif", plans: [{ officerId: "so3", planId: "v2" }] })), 422, "a plan of another officer is refused");
  assert.equal(await code(svc.exportSeasonalPlans(admin, { seasonId: "kharif", plans: [{ officerId: "so1", planId: "v1" }, { officerId: "so1", planId: "v2" }] })), 422, "two versions of one officer are never combined");
  assert.equal(await code(svc.exportSeasonalPlans(admin, { seasonId: "kharif", plans: [{ officerId: "so1", planId: "" }] })), 422, "a missing version choice is refused");
  assert.equal(await code(svc.exportSeasonalPlans(admin, { seasonId: "kharif", plans: [] })), 422);
  const msg = await svc.exportSeasonalPlans(admin, { seasonId: "kharif", plans: [{ officerId: "so3", planId: "nope" }, { officerId: "so1", planId: "v2" }] }).then(() => "", (e: Error) => e.message);
  assert.match(msg, /No Plan Officer/, "the failure names the officer (never silently omitted)");

  /* ---- one officer → one .xlsx; statement count of the batch read ---- */
  let mark = queries.length;
  const single = await svc.exportSeasonalPlans(admin, { seasonId: "kharif", plans: [{ officerId: "so1", planId: "v2" }] });
  const singleStatements = queries.slice(mark).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(q.trim())).length;
  assert.equal(single.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(single.filename, "Seasonal Plan - Chhitranjan - Kharif 2026 - v2.xlsx");
  const wb = await readXlsx(single.data);
  const tabs = wb.worksheets.map((w) => w.name);
  eq(tabs, ["PRICELIST", "Product Plan", "Dealer Summary", "BABA SABBIR", "GREENLIGHT", "RAKSHIT TRADERS", "ZEBRA AGRO"],
    "fixed sheets, then the plan's eligible seasonal dealers alphabetically by DISPLAYED (alias) name — inactive / Defaulter / monthly-only dealers excluded");

  // PRICELIST = the WB catalogue (not the Master); saved prices that differ are kept for the lines that use them.
  const price = wb.getWorksheet("PRICELIST")!;
  eq([2, 3, 4].map((r) => [price.getCell(r, 2).value, price.getCell(r, 4).value]), [["AGORA", 514.15], ["NEON", 605.15], ["TANDAB", 1970.15]], "state price list, alphabetical");
  const saved: string[] = [];
  for (let r = 2; price.getCell(r, 8).value; r++) saved.push(`${price.getCell(r, 8).value}@${price.getCell(r, 10).value}`);
  eq(saved.sort(), ["NEON@600", "TAANDAB@1800", "TANDAB@1950"], "older saved WB price, a merged source's price and the legacy line's Master fallback are kept");

  // Opening figures = the system's own plan read, through the seasonal workspace rule.
  const detail = await planning.getPlanDetail(admin, "v2");
  const mode = detail.seasonalMode as PlanningMode;
  const screen = new Map(detail.dealers.map((d) => [d.dealerName, d.lines.reduce((acc, l) => {
    const value = mode === "PACK_SIZE" ? Object.values(l.packs).reduce((a, b) => a + b, 0) : seasonalSeedValue(l, mode);
    const fig = figuresForMode(mode, value, l.rate, l.nbvPercent);
    const live = calcAmount(l.liveMonthlyQty, l.rate);
    return { plan: acc.plan + (fig.amount ?? 0), nbv: acc.nbv + (fig.nbv ?? 0), live: acc.live + live, liveNbv: acc.liveNbv + calcNbv(live, l.nbvPercent), actual: acc.actual + l.actualAmount, actualNbv: acc.actualNbv + calcNbv(l.actualAmount, l.nbvPercent) };
  }, { plan: 0, nbv: 0, live: 0, liveNbv: 0, actual: 0, actualNbv: 0 })]));
  const ds = wb.getWorksheet("Dealer Summary")!;
  let grandPlan = 0;
  for (let r = 6; ds.getCell(r, 2).value; r++) {
    const name = String(ds.getCell(r, 2).value);
    const s = screen.get(name)!;
    near(result(ds.getCell(r, 3).value), s.plan, `${name} Sales Plan = Dealer Summary screen`);
    near(result(ds.getCell(r, 4).value), s.nbv, `${name} Sales Plan NBV`);
    near(result(ds.getCell(r, 5).value), s.live, `${name} Live Month Plan (closed months included, as on screen)`);
    near(result(ds.getCell(r, 7).value), s.actual, `${name} Actual Sales = uploaded values incl. negative`);
    near(result(ds.getCell(r, 8).value), s.actualNbv, `${name} Actual NBV`);
    grandPlan += s.plan;
  }
  near(result(ds.getCell(5, 3).value), grandPlan, "grand Sales Plan");
  assert.equal(String(ds.getCell(6, 11).value), "No Plan", "BABA SABBIR: No Plan");
  assert.equal(String(ds.getCell(6, 12).value), "Shop closed", "…with its reason");
  assert.equal(String(ds.getCell(7, 11).value), "Remaining", "GREENLIGHT: unfinished draft, not No Plan");
  const zebra = wb.getWorksheet("ZEBRA AGRO")!;
  const headers = Array.from({ length: zebra.columnCount }, (_, i) => String(zebra.getCell(3, i + 1).value ?? ""));
  assert.ok(headers.includes("1 LTR") && headers.includes("500 ML") && headers.includes("5 LTR (retired)"), "planning packs + a retired pack that still holds a saved quantity");
  const months = Array.from({ length: zebra.columnCount }, (_, i) => String(zebra.getCell(2, i + 1).value ?? "")).filter((t) => /^[A-Z][a-z]+ 20\d\d$|^Closed/.test(t));
  eq([...new Set(months)], ["June 2026", "July 2026", "Closed months (combined)"], "open months by calendar, real names; the closed month only as combined totals");
  assert.ok(String(zebra.getCell(1, 1).value).includes("Officer: Chhitranjan") && String(zebra.getCell(1, 1).value).includes("State: WB") && String(zebra.getCell(1, 1).value).includes("Version 2 · Draft"));
  const pp = wb.getWorksheet("Product Plan")!;
  const ppNames: string[] = [];
  for (let r = 4; pp.getCell(r, 2).value && pp.getCell(r, 2).value !== "TOTAL"; r++) ppNames.push(String(pp.getCell(r, 2).value));
  eq(ppNames, ["AGORA", "NEON", "TANDAB"], "Product Plan: effective products only (TAANDAB folded into TANDAB), alphabetical");

  /* ---- several officers → one ZIP, one workbook each; versions are the chosen ones ---- */
  mark = queries.length;
  const t0 = Date.now();
  const bundle = await svc.exportSeasonalPlans(admin, { seasonId: "kharif", plans: [{ officerId: "so1", planId: "v1" }, { officerId: "so2", planId: "so2-v1" }] });
  const zipMs = Date.now() - t0;
  const zipStatements = queries.slice(mark).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(q.trim())).length;
  assert.equal(bundle.contentType, "application/zip");
  const dir = mkdtempSync(join(tmpdir(), "seasonal-export-db-"));
  writeFileSync(join(dir, "b.zip"), bundle.data);
  const names = execFileSync("python3", ["-c", "import sys,zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", join(dir, "b.zip")], { encoding: "utf8" }).trim().split("\n");
  eq(names, ["Seasonal Plan - Chhitranjan - Kharif 2026 - v1.xlsx", "Seasonal Plan - Rajesh Kundu - Kharif 2026 - v1.xlsx"], "one separate workbook per officer");
  execFileSync("unzip", ["-q", "-o", join(dir, "b.zip"), "-d", dir]);
  const v1 = await readXlsx(await import("node:fs").then((fs) => fs.readFileSync(join(dir, names[0]!))));
  const v1Zebra = v1.getWorksheet("ZEBRA AGRO")!;
  const qtyCol = headers.indexOf("TOTAL QTY") + 1;
  const tandabRow = [4, 5, 6, 7].find((r) => v1Zebra.getCell(r, 2).value === "TANDAB")!;
  assert.equal(result(v1Zebra.getCell(tandabRow, qtyCol).value), 60, "version 1's own quantities (40 + 20), never mixed with version 2");
  const od = await readXlsx(await import("node:fs").then((fs) => fs.readFileSync(join(dir, names[1]!))));
  assert.match(String(od.getWorksheet("PRICELIST")!.getCell(od.getWorksheet("PRICELIST")!.rowCount, 1).value ?? "") + JSON.stringify(od.getWorksheet("PRICELIST")!.getSheetValues()), /Master price list/, "OD has no state catalogue → the Master price list, never another state's catalogue");

  /* ---- read-only ---- */
  assert.equal(await snapshotDb(), before, "exporting changed nothing (plans, lines, packs, prices, statuses, assignments, audit, notifications)");
  console.log(`measured: one officer export ${singleStatements} statements; two officers ${zipStatements} statements, ${zipMs} ms (small fixture)`);
  console.log("seasonal-export.integration.ts — all scenarios passed");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
