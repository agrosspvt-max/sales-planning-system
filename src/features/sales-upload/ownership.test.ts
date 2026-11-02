/** Real Sales Upload preview/commit and alias resolver: new actuals follow current ownership,
 * independently of historical plan order. No production database or credentials are used.
 */
import assert from "node:assert/strict";
import { Role } from "@prisma/client";
import * as XLSX from "xlsx";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";
import type { OpenAssignment } from "@/lib/dealer-ownership";

const same = (actual: unknown, expected: unknown, message?: string) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const NAME = "Siddhi Vinayak Krishi Kendra (Bija) CG";
const ALIAS = "SIDDHI VINAYAK BIJA TALLY";
const products = [{ id: "agora", name: "AGORA" }, { id: "neon", name: "NEON" }];
const ADMIN = { userId: "admin", role: Role.SUPER_ADMIN } as AuthContext;
const owner = (officerId: string, day: number): OpenAssignment => ({
  officerId, effectiveFrom: new Date(Date.UTC(2026, 9, day)), createdAt: new Date(Date.UTC(2026, 9, day)),
});
function workbook(name = ALIAS) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Group Name", "Particulars", "1-Oct-26", "31-Oct-26"],
    ["", "", "Total", "Sales"], ["", "Qty", "Value", null],
    ["BEMETARA", name, 50, 24539],
    ["", "AGORA 20X500ML", 50, 24650], ["", "NEON 20X500ML", null, -111],
  ]), "Sales Register");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
type Entry = { id: string; planLineId: string; saleQty: number; saleValue: number; planQty: number; planValue: number };
type Plan = { id: string; dealerId: string; dealer: { name: string; assignments: OpenAssignment[] }; seasonPlan: { officer: { id: string; name: string } }; lines: { id: string; productId: string }[] };

