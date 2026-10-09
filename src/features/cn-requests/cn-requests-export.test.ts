/** CN Requests → Export Excel (Admin): the four tabs, the five fixed columns, every authorized row, scope / authorization, empty and missing values. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { Role } from "@prisma/client";
import { testLoader, TestApiError } from "@/features/dealer-tags/test-loader";
import { DEFAULT_LABELS } from "@/features/labels/labels";
import { CN_EXPORT_COLUMNS, CN_REQUEST_STATUSES, NO_CN_EXPORT_MESSAGE, cnExportFilename, toCnExportRows, type CnRequestView } from "@/lib/cn-request";
import { apiPermission } from "@/features/accounts/route-permissions";
import type { AuthContext } from "@/lib/http";

interface Row { id: string; officerId: string; dealerId: string; cnType: string; status: string; paymentStatus: string | null; paymentVerified: boolean; dealer: string; officer: string; territory: string | null; state: string | null }
let rows: Row[] = [];
let findManyCalls = 0;
let labelOverrides: Record<string, string> = {};
const ST = CN_REQUEST_STATUSES;
const seed = (id: string, status: string, o: Partial<Row> = {}) => rows.push({ id, officerId: "so-1", dealerId: `d-${id}`, cnType: "CD", status, paymentStatus: "Pending", paymentVerified: false, dealer: `Dealer ${id}`, officer: "Officer One", territory: "North", state: "State One", ...o });

const prisma = {
  cnRequest: {
    findMany: async ({ where }: { where: { officerId?: { in: string[] }; status?: { in: string[] }; paymentStatus?: string; paymentVerified?: boolean; OR?: { paymentStatus?: null | { not: string }; paymentVerified?: boolean }[] } }) => {
      findManyCalls++;
      return rows
        .filter((r) => !where.officerId || where.officerId.in.includes(r.officerId))
        .filter((r) => !where.status || where.status.in.includes(r.status))
        .filter((r) => where.paymentStatus === undefined || r.paymentStatus === where.paymentStatus)
        .filter((r) => where.paymentVerified === undefined || r.paymentVerified === where.paymentVerified)
        .filter((r) => !where.OR || where.OR.some((c) => (c.paymentVerified !== undefined ? r.paymentVerified === c.paymentVerified : c.paymentStatus === null ? r.paymentStatus == null : r.paymentStatus !== (c.paymentStatus as { not: string }).not)))
        .map((r) => ({ ...r, amount: 5000, postedAmount: null, details: "secret details", createdAt: new Date("2026-09-22T06:00:00Z"), acceptedAt: null, rejectedAt: null, postedAt: null,
          dealer: { name: r.dealer }, officer: { name: r.officer, territory: r.territory, group: r.state ? { name: r.state } : null } }));
    },
  },
  $queryRaw: async () => rows.map((r) => ({ id: r.id, paymentVerified: r.paymentVerified })),
};
class FakeNextResponse { constructor(public body: unknown, public init: { status?: number; headers?: Record<string, string> } = {}) {} get status() { return this.init.status ?? 200; } static json(body: unknown, init: { status?: number } = {}) { return new FakeNextResponse(body, init); } }
let session: AuthContext = { userId: "admin-1", role: Role.SUPER_ADMIN, username: "admin", groupId: null };
const load = testLoader({
  "@/lib/prisma": { prisma },
  "@/lib/api-error": { ApiError: TestApiError },
  "@/lib/http": { ApiError: TestApiError, requireAuth: async () => session },
  "next/server": { NextResponse: FakeNextResponse },
  "@/lib/scope": { getOfficerScope: async (ctx: AuthContext) => ctx.role === Role.SUPER_ADMIN || ctx.role === Role.CUSTOM_ADMIN ? { all: true, ids: [] } : ctx.role === Role.REGIONAL_MANAGER ? { all: false, ids: [ctx.userId, "so-1"] } : { all: false, ids: [ctx.userId] } },
  "@/lib/audit": { writeAudit: async () => undefined },
  "@/lib/dealer-display-name.server": { loadDealerAliasNameMap: async () => new Map(), resolveDealerDisplayNames: async () => new Map(), decorateDealerNames: async (r: unknown[]) => r, dealerDisplayName: (n: string) => n },
  "@/lib/daily-work": { currentBusinessDate: () => "2026-10-09" },
  "@/features/daily-work/day-lock.server": { lockDailyWorkDay: async () => ({}) },
  "@/features/daily-work/auto-task-materialization.server": { reverseMaterializedDailyWorkContribution: async () => undefined },
  "@/features/labels/service.server": { getResolvedLabels: async () => ({ ...DEFAULT_LABELS, ...labelOverrides }) },
});
const route = load<{ GET: (req: { nextUrl: { searchParams: URLSearchParams } }) => Promise<FakeNextResponse> }>("src/app/api/cn-requests/export/route.ts");
const call = (view: string | null) => route.GET({ nextUrl: { searchParams: new URLSearchParams(view ? { view } : {}) } });
const sheet = async (res: FakeNextResponse) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0]);
  assert.equal(wb.worksheets.length, 1);
  const ws = wb.worksheets[0]!;
  const grid: string[][] = [];
  ws.eachRow((row) => grid.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ""))));
  return { ws, grid };
};

async function main() {

  const HEAD = ["Dealer", "CN Type", "Employee Name", "State", "Territory"];
  assert.deepEqual(CN_EXPORT_COLUMNS.map((c) => c.label), HEAD, "the five columns, in order");

  // Seed: Submitted ×3, Rejected ×2, CN Working Shared ×2 (+ one posted-then-returned), Posted in Ledger ×2 (one legacy status).
  seed("s1", ST.SUBMITTED); seed("s2", ST.SUBMITTED, { cnType: "Freight" }); seed("s3", ST.SUBMITTED, { officerId: "so-9", officer: "Officer Nine", dealer: "Other Dealer" });
  seed("r1", ST.REJECTED); seed("r2", ST.REJECTED, { cnType: "Damage" });
  seed("w1", ST.ACCEPTED_NOT_POSTED); seed("w2", ST.ACCEPTED_NOT_POSTED, { paymentStatus: "Paid", paymentVerified: false });
  seed("w3", ST.POSTED_IN_LEDGER, { paymentStatus: "Partial Paid" }); // returned from ledger → shows in CN Working Shared
  seed("p1", ST.POSTED_IN_LEDGER, { paymentStatus: "Paid", paymentVerified: true }); seed("p2", ST.LEGACY_ACCEPTED, { paymentStatus: "Paid", paymentVerified: true, dealer: "Legacy Dealer" });

  // 1. Each tab exports exactly its own requests, with only the five columns in order.
  const expectDealers: Record<CnRequestView, string[]> = {
    submitted: ["Dealer s1", "Dealer s2", "Other Dealer"], rejected: ["Dealer r1", "Dealer r2"],
    "accepted-not-posted": ["Dealer w1", "Dealer w2", "Dealer w3"], "posted-in-ledger": ["Dealer p1", "Legacy Dealer"],
  };
  for (const view of Object.keys(expectDealers) as CnRequestView[]) {
    const res = await call(view);
    assert.equal(res.status, 200, view);
    assert.equal(res.init.headers!["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const { grid, ws } = await sheet(res);
    assert.deepEqual(grid[0], HEAD, `${view}: header`);
    assert.ok(grid.every((r) => r.length === 5), `${view}: exactly five columns`);
    assert.deepEqual(grid.slice(1).map((r) => r[0]).sort(), [...expectDealers[view]].sort(), `${view}: only that tab's requests`);
    assert.equal(ws.getRow(1).font?.bold, true, "bold header row");
    assert.ok(ws.columns.every((c) => (c.width ?? 0) >= 18), "readable column widths");
    assert.equal(ws.columnCount, 5);
  }
  assert.deepEqual((await sheet(await call("submitted"))).grid.slice(1).find((r) => r[0] === "Dealer s2"), ["Dealer s2", "Freight", "Officer One", "State One", "North"]);
  assert.equal((await sheet(await call("rejected"))).grid.slice(1).find((r) => r[0] === "Dealer r2")![1], "Damage/Expiry", "legacy Damage reads as Damage/Expiry");
  assert.equal((await sheet(await call("submitted"))).grid[1]![1], "Price diff", "CN Type is the displayed label");
  labelOverrides = { "cn_requests.cn_type.price_difference": "Rate Difference" };
  assert.equal((await sheet(await call("submitted"))).grid[1]![1], "Rate Difference", "a configured CN Type label is used");
  labelOverrides = {};
  // nothing but the five fields leaves the server
  const everything = (await Promise.all((["submitted", "rejected", "accepted-not-posted", "posted-in-ledger"] as const).map(async (v) => (await sheet(await call(v))).grid.flat().join("|")))).join("|");
  assert.ok(!/5000|secret details|\bd-[a-z0-9]+\b|Pending|Paid|SUBMITTED/.test(everything), "no amount, payment, details, id or status is exported");

  // 2. Not limited to a page: 300 matching requests all come out.
  rows = []; for (let i = 0; i < 300; i++) seed(`bulk${i}`, ST.SUBMITTED, { dealer: `Bulk ${i}` });
  seed("other-tab", ST.REJECTED);
  const bulk = await sheet(await call("submitted"));
  assert.equal(bulk.grid.length - 1, 300, "all 300 matching requests, not one screenful");
  assert.equal(new Set(bulk.grid.slice(1).map((r) => r[0])).size, 300);

  // 3. Missing values never break the export or get invented.
  rows = []; seed("m1", ST.SUBMITTED, { state: null, territory: null, dealer: "No Profile Dealer" });
  assert.deepEqual((await sheet(await call("submitted"))).grid[1], ["No Profile Dealer", "Price diff", "Officer One", "", ""]);
  assert.deepEqual(toCnExportRows([{ partyName: null, cnType: null, employeeName: null, state: null, territory: null }]), [{ dealer: "", cnType: "", employeeName: "", state: "", territory: "" }]);

  // 4. Empty result: a clear message, no file.
  rows = [];
  const empty = await call("posted-in-ledger");
  assert.equal(empty.status, 422);
  assert.equal((empty.body as { error: string }).error, NO_CN_EXPORT_MESSAGE, "message, not an empty workbook");
  assert.ok(!(empty.body instanceof Buffer));

  // 5. Authorization is enforced on the endpoint itself.
  seed("a1", ST.SUBMITTED); seed("a2", ST.SUBMITTED, { officerId: "so-2", officer: "Officer Two" });
  findManyCalls = 0;
  for (const ctx of [
    { userId: "so-1", role: Role.SALES_OFFICER, username: "so", groupId: "g" },
    { userId: "rm-1", role: Role.REGIONAL_MANAGER, username: "rm", groupId: "g" },
  ] as AuthContext[]) {
    session = ctx;
    const res = await call("submitted");
    assert.equal(res.status, 403, `${ctx.role} cannot export`);
    assert.equal((res.body as { error: string }).error, DEFAULT_LABELS["cn_requests.error.admin_export_only"]);
  }
  assert.equal(findManyCalls, 0, "no CN data is read for a caller who may not export");
  session = { userId: "ca-1", role: Role.CUSTOM_ADMIN, username: "ca", groupId: null, permissions: { reports: ["read"] } } as unknown as AuthContext;
  assert.equal((await call("submitted")).status, 403, "an Admin without CN Requests access is refused");
  session = { userId: "ca-1", role: Role.CUSTOM_ADMIN, username: "ca", groupId: null, permissions: { cnRequests: ["read"] } } as unknown as AuthContext;
  assert.equal((await sheet(await call("submitted"))).grid.length - 1, 2, "a CN Requests Admin exports all requests");
  session = { userId: "admin-1", role: Role.SUPER_ADMIN, username: "admin", groupId: null };
  assert.equal((await call("bogus")).status, 400, "unknown tab");
  assert.equal((await call(null)).status, 400, "missing tab");
  assert.deepEqual(apiPermission("/api/cn-requests/export", "GET"), ["cnRequests", "read"], "route permission: CN Requests read (the service additionally requires an Admin)");

  // 6. File names.
  const d = new Date("2026-10-09T08:00:00Z");
  assert.deepEqual((["submitted", "rejected", "accepted-not-posted", "posted-in-ledger"] as const).map((v) => cnExportFilename(v, d)), [
    "CN-Requests-Submitted-2026-10-09.xlsx", "CN-Requests-Rejected-2026-10-09.xlsx", "CN-Requests-CN-Working-Shared-2026-10-09.xlsx", "CN-Requests-Posted-in-Ledger-2026-10-09.xlsx",
  ]);
  rows = []; seed("f1", ST.SUBMITTED);
  assert.match((await call("submitted")).init.headers!["Content-Disposition"]!, /^attachment; filename="CN-Requests-Submitted-\d{4}-\d{2}-\d{2}\.xlsx"$/);

  // 7. UI wiring: Admin-only button on both tab rows, busy state, no duplicate request, empty tab message without a download.
  const ui = readFileSync("src/features/cn-requests/cn-requests-page.tsx", "utf8");
  assert.equal((ui.match(/\{exportButton\}/g) ?? []).length, 2, "one Export Excel button beside the Submitted/Rejected tabs and the Accepted tabs");
  assert.ok(ui.includes("const exportButton = isAdmin ?") && ui.includes("if (exporting) return;") && ui.includes("disabled={exporting || isLoading}") && ui.includes("labels.exporting"), "Admin only, loading state, duplicate clicks ignored");
  assert.ok(ui.includes("api/cn-requests/export?view=${encodeURIComponent(view)}") && ui.includes("rows.length === 0") && ui.includes("labels.exportEmpty"), "exports the selected tab; empty tab → message");
  const fn = ui.slice(ui.indexOf("const exportExcel"), ui.indexOf("const exportButton"));
  assert.ok(!/rows[!?]?\.(map|filter|forEach)/.test(fn) && !/xlsx|exceljs/i.test(fn), "the file is never built from the on-screen rows");
  assert.ok(DEFAULT_LABELS["cn_requests.action.export_excel"] === "Export Excel");
  console.log("cn-requests-export.test.ts — all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
