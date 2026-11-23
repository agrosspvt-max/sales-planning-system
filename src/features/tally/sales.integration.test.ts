/** Synthetic database only. Never accepts an application/Neon URL. */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import * as db from "@prisma/client";
import { z } from "zod";
import * as billwise from "./billwise";
import * as changes from "./changes";
import * as sales from "./sales";
import { salesMonths } from "./sales-range";
import { figuresForMode, nbv, isQuantityMode } from "@/lib/calc";
import { summarizeTerritoryDealers } from "@/features/planning/group-dealer-summary";
const url = process.env.TALLY_DISPOSABLE_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "localhost" ||
  !new URL(url).searchParams.get("host")?.startsWith("/tmp/tally-test-pg.")
)
  throw Error("Disposable synthetic DB required");
process.env.DATABASE_URL = url;
process.env.TALLY_SYNC_ENABLED = "true";
process.env.TALLY_SALES_SYNC_ENABLED = "true";
process.env.TALLY_EXPECTED_DB_HOST = "localhost";
const prisma = new db.PrismaClient({
  datasources: { db: { url } },
  log: [{ emit: "event", level: "query" }],
});
let planLineInsertQueries = 0,
  monthlyWriteQueries = 0;
prisma.$on("query", (event) => {
  if (/INSERT INTO ["\w.]*"PlanLine"/.test(event.query)) planLineInsertQueries++;
  if (/INSERT INTO "MonthlyEntry"/.test(event.query)) monthlyWriteQueries++;
});
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let missingLedgerZeroPolicy = true;
let companyActualsEnabled = false;
const require = createRequire(import.meta.url),
  modules: Record<string, unknown> = {
    "server-only": {},
    "./sales-rollout": {
      approvedTestPreview: () => companyActualsEnabled,
      salesSyncEnabled: () => process.env.TALLY_SALES_SYNC_ENABLED === "true",
      missingSalesLedgerAsZeroEnabled: () => missingLedgerZeroPolicy,
    },
    "@prisma/client": db,
    zod: { z },
    "@/lib/prisma": { prisma },
    "@/lib/http": { ApiError },
    "./billwise": billwise,
    "./changes": changes,
    "./sales": sales,
    "@/lib/audit": { writeAudit: async () => {} },
  };
function load<T>(file: string): T {
  const code = ts.transpileModule(readFileSync(resolve(file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    mod = { exports: {} };
  runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    require: (name: string) => modules[name] ?? require(name),
    process,
    console,
    Date,
    Math,
    Set,
    Map,
    Buffer,
    JSON,
    URL,
  });
  return mod.exports as T;
}
modules["./sales-party-names"] = load("src/features/tally/sales-party-names.ts");
modules["@/features/tally/sales-party-names"] = modules["./sales-party-names"];
modules["./sales-range"] = load("src/features/tally/sales-range.ts");
modules["@/lib/import/workbook"] = {};
modules["@/lib/match-key"] = load("src/lib/match-key.ts");
modules["@/lib/product-merge"] = load("src/lib/product-merge.ts");
modules["@/features/sales-upload/parser"] = load("src/features/sales-upload/parser.ts");
modules["@/lib/product-resolver"] = load("src/lib/product-resolver.ts");
modules["./service.server"] = load("src/features/tally/service.server.ts");
const svc = load<typeof import("./sales.server")>("src/features/tally/sales.server.ts");
const today = billwise.indiaDay(),
  month = today.slice(0, 7),
  prefix = "cb293b57-f31b-464e-b2e1-42d4edb59b7d",
  anchor = prefix + "-00002385";
const actor = {
  userId: "sales-admin",
  username: "sales-admin",
  role: db.Role.SUPER_ADMIN,
  groupId: null,
};
let connectionId = "",
  credential = "";
async function call(body: unknown, otherCredential = credential) {
  return svc.salesAgent(
    new Request("https://test.example/api/tally/sales-agent", {
      method: "POST",
      headers: { "x-agent-id": connectionId, authorization: "Bearer " + otherCredential },
    }),
    body,
  ) as Promise<any>;
}
async function claim() {
  return (await call({ action: "claim", requestId: randomUUID() })).job;
}
function result(
  job: any,
  items: any[] = [
    {
      lineNo: 0,
      stockItemName: "Product 10X1L",
      quantity: "14.400000",
      amount: "1040.00",
      unit: "L",
      actualQty: "14.4 L",
      billedQty: "14.4 L",
      rate: "",
    },
  ],
) {
  return {
    version: "sales.sync.v1",
    companyName: job.companyName,
    monthKey: job.monthKey,
    fromDate: job.fromDate,
    throughDate: job.throughDate,
    observedAt: new Date().toISOString(),
    sourceHash: "a".repeat(64),
    controlMarkerCount: 0,
    anchorGuid: anchor,
    ledgers: [
      { name: "NEW MAURYA BEEJ BHANDAR-SIKRIGANJ UP", guid: anchor },
      { name: "Dealer A", guid: prefix + "-00000002" },
      { name: "Dealer B", guid: prefix + "-00000003" },
    ],
    vouchers: [
      {
        guid: prefix + "-00000001",
        masterId: "1",
        alterId: "1",
        billDate: job.fromDate,
        billNumber: "S1",
        typeName: "CASH SALE-CG",
        family: "Sales",
        partyName: "Dealer A",
        cancelled: false,
        optional: false,
        ledgerEntries: [],
        items,
      },
    ],
  };
}
async function stage(job: any, data: any) {
  const payload = JSON.stringify(data),
    ids = { jobId: job.id, leaseToken: job.leaseToken },
    chunks = Array.from({ length: Math.ceil(payload.length / 32768) }, (_, i) =>
      payload.slice(i * 32768, (i + 1) * 32768),
    );
  await call({
    action: "begin",
    ...ids,
    manifest: { chunks: chunks.length, bytes: payload.length, sha256: sales.hashSales(payload) },
  });
  for (let i = 0; i < chunks.length; i++)
    await call({
      action: "chunk",
      ...ids,
      sequence: i,
      hash: sales.hashSales(chunks[i]),
      data: chunks[i],
    });
  return ids;
}
async function refresh(data: (job: any) => any, monthKey = month) {
  await svc.requestSalesRefresh(actor, monthKey);
  const job = await claim();
  assert.ok(job);
  const ids = await stage(job, data(job));
  await call({ action: "complete", ...ids });
  return { job, ids };
}
async function actual(id = "line-a", m = "sales-month") {
  return prisma.monthlyEntry.findUniqueOrThrow({
    where: { planLineId_seasonMonthId: { planLineId: id, seasonMonthId: m } },
  });
}
async function roundtrip() {
  const directory = mkdtempSync(join(tmpdir(), "sales-https-test-"));
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem");
  assert.equal(
    spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    ).status,
    0,
  );
  let exports = 0;
  const envelope = (body: string) =>
    `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${body}</COLLECTION></DATA></BODY></ENVELOPE>`;
  const http = httpServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const xml = Buffer.concat(parts).toString();
    assert.ok(xml.includes("<TALLYREQUEST>Export</TALLYREQUEST>"));
    exports++;
    let reply = "";
    if (xml.includes('<ID TYPE="Name">'))
      reply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><LEDGER NAME="NEW MAURYA BEEJ BHANDAR-SIKRIGANJ UP"><GUID>${anchor}</GUID><PARENT>Test</PARENT><CLOSINGBALANCE>-10.00</CLOSINGBALANCE></LEDGER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    else if (xml.includes("<TYPE>VoucherType</TYPE>"))
      reply = envelope(
        `<VOUCHERTYPE NAME="Sales MP" RESERVEDNAME="Sales"><GUID>${prefix}-00000038</GUID><PARENT>Sales MP</PARENT></VOUCHERTYPE><VOUCHERTYPE NAME="Credit Note" RESERVEDNAME="Credit Note"><GUID>${prefix}-00000036</GUID><PARENT>Credit Note</PARENT></VOUCHERTYPE>`,
      );
    else if (xml.includes("<TYPE>Ledger</TYPE>"))
      reply = envelope(
        `<LEDGER NAME="NEW MAURYA BEEJ BHANDAR-SIKRIGANJ UP"><GUID>${anchor}</GUID></LEDGER><LEDGER NAME="Dealer A"><GUID>${prefix}-00000002</GUID></LEDGER><LEDGER NAME="Dealer B"><GUID>${prefix}-00000003</GUID></LEDGER>`,
      );
    else {
      const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ],
        first = `1-${monthNames[+month.slice(5) - 1]}-${month.slice(0, 4)}`;
      const match =
        xml.includes("<CHILDOF>Sales MP</CHILDOF>") && xml.includes('$$Date:"' + first + '"');
      reply = envelope(
        match
          ? `<VOUCHER><GUID>${prefix}-00000001</GUID><MASTERID>1</MASTERID><ALTERID>3</ALTERID><DATE>${month.replace("-", "")}01</DATE><VOUCHERNUMBER>End-to-end bill</VOUCHERNUMBER><VOUCHERTYPENAME>Sales MP</VOUCHERTYPENAME><PARTYLEDGERNAME>Dealer A</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Product 10X1L</STOCKITEMNAME><BILLEDQTY>37.304 Kg = 2.5 case</BILLEDQTY><ACTUALQTY>37.304 Kg</ACTUALQTY><AMOUNT>123.45</AMOUNT><BATCHNAME>&#4; Not Applicable</BATCHNAME></ALLINVENTORYENTRIES.LIST></VOUCHER>`
          : "",
      );
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(reply);
  });
  const https = httpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      try {
        assert.equal(req.url, "/api/tally/sales-agent");
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const request = new Request("https://localhost/api/tally/sales-agent", {
          method: "POST",
          headers: req.headers as Record<string, string>,
          body: Buffer.concat(parts),
        });
        const reply = await svc.salesAgent(
          request,
          await (modules["./service.server"] as typeof import("./service.server")).readBody(
            request,
          ),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      } catch (e) {
        res.writeHead((e as ApiError).status ?? 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "test request rejected" }));
      }
    },
  );
  try {
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
    await svc.requestSalesRefresh(actor, month);
    const python = `import os,sys,ssl
sys.path.insert(0,os.environ['CONNECTOR_ROOT'])
import connector as c
from sales_worker import SalesWorker,SalesCloud
config=c.load_config(os.path.join(os.environ['CONNECTOR_ROOT'],'config.example.json'))
config.update(tallyUrl=os.environ['MOCK_TALLY'],cloudUrl=os.environ['MOCK_CLOUD'],agentId=os.environ['AGENT'],stateDir=os.environ['STATE'])
context=ssl.create_default_context(cafile=os.environ['CA'])
cloud=SalesCloud(config,token_reader=lambda:os.environ['TOKEN'],tls_context=context,bypass_reader=lambda:None)
worker=SalesWorker(config,cloud=cloud,protect=lambda x:b'TEST'+x,unprotect=lambda x:x[4:],recover_claim=True)
assert worker.tick()
print('Sales: native curl XML -> Python collector -> verified HTTPS -> PostgreSQL passed')
`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python3", ["-B", "-c", python], {
        env: {
          ...process.env,
          CONNECTOR_ROOT: resolvePath("../tally-connector-v1.3/Tally-Office-Connector"),
          MOCK_TALLY: `http://127.0.0.1:${(http.address() as { port: number }).port}/`,
          MOCK_CLOUD: `https://127.0.0.1:${(https.address() as { port: number }).port}`,
          AGENT: connectionId,
          TOKEN: credential,
          STATE: directory,
          CA: cert,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.on("data", (b) => (text += b));
      child.stderr.on("data", (b) => (text += b));
      child.on("close", (code) =>
        code === 0 ? (console.log(text.trim()), resolve()) : reject(new Error(text)),
      );
    });
    assert.equal((await actual()).saleQty.toString(), "37.304");
    assert.equal((await actual()).saleValue?.toString(), "123.45");
    assert.ok(exports >= 6);
    assert.equal(await prisma.tallySalesChunk.count(), 0);
  } finally {
    await new Promise<void>((r) => http.close(() => r()));
    await new Promise<void>((r) => https.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
}
const resolvePath = resolve;
async function main() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "TallyConnection", "User", "Dealer", "Season", "Product" CASCADE',
  );
  await prisma.user.createMany({
    data: [
      {
        id: actor.userId,
        username: actor.username,
        name: "Admin",
        passwordHash: "disabled",
        role: db.Role.SUPER_ADMIN,
      },
      {
        id: "sales-officer",
        username: "sales-officer",
        name: "Officer",
        passwordHash: "disabled",
        role: db.Role.SALES_OFFICER,
      },
    ],
  });
  await prisma.season.create({
    data: { id: "sales-season", name: "Synthetic", year: +today.slice(0, 4) },
  });
  const oldKey = month === "2026-04" ? "2026-04" : "2026-04";
  await prisma.seasonMonth.createMany({
    data: [
      {
        id: "sales-month",
        seasonId: "sales-season",
        name: "Current",
        order: 1,
        calendarYear: +today.slice(0, 4),
        calendarMonth: +today.slice(5, 7),
      },
      {
        id: "sales-old",
        seasonId: "sales-season",
        name: "Historical",
        order: 2,
        calendarYear: 2026,
        calendarMonth: 4,
      },
    ],
  });
  await prisma.seasonPlan.create({
    data: {
      id: "sales-plan",
      seasonId: "sales-season",
      officerId: "sales-officer",
      status: "APPROVED",
      isActiveVersion: true,
    },
  });
  await prisma.product.create({
    data: { id: "sales-product", name: "Product", rate: 100, nbvPercent: "0.5" },
  });
  for (const id of ["a", "b", "held", "noalias"]) {
    await prisma.dealer.create({
      data: { id, name: "Dealer " + id.toUpperCase(), isActive: true, status: "ACTIVE" },
    });
    if (id !== "noalias")
      await prisma.dealerAlias.create({
        data: {
          tallyName: "Dealer " + id.toUpperCase(),
          tallyKey: "dealer" + id,
          systemDealerId: id,
        },
      });
    await prisma.planDealer.create({
      data: { id: "pd-" + id, dealerId: id, seasonPlanId: "sales-plan" },
    });
    await prisma.planLine.create({
      data: { id: "line-" + id, planDealerId: "pd-" + id, productId: "sales-product" },
    });
    await prisma.monthlyEntry.create({
      data: {
        planLineId: "line-" + id,
        seasonMonthId: "sales-month",
        planQty: 77,
        planValue: 999,
        saleQty: 20,
        saleValue: 2000,
      },
    });
  }
  await prisma.monthlyEntry.create({
    data: {
      planLineId: "line-a",
      seasonMonthId: "sales-old",
      planQty: 55,
      saleQty: 999,
      saleValue: 8888,
    },
  });
  await prisma.monthlyEntry.create({
    data: {
      planLineId: "line-noalias",
      seasonMonthId: "sales-old",
      planQty: 44,
      saleQty: 101,
      saleValue: -505,
    },
  });
  const access = await (modules["./service.server"] as typeof import("./service.server")).setup(
    actor,
  );
  connectionId = access.agentId;
  credential = access.token;
  await assert.rejects(
    () => call({ action: "claim", requestId: randomUUID() }, "x".repeat(43)),
    (e: any) => e.status === 401,
  );
  await assert.rejects(
    () => svc.requestSalesRefresh({ ...actor, role: db.Role.SALES_OFFICER }, month),
    (e: any) => e.status === 403,
  );
  const requestId = randomUUID(),
    first = (await call({ action: "claim", requestId })).job,
    resumed = (await call({ action: "claim", requestId })).job;
  assert.ok(
    first.aliases.includes("NEW MAURYA BEEJ BHANDAR-SIKRIGANJ UP"),
    "verified ledger anchor is requested even outside dealer scope",
  );
  assert.equal(first.id, resumed.id);
  assert.notEqual(first.leaseToken, resumed.leaseToken);
  assert.equal(await claim(), null);
  const ids = await stage(resumed, result(resumed));
  await assert.rejects(
    () => call({ action: "complete", jobId: first.id, leaseToken: first.leaseToken }),
    (e: any) => e.status === 409,
  );
  await call({ action: "complete", ...ids });
  assert.equal((await actual()).saleQty.toString(), "14.4");
  assert.equal((await actual()).saleValue?.toString(), "1040");
  assert.equal((await actual()).planQty, 77);
  assert.equal((await actual()).planValue?.toString(), "999");
  assert.equal(
    (await actual("line-b")).saleQty.toString(),
    "0",
    "verified dealer without bills clears previous actuals",
  );
  assert.equal(
    (await actual("line-held")).saleQty.toString(),
    "0",
    "absent configured Tally ledger clears requested month actuals under test rule",
  );
  assert.equal(
    (await actual("line-a", "sales-old")).saleQty.toString(),
    "999",
    "automatic refresh preserves older month",
  );
  assert.equal(await prisma.tallySalesVoucher.count(), 1);
  assert.equal(await prisma.tallySalesItem.count(), 1);
  assert.equal((await call({ action: "complete", ...ids })).duplicate, true);
  assert.equal(await prisma.tallySalesVoucher.count(), 1);
  assert.equal(
    (await actual("line-noalias")).saleQty.toString(),
    "0",
    "no alias and no exact Tally name clears old quantity",
  );
  assert.equal(
    (await actual("line-noalias")).saleValue?.toString(),
    "0",
    "no alias and no exact Tally name clears old amount",
  );
  assert.equal((await actual("line-noalias")).planQty, 77, "zero rule preserves planning figures");
  assert.equal(
    (await actual("line-noalias", "sales-old")).saleQty.toString(),
    "101",
    "zero rule cannot change another month",
  );
  const initialSnapshot = await prisma.tallySalesSnapshot.findUniqueOrThrow({
    where: { connectionId_monthKey: { connectionId, monthKey: month } },
  });
  const initialSummary = initialSnapshot.summary as any;
  assert.ok(initialSummary.zeroed.some((d: any) => d.name === "Dealer NOALIAS"));
  assert.ok(!initialSummary.held.some((d: any) => d.name === "Dealer NOALIAS"));
  // Missing or malformed ledger coverage must not be interpreted as zero sales.
  await prisma.monthlyEntry.update({
    where: {
      planLineId_seasonMonthId: { planLineId: "line-noalias", seasonMonthId: "sales-month" },
    },
    data: { saleQty: 5, saleValue: 500 },
  });
  await svc.requestSalesRefresh(actor, month);
  const invalidCoverage = await claim();
  const incomplete = result(invalidCoverage);
  incomplete.ledgers = [];
  const incompleteIds = await stage(invalidCoverage, incomplete);
  await assert.rejects(
    () => call({ action: "complete", ...incompleteIds }),
    (e: any) => e.status === 409,
  );
  assert.equal(
    (await actual("line-noalias")).saleValue?.toString(),
    "500",
    "failed ledger export keeps prior values",
  );
  assert.equal(
    (await prisma.tallySalesJob.findUniqueOrThrow({ where: { id: invalidCoverage.id } })).error,
    "SALES_LEDGER_COVERAGE_NOT_VERIFIED",
  );
  // No-alias dealer with an exact Tally ledger name still receives actual sales.
  await refresh((j) => {
    const r = result(j);
    r.ledgers.push({ name: "Dealer NOALIAS", guid: prefix + "-00000005" });
    r.vouchers[0].partyName = "Dealer NOALIAS";
    r.vouchers[0].items[0].quantity = "2.500000";
    r.vouchers[0].items[0].amount = "125.00";
    return r;
  });
  assert.equal((await actual("line-noalias")).saleQty.toString(), "2.5");
  assert.equal((await actual("line-noalias")).saleValue?.toString(), "125");
  // A missing old alias contributes zero; it cannot erase a readable current alias.
  await prisma.dealerAlias.create({
    data: { tallyName: "Missing old alias", tallyKey: "missingoldalias", systemDealerId: "a" },
  });
  await refresh((j) => result(j));
  assert.equal((await actual()).saleValue?.toString(), "1040");
  await prisma.dealerAlias.deleteMany({ where: { tallyKey: "missingoldalias" } });
  // The legacy preserve policy still applies outside the pinned test Preview.
  missingLedgerZeroPolicy = false;
  await prisma.monthlyEntry.update({
    where: {
      planLineId_seasonMonthId: { planLineId: "line-noalias", seasonMonthId: "sales-month" },
    },
    data: { saleQty: 7, saleValue: 700 },
  });
  await refresh((j) => result(j));
  assert.equal((await actual("line-noalias")).saleValue?.toString(), "700");
  missingLedgerZeroPolicy = true;
  await refresh((j) => result(j));
  assert.equal((await actual("line-noalias")).saleValue?.toString(), "0");
  // Explicit historical request clears that historical month only, including old credit values.
  await refresh((j) => result(j), oldKey);
  assert.equal((await actual("line-noalias", "sales-old")).saleValue?.toString(), "0");
  assert.equal((await actual("line-noalias", "sales-old")).planQty, 44);
  await roundtrip();
  assert.equal(await claim(), null, "automatic refresh not due before 15 minutes");
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].family = "Credit Note";
    r.vouchers[0].items[0].quantity = "-9.750000";
    r.vouchers[0].items[0].amount = "-120.00";
    return r;
  });
  assert.equal((await actual()).saleQty.toString(), "-9.75");
  assert.equal((await actual()).saleValue?.toString(), "-120");
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].items[0].quantity = "0.000000";
    r.vouchers[0].items[0].amount = "1040.00";
    return r;
  });
  assert.equal(
    (await actual()).saleValue?.toString(),
    "1040",
    "zero qty retains value-only adjustments",
  );
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].items[0].stockItemName = "UNREGISTERED ZETA";
    return r;
  });
  assert.equal(
    (await actual()).saleValue?.toString(),
    "0",
    "a successful month with only unmapped sales replaces stale matched totals",
  );
  await refresh((j) => result(j));
  await refresh((j) => {
    const r = result(j);
    r.vouchers[0].cancelled = true;
    return r;
  });
  assert.equal((await actual()).saleValue?.toString(), "0", "cancelled bill excluded");
  await refresh((j) => {
    const r = result(j);
    r.vouchers = [];
    return r;
  });
  assert.equal((await actual()).saleQty.toString(), "0", "deleted bills replaced, not accumulated");
  await refresh((j) => result(j), oldKey);
  assert.equal(
    (await actual("line-a", "sales-old")).saleQty.toString(),
    "14.4",
    "historical manual refresh",
  );
  assert.equal(
    (await actual()).saleQty.toString(),
    "0",
    "historical refresh cannot overwrite current month",
  );
  await prisma.product.createMany({
    data: [
      { id: "catalog-tricho", name: "TRICHO", rate: 100, nbvPercent: "0.5" },
      { id: "catalog-open", name: "OPEN", rate: 100, nbvPercent: "0.5" },
      { id: "catalog-liner", name: "LINER (1ACER DOSE)", rate: 100, nbvPercent: "0.5" },
    ],
  });
  await refresh((j) =>
    result(j, [
      {
        lineNo: 0,
        stockItemName: "MAXX TRICHO 12X1KG",
        quantity: "12.000000",
        amount: "3300.00",
        unit: "Kg",
        actualQty: "12 Kg",
        billedQty: "12 Kg",
        rate: "",
      },
      {
        lineNo: 1,
        stockItemName: "MAXX OPEN 20X500ML",
        quantity: "10.000000",
        amount: "22950.00",
        unit: "L",
        actualQty: "10 L",
        billedQty: "10 L",
        rate: "",
      },
      {
        lineNo: 2,
        stockItemName: "MAXX OPEN 100 X 25ML",
        quantity: "2.500000",
        amount: "8300.00",
        unit: "L",
        actualQty: "2.5 L",
        billedQty: "2.5 L",
        rate: "",
      },
      {
        lineNo: 3,
        stockItemName: "LINER 8X230ML",
        quantity: "1.840000",
        amount: "1000.00",
        unit: "L",
        actualQty: "1.84 L",
        billedQty: "1.84 L",
        rate: "",
      },
    ]),
  );
  const packRows = await prisma.monthlyEntry.findMany({
    where: {
      seasonMonthId: "sales-month",
      planLine: {
        planDealerId: "pd-a",
        productId: { in: ["catalog-tricho", "catalog-open", "catalog-liner"] },
      },
    },
    include: { planLine: true },
  });
  assert.equal(
    packRows.length,
    3,
    "existing catalog products reused; no pack-specific products created",
  );
  assert.equal(
    packRows.find((r) => r.planLine.productId === "catalog-open")?.saleQty.toString(),
    "12.5",
  );
  assert.equal(
    packRows.find((r) => r.planLine.productId === "catalog-open")?.saleValue?.toString(),
    "31250",
  );
  assert.equal(
    packRows.find((r) => r.planLine.productId === "catalog-tricho")?.saleQty.toString(),
    "12",
  );
  assert.equal(
    packRows.find((r) => r.planLine.productId === "catalog-liner")?.saleQty.toString(),
    "1.84",
  );
  const packs = await prisma.tallySalesItem.findMany({
    where: { voucher: { snapshot: { monthKey: month } } },
    orderBy: { lineNo: "asc" },
  });
  assert.equal(
    packs[0].stockItemName,
    "MAXX TRICHO 12X1KG",
    "original bill/pack name retained for evidence",
  );
  assert.equal((await actual()).planQty, 77, "pack matching preserves planning figures");
  // A first historical import can add hundreds of previously unplanned product lines.
  // Measure actual SQL: these must be bulk inserts, not one round trip per product.
  const bulkProducts = Array.from({ length: 300 }, (_, i) => ({
    id: "bulk-" + i,
    name:
      "CATALOG " +
      String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26)) +
      " PRODUCT",
    rate: 100,
    nbvPercent: "0.5",
  }));
  await prisma.product.createMany({ data: bulkProducts });
  const beforeBulk = planLineInsertQueries;
  const bulkResult = (j: any) => {
    const r = result(j);
    const template = r.vouchers[0].items[0];
    r.vouchers[0].items = bulkProducts.map((p, lineNo) => ({
      ...template,
      lineNo,
      stockItemName: p.name,
    }));
    return r;
  };
  await refresh(bulkResult, oldKey);
  assert.equal(
    planLineInsertQueries - beforeBulk,
    1,
    "300 missing lines require batched SQL, not 300 upserts",
  );
  assert.equal(
    await prisma.planLine.count({
      where: { planDealerId: "pd-a", productId: { startsWith: "bulk-" } },
    }),
    300,
  );
  const oldWriteCount = monthlyWriteQueries;
  await refresh(bulkResult, oldKey);
  assert.equal(
    monthlyWriteQueries,
    oldWriteCount,
    "identical month snapshot must not rewrite unchanged actual rows",
  );
  const bulkSnapshot = await prisma.tallySalesSnapshot.findUniqueOrThrow({
    where: { connectionId_monthKey: { connectionId, monthKey: oldKey } },
  });
  assert.equal(
    await prisma.tallySalesItem.count({ where: { voucher: { snapshotId: bulkSnapshot.id } } }),
    300,
    "bill-wise product evidence is kept even for an unchanged refresh",
  );
  await svc.requestSalesRefresh(actor, month);
  const changed = await claim();
  const staged = await stage(changed, result(changed));
  await prisma.dealerAlias.updateMany({
    where: { systemDealerId: "a" },
    data: { tallyName: "New Dealer Name" },
  });
  await assert.rejects(
    () => call({ action: "complete", ...staged }),
    (e: any) => e.status === 409,
  );
  assert.equal((await actual()).saleValue?.toString(), "0", "scope changes reject atomically");
  assert.equal(
    (await prisma.tallySalesJob.findUniqueOrThrow({ where: { id: changed.id } })).error,
    "SCOPE_CHANGED",
    "scope changes end the job immediately instead of leaving a stuck read",
  );
  // Inclusive range is atomically queued, idempotent while pending, and never combines month snapshots.
  const countBefore = await prisma.tallySalesJob.count();
  await assert.rejects(
    () => svc.requestSalesRefresh(actor, month, "2026-03"),
    (e: any) => e.status === 422,
  );
  assert.equal(await prisma.tallySalesJob.count(), countBefore);
  const range = await svc.requestSalesRefresh(actor, oldKey, month);
  const again = await svc.requestSalesRefresh(actor, oldKey, month);
  assert.equal(range.jobs.length, salesMonths(oldKey, month, today).length);
  assert.deepEqual(JSON.parse(JSON.stringify(again.jobs)), JSON.parse(JSON.stringify(range.jobs)));
  const rangeStatus = await svc.salesRangeStatus(actor, oldKey, month);
  assert.equal(rangeStatus.months.length, range.jobs.length);
  assert.equal(rangeStatus.months[0].job?.status, "QUEUED");
  assert.equal(rangeStatus.months.at(-1)?.job?.status, "QUEUED");
  // Historical queue must not starve the automatic current-month interval.
  await prisma.tallySalesJob.updateMany({
    where: { connectionId, manual: false, monthKey: month },
    data: { createdAt: new Date(Date.now() - 16 * 60000) },
  });
  const priority = await claim();
  assert.equal(priority.monthKey, month);
  await call({
    action: "fail",
    jobId: priority.id,
    leaseToken: priority.leaseToken,
    code: "SALES_COLLECTION_REJECTED",
  });
  const historical = await claim();
  assert.equal(historical.monthKey, oldKey);
  await call({
    action: "fail",
    jobId: historical.id,
    leaseToken: historical.leaseToken,
    code: "SALES_COLLECTION_REJECTED",
  });
  await prisma.tallySalesJob.deleteMany({
    where: { connectionId, status: "QUEUED", monthKey: { not: month } },
  });
  // Exercise the real territory query with current assignments and a synced month that
  // has approved, draft, pending, missing-month and missing-season plan cases.
  companyActualsEnabled = true;
  await prisma.tallySalesJob.deleteMany({ where: { connectionId, status: "QUEUED" } });
  const group = await prisma.userGroup.create({ data: { name: "Synthetic Territory" } });
  await prisma.user.update({ where: { id: "sales-officer" }, data: { groupId: group.id } });
  await prisma.monthlyPlan.create({
    data: {
      seasonPlanId: "sales-plan",
      seasonMonthId: "sales-old",
      officerId: "sales-officer",
      status: "APPROVED",
    },
  });
  const testCases = [
    { suffix: "draft", qty: "1.250000", amount: "125.00", status: "DRAFT", seasonal: true },
    {
      suffix: "pending",
      qty: "2.500000",
      amount: "250.00",
      status: "PENDING_ADMIN",
      seasonal: true,
    },
    { suffix: "missing-month", qty: "4.000000", amount: "400.00", status: null, seasonal: true },
    {
      suffix: "missing-seasonal",
      qty: "-0.750000",
      amount: "-75.00",
      status: null,
      seasonal: false,
    },
  ] as const;
  const additions: ((typeof testCases)[number] & { id: string; guid: string })[] = [];
  for (const [index, entry] of testCases.entries()) {
    const id = "territory-" + entry.suffix;
    await prisma.user.create({
      data: {
        id,
        username: id,
        name: id,
        passwordHash: "disabled",
        groupId: group.id,
        role: db.Role.SALES_OFFICER,
      },
    });
    await prisma.dealer.create({ data: { id, name: id, isActive: true, status: "ACTIVE" } });
    await prisma.dealerAssignment.create({
      data: { dealerId: id, officerId: id, effectiveFrom: new Date("2026-04-01") },
    });
    if (entry.seasonal) {
      await prisma.seasonPlan.create({
        data: {
          id,
          seasonId: "sales-season",
          officerId: id,
          status: "DRAFT",
          dealers: { create: { dealerId: id } },
        },
      });
      if (entry.status)
        await prisma.monthlyPlan.create({
          data: {
            seasonPlanId: id,
            seasonMonthId: "sales-old",
            officerId: id,
            status: entry.status,
          },
        });
    }
    additions.push({ ...entry, id, guid: prefix + "-" + String(900 + index).padStart(8, "0") });
  }
  const beforePlans = await prisma.monthlyPlan.count();
  await refresh((job) => {
    const out = result(job);
    const approvedVoucher = { ...out.vouchers[0], partyName: "New Dealer Name" };
    out.ledgers = [
      out.ledgers[0],
      { name: "New Dealer Name", guid: prefix + "-00000002" },
      ...additions.map(({ id, guid }) => ({ name: id, guid })),
    ];
    out.vouchers = [
      approvedVoucher,
      ...additions.map(({ id, guid, qty, amount }) => {
        assert.ok(job.aliases.includes(id), "claim verifies ledgers even without a plan");
        return {
          ...approvedVoucher,
          guid,
          partyName: id,
          family: amount.startsWith("-") ? "Credit Note" : "Sales",
          items: [{ ...approvedVoucher.items[0], quantity: qty, amount }],
        };
      }),
    ];
    return out;
  }, oldKey);
  assert.equal(await prisma.monthlyPlan.count(), beforePlans);
  const actuals = await prisma.tallySalesActual.findMany({
    where: { snapshot: { monthKey: oldKey } },
    select: { dealerId: true, quantity: true },
  });
  assert.equal(actuals.length, 5);
  assert.equal(
    actuals.find((a) => a.dealerId === "territory-missing-seasonal")?.quantity.toString(),
    "-0.75",
  );

  modules["./territory-sales"] = load("src/features/planning/territory-sales.ts");
  modules["./group-plan-metrics"] = load("src/features/planning/group-plan-metrics.ts");
  modules["@/features/tally/sales-rollout"] = modules["./sales-rollout"];
  modules["@/features/accounts/permissions"] = {
    isAdministrativeRole: (role: string) => role === "SUPER_ADMIN",
  };
  modules["./season-months"] = load("src/lib/season-months.ts");
  modules["@/lib/season-calendar"] = load("src/lib/season-calendar.ts");
  modules["@/lib/calc"] = { figuresForMode, nbv, isQuantityMode };
  modules["@/features/users/catalogue.server"] = { clearanceMapForGroup: async () => new Map() };
  modules["@/features/products/merge.server"] = {
    loadEffectiveProduct: async () => ({ effId: (id: string) => id, meta: () => null }),
  };
  modules["@/lib/dealer-display-name.server"] = { loadDealerAliasNameMap: async () => new Map() };
  modules["@/lib/dealer-ownership"] = load("src/lib/dealer-ownership.ts");
  modules["@/lib/scope"] = load("src/lib/scope.ts");
  const territory = load<typeof import("@/features/planning/group-plan.server")>(
    "src/features/planning/group-plan.server.ts",
  );
  const report = async (
    buckets: ("approved" | "draft" | "submitted")[],
    includeUnplanned: boolean,
    view: "month" | "total" | "range" = "month",
    officerId?: string,
    monthIds = ["sales-old"],
  ) =>
    territory.getGroupProductPlan(actor, group.id, "sales-season", {
      buckets,
      includeUnplanned,
      view,
      monthIds,
      officerId,
    });
  const amount = (r: Awaited<ReturnType<typeof report>>) =>
    r.products.reduce((sum, p) => sum + p.actual.amount, 0);
  assert.equal(amount(await report(["approved"], false)), 1040);
  assert.equal(amount(await report([], true)), 700);
  assert.equal(amount(await report(["approved"], true)), 1740);
  assert.equal(
    amount(await report(["approved", "draft", "submitted"], true, "range")),
    1740,
    "draft/pending and Unplanned overlap only once",
  );
  assert.equal(
    amount(await report(["approved"], true, "month", "territory-missing-seasonal")),
    -75,
  );
  const novemberAmount = amount(await report(["approved"], true, "month", undefined, ["sales-month"]));
  const combined = await report(["approved"], true, "total");
  assert.equal(amount(combined), 1740 + novemberAmount);
  assert.equal(
    combined.products.flatMap((p) => p.drawer).reduce((sum, d) => sum + d.periodSales.amount, 0),
    1740 + novemberAmount,
  );
  const dealerReport = async (filter: Parameters<typeof territory.getGroupProductPlan>[3]) => {
    const result = await territory.getGroupProductPlan(actor, group.id, "sales-season", {
      ...filter,
      groupBy: "dealer",
    });
    return summarizeTerritoryDealers(result.dealerProducts ?? [], "", []);
  };
  const dealerApril = await dealerReport({
    buckets: ["approved"], includeUnplanned: true, view: "month", monthIds: [], fromMonthId: "sales-old",
  });
  const dealerA = dealerApril.find((r) => r.dealerId === "a");
  assert.equal(dealerA?.planAmount, 5500);
  assert.equal(dealerA?.planNbv, 2750);
  assert.equal(dealerA?.actualAmount, 1040);
  assert.equal(dealerA?.actualNbv, 520);
  assert.equal(dealerA?.products.find((p) => p.productId === "sales-product")?.productName, "Product");
  assert.equal(dealerA?.products.find((p) => p.productId === "sales-product")?.actualQty, 14.4);
  for (const dealer of dealerApril) {
    assert.equal(dealer.products.reduce((sum, product) => sum + product.actualAmount, 0), dealer.actualAmount);
  }
  assert.equal(dealerApril.reduce((sum, d) => sum + d.actualAmount, 0), 1740);
  const unplannedOnly = await dealerReport({
    buckets: [], includeUnplanned: true, view: "month", monthIds: [], fromMonthId: "",
    officerId: "territory-missing-seasonal",
  });
  assert.equal(unplannedOnly.length, 1);
  assert.equal(unplannedOnly[0].actualAmount, -75);
  assert.equal(unplannedOnly[0].actualNbv, -37.5);
  assert.equal(unplannedOnly[0].planAmount, 0);
  assert.equal(unplannedOnly[0].products[0].actualQty, -0.75);
  const dealerSeason = await dealerReport({
    buckets: ["approved"], includeUnplanned: true, view: "total", monthIds: [],
  });
  const dealerRange = await dealerReport({
    buckets: ["approved"], includeUnplanned: true, view: "range", monthIds: [],
    fromMonthId: "sales-month", toMonthId: "sales-old",
  });
  assert.equal(dealerSeason.find((r) => r.dealerId === "a")?.planAmount, 5500);
  assert.equal(JSON.stringify(dealerSeason), JSON.stringify(dealerRange));
  assert.equal(dealerSeason.reduce((sum, d) => sum + d.actualAmount, 0), 1740 + novemberAmount);
  const filtered = summarizeTerritoryDealers(
    [
      { ...unplannedOnly[0].products[0], nbvPercent: 0.5 },
      { ...unplannedOnly[0].products[0], productId: "other", nbvPercent: 0.25, actualAmount: 25, actualNbv: 6.25 },
    ],
    "half",
    [{ id: "half", name: "Half", nbvPercent: 0.5, notation: null, color: null }],
  );
  assert.equal(filtered[0].actualAmount, -75, "filter products before combining dealer amounts");
  assert.equal(filtered[0].products.length, 1, "drawer sees the same category-filtered products");
  console.log("Territory dealer plans, consistent actuals, month selection, and category filtering: PASS");
  console.log("Territory approval filters, missing-plan capture, returns and deduplication: PASS");

  modules["./group-plan.server"] = territory;
  modules["./dealer-sales-breakdown"] = load("src/features/planning/dealer-sales-breakdown.ts");
  const billService = load<typeof import("@/features/planning/dealer-sales-bills.server")>(
    "src/features/planning/dealer-sales-bills.server.ts",
  );
  const billFilter = {
    buckets: ["approved"] as const,
    includeUnplanned: false,
    view: "month" as const,
    monthIds: [],
    fromMonthId: "sales-old",
  };
  const readBills = (
    dealerId: string,
    changes: Partial<Parameters<typeof territory.getGroupProductPlan>[3]> = {},
  ) =>
    billService.getDealerSalesBills(actor, group.id, "sales-season", dealerId, {
      ...billFilter,
      buckets: ["approved"],
      ...changes,
    });
  const billA = await readBills("a");
  assert.equal(billA.bills.length, 1);
  assert.equal(billA.bills[0].number, "S1");
  assert.equal(billA.bills[0].date, oldKey + "-01");
  assert.equal(billA.bills[0].items[0].productName, "Product 10X1L");
  assert.equal(billA.bills[0].items[0].productId, "sales-product");
  assert.equal(billA.bills[0].items[0].quantity, 14.4);
  assert.equal(billA.bills[0].items[0].amount, dealerA!.actualAmount);
  assert.equal(
    billA.productBreakdown!.find((row) => row.productId === "sales-product")!.reconciled,
    true,
  );
  // The source split explains the saved net; reading it must never republish actuals.
  const sourceBill = await prisma.tallySalesVoucher.findUniqueOrThrow({
    where: { id: billA.bills[0].id },
    include: { items: true },
  });
  const splitActualKey = {
    snapshotId: sourceBill.snapshotId,
    dealerId: "a",
    productId: "sales-product",
  };
  const beforeSplitActual = await prisma.tallySalesActual.findUniqueOrThrow({
    where: { snapshotId_dealerId_productId: splitActualKey },
  });
  const splitFixtureIds: string[] = [];
  try {
    for (const [index, row] of [
      { family: "Sales", typeName: "CREDIT SALE-CG", qty: "10", amount: "100" },
      { family: "Credit Note", typeName: "SALES RETURN-CG", qty: "-2", amount: "-20" },
      { family: "Credit Note", typeName: "Credit Note", qty: "0", amount: "-5" },
      { family: "Credit Note", typeName: "Credit Note", qty: null, amount: null },
    ].entries()) {
      const fixture = await prisma.tallySalesVoucher.create({
        data: {
          snapshotId: sourceBill.snapshotId,
          guid: prefix + "-0000888" + index,
          masterId: String(8880 + index),
          alterId: "1",
          billDate: oldKey + "-04",
          billNumber: "SPLIT-" + index,
          typeName: row.typeName,
          family: row.family,
          partyName: sourceBill.partyName,
          cancelled: false,
          optional: false,
          ledgerEntries: row.qty === null ? [{ name: sourceBill.partyName, amount: "12.00" }] : [],
          ...(row.qty !== null
            ? {
                items: {
                  create: {
                    lineNo: 0,
                    stockItemName: sourceBill.items[0].stockItemName,
                    quantity: row.qty,
                    amount: row.amount!,
                    unit: sourceBill.items[0].unit,
                    actualQty: "",
                    billedQty: "",
                    rate: "",
                  },
                },
              }
            : {}),
        },
      });
      splitFixtureIds.push(fixture.id);
    }
    await prisma.tallySalesActual.update({
      where: { snapshotId_dealerId_productId: splitActualKey },
      data: {
        quantity: beforeSplitActual.quantity.add(8),
        amount: beforeSplitActual.amount.add(75),
      },
    });
    const splitRead = await readBills("a");
    assert.equal(splitRead.breakdownAvailable, true);
    const splitProduct = splitRead.productBreakdown!.find(
      (row) => row.productId === "sales-product",
    )!;
    assert.equal(splitProduct.reconciled, true);
    assert.equal(splitProduct.sales.amount, billA.bills[0].items[0].amount + 100);
    assert.equal(splitProduct.returns.amount, -20);
    assert.equal(splitProduct.creditNotes.amount, -5);
    assert.equal(splitProduct.creditNotes.quantity, 0);
    assert.equal(splitProduct.net.amount, Number(beforeSplitActual.amount.add(75)));
    assert.equal(splitRead.bills.find((row) => row.number === "SPLIT-3")!.unallocatedAmount, -12);
    const afterSplitRead = await prisma.tallySalesActual.findUniqueOrThrow({
      where: { snapshotId_dealerId_productId: splitActualKey },
    });
    assert.equal(
      afterSplitRead.amount.toString(),
      beforeSplitActual.amount.add(75).toString(),
      "breakdown read leaves the existing net amount unchanged",
    );
    assert.equal(afterSplitRead.quantity.toString(), beforeSplitActual.quantity.add(8).toString());
  } finally {
    await prisma.tallySalesVoucher.deleteMany({ where: { id: { in: splitFixtureIds } } });
    await prisma.tallySalesActual.update({
      where: { snapshotId_dealerId_productId: splitActualKey },
      data: { quantity: beforeSplitActual.quantity, amount: beforeSplitActual.amount },
    });
  }
  assert.equal((await readBills("territory-draft")).bills.length, 0);
  assert.equal((await readBills("territory-draft", { buckets: ["draft"] })).bills.length, 1);
  assert.equal((await readBills("territory-missing-seasonal")).bills.length, 0);
  const returnBills = await readBills("territory-missing-seasonal", { includeUnplanned: true });
  assert.equal(returnBills.bills.length, 1);
  assert.equal(returnBills.bills[0].family, "Credit Note");
  assert.equal(returnBills.bills[0].items[0].quantity, -0.75);
  assert.equal(returnBills.bills[0].items[0].amount, -75);
  assert.equal(returnBills.breakdownAvailable, true);
  assert.equal(returnBills.productBreakdown!.find((row) => row.productId === "sales-product")!.net.amount, -75, "unplanned negative-only activity remains visible when that same report filter is included");
  assert.equal((await readBills("a", { officerId: "territory-missing-seasonal" })).bills.length, 0);
  assert.equal((await readBills("not-a-dealer")).bills.length, 0);
  await assert.rejects(
    billService.getDealerSalesBills(
      { ...actor, role: db.Role.REGIONAL_MANAGER, groupId: "another-group" },
      group.id,
      "sales-season",
      "a",
      { ...billFilter, buckets: ["approved"] },
    ),
    /own group's planning/,
  );
  await assert.rejects(
    billService.getDealerSalesBills(
      { ...actor, role: db.Role.SALES_OFFICER },
      group.id,
      "sales-season",
      "a",
      { ...billFilter, buckets: ["approved"] },
    ),
    /admin or manager/,
  );
  // Source names must have an exact current attribution; renamed aliases are not guessed.
  await prisma.dealerAlias.updateMany({
    where: { systemDealerId: "a" },
    data: { tallyName: "Alias after publication" },
  });
  assert.equal((await readBills("a")).bills.length, 0);
  await prisma.dealerAlias.updateMany({
    where: { systemDealerId: "a" },
    data: { tallyName: "New Dealer Name" },
  });
  const snapshot = await prisma.tallySalesSnapshot.findFirstOrThrow({
    where: { monthKey: oldKey },
  });
  const diagnosticIds: string[] = [];
  for (const [n, cancelled] of [false, true].entries()) {
    const v = await prisma.tallySalesVoucher.create({
      data: {
        snapshotId: snapshot.id,
        guid: prefix + "-0000999" + n,
        masterId: "test",
        alterId: "test",
        billDate: oldKey + (cancelled ? "-03" : "-02"),
        billNumber: cancelled ? "S1" : "",
        typeName: "Credit Note",
        family: "Credit Note",
        partyName: "New Dealer Name",
        cancelled,
        optional: false,
        ledgerEntries: [],
      },
    });
    diagnosticIds.push(v.id);
  }
  const datedBills = await readBills("a");
  assert.equal(datedBills.bills.length, 3);
  assert.equal(datedBills.bills[0].cancelled, true);
  assert.equal(datedBills.bills[1].number, "");
  assert.equal(datedBills.bills[1].items.length, 0);
  assert.equal(
    datedBills.bills[2].id,
    billA.bills[0].id,
    "duplicate bill numbers remain separate vouchers",
  );
  await prisma.tallySalesVoucher.deleteMany({ where: { id: { in: diagnosticIds } } });
  const allBills = await readBills("a", { view: "total", includeUnplanned: true });
  const rangeBills = await readBills("a", {
    view: "range",
    fromMonthId: "sales-month",
    toMonthId: "sales-old",
    includeUnplanned: true,
  });
  assert.equal(JSON.stringify(allBills), JSON.stringify(rangeBills));
  const outside = await prisma.userGroup.create({ data: { name: "Outside bill group" } });
  await prisma.user.update({ where: { id: "sales-officer" }, data: { groupId: outside.id } });
  assert.equal(
    (await readBills("a")).bills.length,
    0,
    "dealer bills cannot escape current group membership",
  );
  await prisma.user.update({ where: { id: "sales-officer" }, data: { groupId: group.id } });
  console.log(
    "Dealer bill drilldown: exact source lines, exact aliases, dates, duplicate/blank numbers, returns, status/month/range/officer/group/role filters: PASS",
  );

  await prisma.product.create({
    data: { id: "vajeer", name: "VAJEER", rate: 4665, nbvPercent: "0.5" },
  });
  const stockItems = [
    { stockItemName: "MAXX CELODI (50X160)GM", quantity: "150.000000", unit: "Nos", amount: "21750.00" },
    { stockItemName: "VAJEER 50X50ML", quantity: "2.500000", unit: "LITRE", amount: "11662.50" },
    { stockItemName: "VAJEER 50X100ML", quantity: "5.000000", unit: "LITRE", amount: "22475.00" },
  ];
  const mixedVoucher = (job: any) => {
    const out = result(job, stockItems.map((item, lineNo) => ({
      ...item, lineNo, actualQty: `${item.quantity} ${item.unit}`, billedQty: `${item.quantity} ${item.unit}`, rate: "",
    })));
    out.ledgers[1].name = "New Dealer Name";
    out.vouchers[0].partyName = "New Dealer Name";
    return out;
  };
  const mixed = await refresh(mixedVoucher, oldKey);
  const mixedSnapshot = await prisma.tallySalesSnapshot.findUniqueOrThrow({
    where: { connectionId_monthKey: { connectionId, monthKey: oldKey } },
  });
  const mixedSummary = mixedSnapshot.summary as {
    held: { dealerId: string }[];
    unmatchedProductLines: number;
    unmatchedProducts: { dealerId: string; stockItems: string[] }[];
  };
  assert.equal(mixedSummary.unmatchedProductLines, 1);
  const missingProducts = load<typeof import("./missing-products.server")>(
    "src/features/tally/missing-products.server.ts",
  );
  const reportBeforeMapping = await missingProducts.missingProductsStatus(actor);
  const missingCelodi = reportBeforeMapping.products.filter(
    (row) => row.stockItemName === "MAXX CELODI (50X160)GM",
  );
  assert.equal(missingCelodi.length, 1);
  assert.equal(missingCelodi[0].dealerName, "New Dealer Name");
  assert.ok(missingCelodi[0].months.includes(oldKey));
  assert.equal(
    reportBeforeMapping.products.some((row) => row.stockItemName.startsWith("VAJEER")),
    false,
  );
  const celodiItem = await prisma.tallySalesItem.findFirstOrThrow({
    where: { voucher: { snapshotId: mixedSnapshot.id }, stockItemName: "MAXX CELODI (50X160)GM" },
  });
  await prisma.tallySalesItem.create({ data: { ...celodiItem, id: randomUUID(), lineNo: 99 } });
  assert.equal(
    (await missingProducts.missingProductsStatus(actor)).products.filter(
      (row) => row.stockItemName === "MAXX CELODI (50X160)GM",
    ).length,
    1,
  );
  await prisma.tallySalesVoucher.update({
    where: { id: celodiItem.voucherId },
    data: { cancelled: true },
  });
  assert.equal(
    (await missingProducts.missingProductsStatus(actor)).products.some(
      (row) => row.stockItemName === "MAXX CELODI (50X160)GM",
    ),
    false,
  );
  await prisma.tallySalesVoucher.update({
    where: { id: celodiItem.voucherId },
    data: { cancelled: false, optional: true },
  });
  assert.equal(
    (await missingProducts.missingProductsStatus(actor)).products.some(
      (row) => row.stockItemName === "MAXX CELODI (50X160)GM",
    ),
    false,
  );
  await prisma.tallySalesVoucher.update({
    where: { id: celodiItem.voucherId },
    data: { optional: false },
  });
  await prisma.tallySalesItem.delete({
    where: {
      id: (
        await prisma.tallySalesItem.findFirstOrThrow({
          where: { voucherId: celodiItem.voucherId, lineNo: 99 },
        })
      ).id,
    },
  });
  await assert.rejects(
    missingProducts.missingProductsStatus({ ...actor, role: db.Role.SALES_OFFICER }),
    /Super Admin/,
  );
  assert.equal(mixedSummary.held.some((dealer) => dealer.dealerId === "a"), false);
  assert.deepEqual(mixedSummary.unmatchedProducts[0].stockItems, ["MAXX CELODI (50X160)GM"]);
  assert.equal(
    await prisma.tallySalesItem.count({ where: {
      voucher: { snapshotId: mixedSnapshot.id },
      stockItemName: "MAXX CELODI (50X160)GM",
    } }),
    1,
    "unmatched stock line remains available in the stored voucher",
  );
  const vajeerPlanLine = await prisma.planLine.findFirstOrThrow({
    where: { planDealerId: "pd-a", productId: "vajeer" },
  });
  assert.equal((await actual(vajeerPlanLine.id, "sales-old")).saleQty.toString(), "7.5");
  assert.equal((await actual(vajeerPlanLine.id, "sales-old")).saleValue?.toString(), "34137.5");
  assert.equal((await actual("line-a", "sales-old")).saleValue?.toString(), "0");
  assert.equal((await actual("line-a", "sales-old")).planQty, 55);
  const mixedDealers = await dealerReport({
    buckets: ["approved"], includeUnplanned: true, view: "month", monthIds: ["sales-old"],
  });
  assert.equal(mixedDealers.find((d) => d.dealerId === "a")?.actualAmount, 34137.5);
  assert.equal((await call({ action: "complete", ...mixed.ids })).duplicate, true);

  await prisma.product.create({
    data: { id: "maxx-celodi", name: "MAXX CELODI", rate: 145, nbvPercent: "0.5" },
  });
  assert.equal(
    (await missingProducts.missingProductsStatus(actor)).products.some(
      (row) => row.stockItemName === "MAXX CELODI (50X160)GM",
    ),
    false,
  );
  await refresh(mixedVoucher, oldKey);
  const resolvedDealers = await dealerReport({
    buckets: ["approved"], includeUnplanned: true, view: "month", monthIds: ["sales-old"],
  });
  assert.equal(resolvedDealers.find((d) => d.dealerId === "a")?.actualAmount, 55887.5);
  const resolvedSnapshot = await prisma.tallySalesSnapshot.findUniqueOrThrow({
    where: { connectionId_monthKey: { connectionId, monthKey: oldKey } },
  });
  assert.equal((resolvedSnapshot.summary as { unmatchedProductLines: number }).unmatchedProductLines, 0);
  console.log(
    "Missing products reports captured dealer/month, deduplicates lines, excludes cancelled and optional vouchers, and follows product mappings: PASS",
  );
  console.log("Matched sales publish alongside unmatched stock items and reconverge after mapping: PASS");

  await svc.requestSalesRefresh(actor, month);
  const revokeJob = await claim();
  await (modules["./service.server"] as typeof import("./service.server")).disable(actor);
  await assert.rejects(
    () => call({ action: "heartbeat" }),
    (e: any) => e.status === 401,
  );
  assert.equal(
    (await prisma.tallySalesJob.findUniqueOrThrow({ where: { id: revokeJob.id } })).error,
    "CONNECTION_DISABLED",
  );
  assert.deepEqual(sales.salesPeriod("2026-09", "2026-10-31"), {
    monthKey: "2026-09",
    fromDate: "2026-09-01",
    throughDate: "2026-09-30",
  });
  assert.throws(() => sales.salesPeriod("2026-11", "2026-10-31"));
  console.log(
    "Sales integration: credential/role boundaries, claim recovery, decimals, returns, zero-qty value, verified zero, holds, replacement, replay, 15-minute interval, historical manual refresh, scope-change rollback, missing-ledger zero with anchor coverage, no-alias exact match, requested-month isolation, production preservation, revoke: PASS",
  );
}
main()
  .finally(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