function setup(order = ["kamal", "harsh"], assignments = [owner("kamal", 20)]) {
  const plans: Plan[] = order.map((id) => ({
    id: `pd-${id}`, dealerId: "dealer", dealer: { name: NAME, assignments },
    seasonPlan: { officer: { id, name: id === "kamal" ? "Kamal Hasan" : "Harsh Tiwari" } },
    lines: products.map((p) => ({ id: `${id}-${p.id}`, productId: p.id })),
  }));
  const entries: Entry[] = [
    { id: "old", planLineId: "harsh-agora", saleQty: 3, saleValue: 1500, planQty: 17, planValue: 8000 },
    { id: "new", planLineId: "kamal-agora", saleQty: 1, saleValue: 500, planQty: 25, planValue: 12000 },
  ];
  const writes: { planLineId: string; saleQty: number; saleValue: number }[] = [];
  let planReads = 0;
  const prisma = {
    seasonMonth: { findUnique: async () => ({ id: "month", name: "October", season: { id: "season", name: "Kharif", year: 2026 } }) },
    dealer: { findMany: async () => [{ id: "dealer", name: NAME }] },
    dealerAlias: { findMany: async () => [{ tallyName: ALIAS, tallyKey: "unused-legacy-key", systemDealerId: "dealer" }] },
    planDealer: { findMany: async (args: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      planReads++;
      assert.equal(args.where.seasonPlan.status, "APPROVED");
      assert.equal(args.where.seasonPlan.isActiveVersion, true);
      assert.equal(args.where.seasonPlan.lifecycleState, "ACTIVE");
      assert.equal(args.where.dealer.status, "ACTIVE");
      assert.equal(args.select.dealer.select.assignments.where.effectiveTo, null);
      assert.equal(args.select.dealer.select.assignments.select.effectiveFrom, true);
      assert.equal(args.select.dealer.select.assignments.select.createdAt, true);
      return plans.filter((p) => !args.where.seasonPlan.officerId || p.seasonPlan.officer.id === args.where.seasonPlan.officerId);
    } },
    monthlyEntry: {
      findMany: async (args: { where: { planLineId: { in: string[] } } }) => entries.filter((e) => args.where.planLineId.in.includes(e.planLineId)),
      createMany: async ({ data }: { data: { planLineId: string; saleQty: number; saleValue: number }[] }) => {
        for (const d of data) { writes.push(d); entries.push({ ...d, id: `e-${d.planLineId}`, planQty: 0, planValue: 0 }); }
        return { count: data.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: { saleQty: number; saleValue: number } }) => {
        const entry = entries.find((e) => e.id === where.id)!;
        writes.push({ planLineId: entry.planLineId, ...data }); Object.assign(entry, data); return entry;
      },
    },
    planLine: { createMany: async ({ data }: { data: { planDealerId: string; productId: string }[] }) => {
      let count = 0;
      for (const d of data) {
        const pd = plans.find((p) => p.id === d.planDealerId)!;
        if (!pd.lines.some((l) => l.productId === d.productId)) { pd.lines.push({ id: `${pd.seasonPlan.officer.id}-${d.productId}`, productId: d.productId }); count++; }
      }
      return { count };
    } },
    user: { findMany: async () => [ { id: "kamal", groupId: null }, { id: "harsh", groupId: null } ] },
    groupProductCatalogue: { findMany: async () => [] },
    salesUploadRun: { create: async () => ({ id: "run" }) },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const load = testLoader({
    "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => undefined },
    "@/lib/db-retry": { withDbRetry: <T,>(fn: () => Promise<T>) => fn() },
    "@/lib/product-resolver": { loadProductResolver: async () => ({ products, productNameById: new Map(products.map((p) => [p.id, p.name])), resolveProduct: (name: string) => products.find((p) => p.name === name) ?? null }) },
  });
  return { service: load<typeof import("./service.server")>("src/features/sales-upload/service.server.ts"), plans, entries, writes, assignments, reads: () => planReads };
}

async function main() {
  for (const order of [["kamal", "harsh"], ["harsh", "kamal"]]) {
    const f = setup(order);
    const before = JSON.stringify(f.entries);
    const preview = await f.service.analyzeSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    same(preview.detectedOfficers, ["Kamal Hasan"], "current owner wins in either plan return order");
    assert.equal(preview.rowsToImport, 2);
    assert.equal(preview.report!.officers[0].dealers[0].matchedBy, "Alias");
    assert.equal(preview.report!.officers[0].dealers[0].products[0].plannedQty, 25, "preview uses Kamal's monthly planning values");
    assert.equal(f.reads(), 1, "ownership is selected with existing plan read, no per-dealer query");
    assert.equal(JSON.stringify(f.entries), before, "preview is read only");
    await f.service.commitSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    same(f.writes.map((w) => [w.planLineId, w.saleQty, w.saleValue]).sort(), [["kamal-agora", 50, 24650], ["kamal-neon", 0, -111]]);
    same(f.entries.find((e) => e.id === "old"), JSON.parse(before)[0], "Harsh's existing sales and manual planning stay unchanged");
    assert.equal(f.entries.find((e) => e.id === "new")!.planQty, 25);
    assert.equal(f.entries.find((e) => e.id === "new")!.planValue, 12000);
    f.writes.length = 0;
    await f.service.commitSalesUpload(ADMIN, workbook(NAME), "sales.xlsx", { seasonMonthId: "month" });
    assert.equal(f.entries.filter((e) => e.planLineId === "kamal-neon").length, 1, "exact-name reimport remains idempotent");
    assert.ok(f.writes.every((w) => w.planLineId.startsWith("kamal-")));
  }
  {
    const f = setup(["harsh"]);
    const preview = await f.service.analyzeSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    assert.equal(preview.rowsToImport, 0, "missing current-owner plan never falls back to former owner");
    same(preview.dealersWithoutPlan, [NAME]);
    await f.service.commitSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    assert.equal(f.writes.length, 0);
  }
  {
    const f = setup();
    const preview = await f.service.analyzeSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month", officerId: "harsh" });
    assert.equal(preview.rowsToImport, 0, "explicit officer selection cannot override assignment");
    await f.service.commitSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month", officerId: "harsh" });
    assert.equal(f.writes.length, 0);
    f.plans.find((p) => p.id === "pd-kamal")!.lines = [];
    const result = await f.service.commitSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month", officerId: "kamal" });
    assert.equal(result.autoAddedLines, 2, "missing products added only to current owner's plan");
    assert.ok(f.writes.every((w) => w.planLineId.startsWith("kamal-")));
  }
  for (const assignments of [[owner("kamal", 20), owner("harsh", 1)], [owner("harsh", 1), owner("kamal", 20)]]) {
    const f = setup(undefined, assignments);
    const preview = await f.service.analyzeSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    same(preview.detectedOfficers, ["Kamal Hasan"], "latest open assignment wins over lingering old open assignment");
  }
  {
    const f = setup();
    await f.service.analyzeSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    f.assignments.splice(0, 1, owner("harsh", 25));
    await f.service.commitSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    assert.ok(f.writes.every((w) => w.planLineId.startsWith("harsh-")), "commit re-resolves ownership after a stale preview");
  }
  {
    const f = setup(["harsh"], []);
    const preview = await f.service.analyzeSalesUpload(ADMIN, workbook(), "sales.xlsx", { seasonMonthId: "month" });
    same(preview.detectedOfficers, ["Harsh Tiwari"], "unassigned legacy dealers retain existing routing");
  }
  console.log("Sales Upload ownership passed: alias/exact, preview/commit, plan order, current owner, stale preview, no unsafe fallback, auto-added products, signed values and historical planning preservation.");
}
main().catch((e) => { console.error(e); process.exit(1); });
