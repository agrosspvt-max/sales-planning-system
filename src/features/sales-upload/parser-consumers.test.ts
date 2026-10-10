/**
 * The shared Tally parser feeds Sales Upload (preview + commit) and Scheme Upload. Runs the REAL services against in-memory fakes with the
 * Ganesh Agro rows: blank-quantity / negative-amount product rows stay with their dealer and keep their signed amounts end to end.
 */
import assert from "node:assert/strict";
import { Role } from "@prisma/client";
import * as XLSX from "xlsx";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import type { AuthContext } from "@/lib/http";

type Row = Record<string, unknown>;
const rows: (string | number | null)[][] = [
  [" Group Name", "Particulars", "1-Oct-26", "9-Oct-26"], ["", "", "Total", "Sales"], ["", "Qty", "Value", null],
  ["MAHASAMUND", "Other Dealer", 10, 5000], ["", "MAXX OPEN 20X500ML", 10, 5000],
  ["DURG", "Ganesh Agro berla CG", 70, 42335.28],
  ["", "BLACK CAT 20X500ML", null, -1655.93],
  ["", "MAXX OPEN 20X500ML", 20, 38095.24],
  ["", "MAXX OPEN 40X250ML", null, -7876.19],
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sales Register");
const BUFFER = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

const DEALERS = [{ id: "d-ganesh", name: "Ganesh Agro berla CG" }, { id: "d-other", name: "Other Dealer" }];
const PRODUCTS = [{ id: "p-bc", name: "BLACK CAT" }, { id: "p-mo", name: "MAXX OPEN" }];
const tight = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const dealerResolver = { dealers: DEALERS, resolveWithReason: (name: string) => { const d = DEALERS.find((x) => tight(x.name) === tight(name)); return d ? { dealer: d, matchType: "EXACT" } : null; } };
const productResolver = { products: PRODUCTS, productNameById: new Map(PRODUCTS.map((p) => [p.id, p.name])), resolveProduct: (name: string) => PRODUCTS.find((p) => tight(p.name) === tight(name)) ?? null };
const ADMIN = { userId: "admin", role: Role.SUPER_ADMIN, username: "admin", groupId: null, designation: null } as unknown as AuthContext;

async function main() {
/* ---------------------------------------------- Sales Upload: preview + commit ---------------------------------------------- */
{
  const created: Row[] = [], runs: Row[] = [];
  const prisma = {
    seasonMonth: { findUnique: async () => ({ id: "m1", name: "October", calendarMonth: 10, calendarYear: 2026, season: { id: "s1", name: "Rabi", year: 2026 } }) },
    planDealer: {
      findMany: async () => [
        { id: "pd-g", dealerId: "d-ganesh", dealer: { name: "Ganesh Agro berla CG" }, seasonPlan: { officer: { id: "o1", name: "Officer" } }, lines: [{ id: "pl-bc", productId: "p-bc" }, { id: "pl-mo", productId: "p-mo" }] },
        { id: "pd-o", dealerId: "d-other", dealer: { name: "Other Dealer" }, seasonPlan: { officer: { id: "o1", name: "Officer" } }, lines: [{ id: "pl-o", productId: "p-mo" }] },
      ],
    },
    monthlyEntry: { findMany: async () => [], createMany: async ({ data }: { data: Row[] }) => { created.push(...data); return { count: data.length }; }, update: async () => ({}) },
    planLine: { createMany: async () => ({ count: 0 }) },
    user: { findMany: async () => [{ id: "o1", groupId: null }] },
    groupProductCatalogue: { findMany: async () => [] },
    salesUploadRun: { create: async ({ data }: { data: Row }) => { runs.push(data); return { id: "run1" }; } },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const load = testLoader({
    "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => undefined },
    "@/lib/db-retry": { withDbRetry: <T,>(fn: () => Promise<T>) => fn() },
    "@/lib/dealer-resolver": { loadDealerResolver: async () => dealerResolver }, "@/lib/product-resolver": { loadProductResolver: async () => productResolver },
  });
  const service = load("src/features/sales-upload/service.server.ts") as typeof import("./service.server");

  const preview = await service.analyzeSalesUpload(ADMIN, BUFFER, "Sales 01-10 To 09-10-26.xlsx", { seasonMonthId: "m1" });
  assert.deepEqual([preview.dealersFound, preview.unknownDealers.length, preview.rowsToImport, preview.duplicatesMerged], [2, 0, 3, 1], "both real dealers matched; no product row became an unknown dealer");
  const ganesh = preview.report!.officers[0]!.dealers.find((d) => d.dealerName === "Ganesh Agro berla CG")!;
  assert.equal(JSON.stringify(ganesh.products.map((x) => [x.productName, x.importedQty, Math.round(x.amount * 100) / 100, x.status])), JSON.stringify([["BLACK CAT", 0, -1655.93, "Imported"], ["MAXX OPEN", 20, 30219.05, "Imported"]]), "preview shows the signed amounts under Ganesh");
  assert.equal(Math.round(preview.report!.summary.totalAmount * 100) / 100, 33563.12, "preview total = every signed amount (5,000 + 28,563.12)");

  const result = await service.commitSalesUpload(ADMIN, BUFFER, "Sales 01-10 To 09-10-26.xlsx", { seasonMonthId: "m1" });
  const saved = Object.fromEntries(created.map((c) => [c.planLineId, [c.saleQty, Math.round((c.saleValue as number) * 100) / 100]]));
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { "pl-bc": [0, -1655.93], "pl-mo": [20, 30219.05], "pl-o": [10, 5000] }, "commit stores quantity 0 / -1655.93 for BLACK CAT and 20 / 30219.05 for MAXX OPEN, the other dealer unchanged");
  assert.deepEqual([result.rowsImported, result.dealersUpdated, result.unknownDealers], [3, 2, 0]);
  assert.equal(runs.length, 1, "one run record");
}

/* ---------------------------------------------- Scheme Upload: same parser, isolated persistence ---------------------------------------------- */
{
  let incomingSeen: Map<string, { qty: number; value: number }> | null = null;
  const prisma = { scheme: { findMany: async () => [{ id: "sc1", schemeName: "S1", requirementType: "QUANTITY_BASED", valueMode: null, isPerpetual: true, startDate: null, endDate: null }] }, schemeUploadBatchScheme: { findFirst: async () => null } };
  const load = testLoader({
    "@/lib/prisma": { prisma }, "@/lib/http": { ApiError: TestApiError }, "@/lib/audit": { writeAudit: async () => undefined },
    "@/lib/dealer-resolver": { loadDealerResolver: async () => dealerResolver }, "@/lib/product-resolver": { loadProductResolver: async () => productResolver },
    "./scheme-achievement.server": {
      loadSchemeRequirements: async () => new Map([["sc1", { type: "QUANTITY_BASED", valueMode: null, combinedRequiredValue: null, products: [{ productId: "p-bc" }, { productId: "p-mo" }] }]]),
      loadEnrolledDealerIds: async () => new Map([["sc1", ["d-ganesh"]]]),
      loadSchemeOptionConfig: async () => new Map(), loadOptionSnapshotTargets: async () => new Map(),
      computeSchemeUploadImpact: async (_c: unknown, _s: unknown, _r: unknown, incoming: typeof incomingSeen) => { incomingSeen = incoming; return { rows: [] }; },
      computeSchemeOptionUploadImpact: async () => ({ rows: [] }),
    },
  });
  const scheme = load("src/features/schemes/scheme-upload.server.ts") as typeof import("@/features/schemes/scheme-upload.server");
  const a = await scheme.analyzeSchemeUpload(ADMIN, BUFFER, "f.xlsx", { startDate: "2026-10-01", endDate: "2026-10-09", schemeIds: ["sc1"] });
  assert.deepEqual([a.parsedDealers, a.unmatchedDealers.length, a.unmatchedProducts.length], [2, 0, 0], "Scheme Upload sees the 2 real dealers (not product rows as dealers)");
  const facts = [...incomingSeen!.entries()].map(([k, f]) => [...k.split("|"), f.qty, f.value]).sort();
  assert.equal(JSON.stringify(facts), JSON.stringify([["d-ganesh", "p-bc", 0, -1655.93], ["d-ganesh", "p-mo", 20, 30219.05]]), "the achievement engine receives Ganesh's BLACK CAT and MAXX OPEN facts, for the enrolled dealer only");
  assert.deepEqual([a.schemes[0]!.incomingQty, a.schemes[0]!.incomingValue], [20, 28563.12], "scheme totals follow the same facts");
}
  console.log("parser-consumers.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
